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
    execute: () => runtime.adapter.invokeSync({
      serviceId: runtime.service.id,
      requestId,
      payload,
      timeoutMs,
      ...(signal ? { signal } : {})
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
    execute: () => runtime.adapter.invokeStream({
      serviceId: runtime.service.id,
      requestId,
      payload,
      timeoutMs,
      ...(signal ? { signal } : {}),
      onChunk
    })
  });

  signal?.throwIfAborted();
  return normalizeResult({ runtime, result, recordLifecycle });
}

module.exports = {
  invokeServiceSync,
  invokeServiceStream
};
