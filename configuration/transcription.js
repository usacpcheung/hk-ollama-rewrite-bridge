const { readTranscriptionConfig } = require('../lib/transcription-config');
const { createProvider } = require('../providers');
const { createTranscriptionService: defineTranscription } = require('../services/transcription');

// Keep existing deployment settings at the composition boundary. Step 5 owns
// general provider selection/credential configuration; the workflow is neutral.
function createTranscriptionService({ config = readTranscriptionConfig(), provider, normalize } = {}) {
  if (!config.enabled) return defineTranscription({ config });
  const { project, location, model, language, googleMs, ...serviceConfig } = config;
  const selected = provider || createProvider({ serviceConfig: {
    id: 'transcription', provider: { selected: 'google-speech', runtime: { project, location, model, language } }
  } });
  return defineTranscription({ config: { ...serviceConfig, recognitionMs: googleMs }, provider: selected, normalize });
}
module.exports = { createTranscriptionService };
