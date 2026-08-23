const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const {
  successResult,
  failureResult,
  streamTextEvent,
  streamDoneEvent,
  streamErrorEvent
} = require('../lib/bridge-contract');
const {
  normalizeProviderSyncResponse,
  normalizeProviderStreamTerminal
} = require('../lib/provider-response-normalizer');

function createMinimaxProvider({
  apiUrl,
  model,
  apiFormat = 'legacy-chat',
  anthropicBaseUrl = 'https://api.minimax.io/anthropic',
  apiKey,
  systemPrompt,
  userTemplate,
  maxCompletionTokens = 300,
  debugLog
}) {
  const t2aFormat = 'mp3';
  const t2aMimeType = 'audio/mpeg';
  const probeBody = buildMinimaxRewriteBody({
    model,
    messages: buildProbeMessages(),
    maxTokens: 1,
    stream: false,
    includeTemperature: false
  });

  async function checkReadiness({ timeoutMs }) {
    if (!apiKey) {
      return { ready: false, error: 'minimax_api_key_missing' };
    }

    if (apiFormat === 'anthropic') {
      return { ready: true, error: null };
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
    if (apiFormat === 'anthropic') {
      return generateAnthropic({
        requestId,
        prompt,
        systemPrompt: runtimeSystemPrompt,
        userContent,
        timeoutMs,
        maxTokens: maxCompletionTokens
      });
    }

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
    if (apiFormat === 'anthropic') {
      return generateAnthropicStream({
        requestId,
        prompt,
        systemPrompt: runtimeSystemPrompt,
        userContent,
        timeoutMs,
        maxTokens: maxCompletionTokens,
        onChunk
      });
    }

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

  async function t2a({ requestId, text, voice, audio, languageBoost, voiceModify, outputFormat, timeoutMs }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
      const body = {
        model,
        text,
        stream: false,
        voice_setting: {
          voice_id: voice?.voiceId,
          speed: voice?.speed,
          vol: voice?.volume,
          pitch: voice?.pitch
        },
        audio_setting: {
          sample_rate: audio?.sampleRate,
          bitrate: audio?.bitrate,
          format: audio?.format || t2aFormat,
          channel: audio?.channel
        },
        language_boost: languageBoost,
        voice_modify: {
          pitch: voiceModify?.pitch,
          intensity: voiceModify?.intensity,
          timbre: voiceModify?.timbre
        },
        output_format: outputFormat || 'hex'
      };

      debugLog?.({
        requestId,
        stream: false,
        eventType: 'provider_request',
        payload: { headers, body, service: 't2a' }
      });

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

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
          service: 't2a',
          response: data
        }
      });

      if (!response.ok) {
        return failureResult(mapError(new Error('request_failed'), { kind: 'http', status: response.status }));
      }

      const extractedAudio = extractMinimaxT2AAudio(data);
      if (!extractedAudio.ok) {
        return failureResult(mapError(new Error(extractedAudio.reason), { kind: extractedAudio.reason }));
      }

      const providerMeta = extractMinimaxT2AProviderMetadata(data, extractedAudio.sourcePath);
      const audioBuffer = Buffer.from(extractedAudio.hexAudio, 'hex');

      return successResult({
        output: {
          text: '',
          artifacts: [
            {
              kind: 'audio',
              data: audioBuffer,
              mime: t2aMimeType,
              contentType: providerMeta.contentType || t2aMimeType,
              format: t2aFormat
            }
          ],
          meta: {
            audio: audioBuffer,
            mime: t2aMimeType,
            contentType: providerMeta.contentType || t2aMimeType,
            format: t2aFormat,
            provider: providerMeta
          }
        },
        response: ''
      });
    } catch (err) {
      return failureResult(mapError(err, { kind: 'fetch' }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generate({ requestId, prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs, maxTokens }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
      const body = buildMinimaxRewriteBody({
        model,
        messages: buildMessages({
          prompt,
          systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
          userContent
        }),
        stream: false,
        maxTokens
      });

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

      const providerFailure = getMinimaxProviderFailure(data);
      if (providerFailure) {
        return failureResult(mapError(new Error('provider_error'), {
          kind: 'provider',
          providerCode: providerFailure.code
        }));
      }

      const normalized = extractMinimaxRewriteResponse(data);
      if (!normalized.text) {
        return failureResult(mapError(new Error('empty_content'), { kind: 'empty_content' }));
      }

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
      const body = buildMinimaxRewriteBody({
        model,
        messages: buildMessages({
          prompt,
          systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
          userContent
        }),
        stream: true,
        maxTokens
      });

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
      let authoritativeDoneReason = null;
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

        const terminal = normalizeProviderStreamTerminal({
          provider: 'minimax',
          payload: finalCompletionEvent,
          fallbackText: finalMessageContent || streamedText,
          fallbackDoneReason: authoritativeDoneReason || reason || doneReason || 'stop'
        });

        doneReason = terminal.doneReason;
        doneEventEmitted = true;
        await emit(
          streamDoneEvent({
            reason: terminal.doneReason,
            usage: terminal.usage,
            raw: buildMappedChunk({
              id: streamId,
              model,
              response: '',
              done: true,
              doneReason: terminal.doneReason,
              usage: terminal.usage
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
          await emitDone();
          return;
        }

        const parsedFrame = parseMinimaxSseFrame(payload);
        if (!parsedFrame) {
          return;
        }

        if (parsedFrame.providerFailure) {
          const error = mapError(new Error('provider_error'), {
            kind: 'provider',
            providerCode: parsedFrame.providerFailure.code
          });
          await emit(streamErrorEvent({ error }));
          throw Object.assign(new Error('provider_error'), {
            code: 'MINIMAX_PROVIDER_ERROR',
            mappedError: error
          });
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
          if (parsedFrame.chunk.done_reason && !authoritativeDoneReason) {
            authoritativeDoneReason = parsedFrame.chunk.done_reason;
          }

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

          await emitDone(parsedFrame.chunk.done_reason);
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

      const finalTerminal = normalizeProviderStreamTerminal({
        provider: 'minimax',
        payload: finalCompletionEvent,
        fallbackText: finalMessageContent || streamedText || '',
        fallbackDoneReason: authoritativeDoneReason || doneReason || 'stop'
      });
      const finalResponseText = finalTerminal.text;

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
        usage: finalTerminal.usage,
        doneReason: doneReason || finalTerminal.doneReason
      });
    } catch (err) {
      const mappedError = err?.mappedError
        || mapError(err, { kind: err?.code === 'INVALID_JSON_CHUNK' ? 'invalid_json' : 'fetch' });
      if (!err?.mappedError) {
        await emit(streamErrorEvent({ error: mappedError }));
      }
      return failureResult(mappedError);
    } finally {
      clearTimeout(timeout);
    }
  }

  function createAnthropicClient() {
    return new Anthropic({
      apiKey,
      baseURL: anthropicBaseUrl,
      maxRetries: 0,
      logLevel: 'off'
    });
  }

  function buildAnthropicRequest({
    prompt,
    systemPrompt: runtimeSystemPrompt,
    userContent,
    maxTokens,
    stream
  }) {
    const content = typeof userContent === 'string' ? userContent : prompt;
    const request = {
      model,
      max_tokens: maxTokens,
      temperature: 0.15,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: content }]
        }
      ],
      stream
    };
    const resolvedSystemPrompt =
      runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt;
    if (typeof resolvedSystemPrompt === 'string' && resolvedSystemPrompt.trim()) {
      request.system = resolvedSystemPrompt.trim();
    }
    return request;
  }

  async function generateAnthropic({
    requestId,
    prompt,
    systemPrompt: runtimeSystemPrompt,
    userContent,
    timeoutMs,
    maxTokens
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const body = buildAnthropicRequest({
      prompt,
      systemPrompt: runtimeSystemPrompt,
      userContent,
      maxTokens,
      stream: false
    });

    try {
      debugLog?.({
        requestId,
        stream: false,
        eventType: 'provider_request',
        payload: {
          service: 'rewrite',
          apiFormat: 'anthropic',
          baseUrl: anthropicBaseUrl,
          body
        }
      });

      const message = await createAnthropicClient().messages.create(body, {
        signal: controller.signal
      });

      debugLog?.({
        requestId,
        stream: false,
        eventType: 'provider_response_raw',
        payload: {
          requestId: requestId || null,
          stream: false,
          response: message
        }
      });

      const text = extractAnthropicText(message);
      if (!text.trim()) {
        return failureResult(mapError(new Error('empty_content'), { kind: 'empty_content' }));
      }

      return successResult({
        response: text,
        usage: message?.usage || null,
        ...(message?.stop_reason ? { doneReason: message.stop_reason } : {})
      });
    } catch (err) {
      return failureResult(mapAnthropicError(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateAnthropicStream({
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
    const body = buildAnthropicRequest({
      prompt,
      systemPrompt: runtimeSystemPrompt,
      userContent,
      maxTokens,
      stream: true
    });
    const emit = async (event) => {
      if (typeof onChunk === 'function') {
        await onChunk(event);
      }
    };

    let text = '';
    let usage = null;
    let doneReason = 'end_turn';
    let sawValidEvent = false;
    let sawMessageStop = false;

    try {
      debugLog?.({
        requestId,
        stream: true,
        eventType: 'provider_request',
        payload: {
          service: 'rewrite',
          apiFormat: 'anthropic',
          baseUrl: anthropicBaseUrl,
          body
        }
      });

      const stream = await createAnthropicClient().messages.create(body, {
        signal: controller.signal
      });

      for await (const event of stream) {
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          continue;
        }
        sawValidEvent = true;

        if (event.type === 'message_start') {
          usage = mergeAnthropicUsage(usage, event.message?.usage);
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const chunk = event.delta.text || '';
          if (chunk) {
            text += chunk;
            await emit(streamTextEvent({ text: chunk, raw: event }));
          }
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          debugLog?.({
            requestId,
            stream: true,
            eventType: 'provider_reasoning_ignored',
            payload: {
              requestId: requestId || null,
              stream: true,
              provider: 'minimax'
            }
          });
          continue;
        }

        if (event.type === 'message_delta') {
          usage = mergeAnthropicUsage(usage, event.usage);
          doneReason = event.delta?.stop_reason || doneReason;
          continue;
        }

        if (event.type === 'message_stop') {
          sawMessageStop = true;
        }
      }

      if (!sawValidEvent || !sawMessageStop) {
        const error = mapError(new Error('incomplete_stream'), { kind: 'invalid_json' });
        await emit(streamErrorEvent({ error }));
        return failureResult(error);
      }

      if (!text.trim()) {
        const error = mapError(new Error('empty_content'), { kind: 'empty_content' });
        await emit(streamErrorEvent({ error }));
        return failureResult(error);
      }

      await emit(streamDoneEvent({ reason: doneReason, usage }));
      debugLog?.({
        requestId,
        stream: true,
        eventType: 'provider_response_raw',
        payload: {
          requestId: requestId || null,
          stream: true,
          completion: {
            type: 'message',
            stop_reason: doneReason,
            usage
          }
        }
      });

      return successResult({
        response: text,
        usage,
        doneReason
      });
    } catch (err) {
      const mappedError = mapAnthropicError(err);
      await emit(streamErrorEvent({ error: mappedError }));
      return failureResult(mappedError);
    } finally {
      clearTimeout(timeout);
    }
  }

  function mapAnthropicError(err) {
    if (
      err?.name === 'AbortError'
      || err?.name === 'APIUserAbortError'
      || err?.name === 'APIConnectionTimeoutError'
      || err?.constructor?.name === 'APIUserAbortError'
      || err?.constructor?.name === 'APIConnectionTimeoutError'
      || err?.code === 'ABORT_ERR'
    ) {
      return {
        code: 'MODEL_TIMEOUT',
        message: 'Model response timed out. Please retry.',
        status: 504,
        detail: 'minimax_timeout'
      };
    }

    if (err?.status === 401 || err?.status === 403) {
      return mapError(err, { kind: 'http', status: err.status });
    }

    if (typeof err?.status === 'number') {
      return mapError(err, { kind: 'http', status: err.status });
    }

    if (
      err instanceof SyntaxError
      || String(err?.message || '').includes('Could not parse message into JSON')
    ) {
      return mapError(err, { kind: 'invalid_json' });
    }

    return mapError(err, { kind: 'fetch' });
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
      return { code: 'PROVIDER_ERROR', message: 'Invalid provider response', status: 502, detail: 'minimax_invalid_json' };
    }

    if (context.kind === 'provider') {
      return {
        code: 'PROVIDER_ERROR',
        message: 'Provider request failed',
        status: 502,
        detail: `minimax_provider_${context.providerCode ?? 'unknown'}`
      };
    }

    if (context.kind === 'empty_content') {
      return {
        code: 'PROVIDER_ERROR',
        message: 'Provider response did not include rewrite content',
        status: 502,
        detail: 'minimax_empty_content'
      };
    }

    if (context.kind === 'missing_audio') {
      return { code: 'PROVIDER_ERROR', message: 'Provider response did not include audio data', status: 502, detail: 'minimax_missing_audio' };
    }

    if (context.kind === 'schema_drift') {
      return { code: 'PROVIDER_ERROR', message: 'Provider response schema changed unexpectedly', status: 502, detail: 'minimax_schema_drift' };
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
    services: {
      rewrite: {
        sync: rewrite,
        stream: rewriteStream
      },
      t2a: {
        sync: t2a
      }
    },
    rewrite,
    rewriteStream,
    t2a,
    checkReadiness,
    triggerWarmup,
    mapError,
    getInfo: () => ({
      provider: 'minimax',
      minimaxApiUrl: apiUrl,
      minimaxModel: model,
      minimaxApiFormat: apiFormat,
      minimaxAnthropicBaseUrl: anthropicBaseUrl,
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

  const providerFailure = getMinimaxProviderFailure(eventData);
  const completion = eventData?.object === 'chat.completion' ? eventData : null;
  const choice = eventData?.choices?.[0] || {};
  const deltaText = choice?.delta?.content;
  const finishReason = choice?.finish_reason;
  const finalMessageContent = choice?.message?.content;

  if (providerFailure) {
    return {
      completion,
      finalMessageContent: '',
      chunk: null,
      providerFailure
    };
  }

  if (typeof deltaText === 'string' && deltaText.length > 0) {
    return {
      completion,
      finalMessageContent,
      chunk: buildMappedChunk({ response: deltaText, done: false }),
      providerFailure: null
    };
  }

  if (finishReason) {
    return {
      completion,
      finalMessageContent,
      chunk: buildMappedChunk({ response: '', done: true, doneReason: finishReason, usage: eventData?.usage || null }),
      providerFailure: null
    };
  }

  if (typeof finalMessageContent === 'string' && finalMessageContent.length > 0) {
    return {
      completion,
      finalMessageContent,
      chunk: null,
      providerFailure: null
    };
  }

  return {
    completion,
    finalMessageContent: '',
    chunk: null,
    providerFailure: null
  };
}

function buildMinimaxRewriteBody({
  model,
  messages,
  maxTokens,
  stream,
  includeTemperature = true
}) {
  return {
    model,
    messages,
    stream,
    max_completion_tokens: maxTokens,
    ...(includeTemperature ? { temperature: 0.15 } : {})
  };
}

function extractMinimaxRewriteResponse(payload) {
  const normalized = normalizeProviderSyncResponse({ provider: 'minimax', payload });
  return {
    text: normalized.text,
    usage: normalized.usage,
    doneReason: normalized.doneReason
  };
}

function getMinimaxProviderFailure(payload) {
  const statusCode = payload?.base_resp?.status_code;
  if (typeof statusCode === 'number' && statusCode !== 0) {
    return {
      code: statusCode,
      message: payload?.base_resp?.status_msg || null
    };
  }
  return null;
}

function extractAnthropicText(message) {
  if (!Array.isArray(message?.content)) {
    return '';
  }

  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function mergeAnthropicUsage(current, next) {
  if (!next || typeof next !== 'object') {
    return current;
  }

  return {
    ...(current || {}),
    ...Object.fromEntries(
      Object.entries(next).filter(([, value]) => typeof value === 'number')
    )
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

function extractMinimaxT2AAudio(payload) {
  const directCandidates = [
    { value: payload?.audio, path: 'audio' },
    { value: payload?.audio_hex, path: 'audio_hex' },
    { value: payload?.audioHex, path: 'audioHex' },
    { value: payload?.data?.audio, path: 'data.audio' },
    { value: payload?.data?.audio_hex, path: 'data.audio_hex' },
    { value: payload?.data?.audioHex, path: 'data.audioHex' },
    { value: payload?.data?.audio_data, path: 'data.audio_data' },
    { value: payload?.base_resp?.audio, path: 'base_resp.audio' }
  ];

  for (const candidate of directCandidates) {
    if (isLikelyHexAudio(candidate.value)) {
      return { ok: true, hexAudio: candidate.value, sourcePath: candidate.path, search: 'direct' };
    }
  }

  const deepMatch = deepFindHexAudio(payload);
  if (deepMatch) {
    return { ok: true, hexAudio: deepMatch.value, sourcePath: deepMatch.path, search: 'deep' };
  }

  if (payload && typeof payload === 'object') {
    return { ok: false, reason: 'missing_audio' };
  }

  return { ok: false, reason: 'schema_drift' };
}

function deepFindHexAudio(node, path = 'root', seen = new WeakSet()) {
  if (node == null) {
    return null;
  }

  if (typeof node === 'string') {
    return isLikelyHexAudio(node) ? { value: node, path } : null;
  }

  if (typeof node !== 'object') {
    return null;
  }

  if (seen.has(node)) {
    return null;
  }
  seen.add(node);

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const found = deepFindHexAudio(node[index], `${path}[${index}]`, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const [key, value] of Object.entries(node)) {
    const found = deepFindHexAudio(value, path === 'root' ? key : `${path}.${key}`, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

function isLikelyHexAudio(value) {
  return typeof value === 'string' && value.length > 64 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function extractMinimaxT2AProviderMetadata(payload, sourcePath) {
  const baseResp = payload?.base_resp && typeof payload.base_resp === 'object' ? payload.base_resp : null;
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : null;
  const contentType = (typeof payload?.content_type === 'string' && payload.content_type)
    || (typeof data?.content_type === 'string' && data.content_type)
    || t2aContentTypeFromFormat((typeof data?.format === 'string' && data.format) || null)
    || 'audio/mpeg';

  return {
    statusCode: typeof payload?.status_code === 'number' ? payload.status_code : null,
    status: typeof payload?.status === 'string' ? payload.status : null,
    traceId: typeof payload?.trace_id === 'string' ? payload.trace_id : null,
    extraInfo: payload?.extra_info || null,
    subtitles: data?.subtitles || null,
    audioLength: typeof data?.audio_length === 'number' ? data.audio_length : null,
    sourcePath,
    contentType,
    baseResp
  };
}

function t2aContentTypeFromFormat(format) {
  if (format === 'mp3') {
    return 'audio/mpeg';
  }
  if (format === 'wav') {
    return 'audio/wav';
  }
  if (format === 'pcm') {
    return 'audio/pcm';
  }
  return null;
}

module.exports = {
  createMinimaxProvider,
  parseMinimaxSseFrame,
  buildMappedChunk,
  buildMessages,
  buildMinimaxRewriteBody,
  extractMinimaxRewriteResponse,
  getMinimaxProviderFailure,
  extractAnthropicText,
  mergeAnthropicUsage,
  renderUserContent,
  buildProbeMessages,
  extractMinimaxT2AAudio,
  deepFindHexAudio,
  isLikelyHexAudio
};
