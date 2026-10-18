const DEFAULT_LIMITS = Object.freeze({
  maxConcurrency: 4,
  maxQueueSize: 100,
  maxWaitMs: 15_000
});

function createAdmissionError({ reason, message, admission, requestId }) {
  const error = new Error(message);
  error.status = 503;
  error.code = 'ADMISSION_OVERLOADED';
  error.reason = reason;
  error.admission = admission;
  error.requestId = requestId;
  return error;
}

function createAdmissionController({
  globalLimits = {},
  providerOverridesByName = {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timerId) => clearTimeout(timerId)
} = {}) {
  const stateByProvider = new Map();

  const normalizeProviderName = (providerName) => String(providerName || 'default').toLowerCase();

  const getProviderState = (providerName) => {
    const providerKey = normalizeProviderName(providerName);
    let providerState = stateByProvider.get(providerKey);
    if (!providerState) {
      providerState = {
        inFlight: 0,
        queue: []
      };
      stateByProvider.set(providerKey, providerState);
    }

    return providerState;
  };

  const resolveLimits = (providerName) => {
    const providerKey = normalizeProviderName(providerName);
    const providerOverrides = providerOverridesByName[providerKey] || {};

    return {
      maxConcurrency: providerOverrides.maxConcurrency ?? globalLimits.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
      maxQueueSize: providerOverrides.maxQueueSize ?? globalLimits.maxQueueSize ?? DEFAULT_LIMITS.maxQueueSize,
      maxWaitMs: providerOverrides.maxWaitMs ?? globalLimits.maxWaitMs ?? DEFAULT_LIMITS.maxWaitMs
    };
  };

  const admitQueued = (providerName) => {
    const providerState = getProviderState(providerName);
    while (providerState.queue.length > 0) {
      const next = providerState.queue[0];
      const limits = resolveLimits(next.providerName);
      if (providerState.inFlight >= limits.maxConcurrency) {
        return;
      }

      providerState.queue.shift();
      next.cleanup();
      providerState.inFlight += 1;
      next.resolve({
        release: () => {
          if (next.released) {
            return;
          }

          next.released = true;
          providerState.inFlight = Math.max(0, providerState.inFlight - 1);
          admitQueued(next.providerName);
        },
        waitMs: Math.max(0, now() - next.enqueuedAt)
      });
    }
  };

  const acquire = ({ providerName, requestId, signal } = {}) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const limits = resolveLimits(providerName);
    const providerState = getProviderState(providerName);

    if (providerState.inFlight < limits.maxConcurrency) {
      providerState.inFlight += 1;
      let released = false;

      return Promise.resolve({
        release: () => {
          if (released) {
            return;
          }

          released = true;
          providerState.inFlight = Math.max(0, providerState.inFlight - 1);
          admitQueued(providerName);
        },
        waitMs: 0
      });
    }

    if (providerState.queue.length >= limits.maxQueueSize) {
      return Promise.reject(
        createAdmissionError({
          reason: 'queue_full',
          message: 'Admission controller overloaded. Please retry shortly.',
          admission: {
            provider: providerName,
            maxConcurrency: limits.maxConcurrency,
            maxQueueSize: limits.maxQueueSize,
            maxWaitMs: limits.maxWaitMs,
            queueDepth: providerState.queue.length,
            inFlight: providerState.inFlight
          },
          requestId
        })
      );
    }

    return new Promise((resolve, reject) => {
      const entry = {
        providerName,
        enqueuedAt: now(),
        released: false,
        resolve,
        reject,
        timerId: null
      };

      entry.cleanup = () => {
        clearTimer(entry.timerId);
        signal?.removeEventListener('abort', cancel);
      };
      const remove = () => {
        const index = providerState.queue.indexOf(entry);
        if (index < 0) return false; // Already admitted/cancelled/timed out.
        providerState.queue.splice(index, 1);
        entry.cleanup();
        return true;
      };
      const cancel = () => { if (remove()) reject(signal.reason); };
      entry.timerId = setTimer(() => {
        if (!remove()) return;

        reject(
          createAdmissionError({
            reason: 'wait_timeout',
            message: 'Admission controller overloaded. Please retry shortly.',
            admission: {
              provider: providerName,
              maxConcurrency: limits.maxConcurrency,
              maxQueueSize: limits.maxQueueSize,
              maxWaitMs: limits.maxWaitMs,
              queueDepth: providerState.queue.length,
              inFlight: providerState.inFlight
            },
            requestId
          })
        );
      }, limits.maxWaitMs);

      providerState.queue.push(entry);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  };

  const getState = () => {
    let inFlight = 0;
    let queueDepth = 0;
    const byProvider = {};

    for (const [providerName, providerState] of stateByProvider.entries()) {
      inFlight += providerState.inFlight;
      queueDepth += providerState.queue.length;
      byProvider[providerName] = {
        inFlight: providerState.inFlight,
        queueDepth: providerState.queue.length
      };
    }

    return { inFlight, queueDepth, byProvider };
  };

  return {
    acquire,
    getState,
    resolveLimits
  };
}

function isAdmissionOverloadError(error) {
  return Boolean(error && error.code === 'ADMISSION_OVERLOADED');
}

module.exports = {
  createAdmissionController,
  isAdmissionOverloadError
};
