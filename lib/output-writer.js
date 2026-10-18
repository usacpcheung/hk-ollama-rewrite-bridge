function writeJsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    ...extra
  });
}

function writeJsonSuccess(res, payload = {}) {
  return res.json({ ok: true, ...payload });
}

function setStreamHeaders(res) {
  res.status(200);
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

// Limit queued output even if a caller forgets to await a write. Provider frame
// parsing has the same 1 MiB bound. A blocked client gets at most 30s to drain.
function createStreamWriter(res, { signal: requestSignal, maxBufferedBytes = 1024 * 1024, drainTimeoutMs = 30_000 } = {}) {
  let doneSent = false;
  let usage = null;
  let pending = false;

  const write = (payload, { signal } = {}) => {
    if (res.writableEnded || res.destroyed) return;
    const line = `${JSON.stringify(payload)}\n`;
    if (pending || Buffer.byteLength(line) + (res.writableLength || 0) > maxBufferedBytes) {
      res.destroy();
      throw Object.assign(new Error('Stream output buffer limit exceeded'), { code: 'STREAM_OUTPUT_LIMIT' });
    }
    const signals = [...new Set([requestSignal, signal].filter(Boolean))];
    for (const active of signals) active.throwIfAborted();
    const writable = res.write(line);
    if (typeof res.flush === 'function') res.flush();
    if (writable !== false) return;
    pending = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        res.removeListener('drain', drained);
        res.removeListener('close', closed);
        res.removeListener('error', failed);
        for (const active of signals) active.removeEventListener('abort', aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        pending = false;
        cleanup();
        if (error) { res.destroy(); reject(error); }
        else resolve();
      };
      const drained = () => finish();
      const closed = () => finish(new DOMException('Client disconnected', 'AbortError'));
      const failed = error => finish(error);
      const aborted = () => finish(signals.find(active => active.aborted)?.reason);
      res.once('drain', drained);
      res.once('close', closed);
      res.once('error', failed);
      for (const active of signals) active.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => finish(new DOMException('Stream drain timed out', 'AbortError')), drainTimeoutMs);
      if (res.destroyed) closed();
      else if (signals.some(active => active.aborted)) aborted();
      else if (res.writableNeedDrain === false) drained();
    });
  };

  const setUsage = nextUsage => { usage = nextUsage || usage; };
  const writeChunk = (payload, options) => {
    if (!doneSent) return write(payload, options);
  };
  const writeDone = (extra = {}, options) => {
    if (doneSent) return;
    const pendingWrite = write({ response: '', done: true, ...(usage ? { usage } : {}), ...extra }, options);
    doneSent = true;
    return pendingWrite;
  };
  const writeError = (errorPayload, options) => {
    if (doneSent) return;
    const pendingWrite = write({ done: true, error: errorPayload }, options);
    doneSent = true;
    return pendingWrite;
  };

  return { writeChunk, writeDone, writeError, setUsage, isDoneSent: () => doneSent };
}

module.exports = {
  writeJsonError,
  writeJsonSuccess,
  setStreamHeaders,
  createStreamWriter
};
