/**
 * Google Gemini API Client for Speech-to-Text
 * Converts audio buffers (L16 PCM from FreeSWITCH) to text
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const WaveFile = require("wavefile").WaveFile;

// Lazy-initialized Gemini client
let model = null;

function getGeminiModel() {
  if (!model) {
    if (!process.env.GOOGLE_API_KEY) {
      console.warn("[GEMINI] GOOGLE_API_KEY not set - STT will not work");
      return null;
    }
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  }
  return model;
}

/**
 * Convert L16 PCM buffer to WAV format for Gemini API
 * @param {Buffer} pcmBuffer - Raw L16 PCM audio data
 * @param {number} sampleRate - Sample rate (default: 8000 Hz for telephony)
 * @returns {Buffer} WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 8000) {
  const wav = new WaveFile();

  // Convert Buffer to Int16Array for wavefile library
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

  // Create WAV from raw PCM data
  wav.fromScratch(1, sampleRate, "16", samples);

  return Buffer.from(wav.toBuffer());
}

/**
 * Transcribe audio using Google Gemini API
 * @param {Buffer} audioBuffer - Audio data (either WAV or raw PCM)
 * @param {Object} options - Transcription options
 * @param {string} options.format - Input format: "wav" or "pcm" (default: "pcm")
 * @param {number} options.sampleRate - Sample rate for PCM (default: 8000)
 * @param {string} options.language - Language code (default: "en")
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioBuffer, options = {}) {
  const {
    format = "pcm",
    sampleRate = 8000,
    language = "en"
  } = options;

  const geminiModel = getGeminiModel();
  if (!geminiModel) {
    throw new Error("Google API key not configured");
  }

  // Convert PCM to WAV if needed
  let wavBuffer;
  if (format === "pcm") {
    wavBuffer = pcmToWav(audioBuffer, sampleRate);
  } else {
    wavBuffer = audioBuffer;
  }

  // Build the language instruction
  const langInstruction = language !== "en"
    ? ` The audio is in language code "${language}".`
    : "";

  const result = await geminiModel.generateContent([
    { inlineData: { mimeType: "audio/wav", data: wavBuffer.toString("base64") } },
    `Transcribe this audio exactly. Return ONLY the transcription text, nothing else. No quotes, no labels, no prefixes.${langInstruction}`
  ]);

  const transcription = result.response.text().trim();

  const timestamp = new Date().toISOString();
  console.log("[" + timestamp + "] GEMINI Transcribed: " + transcription.substring(0, 100) + (transcription.length > 100 ? "..." : ""));

  return transcription;
}

/**
 * Check if Gemini API is configured and available
 * @returns {boolean} True if API key is set
 */
function isAvailable() {
  return !!process.env.GOOGLE_API_KEY;
}

module.exports = {
  transcribe,
  pcmToWav,
  isAvailable
};
