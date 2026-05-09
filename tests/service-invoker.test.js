const test = require('node:test');
const assert = require('node:assert/strict');

const {
  invokeServiceSync,
  invokeServiceStream
} = require('../lib/service-invoker');

function createRuntime({ result, streamResult, mapErrorResult } = {}) {
  const lifecycleCalls = [];
  const adapterCalls = [];

  const runtime = {
    providerName: 'provider-a',
    service: { id: 'rewrite' },
    lifecycle: {
      recordSuccess: ({ nowMs }) => lifecycleCalls.push(['success', typeof nowMs]),
      recordFailure: ({ nowMs }) => lifecycleCalls.push(['failure', typeof nowMs])
    },
    adapter: {
      invokeSync: async (args) => {
        adapterCalls.push(['sync', args]);
        return result || { ok: true, data: { response: 'ok' } };
      },
      invokeStream: async (args) => {
        adapterCalls.push(['stream', args]);
        if (typeof args.onChunk === 'function') {
          await args.onChunk({ type: 'text', text: 'chunk' });
        }
        return streamResult || { ok: true, data: { response: 'chunk' } };
      },
      mapError: () => mapErrorResult || {
        code: 'PROVIDER_ERROR',
        message: 'fallback',
        status: 502
      }
    }
  };

  return { runtime, lifecycleCalls, adapterCalls };
}

function createAdmissionExecutor({ throwError } = {}) {
  const calls = [];
  const executeWithAdmission = async ({ providerName, requestId, execute }) => {
    calls.push({ providerName, requestId });
    if (throwError) {
      throw throwError;
    }
    return execute();
  };

  return { calls, executeWithAdmission };
}

test('invokeServiceSync wraps admission, invokes adapter, and records lifecycle success', async () => {
  const { runtime, lifecycleCalls, adapterCalls } = createRuntime();
  const { calls, executeWithAdmission } = createAdmissionExecutor();

  const result = await invokeServiceSync({
    runtime,
    requestId: 'req-sync-ok',
    payload: { prompt: 'hello' },
    timeoutMs: 123,
    executeWithAdmission
  });

  assert.deepEqual(calls, [{ providerName: 'provider-a', requestId: 'req-sync-ok' }]);
  assert.equal(adapterCalls[0][0], 'sync');
  assert.deepEqual(adapterCalls[0][1], {
    serviceId: 'rewrite',
    requestId: 'req-sync-ok',
    payload: { prompt: 'hello' },
    timeoutMs: 123
  });
  assert.equal(result.ok, true);
  assert.deepEqual(lifecycleCalls, [['success', 'number']]);
});

test('invokeServiceSync maps fallback error and records lifecycle failure', async () => {
  const { runtime, lifecycleCalls } = createRuntime({
    result: { ok: false }
  });
  const { executeWithAdmission } = createAdmissionExecutor();

  const result = await invokeServiceSync({
    runtime,
    requestId: 'req-sync-fail',
    timeoutMs: 123,
    executeWithAdmission
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'PROVIDER_ERROR',
      message: 'fallback',
      status: 502
    }
  });
  assert.deepEqual(lifecycleCalls, [['failure', 'number']]);
});

test('invokeServiceStream passes onChunk, wraps admission, and records lifecycle success', async () => {
  const { runtime, lifecycleCalls, adapterCalls } = createRuntime();
  const { calls, executeWithAdmission } = createAdmissionExecutor();
  const events = [];

  const result = await invokeServiceStream({
    runtime,
    requestId: 'req-stream-ok',
    payload: { prompt: 'hello' },
    timeoutMs: 456,
    onChunk: async (event) => events.push(event),
    executeWithAdmission
  });

  assert.deepEqual(calls, [{ providerName: 'provider-a', requestId: 'req-stream-ok' }]);
  assert.equal(adapterCalls[0][0], 'stream');
  assert.equal(adapterCalls[0][1].serviceId, 'rewrite');
  assert.equal(adapterCalls[0][1].requestId, 'req-stream-ok');
  assert.equal(adapterCalls[0][1].timeoutMs, 456);
  assert.deepEqual(events, [{ type: 'text', text: 'chunk' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(lifecycleCalls, [['success', 'number']]);
});

test('invokeServiceStream records lifecycle failure', async () => {
  const { runtime, lifecycleCalls } = createRuntime({
    streamResult: {
      ok: false,
      error: {
        code: 'STREAM_FAILED',
        message: 'stream failed',
        status: 502
      }
    }
  });
  const { executeWithAdmission } = createAdmissionExecutor();

  const result = await invokeServiceStream({
    runtime,
    requestId: 'req-stream-fail',
    timeoutMs: 456,
    onChunk: async () => {},
    executeWithAdmission
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STREAM_FAILED');
  assert.deepEqual(lifecycleCalls, [['failure', 'number']]);
});

test('invokeServiceSync does not swallow admission overload exceptions', async () => {
  const overload = new Error('overloaded');
  overload.code = 'ADMISSION_OVERLOADED';
  const { runtime, lifecycleCalls } = createRuntime();
  const { executeWithAdmission } = createAdmissionExecutor({ throwError: overload });

  await assert.rejects(
    () => invokeServiceSync({
      runtime,
      requestId: 'req-overload',
      executeWithAdmission
    }),
    { code: 'ADMISSION_OVERLOADED' }
  );
  assert.deepEqual(lifecycleCalls, []);
});

test('invokeServiceSync returns unsupported provider-service failures unchanged', async () => {
  const unsupported = {
    ok: false,
    error: {
      code: 'UNSUPPORTED_PROVIDER_SERVICE',
      message: 'Provider "ollama" does not support sync t2a requests',
      status: 501
    }
  };
  const { runtime, lifecycleCalls } = createRuntime({ result: unsupported });
  const { executeWithAdmission } = createAdmissionExecutor();

  const result = await invokeServiceSync({
    runtime,
    requestId: 'req-unsupported',
    executeWithAdmission
  });

  assert.deepEqual(result, unsupported);
  assert.deepEqual(lifecycleCalls, [['failure', 'number']]);
});
