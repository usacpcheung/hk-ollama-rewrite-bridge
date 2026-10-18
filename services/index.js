const { createRewriteServiceDefinition } = require('../configuration/services');
const { createT2AServiceDefinition } = require('../configuration/services');

function createServiceRegistry({
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {},
  providerCapabilitiesForService,
  additionalServices = []
}) {
  const rewriteService = createRewriteServiceDefinition({
    parseEnvBoundedInteger,
    parseEnvMilliseconds,
    providerCapabilities: providerCapabilitiesForService?.('rewrite') || providerCapabilities
  });
  const t2aService = createT2AServiceDefinition({
    parseEnvBoundedInteger,
    parseEnvMilliseconds,
    providerCapabilities: providerCapabilitiesForService?.('t2a') || providerCapabilities
  });

  const definitions = [rewriteService, t2aService, ...additionalServices];
  const ids = new Set();
  for (const service of definitions) {
    if (typeof service?.id !== 'string' || !service.id.trim() || service.id !== service.id.trim() || ids.has(service.id)) {
      throw new TypeError('Service IDs must be non-empty, unique names without surrounding whitespace');
    }
    ids.add(service.id);
  }
  const services = definitions.map((service) => ({
    ...service,
    postProcessOutput: typeof service.postProcessOutput === 'function'
      ? service.postProcessOutput
      : ({ payload }) => payload,
    capabilities: {
      ...service.capabilities,
      streaming: service.capabilities?.streaming === true
    }
  }));

  return {
    get(serviceId) {
      return services.find((service) => service.id === serviceId) || null;
    },
    list() {
      return services;
    }
  };
}

module.exports = {
  createServiceRegistry
};
