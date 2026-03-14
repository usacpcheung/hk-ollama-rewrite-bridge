const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRewriteConfig } = require('../services/rewrite');
const { PROVIDER_CAPABILITIES } = require('../providers');

function parseBounded(rawValue, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

test('new service-scoped key overrides legacy key', () => {
  const env = {
    REWRITE_MAX_COMPLETION_TOKENS: '111',
    REWRITE_PROVIDER_MINIMAX_MODEL: 'new-minimax-model',
    MINIMAX_MODEL: 'legacy-minimax-model'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.maxCompletionTokens, 111);
  assert.equal(config.providers.minimax.model, 'new-minimax-model');
  assert.equal(config.sources.minimaxModel.type, 'preferred');
});

test('legacy key still works when new key is absent', () => {
  const env = {
    OLLAMA_MODEL: 'legacy-ollama-model'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.providers.ollama.model, 'legacy-ollama-model');
  assert.equal(config.sources.ollamaModel.type, 'legacy');
});

test('defaults apply when both new and legacy keys are absent', () => {
  const config = resolveRewriteConfig({
    env: {},
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.provider, 'ollama');
  assert.equal(config.maxCompletionTokens, 300);
  assert.equal(config.maxTextLength, 200);
  assert.equal(config.sources.maxCompletionTokens.type, 'default');
  assert.equal(config.sources.maxTextLength.type, 'default');
  assert.equal(config.providers.minimax.apiUrl, 'https://api.minimax.io/v1/text/chatcompletion_v2');
  assert.equal(config.sources.minimaxApiUrl.type, 'default');
});

test('preferred minimax api url overrides legacy key', () => {
  const env = {
    REWRITE_MINIMAX_API_URL: 'https://preferred-minimax.example/v1/chat',
    MINIMAX_API_URL: 'https://legacy-minimax.example/v1/chat'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.providers.minimax.apiUrl, 'https://preferred-minimax.example/v1/chat');
  assert.equal(config.sources.minimaxApiUrl.type, 'preferred');
});

test('legacy minimax api url works when preferred keys are absent', () => {
  const env = {
    MINIMAX_API_URL: 'https://legacy-minimax.example/v1/chat'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.providers.minimax.apiUrl, 'https://legacy-minimax.example/v1/chat');
  assert.equal(config.sources.minimaxApiUrl.type, 'legacy');
});
