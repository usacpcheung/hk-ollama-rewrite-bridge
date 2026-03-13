const { createRewriteServiceDefinition } = require('./rewrite');

function createServiceRegistry({ parseEnvBoundedInteger, provider, readyTimeoutMs, coldTimeoutMs }) {
  const rewriteService = createRewriteServiceDefinition({
    parseEnvBoundedInteger,
    provider,
    readyTimeoutMs,
    coldTimeoutMs
  });

  return {
    get(serviceId) {
      if (serviceId === rewriteService.id) {
        return rewriteService;
      }

      return null;
    },
    list() {
      return [rewriteService];
    }
  };
}

module.exports = {
  createServiceRegistry
};
