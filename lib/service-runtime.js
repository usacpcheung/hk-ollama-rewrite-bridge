function createServiceRuntimes({
  serviceRegistry,
  createProvider,
  createProviderAdapter,
  createProviderOptions
}) {
  if (!serviceRegistry || typeof serviceRegistry.list !== 'function') {
    throw new Error('serviceRegistry with list() is required');
  }

  if (typeof createProvider !== 'function') {
    throw new Error('createProvider is required');
  }

  if (typeof createProviderAdapter !== 'function') {
    throw new Error('createProviderAdapter is required');
  }

  const runtimeByServiceId = new Map();

  for (const service of serviceRegistry.list()) {
    const providerName = service?.provider?.selected;
    const providerOptions = typeof createProviderOptions === 'function'
      ? createProviderOptions({ service, serviceRegistry })
      : {};
    const provider = createProvider({
      serviceConfig: service,
      ...providerOptions
    });
    const adapter = createProviderAdapter(provider);

    runtimeByServiceId.set(service.id, {
      service,
      providerName,
      adapter,
      capabilities: service.capabilities || {},
      timeouts: service.timeouts || {}
    });
  }

  return {
    get(serviceId) {
      return runtimeByServiceId.get(serviceId) || null;
    },
    list() {
      return Array.from(runtimeByServiceId.values());
    }
  };
}

module.exports = {
  createServiceRuntimes
};
