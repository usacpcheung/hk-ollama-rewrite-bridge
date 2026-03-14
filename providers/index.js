const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');

const PROVIDER_CAPABILITIES = {
  ollama: {
    streaming: true
  },
  minimax: {
    streaming: true
  }
};

function createProvider({
  serviceConfig,
  ollamaUrl,
  ollamaPsUrl,
  ollamaKeepAlive,
  minimaxApiUrl,
  minimaxApiKey,
  minimaxSystemPrompt,
  minimaxUserTemplate,
  debugLog
}) {
  const provider = serviceConfig?.provider?.selected || 'ollama';
  const selectedRuntime = serviceConfig?.provider?.runtime || {};
  const maxCompletionTokens = serviceConfig?.provider?.maxCompletionTokens;

  if (provider === 'ollama') {
    return createOllamaProvider({
      generateUrl: ollamaUrl,
      psUrl: ollamaPsUrl,
      model: selectedRuntime.model,
      keepAlive: ollamaKeepAlive,
      maxCompletionTokens,
      debugLog
    });
  }

  if (provider === 'minimax') {
    return createMinimaxProvider({
      apiUrl: minimaxApiUrl,
      model: selectedRuntime.model,
      apiKey: minimaxApiKey,
      systemPrompt: minimaxSystemPrompt,
      userTemplate: minimaxUserTemplate,
      maxCompletionTokens,
      debugLog
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider, PROVIDER_CAPABILITIES };
