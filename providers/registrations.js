const { createGoogleSpeechProvider } = require('./google-speech');
const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');
const { ollamaLifecycle, minimaxLifecycle, minimaxAvailability } = require('./configuration/lifecycle');
const { minimaxT2APolicy } = require('./minimax-t2a-compatibility');

const { MINIMAX_USER_TEMPLATE, withRewriteService } = require('./service-requests');
const { resolveMinimaxSpeechRequest } = require('./minimax-t2a-compatibility');

function buildOllama({ serviceConfig, ollamaUrl, ollamaPsUrl, ollamaKeepAlive, debugLog }) {
  const runtime = serviceConfig.provider.runtime || {};
  return withRewriteService(createOllamaProvider({
    generateUrl: runtime.generateUrl || ollamaUrl,
    psUrl: runtime.psUrl || ollamaPsUrl,
    model: runtime.model,
    keepAlive: ollamaKeepAlive ?? runtime.keepAlive,
    maxCompletionTokens: serviceConfig.provider.maxCompletionTokens,
    debugLog
  }), '原文：{TEXT}');
}

function buildMinimax({ serviceConfig, minimaxApiKey, debugLog, env = process.env }) {
  const runtime = serviceConfig.provider.runtime || {};
  const rewrite = serviceConfig.id === 'rewrite';
  const native = createMinimaxProvider({
    apiUrl: runtime.apiUrl,
    model: runtime.model,
    apiFormat: runtime.apiFormat,
    thinking: rewrite ? runtime.thinking : undefined,
    anthropicBaseUrl: runtime.anthropicBaseUrl,
    apiKey: minimaxApiKey ?? env.MINIMAX_API_KEY,
    systemPrompt: rewrite ? serviceConfig.instructions : undefined,
    userTemplate: rewrite ? MINIMAX_USER_TEMPLATE : undefined,
    maxCompletionTokens: rewrite ? serviceConfig.provider.maxCompletionTokens : undefined,
    debugLog
  });
  if (rewrite) return withRewriteService(native, MINIMAX_USER_TEMPLATE);
  return { ...native, services: { t2a: { sync: request => native.t2a(request.voiceSelection
    ? { ...request, ...resolveMinimaxSpeechRequest(request, runtime.defaults) } : request) } } };
}

module.exports = [
  { provider: 'google-speech', serviceId: 'transcription',
    create: ({ serviceConfig }) => createGoogleSpeechProvider(serviceConfig.provider.runtime),
    readConfiguration: require('./configuration/google-transcription').readConfiguration,
    capabilities: { sync: true, streaming: false, lifecycle: 'none' } },
  { provider: 'ollama', serviceId: 'rewrite', create: buildOllama,
    readConfiguration: require('./configuration/ollama-rewrite').readConfiguration, lifecycleOptions: ollamaLifecycle,
    capabilities: { sync: true, streaming: true, lifecycle: 'active_probe' } },
  { provider: 'minimax', serviceId: 'rewrite', create: buildMinimax,
    readConfiguration: require('./configuration/minimax-rewrite').readConfiguration,
    lifecycleOptions: minimaxLifecycle, availability: minimaxAvailability,
    capabilities: { sync: true, streaming: true, lifecycle: 'passive_remote' } },
  { provider: 'minimax', serviceId: 't2a', create: buildMinimax,
    readConfiguration: require('./configuration/minimax-t2a').readConfiguration,
    requestPolicy: minimaxT2APolicy, availability: minimaxAvailability,
    capabilities: { sync: true, streaming: false, lifecycle: 'none',
      audioFormats: ['mp3', 'wav', 'pcm'], legacyVoiceControls: true } }
];
