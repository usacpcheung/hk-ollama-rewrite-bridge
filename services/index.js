const { createRewriteServiceDefinition } = require('./rewrite');

function createServiceRegistry({
  parseEnvBoundedInteger,
  provider,
  providerCapabilities = {},
  readyTimeoutMs,
  coldTimeoutMs
}) {
  const rewriteService = createRewriteServiceDefinition({
    parseEnvBoundedInteger,
    provider,
    readyTimeoutMs,
    coldTimeoutMs,
    providerCapabilities
  });

  const services = [rewriteService].map((service) => ({
    ...service,
    capabilities: {
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
