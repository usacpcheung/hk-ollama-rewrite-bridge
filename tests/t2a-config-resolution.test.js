const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveT2AConfig } = require('../services/t2a');

function parseBounded(rawValue, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

test('preferred service-scoped T2A keys override legacy minimax smoke envs', () => {
  const env = {
    T2A_MODEL: 'preferred-short-model',
    T2A_MINIMAX_API_URL: 'https://preferred.example/v1/t2a',
    T2A_VOICE_ID: 'preferred-voice',
    T2A_SPEED: '1.25',
    T2A_VOLUME: '2',
    T2A_PITCH: '3',
    MINIMAX_T2A_MODEL: 'legacy-model',
    MINIMAX_T2A_URL: 'https://legacy.example/v1/t2a',
    MINIMAX_T2A_VOICE_ID: 'legacy-voice',
    MINIMAX_T2A_SPEED: '1.5',
    MINIMAX_T2A_VOLUME: '4',
    MINIMAX_T2A_PITCH: '5'
  };

  const config = resolveT2AConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    providerCapabilities: { minimax: { streaming: false } }
  });

  assert.equal(config.provider, 'minimax');
  assert.equal(config.providers.minimax.model, 'preferred-short-model');
  assert.equal(config.providers.minimax.apiUrl, 'https://preferred.example/v1/t2a');
  assert.equal(config.providers.minimax.defaults.voiceId, 'preferred-voice');
  assert.equal(config.providers.minimax.defaults.speed, 1.25);
  assert.equal(config.providers.minimax.defaults.volume, 2);
  assert.equal(config.providers.minimax.defaults.pitch, 3);
  assert.equal(config.sources.minimaxModel.type, 'preferred');
  assert.equal(config.sources.minimaxApiUrl.type, 'preferred');
  assert.equal(config.sources.voiceId.type, 'preferred');
  assert.equal(config.sources.speed.type, 'preferred');
  assert.equal(config.sources.volume.type, 'preferred');
  assert.equal(config.sources.pitch.type, 'preferred');
});

test('legacy minimax smoke envs work when preferred T2A keys are absent', () => {
  const env = {
    MINIMAX_T2A_URL: 'https://legacy.example/v1/t2a',
    MINIMAX_T2A_MODEL: 'legacy-model',
    MINIMAX_T2A_VOICE_ID: 'legacy-voice',
    MINIMAX_T2A_SPEED: '1.1',
    MINIMAX_T2A_VOLUME: '3',
    MINIMAX_T2A_PITCH: '-2'
  };

  const config = resolveT2AConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    providerCapabilities: { minimax: { streaming: false } }
  });

  assert.equal(config.providers.minimax.apiUrl, 'https://legacy.example/v1/t2a');
  assert.equal(config.providers.minimax.model, 'legacy-model');
  assert.equal(config.providers.minimax.defaults.voiceId, 'legacy-voice');
  assert.equal(config.providers.minimax.defaults.speed, 1.1);
  assert.equal(config.providers.minimax.defaults.volume, 3);
  assert.equal(config.providers.minimax.defaults.pitch, -2);
  assert.equal(config.sources.minimaxApiUrl.type, 'legacy');
  assert.equal(config.sources.minimaxModel.type, 'legacy');
  assert.equal(config.sources.voiceId.type, 'legacy');
  assert.equal(config.sources.speed.type, 'legacy');
  assert.equal(config.sources.volume.type, 'legacy');
  assert.equal(config.sources.pitch.type, 'legacy');
});

test('defaults apply when T2A env keys are absent', () => {
  const config = resolveT2AConfig({
    env: {},
    parseEnvBoundedInteger: parseBounded,
    providerCapabilities: { minimax: { streaming: false } }
  });

  assert.equal(config.provider, 'minimax');
  assert.equal(config.maxTextLength, 200);
  assert.equal(config.providers.minimax.apiUrl, 'https://api.minimaxi.chat/v1/t2a_v2');
  assert.equal(config.providers.minimax.model, 'speech-02-hd');
  assert.equal(config.providers.minimax.defaults.voiceId, 'female-tianmei');
  assert.equal(config.providers.minimax.defaults.speed, 1);
  assert.equal(config.providers.minimax.defaults.volume, 1);
  assert.equal(config.providers.minimax.defaults.pitch, 0);
  assert.equal(config.sources.maxTextLength.type, 'default');
  assert.equal(config.sources.minimaxApiUrl.type, 'default');
  assert.equal(config.sources.minimaxModel.type, 'default');
  assert.equal(config.sources.voiceId.type, 'default');
});

test('malformed preferred T2A env values fall back to legacy values or defaults', () => {
  const env = {
    T2A_MAX_TEXT_LENGTH: 'bad',
    T2A_SPEED: 'fast',
    T2A_VOLUME: 'loud',
    T2A_PITCH: 'high',
    MINIMAX_T2A_SPEED: '1.4',
    MINIMAX_T2A_VOLUME: '4',
    MINIMAX_T2A_PITCH: '-1'
  };

  const config = resolveT2AConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    providerCapabilities: { minimax: { streaming: false } }
  });

  assert.equal(config.maxTextLength, 200);
  assert.equal(config.providers.minimax.defaults.speed, 1.4);
  assert.equal(config.providers.minimax.defaults.volume, 4);
  assert.equal(config.providers.minimax.defaults.pitch, -1);
  assert.equal(config.sources.maxTextLength.type, 'default');
  assert.equal(config.sources.speed.type, 'legacy');
  assert.equal(config.sources.volume.type, 'legacy');
  assert.equal(config.sources.pitch.type, 'legacy');
});
