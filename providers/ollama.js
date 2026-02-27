function createOllamaProvider({
  generateUrl,
  psUrl,
  model,
  keepAlive
}) {
  async function checkReadiness({ timeoutMs }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(psUrl, { signal: controller.signal });
      if (!response.ok) {
        return { ready: null, error: `ps_http_${response.status}` };
      }

      let psJson;
      try {
        psJson = await response.json();
      } catch (_err) {
        return { ready: null, error: 'ps_invalid_json' };
      }

      const models = Array.isArray(psJson.models) ? psJson.models : [];
      const ready = models.some((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        return entry.name === model || entry.model === model;
      });

      return { ready, error: null };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { ready: null, error: 'ps_timeout' };
      }
      return { ready: null, error: 'ps_fetch_failed' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function triggerWarmup({ timeoutMs }) {
    return generate({
      prompt: 'hi',
      timeoutMs,
      options: {
        temperature: 0,
        num_predict: 1
      }
    });
  }

  async function rewrite({ prompt, timeoutMs }) {
    return generate({
      prompt,
      timeoutMs,
      options: {
        temperature: 0.2,
        num_predict: 300
      }
    });
  }

  async function generate({ prompt, timeoutMs, options }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          keep_alive: keepAlive,
          options
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

      return {
        ok: true,
        data: {
          text: typeof data.response === 'string' ? data.response : '',
          meta: {
            provider: 'ollama',
            model: data.model || model,
            totalDuration: data.total_duration || null,
            evalCount: data.eval_count || null
          }
        }
      };
    } catch (err) {
      return { ok: false, error: mapError(err, { kind: 'fetch' }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  function mapError(err, context = {}) {
    if (context.kind === 'http') {
      return {
        code: 'MODEL_PROVIDER_ERROR',
        message: 'Model request failed',
        status: 502,
        detail: `warmup_http_${context.status}`
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
        detail: 'warmup_timeout'
      };
    }

    return {
      code: 'MODEL_PROVIDER_ERROR',
      message: 'Failed to reach model',
      status: 502,
      detail: 'warmup_fetch_failed'
    };
  }

  return {
    rewrite,
    checkReadiness,
    triggerWarmup,
    mapError,
    getInfo: () => ({
      provider: 'ollama',
      ollamaUrl: generateUrl,
      ollamaPsUrl: psUrl,
      ollamaModel: model,
      ollamaKeepAlive: keepAlive
    })
  };
}

module.exports = { createOllamaProvider };
