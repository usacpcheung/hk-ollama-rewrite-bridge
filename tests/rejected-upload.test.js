const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const path = require('node:path');
const { installRejectedUploadCleanup } = require('../lib/rejected-upload');
const { fixture, AUTH } = require('../test-support/server-fixture');

test('rejected upload cleanup is idempotent, drains a small tail and removes listeners', async () => {
  const req = new PassThrough(); const res = new EventEmitter();
  installRejectedUploadCleanup(req, res); installRejectedUploadCleanup(req, res);
  assert.equal(res.listenerCount('finish'), 1);
  res.emit('finish');
  assert.equal(req.destroyed, false, 'do not reset at response finish');
  const ended = once(req, 'end');
  req.end(Buffer.alloc(6444)); await ended;
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(req.listenerCount('close'), 0);
});

test('rejected upload cleanup bounds bytes and unfinished connection lifetime', async () => {
  for (const excessive of [true, false]) {
    const req = new PassThrough(); const res = new EventEmitter();
    installRejectedUploadCleanup(req, res);
    const closed = once(req, 'close');
    res.emit('finish');
    if (excessive) {
      req.write(Buffer.alloc(65536)); assert.equal(req.destroyed, false);
      req.write(Buffer.alloc(1)); assert.equal(req.destroyed, true);
    } else {
      // Keep the test alive while the production timer is deliberately unref'd.
      const keepAlive = setTimeout(() => {}, 1000);
      await closed; clearTimeout(keepAlive);
    }
    await closed;
    assert.equal(req.destroyed, true);
    assert.equal(req.listenerCount('data'), 0);
  }
});

test('actual transcription rejections deliver errors while a small upload is still being sent', { timeout: 15000 }, async t => {
  const f = await fixture(t, { env: {
    NODE_OPTIONS: '--require=' + path.join(__dirname, '../test-support/step5-providers.cjs'),
    TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER: 'fixture-a', FIXTURE_KEY: '',
  } });
  for (const route of ['/transcriptions', '/api/transcriptions']) {
    for (const [headers, expected] of [
      [{ ...AUTH, 'X-Bridge-Auth': 'wrong' }, 401],
      [{ ...AUTH, Origin: 'https://untrusted.example' }, 403],
      [AUTH, 503],
    ]) {
      await new Promise((resolve, reject) => {
        const req = http.request('http://127.0.0.1:3001' + route, {
          method: 'POST', headers: { ...headers, Connection: 'keep-alive',
            'Content-Type': 'multipart/form-data; boundary=synthetic', 'Content-Length': '6444' },
        });
        req.on('error', reject);
        req.on('response', res => {
          assert.equal(res.statusCode, expected);
          let text = ''; res.on('data', b => { text += b; });
          res.on('end', () => {
            assert.equal(JSON.parse(text).ok, false);
            setTimeout(() => {
              try {
                assert.equal(req.socket.destroyed, false, 'allow in-flight upload to finish');
                req.end(Buffer.alloc(6443));
                setTimeout(() => { req.destroy(); resolve(); }, 20);
              } catch (e) { req.destroy(); reject(e); }
            }, 20);
          });
        });
        req.write(Buffer.alloc(1));
      });
    }
  }
  assert.equal(f.calls.length, 0, 'rejected requests never reach an upstream provider');
  assert.equal((await fetch('http://127.0.0.1:3001/healthz')).status, 200);
});
