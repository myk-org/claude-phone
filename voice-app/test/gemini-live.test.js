/**
 * Gemini Live Session Tests
 *
 * Tests PCM resampling logic (unit tests) and optionally the live
 * Gemini API connection when GOOGLE_API_KEY is set.
 *
 * Run with: node --test test/gemini-live.test.js
 */

var { describe, it, after } = require('node:test');
var assert = require('node:assert');
var { GeminiLiveSession } = require('../lib/gemini-live-session');

/**
 * Create a minimal GeminiLiveSession instance for accessing _resamplePcm.
 * The API key is not used for resampling tests.
 */
function createTestSession() {
  return new GeminiLiveSession({ apiKey: 'test-key-not-real' });
}

/**
 * Generate a PCM buffer containing a sine wave.
 * @param {number} frequency - Frequency in Hz
 * @param {number} sampleRate - Sample rate in Hz
 * @param {number} durationMs - Duration in milliseconds
 * @returns {Buffer} 16-bit signed PCM buffer (little-endian)
 */
function generateSineWave(frequency, sampleRate, durationMs) {
  var numSamples = Math.floor(sampleRate * durationMs / 1000);
  var buf = Buffer.alloc(numSamples * 2);
  for (var i = 0; i < numSamples; i++) {
    var sample = Math.round(16000 * Math.sin(2 * Math.PI * frequency * i / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/**
 * Generate a PCM buffer containing a linear ramp signal.
 * @param {number} numSamples - Number of samples to generate
 * @param {number} step - Value increment per sample
 * @returns {Buffer} 16-bit signed PCM buffer (little-endian)
 */
function generateRampSignal(numSamples, step) {
  var buf = Buffer.alloc(numSamples * 2);
  for (var i = 0; i < numSamples; i++) {
    buf.writeInt16LE(i * step, i * 2);
  }
  return buf;
}

// --------------------------------------------------------------------------
// PCM Resampling Tests (unit tests, no API key required)
// --------------------------------------------------------------------------

describe('GeminiLiveSession', function () {
  describe('PCM Resampling', function () {
    it('should pass through when source and target rates are the same', function () {
      var session = createTestSession();
      var input = generateSineWave(440, 24000, 100); // 100ms of 440Hz at 24kHz
      var output = session._resamplePcm(input, 24000, 24000);

      // When rates are equal the method returns the same buffer reference
      assert.strictEqual(output, input, 'Should return the exact same buffer instance');
    });

    it('should downsample 24kHz to 8kHz with correct output length', function () {
      var session = createTestSession();
      var durationMs = 100;
      var inputSamples = 24000 * durationMs / 1000; // 2400 samples
      var input = generateSineWave(440, 24000, durationMs);

      var output = session._resamplePcm(input, 24000, 8000);

      // Output should have 1/3 the number of samples
      var expectedSamples = Math.floor(inputSamples / 3);
      var actualSamples = output.length / 2;

      assert.strictEqual(actualSamples, expectedSamples,
        'Output should have ' + expectedSamples + ' samples, got ' + actualSamples);
    });

    it('should produce a Buffer with correct byte length', function () {
      var session = createTestSession();
      var input = generateSineWave(440, 24000, 50); // 50ms
      var output = session._resamplePcm(input, 24000, 8000);

      assert.ok(Buffer.isBuffer(output), 'Output should be a Buffer');

      // Each sample is 2 bytes (16-bit), output samples = floor(inputSamples / ratio)
      var inputSamples = input.length / 2;
      var expectedOutputSamples = Math.floor(inputSamples / 3);
      assert.strictEqual(output.length, expectedOutputSamples * 2,
        'Output byte length should be outputSamples * 2');
    });

    it('should return an empty buffer for empty input', function () {
      var session = createTestSession();
      var emptyInput = Buffer.alloc(0);
      var output = session._resamplePcm(emptyInput, 24000, 8000);

      assert.ok(Buffer.isBuffer(output), 'Output should be a Buffer');
      assert.strictEqual(output.length, 0, 'Output should be empty');
    });

    it('should linearly interpolate a ramp signal correctly', function () {
      var session = createTestSession();
      // Create a ramp: 0, 100, 200, 300, ..., 2900 (30 samples at 24kHz)
      var numSamples = 30;
      var step = 100;
      var input = generateRampSignal(numSamples, step);

      // Resample from 24kHz to 8kHz (ratio 3:1) -> 10 output samples
      var output = session._resamplePcm(input, 24000, 8000);
      var outputSamples = output.length / 2;

      assert.strictEqual(outputSamples, 10, 'Should produce 10 output samples');

      // Verify interpolated values.
      // Output sample i maps to source index i * 3.0.
      // Since i * 3 is an integer, floor == upper, fraction is 0,
      // so interpolated value equals inputSamples[i * 3] exactly.
      for (var i = 0; i < outputSamples; i++) {
        var actual = output.readInt16LE(i * 2);
        var expected = (i * 3) * step; // value at source index i*3
        assert.strictEqual(actual, expected,
          'Sample ' + i + ' should be ' + expected + ', got ' + actual);
      }
    });

    it('should handle upsampling (8kHz to 24kHz)', function () {
      var session = createTestSession();
      var durationMs = 100;
      var input = generateSineWave(440, 8000, durationMs);
      var inputSamples = input.length / 2; // 800 samples

      var output = session._resamplePcm(input, 8000, 24000);
      var outputSamples = output.length / 2;

      // Output should have 3x the number of input samples
      var expectedSamples = Math.floor(inputSamples * 3);
      assert.strictEqual(outputSamples, expectedSamples,
        'Upsampled output should have ' + expectedSamples + ' samples, got ' + outputSamples);
      assert.ok(Buffer.isBuffer(output), 'Output should be a Buffer');
    });
  });

  // --------------------------------------------------------------------------
  // Live API Connection Tests (skipped when GOOGLE_API_KEY is not set)
  // --------------------------------------------------------------------------

  var GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  var describeApi = GOOGLE_API_KEY ? describe : describe.skip;

  describeApi('Gemini Live API Connection', function () {
    var session;

    after(function () {
      if (session) {
        session.close();
        session = null;
      }
    });

    it('should connect and receive setupComplete (ready event)', { timeout: 15000 }, function () {
      return new Promise(function (resolve, reject) {
        session = new GeminiLiveSession({ apiKey: GOOGLE_API_KEY });

        session.on('ready', function () {
          assert.strictEqual(session.connected, true, 'Session should be connected');
          assert.strictEqual(session._setupComplete, true, 'Setup should be complete');
          resolve();
        });

        session.connect().catch(reject);
      });
    });

    it('should send text and receive audio response', { timeout: 30000 }, function () {
      return new Promise(function (resolve, reject) {
        // Close any previous session
        if (session) {
          session.close();
        }

        session = new GeminiLiveSession({ apiKey: GOOGLE_API_KEY });
        var audioChunks = [];
        var gotTurnComplete = false;

        session.on('audio', function (pcmBuffer) {
          assert.ok(Buffer.isBuffer(pcmBuffer), 'Audio chunk should be a Buffer');
          assert.ok(pcmBuffer.length > 0, 'Audio chunk should not be empty');
          // PCM 16-bit: byte length must be even
          assert.strictEqual(pcmBuffer.length % 2, 0,
            'Audio buffer byte length should be even (16-bit samples)');
          audioChunks.push(pcmBuffer);
        });

        session.on('turnComplete', function () {
          gotTurnComplete = true;
          assert.ok(audioChunks.length > 0,
            'Should have received at least one audio chunk before turn complete');

          // Verify total audio is reasonable for spoken output
          var totalBytes = audioChunks.reduce(function (sum, buf) { return sum + buf.length; }, 0);
          assert.ok(totalBytes > 100,
            'Total audio should be more than 100 bytes, got ' + totalBytes);

          resolve();
        });

        session.on('error', function (err) {
          reject(err);
        });

        session.connect()
          .then(function () {
            session.sendText('Say hello');
          })
          .catch(reject);
      });
    });
  });
});
