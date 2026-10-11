const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, AUTH, json } = require('../test-support/server-fixture');
const { createAdmissionController } = require('../lib/admission-controller');
const { invokeServiceSync, invokeServiceStream } = require('../lib/service-invoker');
const { createActiveProbeLifecycle } = require('../providers/lifecycle');
const { readProviderAvailability } = require('../lib/provider-availability');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fault = mode => ({ NODE_OPTIONS: '--require=' + path.join(__dirname, '../test-support/provider-faults.cjs'), TEST_PROVIDER_FAULT: mode });

test('expired queued work never receives capacity even before the timeout callback runs', async () => {
  let now = 0; const timers = [];
  const controller = createAdmissionController({ globalLimits: { maxConcurrency: 1, maxQueueSize: 3, maxWaitMs: 100 },
    now: () => now, setTimer: fn => { timers.push(fn); return fn; }, clearTimer() {} });
  const first = await controller.acquire({ providerName: 'one' });
  const expired = assert.rejects(controller.acquire({ providerName: 'one' }), { code: 'ADMISSION_OVERLOADED', reason: 'wait_timeout' });
  now = 50;
  const live = controller.acquire({ providerName: 'one' });
  now = 101; first.release();
  await expired; const next = await live;
  assert.equal(next.waitMs, 51); assert.equal(controller.getState().inFlight, 1);
  timers.forEach(fn => fn()); next.release(); next.release();
  assert.equal(controller.getState().inFlight, 0); assert.equal(controller.getState().queueDepth, 0);
});

test('queue expiry is inclusive at the deadline and cancellation still wins when already observed', async () => {
  for (const cancelFirst of [false, true]) {
    let now = 0;
    const controller = createAdmissionController({ globalLimits: { maxConcurrency: 1, maxQueueSize: 1, maxWaitMs: 10 },
      now: () => now, setTimer: () => 0, clearTimer() {} });
    const held = await controller.acquire({ providerName: 'one' }); const abort = new AbortController();
    const expected = assert.rejects(controller.acquire({ providerName: 'one', signal: abort.signal }),
      cancelFirst ? { name: 'AbortError' } : { reason: 'wait_timeout' });
    now = 10; if (cancelFirst) abort.abort(); held.release(); await expected;
    assert.equal(controller.getState().inFlight, 0);
  }
});

test('availability exceptions, rejected promises and malformed results become sanitized unavailability', async () => {
  for (const hook of [() => { throw Error('private secret'); }, async () => { throw Error('private secret'); },
    () => ({ status: 200, code: 'BAD', message: 'bad' }), () => true]) {
    assert.deepEqual(readProviderAvailability(hook), { status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'Provider is temporarily unavailable.' });
  }
  await delay(0); // Rejected asynchronous hooks must be observed, not unhandled.
  assert.equal(readProviderAvailability(() => null), null);
});

for (const mode of ['availability', 'async-availability']) {
  test(`HTTP ${mode} failures preserve authentication and keep unrelated services alive`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { env: { ...fault(mode), TRANSCRIPTION_ENABLED: 'true' } });
    for (const route of ['/transcriptions', '/api/transcriptions']) {
      for (const valid of [false, true]) {
        // Buffer this tiny request: this case tests hook containment, not a
        // streaming upload racing an intentional early Connection: close.
        const body = '--hook-test\r\nContent-Disposition: form-data; name="audio"; filename="input.wav"\r\n\r\ntest\r\n--hook-test--\r\n';
        const r = await fetch('http://127.0.0.1:3001' + route, { method: 'POST', body,
          headers: { ...AUTH, ...(valid ? {} : { 'X-Bridge-Auth': 'wrong' }),
            'Content-Type': 'multipart/form-data; boundary=hook-test' } });
        assert.equal(r.status, valid ? 503 : 401); const text = await r.text(); assert.ok(!text.includes('private'));
        if (valid) assert.equal(JSON.parse(text).error.code, 'PROVIDER_UNAVAILABLE');
      }
    }
    assert.equal((await fetch('http://127.0.0.1:3001/healthz')).status, 200);
    assert.equal((await f.request('/rewrite')).status, 200);
    assert.equal((await f.request('/t2a')).status, 200);
    assert.equal(f.bridge.exitCode, null);
  });
}

for (const mode of ['readiness', 'warmup', 'invalid-readiness']) {
  test(`HTTP ${mode} hook failures are controlled and leave the process operational`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { env: { ...fault(mode), REWRITE_PROVIDER: 'ollama', REWRITE_OLLAMA_READINESS_CACHE_MS: '0' } });
    for (const route of ['/model-status', '/readyz']) {
      const r = await fetch('http://127.0.0.1:3001' + route);
      assert.equal(r.status, route === '/readyz' ? 503 : 200); assert.ok(!(await r.text()).includes('private'));
    }
    for (const route of ['/rewrite', '/api/rewrite']) {
      const r = await f.request(route); assert.equal(r.status, 202); assert.ok(!(await r.text()).includes('private'));
    }
    assert.equal((await f.request('/t2a')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:3001/healthz')).status, 200);
  });
}

test('overlapping HTTP readiness consumers share one probe and later failure stays authoritative', { timeout: 15000 }, async t => {
  let release; let entered; const started = new Promise(resolve => { entered = resolve; }); let probes = 0;
  await fixture(t, { env: { REWRITE_PROVIDER: 'ollama', REWRITE_OLLAMA_READINESS_CACHE_MS: '0' }, handle(req, res) {
    if (req.url !== '/ps') return;
    probes++;
    if (probes === 1) { release = () => json(res, 200, { models: [{ name: 'qwen2.5:3b-instruct' }] }); entered(); }
    else json(res, 200, { models: [] });
    return true;
  } });
  const older = fetch('http://127.0.0.1:3001/model-status'); await started;
  const overlap = fetch('http://127.0.0.1:3001/readyz'); await delay(40);
  assert.equal(probes, 1); release();
  assert.equal((await (await older).json()).lastProbeReady, true);
  assert.equal((await overlap).status, 200);
  assert.equal((await fetch('http://127.0.0.1:3001/readyz')).status, 503);
  assert.equal((await fetch('http://127.0.0.1:3001/readyz')).status, 503);
});

test('shared readiness failure clears the in-flight probe and a subsequent check can recover', async () => {
  let reject; let calls = 0;
  const lifecycle = createActiveProbeLifecycle({ providerName: 'new', serviceId: 'rewrite', adapter: {
    checkReadiness: () => ++calls === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : { ready: true, error: null }
  } });
  const requests = Array.from({ length: 20 }, () => lifecycle.checkReadiness());
  await Promise.resolve(); assert.equal(calls, 1); reject(Error('private'));
  const results = await Promise.all(requests); assert.ok(results.every(r => r.ready === null));
  assert.deepEqual(await lifecycle.checkReadiness(), { ready: true, error: null }); assert.equal(calls, 2);
});

for (const provider of ['minimax', 'ollama']) {
  test(`HTTP ${provider} rewrite rejects late success after synchronous parsing delay`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { env: { ...fault('slow-json'), REWRITE_PROVIDER: provider,
      REWRITE_READY_INVOKE_TIMEOUT_MS: '80', TEST_PARSE_BLOCK_MS: '180' }, handle(req, res) {
      if (req.url === '/ps') { json(res, 200, { models: [{ name: 'qwen2.5:3b-instruct' }] }); return true; }
      if (req.url === '/generate') { json(res, 200, { response: 'late', done: true }); return true; }
    } });
    for (const route of ['/rewrite', '/api/rewrite']) {
      const r = await f.request(route); assert.equal(r.status, 504); assert.equal((await r.json()).error.code, 'MODEL_TIMEOUT');
    }
  });
}

test('HTTP T2A rejects late success after synchronous parsing delay on both aliases', { timeout: 15000 }, async t => {
  const f = await fixture(t, { env: { ...fault('slow-json'), T2A_INVOKE_TIMEOUT_MS: '1000', TEST_PARSE_BLOCK_MS: '1100' } });
  for (const route of ['/t2a', '/api/t2a']) {
    const r = await f.request(route); assert.equal(r.status, 504); assert.equal((await r.json()).error.code, 'MODEL_TIMEOUT');
  }
});

test('stream deadline suppresses late text/done even while the timeout callback cannot run', async () => {
  const seen = []; const records = [];
  const runtime = { providerName: 'fixture', service: { id: 'rewrite' }, lifecycle: {
    recordFailure: () => records.push('failure'), recordSuccess: () => records.push('success')
  }, adapter: { invokeStream: async ({ onChunk }) => {
    await onChunk({ type: 'text', text: 'early' });
    const until = performance.now() + 30; while (performance.now() < until) {}
    await onChunk({ type: 'done' }); return { ok: true };
  } } };
  const result = await invokeServiceStream({ runtime, timeoutMs: 15, onChunk: event => seen.push(event), executeWithAdmission: ({ execute }) => execute() });
  assert.equal(result.error.code, 'MODEL_TIMEOUT'); assert.deepEqual(seen, [{ type: 'text', text: 'early' }]);
  assert.deepEqual(records, ['failure']);
});

test('deadline keeps admission until settlement, excludes queue wait and preserves caller cancellation', async () => {
  const admission = createAdmissionController({ globalLimits: { maxConcurrency: 1, maxQueueSize: 1, maxWaitMs: 1000 } });
  const executor = async ({ execute, signal }) => {
    const permit = await admission.acquire({ providerName: 'fixture', signal });
    try { return await execute(); } finally { permit.release(); }
  };
  let settle; const runtime = { providerName: 'fixture', service: { id: 'rewrite' },
    adapter: { invokeSync: () => new Promise(resolve => { settle = resolve; }) } };
  const pending = invokeServiceSync({ runtime, timeoutMs: 10, executeWithAdmission: executor });
  await delay(25); assert.equal(admission.getState().inFlight, 1);
  settle({ ok: true }); assert.equal((await pending).error.code, 'MODEL_TIMEOUT');
  assert.equal(admission.getState().inFlight, 0);
  const held = await admission.acquire({ providerName: 'fixture' });
  runtime.adapter.invokeSync = async () => ({ ok: true });
  const queued = invokeServiceSync({ runtime, timeoutMs: 10, executeWithAdmission: executor });
  await delay(25); held.release(); assert.equal((await queued).ok, true);
  const abort = new AbortController(); runtime.adapter.invokeSync = async () => { abort.abort(new Error('caller cancelled')); await delay(20); return { ok: true }; };
  await assert.rejects(invokeServiceSync({ runtime, timeoutMs: 10, signal: abort.signal, executeWithAdmission: executor }), /caller cancelled/);
  assert.equal(admission.getState().inFlight, 0);
});


test('availability loss during a shared probe cannot be overwritten by its older ready result', async () => {
  let finish; let available = true;
  const lifecycle = createActiveProbeLifecycle({ providerName: 'fixture', serviceId: 'rewrite',
    availability: () => available ? null : { status: 503, code: 'MISSING', message: 'Unavailable.' },
    adapter: { checkReadiness: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = lifecycle.checkReadiness(); await Promise.resolve(); available = false;
  assert.equal((await lifecycle.checkReadiness()).ready, false);
  finish({ ready: true, error: null }); assert.equal((await pending).ready, false);
});

test('late provider rejection becomes timeout and does not record lifecycle success', async () => {
  const records = [];
  const runtime = { providerName: 'fixture', service: { id: 'rewrite' }, lifecycle: {
    recordFailure: () => records.push('failure'), recordSuccess: () => records.push('success')
  }, adapter: { invokeSync: async () => {
    const until = performance.now() + 30; while (performance.now() < until) {}
    throw new Error('native private details');
  } } };
  const r = await invokeServiceSync({ runtime, timeoutMs: 10, executeWithAdmission: ({ execute }) => execute() });
  assert.equal(r.error.code, 'MODEL_TIMEOUT'); assert.deepEqual(records, ['failure']);
});

for (const provider of ['minimax', 'ollama']) {
  test(`HTTP ${provider} stream emits one timeout terminal after blocked frame parsing`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { env: { ...fault('slow-stream'), REWRITE_PROVIDER: provider,
      REWRITE_READY_INVOKE_TIMEOUT_MS: '80', TEST_PARSE_BLOCK_MS: '180' }, handle(req, res) {
      if (req.url === '/ps') { json(res, 200, { models: [{ name: 'qwen2.5:3b-instruct' }] }); return true; }
      if (req.url === '/generate') { res.end(JSON.stringify({ response: 'late text', done: true }) + '\n'); return true; }
      if (req.url === '/rewrite') {
        res.end('data: {"choices":[{"delta":{"content":"late text"}}]}\n\ndata: [DONE]\n\n'); return true;
      }
    } });
    for (const route of ['/rewrite', '/api/rewrite']) {
      const r = await f.request(route, { body: { text: 'test', stream: true } }); assert.equal(r.status, 200);
      const chunks = (await r.text()).trim().split('\n').map(JSON.parse);
      assert.equal(chunks.length, 1); assert.equal(chunks[0].done, true);
      assert.equal(chunks[0].error.code, 'MODEL_TIMEOUT');
      assert.equal(chunks[0].error.status, 504);
    }
  });
}


test('active lifecycle rejects late probe and warmup success after an event-loop stall', async () => {
  const stall = result => { const until = performance.now() + 25; while (performance.now() < until) {} return result; };
  const lifecycle = createActiveProbeLifecycle({ providerName: 'fixture', serviceId: 'rewrite', adapter: {
    checkReadiness: async () => stall({ ready: true, error: null }),
    triggerWarmup: async () => stall({ ok: true })
  } });
  assert.deepEqual(await lifecycle.checkReadiness({ timeoutMs: 10 }), { ready: null, error: 'PROVIDER_PROBE_UNAVAILABLE' });
  assert.deepEqual(await lifecycle.maybeWarmup({ timeoutMs: 10 }), { triggered: true, result: 'failed', error: 'PROVIDER_WARMUP_FAILED' });
  assert.equal(lifecycle.getDiagnostics().warmupInFlight, false);
});
