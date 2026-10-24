const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, AUTH, AUDIO } = require('../test-support/server-fixture');

// Local-only regression for GHSA-27r3-jxmh-p828. A gzip padding byte lets
// the decoder finish before the HTTP body; subsequent bytes must not leave
// an unhandled error on that finished decoder or terminate the bridge.
async function trailingRequest(route, suffix) {
  const first = Buffer.concat([zlib.gzipSync(Buffer.from('{"text":"test"}')), Buffer.from([0])]);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3001, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume();
      res.on('end', () => req.end(suffix, () => resolve(res.statusCode)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Compressed request timed out')));
    req.write(first);
  });
}

test('finished gzip decoder cannot crash unauthenticated routes or aliases on trailing input', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const route of ['/rewrite', '/api/rewrite', '/t2a', '/api/t2a', '/transcriptions', '/api/transcriptions', '/not-a-route']) {
    for (const suffix of [Buffer.from('trailing-data'), Buffer.alloc(256, 255)]) {
      const status = await trailingRequest(route, suffix);
      assert.equal(status, route === '/not-a-route' ? 404 : 401);
      await delay(40); // Allow the decoder's asynchronous error event to run.
      assert.equal(f.bridge.exitCode, null, `bridge survives ${route}`);
      assert.equal((await f.request('/healthz', { method: 'GET' })).status, 200);
    }
  }
  assert.equal(f.calls.length, 0, 'unauthenticated requests never invoke a provider');
});

test('gzip/deflate JSON preserves rewrite/T2A auth, malformed JSON and decompressed limits', async t => {
  const f = await fixture(t);
  for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync]]) {
    const send = (route, text, authenticated = true) => f.request(route, {
      raw: compress(Buffer.from(text)), headers: { ...(authenticated ? AUTH : {}), 'Content-Encoding': encoding }
    });
    for (const route of ['/rewrite', '/api/rewrite']) {
      const valid = await send(route, JSON.stringify({ text: '測試' }));
      assert.equal(valid.status, 200); assert.equal((await valid.json()).result, '正式文字');
      assert.equal((await send(route, '{"text":"test"}', false)).status, 401);
      const malformed = await send(route, '{bad');
      assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
      const large = await send(route, JSON.stringify({ text: 'x'.repeat(17000) }));
      assert.equal(large.status, 413); assert.equal((await large.json()).error.code, 'PAYLOAD_TOO_LARGE');
    }
    for (const route of ['/t2a', '/api/t2a']) {
      const valid = await send(route, JSON.stringify({ text: 'hello', voice_choice: 'english_narrator_female' }));
      assert.equal(valid.status, 200); assert.deepEqual(Buffer.from(await valid.arrayBuffer()), AUDIO);
    }
    const broken = await f.request('/rewrite', { raw: Buffer.from('not compressed'), headers: { ...AUTH, 'Content-Encoding': encoding } });
    assert.ok(broken.status >= 400);
    assert.equal((await f.request('/healthz', { method: 'GET' })).status, 200);
  }
});
