/**
 * Google Gemini Text-to-Speech Service
 * Generates speech audio files and returns URLs for FreeSWITCH playback
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const WaveFile = require('wavefile').WaveFile;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

// Available Gemini TTS voices
const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];

// Default voice (can be overridden via env var or parameter)
const DEFAULT_VOICE = process.env.GOOGLE_TTS_VOICE || 'Kore';

// Audio output directory (set via setAudioDir)
let audioDir = path.join(__dirname, '../audio-temp');

/**
 * Set the audio output directory
 * @param {string} dir - Absolute path to audio directory
 */
function setAudioDir(dir) {
  audioDir = dir;

  // Create directory if it doesn't exist
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    logger.info('Created audio directory', { path: audioDir });
  }
}

/**
 * Generate unique filename for audio file
 * @param {string} text - Text being converted
 * @returns {string} Filename (without path)
 */
function generateFilename(text) {
  // Hash text to create unique identifier
  const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
  const timestamp = Date.now();
  return `tts-${timestamp}-${hash}.wav`;
}

/**
 * Convert text to speech using Google Gemini TTS API
 * @param {string} text - Text to convert to speech
 * @param {string} voiceName - Gemini voice name (optional, e.g., "Kore", "Puck")
 * @returns {Promise<string>} HTTP URL to audio file
 */
async function generateSpeech(text, voiceName = DEFAULT_VOICE) {
  const startTime = Date.now();

  try {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY environment variable not set');
    }

    logger.info('Generating speech with Gemini TTS', {
      textLength: text.length,
      voice: voiceName,
      model: 'gemini-2.5-flash-preview-tts'
    });

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-preview-tts',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName
            }
          }
        }
      }
    });

    const result = await model.generateContent(`Say the following text exactly as written, do not add anything: ${text}`);
    const audioData = result.response.candidates[0].content.parts[0].inlineData.data;

    // audioData is base64-encoded PCM at 24kHz, 16-bit, mono
    const pcmBuffer = Buffer.from(audioData, 'base64');

    // Convert PCM to WAV using wavefile
    const wav = new WaveFile();
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    wav.fromScratch(1, 24000, '16', samples);
    const wavBuffer = Buffer.from(wav.toBuffer());

    // Generate filename and save audio
    const filename = generateFilename(text);
    const filepath = path.join(audioDir, filename);

    fs.writeFileSync(filepath, wavBuffer);

    const latency = Date.now() - startTime;
    const fileSize = wavBuffer.length;

    logger.info('Speech generation successful', {
      filename,
      fileSize,
      latency,
      textLength: text.length
    });

    // Return HTTP URL (assumes audio-temp is served via HTTP)
    // Format: http://MEDIA_HOST:PORT/audio-files/filename.wav
    // The HTTP server setup is handled elsewhere
    const port = process.env.HTTP_PORT || 3000;
    const audioUrl = `http://${process.env.MEDIA_HOST}:${port}/audio-files/${filename}`;

    return audioUrl;

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Speech generation failed', {
      error: error.message,
      latency,
      textLength: text?.length
    });

    throw new Error(`TTS generation failed: ${error.message}`);
  }
}

/**
 * Clean up old audio files (older than specified age)
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 */
function cleanupOldFiles(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(audioDir);

    let deletedCount = 0;
    files.forEach(file => {
      if (!file.startsWith('tts-') || !file.endsWith('.wav')) {
        return;
      }

      const filepath = path.join(audioDir, file);
      const stats = fs.statSync(filepath);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        fs.unlinkSync(filepath);
        deletedCount++;
      }
    });

    if (deletedCount > 0) {
      logger.info('Cleaned up old audio files', { deletedCount });
    }

  } catch (error) {
    logger.warn('Failed to cleanup old audio files', { error: error.message });
  }
}

/**
 * Get list of available Gemini TTS voices
 * @returns {Array<{name: string}>} Array of voice objects
 */
function getAvailableVoices() {
  return GEMINI_VOICES.map(name => ({ name }));
}

// Initialize audio directory
setAudioDir(audioDir);

// Setup periodic cleanup (every 30 minutes)
setInterval(() => {
  cleanupOldFiles();
}, 30 * 60 * 1000);

module.exports = {
  generateSpeech,
  setAudioDir,
  cleanupOldFiles,
  getAvailableVoices
};
