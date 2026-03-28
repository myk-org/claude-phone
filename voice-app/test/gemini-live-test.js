#!/usr/bin/env node
/**
 * Standalone test for GeminiLiveSession
 *
 * Tests:
 *  1. Connect to gemini-3.1-flash-live-preview
 *  2. Send text prompt
 *  3. Receive native audio chunks
 *  4. Verify resampling works
 *
 * Usage: GOOGLE_API_KEY=xxx node test/gemini-live-test.js
 */

const { GeminiLiveSession, resamplePCM } = require('../lib/gemini-live-session');

async function main() {
  console.log('=== Gemini 3.1 Flash Live Test ===\n');

  // Test 1: Resampling
  console.log('Test 1: PCM resampling...');
  const testBuf = Buffer.alloc(16000, 0); // 1 second at 8kHz
  for (let i = 0; i < 8000; i++) {
    const sample = Math.round(16000 * Math.sin(2 * Math.PI * 440 * i / 8000));
    testBuf.writeInt16LE(sample, i * 2);
  }

  const up16k = resamplePCM(testBuf, 8000, 16000);
  console.log(`  8kHz → 16kHz: ${testBuf.length} → ${up16k.length} bytes`);
  console.assert(up16k.length === 32000, 'Expected 32000 bytes for 16kHz');

  const down8k = resamplePCM(up16k, 16000, 8000);
  console.log(`  16kHz → 8kHz: ${up16k.length} → ${down8k.length} bytes`);
  console.assert(down8k.length === 16000, 'Expected 16000 bytes for 8kHz');

  const down24to8 = resamplePCM(Buffer.alloc(48000, 0), 24000, 8000);
  console.log(`  24kHz → 8kHz: 48000 → ${down24to8.length} bytes`);
  console.assert(down24to8.length === 16000, 'Expected 16000 bytes');

  console.log('  ✅ Resampling OK\n');

  // Test 2: Live API connection
  if (!process.env.GOOGLE_API_KEY) {
    console.log('Test 2: SKIPPED (no GOOGLE_API_KEY)\n');
    process.exit(0);
  }

  console.log('Test 2: Connecting to Gemini Live...');
  const session = new GeminiLiveSession({
    voiceName: 'Puck',
    systemPrompt: 'You are a test assistant. Keep responses very brief.',
    autoReconnect: false
  });

  let audioChunks = 0;
  let totalAudioBytes = 0;
  let transcripts = [];

  session.on('audio', (pcm8k) => {
    audioChunks++;
    totalAudioBytes += pcm8k.length;
    // Verify it's 8kHz (output of resampler)
    if (audioChunks === 1) {
      console.log(`  First audio chunk: ${pcm8k.length} bytes (8kHz PCM)`);
    }
  });

  session.on('transcript', (text) => {
    transcripts.push(text);
  });

  session.on('error', (err) => {
    console.error(`  ❌ Error: ${err.message}`);
  });

  try {
    await session.connect();
    console.log('  ✅ Connected!\n');

    console.log('Test 3: Sending text prompt...');
    session.sendText('Say hello in exactly five words.');

    // Wait for response
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('  ⚠️  Timeout waiting for response');
        resolve();
      }, 15000);

      session.on('turn_complete', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    console.log(`  Audio chunks received: ${audioChunks}`);
    console.log(`  Total audio bytes: ${totalAudioBytes}`);
    console.log(`  Duration: ~${(totalAudioBytes / (8000 * 2)).toFixed(1)}s at 8kHz`);
    console.log(`  Transcripts: ${transcripts.join(' ')}`);

    if (audioChunks > 0) {
      console.log('  ✅ Native audio output confirmed!\n');
    } else {
      console.log('  ❌ No audio received\n');
    }

  } finally {
    session.close();
  }

  console.log('=== All tests complete ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
