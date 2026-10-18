const { resolveRewriteConfig } = require('./rewrite');
const { resolveT2AConfig } = require('./t2a');
const { createRewriteServiceDefinition: defineRewrite } = require('../services/rewrite');
const { createT2AServiceDefinition: defineT2A } = require('../services/t2a');
const { unsupportedT2APolicy } = require('./unsupported-t2a');
function createRewriteServiceDefinition(options = {}) {
  const service = defineRewrite({ config: resolveRewriteConfig({ ...options, selectedOnly: true }) });
  service.capabilities.byProvider = options.providerCapabilities || (options.registry || require('../providers').providerRegistry).capabilitiesFor('rewrite');
  return service;
}
function createT2AServiceDefinition(options = {}) {
  const registry = options.registry || require('../providers').providerRegistry;
  const config = resolveT2AConfig({ ...options, registry, selectedOnly: true });
  const requestPolicy = config.providerSupported ? registry.registration(config.provider, 't2a').requestPolicy : unsupportedT2APolicy;
  if (!requestPolicy || typeof requestPolicy.validateControls !== 'function' ||
      typeof requestPolicy.supportsVoiceChoice !== 'function' || !Array.isArray(requestPolicy.legacyFields)) {
    throw new TypeError('T2A registration requires a request policy');
  }
  return defineT2A({ config, requestPolicy });
}
module.exports = { createRewriteServiceDefinition, createT2AServiceDefinition };
