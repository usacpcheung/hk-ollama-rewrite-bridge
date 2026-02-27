function createMinimaxProvider({
  apiUrl,
  model,
  apiKey
}) {
  async function checkReadiness({ timeoutMs }) {
    if (!apiKey) {
      return { ready: false, error: 'minimax_api_key_missing' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: 1,
          stream: false
        }),
        signal: controller.signal
      });

      if (response.ok) {
        await response.json();

        return { ready: true, error: null };
      }

      if (response.status === 401 || response.status === 403) {
        return { ready: false, error: 'minimax_auth_failed' };
      }

      return { ready: false, error: `minimax_readiness_http_${response.status}` };
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { ready: false, error: 'minimax_readiness_timeout' };
      }

      return { ready: false, error: 'minimax_readiness_fetch_failed' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function triggerWarmup({ timeoutMs }) {
    return generate({
      prompt: '你好',
      timeoutMs,
      maxTokens: 1
    });
  }

  async function rewrite({ prompt, timeoutMs }) {
    return generate({
      prompt,
      timeoutMs,
      maxTokens: 300
    });
  }

  async function generate({ prompt, timeoutMs, maxTokens }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          max_completion_tokens: maxTokens,
          temperature: 0.2
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        return {
          ok: false,
          error: mapError(new Error('request_failed'), { kind: 'http', status: response.status })
        };
      }

      let data;
      try {
        data = await response.json();
      } catch (_err) {
        return { ok: false, error: mapError(new Error('invalid_json'), { kind: 'invalid_json' }) };
      }

      const responseText =
        data?.reply ||
        data?.choices?.[0]?.message?.content ||
        data?.choices?.[0]?.text ||
        '';

      return { ok: true, data: { response: responseText } };
    } catch (err) {
      return { ok: false, error: mapError(err, { kind: 'fetch' }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  function mapError(err, context = {}) {
    if (context.kind === 'http') {
      if (context.status === 401 || context.status === 403) {
        return {
          code: 'PROVIDER_AUTH_ERROR',
          message: 'Provider authentication failed',
          status: 502,
          detail: `minimax_http_${context.status}`
        };
      }

      return {
        code: 'PROVIDER_ERROR',
        message: 'Provider request failed',
        status: 502,
        detail: `minimax_http_${context.status}`
      };
    }

    if (context.kind === 'invalid_json') {
      return { code: 'PROVIDER_ERROR', message: 'Invalid provider response', status: 502 };
    }

    if (err?.name === 'AbortError') {
      return {
        code: 'MODEL_TIMEOUT',
        message: 'Model response timed out. Please retry.',
        status: 504,
        detail: 'minimax_timeout'
      };
    }

    return {
      code: 'PROVIDER_ERROR',
      message: 'Failed to reach provider',
      status: 502,
      detail: 'minimax_fetch_failed'
    };
  }

  return {
    rewrite,
    checkReadiness,
    triggerWarmup,
    mapError,
    getInfo: () => ({
      provider: 'minimax',
      minimaxApiUrl: apiUrl,
      minimaxModel: model,
      minimaxApiKeySet: Boolean(apiKey)
    })
  };
}

module.exports = { createMinimaxProvider };
