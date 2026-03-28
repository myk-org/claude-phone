import { test } from 'node:test';
import assert from 'node:assert';
import {
  validateGoogleApiKey,
  validateVoiceName
} from '../lib/validators.js';

test('validators module', async (t) => {
  await t.test('validateGoogleApiKey rejects empty key', async () => {
    const result = await validateGoogleApiKey('');
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /API key cannot be empty/);
  });

  await t.test('validateGoogleApiKey rejects invalid format', async () => {
    const result = await validateGoogleApiKey('invalid-key');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
  });

  await t.test('validateVoiceName accepts valid voice', async () => {
    const result = await validateVoiceName(null, 'Kore');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.name, 'Kore');
  });

  await t.test('validateVoiceName rejects invalid voice', async () => {
    const result = await validateVoiceName(null, 'InvalidVoice');
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /Unknown voice name/);
  });

  await t.test('validateVoiceName rejects empty voice', async () => {
    const result = await validateVoiceName(null, '');
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /Voice name cannot be empty/);
  });

  // Note: We can't test successful Google API validation without real API keys
  // These would be integration tests, not unit tests
});
