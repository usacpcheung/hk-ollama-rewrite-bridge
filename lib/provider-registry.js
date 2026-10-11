// Registry entries are code-owned: environment values select registrations,
// never module paths. Factories run only when the selected pair is constructed.
function createProviderRegistry(definitions) {
  const entries = new Map();
  for (const { provider, serviceId, create, capabilities, readConfiguration, requestPolicy, lifecycleOptions, availability } of definitions) {
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
    for (const fn of [readConfiguration, lifecycleOptions, availability]) {
      if (fn !== undefined && typeof fn !== 'function') throw new TypeError('Registration hooks must be functions');
    }
    if (capabilities.lifecycle !== undefined && !['none', 'active_probe', 'passive_remote'].includes(capabilities.lifecycle)) {
      throw new TypeError('Unsupported lifecycle mode');
    }
    services.set(serviceId, Object.freeze({ create, capabilities: snapshot, readConfiguration, requestPolicy, lifecycleOptions, availability }));
  }
  const get = (provider, serviceId) => entries.get(provider)?.get(serviceId);
  return Object.freeze({
    providersFor: serviceId => [...entries].filter(([, services]) => services.has(serviceId)).map(([name]) => name),
    registration: (provider, serviceId) => get(provider, serviceId) || null,
    readConfiguration(provider, serviceId, options) {
      const entry = get(provider, serviceId);
      if (typeof entry?.readConfiguration !== 'function') throw new TypeError(`Missing configuration reader: ${provider}/${serviceId}`);
      const result = entry.readConfiguration(options);
      if (!result?.runtime || typeof result.runtime !== 'object' || Array.isArray(result.runtime)) throw new TypeError(`Invalid configuration: ${provider}/${serviceId}`);
      return result;
    },
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
      if (entry.capabilities.lifecycle === 'active_probe' &&
          (typeof instance.checkReadiness !== 'function' || typeof instance.triggerWarmup !== 'function')) {
        throw new TypeError(`Active lifecycle requires readiness/warmup methods: ${provider}/${serviceId}`);
      }
      // Copy data, but explicitly forward interface methods to their original
      // receiver. Class/prototype methods and private state must survive wrapping.
      const adapter = { ...instance, services: instance.services, capabilities: entry.capabilities,
        getAvailability: () => entry.availability?.(options) || null,
        lifecycleOptions: entry.lifecycleOptions?.({ env: options.env || process.env }) || {} };
      for (const method of ['mapError', 'getInfo', 'checkReadiness', 'triggerWarmup', 'rewrite', 'rewriteStream', 'close']) {
        if (typeof instance[method] === 'function') adapter[method] = instance[method].bind(instance);
      }
      return adapter;
    }
  });
}

module.exports = { createProviderRegistry };
