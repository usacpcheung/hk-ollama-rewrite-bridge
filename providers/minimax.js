const { randomUUID } = require('crypto');

const {
  successResult,
  failureResult,
  streamTextEvent,
  streamDoneEvent,
  streamErrorEvent
} = require('../lib/bridge-contract');

function createMinimaxProvider({
  apiUrl,
  model,
  apiKey,
  systemPrompt,
  userTemplate,
  maxCompletionTokens = 300,
  debugLog
}) {
  const probeBody = {
    model,
    messages: buildProbeMessages(),
    max_completion_tokens: 1,
    stream: false
  };

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
        body: JSON.stringify(probeBody),
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
    return successResult({ response: '', usage: null });
  }

  async function rewrite({ requestId, prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs }) {
    return generate({
      requestId,
      prompt,
      systemPrompt: runtimeSystemPrompt,
      userContent,
      timeoutMs,
      maxTokens: maxCompletionTokens
    });
  }

  async function rewriteStream({ requestId, prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs, onChunk }) {
    return generateStream({
      requestId,
      prompt,
      systemPrompt: runtimeSystemPrompt,
      userContent,
      timeoutMs,
      maxTokens: maxCompletionTokens,
      onChunk
    });
  }

  async function generate({ requestId, prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs, maxTokens }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
      const body = {
        model,
        messages: buildMessages({
          prompt,
          systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
          userContent
        }),
        stream: false,
        max_completion_tokens: maxTokens,
        temperature: 0.15
      };

      debugLog?.({
        requestId,
        stream: false,
        eventType: 'provider_request',
        payload: { headers, body }
      });

      const response = await fetch(apiUrl, {
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

      debugLog?.({
        requestId,
        stream: false,
        eventType: 'provider_response_raw',
        payload: {
          requestId: requestId || null,
          stream: false,
          response: data
        }
      });

      const responseText =
        data?.reply ||
        data?.choices?.[0]?.message?.content ||
        data?.choices?.[0]?.text ||
        '';

      return successResult({ response: responseText, usage: data?.usage || null });
    } catch (err) {
      return failureResult(mapError(err, { kind: 'fetch' }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateStream({
    requestId,
    prompt,
    systemPrompt: runtimeSystemPrompt,
    userContent,
    timeoutMs,
    maxTokens,
    onChunk
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const emit = async (event) => {
      if (typeof onChunk === 'function') {
        await onChunk(event);
      }
    };

    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
      const body = {
        model,
        messages: buildMessages({
          prompt,
          systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
          userContent
        }),
        stream: true,
        max_completion_tokens: maxTokens,
        temperature: 0.15
      };

      debugLog?.({
        requestId,
        stream: true,
        eventType: 'provider_request',
        payload: { headers, body }
      });

      const response = await fetch(apiUrl, {
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
      let streamedText = '';
      let doneEventEmitted = false;
      let doneReason = 'stop';
      let finalCompletionEvent = null;
      let finalMessageContent = '';
      const streamId = `chatcmpl-${typeof randomUUID === 'function' ? randomUUID() : `${Date.now()}`}`;

      const emitMappedChunk = async (chunk) => {
        await emit(streamTextEvent({ text: chunk?.response || '', raw: chunk }));
      };

      const emitDone = async (reason) => {
        if (doneEventEmitted) {
          return;
        }

        doneReason = reason || doneReason || 'stop';
        doneEventEmitted = true;
        await emit(
          streamDoneEvent({
            reason: doneReason,
            usage: finalCompletionEvent?.usage || null,
            raw: buildMappedChunk({
              id: streamId,
              model,
              response: '',
              done: true,
              doneReason,
              usage: finalCompletionEvent?.usage || null
            })
          })
        );
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

        const parsedFrame = parseMinimaxSseFrame(payload);
        if (!parsedFrame) {
          return;
        }

        if (parsedFrame.completion) {
          finalCompletionEvent = parsedFrame.completion;
        }

        if (typeof parsedFrame.finalMessageContent === 'string' && parsedFrame.finalMessageContent.length > 0) {
          finalMessageContent = parsedFrame.finalMessageContent;
        }

        if (parsedFrame.chunk && !parsedFrame.chunk.done) {
          const chunk = {
            ...parsedFrame.chunk,
            id: streamId,
            model
          };

          const token = chunk.response;
          if (typeof token === 'string' && token.length > 0 && !chunk.done) {
            streamedText += token;
          }

          await emitMappedChunk(chunk);
          return;
        }

        if (parsedFrame.chunk?.done) {
          if (!streamedText && finalMessageContent) {
            await emitMappedChunk(
              buildMappedChunk({
                id: streamId,
                model,
                response: finalMessageContent,
                done: false
              })
            );
            streamedText += finalMessageContent;
          }

          await emitDone(parsedFrame.chunk.done_reason || 'stop');
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
        finalMessageContent ||
        finalCompletionEvent?.choices?.[0]?.message?.content ||
        finalCompletionEvent?.choices?.[0]?.text ||
        streamedText ||
        '';

      debugLog?.({
        requestId,
        stream: true,
        eventType: 'provider_response_raw',
        payload: {
          requestId: requestId || null,
          stream: true,
          completion: finalCompletionEvent || null
        }
      });

      if (!streamedText && finalResponseText && !doneEventEmitted) {
        await emitMappedChunk(
          buildMappedChunk({
            id: streamId,
            model,
            response: finalResponseText,
            done: false
          })
        );
      }

      await emitDone(doneReason);
      return successResult({
        response: finalResponseText,
        usage: finalCompletionEvent?.usage || null,
        doneReason
      });
    } catch (err) {
      const mappedError = mapError(err, { kind: err?.code === 'INVALID_JSON_CHUNK' ? 'invalid_json' : 'fetch' });
      await emit(streamErrorEvent({ error: mappedError }));
      return failureResult(mappedError);
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
      minimaxApiKeySet: Boolean(apiKey),
      minimaxSystemPrompt: systemPrompt || null,
      minimaxUserTemplate: userTemplate || null
    })
  };
}

function buildMappedChunk({ id, model, response, done, doneReason, usage }) {
  return {
    ...(id ? { id } : {}),
    object: 'chat.completion.chunk',
    created_at: new Date().toISOString(),
    ...(model ? { model } : {}),
    response,
    done,
    ...(done ? { done_reason: doneReason || 'stop' } : {}),
    ...(done && usage && typeof usage === 'object' ? { usage } : {})
  };
}

function parseMinimaxSseFrame(payload) {
  let eventData;
  try {
    eventData = JSON.parse(payload);
  } catch (_err) {
    return null;
  }

  const completion = eventData?.object === 'chat.completion' ? eventData : null;
  const choice = eventData?.choices?.[0] || {};
  const deltaText = choice?.delta?.content;
  const finishReason = choice?.finish_reason;
  const finalMessageContent = choice?.message?.content;

  if (typeof deltaText === 'string' && deltaText.length > 0) {
    return {
      completion,
      finalMessageContent,
      chunk: buildMappedChunk({ response: deltaText, done: false })
    };
  }

  if (finishReason) {
    return {
      completion,
      finalMessageContent,
      chunk: buildMappedChunk({ response: '', done: true, doneReason: finishReason, usage: completion?.usage || null })
    };
  }

  if (typeof finalMessageContent === 'string' && finalMessageContent.length > 0) {
    return {
      completion,
      finalMessageContent,
      chunk: null
    };
  }

  return {
    completion,
    finalMessageContent: '',
    chunk: null
  };
}


function renderUserContent(template, text) {
  if (typeof template !== 'string' || template.length === 0) {
    return text;
  }

  if (template.includes('{TEXT}')) {
    return template.replace('{TEXT}', text);
  }

  return `${template}${text}`;
}

function buildMessages({ prompt, systemPrompt, userContent }) {
  const userMessageContent = typeof userContent === 'string' ? userContent : prompt;
  const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';

  if (!normalizedSystemPrompt) {
    return [{ role: 'user', content: userMessageContent }];
  }

  return [
    { role: 'system', content: normalizedSystemPrompt },
    { role: 'user', content: userMessageContent }
  ];
}

function buildProbeMessages() {
  return [{ role: 'user', content: 'ping' }];
}

module.exports = {
  createMinimaxProvider,
  parseMinimaxSseFrame,
  buildMappedChunk,
  buildMessages,
  renderUserContent,
  buildProbeMessages
};
