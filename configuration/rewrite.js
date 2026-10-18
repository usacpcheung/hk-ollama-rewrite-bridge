const DEFAULT_MAX_TEXT_LENGTH = 200;
const ABSOLUTE_MAX_TEXT_LENGTH = 4000;
const DEFAULT_MAX_COMPLETION_TOKENS = 300;
const ABSOLUTE_MAX_COMPLETION_TOKENS = 8192;
const DEFAULT_ADMISSION_MAX_CONCURRENCY = 4;
const DEFAULT_ADMISSION_MAX_QUEUE_SIZE = 100;
const DEFAULT_ADMISSION_MAX_WAIT_MS = 15000;
const DEFAULT_MINIMAX_API_FORMAT = 'legacy-chat';
const DEFAULT_MINIMAX_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
const SUPPORTED_MINIMAX_API_FORMATS = new Set(['legacy-chat', 'anthropic']);

function readPreferredEnv(env, keys = []) {
  for (const key of keys) {
    const raw = env[key];
    if (raw != null && raw.trim() !== '') {
      return { key, value: raw };
    }
  }
  return null;
}

function parseBooleanFlag(raw, fallback) {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return fallback;
}

function parseEnumValue(raw, fallback, supportedValues) {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  return supportedValues.has(normalized) ? normalized : fallback;
}

function readWithLegacyFallback({
  env,
  preferredKeys,
  legacyKeys,
  parse,
  defaultValue,
  warnLegacyUsage,
  warningLabel
}) {
  const parseWithValidity = (raw) => {
    const invalidMarker = Symbol('invalid-env-value');
    const parsed = parse(raw, invalidMarker);

    return {
      isValid: parsed !== invalidMarker,
      value: parsed
    };
  };

  const preferred = readPreferredEnv(env, preferredKeys);
  if (preferred) {
    const preferredParsed = parseWithValidity(preferred.value);
    if (preferredParsed.isValid) {
      return {
        value: preferredParsed.value,
        source: { type: 'preferred', key: preferred.key }
      };
    }
  }

  const legacy = readPreferredEnv(env, legacyKeys);
  if (legacy) {
    const legacyParsed = parseWithValidity(legacy.value);
    if (legacyParsed.isValid) {
      warnLegacyUsage({
        legacyKey: legacy.key,
        preferredKeys,
        warningLabel
      });
      return {
        value: legacyParsed.value,
        source: { type: 'legacy', key: legacy.key }
      };
    }
  }

  return {
    value: defaultValue,
    source: { type: 'default', key: null }
  };
}

function resolveRewriteConfig({
  env = process.env,
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {}
}) {
  const serviceId = 'REWRITE';
  const supportedProviders = ['ollama', 'minimax'];

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

  const minimaxModelResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_MODEL`, `${serviceId}_PROVIDER_MINIMAX_MODEL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer REWRITE_MINIMAX_MODEL. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_MODEL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'M2-her',
    warnLegacyUsage,
    warningLabel: 'minimaxModel'
  });

  const minimaxApiUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_API_URL`, `${serviceId}_PROVIDER_MINIMAX_API_URL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer REWRITE_MINIMAX_API_URL. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_API_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'https://api.minimax.io/v1/text/chatcompletion_v2',
    warnLegacyUsage,
    warningLabel: 'minimaxApiUrl'
  });

  const minimaxApiFormatResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_API_FORMAT`, `${serviceId}_PROVIDER_MINIMAX_API_FORMAT`],
    legacyKeys: [],
    parse: (raw, fallback) => parseEnumValue(raw, fallback, SUPPORTED_MINIMAX_API_FORMATS),
    defaultValue: DEFAULT_MINIMAX_API_FORMAT,
    warnLegacyUsage,
    warningLabel: 'minimaxApiFormat'
  });

  const minimaxAnthropicBaseUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [
      `${serviceId}_MINIMAX_ANTHROPIC_BASE_URL`,
      `${serviceId}_PROVIDER_MINIMAX_ANTHROPIC_BASE_URL`
    ],
    legacyKeys: [],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_ANTHROPIC_BASE_URL,
    warnLegacyUsage,
    warningLabel: 'minimaxAnthropicBaseUrl'
  });

  const provider = providerResolution.value;

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
    const providerEnvPrefix = providerName.toUpperCase();
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
      `${serviceId}_${String(provider).toUpperCase()}_STREAMING_ENABLED`
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
    providers: {
      ollama: {
        model: ollamaModelResolution.value,
        generateUrl: ollamaUrlResolution.value,
        psUrl: ollamaPsUrlResolution.value,
        capabilities: providerCapabilities.ollama || { streaming: false }
      },
      minimax: {
        model: minimaxModelResolution.value,
        apiUrl: minimaxApiUrlResolution.value,
        apiFormat: minimaxApiFormatResolution.value,
        anthropicBaseUrl: minimaxAnthropicBaseUrlResolution.value,
        capabilities: providerCapabilities.minimax || { streaming: false }
      }
    },
    selectedProviderCapabilities,
    selectedProviderStreamingEnabled,
    sources: {
      provider: providerResolution.source,
      maxCompletionTokens: maxCompletionTokensResolution.source,
      maxTextLength: maxTextLengthResolution.source,
      readyTimeoutMs: readyTimeoutResolution.source,
      coldTimeoutMs: coldTimeoutResolution.source,
      ollamaModel: ollamaModelResolution.source,
      ollamaUrl: ollamaUrlResolution.source,
      ollamaPsUrl: ollamaPsUrlResolution.source,
      minimaxModel: minimaxModelResolution.source,
      minimaxApiUrl: minimaxApiUrlResolution.source,
      minimaxApiFormat: minimaxApiFormatResolution.source,
      minimaxAnthropicBaseUrl: minimaxAnthropicBaseUrlResolution.source,
      streamingEnabled: providerStreamingEnvResolution.source
    }
  };
}

module.exports = { resolveRewriteConfig };
