const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');

function createProvider({
  provider = process.env.REWRITE_PROVIDER || 'ollama',
  ollamaUrl,
  ollamaPsUrl,
  ollamaModel,
  ollamaKeepAlive,
  minimaxApiUrl,
  minimaxApiStyle,
  minimaxOpenaiBaseUrl,
  minimaxModel,
  minimaxApiKey,
  minimaxSystemPrompt,
  minimaxUserTemplate
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
      apiStyle: minimaxApiStyle,
      openaiBaseUrl: minimaxOpenaiBaseUrl,
      model: minimaxModel,
      apiKey: minimaxApiKey,
      systemPrompt: minimaxSystemPrompt,
      userTemplate: minimaxUserTemplate
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider };
