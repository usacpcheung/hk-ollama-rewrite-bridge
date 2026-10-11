const { performance } = require('node:perf_hooks');
function getFallbackError(runtime) {
  return runtime.adapter.mapError(new Error('unknown'));
}

function recordLifecycle(runtime, methodName) {
  const lifecycleMethod = runtime.lifecycle?.[methodName];
  if (typeof lifecycleMethod === 'function') {
    lifecycleMethod.call(runtime.lifecycle, { nowMs: Date.now() });
  }
}

function normalizeResult({ runtime, result, recordLifecycle: shouldRecordLifecycle }) {
  if (result?.ok) {
    if (shouldRecordLifecycle) {
      recordLifecycle(runtime, 'recordSuccess');
    }
    return result;
  }

  if (shouldRecordLifecycle) {
    recordLifecycle(runtime, 'recordFailure');
  }

  return {
    ok: false,
    error: result?.error || getFallbackError(runtime)
  };
}

// Start the invocation budget only after admission. A late timer must not allow
// late success/terminal output, and timeout must not release unsettled work.
async function withInvocationDeadline({ timeoutMs, signal, onChunk, invoke }) {
  const deadline = Number.isFinite(timeoutMs) ? performance.now() + timeoutMs : Infinity;
  const check = () => {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new DOMException('Provider deadline exceeded', 'TimeoutError');
  };
  try {
    check();
    const result = await invoke(onChunk && ((...args) => { check(); return onChunk(...args); }));
    check();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) return { ok: false, error: {
      status: 504, code: 'MODEL_TIMEOUT', message: 'Model response timed out. Please retry.'
    } };
    throw error;
  }
}

async function invokeServiceSync({
  runtime,
  requestId,
  payload = {},
  timeoutMs,
  signal,
  executeWithAdmission,
  recordLifecycle = true
}) {
  const result = await executeWithAdmission({
    providerName: runtime.providerName,
    requestId,
    signal,
    execute: () => withInvocationDeadline({
      timeoutMs, signal,
      invoke: () => runtime.adapter.invokeSync({
        serviceId: runtime.service.id,
        requestId,
        payload,
        timeoutMs,
        ...(signal ? { signal } : {})
      })
    })
  });

  signal?.throwIfAborted();
  return normalizeResult({ runtime, result, recordLifecycle });
}

async function invokeServiceStream({
  runtime,
  requestId,
  payload = {},
  timeoutMs,
  signal,
  onChunk,
  executeWithAdmission,
  recordLifecycle = true
}) {
  const result = await executeWithAdmission({
    providerName: runtime.providerName,
    requestId,
    signal,
    execute: () => withInvocationDeadline({
      timeoutMs, signal, onChunk,
      invoke: guardedChunk => runtime.adapter.invokeStream({
        serviceId: runtime.service.id,
        requestId,
        payload,
        timeoutMs,
        ...(signal ? { signal } : {}),
        onChunk: guardedChunk
      })
    })
  });

  signal?.throwIfAborted();
  return normalizeResult({ runtime, result, recordLifecycle });
}

module.exports = {
  invokeServiceSync,
  invokeServiceStream
};
