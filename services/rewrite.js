const OpenCC = require('opencc-js');
const { createRewriteStreamConverter } = require('../lib/rewrite-stream-converter');
const toHK = OpenCC.Converter({ from: 'cn', to: 'hk' });
const REWRITE_SYSTEM_PROMPT =
  '你是忠實改寫助手。請將以下香港口語廣東話改寫成正式書面繁體中文（zh-Hant）。\n'
  + '必須逐句保留原意與全部資訊（包括人物、時間、地點、數字、否定、因果、條件、語氣）。\n'
  + '只可改寫語體，不可新增、虛構、延伸、評論、解釋、總結或改變立場。\n'
  + '請移除口語贅詞、語氣助詞與寒暄開場（例如：喂、係、嘅、啦、囉、呀、唉、哦、嗯、咩），但只可移除不影響語義者，不得刪除任何實質內容詞。\n'
  + '若上述詞語出現在引號內容、專有名稱、品牌、口號、歌詞或其他關鍵語義位置，必須保留，不可硬改。\n'
  + '不得把內容寫成故事、對話續寫、創作文本或條列重組。\n'
  + '輸出格式：只輸出改寫後正文，不要標題、前言、註解、解釋、JSON、metadata 或引號。';
function createRewriteServiceDefinition({ config: resolvedConfig }) {
  const maxTextLength = resolvedConfig.maxTextLength;

  return {
    id: 'rewrite',
    instructions: REWRITE_SYSTEM_PROMPT,
    routes: {
      legacyPath: '/rewrite',
      futureApiPath: '/api/rewrite'
    },
    provider: {
      selected: resolvedConfig.provider,
      maxCompletionTokens: resolvedConfig.maxCompletionTokens,
      runtime: resolvedConfig.providers[resolvedConfig.provider] || {},
      runtimeByProvider: resolvedConfig.providers,
      admission: resolvedConfig.admission,
      sources: resolvedConfig.sources
    },
    capabilities: {
      streaming: resolvedConfig.selectedProviderStreamingEnabled === true,
      byProvider: Object.fromEntries(Object.entries(resolvedConfig.providers).map(([id, value]) => [id, value.capabilities]))
    },
    limits: {
      maxTextLength
    },
    timeouts: {
      readyMs: resolvedConfig.timeouts.readyMs,
      coldMs: resolvedConfig.timeouts.coldMs
    },
    buildRequest: ({ trimmedText }) => ({ text: trimmedText, instructions: REWRITE_SYSTEM_PROMPT, outputBudget: resolvedConfig.maxCompletionTokens }),
    createStreamConverter: createRewriteStreamConverter,
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
      const inputCharCount = [...trimmedText].length;

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

module.exports = { createRewriteServiceDefinition };
