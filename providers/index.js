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
  provider = process.env.REWRITE_PROVIDER || 'ollama',
  ollamaUrl,
  ollamaPsUrl,
  ollamaModel,
  ollamaKeepAlive,
  rewriteMaxCompletionTokens,
  minimaxApiUrl,
  minimaxModel,
  minimaxApiKey,
  minimaxSystemPrompt,
  minimaxUserTemplate,
  debugLog
}) {
  if (provider === 'ollama') {
    return createOllamaProvider({
      generateUrl: ollamaUrl,
      psUrl: ollamaPsUrl,
      model: ollamaModel,
      keepAlive: ollamaKeepAlive,
      maxCompletionTokens: rewriteMaxCompletionTokens,
      debugLog
    });
  }

  if (provider === 'minimax') {
    return createMinimaxProvider({
      apiUrl: minimaxApiUrl,
      model: minimaxModel,
      apiKey: minimaxApiKey,
      systemPrompt: minimaxSystemPrompt,
      userTemplate: minimaxUserTemplate,
      maxCompletionTokens: rewriteMaxCompletionTokens,
      debugLog
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider, PROVIDER_CAPABILITIES };
