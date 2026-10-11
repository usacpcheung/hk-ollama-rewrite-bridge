const DEFAULT_MAX_TEXT_LENGTH = 200;
const ABSOLUTE_MAX_TEXT_LENGTH = 4000;
const DEFAULT_MAX_COMPLETION_TOKENS = 300;
const ABSOLUTE_MAX_COMPLETION_TOKENS = 8192;
const DEFAULT_ADMISSION_MAX_CONCURRENCY = 4;
const DEFAULT_ADMISSION_MAX_QUEUE_SIZE = 100;
const DEFAULT_ADMISSION_MAX_WAIT_MS = 15000;
const { readWithLegacyFallback, parseBooleanFlag } = require('./values');
function resolveRewriteConfig({
  env = process.env,
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {},
  registry = require('../providers').providerRegistry,
  selectedOnly = false
}) {
  const serviceId = 'REWRITE';
  const supportedProviders = [...new Set([...registry.providersFor('rewrite'), ...registry.providersFor('t2a')])];

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
        service: 'rewrite'
      })
    );
  };

  const providerResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_PROVIDER`],
    legacyKeys: [],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'ollama',
    warnLegacyUsage,
    warningLabel: 'provider'
  });

  const maxCompletionTokensResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MAX_COMPLETION_TOKENS`],
    legacyKeys: [],
    parse: (raw, fallback) => {
      const parsed = parseEnvBoundedInteger(raw, fallback, {
        min: 1,
        max: ABSOLUTE_MAX_COMPLETION_TOKENS
      });
      return parsed;
    },
    defaultValue: DEFAULT_MAX_COMPLETION_TOKENS,
    warnLegacyUsage,
    warningLabel: 'maxCompletionTokens'
  });

  const maxTextLengthResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MAX_TEXT_LENGTH`],
    legacyKeys: [],
    parse: (raw, fallback) => {
      const parsed = parseEnvBoundedInteger(raw, fallback, {
        min: 1,
        max: ABSOLUTE_MAX_TEXT_LENGTH
      });
      return parsed;
    },
    defaultValue: DEFAULT_MAX_TEXT_LENGTH,
    warnLegacyUsage,
    warningLabel: 'maxTextLength'
  });

  const readyTimeoutResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_READY_INVOKE_TIMEOUT_MS`],
    // Deprecated env aliases kept for one compatibility window.
    // Prefer REWRITE_READY_INVOKE_TIMEOUT_MS. Remove after production env files have migrated.
    legacyKeys: [`${serviceId}_READY_TIMEOUT_MS`, 'OLLAMA_TIMEOUT_MS'],
    parse: (raw, fallback) => parseEnvMilliseconds(raw, fallback, { max: 300_000 }),
    defaultValue: 30_000,
    warnLegacyUsage,
    warningLabel: 'readyTimeoutMs'
  });

  const coldTimeoutResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_COLD_INVOKE_TIMEOUT_MS`],
    // Deprecated env aliases kept for one compatibility window.
    // Prefer REWRITE_COLD_INVOKE_TIMEOUT_MS. Remove after production env files have migrated.
    legacyKeys: [`${serviceId}_COLD_TIMEOUT_MS`, 'OLLAMA_COLD_TIMEOUT_MS'],
    parse: (raw, fallback) => parseEnvMilliseconds(raw, fallback, { max: 600_000 }),
    defaultValue: 120_000,
    warnLegacyUsage,
    warningLabel: 'coldTimeoutMs'
  });


  const provider = providerResolution.value;
  const resolvedProviders = {};
  const providerSources = {};
  for (const name of selectedOnly ? [provider] : registry.providersFor('rewrite')) {
    if (!registry.supports(name, 'rewrite')) continue;
    const configured = registry.readConfiguration(name, 'rewrite', { env, warnLegacyUsage });
    resolvedProviders[name] = { ...configured.runtime, capabilities: providerCapabilities[name] || { streaming: false } };
    Object.assign(providerSources, configured.sources);
  }


  const admissionGlobalLimits = {
    maxConcurrency: parseEnvBoundedInteger(
      env.ADMISSION_MAX_CONCURRENCY,
      DEFAULT_ADMISSION_MAX_CONCURRENCY,
      { min: 1, max: 1000 },
      'ADMISSION_MAX_CONCURRENCY'
    ),
    maxQueueSize: parseEnvBoundedInteger(
      env.ADMISSION_MAX_QUEUE_SIZE,
      DEFAULT_ADMISSION_MAX_QUEUE_SIZE,
      { min: 0, max: 10000 },
      'ADMISSION_MAX_QUEUE_SIZE'
    ),
    maxWaitMs: parseEnvMilliseconds(
      env.ADMISSION_MAX_WAIT_MS,
      DEFAULT_ADMISSION_MAX_WAIT_MS,
      { max: 600_000 },
      'ADMISSION_MAX_WAIT_MS'
    )
  };

  const admissionByProvider = supportedProviders.reduce((acc, providerName) => {
    const providerEnvPrefix = providerName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const maxConcurrency = parseEnvBoundedInteger(
      env[`${providerEnvPrefix}_MAX_CONCURRENCY`],
      null,
      { min: 1, max: 1000 },
      `${providerEnvPrefix}_MAX_CONCURRENCY`
    );
    const maxQueueSize = parseEnvBoundedInteger(
      env[`${providerEnvPrefix}_MAX_QUEUE_SIZE`],
      null,
      { min: 0, max: 10000 },
      `${providerEnvPrefix}_MAX_QUEUE_SIZE`
    );
    const maxWaitMs = parseEnvMilliseconds(
      env[`${providerEnvPrefix}_MAX_WAIT_MS`],
      null,
      { max: 600_000 },
      `${providerEnvPrefix}_MAX_WAIT_MS`
    );

    acc[providerName] = {
      ...(maxConcurrency != null ? { maxConcurrency } : {}),
      ...(maxQueueSize != null ? { maxQueueSize } : {}),
      ...(maxWaitMs != null ? { maxWaitMs } : {})
    };

    return acc;
  }, {});

  const selectedProviderCapabilities = providerCapabilities[provider] || { streaming: false };
  const providerStreamingEnvResolution = readWithLegacyFallback({
    env,
    preferredKeys: [
      `${serviceId}_STREAMING_ENABLED`,
      `${serviceId}_PROVIDER_STREAMING_ENABLED`,
      `${serviceId}_${String(provider).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_STREAMING_ENABLED`
    ],
    legacyKeys: [],
    parse: parseBooleanFlag,
    defaultValue: false,
    warnLegacyUsage,
    warningLabel: 'streamingEnabled'
  });
  const providerSupportsStreaming = selectedProviderCapabilities.streaming === true;
  const selectedProviderStreamingEnabled =
    providerSupportsStreaming && providerStreamingEnvResolution.value === true;

  return {
    provider,
    maxCompletionTokens: maxCompletionTokensResolution.value,
    maxTextLength: maxTextLengthResolution.value,
    timeouts: {
      readyMs: readyTimeoutResolution.value,
      coldMs: coldTimeoutResolution.value
    },
    admission: {
      global: admissionGlobalLimits,
      byProvider: admissionByProvider
    },
    providers: resolvedProviders,
    selectedProviderCapabilities,
    selectedProviderStreamingEnabled,
    sources: {
      provider: providerResolution.source,
      maxCompletionTokens: maxCompletionTokensResolution.source,
      maxTextLength: maxTextLengthResolution.source,
      readyTimeoutMs: readyTimeoutResolution.source,
      coldTimeoutMs: coldTimeoutResolution.source,
      ...providerSources,
      streamingEnabled: providerStreamingEnvResolution.source
    }
  };
}

module.exports = { resolveRewriteConfig };
