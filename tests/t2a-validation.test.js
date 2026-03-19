const test = require('node:test');
const assert = require('node:assert/strict');

const { createT2AServiceDefinition } = require('../services/t2a');

function parseBounded(rawValue, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function createService(env = {}) {
  const originalEnv = process.env;
  process.env = { ...originalEnv, ...env };
  try {
    return createT2AServiceDefinition({
      parseEnvBoundedInteger: parseBounded,
      providerCapabilities: { minimax: { streaming: false } }
    });
  } finally {
    process.env = originalEnv;
  }
}

test('t2a validation rejects missing text', () => {
  const service = createService();

  const result = service.validateRequest({ body: {} });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'INVALID_INPUT');
  assert.equal(result.message, 'text is required');
});

test('t2a validation enforces Unicode-aware text length counting', () => {
  const service = createService({ T2A_MAX_TEXT_LENGTH: '4' });

  const withinLimit = service.validateRequest({ body: { text: 'a😊bc' } });
  assert.equal(withinLimit.ok, true);
  assert.equal(withinLimit.value.inputCharCount, 4);

  const overLimit = service.validateRequest({ body: { text: 'a😊bcd' } });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.status, 413);
  assert.equal(overLimit.code, 'TOO_LONG');
});

test('t2a validation rejects invalid voice controls and audio options', () => {
  const service = createService();

  const invalidVoiceId = service.validateRequest({ body: { text: '你好', voice_id: '   ' } });
  assert.equal(invalidVoiceId.ok, false);
  assert.equal(invalidVoiceId.message, 'voice_id must be a non-empty string');

  const invalidSpeed = service.validateRequest({ body: { text: '你好', speed: '4' } });
  assert.equal(invalidSpeed.ok, false);
  assert.equal(invalidSpeed.message, 'speed must be a number between 0.5 and 2');

  const invalidVolume = service.validateRequest({ body: { text: '你好', volume: '-1' } });
  assert.equal(invalidVolume.ok, false);
  assert.equal(invalidVolume.message, 'volume must be a number between 0 and 10');

  const invalidPitch = service.validateRequest({ body: { text: '你好', pitch: '100' } });
  assert.equal(invalidPitch.ok, false);
  assert.equal(invalidPitch.message, 'pitch must be a number between -12 and 12');

  const invalidSampleRate = service.validateRequest({ body: { text: '你好', sample_rate: '1234' } });
  assert.equal(invalidSampleRate.ok, false);
  assert.equal(invalidSampleRate.message, 'sample_rate must be an integer between 8000 and 48000');
});

test('t2a validation rejects invalid response mode', () => {
  const service = createService();

  const result = service.validateRequest({ body: { text: '你好', response_mode: 'hex' } });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'INVALID_INPUT');
  assert.equal(result.message, 'response_mode must be binary/default or base64_json');
});

test('t2a validation rejects stream true as unsupported in v1', () => {
  const service = createService();

  const result = service.validateRequest({ body: { text: '你好', stream: true } });

  assert.equal(result.ok, false);
  assert.equal(result.status, 501);
  assert.equal(result.code, 'STREAMING_UNSUPPORTED');
  assert.equal(result.message, 'stream is not supported for t2a v1');
});
