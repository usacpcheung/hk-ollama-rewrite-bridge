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


test('regression: legacy-routing bug - rewrite(legacy) sends expected payload to legacy endpoint and extracts response', async (t) => {
  let legacyRequestBody = null;
  const legacyServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      legacyRequestBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '正式中文結果' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
      }));
    });
  });
  await new Promise((resolve) => legacyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => legacyServer.close());

  const legacyAddress = legacyServer.address();
  const provider = createMinimaxProvider({
    apiUrl: `http://127.0.0.1:${legacyAddress.port}/v1/text/chatcompletion_v2`,
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    apiStyle: 'legacy',
    systemPrompt: '你是改寫助手'
  });

  const result = await provider.rewrite({
    prompt: '原文提示',
    userContent: '原文：我聽日請假',
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.response, '正式中文結果');
  assert.deepEqual(result.data.usage, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
  assert.equal(result.data.reasoning.splitRequested, false);
  assert.equal(result.data.reasoning.splitAvailable, false);

  assert.equal(legacyRequestBody.model, 'MiniMax-Text-01');
  assert.equal(legacyRequestBody.max_completion_tokens, 5000);
  assert.equal('extra_body' in legacyRequestBody, false);
  assert.deepEqual(legacyRequestBody.messages, [
    { role: 'system', content: '你是改寫助手' },
    { role: 'user', content: '原文：我聽日請假' }
  ]);
});

test('matrix: rewriteStream(legacy) preserves SSE parsing and done-chunk behavior', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => new Response(createSseStream([
    JSON.stringify({ choices: [{ delta: { content: '正' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: '式' }, finish_reason: null }] }),
    JSON.stringify({ object: 'chat.completion', choices: [{ message: { content: '正式' }, finish_reason: 'stop' }] }),
    '[DONE]'
  ]), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  const provider = createMinimaxProvider({
    apiUrl: 'http://minimax.test/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    apiStyle: 'legacy'
  });

  const events = [];
  const result = await provider.rewriteStream({
    prompt: 'test',
    timeoutMs: 5_000,
    onChunk: async (event) => events.push(event)
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.response, '正式');

  const chunkEvents = events.filter((event) => event.type === 'chunk');
  assert.equal(chunkEvents.length, 3);
  assert.equal(chunkEvents[0].chunk.response, '正');
  assert.equal(chunkEvents[1].chunk.response, '式');
  assert.equal(chunkEvents[2].chunk.done, true);
});

test('matrix: openai_compatible sync + stream continue to use OpenAI-compatible endpoint', async (t) => {
  const requestBodies = [];
  const openaiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      requestBodies.push(parsed);

      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '書', reasoning_details: [{ type: 'reasoning.summary', text: '流式推理1' }] }, finish_reason: null }] })}

`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '書面', reasoning_details: [{ type: 'reasoning.summary', text: '流式推理2' }] }, finish_reason: null }] })}

`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}

`);
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-openai-sync',
        choices: [{
          message: {
            content: [
              { type: 'text', text: '<think>中間推理</think>' },
              { type: 'text', text: '書面中文' }
            ],
            reasoning_details: [{ type: 'reasoning.summary', text: '中間推理' }]
          }
        }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
      }));
    });
  });
  await new Promise((resolve) => openaiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => openaiServer.close());

  const openaiAddress = openaiServer.address();
  const provider = createMinimaxProvider({
    apiUrl: 'http://127.0.0.1:9/v1/text/chatcompletion_v2',
    openaiBaseUrl: `http://127.0.0.1:${openaiAddress.port}`,
    model: 'MiniMax-Text-01',
    apiKey: 'test-key',
    apiStyle: 'openai_compatible'
  });

  const syncResult = await provider.rewrite({
    prompt: 'sync prompt',
    timeoutMs: 5_000
  });
  assert.equal(syncResult.ok, true);
  assert.equal(syncResult.data.response, '書面中文');
  assert.equal(syncResult.data.reasoning.splitRequested, true);
  assert.equal(syncResult.data.reasoning.splitAvailable, true);
  assert.equal(syncResult.data.reasoning.detailsCount, 1);
  assert.equal(syncResult.data.reasoning.thinkSegmentsStripped, true);

  const streamEvents = [];
  const streamResult = await provider.rewriteStream({
    prompt: 'stream prompt',
    timeoutMs: 5_000,
    onChunk: async (event) => streamEvents.push(event)
  });
  assert.equal(streamResult.ok, true);
  assert.equal(streamResult.data.response, '書面');
  assert.equal(streamResult.data.reasoning.splitRequested, true);
  assert.equal(streamResult.data.reasoning.splitAvailable, true);
  assert.equal(streamResult.data.reasoning.detailsCount, 2);

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].stream, false);
  assert.equal(requestBodies[1].stream, true);
  assert.deepEqual(requestBodies[0].extra_body, { reasoning_split: true });
  assert.deepEqual(requestBodies[1].extra_body, { reasoning_split: true });

  const streamChunkEvents = streamEvents.filter((event) => event.type === 'chunk');
  assert.equal(streamChunkEvents.length, 3);
  assert.equal(streamChunkEvents[0].chunk.response, '書');
  assert.equal(streamChunkEvents[1].chunk.response, '面');
  assert.equal(streamChunkEvents[2].chunk.done, true);
});
