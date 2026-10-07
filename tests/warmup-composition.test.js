const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture, AUTH, json } = require('../test-support/server-fixture');
test('actual server MODEL_WARMUP_STARTED is preserved on both aliases', async (t) => {
  let probes = 0;
  const f = await fixture(t, {
    env: {
      REWRITE_PROVIDER: 'ollama',
      WARMUP_ON_START: 'true',
      REWRITE_OLLAMA_WARMUP_RETRIGGER_WINDOW_MS: '0',
      WARMUP_STARTUP_RETRY_INTERVAL_MS: '60000',
      WARMUP_STARTUP_MAX_WAIT_MS: '120000',
      REWRITE_OLLAMA_READINESS_CACHE_MS: '0',
    },
    handle: (req, res) => {
      if (req.url === '/ps') {
        probes++;
        json(res, 200, { models: [] });
        return true;
      }
      if (req.url === '/generate') {
        json(res, 200, { response: 'warm', done: true });
        return true;
      }
      return false;
    },
  });
  for (let i = 0; i < 100 && probes === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  for (const route of ['/rewrite', '/api/rewrite']) {
    const r = await f.request(route);
    const b = await r.json();
    assert.equal(r.status, 202);
    assert.equal(b.error.code, 'MODEL_WARMUP_STARTED', JSON.stringify(b));
    assert.equal(Number(r.headers.get('retry-after')), b.retryAfterSec);
  }
  assert.equal((await f.request('/t2a')).status, 200);
});
