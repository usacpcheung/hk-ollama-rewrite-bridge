const { createOllamaProvider } = require('./ollama');
const { createMinimaxProvider } = require('./minimax');
const { createProviderLifecycle } = require('./lifecycle');
const { createProviderRegistry } = require('../lib/provider-registry');


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
  return ensureServiceHandlers(createOllamaProvider({
    generateUrl: runtime.generateUrl || ollamaUrl,
    psUrl: runtime.psUrl || ollamaPsUrl,
    model: runtime.model,
    keepAlive: ollamaKeepAlive,
    maxCompletionTokens: serviceConfig.provider.maxCompletionTokens,
    debugLog
  }));
}

function buildMinimax({ serviceConfig, minimaxApiKey, minimaxSystemPrompt, minimaxUserTemplate, debugLog }) {
  const runtime = serviceConfig.provider.runtime || {};
  const rewrite = serviceConfig.id === 'rewrite';
  return ensureServiceHandlers(createMinimaxProvider({
    apiUrl: runtime.apiUrl,
    model: runtime.model,
    apiFormat: runtime.apiFormat,
    anthropicBaseUrl: runtime.anthropicBaseUrl,
    apiKey: minimaxApiKey,
    systemPrompt: rewrite ? minimaxSystemPrompt : undefined,
    userTemplate: rewrite ? minimaxUserTemplate : undefined,
    maxCompletionTokens: rewrite ? serviceConfig.provider.maxCompletionTokens : undefined,
    debugLog
  }));
}

const providerRegistry = createProviderRegistry([
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
