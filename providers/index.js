const { createGoogleSpeechProvider } = require('./google-speech');
const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');
const { createProviderLifecycle } = require('./lifecycle');
const { createProviderRegistry } = require('../lib/provider-registry');

const { MINIMAX_USER_TEMPLATE, withRewriteService } = require('./service-requests');
const { resolveMinimaxSpeechRequest } = require('./minimax-t2a-compatibility');

function createUnsupportedProvider({ provider }) {
  return {
    name: provider,
    services: {},
    getInfo: () => ({ provider }),
    mapError: (error) => ({
      code: 'UNSUPPORTED_PROVIDER',
      message: error?.message || `Unsupported provider: ${provider}`,
      status: 501
    }),
    checkReadiness: async () => ({ ok: true }),
    triggerWarmup: async () => ({ ok: true })
  };
}

function buildOllama({ serviceConfig, ollamaUrl, ollamaPsUrl, ollamaKeepAlive, debugLog }) {
  const runtime = serviceConfig.provider.runtime || {};
  return withRewriteService(createOllamaProvider({
    generateUrl: runtime.generateUrl || ollamaUrl,
    psUrl: runtime.psUrl || ollamaPsUrl,
    model: runtime.model,
    keepAlive: ollamaKeepAlive,
    maxCompletionTokens: serviceConfig.provider.maxCompletionTokens,
    debugLog
  }), '原文：{TEXT}');
}

function buildMinimax({ serviceConfig, minimaxApiKey, debugLog }) {
  const runtime = serviceConfig.provider.runtime || {};
  const rewrite = serviceConfig.id === 'rewrite';
  const native = createMinimaxProvider({
    apiUrl: runtime.apiUrl,
    model: runtime.model,
    apiFormat: runtime.apiFormat,
    anthropicBaseUrl: runtime.anthropicBaseUrl,
    apiKey: minimaxApiKey,
    systemPrompt: rewrite ? serviceConfig.instructions : undefined,
    userTemplate: rewrite ? MINIMAX_USER_TEMPLATE : undefined,
    maxCompletionTokens: rewrite ? serviceConfig.provider.maxCompletionTokens : undefined,
    debugLog
  });
  if (rewrite) return withRewriteService(native, MINIMAX_USER_TEMPLATE);
  return { ...native, services: { t2a: { sync: request => native.t2a(request.voiceSelection
    ? { ...request, ...resolveMinimaxSpeechRequest(request, runtime.defaults) } : request) } } };
}

const providerRegistry = createProviderRegistry([
  { provider: 'google-speech', serviceId: 'transcription',
    create: ({ serviceConfig }) => createGoogleSpeechProvider(serviceConfig.provider.runtime),
    capabilities: { sync: true, streaming: false, lifecycle: 'none' } },
  { provider: 'ollama', serviceId: 'rewrite', create: buildOllama,
    capabilities: { sync: true, streaming: true, lifecycle: 'active_probe' } },
  { provider: 'minimax', serviceId: 'rewrite', create: buildMinimax,
    capabilities: { sync: true, streaming: true, lifecycle: 'passive_remote' } },
  { provider: 'minimax', serviceId: 't2a', create: buildMinimax,
    capabilities: { sync: true, streaming: false, lifecycle: 'none',
      audioFormats: ['mp3', 'wav', 'pcm'], legacyVoiceControls: true } }
]);

// Compatibility export for direct rewrite configuration consumers. Production
// composition uses capabilitiesFor(serviceId), never a provider-wide capability.
const PROVIDER_CAPABILITIES = providerRegistry.capabilitiesFor('rewrite');

function createProvider(options = {}, registry = providerRegistry) {
  const serviceId = options.serviceConfig?.id || 'rewrite';
  const provider = options.serviceConfig?.provider?.selected || 'ollama';
  if (!registry.supports(provider, serviceId)) {
    // Preserve request-time rejection for unsupported T2A selections. Rewrite
    // selections still fail startup; neither path silently selects another provider.
    if (serviceId === 't2a') return createUnsupportedProvider({ provider });
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return registry.create({
    ...options,
    serviceConfig: { ...options.serviceConfig, id: serviceId,
      provider: { ...options.serviceConfig?.provider, selected: provider } }
  });
}

module.exports = { createProvider, createProviderLifecycle, providerRegistry, PROVIDER_CAPABILITIES };
