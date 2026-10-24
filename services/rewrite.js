const OpenCC = require('opencc-js');
const { createRewriteStreamConverter } = require('../lib/rewrite-stream-converter');
const toHK = OpenCC.Converter({ from: 'cn', to: 'hk' });
const { createQuotePreservingConverter } = require('../lib/rewrite-quote-converter');
const { resolveRewritePolicy } = require('./rewrite-policies');
function createRewriteServiceDefinition({ config: resolvedConfig }) {
  const maxTextLength = resolvedConfig.maxTextLength;
  const policy = resolveRewritePolicy(resolvedConfig.policy);

  return {
    id: 'rewrite',
    policyId: policy.id,
    instructions: policy.instructions,
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
    buildRequest: ({ trimmedText }) => ({ text: trimmedText, instructions: policy.instructions, outputBudget: resolvedConfig.maxCompletionTokens }),
    createStreamConverter: ({ inputText } = {}) => policy.id === 'hk-school-v1'
      ? createQuotePreservingConverter(inputText) : createRewriteStreamConverter(),
    postProcessOutput: ({ payload, inputText }) => {
      if (!payload || typeof payload !== 'object') {
        return payload;
      }

      const convert = text => policy.id === 'hk-school-v1'
        ? createQuotePreservingConverter(inputText).write(text, true) : toHK(text);
      return {
        ...payload,
        ...(typeof payload.response === 'string' ? { response: convert(payload.response) } : {}),
        ...(typeof payload.result === 'string' ? { result: convert(payload.result) } : {})
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
