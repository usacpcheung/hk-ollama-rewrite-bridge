// Registry entries are code-owned: environment values select registrations,
// never module paths. Factories run only when the selected pair is constructed.
function createProviderRegistry(definitions) {
  const entries = new Map();
  for (const { provider, serviceId, create, capabilities } of definitions) {
    if (typeof provider !== 'string' || !provider.trim() ||
        typeof serviceId !== 'string' || !serviceId.trim() || typeof create !== 'function' ||
        capabilities?.sync !== true || typeof capabilities.streaming !== 'boolean') {
      throw new TypeError('Provider registrations require names, a factory and sync/streaming capabilities');
    }
    if (!entries.has(provider)) entries.set(provider, new Map());
    const services = entries.get(provider);
    if (services.has(serviceId)) throw new Error(`Duplicate provider registration: ${provider}/${serviceId}`);
    const snapshot = Object.freeze({
      ...capabilities,
      ...(capabilities.audioFormats ? { audioFormats: Object.freeze([...capabilities.audioFormats]) } : {})
    });
    services.set(serviceId, { create, capabilities: snapshot });
  }
  const get = (provider, serviceId) => entries.get(provider)?.get(serviceId);
  return Object.freeze({
    supports: (provider, serviceId) => Boolean(get(provider, serviceId)),
    capabilitiesFor(serviceId) {
      return Object.freeze(Object.fromEntries([...entries].flatMap(([provider, services]) => {
        const entry = services.get(serviceId);
        return entry ? [[provider, entry.capabilities]] : [];
      })));
    },
    create(options) {
      const { id: serviceId, provider: { selected: provider } } = options.serviceConfig;
      const entry = get(provider, serviceId);
      if (!entry) throw new Error(`Unregistered provider/service: ${provider}/${serviceId}`);
      const instance = entry.create(options);
      const handlers = instance?.services?.[serviceId];
      if (typeof handlers?.sync !== 'function' ||
          (entry.capabilities.streaming !== (typeof handlers.stream === 'function')) ||
          typeof instance.mapError !== 'function') {
        throw new TypeError(`Provider factory violates contract: ${provider}/${serviceId}`);
      }
      return { ...instance, capabilities: entry.capabilities };
    }
  });
}

module.exports = { createProviderRegistry };
