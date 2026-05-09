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
  executeWithAdmission,
  recordLifecycle = true
}) {
  const result = await executeWithAdmission({
    providerName: runtime.providerName,
    requestId,
    execute: () => runtime.adapter.invokeSync({
      serviceId: runtime.service.id,
      requestId,
      payload,
      timeoutMs
    })
  });

  return normalizeResult({ runtime, result, recordLifecycle });
}

async function invokeServiceStream({
  runtime,
  requestId,
  payload = {},
  timeoutMs,
  onChunk,
  executeWithAdmission,
  recordLifecycle = true
}) {
  const result = await executeWithAdmission({
    providerName: runtime.providerName,
    requestId,
    execute: () => runtime.adapter.invokeStream({
      serviceId: runtime.service.id,
      requestId,
      payload,
      timeoutMs,
      onChunk
    })
  });

  return normalizeResult({ runtime, result, recordLifecycle });
}

module.exports = {
  invokeServiceSync,
  invokeServiceStream
};
