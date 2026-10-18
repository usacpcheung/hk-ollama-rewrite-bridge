const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const http = require('node:http');
const { createStreamWriter } = require('../lib/output-writer');
const { createAdmissionController } = require('../lib/admission-controller');
const { createInvocationAbort } = require('../lib/invocation-abort');
const { invokeServiceSync } = require('../lib/service-invoker');
const { createProviderAdapter } = require('../lib/provider-adapter');

function response() {
  const res = new EventEmitter();
  res.chunks = [];
  res.write = (data) => {
    res.chunks.push(JSON.parse(data));
    return false;
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
  };
  return res;
}

test('stream output waits for drain, emits one terminal event and rejects trailing text', async () => {
  const res = response();
  const writer = createStreamWriter(res);
  let drained = false;
  const pending = writer.writeChunk({ response: 'first', done: false }).then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  res.emit('drain');
  await pending;
  const done = writer.writeDone();
  res.emit('drain');
  await done;
  await writer.writeChunk({ response: 'late', done: false });
  await writer.writeDone();
  await writer.writeError({ code: 'late' });
  assert.deepEqual(res.chunks, [
    { response: 'first', done: false },
    { response: '', done: true },
  ]);
  assert.equal(res.listenerCount('close'), 0);
});

for (const mode of ['abort', 'close', 'error', 'deadline'])
  test(`blocked output settles on ${mode} and removes listeners`, async () => {
    const res = response();
    const controller = new AbortController();
    const writer = createStreamWriter(res, { signal: controller.signal, drainTimeoutMs: 20 });
    const pending = writer.writeChunk({ response: 'text' });
    const rejected = assert.rejects(pending);
    if (mode === 'abort') controller.abort();
    if (mode === 'close') res.destroy();
    if (mode === 'error') res.emit('error', new Error('socket error'));
    await rejected;
    assert.equal(res.destroyed, true);
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('error'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

test('oversized or unawaited output cannot grow a blocked buffer', async () => {
  const res = response();
  const writer = createStreamWriter(res, { maxBufferedBytes: 128 });
  const first = writer.writeChunk({ response: 'text' });
  const rejected = assert.rejects(first);
  assert.throws(() => writer.writeChunk({ response: 'more' }), { code: 'STREAM_OUTPUT_LIMIT' });
  await rejected;
  assert.equal(res.chunks.length, 1);
  const other = response();
  assert.throws(
    () => createStreamWriter(other, { maxBufferedBytes: 128 }).writeChunk({ response: 'x'.repeat(129) }),
    { code: 'STREAM_OUTPUT_LIMIT' },
  );
  assert.equal(other.chunks.length, 0);
});

test('a real paused HTTP reader bounds output then disconnect releases the writer', async (t) => {
  let maxBuffered = 0;
  let written = 0;
  let settled;
  const completed = new Promise((resolve) => {
    settled = resolve;
  });
  const server = http.createServer(async (req, res) => {
    const writer = createStreamWriter(res, { drainTimeoutMs: 1000 });
    try {
      for (let i = 0; i < 8192; i++) {
        const pending = writer.writeChunk({ response: 'x'.repeat(8192), done: false });
        maxBuffered = Math.max(maxBuffered, res.writableLength);
        written++;
        await pending;
      }
      res.end();
    } catch {
      /* Expected disconnect from the paused client. */
    } finally {
      settled();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${server.address().port}`, (res) => {
      res.pause();
      setTimeout(() => {
        res.destroy();
        resolve();
      }, 100);
    });
    req.on('error', reject);
  });
  await completed;
  assert.ok(written < 8192, 'provider pacing must stop before buffering all 64 MiB');
  assert.ok(maxBuffered < 128 * 1024, `buffer was ${maxBuffered}`);
});

test('cancelled admission entries never invoke work; admission/timeout/cancel races leave no tickets', async () => {
  for (let round = 0; round < 50; round++) {
    const c = createAdmissionController({
      globalLimits: { maxConcurrency: 1, maxQueueSize: 10, maxWaitMs: 2 },
    });
    const ticket = await c.acquire({ providerName: 'test' });
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      c.acquire({ providerName: 'test', signal: controller.signal }).then(
        (next) => {
          next.release();
          next.release();
        },
        (error) => {
          assert.ok(error.name === 'AbortError' || error.reason === 'wait_timeout');
        },
      ),
    );
    controllers.slice(0, 5).forEach((controller) => controller.abort());
    setTimeout(() => {
      ticket.release();
      ticket.release();
      controllers.forEach((controller) => controller.abort());
    }, round % 4);
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(c.getState().inFlight, 0);
    assert.equal(c.getState().queueDepth, 0);
    controllers.forEach((controller) =>
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0),
    );
  }
  const controller = new AbortController();
  controller.abort();
  const c = createAdmissionController();
  await assert.rejects(c.acquire({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(c.getState().inFlight, 0);
});

test('provider deadline and caller cancellation clean up signals on success and abort', async () => {
  const caller = new AbortController();
  const first = createInvocationAbort(caller.signal, 1000);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 1);
  first.dispose();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  const next = createInvocationAbort(caller.signal, 1000);
  caller.abort();
  assert.equal(next.controller.signal.aborted, true);
  next.dispose();
});

test('cancelled callers retain active admission until provider settles and do not poison readiness', async () => {
  const c = createAdmissionController({ globalLimits: { maxConcurrency: 1 } });
  const controller = new AbortController();
  let complete;
  let lifecycleCalls = 0;
  let calledSignal;
  const adapter = createProviderAdapter({
    services: {
      rewrite: {
        sync: ({ signal }) => {
          calledSignal = signal;
          return new Promise((resolve) => {
            complete = resolve;
          });
        },
      },
    },
    mapError() {},
  });
  const operation = invokeServiceSync({
    runtime: {
      service: { id: 'rewrite' },
      providerName: 'fake',
      adapter,
      lifecycle: {
        recordSuccess() {
          lifecycleCalls++;
        },
        recordFailure() {
          lifecycleCalls++;
        },
      },
    },
    signal: controller.signal,
    executeWithAdmission: async ({ signal, execute }) => {
      const ticket = await c.acquire({ providerName: 'fake', signal });
      try {
        signal.throwIfAborted();
        return await execute();
      } finally {
        ticket.release();
      }
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(calledSignal, controller.signal);
  assert.equal(c.getState().inFlight, 1);
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  complete({ ok: true });
  await rejected;
  assert.equal(c.getState().inFlight, 0);
  assert.equal(lifecycleCalls, 0);
});

test('deadline before a terminal write does not suppress the subsequent error frame', async () => {
  const res = response();
  const writer = createStreamWriter(res);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => writer.writeDone({}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(writer.isDoneSent(), false);
  const errorWrite = writer.writeError({ code: 'MODEL_TIMEOUT' });
  res.emit('drain');
  await errorWrite;
  assert.deepEqual(res.chunks, [{ done: true, error: { code: 'MODEL_TIMEOUT' } }]);
});
