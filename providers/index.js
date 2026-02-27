const { createOllamaProvider } = require('./ollama');
const { createMiniMaxProvider } = require('./minimax');

function createProvider({
  provider = process.env.REWRITE_PROVIDER || 'ollama',
  ollamaUrl,
  ollamaPsUrl,
  ollamaModel,
  ollamaKeepAlive,
  minimaxEndpoint,
  minimaxModel,
  minimaxApiKey,
  minimaxTimeoutMs
}) {
  if (provider === 'ollama') {
    return createOllamaProvider({
      generateUrl: ollamaUrl,
      psUrl: ollamaPsUrl,
      model: ollamaModel,
      keepAlive: ollamaKeepAlive
    });
  }

  if (provider === 'minimax') {
    if (!minimaxApiKey) {
      throw new Error('MINIMAX_API_KEY is required when REWRITE_PROVIDER=minimax');
    }

    return createMiniMaxProvider({
      endpoint: minimaxEndpoint,
      model: minimaxModel,
      apiKey: minimaxApiKey,
      timeoutMs: minimaxTimeoutMs
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider };
