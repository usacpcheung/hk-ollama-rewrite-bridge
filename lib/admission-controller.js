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
  let inFlight = 0;
  const queue = [];

  const resolveLimits = (providerName) => {
    const providerKey = String(providerName || '').toLowerCase();
    const providerOverrides = providerOverridesByName[providerKey] || {};

    return {
      maxConcurrency: providerOverrides.maxConcurrency ?? globalLimits.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
      maxQueueSize: providerOverrides.maxQueueSize ?? globalLimits.maxQueueSize ?? DEFAULT_LIMITS.maxQueueSize,
      maxWaitMs: providerOverrides.maxWaitMs ?? globalLimits.maxWaitMs ?? DEFAULT_LIMITS.maxWaitMs
    };
  };

  const admitQueued = () => {
    while (queue.length > 0) {
      const next = queue[0];
      const limits = resolveLimits(next.providerName);
      if (inFlight >= limits.maxConcurrency) {
        return;
      }

      queue.shift();
      clearTimer(next.timerId);
      inFlight += 1;
      next.resolve({
        release: () => {
          if (next.released) {
            return;
          }

          next.released = true;
          inFlight = Math.max(0, inFlight - 1);
          admitQueued();
        },
        waitMs: Math.max(0, now() - next.enqueuedAt)
      });
    }
  };

  const acquire = ({ providerName, requestId } = {}) => {
    const limits = resolveLimits(providerName);

    if (inFlight < limits.maxConcurrency) {
      inFlight += 1;
      let released = false;

      return Promise.resolve({
        release: () => {
          if (released) {
            return;
          }

          released = true;
          inFlight = Math.max(0, inFlight - 1);
          admitQueued();
        },
        waitMs: 0
      });
    }

    if (queue.length >= limits.maxQueueSize) {
      return Promise.reject(
        createAdmissionError({
          reason: 'queue_full',
          message: 'Admission controller overloaded. Please retry shortly.',
          admission: {
            provider: providerName,
            maxConcurrency: limits.maxConcurrency,
            maxQueueSize: limits.maxQueueSize,
            maxWaitMs: limits.maxWaitMs,
            queueDepth: queue.length,
            inFlight
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

      entry.timerId = setTimer(() => {
        const queueIndex = queue.indexOf(entry);
        if (queueIndex >= 0) {
          queue.splice(queueIndex, 1);
        }

        reject(
          createAdmissionError({
            reason: 'wait_timeout',
            message: 'Admission controller overloaded. Please retry shortly.',
            admission: {
              provider: providerName,
              maxConcurrency: limits.maxConcurrency,
              maxQueueSize: limits.maxQueueSize,
              maxWaitMs: limits.maxWaitMs,
              queueDepth: queue.length,
              inFlight
            },
            requestId
          })
        );
      }, limits.maxWaitMs);

      queue.push(entry);
    });
  };

  return {
    acquire,
    getState: () => ({ inFlight, queueDepth: queue.length }),
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
