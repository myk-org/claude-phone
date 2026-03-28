/**
 * Gemini Live Session
 * Manages a WebSocket connection to the Gemini 3.1 Flash Live API
 * for real-time bidirectional audio streaming (bidiGenerateContent).
 *
 * Sends PCM 16kHz audio, receives PCM 24kHz audio (resampled to 8kHz),
 * and emits events for audio data, transcripts, and turn lifecycle.
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const logger = require('./logger');

const DEFAULT_MODEL = 'models/gemini-3.1-flash-live-preview';
const DEFAULT_VOICE = 'Puck';
const SETUP_TIMEOUT_MS = 10000;
const MAX_RECONNECT_ATTEMPTS = 3;

function sanitizeError(msg) {
  if (typeof msg !== 'string') return msg;
  return msg.replace(/key=[^&\s"']+/g, 'key=***');
}

class GeminiLiveSession extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - Google API key (required)
   * @param {string} [opts.model] - Gemini model identifier
   * @param {string} [opts.systemPrompt] - System instruction text
   * @param {string} [opts.voiceName] - Gemini voice name
   */
  constructor({ apiKey, model, systemPrompt, voiceName }) {
    super();

    if (!apiKey) {
      throw new Error('GeminiLiveSession requires an apiKey');
    }

    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.systemPrompt = systemPrompt || '';
    this.voiceName = voiceName || DEFAULT_VOICE;

    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
    this._reconnectTimer = null;
    this._reconnecting = false;
    this._setupComplete = false;
  }

  /**
   * Open WebSocket to Gemini Live API and perform setup handshake.
   * Resolves when setupComplete is received, rejects on error or timeout.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      var url = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + this.apiKey;

      logger.info('Gemini Live connecting', { model: this.model, voice: this.voiceName });

      var ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        logger.error('Gemini Live WebSocket creation failed', { error: err.message });
        reject(err);
        return;
      }

      this.ws = ws;
      this._setupComplete = false;

      var setupTimer = setTimeout(function () {
        if (!this._setupComplete) {
          logger.error('Gemini Live setup timed out', { timeoutMs: SETUP_TIMEOUT_MS });
          ws.close();
          reject(new Error('Gemini Live setup timed out after ' + SETUP_TIMEOUT_MS + 'ms'));
        }
      }.bind(this), SETUP_TIMEOUT_MS);

      var settled = false;

      ws.on('open', function () {
        logger.info('Gemini Live WebSocket opened, sending setup');

        var setupMsg = {
          setup: {
            model: this.model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.voiceName
                  }
                }
              }
            },
            inputAudioTranscription: {}
          }
        };

        if (this.systemPrompt) {
          setupMsg.setup.systemInstruction = {
            parts: [{ text: this.systemPrompt }]
          };
        }

        ws.send(JSON.stringify(setupMsg));
      }.bind(this));

      ws.on('message', function (rawData) {
        var data;
        try {
          data = JSON.parse(rawData.toString());
        } catch (err) {
          logger.warn('Gemini Live received unparseable message', { error: err.message });
          return;
        }

        // Handle setupComplete during handshake
        if (data.setupComplete !== undefined) {
          this._setupComplete = true;
          this.connected = true;
          this.reconnectAttempts = 0;
          clearTimeout(setupTimer);

          logger.info('Gemini Live setup complete');
          this.emit('ready');

          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        // After setup, dispatch to message handler
        if (this._setupComplete) {
          this._handleMessage(data);
        }
      }.bind(this));

      ws.on('error', function (err) {
        logger.error('Gemini Live WebSocket error', { error: sanitizeError(err.message) });

        if (!settled) {
          settled = true;
          clearTimeout(setupTimer);
          reject(err);
          return;
        }

        this.emit('error', err);
      }.bind(this));

      ws.on('close', function (code, reason) {
        var wasConnected = this.connected;
        this.connected = false;
        this._setupComplete = false;

        logger.info('Gemini Live WebSocket closed', {
          code: code,
          reason: reason ? reason.toString() : '',
          wasConnected: wasConnected
        });

        if (!settled) {
          settled = true;
          clearTimeout(setupTimer);
          reject(new Error(sanitizeError('Gemini Live WebSocket closed before setup complete (code ' + code + ')')));
          return;
        }

        this.emit('close');

        // Attempt reconnect if the connection was established and dropped unexpectedly
        if (wasConnected && code !== 1000) {
          this._reconnect();
        }
      }.bind(this));
    });
  }

  /**
   * Send raw PCM audio to Gemini.
   * @param {Buffer} pcmBuffer - 16kHz 16-bit mono PCM (little-endian)
   */
  sendAudio(pcmBuffer) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    var base64 = pcmBuffer.toString('base64');
    var msg = JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64
        }
      }
    });

    try {
      this.ws.send(msg);
    } catch (err) {
      logger.warn('Gemini Live failed to send audio', { error: err.message, bytes: pcmBuffer.length });
    }
  }

  /**
   * Send a text message as realtime input (e.g. initial context for outbound calls).
   * @param {string} text
   */
  sendText(text) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    var msg = JSON.stringify({
      realtimeInput: {
        text: text
      }
    });

    try {
      this.ws.send(msg);
      logger.info('Gemini Live sent text input', { length: text.length });
    } catch (err) {
      logger.warn('Gemini Live failed to send text', { error: err.message });
    }
  }

  /**
   * Close the WebSocket connection cleanly.
   */
  close() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this.connected = false;
    this._setupComplete = false;
    this._reconnecting = false;
    this.reconnectAttempts = 0;

    if (this.ws) {
      try {
        this.ws.close(1000, 'Client closing');
      } catch (err) {
        logger.warn('Gemini Live error during close', { error: err.message });
      }
      this.ws = null;
    }

    logger.info('Gemini Live session closed');
  }

  /**
   * Parse and dispatch an incoming Gemini Live API message.
   * @param {Object} data - Parsed JSON message
   * @private
   */
  _handleMessage(data) {
    var serverContent = data.serverContent;
    if (!serverContent) {
      return;
    }

    // Audio and inline data from model turn
    if (serverContent.modelTurn && serverContent.modelTurn.parts) {
      var parts = serverContent.modelTurn.parts;
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (part.inlineData && part.inlineData.data) {
          var pcm24 = Buffer.from(part.inlineData.data, 'base64');
          var pcm8 = this._resamplePcm(pcm24, 24000, 8000);
          logger.debug('Gemini Live audio chunk', { input: pcm24.length, output: pcm8.length });
          this.emit('audio', pcm8);
        }
      }
    }

    // Output transcription
    if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
      var text = serverContent.outputTranscription.text;
      logger.debug('Gemini Live transcript', { text: text.substring(0, 100) });
      this.emit('transcript', text);
    }

    // Input transcription (what the user said)
    if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
      var inputText = serverContent.inputTranscription.text;
      logger.debug('Gemini Live input transcript', { text: inputText.substring(0, 100) });
      this.emit('inputTranscription', inputText);
    }

    // Turn lifecycle events
    if (serverContent.generationComplete === true) {
      logger.debug('Gemini Live generation complete');
      this.emit('generationComplete');
    }

    if (serverContent.turnComplete === true) {
      logger.debug('Gemini Live turn complete');
      this.emit('turnComplete');
    }

    if (serverContent.interrupted === true) {
      logger.info('Gemini Live interrupted (barge-in)');
      this.emit('interrupted');
    }
  }

  /**
   * Resample PCM audio using linear interpolation.
   * No external audio dependencies required.
   *
   * @param {Buffer} inputBuffer - 16-bit signed PCM (little-endian)
   * @param {number} fromRate - Source sample rate (e.g. 24000)
   * @param {number} toRate - Target sample rate (e.g. 8000)
   * @returns {Buffer} Resampled 16-bit signed PCM (little-endian)
   * @private
   */
  _resamplePcm(inputBuffer, fromRate, toRate) {
    if (fromRate === toRate) {
      return inputBuffer;
    }

    var inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      Math.floor(inputBuffer.length / 2)
    );
    var inputLength = inputSamples.length;

    if (inputLength === 0) {
      return Buffer.alloc(0);
    }

    var ratio = fromRate / toRate;
    var outputLength = Math.floor(inputLength / ratio);
    var outputSamples = new Int16Array(outputLength);

    for (var i = 0; i < outputLength; i++) {
      var srcIndex = i * ratio;
      var lower = Math.floor(srcIndex);
      var upper = Math.min(lower + 1, inputLength - 1);
      var fraction = srcIndex - lower;
      outputSamples[i] = Math.round(
        inputSamples[lower] + (inputSamples[upper] - inputSamples[lower]) * fraction
      );
    }

    // Return a new Buffer backed by the Int16Array (little-endian on all Node.js platforms)
    return Buffer.from(outputSamples.buffer, outputSamples.byteOffset, outputSamples.byteLength);
  }

  /**
   * Attempt to reconnect with exponential backoff.
   * @private
   */
  _reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._reconnecting = false;
      var errMsg = 'Max reconnect attempts reached (' + this.maxReconnectAttempts + ')';
      logger.error('Gemini Live ' + errMsg);
      this.emit('error', new Error(errMsg));
      return;
    }

    this.reconnectAttempts++;
    var delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);

    logger.info('Gemini Live reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay
    });

    this._reconnectTimer = setTimeout(function () {
      this._reconnectTimer = null;

      this.connect()
        .then(function () {
          logger.info('Gemini Live reconnected successfully');
          this.reconnectAttempts = 0;
          this._reconnecting = false;
        }.bind(this))
        .catch(function (err) {
          logger.error('Gemini Live reconnect attempt failed', {
            attempt: this.reconnectAttempts,
            error: sanitizeError(err.message)
          });
          this._reconnecting = false;
          this._reconnect();
        }.bind(this));
    }.bind(this), delay);
  }
}

module.exports = { GeminiLiveSession };
