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
  assert.equal(body.contents[0].parts[0].text, request.text);
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
