const { randomUUID } = require('crypto');

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
  apiKey,
  systemPrompt,
  userTemplate,
  maxCompletionTokens = 300,
  debugLog
}) {
  const t2aFormat = 'mp3';
  const t2aMimeType = 'audio/mpeg';
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

  async function t2a({ requestId, text, voice, audio, timeoutMs }) {
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
        voice_setting: {
          voice_id: voice?.voiceId,
          speed: voice?.speed,
          vol: voice?.volume,
          pitch: voice?.pitch
        },
        audio_setting: {
          sample_rate: audio?.sampleRate,
          bitrate: audio?.bitrate,
          format: audio?.format || t2aFormat
        }
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

      const normalized = normalizeProviderSyncResponse({ provider: 'minimax', payload: data });

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
      return { code: 'PROVIDER_ERROR', message: 'Invalid provider response', status: 502, detail: 'minimax_invalid_json' };
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
  renderUserContent,
  buildProbeMessages,
  extractMinimaxT2AAudio,
  deepFindHexAudio,
  isLikelyHexAudio
};
