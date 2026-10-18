const test = require('node:test');
const assert = require('node:assert/strict');
const OpenCC = require('opencc-js');
const { createRewriteStreamConverter } = require('../lib/rewrite-stream-converter');
const { fixture, json } = require('../test-support/server-fixture');

const convert = OpenCC.Converter({ from: 'cn', to: 'hk' });
test('stream conversion matches whole-text conversion across dictionary words and UTF-16 boundaries', () => {
  const phrases = ['头发干杯面条😀𠮷', 'a头发\n发展里面', 'plain text'];
  for (const group of [OpenCC.Locale.from.cn, OpenCC.Locale.to.hk]) {
    for (const dictionary of group) {
      const entries = typeof dictionary === 'string' ? dictionary.split('|').map(row => row.split(' ')) : dictionary;
      // Every dictionary entry, with context, is split into single UTF-16 units.
      for (const [word] of entries) phrases.push('a' + word + '😀');
    }
  }
  for (const phrase of phrases) {
    const c = createRewriteStreamConverter();
    let actual = '';
    for (let i = 0; i < phrase.length; i++) actual += c.write(phrase[i]);
    actual += c.write('', true);
    assert.equal(actual, convert(phrase), phrase);
  }
});
test('stream converters isolate requests and emit unambiguous text before completion', () => {
  const a = createRewriteStreamConverter(), b = createRewriteStreamConverter();
  assert.equal(a.write('hello!'), 'hello!');
  const first = a.write('头');
  assert.equal(b.write('发', true), convert('发'));
  assert.equal(first + a.write('发', true), convert('头发'));
});
test('HTTP prompt preserves literal replacement sequences and malformed provider text is controlled', { timeout: 30000 }, async t => {
  let malformed = false;
  const f = await fixture(t, { handle(req, res) {
    if (req.url !== '/rewrite') return false;
    json(res, 200, malformed ? { reply: { text: 'bad' } } : { reply: '正常' }); return true;
  } });
  const text = "保留 $& $$ $` $'";
  for (const route of ['/rewrite', '/api/rewrite']) {
    assert.equal((await f.request(route, { body: { text } })).status, 200);
    assert.ok(f.calls.at(-1).body.messages.at(-1).content.endsWith(text));
  }
  malformed = true;
  const r = await f.request('/rewrite');
  assert.equal(r.status, 502); assert.equal((await r.json()).error.code, 'PROVIDER_ERROR');
});
test('HTTP T2A rejects provider errors and unrelated hex metadata', { timeout: 30000 }, async t => {
  let payload;
  const f = await fixture(t, { handle(req, res) {
    if (req.url !== '/t2a') return false;
    json(res, 200, payload); return true;
  } });
  for (payload of [
    { trace_id: 'ab'.repeat(48), data: null },
    { base_resp: { status_code: 1008 }, data: { audio: 'ab'.repeat(48) } },
    { data: { extra_info: { token: 'ab'.repeat(48) } } }
  ]) for (const route of ['/t2a', '/api/t2a']) {
    const r = await f.request(route); assert.equal(r.status, 502); assert.equal((await r.json()).ok, false);
  }
});
test('HTTP failed readiness replaces cached health and empty Ollama streams fail on both aliases', { timeout: 30000 }, async t => {
  let probeFails = false, probes = 0;
  const f = await fixture(t, { env: { REWRITE_PROVIDER: 'ollama', REWRITE_OLLAMA_MODEL: 'fixture-model', REWRITE_OLLAMA_READINESS_CACHE_MS: '100' }, handle(req, res) {
    if (req.url === '/ps') { probes++; json(res, probeFails ? 503 : 200, { models: [{ name: 'fixture-model' }] }); return true; }
    if (req.url === '/generate') { res.end('{"response":"","done":true}\n'); return true; }
  } });
  for (const route of ['/rewrite', '/api/rewrite']) {
    const r = await f.request(route, { body: { text: 'test', stream: true } });
    const frames = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(frames.length, 1); assert.equal(frames[0].error.code, 'OLLAMA_ERROR');
  }
  probeFails = true; await new Promise(r => setTimeout(r, 110));
  const read = () => f.request('/readyz', { method: 'GET' });
  assert.equal((await read()).status, 503); const count = probes;
  assert.equal((await read()).status, 503); assert.equal(probes, count);
  const status = await (await f.request('/model-status', { method: 'GET' })).json();
  assert.notEqual(status.status, 'ready');
});
test('HTTP streaming conversion preserves phrase context and flushes before done', { timeout: 30000 }, async t => {
  const f = await fixture(t, { handle(req, res, body) {
    if (req.url !== '/rewrite') return false;
    if (!body.stream) json(res, 200, { reply: '头发干杯😀' });
    else {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end([... '头发干杯😀'].map(content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('') + 'data: [DONE]\n\n');
    }
    return true;
  } });
  const expected = await (await f.request('/rewrite')).json();
  const r = await f.request('/rewrite', { body: { text: 'test', stream: true } });
  const frames = (await r.text()).trim().split('\n').map(JSON.parse);
  assert.equal(frames.filter(x => !x.done).map(x => x.response).join(''), expected.result);
  assert.equal(frames.at(-1).done, true);
});
