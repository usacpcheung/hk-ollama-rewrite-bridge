const { createProviderRegistry } = require('../lib/provider-registry');
const { createProviderLifecycle: defineLifecycle } = require('./lifecycle');
const providerRegistry = createProviderRegistry(require('./registrations'));

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

function createProviderLifecycle({ providerName, serviceId, adapter, provider, service, options = {}, registry = providerRegistry }) {
  const registration = registry.registration(providerName, serviceId);
  const settings = provider?.lifecycleOptions || registration?.lifecycleOptions?.({ legacy: options }) || {};
  const availability = provider?.getAvailability || (() => registration?.availability?.({
    ...options, serviceConfig: { id: serviceId } }) || null);
  return defineLifecycle({ providerName, serviceId, adapter,
    mode: provider?.capabilities?.lifecycle || registration?.capabilities.lifecycle || 'none',
    options: { ...settings, availability } });
}

module.exports = { createProvider, createProviderLifecycle, providerRegistry, PROVIDER_CAPABILITIES };
