/**
 * Gemini Live Conversation Loop
 * Real-time voice conversation using Gemini 3.1 Flash Live API
 *
 * Instead of the classic STT -> Claude -> TTS pipeline, this loop sends
 * caller audio directly to Gemini Live and streams back audio responses.
 * Gemini handles speech detection, language understanding, and audio
 * generation in a single bidirectional session.
 *
 * Audio from Gemini (8kHz 16-bit mono PCM) is accumulated into WAV file
 * segments and played back through FreeSWITCH.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WaveFile = require('wavefile').WaveFile;
const logger = require('./logger');
const { GeminiLiveSession } = require('./gemini-live-session');

// Media server configuration
const MEDIA_HOST = process.env.MEDIA_HOST;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

/**
 * Convert raw PCM buffer to WAV format
 * @param {Buffer} pcmBuffer - Raw 16-bit PCM audio data
 * @param {number} sampleRate - Sample rate in Hz
 * @returns {Buffer} WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate) {
  const wav = new WaveFile();
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.length / 2)
  );
  wav.fromScratch(1, sampleRate, '16', samples);
  return Buffer.from(wav.toBuffer());
}

/**
 * Save WAV buffer to disk and return an HTTP URL for FreeSWITCH playback
 * @param {Buffer} wavBuffer - WAV file buffer
 * @param {string} audioDir - Directory to save audio files
 * @returns {string} HTTP URL to the saved file
 */
async function saveAndGetUrl(wavBuffer, audioDir) {
  const filename = `gemini-live-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`;
  const filepath = path.join(audioDir, filename);
  await fs.promises.writeFile(filepath, wavBuffer);
  return `http://${MEDIA_HOST}:${HTTP_PORT}/audio-files/${filename}`;
}

/**
 * Run a real-time voice conversation loop using Gemini Live
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {Object} dialog - SIP dialog
 * @param {string} callUuid - Unique call identifier
 * @param {Object} options - Configuration options
 * @param {Object} options.audioForkServer - WebSocket audio fork server
 * @param {Object} options.ttsService - TTS service (for fallback greeting)
 * @param {number} [options.wsPort=3001] - WebSocket port for audio fork
 * @param {Object} [options.deviceConfig] - Device configuration
 * @param {string} [options.initialContext] - Context for outbound calls
 * @param {boolean} [options.skipGreeting=false] - Skip greeting for outbound calls
 * @param {string} [options.callerExtension] - Caller's extension number
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function runGeminiLiveLoop(endpoint, dialog, callUuid, options) {
  const {
    audioForkServer,
    ttsService,
    wsPort = 3001,
    deviceConfig = null,
    initialContext = null,
    skipGreeting = false,
    callerExtension = null
  } = options;

  if (!process.env.GOOGLE_API_KEY) {
    logger.warn('Gemini Live requires GOOGLE_API_KEY', { callUuid });
    return { success: false, error: 'GOOGLE_API_KEY not set' };
  }

  const voiceId = deviceConfig?.voiceId || 'Puck';
  const deviceName = deviceConfig?.name || 'your assistant';
  const audioDir = process.env.AUDIO_DIR || '/tmp/voice-audio';

  let session = null;
  let audioSession = null;
  let forkRunning = false;
  let callActive = true;
  let flushTimer = null;

  // Audio playback state
  let audioAccumulator = Buffer.alloc(0);
  let isPlaying = false;
  const playQueue = [];

  // Track when call ends
  const onDialogDestroy = () => {
    callActive = false;
    logger.info('Call ended (dialog destroyed)', { callUuid });
  };

  /**
   * Flush accumulated audio into a WAV segment and queue for playback
   */
  async function flushAudio() {
    flushTimer = null;
    // Minimum 100ms of audio at 8kHz (8000 samples/sec * 0.1s * 2 bytes = 1600 bytes)
    if (audioAccumulator.length < 1600) return;

    const pcmData = audioAccumulator;
    audioAccumulator = Buffer.alloc(0);

    const wavBuf = pcmToWav(pcmData, 8000);
    const url = await saveAndGetUrl(wavBuf, audioDir);
    playQueue.push(url);
    processPlayQueue();
  }

  /**
   * Process queued audio segments sequentially through FreeSWITCH
   */
  async function processPlayQueue() {
    if (isPlaying || playQueue.length === 0 || !callActive) return;
    isPlaying = true;
    while (playQueue.length > 0 && callActive) {
      const url = playQueue.shift();
      try {
        await endpoint.play(url);
      } catch (e) {
        if (!callActive) break;
        logger.warn('Play failed', { callUuid, error: e.message });
      }
    }
    isPlaying = false;
  }

  try {
    logger.info('Gemini Live loop starting', {
      callUuid,
      skipGreeting,
      hasInitialContext: !!initialContext,
      voiceId,
      callerExtension
    });

    // Listen for call end
    dialog.on('destroy', onDialogDestroy);

    // 1. Create and connect Gemini Live session
    session = new GeminiLiveSession({
      apiKey: process.env.GOOGLE_API_KEY,
      systemPrompt: deviceConfig?.prompt || 'You are a helpful voice assistant. Keep responses concise and conversational.',
      voiceName: voiceId
    });

    try {
      await session.connect();
      logger.info('Gemini Live session connected', { callUuid });
    } catch (err) {
      logger.error('Gemini Live connection failed', { callUuid, error: err.message });
      return { success: false, error: err.message };
    }

    // 2. Play greeting (if not skipped)
    if (!skipGreeting && callActive) {
      const greetingText = `Hello! I'm ${deviceName}. How can I help you today?`;
      const greetingUrl = await ttsService.generateSpeech(greetingText, voiceId);
      await endpoint.play(greetingUrl);
    }

    // 3. Send initial context for outbound calls
    if (initialContext && callActive) {
      session.sendText(
        '[CONTEXT]: You just called this person to tell them: "' +
        initialContext +
        '". They answered. Now listen and respond.'
      );
      logger.info('Sent initial context to Gemini Live', { callUuid });
    }

    // Check if call is still active before starting audio fork
    if (!callActive) {
      logger.info('Call ended before audio fork could start', { callUuid });
      return { success: true };
    }

    // 4. Start audio fork
    const wsUrl = `ws://${MEDIA_HOST}:${wsPort}/${encodeURIComponent(callUuid)}`;

    let sessionPromise;
    try {
      sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });
    } catch (err) {
      logger.warn('Failed to set up session expectation', { callUuid, error: err.message });
      return { success: true };
    }

    await endpoint.forkAudioStart({
      wsUrl,
      mixType: 'mono',
      sampling: '16k'
    });
    forkRunning = true;

    try {
      audioSession = await sessionPromise;
      logger.info('Audio fork connected', { callUuid });
    } catch (err) {
      logger.warn('Audio fork session failed', { callUuid, error: err.message });
      if (audioForkServer.cancelExpectation) {
        audioForkServer.cancelExpectation(callUuid);
      }
      return { success: true };
    }

    // 5. Pipe raw audio from caller to Gemini Live
    // AudioForkSession stores the WebSocket as this.ws.
    // Binary messages on that WebSocket are raw PCM from FreeSWITCH.
    // We intercept them and forward to Gemini for real-time processing.
    // Gemini handles its own VAD, so we bypass AudioForkSession's speech detection.
    if (audioSession.ws) {
      audioSession.ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
          session.sendAudio(data);
        } else if (data instanceof ArrayBuffer) {
          session.sendAudio(Buffer.from(data));
        }
        // Text messages are metadata - ignore for Gemini forwarding
      });
    }

    // 6. Handle Gemini audio responses
    session.on('audio', (pcm8k) => {
      audioAccumulator = Buffer.concat([audioAccumulator, pcm8k]);

      // Debounce: clear and reset the flush timer on each chunk
      // Flushes after 200ms of no new audio, or when accumulator >= 8000 bytes
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      var flushDelay = audioAccumulator.length >= 8000 ? 50 : 200;
      flushTimer = setTimeout(() => flushAudio(), flushDelay);
    });

    session.on('turnComplete', () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (audioAccumulator.length > 0) {
        flushAudio();
      }
      logger.info('Gemini turn complete', { callUuid });
    });

    // 7. Handle barge-in (caller interrupts Gemini)
    session.on('interrupted', () => {
      logger.info('Barge-in detected', { callUuid });
      playQueue.length = 0;
      audioAccumulator = Buffer.alloc(0);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      endpoint.api('uuid_break', endpoint.uuid).catch(() => {
        // Ignore - playback may have already stopped
      });
    });

    // 8. Handle Gemini errors
    session.on('error', (err) => {
      logger.error('Gemini Live error', { callUuid, error: err.message });
    });

    // 9. Track transcripts for logging
    session.on('transcript', (text) => {
      logger.info('Gemini transcript', { callUuid, text });
    });

    // 10. Wait for call to end
    await new Promise((resolve) => {
      const onDestroy = () => {
        callActive = false;
        resolve();
      };
      dialog.once('destroy', onDestroy);

      session.on('error', (err) => {
        if (err.message === 'Max reconnect attempts reached') {
          logger.error('Gemini Live permanently failed', { callUuid });
          resolve();
        }
      });

      session.on('close', () => {
        if (!callActive) return;
        logger.info('Gemini Live session closed', { callUuid });
        resolve();
      });

      // If the call already ended while setting up listeners
      if (!callActive) {
        resolve();
      }
    });

    logger.info('Gemini Live loop ended normally', { callUuid });
    return { success: true };

  } catch (error) {
    logger.error('Gemini Live loop error', {
      callUuid,
      error: error.message,
      stack: error.stack
    });
    return { success: false, error: error.message };

  } finally {
    logger.info('Gemini Live loop cleanup', { callUuid });

    // Remove dialog listener
    dialog.off('destroy', onDialogDestroy);

    // Clear flush timer
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    // Close Gemini session
    if (session) {
      try {
        session.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Cancel any pending session expectations
    if (audioForkServer.cancelExpectation) {
      audioForkServer.cancelExpectation(callUuid);
    }

    // Stop audio fork
    if (forkRunning) {
      try {
        await endpoint.forkAudioStop();
      } catch (e) {
        // Ignore
      }
    }
  }
}

module.exports = { runGeminiLiveLoop };
