/**
 * Gemini Live Conversation Loop — OpenClaw Relay Mode
 *
 * Gemini Live handles speech recognition and speech synthesis.
 * OpenClaw provides the AI brain (context, memory, tools).
 *
 * Flow: Caller audio → Gemini STT → OpenClaw → Gemini TTS → Caller
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var WaveFile = require('wavefile').WaveFile;
var logger = require('./logger');
var GeminiLiveSession = require('./gemini-live-session').GeminiLiveSession;
var openclawBridge = require('./openclaw-bridge');
var openclawConfig = require('./openclaw-config');

var MEDIA_HOST = process.env.MEDIA_HOST;
var HTTP_PORT = process.env.HTTP_PORT || 3000;

var STATE_LISTENING = 'LISTENING';
var STATE_SPEAKING = 'SPEAKING';

function pcmToWav(pcmBuffer, sampleRate) {
  var wav = new WaveFile();
  var samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.length / 2)
  );
  wav.fromScratch(1, sampleRate, '16', samples);
  return Buffer.from(wav.toBuffer());
}

async function saveAndGetUrl(wavBuffer, audioDir) {
  var filename = 'gemini-live-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.wav';
  var filepath = path.join(audioDir, filename);
  await fs.promises.writeFile(filepath, wavBuffer);
  return 'http://' + MEDIA_HOST + ':' + HTTP_PORT + '/audio-files/' + filename;
}

/**
 * Run a voice conversation loop using Gemini Live as ears/mouth and OpenClaw as brain
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {Object} dialog - SIP dialog
 * @param {string} callUuid - Unique call identifier
 * @param {Object} options - Configuration options
 * @param {Object} options.audioForkServer - WebSocket audio fork server
 * @param {number} [options.wsPort=3001] - WebSocket port for audio fork
 * @param {Object} [options.deviceConfig] - Device configuration
 * @param {string} [options.initialContext] - Context for outbound calls
 * @param {boolean} [options.skipGreeting=false] - Skip greeting for outbound calls
 * @param {string} [options.callerExtension] - Caller's extension number
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function runGeminiLiveLoop(endpoint, dialog, callUuid, options) {
  var audioForkServer = options.audioForkServer;
  var wsPort = options.wsPort || 3001;
  var deviceConfig = options.deviceConfig || null;
  var initialContext = options.initialContext || null;
  var skipGreeting = options.skipGreeting || false;
  var callerExtension = options.callerExtension || null;

  var audioDir = process.env.AUDIO_DIR || '/tmp/voice-audio';

  // Look up OpenClaw route for this caller
  var openclawRoute = openclawConfig.getRouteForCaller(callerExtension);
  if (!openclawRoute) {
    openclawRoute = openclawConfig.getDefault();
  }
  if (!openclawRoute) {
    logger.error('No OpenClaw config for caller', { callUuid: callUuid, callerExtension: callerExtension });
    return { success: false, error: 'No OpenClaw config for caller ' + callerExtension };
  }

  // Validate Google API key
  if (!process.env.GOOGLE_API_KEY) {
    logger.warn('Gemini Live requires GOOGLE_API_KEY', { callUuid: callUuid });
    return { success: false, error: 'GOOGLE_API_KEY not set' };
  }

  var voiceId = (deviceConfig && deviceConfig.voiceId) ? deviceConfig.voiceId : 'Puck';

  var session = null;
  var audioSession = null;
  var forkRunning = false;
  var callActive = true;
  var flushTimer = null;
  var state = STATE_LISTENING;
  var inputTranscriptBuffer = '';
  var queryInProgress = false;

  var audioAccumulator = Buffer.alloc(0);
  var isPlaying = false;
  var playQueue = [];

  var onDialogDestroy = function() {
    callActive = false;
    logger.info('Call ended (dialog destroyed)', { callUuid: callUuid });
  };

  var systemPrompt = 'You are a voice relay interface. You have two jobs:\n' +
    '1. When you hear the user speak, do NOT respond. Stay completely silent. Do not generate any audio.\n' +
    '2. When you receive a text message, speak it aloud naturally and warmly.\n' +
    'Never answer questions yourself. Never add your own words. Only speak the exact text messages you receive.';

  async function flushAudio() {
    flushTimer = null;
    if (audioAccumulator.length < 1600) return;

    var pcmData = audioAccumulator;
    audioAccumulator = Buffer.alloc(0);

    var wavBuf = pcmToWav(pcmData, 8000);
    var url = await saveAndGetUrl(wavBuf, audioDir);
    playQueue.push(url);
    processPlayQueue();
  }

  async function processPlayQueue() {
    if (isPlaying || playQueue.length === 0 || !callActive) return;
    isPlaying = true;
    while (playQueue.length > 0 && callActive) {
      var url = playQueue.shift();
      try {
        await endpoint.play(url);
      } catch (e) {
        if (!callActive) break;
        logger.warn('Play failed', { callUuid: callUuid, error: e.message });
      }
    }
    isPlaying = false;
  }

  function clearAudioState() {
    playQueue.length = 0;
    audioAccumulator = Buffer.alloc(0);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  try {
    logger.info('Gemini Live OpenClaw relay starting', {
      callUuid: callUuid,
      skipGreeting: skipGreeting,
      hasInitialContext: !!initialContext,
      voiceId: voiceId,
      callerExtension: callerExtension,
      openclawUrl: openclawRoute.url
    });

    dialog.on('destroy', onDialogDestroy);

    // 1. Connect Gemini Live
    session = new GeminiLiveSession({
      apiKey: process.env.GOOGLE_API_KEY,
      systemPrompt: systemPrompt,
      voiceName: voiceId
    });

    try {
      await session.connect();
      logger.info('Gemini Live session connected', { callUuid: callUuid });
    } catch (err) {
      logger.error('Gemini Live connection failed', { callUuid: callUuid, error: err.message });
      return { success: false, error: err.message };
    }

    // 2. Greeting or initial context via Gemini TTS
    if (!skipGreeting && callActive) {
      session.sendText('Hello! How can I help you?');
      state = STATE_SPEAKING;
      logger.info('Greeting sent to Gemini', { callUuid: callUuid });
    }

    if (initialContext && callActive) {
      session.sendText(initialContext);
      state = STATE_SPEAKING;
      logger.info('Initial context sent to Gemini', { callUuid: callUuid });
    }

    if (!callActive) {
      logger.info('Call ended before audio fork could start', { callUuid: callUuid });
      return { success: true };
    }

    // 3. Start audio fork
    var wsUrl = 'ws://' + MEDIA_HOST + ':' + wsPort + '/' + encodeURIComponent(callUuid);

    var sessionPromise;
    try {
      sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });
    } catch (err) {
      logger.warn('Failed to set up session expectation', { callUuid: callUuid, error: err.message });
      return { success: true };
    }

    await endpoint.forkAudioStart({
      wsUrl: wsUrl,
      mixType: 'mono',
      sampling: '16k'
    });
    forkRunning = true;

    try {
      audioSession = await sessionPromise;
      logger.info('Audio fork connected', { callUuid: callUuid });
    } catch (err) {
      logger.warn('Audio fork session failed', { callUuid: callUuid, error: err.message });
      if (audioForkServer.cancelExpectation) {
        audioForkServer.cancelExpectation(callUuid);
      }
      return { success: true };
    }

    // 4. Pipe raw audio from caller to Gemini Live
    if (audioSession.ws) {
      audioSession.ws.on('message', function(data) {
        if (Buffer.isBuffer(data)) {
          session.sendAudio(data);
        } else if (data instanceof ArrayBuffer) {
          session.sendAudio(Buffer.from(data));
        }
      });
    }

    // 5. Handle inputTranscription (what the user said)
    session.on('inputTranscription', function(text) {
      if (state === STATE_LISTENING) {
        inputTranscriptBuffer += text;
        logger.debug('Input transcript chunk', { callUuid: callUuid, text: text });
      }
    });

    // 6. Handle Gemini audio output
    session.on('audio', function(pcm8k) {
      if (state === STATE_SPEAKING) {
        audioAccumulator = Buffer.concat([audioAccumulator, pcm8k]);

        if (flushTimer) {
          clearTimeout(flushTimer);
        }
        var flushDelay = audioAccumulator.length >= 8000 ? 50 : 200;
        flushTimer = setTimeout(function() { flushAudio(); }, flushDelay);
      }
      // In LISTENING state, discard all Gemini audio
    });

    // 7. Handle turnComplete
    session.on('turnComplete', function() {
      if (state === STATE_LISTENING) {
        if (queryInProgress) {
          logger.debug('Query already in progress, ignoring turnComplete', { callUuid: callUuid });
          return;
        }
        // User finished speaking — send transcript to OpenClaw
        var transcript = inputTranscriptBuffer.trim();
        inputTranscriptBuffer = '';

        if (!transcript || transcript.length < 2) {
          logger.info('Empty or too short transcript, keep listening', { callUuid: callUuid });
          return;
        }

        logger.info('User said', { callUuid: callUuid, transcript: transcript });

        // Query OpenClaw (async)
        queryInProgress = true;
        (async function() {
          try {
            var response = await openclawBridge.query(transcript, openclawRoute);

            if (!callActive) return;

            logger.info('OpenClaw responded', { callUuid: callUuid, response: response });
            session.sendText(response);
            state = STATE_SPEAKING;
            queryInProgress = false;

          } catch (err) {
            logger.error('OpenClaw query failed', { callUuid: callUuid, error: err.message });
            if (callActive) {
              session.sendText("I'm having trouble connecting right now, try again in a moment");
              state = STATE_SPEAKING;
            }
            queryInProgress = false;
          }
        })();

      } else if (state === STATE_SPEAKING) {
        // Gemini finished speaking — flush remaining audio
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (audioAccumulator.length > 0) {
          flushAudio();
        }

        logger.info('Gemini finished speaking, switching to listening', { callUuid: callUuid });
        state = STATE_LISTENING;
        inputTranscriptBuffer = '';
      }
    });

    // 8. Handle barge-in
    session.on('interrupted', function() {
      logger.info('Barge-in detected', { callUuid: callUuid });
      clearAudioState();
      endpoint.api('uuid_break', endpoint.uuid).catch(function() {});
      state = STATE_LISTENING;
      inputTranscriptBuffer = '';
    });

    // 9. Handle Gemini errors
    session.on('error', function(err) {
      logger.error('Gemini Live error', { callUuid: callUuid, error: err.message });
    });

    // 10. Log what Gemini speaks
    session.on('transcript', function(text) {
      logger.info('Gemini spoke', { callUuid: callUuid, text: text });
    });

    // 11. Wait for call to end
    await new Promise(function(resolve) {
      dialog.once('destroy', function() {
        callActive = false;
        resolve();
      });

      session.on('error', function(err) {
        if (err.message && err.message.indexOf('Max reconnect attempts') !== -1) {
          logger.error('Gemini Live permanently failed', { callUuid: callUuid });
          resolve();
        }
      });

      session.on('close', function() {
        if (!callActive) return;
        logger.info('Gemini Live session closed', { callUuid: callUuid });
        resolve();
      });

      if (!callActive) {
        resolve();
      }
    });

    logger.info('Gemini Live OpenClaw relay ended normally', { callUuid: callUuid });
    return { success: true };

  } catch (error) {
    logger.error('Gemini Live loop error', {
      callUuid: callUuid,
      error: error.message,
      stack: error.stack
    });
    return { success: false, error: error.message };

  } finally {
    logger.info('Gemini Live loop cleanup', { callUuid: callUuid });

    dialog.off('destroy', onDialogDestroy);

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (session) {
      try { session.close(); } catch (e) {}
    }

    if (audioForkServer.cancelExpectation) {
      audioForkServer.cancelExpectation(callUuid);
    }

    if (forkRunning) {
      try { await endpoint.forkAudioStop(); } catch (e) {}
    }
  }
}

module.exports = { runGeminiLiveLoop };
