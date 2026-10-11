const DEFAULT_MAX_TEXT_LENGTH = 200;
const ABSOLUTE_MAX_TEXT_LENGTH = 1000;
const { readWithLegacyFallback } = require('./values');
function resolveT2AConfig({
  env = process.env,
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {},
  registry = require('../providers').providerRegistry,
  selectedOnly = false
}) {
  const serviceId = 'T2A';

  const warnLegacyUsage = ({ legacyKey, preferredKeys, warningLabel }) => {
    if (!preferredKeys.length) {
      return;
    }

    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: `${warningLabel} uses legacy env key`,
        legacyKey,
        preferredKeys,
        service: 't2a'
      })
    );
  };

  const providerResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_PROVIDER`],
    legacyKeys: [],
    parse: (raw, fallback) => String(raw || '').trim().toLowerCase() || fallback,
    defaultValue: 'minimax',
    warnLegacyUsage,
    warningLabel: 'provider'
  });

  const maxTextLengthResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MAX_TEXT_LENGTH`],
    legacyKeys: [],
    parse: (raw, fallback) => {
      const value = Number(raw);
      if (Number.isInteger(value) && value > ABSOLUTE_MAX_TEXT_LENGTH) {
        return ABSOLUTE_MAX_TEXT_LENGTH;
      }
      return parseEnvBoundedInteger(raw, fallback, {
        min: 1,
        max: ABSOLUTE_MAX_TEXT_LENGTH
      });
    },
    defaultValue: DEFAULT_MAX_TEXT_LENGTH,
    warnLegacyUsage,
    warningLabel: 'maxTextLength'
  });

  const invokeTimeoutResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_INVOKE_TIMEOUT_MS`],
    legacyKeys: [],
    parse: (raw, fallback) => parseEnvMilliseconds(raw, fallback, {
      min: 1_000,
      max: 300_000
    }),
    defaultValue: 30_000,
    warnLegacyUsage,
    warningLabel: 'invokeTimeoutMs'
  });

  const provider = providerResolution.value;
  const resolvedProviders = {};
  const providerSources = {};
  for (const name of selectedOnly ? [provider] : registry.providersFor('t2a')) {
    if (!registry.supports(name, 't2a')) continue;
    const configured = registry.readConfiguration(name, 't2a', { env, warnLegacyUsage });
    resolvedProviders[name] = { ...configured.runtime, capabilities: providerCapabilities[name] || { streaming: false } };
    Object.assign(providerSources, configured.sources);
  }

  const providerSupported = registry.supports(provider, 't2a');
  const selectedProviderCapabilities = providerCapabilities[provider] || { streaming: false };

  return {
    provider,
    providerSupported,
    maxTextLength: maxTextLengthResolution.value,
    timeouts: {
      invokeMs: invokeTimeoutResolution.value
    },
    providers: resolvedProviders,
    selectedProviderCapabilities,
    selectedProviderStreamingEnabled: false,
    sources: {
      provider: providerResolution.source,
      maxTextLength: maxTextLengthResolution.source,
      invokeTimeoutMs: invokeTimeoutResolution.source,
      ...providerSources,
      streamingEnabled: { type: 'default', key: null }
    }
  };
}

module.exports = { resolveT2AConfig };
