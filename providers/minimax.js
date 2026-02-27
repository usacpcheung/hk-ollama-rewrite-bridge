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

  async function rewriteStream({ prompt, timeoutMs, onChunk }) {
    return generateStream({
      prompt,
      timeoutMs,
      maxTokens: 300,
      onChunk
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

  async function generateStream({ prompt, timeoutMs, maxTokens, onChunk }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const emit = async (event) => {
      if (typeof onChunk === 'function') {
        await onChunk(event);
      }
    };

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
          stream: true,
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

      if (!response.body) {
        return { ok: false, error: mapError(new Error('missing_body'), { kind: 'invalid_json' }) };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let streamedText = '';
      let doneEventEmitted = false;
      let finalCompletionEvent = null;

      const emitDone = async (reason) => {
        if (doneEventEmitted) {
          return;
        }

        doneEventEmitted = true;
        await emit({ type: 'done', reason: reason || 'stop' });
      };

      const processSseFrame = async (frame) => {
        const trimmed = frame.trim();
        if (!trimmed) {
          return;
        }

        const payload = trimmed
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart())
          .join('\n')
          .trim();

        if (!payload) {
          return;
        }

        if (payload === '[DONE]') {
          await emitDone('done');
          return;
        }

        let eventData;
        try {
          eventData = JSON.parse(payload);
        } catch (_err) {
          return;
        }

        if (eventData?.object === 'chat.completion') {
          finalCompletionEvent = eventData;
        }

        const choice = eventData?.choices?.[0] || {};
        const deltaText = choice?.delta?.content;
        if (typeof deltaText === 'string' && deltaText.length > 0) {
          streamedText += deltaText;
          await emit({ type: 'token', text: deltaText });
        }

        if (choice?.finish_reason) {
          await emitDone(choice.finish_reason);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';

        for (const frame of frames) {
          await processSseFrame(frame);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        await processSseFrame(buffer);
      }

      const finalResponseText =
        finalCompletionEvent?.reply ||
        finalCompletionEvent?.choices?.[0]?.message?.content ||
        finalCompletionEvent?.choices?.[0]?.text ||
        streamedText ||
        '';

      await emitDone('stop');
      await emit({
        type: 'final',
        response: finalResponseText,
        usage: finalCompletionEvent?.usage || null,
        completion: finalCompletionEvent || null
      });

      return {
        ok: true,
        data: {
          response: finalResponseText,
          usage: finalCompletionEvent?.usage || null,
          completion: finalCompletionEvent || null
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
    rewriteStream,
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
