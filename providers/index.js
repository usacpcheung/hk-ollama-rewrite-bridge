const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');


function ensureServiceHandlers(provider) {
  const services = provider?.services ? { ...provider.services } : {};
  if (!services.rewrite && (provider?.rewrite || provider?.rewriteStream)) {
    services.rewrite = {
      ...(typeof provider.rewrite === 'function' ? { sync: provider.rewrite } : {}),
      ...(typeof provider.rewriteStream === 'function' ? { stream: provider.rewriteStream } : {})
    };
  }

  return {
    ...provider,
    services
  };
}

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
  minimaxApiKey,
  minimaxSystemPrompt,
  minimaxUserTemplate,
  debugLog
}) {
  const provider = serviceConfig?.provider?.selected || 'ollama';
  const selectedRuntime = serviceConfig?.provider?.runtime || {};
  const maxCompletionTokens = serviceConfig?.provider?.maxCompletionTokens;

  if (provider === 'ollama') {
    return ensureServiceHandlers(createOllamaProvider({
      generateUrl: selectedRuntime.generateUrl || ollamaUrl,
      psUrl: selectedRuntime.psUrl || ollamaPsUrl,
      model: selectedRuntime.model,
      keepAlive: ollamaKeepAlive,
      maxCompletionTokens,
      debugLog
    }));
  }

  if (provider === 'minimax') {
    return ensureServiceHandlers(createMinimaxProvider({
      apiUrl: selectedRuntime.apiUrl,
      model: selectedRuntime.model,
      apiKey: minimaxApiKey,
      systemPrompt: minimaxSystemPrompt,
      userTemplate: minimaxUserTemplate,
      maxCompletionTokens,
      debugLog
    }));
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider, PROVIDER_CAPABILITIES };
