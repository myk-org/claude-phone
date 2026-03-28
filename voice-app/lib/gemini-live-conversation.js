/**
 * Gemini Live Conversation Loop
 *
 * Replaces the traditional STT → LLM → TTS pipeline with a single
 * Gemini 3.1 Flash Live WebSocket session for real-time, low-latency
 * voice conversations.
 *
 * Architecture:
 *   FreeSWITCH ──(L16 8kHz)──► AudioFork ──(PCM chunks)──► GeminiLiveSession
 *                                                               │
 *   FreeSWITCH ◄──(L16 8kHz WAV file URLs)── AudioWriter ◄─────┘
 *
 * Key differences from conversation-loop.js:
 *   - No VAD / utterance detection needed — Gemini handles it natively
 *   - No separate STT step — audio goes straight to Gemini
 *   - No TTS step — Gemini outputs native audio
 *   - No hold music / thinking phrases — response streams immediately
 *   - Barge-in is handled by Gemini's server-side interruption
 *
 * Fallback: If Live API connection fails, caller can fall back to
 * conversation-loop.js (the old pipeline).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('node:events');
const WaveFile = require('wavefile').WaveFile;
const { GeminiLiveSession } = require('./gemini-live-session');
const logger = require('./logger');

// ─── Audio output ──────────────────────────────────────────────────

// We need to write PCM chunks to WAV files for FreeSWITCH ep.play().
// FreeSWITCH can't consume raw PCM streams directly — it needs file URLs.

const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, '../audio-temp');
const MEDIA_HOST = process.env.MEDIA_HOST;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

/**
 * Accumulates PCM audio chunks from Gemini and writes them as playable
 * WAV files. Each "turn" produces one WAV file that can be played via
 * FreeSWITCH ep.play().
 */
class AudioAccumulator extends EventEmitter {
  constructor() {
    super();
    this._chunks = [];
    this._totalBytes = 0;
    this._flushTimer = null;
    // Flush partial audio every 600ms so playback can start sooner
    this._flushIntervalMs = 600;
    this._minFlushBytes = 8000; // ~500ms at 8kHz 16-bit
    this._segmentIndex = 0;
  }

  /** Add a PCM chunk (L16, 8kHz, mono) */
  push(pcm8k) {
    this._chunks.push(pcm8k);
    this._totalBytes += pcm8k.length;

    // Start flush timer on first chunk
    if (!this._flushTimer) {
      this._flushTimer = setInterval(() => this._tryFlush(), this._flushIntervalMs);
    }
  }

  /** Flush any remaining audio and stop timers */
  finalize() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._tryFlush(true);
  }

  /** Cancel and discard (barge-in) */
  discard() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._chunks = [];
    this._totalBytes = 0;
  }

  /** Reset for next turn */
  reset() {
    this.discard();
    this._segmentIndex = 0;
  }

  _tryFlush(force = false) {
    if (this._totalBytes < this._minFlushBytes && !force) return;
    if (this._chunks.length === 0) return;

    const pcm = Buffer.concat(this._chunks);
    this._chunks = [];
    this._totalBytes = 0;
    this._segmentIndex++;

    // Write WAV file
    const wavUrl = writeWav(pcm, 8000, `live-${this._segmentIndex}`);
    if (wavUrl) {
      this.emit('segment', wavUrl);
    }
  }
}

/**
 * Write PCM data to a WAV file and return its HTTP URL.
 * @param {Buffer} pcm – L16 PCM data
 * @param {number} rate – sample rate
 * @param {string} tag – filename tag
 * @returns {string|null} HTTP URL for FreeSWITCH playback
 */
function writeWav(pcm, rate, tag) {
  try {
    if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

    const hash = crypto.createHash('md5').update(pcm).digest('hex').substring(0, 8);
    const filename = `gemini-live-${Date.now()}-${tag}-${hash}.wav`;
    const filepath = path.join(AUDIO_DIR, filename);

    const wav = new WaveFile();
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    wav.fromScratch(1, rate, '16', samples);
    fs.writeFileSync(filepath, wav.toBuffer());

    // Clean up old files (keep last 50)
    cleanupOldFiles();

    return `http://${MEDIA_HOST}:${HTTP_PORT}/audio/${filename}`;
  } catch (err) {
    logger.error('[GEMINI-LIVE-CONV] Failed to write WAV', { error: err.message });
    return null;
  }
}

let _cleanupCounter = 0;
function cleanupOldFiles() {
  _cleanupCounter++;
  if (_cleanupCounter % 10 !== 0) return; // Only every 10th call

  try {
    const files = fs.readdirSync(AUDIO_DIR)
      .filter(f => f.startsWith('gemini-live-'))
      .map(f => ({ name: f, time: fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const f of files.slice(50)) {
      fs.unlinkSync(path.join(AUDIO_DIR, f.name));
    }
  } catch { /* ignore cleanup errors */ }
}

// ─── Main Conversation Function ────────────────────────────────────

/**
 * Run a Gemini Live conversation.
 *
 * @param {object} endpoint     – FreeSWITCH endpoint
 * @param {object} dialog       – SIP dialog
 * @param {string} callUuid     – unique call ID
 * @param {object} options
 * @param {object} options.audioForkServer – AudioForkServer instance
 * @param {number} options.wsPort          – WebSocket port for audio fork
 * @param {string} [options.initialContext]  – outbound call context
 * @param {boolean} [options.skipGreeting]   – skip initial greeting
 * @param {object} [options.deviceConfig]    – device config (prompt, voiceId)
 * @param {number} [options.maxDurationMs]   – max call duration (default: 10 min)
 * @param {string} [options.callerExtension] – caller ext for logging
 * @returns {Promise<{success: boolean, error?: Error}>}
 */
async function runGeminiLiveConversation(endpoint, dialog, callUuid, options) {
  const {
    audioForkServer,
    wsPort,
    initialContext = null,
    skipGreeting = false,
    deviceConfig = null,
    maxDurationMs = 10 * 60 * 1000, // 10 minutes
    callerExtension = null
  } = options;

  const voiceName = deviceConfig?.voiceId || 'Kore';
  const systemPrompt = buildSystemPrompt(deviceConfig, initialContext);

  let geminiSession = null;
  let audioForkSession = null;
  let accumulator = null;
  let forkRunning = false;
  let callActive = true;
  let playbackQueue = [];
  let isPlaying = false;

  const onDialogDestroy = () => {
    callActive = false;
    logger.info('[GEMINI-LIVE-CONV] Call ended (dialog destroyed)', { callUuid });
  };

  try {
    dialog.on('destroy', onDialogDestroy);

    // ── 1. Connect to Gemini Live API
    logger.info('[GEMINI-LIVE-CONV] Starting', { callUuid, voiceName });

    geminiSession = new GeminiLiveSession({
      voiceName,
      systemPrompt,
      thinkingLevel: 'minimal', // lowest latency for phone calls
      autoReconnect: true
    });

    try {
      await geminiSession.connect();
      logger.info('[GEMINI-LIVE-CONV] Gemini Live connected', { callUuid });
    } catch (err) {
      logger.error('[GEMINI-LIVE-CONV] Failed to connect to Gemini Live', {
        callUuid, error: err.message
      });
      return { success: false, error: err };
    }

    if (!callActive) return { success: false, error: new Error('Call ended before setup') };

    // ── 2. Set up audio accumulator for playback
    accumulator = new AudioAccumulator();

    accumulator.on('segment', async (wavUrl) => {
      playbackQueue.push(wavUrl);
      drainPlaybackQueue();
    });

    async function drainPlaybackQueue() {
      if (isPlaying || !callActive) return;
      while (playbackQueue.length > 0 && callActive) {
        isPlaying = true;
        const url = playbackQueue.shift();
        try {
          await endpoint.play(url);
        } catch (err) {
          if (!callActive) break;
          logger.warn('[GEMINI-LIVE-CONV] Playback failed', { callUuid, error: err.message });
        }
        isPlaying = false;
      }
    }

    // ── 3. Wire Gemini audio output → accumulator
    geminiSession.on('audio', (pcm8k) => {
      if (!callActive) return;
      accumulator.push(pcm8k);
    });

    geminiSession.on('turn_complete', () => {
      logger.info('[GEMINI-LIVE-CONV] Gemini turn complete', { callUuid });
      accumulator.finalize();
    });

    geminiSession.on('interrupted', () => {
      logger.info('[GEMINI-LIVE-CONV] Barge-in detected', { callUuid });
      // Stop current playback and discard buffered audio
      accumulator.discard();
      playbackQueue = [];
      if (isPlaying && callActive) {
        try {
          endpoint.api('uuid_break', endpoint.uuid).catch(() => {});
        } catch { /* ignore */ }
        isPlaying = false;
      }
    });

    geminiSession.on('transcript', (text) => {
      logger.debug('[GEMINI-LIVE-CONV] Transcript', { callUuid, text });
    });

    geminiSession.on('error', (err) => {
      logger.error('[GEMINI-LIVE-CONV] Gemini error', { callUuid, error: err.message });
    });

    // ── 4. Start audio fork from FreeSWITCH
    if (!callActive) return { success: false, error: new Error('Call ended before audio fork') };

    const wsUrl = `ws://${MEDIA_HOST}:${wsPort}/${encodeURIComponent(callUuid)}`;
    const sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });

    await endpoint.forkAudioStart({
      wsUrl,
      mixType: 'mono',
      sampling: '16k'  // FreeSWITCH sends 16kHz (not 8kHz) via audio fork
    });
    forkRunning = true;

    try {
      audioForkSession = await sessionPromise;
      logger.info('[GEMINI-LIVE-CONV] Audio fork connected', { callUuid });
    } catch (err) {
      logger.warn('[GEMINI-LIVE-CONV] Audio fork failed', { callUuid, error: err.message });
      audioForkServer.cancelExpectation && audioForkServer.cancelExpectation(callUuid);
      return { success: false, error: err };
    }

    // ── 5. Pipe audio fork → Gemini Live
    // Audio fork emits raw binary PCM chunks via its WebSocket.
    // We need to intercept them BEFORE the VAD and send to Gemini.
    // The audio fork sends 16kHz PCM (as configured above).
    // GeminiLiveSession.sendAudio() expects 8kHz and resamples to 16kHz,
    // but since we're getting 16kHz from fork, we pipe directly.

    const originalOnMessage = audioForkSession._onMessage.bind(audioForkSession);
    audioForkSession._onMessage = (data) => {
      // Forward to Gemini if it's binary audio
      if (Buffer.isBuffer(data) && data.length >= 2 && geminiSession && geminiSession.isReady) {
        // Audio from fork is already 16kHz — send directly to Gemini
        // (bypassing sendAudio's 8→16 resample)
        const b64 = data.toString('base64');
        try {
          if (geminiSession._ws && geminiSession._ws.readyState === 1) {
            geminiSession._ws.send(JSON.stringify({
              realtimeInput: {
                audio: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: b64
                }
              }
            }));
          }
        } catch (err) {
          logger.warn('[GEMINI-LIVE-CONV] Failed to forward audio', { error: err.message });
        }
      }
      // Still call original handler for metadata messages
      if (typeof data === 'string') {
        originalOnMessage(data);
      }
    };

    // ── 6. If there's initial context (outbound call), send it as text
    if (initialContext && geminiSession.isReady) {
      // Give Gemini a moment to settle, then send context + first message prompt
      setTimeout(() => {
        if (geminiSession && geminiSession.isReady) {
          geminiSession.sendText(
            `You just called someone to tell them: "${initialContext}". ` +
            `They have answered the phone. Greet them and deliver your message naturally.`
          );
        }
      }, 500);
    } else if (!skipGreeting && geminiSession.isReady) {
      // For inbound calls, prompt Gemini to greet
      geminiSession.sendText('Someone just called you. Greet them warmly and ask how you can help.');
    }

    // ── 7. Wait for call to end or max duration
    logger.info('[GEMINI-LIVE-CONV] Conversation active', { callUuid, maxDurationMs });

    await new Promise((resolve) => {
      const maxTimer = setTimeout(() => {
        logger.info('[GEMINI-LIVE-CONV] Max duration reached', { callUuid });
        resolve();
      }, maxDurationMs);

      const checkEnd = () => {
        if (!callActive) {
          clearTimeout(maxTimer);
          resolve();
        }
      };

      dialog.on('destroy', checkEnd);

      // Also resolve if Gemini session closes
      geminiSession.on('closed', () => {
        clearTimeout(maxTimer);
        resolve();
      });
    });

    logger.info('[GEMINI-LIVE-CONV] Conversation ended', { callUuid });
    return { success: true };

  } catch (error) {
    logger.error('[GEMINI-LIVE-CONV] Fatal error', {
      callUuid,
      error: error.message,
      stack: error.stack
    });
    return { success: false, error };

  } finally {
    // ── Cleanup
    dialog.off('destroy', onDialogDestroy);

    if (geminiSession) {
      geminiSession.close();
    }

    if (accumulator) {
      accumulator.discard();
    }

    if (audioForkServer.cancelExpectation) {
      audioForkServer.cancelExpectation(callUuid);
    }

    if (forkRunning) {
      try { await endpoint.forkAudioStop(); } catch { /* ignore */ }
    }

    logger.info('[GEMINI-LIVE-CONV] Cleanup complete', { callUuid });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function buildSystemPrompt(deviceConfig, initialContext) {
  const parts = [];

  if (deviceConfig?.prompt) {
    parts.push(deviceConfig.prompt);
  } else {
    parts.push(
      'You are a helpful AI phone assistant. ' +
      'Keep your responses concise and conversational — you are on a phone call. ' +
      'Use natural speech patterns. Avoid long lists or technical jargon unless asked. ' +
      'If someone says goodbye, say goodbye warmly.'
    );
  }

  parts.push(
    'You are speaking on a phone call. Keep responses brief and natural. ' +
    'Do not use markdown, bullet points, or formatting — only spoken language.'
  );

  return parts.join('\n\n');
}

// ─── Exports ───────────────────────────────────────────────────────

module.exports = {
  runGeminiLiveConversation,
  AudioAccumulator,
  writeWav
};
