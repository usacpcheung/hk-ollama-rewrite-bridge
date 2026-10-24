const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, json, AUDIO, AUTH } = require('../test-support/server-fixture');
const env = { REWRITE_PROVIDER: 'google-gemini', REWRITE_GOOGLE_PROJECT: 'test-project',
  NODE_OPTIONS: '--require=' + path.join(__dirname, '../test-support/gemini-transport.cjs') };
const result = (text, reason = 'STOP') => ({ candidates: [{ content: { parts: [{ thought: true, text: 'internal thought' }, { text }] }, finishReason: reason }], usageMetadata: { totalTokenCount: 10 } });
test('actual server Gemini JSON/NDJSON aliases, auth, validation, passive readiness and T2A coexist', async t => {
  const f = await fixture(t, { env, handle(req, res, body) {
    if (!req.url.startsWith('/gemini')) return false;
    assert.equal(req.headers.authorization, 'Bearer test-only-token');
    assert.equal(body.systemInstruction.parts[0].text.includes('廣東話'), true);
    if (req.url === '/gemini-stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify(result('正式文字')) + '\n\n'); }
    else json(res, 200, result('正式文字'));
    return true;
  } });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/readyz', { method: 'GET' })).status, 200);
  assert.equal(f.calls.length, 0);
  for (const route of ['/rewrite', '/api/rewrite']) {
    assert.equal((await f.request(route, { headers: {} })).status, 401);
    assert.equal((await f.request(route, { body: { text: '' } })).status, 400);
    const r = await f.request(route); assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, result: '正式文字', usage: { totalTokenCount: 10 } });
    const s = await f.request(route, { body: { text: '測試', stream: true } });
    const frames = (await s.text()).trim().split('\n').map(JSON.parse);
    assert.equal(frames.filter(x => x.done).length, 1);
    assert.equal(frames.filter(x => !x.done).map(x => x.response).join(''), '正式文字');
  }
  for (const route of ['/t2a', '/api/t2a']) {
    const r = await f.request(route, { body: { text: 'hello', voice_choice: 'english_narrator_female' } });
    assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), AUDIO);
  }
});
test('actual server Gemini stream truncation has controlled error and no successful completion', async t => {
  const f = await fixture(t, { env, handle(req, res) {
    if (!req.url.startsWith('/gemini')) return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(result('partial', 'MAX_TOKENS')) + '\n\n'); return true;
  } });
  const r = await f.request('/rewrite', { body: { text: 'test', stream: true } });
  const body = await r.text();
  assert.match(body, /GEMINI_OUTPUT_TRUNCATED/); assert.ok(!body.includes('partial'));
});

test('Gemini slow response/caller disconnect releases capacity and subsequent concurrent requests stay isolated', async t => {
  let aborted = 0;
  const f = await fixture(t, { env: { ...env, REWRITE_READY_INVOKE_TIMEOUT_MS: '100', REWRITE_COLD_INVOKE_TIMEOUT_MS: '100', GOOGLE_GEMINI_MAX_CONCURRENCY: '1' }, handle(req, res, body) {
    if (!req.url.startsWith('/gemini')) return false;
    const text = body.contents[0].parts[0].text;
    if (text === 'slow') { res.once('close', () => { aborted++; }); return true; }
    json(res, 200, result(text)); return true;
  } });
  const slow = await f.request('/rewrite', { body: { text: 'slow' } });
  assert.equal(slow.status, 504);
  assert.equal((await slow.json()).error.code, 'MODEL_TIMEOUT');
  const responses = await Promise.all(['甲', '乙', '丙'].map(text => f.request('/rewrite', { body: { text } }).then(r => r.json())));
  assert.deepEqual(responses.map(r => r.result), ['甲', '乙', '丙']);
  assert.equal(aborted, 1);
  const controller = new AbortController();
  const disconnected = fetch('http://127.0.0.1:3001/rewrite', { method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'slow' }), signal: controller.signal });
  const rejection = assert.rejects(disconnected, { name: 'AbortError' });
  const started = Date.now();
  while (f.calls.filter(c => c.body.contents?.[0]?.parts?.[0]?.text === 'slow').length < 2) {
    assert.ok(Date.now() - started < 2000, 'second upstream request starts');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  controller.abort(); await rejection;
  const recovered = await f.request('/rewrite', { body: { text: '恢復' } });
  assert.equal((await recovered.json()).result, '恢復');
  assert.equal(aborted, 2);
});
