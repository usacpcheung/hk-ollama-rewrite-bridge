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
});
