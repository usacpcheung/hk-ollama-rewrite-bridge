const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleGeminiProvider } = require('../providers/google-gemini');
const request = { text: '我唔明', instructions: 'Keep the meaning.', outputBudget: 300, timeoutMs: 1000 };
const payload = (text = '我不明白', finishReason = 'STOP', extra = {}) => ({ candidates: [{ index: 0, content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }], ...extra });
const provider = fetchImpl => createGoogleGeminiProvider({ project: 'test-project', getAccessToken: async () => 'synthetic-token', fetchImpl });
const sync = (body, status = 200) => provider(async () => new Response(JSON.stringify(body), { status })).services.rewrite.sync(request);
const stream = async (records, { split = false, close = true } = {}) => {
  const events = [];
  let cancelled = false;
  const bytes = Buffer.from(records);
  const p = provider(async () => new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    if (close) controller.close();
  }, cancel() { cancelled = true; } })));
  const result = await p.services.rewrite.stream({ ...request, onChunk: async event => { await Promise.resolve(); events.push(event); } });
  return { result, events, cancelled };
};
const frame = body => `data: ${JSON.stringify(body)}\r\n\r\n`;

test('Gemini sends neutral instructions/input to Vertex and normalizes usage', async () => {
  let call;
  const p = provider(async (...args) => { call = args; return new Response(JSON.stringify(payload('文字', 'STOP', { usageMetadata: { promptTokenCount: 5, totalTokenCount: 9, private: 'secret' } }))); });
  const result = await p.services.rewrite.sync(request);
  assert.equal(result.data.response, '文字');
  assert.deepEqual(result.data.usage, { promptTokenCount: 5, totalTokenCount: 9 });
  assert.match(call[0], /locations\/global\/publishers\/google\/models\/gemini-3.8-flash:generateContent$/);
  const body = JSON.parse(call[1].body);
  assert.equal(body.systemInstruction.parts[0].text, request.instructions);
  assert.equal(body.contents[0].parts[0].text, '把下方文字改寫為繁體書面語：\n' + request.text);
  assert.equal(body.generationConfig.temperature, 0.15);
  assert.equal(body.generationConfig.maxOutputTokens, 300);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(call[1].redirect, 'error');
});

test('Gemini excludes reasoning and never succeeds with reasoning only', async () => {
  const body = payload(); body.candidates[0].content.parts.unshift({ thought: true, text: 'private reasoning' });
  assert.equal((await sync(body)).data.response, '我不明白');
  body.candidates[0].content.parts.pop();
  assert.equal((await sync(body)).ok, false);
});

for (const [name, body, code] of [
  ['truncation', payload('partial', 'MAX_TOKENS'), 'GEMINI_OUTPUT_TRUNCATED'],
  ['safety', payload('', 'SAFETY'), 'GEMINI_CONTENT_BLOCKED'],
  ['prompt block', { promptFeedback: { blockReason: 'SAFETY' } }, 'GEMINI_CONTENT_BLOCKED'],
  ['empty', payload(' '), 'GEMINI_INVALID_RESPONSE'],
  ['missing terminal', payload('partial', null), 'GEMINI_INVALID_RESPONSE'],
  ['malformed', { candidates: 'bad' }, 'GEMINI_INVALID_RESPONSE'],
  ['native error', { error: { message: 'secret' } }, 'GEMINI_INVALID_RESPONSE']
]) test(`Gemini rejects ${name}`, async () => { const r = await sync(body); assert.equal(r.error.code, code); assert.ok(!JSON.stringify(r).includes('secret')); });
for (const [status, expected] of [[401,503],[403,503],[429,429],[500,502],[404,502]]) {
  test(`Gemini HTTP ${status} is sanitized and never retried`, async () => {
    let calls = 0;
    const r = await provider(async () => { calls++; return new Response('secret provider details', { status }); }).services.rewrite.sync(request);
    assert.equal(r.error.status, expected); assert.equal(calls, 1); assert.ok(!JSON.stringify(r).includes('secret'));
  });
}

test('Gemini SSE handles byte-split UTF8/CRLF, backpressure and stops before EOF', async () => {
  const r = await stream(': comment\r\n\r\n' + frame(payload('中文', null)) + frame(payload('。', 'STOP', { usageMetadata: { totalTokenCount: 8 } })) + frame(payload('ignored')), { split: true, close: false });
  assert.equal(r.result.data.response, '中文。');
  assert.deepEqual(r.events.map(x => x.type), ['text', 'text', 'done']);
  assert.equal(r.events[2].usage.totalTokenCount, 8); assert.equal(r.cancelled, true);
});
for (const [name, data] of [['missing terminal', frame(payload('partial', null))], ['malformed JSON', 'data: {bad}\n\n'], ['truncated', frame(payload('partial', 'MAX_TOKENS'))], ['oversized', 'data: ' + 'x'.repeat(1024*1024)]]) {
  test(`Gemini stream rejects ${name} without done`, async () => {
    const r = await stream(data); assert.equal(r.result.ok, false); assert.ok(!r.events.some(e => e.type === 'done'));
  });
}

test('Gemini concurrent auth is coalesced; cancelled waiters cannot dispatch inference', async () => {
  let resolve; let authCalls = 0; let fetchCalls = 0;
  const auth = new Promise(r => { resolve = r; });
  const p = createGoogleGeminiProvider({ project: 'test-project', getAccessToken: () => { authCalls++; return auth; }, fetchImpl: async () => { fetchCalls++; return new Response(JSON.stringify(payload())); } });
  const results = await Promise.all(Array.from({ length: 8 }, () => p.services.rewrite.sync({ ...request, timeoutMs: 10 })));
  assert.ok(results.every(r => r.error.code === 'MODEL_TIMEOUT')); assert.equal(authCalls, 1); assert.equal(fetchCalls, 0);
  resolve('token'); await new Promise(r => setImmediate(r));
  assert.equal(fetchCalls, 0);
  assert.equal((await p.services.rewrite.sync(request)).ok, true);
});

test('Gemini auth failure is sanitized and later requests recover', async () => {
  let attempts = 0;
  const p = createGoogleGeminiProvider({ project: 'test-project', getAccessToken: async () => { if (++attempts === 1) throw Error('private-key-details'); return 'token'; }, fetchImpl: async () => new Response(JSON.stringify(payload())) });
  const first = await p.services.rewrite.sync(request);
  assert.equal(first.error.code, 'GEMINI_AUTH_ERROR'); assert.ok(!JSON.stringify(first).includes('private-key'));
  assert.equal((await p.services.rewrite.sync(request)).ok, true);
});

test('Gemini slow fetch is aborted and pre-cancelled requests do no work', async () => {
  let calls = 0;
  const p = provider(async (_url, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  assert.equal((await p.services.rewrite.sync({ ...request, timeoutMs: 10 })).error.code, 'MODEL_TIMEOUT');
  assert.equal((await p.services.rewrite.sync({ ...request, signal: AbortSignal.abort() })).error.code, 'MODEL_TIMEOUT');
  assert.equal(calls, 1);
});

test('Gemini validates endpoint components before credentials/network', () => {
  for (const config of [{}, { project: 'test-project', location: '../other' }, { project: 'test-project', model: 'gemini-x?key=bad' }]) assert.throws(() => createGoogleGeminiProvider(config));
});

test('Gemini rejects SDK logging when selected and accepts a regional endpoint', async () => {
  assert.throws(() => createGoogleGeminiProvider({ project: 'test-project', sdkLogging: 'false' }), /GOOGLE_SDK_NODE_LOGGING/);
  let url;
  const p = createGoogleGeminiProvider({ project: 'test-project', location: 'asia-east1', getAccessToken: async () => 'token', fetchImpl: async value => { url = value; return new Response(JSON.stringify(payload())); } });
  assert.equal((await p.services.rewrite.sync(request)).ok, true);
  assert.match(url, /^https:\/\/asia-east1-aiplatform.googleapis.com\/v1\/projects\/test-project\/locations\/asia-east1\//);
});

test('Gemini accepts multiline SSE data and excludes thought chunks', async () => {
  const thought = payload('', null); thought.candidates[0].content.parts = [{ thought: true, text: 'secret' }];
  const terminal = JSON.stringify(payload('完成'), null, 2).split('\n').map(line => 'data: ' + line).join('\n') + '\n\n';
  const r = await stream(frame(thought) + terminal);
  assert.equal(r.result.ok, true); assert.equal(r.result.data.response, '完成');
  assert.deepEqual(r.events.map(x => x.type), ['text', 'done']); assert.ok(!JSON.stringify(r).includes('secret'));
});

for (const location of ['us', 'eu', '', ' global', 'global ', 'global/other']) {
  test(`Gemini rejects unsupported location ${JSON.stringify(location)} before authentication`, () => {
    assert.throws(() => createGoogleGeminiProvider({ project: 'test-project', location }), /REWRITE_GOOGLE_LOCATION/);
  });
}
test('Google configuration defaults only absent model/location values', () => {
  const { readConfiguration } = require('../providers/configuration/google-rewrite');
  assert.equal(readConfiguration({ env: {} }).runtime.location, 'global');
  for (const env of [{ REWRITE_GOOGLE_LOCATION: '' }, { REWRITE_GOOGLE_MODEL: '' }]) {
    assert.throws(() => createGoogleGeminiProvider({ ...readConfiguration({ env }).runtime, project: 'test-project' }));
  }
});
for (const streaming of [false, true]) {
  test(`Gemini diagnostic wire profile (streaming=${streaming})`, async () => {
    const { resolveRewritePolicy } = require('../services/rewrite-policies');
    const instructions = resolveRewritePolicy('hk-school-v2').instructions;
    const p = provider(async (url, options) => {
      assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.8-flash:' + (streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'));
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), {
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts: [{ text: '把下方文字改寫為繁體書面語：\n我唔明' }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } }
      });
      return new Response(streaming ? frame(payload()) : JSON.stringify(payload()));
    });
    const r = await p.services.rewrite[streaming ? 'stream' : 'sync']({ ...request, instructions, outputBudget: 4096 });
    assert.equal(r.ok, true);
  });
}
test('Gemini rejects late credential completion even before timer callbacks run', async () => {
  let calls = 0;
  const p = createGoogleGeminiProvider({ project: 'test-project', getAccessToken: async () => {
    const end = performance.now() + 30;
    while (performance.now() < end) {} // Simulate synchronous SDK/event-loop delay.
    return 'token';
  }, fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload())); } });
  assert.equal((await p.services.rewrite.sync({ ...request, timeoutMs: 10 })).error.code, 'MODEL_TIMEOUT');
  assert.equal(calls, 0);
});
for (const streaming of [false, true]) {
  test(`Gemini real fetch stalled body respects deadline (streaming=${streaming})`, async t => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' });
      res.write(streaming ? frame({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }] } }] }) : '{');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const events = [];
    const p = provider((_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options));
    const r = await p.services.rewrite[streaming ? 'stream' : 'sync']({ ...request, timeoutMs: 150, onChunk: event => events.push(event) });
    assert.equal(r.error.code, 'MODEL_TIMEOUT');
    assert.deepEqual(events, []);
  });
}
test('Gemini obtains a fresh credential result for successive invocations without inference replay', async () => {
  let acquired = 0; const tokens = [];
  const p = createGoogleGeminiProvider({ project: 'test-project', getAccessToken: async () => `token-${++acquired}`, fetchImpl: async (_url, options) => {
    tokens.push(options.headers.Authorization);
    return new Response(JSON.stringify(payload()), { status: tokens.length === 1 ? 401 : 200 });
  } });
  assert.equal((await p.services.rewrite.sync(request)).error.code, 'GEMINI_AUTH_ERROR');
  assert.equal((await p.services.rewrite.sync(request)).ok, true);
  assert.deepEqual(tokens, ['Bearer token-1', 'Bearer token-2']);
});

for (const streaming of [false, true]) {
  test(`Gemini late transport rejection remains a timeout (streaming=${streaming})`, async () => {
    const p = provider(async () => {
      const until = performance.now() + 35;
      while (performance.now() < until) {}
      throw new TypeError('private transport details');
    });
    const r = await p.services.rewrite[streaming ? 'stream' : 'sync']({ ...request, timeoutMs: 10 });
    assert.equal(r.error.code, 'MODEL_TIMEOUT');
    assert.equal(r.error.status, 504);
  });
  test(`Gemini real connection reset is a transport error (streaming=${streaming})`, async t => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200);
      res.write(streaming ? frame(payload('partial', null)) : '{');
      setTimeout(() => res.destroy(), 30);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const events = [];
    const p = provider((_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options));
    const r = await p.services.rewrite[streaming ? 'stream' : 'sync']({ ...request, onChunk: e => events.push(e) });
    assert.equal(r.error.code, 'GEMINI_ERROR');
    assert.equal(r.error.status, 502);
    assert.ok(!events.some(e => e.type === 'done'));
  });
  test(`Gemini invalid UTF8 remains a malformed response (streaming=${streaming})`, async () => {
    const p = provider(async () => new Response(Uint8Array.of(0xff)));
    const r = await p.services.rewrite[streaming ? 'stream' : 'sync'](request);
    assert.equal(r.error.code, 'GEMINI_INVALID_RESPONSE');
  });
}

test('Gemini cancellation of one credential waiter does not cancel its concurrent peer', async () => {
  let resolveToken; let acquisitions = 0; let calls = 0;
  const pending = new Promise(resolve => { resolveToken = resolve; });
  const p = createGoogleGeminiProvider({ project: 'test-project', getAccessToken: () => { acquisitions++; return pending; },
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload())); } });
  const controller = new AbortController();
  const cancelled = p.services.rewrite.sync({ ...request, signal: controller.signal });
  const survivor = p.services.rewrite.sync(request);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await cancelled).error.code, 'MODEL_TIMEOUT');
  resolveToken('token');
  assert.equal((await survivor).ok, true);
  assert.equal(acquisitions, 1);
  assert.equal(calls, 1);
});

test('Gemini cancels unread error bodies without waiting for provider EOF', async t => {
  const http = require('node:http');
  let closed;
  const closing = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    req.resume(); res.on('close', closed);
    res.writeHead(429); res.write('private quota details');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const p = provider((_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options));
  const r = await p.services.rewrite.sync(request);
  assert.equal(r.error.code, 'GEMINI_QUOTA_EXCEEDED');
  assert.ok(!JSON.stringify(r).includes('private'));
  await closing;
});
