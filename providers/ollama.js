const {
  successResult,
  failureResult,
  streamTextEvent,
  streamDoneEvent,
  streamErrorEvent
} = require('../lib/bridge-contract');
const {
  extractOllamaUsage,
  normalizeProviderSyncResponse,
  normalizeProviderStreamTerminal
} = require('../lib/provider-response-normalizer');

function createOllamaProvider({
  generateUrl,
  psUrl,
  model,
  keepAlive,
  maxCompletionTokens = 300,
  debugLog
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

  async function rewrite({ requestId, prompt, timeoutMs }) {
    return generate({
      requestId,
      prompt,
      timeoutMs,
      options: {
        temperature: 0.15,
        num_predict: maxCompletionTokens
      }
    });
  }

  async function rewriteStream({ requestId, prompt, timeoutMs, onChunk }) {
    return generateStream({
      requestId,
      prompt,
      timeoutMs,
      options: {
        temperature: 0.15,
        num_predict: maxCompletionTokens
      },
      onChunk
    });
  }

  async function generate({ requestId, prompt, timeoutMs, options }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = { 'Content-Type': 'application/json' };
      const body = {
        model,
        prompt,
        stream: false,
        keep_alive: keepAlive,
        options
      };

      debugLog?.({
        requestId,
        stream: false,
        eventType: 'provider_request',
        payload: { headers, body }
      });

      const response = await fetch(generateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        return failureResult(mapError(new Error('request_failed'), { kind: 'http', status: response.status }));
      }

      let data;
      try {
        data = await response.json();
      } catch (_err) {
        return failureResult(mapError(new Error('invalid_json'), { kind: 'invalid_json' }));
      }

      const normalized = normalizeProviderSyncResponse({ provider: 'ollama', payload: data });
      return successResult({
        response: normalized.text,
        usage: normalized.usage,
        ...(normalized.doneReason ? { doneReason: normalized.doneReason } : {})
      });
    } catch (err) {
      return failureResult(mapError(err, { kind: 'fetch' }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateStream({ requestId, prompt, timeoutMs, options, onChunk }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const emit = async (event) => {
      if (typeof onChunk === 'function') {
        await onChunk(event);
      }
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      const body = {
        model,
        prompt,
        stream: true,
        keep_alive: keepAlive,
        options
      };

      debugLog?.({
        requestId,
        stream: true,
        eventType: 'provider_request',
        payload: { headers, body }
      });

      const response = await fetch(generateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        return failureResult(mapError(new Error('request_failed'), { kind: 'http', status: response.status }));
      }

      if (!response.body) {
        return failureResult(mapError(new Error('missing_body'), { kind: 'invalid_json' }));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let responseText = '';
      let lastChunk = null;

      const invalidChunkError = () => {
        const err = new Error('invalid_json');
        err.code = 'INVALID_JSON_CHUNK';
        return err;
      };

      const processLine = async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let payload;
        try {
          payload = JSON.parse(trimmed);
        } catch (_err) {
          throw invalidChunkError();
        }

        lastChunk = payload;
        const token = payload?.response;
        if (typeof token === 'string' && token.length > 0) {
          responseText += token;
          await emit(streamTextEvent({ text: token, raw: payload }));
        }

        if (payload?.done) {
          const terminal = normalizeProviderStreamTerminal({
            provider: 'ollama',
            payload,
            fallbackDoneReason: 'stop'
          });
          await emit(
            streamDoneEvent({
              reason: terminal.doneReason,
              usage: terminal.usage,
              raw: payload
            })
          );
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          await processLine(line);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        await processLine(buffer);
      }

      if (!lastChunk || !lastChunk.done) {
        throw invalidChunkError();
      }

      const terminal = normalizeProviderStreamTerminal({
        provider: 'ollama',
        payload: lastChunk,
        fallbackText: responseText,
        fallbackDoneReason: 'stop'
      });

      return successResult({
        response: terminal.text,
        usage: terminal.usage,
        doneReason: terminal.doneReason
      });
    } catch (err) {
      const mappedError = err?.code === 'INVALID_JSON_CHUNK'
        ? mapError(err, { kind: 'invalid_json' })
        : mapError(err, { kind: 'fetch' });
      await emit(streamErrorEvent({ error: mappedError }));
      if (err?.code === 'INVALID_JSON_CHUNK') {
        return failureResult(mappedError);
      }

      return failureResult(mappedError);
    } finally {
      clearTimeout(timeout);
    }
  }

  function mapError(err, context = {}) {
    if (context.kind === 'http') {
      return {
        code: 'OLLAMA_ERROR',
        message: 'Model request failed',
        status: 502,
        detail: `warmup_http_${context.status}`
      };
    }

    if (context.kind === 'invalid_json') {
      return { code: 'OLLAMA_ERROR', message: 'Invalid model response', status: 502 };
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
      code: 'OLLAMA_ERROR',
      message: 'Failed to reach model',
      status: 502,
      detail: 'warmup_fetch_failed'
    };
  }

  return {
    services: {
      rewrite: {
        sync: rewrite,
        stream: rewriteStream
      }
    },
    rewrite,
    rewriteStream,
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



module.exports = { createOllamaProvider, extractOllamaUsage };
