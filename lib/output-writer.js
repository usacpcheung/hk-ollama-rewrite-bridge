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

function createStreamWriter(res) {
  let doneSent = false;
  let usage = null;

  const writeChunk = (payload) => {
    if (res.writableEnded) {
      return;
    }

    res.write(`${JSON.stringify(payload)}\n`);
    if (typeof res.flush === 'function') {
      res.flush();
    }
  };

  const setUsage = (nextUsage) => {
    usage = nextUsage || usage;
  };

  const writeDone = (extra = {}) => {
    if (doneSent) {
      return;
    }

    doneSent = true;
    writeChunk({
      response: '',
      done: true,
      ...(usage ? { usage } : {}),
      ...extra
    });
  };

  const writeError = (errorPayload) => {
    if (doneSent) {
      return;
    }

    doneSent = true;
    writeChunk({ done: true, error: errorPayload });
  };

  return {
    writeChunk,
    writeDone,
    writeError,
    setUsage,
    isDoneSent: () => doneSent
  };
}

module.exports = {
  writeJsonError,
  writeJsonSuccess,
  setStreamHeaders,
  createStreamWriter
};
