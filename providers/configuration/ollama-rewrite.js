const { readWithLegacyFallback } = require('../../configuration/values');

function readConfiguration({ env = process.env, warnLegacyUsage = () => {} } = {}) {
  const serviceId = 'REWRITE';
  const ollamaUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_OLLAMA_URL`, `${serviceId}_PROVIDER_OLLAMA_URL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer REWRITE_OLLAMA_URL. Remove after production env files have migrated.
    legacyKeys: ['OLLAMA_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'http://127.0.0.1:11434/api/generate',
    warnLegacyUsage,
    warningLabel: 'ollamaUrl'
  });

  const ollamaPsUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_OLLAMA_PS_URL`, `${serviceId}_PROVIDER_OLLAMA_PS_URL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer REWRITE_OLLAMA_PS_URL. Remove after production env files have migrated.
    legacyKeys: ['OLLAMA_PS_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'http://127.0.0.1:11434/api/ps',
    warnLegacyUsage,
    warningLabel: 'ollamaPsUrl'
  });

  const ollamaModelResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_OLLAMA_MODEL`, `${serviceId}_PROVIDER_OLLAMA_MODEL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer REWRITE_OLLAMA_MODEL. Remove after production env files have migrated.
    legacyKeys: ['OLLAMA_MODEL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'qwen2.5:3b-instruct',
    warnLegacyUsage,
    warningLabel: 'ollamaModel'
  });

  return { runtime: { model: ollamaModelResolution.value, generateUrl: ollamaUrlResolution.value, psUrl: ollamaPsUrlResolution.value, keepAlive: env.OLLAMA_KEEP_ALIVE || '30m' }, sources: { ollamaModel: ollamaModelResolution.source, ollamaUrl: ollamaUrlResolution.source, ollamaPsUrl: ollamaPsUrlResolution.source } };
}
module.exports = { readConfiguration };
