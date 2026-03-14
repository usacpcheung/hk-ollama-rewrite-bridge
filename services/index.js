const { createRewriteServiceDefinition } = require('./rewrite');

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

  const services = [rewriteService].map((service) => ({
    ...service,
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
