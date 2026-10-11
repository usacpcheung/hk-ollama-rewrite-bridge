const { readTranscriptionConfig } = require('../lib/transcription-config');
const { createProvider, providerRegistry } = require('../providers');
const { createTranscriptionService: defineTranscription } = require('../services/transcription');
function createTranscriptionService({ env = process.env, registry = providerRegistry,
  config = readTranscriptionConfig(env, registry), provider, normalize } = {}) {
  if (!config.enabled) return defineTranscription({ config });
  const selected = provider || createProvider({ env, serviceConfig: {
    id: 'transcription', provider: { selected: config.provider, runtime: config.providerConfig }
  } }, registry);
  // Service configuration does not receive credentials or native model/options.
  const { provider: _provider, providerConfig: _native, ...serviceConfig } = config;
  return defineTranscription({ config: serviceConfig, provider: selected, normalize });
}
module.exports = { createTranscriptionService };
