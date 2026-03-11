const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

test('rewriteStream does not emit fallback non-done chunk after done chunk', async (t) => {
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

  const chunkEvents = events.filter((event) => event.type === 'chunk');
  assert.equal(chunkEvents.length, 1);
  assert.equal(chunkEvents[0].chunk.done, true);
  assert.equal(chunkEvents[0].chunk.response, '');
  assert.equal(chunkEvents.find((event) => event.chunk.done === false), undefined);
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
    userContent: '原文：你今日得唔得閒？',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.deepEqual(capturedBody.messages, [
    { role: 'system', content: '你是改寫助手' },
    { role: 'user', content: '原文：你今日得唔得閒？' }
  ]);
  assert.equal(capturedBody.max_completion_tokens, 5000);
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

  const result = await provider.rewriteStream({
    prompt: '原文：測試內容',
    timeoutMs: 5_000,
    onChunk: async () => {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(capturedBody.messages, [
    { role: 'user', content: '原文：測試內容' }
  ]);
});


test('rewrite honors custom maxCompletionTokens override', async (t) => {
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
    maxCompletionTokens: 1234
  });

  const result = await provider.rewrite({
    prompt: 'legacy prompt',
    userContent: '原文：測試內容',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(capturedBody.max_completion_tokens, 1234);
});

test('rewrite uses fetch transport and not OpenAI client when apiStyle is legacy', async (t) => {
  let legacyCalls = 0;
  const legacyServer = http.createServer((req, res) => {
    legacyCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: 'legacy-ok' }));
  });
  await new Promise((resolve) => legacyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => legacyServer.close());

  let openaiCalls = 0;
  const openaiServer = http.createServer((req, res) => {
    openaiCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'openai-path' } }] }));
  });
  await new Promise((resolve) => openaiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => openaiServer.close());

  const legacyAddress = legacyServer.address();
  const openaiAddress = openaiServer.address();

  const provider = createMinimaxProvider({
    apiUrl: `http://127.0.0.1:${legacyAddress.port}/v1/text/chatcompletion_v2`,
    openaiBaseUrl: `http://127.0.0.1:${openaiAddress.port}`,
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    apiStyle: 'legacy'
  });

  const result = await provider.rewrite({
    prompt: 'legacy prompt',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.response, 'legacy-ok');
  assert.equal(legacyCalls, 1);
  assert.equal(openaiCalls, 0);
});

test('rewrite uses OpenAI client path when apiStyle is openai_compatible', async (t) => {
  let legacyCalls = 0;
  const legacyServer = http.createServer((req, res) => {
    legacyCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: 'legacy-path' }));
  });
  await new Promise((resolve) => legacyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => legacyServer.close());

  let openaiCalls = 0;
  const openaiServer = http.createServer((req, res) => {
    openaiCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-123',
      choices: [{ message: { content: 'openai-ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
  await new Promise((resolve) => openaiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => openaiServer.close());

  const legacyAddress = legacyServer.address();
  const openaiAddress = openaiServer.address();

  const provider = createMinimaxProvider({
    apiUrl: `http://127.0.0.1:${legacyAddress.port}/v1/text/chatcompletion_v2`,
    openaiBaseUrl: `http://127.0.0.1:${openaiAddress.port}`,
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    apiStyle: 'openai_compatible'
  });

  const result = await provider.rewrite({
    prompt: 'openai prompt',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.response, 'openai-ok');
  assert.equal(openaiCalls, 1);
  assert.equal(legacyCalls, 0);
});
