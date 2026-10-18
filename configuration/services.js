const { resolveRewriteConfig } = require('./rewrite');
const { resolveT2AConfig } = require('./t2a');
const { createRewriteServiceDefinition: defineRewrite } = require('../services/rewrite');
const { createT2AServiceDefinition: defineT2A } = require('../services/t2a');
const { minimaxT2APolicy } = require('../providers/minimax-t2a-compatibility');

function createRewriteServiceDefinition(options) {
  return defineRewrite({ config: resolveRewriteConfig(options) });
}
function createT2AServiceDefinition(options) {
  const config = resolveT2AConfig(options);
  // Unsupported selections retain legacy validation order, but are never invoked.
  const requestPolicy = config.providerSupported ? minimaxT2APolicy
    : { ...minimaxT2APolicy, supportsVoiceChoice: () => false };
  return defineT2A({ config, requestPolicy });
}
module.exports = { createRewriteServiceDefinition, createT2AServiceDefinition };
