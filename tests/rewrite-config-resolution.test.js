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
  assert.equal(config.providers.ollama.generateUrl, 'http://127.0.0.1:11434/api/generate');
  assert.equal(config.providers.ollama.psUrl, 'http://127.0.0.1:11434/api/ps');
  assert.equal(config.sources.ollamaUrl.type, 'default');
  assert.equal(config.sources.ollamaPsUrl.type, 'default');
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


test('preferred ollama urls override legacy keys', () => {
  const env = {
    REWRITE_OLLAMA_URL: 'http://preferred-ollama.example/api/generate',
    REWRITE_PROVIDER_OLLAMA_PS_URL: 'http://preferred-ollama.example/api/ps',
    OLLAMA_URL: 'http://legacy-ollama.example/api/generate',
    OLLAMA_PS_URL: 'http://legacy-ollama.example/api/ps'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.providers.ollama.generateUrl, 'http://preferred-ollama.example/api/generate');
  assert.equal(config.providers.ollama.psUrl, 'http://preferred-ollama.example/api/ps');
  assert.equal(config.sources.ollamaUrl.type, 'preferred');
  assert.equal(config.sources.ollamaPsUrl.type, 'preferred');
});

test('legacy ollama urls work when preferred keys are absent', () => {
  const env = {
    OLLAMA_URL: 'http://legacy-ollama.example/api/generate',
    OLLAMA_PS_URL: 'http://legacy-ollama.example/api/ps'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.providers.ollama.generateUrl, 'http://legacy-ollama.example/api/generate');
  assert.equal(config.providers.ollama.psUrl, 'http://legacy-ollama.example/api/ps');
  assert.equal(config.sources.ollamaUrl.type, 'legacy');
  assert.equal(config.sources.ollamaPsUrl.type, 'legacy');
});

test('malformed preferred ready timeout falls back to legacy timeout', () => {
  const env = {
    REWRITE_READY_TIMEOUT_MS: 'not-a-number',
    OLLAMA_TIMEOUT_MS: '45000'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.timeouts.readyMs, 45000);
  assert.equal(config.sources.readyTimeoutMs.type, 'legacy');
  assert.equal(config.sources.readyTimeoutMs.key, 'OLLAMA_TIMEOUT_MS');
});

test('malformed preferred cold timeout falls back to legacy timeout', () => {
  const env = {
    REWRITE_COLD_TIMEOUT_MS: 'not-a-number',
    OLLAMA_COLD_TIMEOUT_MS: '180000'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.timeouts.coldMs, 180000);
  assert.equal(config.sources.coldTimeoutMs.type, 'legacy');
  assert.equal(config.sources.coldTimeoutMs.key, 'OLLAMA_COLD_TIMEOUT_MS');
});

test('malformed bounded integer key falls back to default with default source metadata', () => {
  const env = {
    REWRITE_MAX_TEXT_LENGTH: 'not-a-number'
  };

  const config = resolveRewriteConfig({
    env,
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: PROVIDER_CAPABILITIES
  });

  assert.equal(config.maxTextLength, 200);
  assert.equal(config.sources.maxTextLength.type, 'default');
  assert.equal(config.sources.maxTextLength.key, null);
});


test('streaming defaults to false when env is unset', () => {
  const config = resolveRewriteConfig({
    env: {
      REWRITE_PROVIDER: 'ollama'
    },
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {
      ollama: { streaming: true }
    }
  });

  assert.equal(config.selectedProviderStreamingEnabled, false);
  assert.equal(config.sources.streamingEnabled.type, 'default');
});

test('streaming is enabled when env is true and provider supports it', () => {
  const config = resolveRewriteConfig({
    env: {
      REWRITE_PROVIDER: 'ollama',
      REWRITE_STREAMING_ENABLED: 'TrUe'
    },
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {
      ollama: { streaming: true }
    }
  });

  assert.equal(config.selectedProviderStreamingEnabled, true);
  assert.equal(config.sources.streamingEnabled.type, 'preferred');
  assert.equal(config.sources.streamingEnabled.key, 'REWRITE_STREAMING_ENABLED');
});

test('streaming stays disabled when env is true but provider does not support it', () => {
  const config = resolveRewriteConfig({
    env: {
      REWRITE_PROVIDER: 'minimax',
      REWRITE_PROVIDER_STREAMING_ENABLED: '1'
    },
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {
      minimax: { streaming: false }
    }
  });

  assert.equal(config.selectedProviderStreamingEnabled, false);
  assert.equal(config.sources.streamingEnabled.type, 'preferred');
  assert.equal(config.sources.streamingEnabled.key, 'REWRITE_PROVIDER_STREAMING_ENABLED');
});

test('invalid streaming env value falls back to false', () => {
  const config = resolveRewriteConfig({
    env: {
      REWRITE_PROVIDER: 'ollama',
      REWRITE_OLLAMA_STREAMING_ENABLED: 'maybe'
    },
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {
      ollama: { streaming: true }
    }
  });

  assert.equal(config.selectedProviderStreamingEnabled, false);
  assert.equal(config.sources.streamingEnabled.type, 'default');
});
