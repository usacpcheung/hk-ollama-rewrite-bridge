function createServiceRuntimes({
  serviceRegistry,
  createProvider,
  createProviderAdapter,
  createProviderOptions,
  createLifecycle,
  createLifecycleOptions
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
    const lifecycleOptions = typeof createLifecycleOptions === 'function'
      ? createLifecycleOptions({ service, serviceRegistry, providerName, adapter })
      : {};
    const lifecycle = typeof createLifecycle === 'function'
      ? createLifecycle({
        service,
        serviceId: service.id,
        providerName,
        adapter,
        options: lifecycleOptions
      })
      : null;

    runtimeByServiceId.set(service.id, {
      service,
      providerName,
      adapter,
      lifecycle,
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
