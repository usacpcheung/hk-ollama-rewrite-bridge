const test = require('node:test');
const assert = require('node:assert/strict');

const { createT2AServiceDefinition } = require('../configuration/services');

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
      parseEnvMilliseconds: parseBounded,
      providerCapabilities: { minimax: { streaming: false } }
    });
  } finally {
    process.env = originalEnv;
  }
}

test('T2A budget boundaries count trimmed Unicode text and punctuation', () => {
  for (const [raw, limit] of [['', 200], ['500', 500], ['1000', 1000], ['1001', 1000], ['bad', 200]]) {
    const service = createService({ T2A_MAX_TEXT_LENGTH: raw });
    const text = '中'.repeat(limit - 3) + ' 😊。';
    const accepted = service.validateRequest({ body: { text: ` \n${text}\t ` } });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.inputCharCount, limit);
    assert.equal(accepted.value.trimmedText, text);
    const rejected = service.validateRequest({ body: { text: text + '！' } });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.code, 'TOO_LONG');
    assert.equal(rejected.message, `Max ${limit} characters`);
    for (const empty of ['', ' \n\t　']) {
      const result = service.validateRequest({ body: { text: empty } });
      assert.equal(result.status, 400);
      assert.equal(result.code, 'INVALID_INPUT');
    }
  }
});

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

  const invalidLanguageBoost = service.validateRequest({ body: { text: '你好', language_boost: '   ' } });
  assert.equal(invalidLanguageBoost.ok, false);
  assert.equal(invalidLanguageBoost.message, 'language_boost must be a non-empty string');

  const nonStringLanguageBoost = service.validateRequest({ body: { text: '你好', language_boost: ['Chinese,Yue'] } });
  assert.equal(nonStringLanguageBoost.ok, false);
  assert.equal(nonStringLanguageBoost.message, 'language_boost must be a non-empty string');

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

test('t2a validation leaves defaults to the adapter and normalizes explicit legacy controls', () => {
  const service = createService();

  const defaultResult = service.validateRequest({ body: { text: '你好' } });
  assert.equal(defaultResult.ok, true);
  assert.deepEqual(defaultResult.value.voiceSelection, { kind: 'default' });

  const overrideResult = service.validateRequest({ body: { text: 'Hello', language_boost: ' English ' } });
  assert.equal(overrideResult.ok, true);
  assert.deepEqual(overrideResult.value.voiceSelection, { kind: 'legacy', controls: { languageBoost: 'English' } });
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

test('named voices retain text, streaming and output validation', () => {
  const service = createService({ T2A_MAX_TEXT_LENGTH: '4', T2A_PROVIDER: 'minimax' });
  const choice = { voice_choice: 'cantonese_male_1' };
  for (const [body, status, code] of [
    [{ ...choice, text: '' }, 400, 'INVALID_INPUT'],
    [{ ...choice, text: 'a😊bcd' }, 413, 'TOO_LONG'],
    [{ ...choice, text: '你好', stream: true }, 501, 'STREAMING_UNSUPPORTED'],
    [{ ...choice, text: '你好', sample_rate: 1234 }, 400, 'INVALID_INPUT'],
    [{ ...choice, text: '你好', bitrate: 1 }, 400, 'INVALID_INPUT'],
    [{ ...choice, text: '你好', format: 'invalid' }, 400, 'INVALID_INPUT'],
    [{ ...choice, text: '你好', response_mode: 'hex' }, 400, 'INVALID_INPUT']
  ]) {
    const result = service.validateRequest({ body });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.code, code);
  }
  const result = service.validateRequest({ body: {
    ...choice, text: ' a😊bc ', response_mode: 'base64-json',
    sample_rate: 24000, bitrate: 64000, format: 'wav'
  } });
  assert.equal(result.ok, true);
  assert.equal(result.value.inputCharCount, 4);
  assert.equal(result.value.responseMode, 'base64_json');
  assert.deepEqual(result.value.audio, { sampleRate: 24000, bitrate: 64000, format: 'wav', channel: 1 });
});
