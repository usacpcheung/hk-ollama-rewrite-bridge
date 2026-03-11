const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');

function createProvider({
  provider = process.env.REWRITE_PROVIDER || 'ollama',
  ollamaUrl,
  ollamaPsUrl,
  ollamaModel,
  ollamaKeepAlive,
  rewriteMaxTokens,
  minimaxApiUrl,
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
      keepAlive: ollamaKeepAlive,
      rewriteMaxTokens
    });
  }

  if (provider === 'minimax') {
    return createMinimaxProvider({
      apiUrl: minimaxApiUrl,
      model: minimaxModel,
      apiKey: minimaxApiKey,
      systemPrompt: minimaxSystemPrompt,
      userTemplate: minimaxUserTemplate,
      rewriteMaxTokens
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

module.exports = { createProvider };
