const test = require('node:test');
const assert = require('node:assert/strict');

const { createMinimaxProvider, parseMinimaxSseFrame } = require('../../providers/minimax');

function createSseStream(frames) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      }
      controller.close();
    }
  });
}

function createAnthropicSseStream(events) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const entry of events) {
        controller.enqueue(encoder.encode(
          `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`
        ));
      }
      controller.close();
    }
  });
}

test('parses normal delta chunk into canonical response chunk', () => {
  const payload = JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ delta: { content: '你好' }, finish_reason: null }]
  });

  const parsed = parseMinimaxSseFrame(payload);

  assert.ok(parsed);
  assert.equal(parsed.chunk.response, '你好');
  assert.equal(parsed.chunk.done, false);
  assert.equal(parsed.chunk.object, 'chat.completion.chunk');
});

test('handles empty delta without emitting chunk', () => {
  const payload = JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ delta: { content: '' }, finish_reason: null }]
  });

  const parsed = parseMinimaxSseFrame(payload);

  assert.ok(parsed);
  assert.equal(parsed.chunk, null);
});

test('keeps final message content for fallback when delta is missing', () => {
  const payload = JSON.stringify({
    object: 'chat.completion',
    choices: [{ message: { content: '最終內容' }, finish_reason: 'stop' }]
  });

  const parsed = parseMinimaxSseFrame(payload);

  assert.ok(parsed);
  assert.equal(parsed.finalMessageContent, '最終內容');
  assert.equal(parsed.chunk.done, true);
  assert.equal(parsed.chunk.done_reason, 'stop');
});

test('returns null for malformed JSON frame', () => {
  const parsed = parseMinimaxSseFrame('{"choices":[{"delta":{"content":"x"}}]');
  assert.equal(parsed, null);
});

test('rewriteStream emits normalized text + done events for completion-only frame', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(createSseStream([
    JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ finish_reason: 'stop', message: { content: '最終內容' } }]
    })
  ]), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key'
  });

  const events = [];
  const result = await provider.rewriteStream({
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async (event) => {
      events.push(event);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.response, '最終內容');

  const textEvents = events.filter((event) => event.type === 'text');
  const doneEvents = events.filter((event) => event.type === 'done');
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0].text, '最終內容');
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].reason, 'stop');
});


test('rewrite serializes system and user messages when system prompt is configured', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ reply: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    systemPrompt: '你是改寫助手'
  });

  const result = await provider.rewrite({
    prompt: 'legacy prompt',
    userContent: '把下方文字改寫為繁體書面語：\n你今日得唔得閒？',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.deepEqual(capturedBody.messages, [
    { role: 'system', content: '你是改寫助手' },
    { role: 'user', content: '把下方文字改寫為繁體書面語：\n你今日得唔得閒？' }
  ]);
});

test('rewriteStream falls back to single user message when system prompt is missing', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(createSseStream(['[DONE]']), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    systemPrompt: ''
  });

  const events = [];
  const result = await provider.rewriteStream({
    prompt: '把下方文字改寫為繁體書面語：\n測試內容',
    timeoutMs: 5_000,
    onChunk: async (event) => {
      events.push(event);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.doneReason, 'stop');
  assert.deepEqual(capturedBody.messages, [
    { role: 'user', content: '把下方文字改寫為繁體書面語：\n測試內容' }
  ]);

  const doneEvents = events.filter((event) => event.type === 'done');
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].reason, 'stop');
});


test('rewrite uses configured max_completion_tokens', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ reply: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    maxCompletionTokens: 512
  });

  const result = await provider.rewrite({
    prompt: 'test',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(capturedBody.max_completion_tokens, 512);
});

test('rewriteStream uses configured max_completion_tokens', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(createSseStream(['[DONE]']), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    maxCompletionTokens: 640
  });

  const result = await provider.rewriteStream({
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(capturedBody.max_completion_tokens, 640);
});

test('legacy rewrite request remains on the existing HTTP payload', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ reply: '正式內容' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'M2-her',
    apiFormat: 'legacy-chat',
    apiKey: 'test-key'
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(capturedBody, 'thinking'), false);
});

test('legacy rewrite treats non-zero base_resp status as a controlled provider failure', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(JSON.stringify({
    base_resp: { status_code: 1004, status_msg: 'invalid request' }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'M2-her',
    apiFormat: 'legacy-chat',
    apiKey: 'test-key'
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.equal(result.error.status, 502);
});

test('anthropic rewrite uses the SDK base URL, disables thinking, and returns text blocks only', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedUrl = null;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'MiniMax-M3',
      content: [
        { type: 'thinking', thinking: 'hidden reasoning', signature: 'sig' },
        { type: 'text', text: '正式書面語' }
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 7 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key',
    systemPrompt: '你是改寫助手'
  });

  const result = await provider.rewrite({
    prompt: 'legacy',
    userContent: '原文',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.response, '正式書面語');
  assert.deepEqual(result.data.usage, { input_tokens: 8, output_tokens: 7 });
  assert.equal(result.data.doneReason, 'end_turn');
  assert.equal(capturedUrl, 'http://minimax.test/anthropic/v1/messages');
  assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
  assert.equal(capturedBody.stream, false);
  assert.equal(capturedBody.max_tokens, 300);
  assert.equal(capturedBody.system, '你是改寫助手');
  assert.deepEqual(capturedBody.messages, [
    { role: 'user', content: [{ type: 'text', text: '原文' }] }
  ]);
  assert.equal(provider.getInfo().minimaxApiFormat, 'anthropic');
  assert.equal(provider.getInfo().minimaxAnthropicBaseUrl, 'http://minimax.test/anthropic');
});

test('anthropic streaming emits text deltas, ignores thinking, and preserves usage', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedUrl = null;
  let capturedBody = null;
  const debugEvents = [];
  global.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(options.body);
    return new Response(createAnthropicSseStream([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg-stream',
            type: 'message',
            role: 'assistant',
            model: 'MiniMax-M3',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 0 }
          }
        }
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hidden reasoning' }
        }
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: '正式' }
        }
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: '書面語' }
        }
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 6 }
        }
      },
      { event: 'message_stop', data: { type: 'message_stop' } }
    ]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req-stream' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key',
    debugLog: (event) => debugEvents.push(event)
  });

  const events = [];
  const result = await provider.rewriteStream({
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async (event) => events.push(event)
  });

  assert.equal(result.ok, true);
  assert.equal(capturedUrl, 'http://minimax.test/anthropic/v1/messages');
  assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
  assert.equal(capturedBody.stream, true);
  assert.deepEqual(
    events.filter((event) => event.type === 'text').map((event) => event.text),
    ['正式', '書面語']
  );
  assert.equal(events.some((event) => JSON.stringify(event).includes('hidden reasoning')), false);
  assert.deepEqual(events.find((event) => event.type === 'done')?.usage, {
    input_tokens: 9,
    output_tokens: 6
  });
  assert.equal(events.find((event) => event.type === 'done')?.reason, 'end_turn');
  assert.equal(result.data.response, '正式書面語');
  assert.equal(debugEvents.some((event) => event.eventType === 'provider_reasoning_ignored'), true);
});

test('anthropic rewrite maps authentication failures to the existing provider auth error', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(JSON.stringify({
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid API key' }
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key'
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_AUTH_ERROR');
  assert.equal(result.error.message, 'Provider authentication failed');
  assert.equal(result.error.status, 502);
});

test('anthropic rewrite maps empty text blocks to controlled provider error', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(JSON.stringify({
    id: 'msg-empty',
    type: 'message',
    role: 'assistant',
    model: 'MiniMax-M3',
    content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key'
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.equal(result.error.message, 'Provider response did not include rewrite content');
  assert.equal(result.error.status, 502);
});

test('anthropic rewrite maps an aborted SDK request to model timeout', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(options.signal.reason || new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key'
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_TIMEOUT');
  assert.equal(result.error.status, 504);
});

test('anthropic malformed stream maps to invalid provider response', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const encoder = new TextEncoder();
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: content_block_delta\ndata: {invalid-json}\n\n'
      ));
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key'
  });

  const events = [];
  const result = await provider.rewriteStream({
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async (event) => events.push(event)
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.equal(result.error.message, 'Invalid provider response');
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
});

test('anthropic stream ending without message_stop fails instead of returning partial text', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(createAnthropicSseStream([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg-truncated',
          type: 'message',
          role: 'assistant',
          model: 'MiniMax-M3',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 0 }
        }
      }
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '部分內容' }
      }
    }
  ]), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://legacy-minimax.test/v1/text/chatcompletion_v2',
    anthropicBaseUrl: 'http://minimax.test/anthropic',
    model: 'MiniMax-M3',
    apiFormat: 'anthropic',
    apiKey: 'test-key'
  });

  const events = [];
  const result = await provider.rewriteStream({
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async (event) => events.push(event)
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.equal(events.filter((event) => event.type === 'text').length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.filter((event) => event.type === 'done').length, 0);
});

test('rewrite returns usage metadata when provider includes usage', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(
    JSON.stringify({ reply: 'ok', usage: { total_tokens: 12, prompt_tokens: 7, completion_tokens: 5 } }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key'
  });

  const result = await provider.rewrite({ prompt: 'test', timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.usage, { total_tokens: 12, prompt_tokens: 7, completion_tokens: 5 });
});


test('rewrite emits provider_response_raw debug event with parsed JSON response', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const debugEvents = [];
  global.fetch = async () => new Response(JSON.stringify({ reply: '正式書面語', usage: { total_tokens: 9 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    debugLog: (event) => {
      debugEvents.push(event);
    }
  });

  const result = await provider.rewrite({
    requestId: 'req-rewrite-raw',
    prompt: 'test',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);

  const rawEvent = debugEvents.find((event) => event.eventType === 'provider_response_raw');
  assert.ok(rawEvent);
  assert.equal(rawEvent.stream, false);
  assert.equal(rawEvent.requestId, 'req-rewrite-raw');
  assert.deepEqual(rawEvent.payload?.response, { reply: '正式書面語', usage: { total_tokens: 9 } });
});

test('rewriteStream emits provider_response_raw debug event with final completion payload', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const completionEvent = {
    object: 'chat.completion',
    choices: [{ finish_reason: 'stop', message: { content: '串流完成內容' } }],
    usage: { total_tokens: 11 }
  };

  const debugEvents = [];
  global.fetch = async () => new Response(createSseStream([
    JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: { content: '串流' } }] }),
    JSON.stringify(completionEvent)
  ]), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    debugLog: (event) => {
      debugEvents.push(event);
    }
  });

  const result = await provider.rewriteStream({
    requestId: 'req-stream-raw',
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async () => {}
  });

  assert.equal(result.ok, true);

  const rawEvent = debugEvents.find((event) => event.eventType === 'provider_response_raw');
  assert.ok(rawEvent);
  assert.equal(rawEvent.stream, true);
  assert.equal(rawEvent.requestId, 'req-stream-raw');
  assert.deepEqual(rawEvent.payload?.completion, completionEvent);
});

test('checkReadiness uses lightweight probe payload without rewrite prompts', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ reply: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    systemPrompt: '你是改寫助手',
    userTemplate: '把下方文字改寫為繁體書面語：\n{TEXT}'
  });

  const result = await provider.checkReadiness({ timeoutMs: 5_000 });

  assert.equal(result.ready, true);
  assert.equal(capturedBody.max_completion_tokens, 1);
  assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'ping' }]);
  assert.equal(JSON.stringify(capturedBody.messages).includes('你是改寫助手'), false);
  assert.equal(JSON.stringify(capturedBody.messages).includes('把下方文字改寫為繁體書面語'), false);
});

test('triggerWarmup is a no-op success and does not send rewrite prompt payload', async () => {
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ reply: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const provider = createMinimaxProvider({
      apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
      model: 'MiniMax-Text-01',
      apiKey: 'test-key',
      systemPrompt: '你是改寫助手',
      userTemplate: '把下方文字改寫為繁體書面語：\n{TEXT}'
    });

    const result = await provider.triggerWarmup({ timeoutMs: 5_000 });

    assert.deepEqual(result, {
      ok: true,
      data: {
        output: { text: '', artifacts: [], meta: {} },
        response: ''
      }
    });
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});


test('exposes rewrite service handlers for generic adapter dispatch', () => {
  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key'
  });

  assert.equal(typeof provider.services?.rewrite?.sync, 'function');
  assert.equal(typeof provider.services?.rewrite?.stream, 'function');
});


test('t2a sends smoke-script-compatible payload and normalizes audio success result', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const expectedBuffer = Buffer.from('MiniMax mp3 audio payload '.repeat(4));
  const expectedHex = expectedBuffer.toString('hex');
  let capturedHeaders = null;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);

    return new Response(JSON.stringify({
      trace_id: 'trace-123',
      base_resp: { status_code: 0, status_msg: 'success' },
      extra_info: { request_id: 'provider-req-1' },
      data: {
        audio: expectedHex,
        format: 'mp3',
        audio_length: 2048,
        subtitles: [{ text: '你好', start_ms: 0, end_ms: 500 }]
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    requestId: 'req-t2a-success',
    text: '你好，歡迎使用',
    voice: {
      voiceId: 'Cantonese_ProfessionalHost（F)',
      speed: 1.2,
      volume: 3,
      pitch: -1
    },
    audio: {
      sampleRate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1
    },
    languageBoost: 'Chinese,Yue',
    voiceModify: { pitch: 0, intensity: 0, timbre: 0 },
    outputFormat: 'hex',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(capturedHeaders.Authorization, 'Bearer test-key');
  assert.deepEqual(capturedBody, {
    model: 'speech-2.6-hd',
    text: '你好，歡迎使用',
    stream: false,
    voice_setting: {
      voice_id: 'Cantonese_ProfessionalHost（F)',
      speed: 1.2,
      vol: 3,
      pitch: -1
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1
    },
    language_boost: 'Chinese,Yue',
    voice_modify: {
      pitch: 0,
      intensity: 0,
      timbre: 0
    },
    output_format: 'hex'
  });
  assert.equal(result.data.response, '');
  assert.equal(result.data.output.text, '');
  assert.equal(result.data.output.meta.format, 'mp3');
  assert.equal(result.data.output.meta.mime, 'audio/mpeg');
  assert.equal(result.data.output.meta.contentType, 'audio/mpeg');
  assert.deepEqual(result.data.output.meta.audio, expectedBuffer);
  assert.deepEqual(result.data.output.artifacts[0].data, expectedBuffer);
  assert.equal(result.data.output.artifacts[0].mime, 'audio/mpeg');
  assert.equal(result.data.output.artifacts[0].format, 'mp3');
  assert.equal(result.data.output.meta.provider.traceId, 'trace-123');
  assert.equal(result.data.output.meta.provider.audioLength, 2048);
  assert.deepEqual(result.data.output.meta.provider.subtitles, [{ text: '你好', start_ms: 0, end_ms: 500 }]);
  assert.equal(result.data.output.meta.provider.sourcePath, 'data.audio');
});

test('t2a prefers direct candidate fields before deep fallback when multiple audio payloads exist', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const directBuffer = Buffer.from('direct candidate payload '.repeat(4));
  const deepBuffer = Buffer.from('deep fallback payload that should not win '.repeat(3));

  global.fetch = async () => new Response(JSON.stringify({
    data: {
      audio_hex: directBuffer.toString('hex'),
      nested: {
        audio: deepBuffer.toString('hex')
      }
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    text: '測試',
    voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
    audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.output.meta.audio, directBuffer);
  assert.equal(result.data.output.meta.provider.sourcePath, 'data.audio_hex');
});

test('t2a smoke-script-compatible response variants decode to the same normalized audio result', async (t) => {
  const variants = [
    { audio: null, data: { audio: Buffer.from('variant-one '.repeat(6)).toString('hex') } },
    { data: { audio_hex: Buffer.from('variant-one '.repeat(6)).toString('hex') } },
    { data: { wrapper: { payload: Buffer.from('variant-one '.repeat(6)).toString('hex') } } }
  ];

  for (const variant of variants) {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify(variant), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    try {
      const provider = createMinimaxProvider({
        apiUrl: 'http://minimax.test/v1/t2a_v2',
        model: 'speech-2.6-hd',
        apiKey: 'test-key'
      });

      const result = await provider.t2a({
        text: '同一結果',
        voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
        audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
        timeoutMs: 5_000
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data.output.meta.audio, Buffer.from('variant-one '.repeat(6)));
      assert.equal(result.data.output.meta.format, 'mp3');
      assert.equal(result.data.output.meta.contentType, 'audio/mpeg');
    } finally {
      global.fetch = originalFetch;
    }
  }
});

test('t2a maps auth failures to provider auth error', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(JSON.stringify({ message: 'forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    text: '測試',
    voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
    audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
    timeoutMs: 5_000
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'PROVIDER_AUTH_ERROR',
      message: 'Provider authentication failed',
      status: 502
    }
  });
});

test('t2a maps invalid JSON responses to provider failure', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response('not-json', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    text: '測試',
    voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
    audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
    timeoutMs: 5_000
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'PROVIDER_ERROR',
      message: 'Invalid provider response',
      status: 502
    }
  });
});

test('t2a returns provider failure when audio payload is missing', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(JSON.stringify({ data: { message: 'no audio here' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    text: '測試',
    voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
    audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
    timeoutMs: 5_000
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'PROVIDER_ERROR',
      message: 'Provider response did not include audio data',
      status: 502
    }
  });
});

test('t2a maps aborted fetch to timeout failure', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (_url, options) => {
    options.signal.throwIfAborted();
    throw new DOMException('The operation was aborted.', 'AbortError');
  };

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    text: '測試',
    voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
    audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
    timeoutMs: 1
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'MODEL_TIMEOUT',
      message: 'Model response timed out. Please retry.',
      status: 504
    }
  });
});

test('t2a maps unexpected schema drift when provider returns non-object JSON', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(JSON.stringify('schema-drift'), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/t2a_v2',
    model: 'speech-2.6-hd',
    apiKey: 'test-key'
  });

  const result = await provider.t2a({
    text: '測試',
    voice: { voiceId: 'voice', speed: 1, volume: 1, pitch: 0 },
    audio: { sampleRate: 32000, bitrate: 128000, format: 'mp3' },
    timeoutMs: 5_000
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'PROVIDER_ERROR',
      message: 'Provider response schema changed unexpectedly',
      status: 502
    }
  });
});
