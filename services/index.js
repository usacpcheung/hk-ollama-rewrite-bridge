const { createRewriteServiceDefinition } = require('./rewrite');
const { createT2AServiceDefinition } = require('./t2a');

function createServiceRegistry({
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {}
}) {
  const rewriteService = createRewriteServiceDefinition({
    parseEnvBoundedInteger,
    parseEnvMilliseconds,
    providerCapabilities
  });
  const t2aService = createT2AServiceDefinition({
    parseEnvBoundedInteger,
    providerCapabilities
  });

  const services = [rewriteService, t2aService].map((service) => ({
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
