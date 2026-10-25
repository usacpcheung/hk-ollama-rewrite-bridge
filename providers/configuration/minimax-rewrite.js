const { resolveMinimaxThinking } = require('./minimax-thinking');
const { readWithLegacyFallback, parseEnumValue } = require('../../configuration/values');
const DEFAULT_MINIMAX_API_FORMAT = 'legacy-chat';
const DEFAULT_MINIMAX_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
const SUPPORTED_MINIMAX_API_FORMATS = new Set(['legacy-chat', 'anthropic']);


function readConfiguration({ env = process.env, warnLegacyUsage = () => {} } = {}) {
  const serviceId = 'REWRITE';
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

  const thinking = resolveMinimaxThinking(env.REWRITE_MINIMAX_THINKING, {
    model: minimaxModelResolution.value, apiFormat: minimaxApiFormatResolution.value
  });

  return { runtime: { thinking, model: minimaxModelResolution.value, apiUrl: minimaxApiUrlResolution.value, apiFormat: minimaxApiFormatResolution.value, anthropicBaseUrl: minimaxAnthropicBaseUrlResolution.value }, sources: { minimaxThinking: env.REWRITE_MINIMAX_THINKING === undefined ? { type: 'default' } : { type: 'env', key: 'REWRITE_MINIMAX_THINKING' }, minimaxModel: minimaxModelResolution.source, minimaxApiUrl: minimaxApiUrlResolution.source, minimaxApiFormat: minimaxApiFormatResolution.source, minimaxAnthropicBaseUrl: minimaxAnthropicBaseUrlResolution.source } };
}
module.exports = { readConfiguration };
