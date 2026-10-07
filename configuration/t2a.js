const DEFAULT_MAX_TEXT_LENGTH = 200;
const ABSOLUTE_MAX_TEXT_LENGTH = 1000;
const DEFAULT_AUDIO_SAMPLE_RATE = 32000;
const DEFAULT_AUDIO_BITRATE = 128000;
const DEFAULT_AUDIO_FORMAT = 'mp3';
const DEFAULT_MINIMAX_API_URL = 'https://api.minimax.io/v1/t2a_v2';
const DEFAULT_MINIMAX_MODEL = 'speech-2.6-hd';
const DEFAULT_MINIMAX_VOICE_ID = 'Cantonese_ProfessionalHost（F)';
const DEFAULT_MINIMAX_SPEED = 1;
const DEFAULT_MINIMAX_VOLUME = 1;
const DEFAULT_MINIMAX_PITCH = 0;
const DEFAULT_AUDIO_CHANNEL = 1;
const DEFAULT_LANGUAGE_BOOST = 'Chinese,Yue';
const DEFAULT_VOICE_MODIFY = Object.freeze({
  pitch: 0,
  intensity: 0,
  timbre: 0
});
const DEFAULT_OUTPUT_FORMAT = 'hex';
const SUPPORTED_T2A_PROVIDERS = new Set(['minimax']);

function readPreferredEnv(env, keys = []) {
  for (const key of keys) {
    const raw = env[key];
    if (raw != null && raw.trim() !== '') {
      return { key, value: raw };
    }
  }
  return null;
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

function parseFiniteNumber(raw, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function resolveT2AConfig({
  env = process.env,
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {}
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

  const minimaxApiUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_API_URL`, `${serviceId}_PROVIDER_MINIMAX_API_URL`, `${serviceId}_URL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer T2A_MINIMAX_API_URL. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_T2A_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_API_URL,
    warnLegacyUsage,
    warningLabel: 'minimaxApiUrl'
  });

  const minimaxModelResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_MODEL`, `${serviceId}_PROVIDER_MINIMAX_MODEL`, `${serviceId}_MODEL`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer T2A_MINIMAX_MODEL. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_T2A_MODEL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_MODEL,
    warnLegacyUsage,
    warningLabel: 'minimaxModel'
  });

  const voiceIdResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_VOICE_ID`, `${serviceId}_PROVIDER_MINIMAX_VOICE_ID`, `${serviceId}_VOICE_ID`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer T2A_MINIMAX_VOICE_ID. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_T2A_VOICE_ID'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_VOICE_ID,
    warnLegacyUsage,
    warningLabel: 'voiceId'
  });

  const speedResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_SPEED`, `${serviceId}_PROVIDER_MINIMAX_SPEED`, `${serviceId}_SPEED`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer T2A_MINIMAX_SPEED. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_T2A_SPEED'],
    parse: (raw, fallback) => parseFiniteNumber(raw, fallback, { min: 0.5, max: 2 }),
    defaultValue: DEFAULT_MINIMAX_SPEED,
    warnLegacyUsage,
    warningLabel: 'speed'
  });

  const volumeResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_VOLUME`, `${serviceId}_PROVIDER_MINIMAX_VOLUME`, `${serviceId}_VOLUME`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer T2A_MINIMAX_VOLUME. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_T2A_VOLUME'],
    parse: (raw, fallback) => parseFiniteNumber(raw, fallback, { min: 0, max: 10 }),
    defaultValue: DEFAULT_MINIMAX_VOLUME,
    warnLegacyUsage,
    warningLabel: 'volume'
  });

  const pitchResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_PITCH`, `${serviceId}_PROVIDER_MINIMAX_PITCH`, `${serviceId}_PITCH`],
    // Deprecated env alias kept for one compatibility window.
    // Prefer T2A_MINIMAX_PITCH. Remove after production env files have migrated.
    legacyKeys: ['MINIMAX_T2A_PITCH'],
    parse: (raw, fallback) => parseFiniteNumber(raw, fallback, { min: -12, max: 12 }),
    defaultValue: DEFAULT_MINIMAX_PITCH,
    warnLegacyUsage,
    warningLabel: 'pitch'
  });

  const provider = providerResolution.value;
  const providerSupported = SUPPORTED_T2A_PROVIDERS.has(provider);
  const selectedProviderCapabilities = providerCapabilities[provider] || { streaming: false };

  return {
    provider,
    providerSupported,
    maxTextLength: maxTextLengthResolution.value,
    timeouts: {
      invokeMs: invokeTimeoutResolution.value
    },
    providers: {
      minimax: {
        apiUrl: minimaxApiUrlResolution.value,
        model: minimaxModelResolution.value,
        defaults: {
          voiceId: voiceIdResolution.value,
          speed: speedResolution.value,
          volume: volumeResolution.value,
          pitch: pitchResolution.value,
          audioSetting: {
            sampleRate: DEFAULT_AUDIO_SAMPLE_RATE,
            bitrate: DEFAULT_AUDIO_BITRATE,
            format: DEFAULT_AUDIO_FORMAT,
            channel: DEFAULT_AUDIO_CHANNEL
          },
          languageBoost: DEFAULT_LANGUAGE_BOOST,
          voiceModify: {
            ...DEFAULT_VOICE_MODIFY
          },
          outputFormat: DEFAULT_OUTPUT_FORMAT
        },
        capabilities: providerCapabilities.minimax || { streaming: false }
      }
    },
    selectedProviderCapabilities,
    selectedProviderStreamingEnabled: false,
    sources: {
      provider: providerResolution.source,
      maxTextLength: maxTextLengthResolution.source,
      invokeTimeoutMs: invokeTimeoutResolution.source,
      minimaxApiUrl: minimaxApiUrlResolution.source,
      minimaxModel: minimaxModelResolution.source,
      voiceId: voiceIdResolution.source,
      speed: speedResolution.source,
      volume: volumeResolution.source,
      pitch: pitchResolution.source,
      audioSampleRate: { type: 'default', key: null },
      audioBitrate: { type: 'default', key: null },
      audioFormat: { type: 'default', key: null },
      audioChannel: { type: 'default', key: null },
      languageBoost: { type: 'default', key: null },
      voiceModify: { type: 'default', key: null },
      outputFormat: { type: 'default', key: null },
      streamingEnabled: { type: 'default', key: null }
    }
  };
}

module.exports = { resolveT2AConfig };
