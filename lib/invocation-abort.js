// A provider deadline and a caller cancellation share one fetch/SDK signal.
// Dispose only after invocation settles, so admission continues to own the work.
function createInvocationAbort(signal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return {
    controller,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Also close unread response bodies after errors or a terminal stream frame.
      controller.abort();
    }
  };
}

function createRequestCancellation(req, res) {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  const dispose = () => {
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  if (req.aborted || res.destroyed) cancel();
  return { signal: controller.signal, dispose };
}

module.exports = { createInvocationAbort, createRequestCancellation };
