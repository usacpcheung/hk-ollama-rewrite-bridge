const { readWithLegacyFallback, parseFiniteNumber } = require('../../configuration/values');
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

function readConfiguration({ env = process.env, warnLegacyUsage = () => {} } = {}) {
  const serviceId = 'T2A';
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

return { runtime: {
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
        }
}, sources: {
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
      outputFormat: { type: 'default', key: null }
} };
}
module.exports = { readConfiguration };
