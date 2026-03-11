const { randomUUID } = require('crypto');
const OpenAI = require('openai');

function envFlagEnabled(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function safeStringLength(value) {
  return typeof value === 'string' ? value.length : 0;
}


function normalizeCompletionMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (!part || typeof part !== 'object') {
        return '';
      }

      if (typeof part.text === 'string') {
        return part.text;
      }

      if (typeof part.content === 'string') {
        return part.content;
      }

      if (typeof part.output_text === 'string') {
        return part.output_text;
      }

      return '';
    })
    .join('');
}

function stripThinkSegments(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractCompletionArtifacts({ completion, streamAccumulation = '', streamReasoningDetails = null }) {
  const choice = completion?.choices?.[0] || {};
  const normalizedContent = normalizeCompletionMessageContent(choice?.message?.content);
  const reasoningDetails = Array.isArray(streamReasoningDetails) && streamReasoningDetails.length > 0
    ? streamReasoningDetails
    : (Array.isArray(choice?.message?.reasoning_details) ? choice.message.reasoning_details : []);
  const shouldStripThink = reasoningDetails.length > 0;
  const normalizedAnswer = shouldStripThink ? stripThinkSegments(normalizedContent) : normalizedContent;

  const response =
    completion?.reply ||
    normalizedAnswer ||
    choice?.text ||
    streamAccumulation ||
    '';

  return {
    response,
    usage: completion?.usage || null,
    reasoning: {
      splitRequested: true,
      splitAvailable: reasoningDetails.length > 0,
      detailsCount: reasoningDetails.length,
      details: reasoningDetails,
      thinkSegmentsStripped: shouldStripThink && normalizedAnswer !== normalizedContent
    }
  };
}

function logMinimaxDebug(payload) {
  if (!envFlagEnabled('MINIMAX_DEBUG_RAW_LOG')) {
    return;
  }

  console.log(JSON.stringify({ level: 'debug', provider: 'minimax', ...payload }));
}

function createMinimaxProvider({
  apiUrl,
  apiStyle = 'legacy',
  openaiBaseUrl = 'https://api.minimax.io/v1',
  model,
  apiKey,
  systemPrompt,
  userTemplate,
  maxCompletionTokens = 5000
}) {
  const resolvedOpenaiBaseUrl = process.env.MINIMAX_OPENAI_BASE_URL || openaiBaseUrl;
  const resolvedApiKey = process.env.MINIMAX_API_KEY || apiKey;
  const resolvedApiStyle = apiStyle === 'openai_compatible' ? 'openai_compatible' : 'legacy';
  const isOpenAiCompatibleStyle = resolvedApiStyle === 'openai_compatible';
  const resolvedMaxCompletionTokens = Number.isInteger(maxCompletionTokens) && maxCompletionTokens > 0
    ? maxCompletionTokens
    : 5000;
  const openaiClient = new OpenAI({
    apiKey: resolvedApiKey,
    baseURL: resolvedOpenaiBaseUrl
  });
  function buildOpenaiCompatibleRequestOptions(payload = {}) {
    return {
      ...payload,
      extra_body: {
        reasoning_split: true
      }
    };
  }

  function buildLegacyRequestPayload({
    prompt,
    runtimeSystemPrompt,
    userContent,
    maxTokens,
    stream
  }) {
    return {
      model,
      messages: buildMessages({
        prompt,
        systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
        userContent
      }),
      stream,
      max_completion_tokens: maxTokens,
      temperature: 0.15
    };
  }

  async function checkReadiness({ timeoutMs }) {
    if (!resolvedApiKey) {
      return { ready: false, error: 'minimax_api_key_missing' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    if (isOpenAiCompatibleStyle) {
      return checkReadinessOpenaiCompatible({ timeoutMs, controller, timeout });
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedApiKey}`
        },
        body: JSON.stringify({
          model,
          messages: buildMessages({
            prompt: 'ping',
            systemPrompt,
            userContent: renderUserContent(userTemplate, 'ping')
          }),
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

  async function rewrite({ prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs }) {
    return generate({
      prompt,
      systemPrompt: runtimeSystemPrompt,
      userContent,
      timeoutMs,
      maxTokens: resolvedMaxCompletionTokens
    });
  }

  async function rewriteStream({ prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs, onChunk }) {
    return generateStream({
      prompt,
      systemPrompt: runtimeSystemPrompt,
      userContent,
      timeoutMs,
      maxTokens: resolvedMaxCompletionTokens,
      onChunk
    });
  }

  async function generate({ prompt, systemPrompt: runtimeSystemPrompt, userContent, timeoutMs, maxTokens }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    if (isOpenAiCompatibleStyle) {
      return generateOpenaiCompatible({
        prompt,
        runtimeSystemPrompt,
        userContent,
        maxTokens,
        controller,
        timeout
      });
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedApiKey}`
        },
        body: JSON.stringify(buildLegacyRequestPayload({
          prompt,
          runtimeSystemPrompt,
          userContent,
          maxTokens,
          stream: false
        })),
        signal: controller.signal
      });

      if (!response.ok) {
        return {
          ok: false,
          error: mapError(new Error('request_failed'), { kind: 'http', status: response.status })
        };
      }

      const data = await response.json();
      const extracted = extractCompletionArtifacts({ completion: data });

      return {
        ok: true,
        data: {
          response: extracted.response,
          usage: extracted.usage,
          completion: data || null,
          reasoning: {
            ...extracted.reasoning,
            splitRequested: false
          }
        }
      };
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { ok: false, error: mapError(err, { kind: 'invalid_json' }) };
      }

      if (typeof err?.status === 'number') {
        return {
          ok: false,
          error: mapError(new Error('request_failed'), { kind: 'http', status: err.status })
        };
      }

      return { ok: false, error: mapError(err, { kind: 'fetch' }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateStream({
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

    if (isOpenAiCompatibleStyle) {
      return generateStreamOpenaiCompatible({
        prompt,
        runtimeSystemPrompt,
        userContent,
        maxTokens,
        emit,
        controller,
        timeout
      });
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedApiKey}`
        },
        body: JSON.stringify(buildLegacyRequestPayload({
          prompt,
          runtimeSystemPrompt,
          userContent,
          maxTokens,
          stream: true
        })),
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
      let finalMessageContent = '';
      const streamId = `chatcmpl-${typeof randomUUID === 'function' ? randomUUID() : `${Date.now()}`}`;

      const emitMappedChunk = async (chunk) => {
        await emit({ type: 'chunk', chunk });
      };

      const emitDone = async (reason) => {
        if (doneEventEmitted) {
          return;
        }

        doneEventEmitted = true;
        await emitMappedChunk(buildMappedChunk({
          id: streamId,
          model,
          response: '',
          done: true,
          doneReason: reason || 'stop'
        }));
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

        if (parsedFrame.chunk) {
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

          if (chunk.done) {
            doneEventEmitted = true;
          }
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

      const extracted = extractCompletionArtifacts({
        completion: finalCompletionEvent,
        streamAccumulation: streamedText || finalMessageContent || ''
      });
      const finalResponseText = extracted.response;

      if (!streamedText && finalResponseText && !doneEventEmitted) {
        await emitMappedChunk(buildMappedChunk({
          id: streamId,
          model,
          response: finalResponseText,
          done: false
        }));
      }

      await emitDone('stop');
      await emit({
        type: 'final',
        response: finalResponseText,
        usage: extracted.usage,
        completion: finalCompletionEvent || null
      });

      return {
        ok: true,
        data: {
          response: finalResponseText,
          usage: extracted.usage,
          completion: finalCompletionEvent || null,
          reasoning: {
            ...extracted.reasoning,
            splitRequested: false
          }
        }
      };
    } catch (err) {
      return { ok: false, error: mapError(err, { kind: 'fetch' }) };
    } finally {
      clearTimeout(timeout);
    }
  }


  async function checkReadinessOpenaiCompatible({ controller, timeout }) {
    try {
      await openaiClient.chat.completions.create(
        buildOpenaiCompatibleRequestOptions({
          model,
          messages: buildMessages({
            prompt: 'ping',
            systemPrompt,
            userContent: renderUserContent(userTemplate, 'ping')
          }),
          max_completion_tokens: 1,
          stream: false
        }),
        {
          signal: controller.signal
        }
      );

      return { ready: true, error: null };
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        return { ready: false, error: 'minimax_auth_failed' };
      }

      if (err?.name === 'AbortError') {
        return { ready: false, error: 'minimax_readiness_timeout' };
      }

      if (typeof err?.status === 'number') {
        return { ready: false, error: `minimax_readiness_http_${err.status}` };
      }

      return { ready: false, error: 'minimax_readiness_fetch_failed' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateOpenaiCompatible({
    prompt,
    runtimeSystemPrompt,
    userContent,
    maxTokens,
    controller,
    timeout
  }) {
    try {
      const data = await openaiClient.chat.completions.create(
        buildOpenaiCompatibleRequestOptions({
          model,
          messages: buildMessages({
            prompt,
            systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
            userContent
          }),
          stream: false,
          max_completion_tokens: maxTokens,
          temperature: 0.15
        }),
        {
          signal: controller.signal
        }
      );

      const extracted = extractCompletionArtifacts({ completion: data });

      return {
        ok: true,
        data: {
          response: extracted.response,
          usage: extracted.usage,
          completion: data || null,
          reasoning: extracted.reasoning
        }
      };
    } catch (err) {
      if (typeof err?.status === 'number') {
        return {
          ok: false,
          error: mapError(new Error('request_failed'), { kind: 'http', status: err.status })
        };
      }

      return { ok: false, error: mapError(err, { kind: 'fetch' }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateStreamOpenaiCompatible({
    prompt,
    runtimeSystemPrompt,
    userContent,
    maxTokens,
    emit,
    controller,
    timeout
  }) {
    let streamedText = '';
    let finalCompletionEvent = null;
    let finalMessageContent = '';
    let doneEventEmitted = false;
    const streamReasoningDetails = [];
    const streamId = `chatcmpl-${typeof randomUUID === 'function' ? randomUUID() : `${Date.now()}`}`;

    const emitMappedChunk = async (chunk) => {
      await emit({ type: 'chunk', chunk });
    };

    const emitDone = async (reason) => {
      if (doneEventEmitted) {
        return;
      }

      doneEventEmitted = true;
      await emitMappedChunk(buildMappedChunk({
        id: streamId,
        model,
        response: '',
        done: true,
        doneReason: reason || 'stop'
      }));
    };

    try {
      const stream = await openaiClient.chat.completions.create(
        buildOpenaiCompatibleRequestOptions({
          model,
          messages: buildMessages({
            prompt,
            systemPrompt: runtimeSystemPrompt !== undefined ? runtimeSystemPrompt : systemPrompt,
            userContent
          }),
          stream: true,
          max_completion_tokens: maxTokens,
          temperature: 0.15
        }),
        {
          signal: controller.signal
        }
      );

      for await (const eventData of stream) {
        finalCompletionEvent = eventData;
        const choice = eventData?.choices?.[0] || {};
        const token = choice?.delta?.content || '';
        const deltaKeys = choice?.delta && typeof choice.delta === 'object' ? Object.keys(choice.delta) : [];
        const previousDoneState = doneEventEmitted;

        if (typeof choice?.message?.content === 'string' && choice.message.content.length > 0) {
          finalMessageContent = choice.message.content;
        }

        if (token) {
          streamedText += token;
          await emitMappedChunk(buildMappedChunk({
            id: streamId,
            model,
            response: token,
            done: false
          }));
        }

        if (Array.isArray(choice?.delta?.reasoning_details) && choice.delta.reasoning_details.length > 0) {
          streamReasoningDetails.push(...choice.delta.reasoning_details);
        }

        if (choice?.finish_reason) {
          await emitDone(choice.finish_reason);
        }

        logMinimaxDebug({
          event: 'openai_compatible_stream_event',
          model,
          stream: true,
          deltaKeys,
          deltaContentLength: safeStringLength(token),
          finishReason: choice?.finish_reason || null,
          finishReasonTransitioned: !previousDoneState && doneEventEmitted,
          accumulatedOutputLength: streamedText.length
        });
      }

      const extracted = extractCompletionArtifacts({
        completion: finalCompletionEvent,
        streamAccumulation: streamedText || finalMessageContent || '',
        streamReasoningDetails
      });
      const finalResponseText = extracted.response;

      const finalChoice = finalCompletionEvent?.choices?.[0] || {};
      const finalReasoningDetails = extracted.reasoning.details;

      logMinimaxDebug({
        event: 'openai_compatible_stream_final',
        model,
        stream: true,
        finishReason: finalChoice?.finish_reason || null,
        usage: finalCompletionEvent?.usage || null,
        contentType: Array.isArray(finalResponseText) ? 'array' : typeof finalResponseText,
        contentLength: safeStringLength(finalResponseText),
        reasoningDetailsCount: finalReasoningDetails.length
      });

      if (!streamedText && finalResponseText && !doneEventEmitted) {
        await emitMappedChunk(buildMappedChunk({
          id: streamId,
          model,
          response: finalResponseText,
          done: false
        }));
      }

      await emitDone('stop');
      await emit({
        type: 'final',
        response: finalResponseText,
        usage: extracted.usage,
        completion: finalCompletionEvent || null
      });

      return {
        ok: true,
        data: {
          response: finalResponseText,
          usage: extracted.usage,
          completion: finalCompletionEvent || null,
          reasoning: extracted.reasoning
        }
      };
    } catch (err) {
      if (typeof err?.status === 'number') {
        return {
          ok: false,
          error: mapError(new Error('request_failed'), { kind: 'http', status: err.status })
        };
      }

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
      minimaxApiStyle: resolvedApiStyle,
      minimaxOpenaiBaseUrl: resolvedOpenaiBaseUrl,
      minimaxModel: model,
      minimaxApiKeySet: Boolean(resolvedApiKey),
      minimaxSystemPrompt: systemPrompt || null,
      minimaxUserTemplate: userTemplate || null,
      minimaxMaxCompletionTokens: resolvedMaxCompletionTokens
    })
  };
}

function buildMappedChunk({ id, model, response, done, doneReason }) {
  return {
    ...(id ? { id } : {}),
    object: 'chat.completion.chunk',
    created_at: new Date().toISOString(),
    ...(model ? { model } : {}),
    response,
    done,
    ...(done ? { done_reason: doneReason || 'stop' } : {})
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
      chunk: buildMappedChunk({ response: '', done: true, doneReason: finishReason })
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

module.exports = {
  createMinimaxProvider,
  parseMinimaxSseFrame,
  buildMappedChunk,
  buildMessages,
  renderUserContent
};
