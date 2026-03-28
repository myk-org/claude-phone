/**
 * Gemini 3.1 Flash Live Session
 *
 * Manages a bidirectional WebSocket connection to Gemini's Live API
 * (gemini-3.1-flash-live-preview). Handles:
 *   - PCM audio streaming in both directions
 *   - Resampling: 8kHz (telephony) ↔ 16kHz (Gemini input) / 24kHz (Gemini output) → 8kHz
 *   - Session lifecycle (connect, reconnect, close)
 *   - System instructions for AI persona
 *
 * Events emitted:
 *   'ready'          — setup complete, ready for audio
 *   'audio'          — (Buffer) PCM L16 8kHz mono chunk for playback
 *   'transcript'     — (string) text transcript of model response (if available)
 *   'turn_complete'  — model finished responding
 *   'interrupted'    — model was interrupted (barge-in)
 *   'error'          — (Error) connection or protocol error
 *   'closed'         — session ended
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const logger = require('./logger');

// ─── PCM Resampling ────────────────────────────────────────────────

/**
 * Resample L16 PCM buffer using linear interpolation.
 * @param {Buffer} buf  – input PCM (little-endian signed 16-bit)
 * @param {number} from – source sample rate
 * @param {number} to   – target sample rate
 * @returns {Buffer}
 */
function resamplePCM(buf, from, to) {
  if (from === to) return buf;

  const inSamples = buf.length / 2;
  const ratio = from / to;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, inSamples - 1);
    const frac = srcIdx - lo;

    const sLo = buf.readInt16LE(lo * 2);
    const sHi = buf.readInt16LE(hi * 2);
    const sample = Math.round(sLo + (sHi - sLo) * frac);

    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return out;
}

// ─── Constants ─────────────────────────────────────────────────────

const GEMINI_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const INPUT_RATE = 16000;   // Gemini expects 16kHz
const OUTPUT_RATE = 24000;  // Gemini outputs 24kHz
const PHONE_RATE = 8000;    // Telephony standard

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000]; // backoff schedule

// ─── Session Class ─────────────────────────────────────────────────

class GeminiLiveSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey       – Google API key (default: process.env.GOOGLE_API_KEY)
   * @param {string} opts.voiceName    – Gemini voice (default: 'Kore')
   * @param {string} opts.systemPrompt – system instruction text
   * @param {string} opts.thinkingLevel – 'minimal'|'low'|'medium'|'high' (default: 'minimal' for lowest latency)
   * @param {boolean} opts.autoReconnect – reconnect on drop (default: true)
   */
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.GOOGLE_API_KEY;
    this.voiceName = opts.voiceName || 'Kore';
    this.systemPrompt = opts.systemPrompt || '';
    this.thinkingLevel = opts.thinkingLevel || 'minimal';
    this.autoReconnect = opts.autoReconnect !== false;

    this._ws = null;
    this._ready = false;
    this._closed = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Open WebSocket and send setup message.
   * Resolves when 'ready' fires.
   */
  async connect() {
    if (this._closed) throw new Error('Session has been closed');
    if (!this.apiKey) throw new Error('GOOGLE_API_KEY is required');

    return new Promise((resolve, reject) => {
      const url = `${WS_BASE}?key=${this.apiKey}`;

      logger.info('[GEMINI-LIVE] Connecting…');
      this._ws = new WebSocket(url);

      const onceReady = () => {
        this.removeListener('error', onceError);
        resolve();
      };
      const onceError = (err) => {
        this.removeListener('ready', onceReady);
        reject(err);
      };
      this.once('ready', onceReady);
      this.once('error', onceError);

      this._ws.on('open', () => this._sendSetup());
      this._ws.on('message', (data) => this._onMessage(data));
      this._ws.on('close', (code, reason) => this._onClose(code, reason));
      this._ws.on('error', (err) => this._onError(err));
    });
  }

  /**
   * Send a chunk of telephony PCM (L16, 8kHz, mono) to Gemini.
   * Resamples to 16kHz before sending.
   * @param {Buffer} pcm8k – raw PCM buffer at 8kHz
   */
  sendAudio(pcm8k) {
    if (!this._ready || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    // Resample 8kHz → 16kHz
    const pcm16k = resamplePCM(pcm8k, PHONE_RATE, INPUT_RATE);
    const b64 = pcm16k.toString('base64');

    const msg = JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_RATE}`,
          data: b64
        }
      }
    });

    try {
      this._ws.send(msg);
    } catch (err) {
      logger.warn('[GEMINI-LIVE] Failed to send audio', { error: err.message });
    }
  }

  /**
   * Send a text message (e.g. initial system prompt context, or typed input).
   * Uses realtimeInput.text format (clientContent is not supported by Live-only models).
   * @param {string} text
   */
  sendText(text) {
    if (!this._ready || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const msg = JSON.stringify({
      realtimeInput: {
        text: text
      }
    });

    try {
      this._ws.send(msg);
    } catch (err) {
      logger.warn('[GEMINI-LIVE] Failed to send text', { error: err.message });
    }
  }

  /**
   * Gracefully close the session.
   */
  close() {
    this._closed = true;
    this._ready = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(1000, 'client close'); } catch { /* ignore */ }
      this._ws = null;
    }
    this.emit('closed');
  }

  /** @returns {boolean} */
  get isReady() {
    return this._ready;
  }

  // ── Internal ─────────────────────────────────────────────────────

  _sendSetup() {
    const setup = {
      setup: {
        model: GEMINI_LIVE_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName
              }
            }
          }
        }
      }
    };

    // Add system instruction if provided
    if (this.systemPrompt) {
      setup.setup.systemInstruction = {
        parts: [{ text: this.systemPrompt }]
      };
    }

    this._ws.send(JSON.stringify(setup));
    logger.info('[GEMINI-LIVE] Setup sent', { voice: this.voiceName, model: GEMINI_LIVE_MODEL });
  }

  _onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      logger.warn('[GEMINI-LIVE] Non-JSON message received');
      return;
    }

    // ── Setup complete
    if (data.setupComplete !== undefined) {
      this._ready = true;
      this._reconnectAttempt = 0;
      logger.info('[GEMINI-LIVE] Ready');
      this.emit('ready');
      return;
    }

    // ── Server content (audio / text / turn complete)
    const sc = data.serverContent;
    if (sc) {
      // Model turn — audio and/or text parts
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            // Audio chunk — decode, resample 24kHz → 8kHz, emit
            const pcm24k = Buffer.from(part.inlineData.data, 'base64');
            const pcm8k = resamplePCM(pcm24k, OUTPUT_RATE, PHONE_RATE);
            this.emit('audio', pcm8k);
          }
          if (part.text) {
            this.emit('transcript', part.text);
          }
        }
      }

      // Output transcription (model's spoken words as text)
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.emit('transcript', sc.outputTranscription.text);
      }

      // Generation complete (all content generated, audio may still be streaming)
      if (sc.generationComplete) {
        this.emit('generation_complete');
      }

      // Turn complete
      if (sc.turnComplete) {
        this.emit('turn_complete');
      }

      // Interrupted (barge-in detected by server)
      if (sc.interrupted) {
        this.emit('interrupted');
      }
      return;
    }

    // ── Usage metadata (ignore, just log)
    if (data.usageMetadata) {
      logger.debug('[GEMINI-LIVE] Usage', data.usageMetadata);
      return;
    }

    // ── Tool calls (future: could route to OpenClaw)
    if (data.toolCall) {
      logger.info('[GEMINI-LIVE] Tool call received (not implemented)', data.toolCall);
      return;
    }
  }

  _onClose(code, reason) {
    const reasonStr = reason ? reason.toString() : 'unknown';
    this._ready = false;
    this._ws = null;
    logger.warn('[GEMINI-LIVE] Connection closed', { code, reason: reasonStr });

    if (!this._closed && this.autoReconnect) {
      this._scheduleReconnect();
    } else {
      this.emit('closed');
    }
  }

  _onError(err) {
    logger.error('[GEMINI-LIVE] WebSocket error', { error: err.message });
    this.emit('error', err);
  }

  _scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;
    logger.info('[GEMINI-LIVE] Reconnecting in %dms (attempt %d)', delay, this._reconnectAttempt);

    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        logger.error('[GEMINI-LIVE] Reconnect failed', { error: err.message });
        if (!this._closed) this._scheduleReconnect();
      }
    }, delay);
  }
}

// ─── Exports ───────────────────────────────────────────────────────

module.exports = { GeminiLiveSession, resamplePCM };
