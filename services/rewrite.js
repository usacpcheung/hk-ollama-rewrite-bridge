const DEFAULT_MAX_TEXT_LENGTH = 200;
const ABSOLUTE_MAX_TEXT_LENGTH = 600;
const DEFAULT_MAX_COMPLETION_TOKENS = 300;
const ABSOLUTE_MAX_COMPLETION_TOKENS = 8192;

const REWRITE_SYSTEM_PROMPT =
  '你是忠實改寫助手。請將以下香港口語廣東話改寫成正式書面繁體中文（zh-Hant）。\n'
  + '必須逐句保留原意與全部資訊（包括人物、時間、地點、數字、否定、因果、條件、語氣）。\n'
  + '只可改寫語體，不可新增、虛構、延伸、評論、解釋、總結或改變立場。\n'
  + '請移除口語贅詞、語氣助詞與寒暄開場（例如：喂、係、嘅、啦、囉、呀、唉、哦、嗯、咩），但只可移除不影響語義者，不得刪除任何實質內容詞。\n'
  + '若上述詞語出現在引號內容、專有名稱、品牌、口號、歌詞或其他關鍵語義位置，必須保留，不可硬改。\n'
  + '不得把內容寫成故事、對話續寫、創作文本或條列重組。\n'
  + '輸出格式：只輸出改寫後正文，不要標題、前言、註解、解釋、JSON、metadata 或引號。';
const REWRITE_USER_TEMPLATE = '原文：{TEXT}';
const MINIMAX_SYSTEM_PROMPT = REWRITE_SYSTEM_PROMPT;
const MINIMAX_DEFAULT_USER_TEMPLATE = '把下方文字改寫為繁體書面語：\n{TEXT}';
const MINIMAX_USER_TEMPLATE = MINIMAX_DEFAULT_USER_TEMPLATE;
const OpenCC = require('opencc-js');

const toHK = OpenCC.Converter({ from: 'cn', to: 'hk' });

function renderUserContent(userTemplate, text) {
  if (typeof userTemplate !== 'string' || userTemplate.length === 0) {
    return text;
  }

  if (userTemplate.includes('{TEXT}')) {
    return userTemplate.replace('{TEXT}', text);
  }

  return `${userTemplate}${text}`;
}

function buildRewritePrompt(systemPrompt, userTemplate, text) {
  const userContent = renderUserContent(userTemplate, text);
  const prompt = [systemPrompt, userContent]
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .join('\n\n');

  return {
    prompt,
    systemPrompt,
    userContent
  };
}

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
    legacyKeys: ['REWRITE_PROVIDER'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'ollama',
    warnLegacyUsage,
    warningLabel: 'provider'
  });

  const maxCompletionTokensResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MAX_COMPLETION_TOKENS`],
    legacyKeys: ['REWRITE_MAX_COMPLETION_TOKENS'],
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
    legacyKeys: ['REWRITE_MAX_TEXT_LENGTH'],
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
    preferredKeys: [`${serviceId}_READY_TIMEOUT_MS`],
    legacyKeys: ['OLLAMA_TIMEOUT_MS'],
    parse: (raw, fallback) => parseEnvMilliseconds(raw, fallback, { max: 300_000 }),
    defaultValue: 30_000,
    warnLegacyUsage,
    warningLabel: 'readyTimeoutMs'
  });

  const coldTimeoutResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_COLD_TIMEOUT_MS`],
    legacyKeys: ['OLLAMA_COLD_TIMEOUT_MS'],
    parse: (raw, fallback) => parseEnvMilliseconds(raw, fallback, { max: 600_000 }),
    defaultValue: 120_000,
    warnLegacyUsage,
    warningLabel: 'coldTimeoutMs'
  });


  const ollamaUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_OLLAMA_URL`, `${serviceId}_PROVIDER_OLLAMA_URL`],
    legacyKeys: ['OLLAMA_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'http://127.0.0.1:11434/api/generate',
    warnLegacyUsage,
    warningLabel: 'ollamaUrl'
  });

  const ollamaPsUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_OLLAMA_PS_URL`, `${serviceId}_PROVIDER_OLLAMA_PS_URL`],
    legacyKeys: ['OLLAMA_PS_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'http://127.0.0.1:11434/api/ps',
    warnLegacyUsage,
    warningLabel: 'ollamaPsUrl'
  });

  const ollamaModelResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_OLLAMA_MODEL`, `${serviceId}_PROVIDER_OLLAMA_MODEL`],
    legacyKeys: ['OLLAMA_MODEL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'qwen2.5:3b-instruct',
    warnLegacyUsage,
    warningLabel: 'ollamaModel'
  });

  const minimaxModelResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_MODEL`, `${serviceId}_PROVIDER_MINIMAX_MODEL`],
    legacyKeys: ['MINIMAX_MODEL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'M2-her',
    warnLegacyUsage,
    warningLabel: 'minimaxModel'
  });

  const minimaxApiUrlResolution = readWithLegacyFallback({
    env,
    preferredKeys: [`${serviceId}_MINIMAX_API_URL`, `${serviceId}_PROVIDER_MINIMAX_API_URL`],
    legacyKeys: ['MINIMAX_API_URL'],
    parse: (raw, fallback) => raw || fallback,
    defaultValue: 'https://api.minimax.io/v1/text/chatcompletion_v2',
    warnLegacyUsage,
    warningLabel: 'minimaxApiUrl'
  });

  const provider = providerResolution.value;
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
      streamingEnabled: providerStreamingEnvResolution.source
    }
  };
}

function createRewriteServiceDefinition({
  parseEnvBoundedInteger,
  parseEnvMilliseconds,
  providerCapabilities = {}
}) {
  const resolvedConfig = resolveRewriteConfig({
    parseEnvBoundedInteger,
    parseEnvMilliseconds,
    providerCapabilities
  });
  const maxTextLength = resolvedConfig.maxTextLength;

  return {
    id: 'rewrite',
    routes: {
      legacyPath: '/rewrite',
      futureApiPath: '/api/rewrite'
    },
    provider: {
      selected: resolvedConfig.provider,
      maxCompletionTokens: resolvedConfig.maxCompletionTokens,
      runtime: resolvedConfig.providers[resolvedConfig.provider] || {},
      runtimeByProvider: resolvedConfig.providers,
      sources: resolvedConfig.sources
    },
    capabilities: {
      streaming: resolvedConfig.selectedProviderStreamingEnabled === true,
      byProvider: {
        ollama: resolvedConfig.providers.ollama.capabilities,
        minimax: resolvedConfig.providers.minimax.capabilities
      }
    },
    prompts: {
      rewriteSystemPrompt: REWRITE_SYSTEM_PROMPT,
      rewriteUserTemplate: REWRITE_USER_TEMPLATE,
      minimaxSystemPrompt: MINIMAX_SYSTEM_PROMPT,
      minimaxUserTemplate: MINIMAX_USER_TEMPLATE
    },
    limits: {
      maxTextLength
    },
    timeouts: {
      readyMs: resolvedConfig.timeouts.readyMs,
      coldMs: resolvedConfig.timeouts.coldMs
    },
    buildPrompt: ({ text, isMinimax }) => {
      if (isMinimax) {
        return buildRewritePrompt(MINIMAX_SYSTEM_PROMPT, MINIMAX_USER_TEMPLATE, text);
      }

      return buildRewritePrompt(REWRITE_SYSTEM_PROMPT, REWRITE_USER_TEMPLATE, text);
    },
    postProcessOutput: ({ payload }) => {
      if (!payload || typeof payload !== 'object') {
        return payload;
      }

      return {
        ...payload,
        ...(typeof payload.response === 'string' ? { response: toHK(payload.response) } : {}),
        ...(typeof payload.result === 'string' ? { result: toHK(payload.result) } : {})
      };
    },
    validateRequest: ({ body }) => {
      const { text, stream } = body || {};
      const streamRequested = stream === true || stream === 'true' || stream === 1 || stream === '1';

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

      return {
        ok: true,
        value: {
          trimmedText,
          streamRequested,
          inputCharCount
        }
      };
    }
  };
}

module.exports = {
  createRewriteServiceDefinition,
  resolveRewriteConfig
};
