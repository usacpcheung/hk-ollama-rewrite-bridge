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

function createRewriteServiceDefinition({
  parseEnvBoundedInteger,
  provider,
  readyTimeoutMs,
  coldTimeoutMs
}) {
  const maxTextLength = parseEnvBoundedInteger('REWRITE_MAX_TEXT_LENGTH', DEFAULT_MAX_TEXT_LENGTH, {
    min: 1,
    max: ABSOLUTE_MAX_TEXT_LENGTH
  });

  const maxCompletionTokens = parseEnvBoundedInteger(
    'REWRITE_MAX_COMPLETION_TOKENS',
    DEFAULT_MAX_COMPLETION_TOKENS,
    {
      min: 1,
      max: ABSOLUTE_MAX_COMPLETION_TOKENS
    }
  );

  return {
    id: 'rewrite',
    routes: {
      legacyPath: '/rewrite',
      futureApiPath: '/api/rewrite'
    },
    provider: {
      selected: provider,
      maxCompletionTokens
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
      readyMs: readyTimeoutMs,
      coldMs: coldTimeoutMs
    },
    buildPrompt: ({ text, isMinimax }) => {
      if (isMinimax) {
        return buildRewritePrompt(MINIMAX_SYSTEM_PROMPT, MINIMAX_USER_TEMPLATE, text);
      }

      return buildRewritePrompt(REWRITE_SYSTEM_PROMPT, REWRITE_USER_TEMPLATE, text);
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
  createRewriteServiceDefinition
};
