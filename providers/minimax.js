function createMiniMaxProvider({ endpoint, model, apiKey, timeoutMs = 30_000 }) {
  function normalizeContent(content) {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part === 'object' && typeof part.text === 'string') {
            return part.text;
          }
          return '';
        })
        .join('')
        .trim();
    }

    return '';
  }

  function mapError(err, context = {}) {
    if (context.kind === 'http') {
      if (context.status === 401 || context.status === 403) {
        return {
          code: 'MODEL_AUTH_ERROR',
          message: 'Model authentication failed',
          status: 502,
          detail: `provider_http_${context.status}`
        };
      }

      if (context.status === 429) {
        return {
          code: 'MODEL_RATE_LIMIT',
          message: 'Model provider rate limit reached',
          status: 503,
          detail: 'provider_http_429'
        };
      }

      if (context.status >= 400 && context.status < 500) {
        return {
          code: 'MODEL_BAD_REQUEST',
          message: 'Model request was rejected by provider',
          status: 502,
          detail: `provider_http_${context.status}`
        };
      }

      return {
        code: 'MODEL_PROVIDER_ERROR',
        message: 'Model provider request failed',
        status: 502,
        detail: `provider_http_${context.status}`
      };
    }

    if (context.kind === 'invalid_json') {
      return { code: 'MODEL_PROVIDER_ERROR', message: 'Invalid model response', status: 502 };
    }

    if (err?.name === 'AbortError') {
      return {
        code: 'MODEL_TIMEOUT',
        message: 'Model response timed out. Please retry.',
        status: 504,
        detail: 'provider_timeout'
      };
    }

    return {
      code: 'MODEL_PROVIDER_ERROR',
      message: 'Failed to reach model provider',
      status: 502,
      detail: 'provider_fetch_failed'
    };
  }

  async function checkReadiness() {
    return { ready: true, error: null };
  }

  async function triggerWarmup({ timeoutMs: warmupTimeoutMs }) {
    return rewrite({ prompt: 'hi', timeoutMs: warmupTimeoutMs });
  }

  async function rewrite({ prompt, timeoutMs: overrideTimeoutMs }) {
    const controller = new AbortController();
    const requestTimeoutMs = overrideTimeoutMs || timeoutMs;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        return { ok: false, error: mapError(new Error('request_failed'), { kind: 'http', status: response.status }) };
      }

      let payload;
      try {
        payload = await response.json();
      } catch (_err) {
        return { ok: false, error: mapError(new Error('invalid_json'), { kind: 'invalid_json' }) };
      }

      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      const text = (
        normalizeContent(choice?.message?.content) ||
        normalizeContent(choice?.delta?.content) ||
        normalizeContent(payload.reply) ||
        normalizeContent(payload.output_text) ||
        normalizeContent(payload.text)
      ).trim();

      return {
        ok: true,
        data: {
          text,
          meta: {
            provider: 'minimax',
            model,
            id: payload.id || null,
            usage: payload.usage || null,
            finishReason: choice?.finish_reason || null
          }
        }
      };
    } catch (err) {
      return { ok: false, error: mapError(err, { kind: 'fetch' }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    rewrite,
    checkReadiness,
    triggerWarmup,
    mapError,
    getInfo: () => ({
      provider: 'minimax',
      minimaxEndpoint: endpoint,
      minimaxModel: model,
      minimaxTimeoutMs: timeoutMs
    })
  };
}

module.exports = { createMiniMaxProvider };
