const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');

function createProvider({
  provider = process.env.REWRITE_PROVIDER || 'ollama',
  ollamaUrl,
  ollamaPsUrl,
  ollamaModel,
  ollamaKeepAlive,
  minimaxApiUrl,
  minimaxReadinessUrl,
  minimaxModel,
  minimaxApiKey
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
    return createMinimaxProvider({
      apiUrl: minimaxApiUrl,
      readinessUrl: minimaxReadinessUrl,
      model: minimaxModel,
      apiKey: minimaxApiKey
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider };
