const DEFAULT_MAX_TEXT_LENGTH = 200;
const ABSOLUTE_MAX_TEXT_LENGTH = 600;
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

function countUnicodeCharacters(value) {
  return [...value].length;
}

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

function parseResponseMode(value) {
  if (value == null || value === '') {
    return 'binary';
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'binary' || normalized === 'default') {
    return 'binary';
  }

  if (normalized === 'base64_json' || normalized === 'base64-json') {
    return 'base64_json';
  }

  return null;
}

function parseOptionalFiniteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

function parseOptionalBoundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

function parseOptionalEnum(value, allowedValues = []) {
  if (value == null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : null;
}

function resolveT2AConfig({
  env = process.env,
  parseEnvBoundedInteger,
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
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'minimax',
    warnLegacyUsage,
    warningLabel: 'provider'
  });

  const maxTextLengthResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MAX_TEXT_LENGTH`],
    legacyKeys: [],
    parse: (raw, fallback) => parseEnvBoundedInteger(raw, fallback, {
      min: 1,
      max: ABSOLUTE_MAX_TEXT_LENGTH
    }),
    defaultValue: DEFAULT_MAX_TEXT_LENGTH,
    warnLegacyUsage,
    warningLabel: 'maxTextLength'
  });

  const minimaxApiUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_API_URL`, `${serviceId}_PROVIDER_MINIMAX_API_URL`, `${serviceId}_URL`],
    legacyKeys: ['MINIMAX_T2A_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_API_URL,
    warnLegacyUsage,
    warningLabel: 'minimaxApiUrl'
  });

  const minimaxModelResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_MODEL`, `${serviceId}_PROVIDER_MINIMAX_MODEL`, `${serviceId}_MODEL`],
    legacyKeys: ['MINIMAX_T2A_MODEL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_MODEL,
    warnLegacyUsage,
    warningLabel: 'minimaxModel'
  });

  const voiceIdResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_VOICE_ID`, `${serviceId}_PROVIDER_MINIMAX_VOICE_ID`, `${serviceId}_VOICE_ID`],
    legacyKeys: ['MINIMAX_T2A_VOICE_ID'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: DEFAULT_MINIMAX_VOICE_ID,
    warnLegacyUsage,
    warningLabel: 'voiceId'
  });

  const speedResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_SPEED`, `${serviceId}_PROVIDER_MINIMAX_SPEED`, `${serviceId}_SPEED`],
    legacyKeys: ['MINIMAX_T2A_SPEED'],
    parse: (raw, fallback) => parseFiniteNumber(raw, fallback, { min: 0.5, max: 2 }),
    defaultValue: DEFAULT_MINIMAX_SPEED,
    warnLegacyUsage,
    warningLabel: 'speed'
  });

  const volumeResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_VOLUME`, `${serviceId}_PROVIDER_MINIMAX_VOLUME`, `${serviceId}_VOLUME`],
    legacyKeys: ['MINIMAX_T2A_VOLUME'],
    parse: (raw, fallback) => parseFiniteNumber(raw, fallback, { min: 0, max: 10 }),
    defaultValue: DEFAULT_MINIMAX_VOLUME,
    warnLegacyUsage,
    warningLabel: 'volume'
  });

  const pitchResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_PITCH`, `${serviceId}_PROVIDER_MINIMAX_PITCH`, `${serviceId}_PITCH`],
    legacyKeys: ['MINIMAX_T2A_PITCH'],
    parse: (raw, fallback) => parseFiniteNumber(raw, fallback, { min: -12, max: 12 }),
    defaultValue: DEFAULT_MINIMAX_PITCH,
    warnLegacyUsage,
    warningLabel: 'pitch'
  });

  const provider = providerResolution.value === 'minimax' ? 'minimax' : 'minimax';
  const selectedProviderCapabilities = providerCapabilities[provider] || { streaming: false };

  return {
    provider,
    maxTextLength: maxTextLengthResolution.value,
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

function createT2AServiceDefinition({
  parseEnvBoundedInteger,
  providerCapabilities = {}
}) {
  const resolvedConfig = resolveT2AConfig({
    parseEnvBoundedInteger,
    providerCapabilities
  });
  const maxTextLength = resolvedConfig.maxTextLength;
  const providerDefaults = resolvedConfig.providers.minimax.defaults;

  return {
    id: 't2a',
    routes: {
      legacyPath: '/t2a',
      futureApiPath: '/api/t2a'
    },
    provider: {
      selected: resolvedConfig.provider,
      runtime: resolvedConfig.providers[resolvedConfig.provider] || {},
      runtimeByProvider: resolvedConfig.providers,
      sources: resolvedConfig.sources
    },
    capabilities: {
      streaming: false,
      byProvider: {
        minimax: resolvedConfig.providers.minimax.capabilities
      }
    },
    limits: {
      maxTextLength
    },
    validateRequest: ({ body }) => {
      const {
        text,
        stream,
        voice_id: voiceId,
        speed,
        volume,
        pitch,
        response_mode: rawResponseMode,
        sample_rate: sampleRate,
        bitrate,
        format
      } = body || {};

      const streamRequested = stream === true || stream === 'true' || stream === 1 || stream === '1';
      if (streamRequested) {
        return {
          ok: false,
          status: 501,
          code: 'STREAMING_UNSUPPORTED',
          message: 'stream is not supported for t2a v1'
        };
      }

      if (typeof text !== 'string') {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'text is required' };
      }

      const trimmedText = text.trim();
      const inputCharCount = countUnicodeCharacters(trimmedText);
      if (!trimmedText) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'text is required' };
      }

      if (inputCharCount > maxTextLength) {
        return { ok: false, status: 413, code: 'TOO_LONG', message: `Max ${maxTextLength} characters` };
      }

      if (voiceId != null && (typeof voiceId !== 'string' || voiceId.trim() === '')) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'voice_id must be a non-empty string' };
      }

      const parsedSpeed = parseOptionalFiniteNumber(speed, { min: 0.5, max: 2 });
      if (parsedSpeed === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'speed must be a number between 0.5 and 2' };
      }

      const parsedVolume = parseOptionalFiniteNumber(volume, { min: 0, max: 10 });
      if (parsedVolume === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'volume must be a number between 0 and 10' };
      }

      const parsedPitch = parseOptionalFiniteNumber(pitch, { min: -12, max: 12 });
      if (parsedPitch === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'pitch must be a number between -12 and 12' };
      }

      const responseMode = parseResponseMode(rawResponseMode);
      if (!responseMode) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'response_mode must be binary/default or base64_json' };
      }

      const parsedSampleRate = parseOptionalBoundedInteger(sampleRate, { min: 8000, max: 48000 });
      if (parsedSampleRate === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'sample_rate must be an integer between 8000 and 48000' };
      }

      const parsedBitrate = parseOptionalBoundedInteger(bitrate, { min: 32000, max: 320000 });
      if (parsedBitrate === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'bitrate must be an integer between 32000 and 320000' };
      }

      const parsedFormat = parseOptionalEnum(format, ['mp3', 'wav', 'pcm']);
      if (parsedFormat === null) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', message: 'format must be one of mp3, wav, or pcm' };
      }

      return {
        ok: true,
        value: {
          trimmedText,
          inputCharCount,
          streamRequested: false,
          responseMode,
          voice: {
            voiceId: typeof voiceId === 'string' ? voiceId.trim() : providerDefaults.voiceId,
            speed: parsedSpeed === undefined ? providerDefaults.speed : parsedSpeed,
            volume: parsedVolume === undefined ? providerDefaults.volume : parsedVolume,
            pitch: parsedPitch === undefined ? providerDefaults.pitch : parsedPitch
          },
          audio: {
            sampleRate: parsedSampleRate === undefined ? providerDefaults.audioSetting.sampleRate : parsedSampleRate,
            bitrate: parsedBitrate === undefined ? providerDefaults.audioSetting.bitrate : parsedBitrate,
            format: parsedFormat === undefined ? providerDefaults.audioSetting.format : parsedFormat,
            channel: providerDefaults.audioSetting.channel
          },
          languageBoost: providerDefaults.languageBoost,
          voiceModify: {
            ...providerDefaults.voiceModify
          },
          outputFormat: providerDefaults.outputFormat
        }
      };
    }
  };
}

module.exports = {
  createT2AServiceDefinition,
  resolveT2AConfig
};
