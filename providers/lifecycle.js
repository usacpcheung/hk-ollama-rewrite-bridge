const { performance } = require('node:perf_hooks');
const { readProviderAvailability } = require('../lib/provider-availability');
function createNoopLifecycle({ providerName = 'unknown', serviceId = 'unknown', availability = () => null } = {}) {
  return {
    mode: 'none',
    providerName,
    serviceId,
    async checkReadiness() {
      if (serviceId !== 'rewrite') return { ready: null, error: null };
      const error = readProviderAvailability(availability);
      return { ready: error ? false : serviceId === 'rewrite' ? true : null, error: error?.code || null };
    },
    async maybeWarmup() {
      return { triggered: false };
    },
    getPassiveReadiness() {
      return null;
    },
    recordSuccess() {},
    recordFailure() {},
    beginRecoveryAttempt() {
      return { allowed: true, retryAfterSec: null };
    },
    getDiagnostics() {
      return {};
    }
  };
}

function createActiveProbeLifecycle({
  providerName,
  serviceId,
  adapter,
  warmupRetriggerWindowMs,
  availability = () => null
}) {
  let readinessInFlight = null;
  let lastWarmupTriggerAtMs = 0;
  let warmupInFlight = false;
  let lastWarmupResult = null;
  let lastWarmupError = null;

  function warmupWithinColdWindow(nowMs) {
    return lastWarmupTriggerAtMs > 0 && nowMs - lastWarmupTriggerAtMs < warmupRetriggerWindowMs;
  }

  return {
    mode: 'active_probe',
    providerName,
    serviceId,
    checkReadiness({ timeoutMs } = {}) {
      const unavailable = readProviderAvailability(availability);
      if (unavailable) return Promise.resolve({ ready: false, error: unavailable.code });
      // All status/request/startup callers share one probe. An older response
      // therefore cannot arrive after, and overwrite, a newer observation.
      if (!readinessInFlight) {
        const deadline = Number.isFinite(timeoutMs) ? performance.now() + timeoutMs : Infinity;
        readinessInFlight = Promise.resolve().then(() => adapter.checkReadiness({ timeoutMs }))
          .then(result => {
            const unavailable = readProviderAvailability(availability);
            if (unavailable) return { ready: false, error: unavailable.code };
            if (performance.now() >= deadline) throw new Error('Probe deadline exceeded');
            if (!result || ![true, false, null].includes(result.ready)) throw new TypeError('Invalid readiness');
            return result;
          })
          .catch(() => ({ ready: null, error: 'PROVIDER_PROBE_UNAVAILABLE' }))
          .finally(() => { readinessInFlight = null; });
      }
      return readinessInFlight;
    },
    async maybeWarmup({ nowMs = Date.now(), timeoutMs } = {}) {
      if (readProviderAvailability(availability)) return { triggered: false };
      if (warmupInFlight || warmupWithinColdWindow(nowMs)) {
        return { triggered: false };
      }

      warmupInFlight = true;
      lastWarmupTriggerAtMs = nowMs;

      const deadline = Number.isFinite(timeoutMs) ? performance.now() + timeoutMs : Infinity;
      try {
        const warmupResult = await adapter.triggerWarmup({ timeoutMs });
        if (performance.now() >= deadline) throw new Error('Warmup deadline exceeded');
        if (!warmupResult.ok) {
          lastWarmupResult = 'failed';
          lastWarmupError = warmupResult.error?.detail || 'warmup_fetch_failed';
          return { triggered: true, result: lastWarmupResult, error: lastWarmupError };
        }

        lastWarmupResult = 'success';
        lastWarmupError = null;
        return { triggered: true, result: lastWarmupResult, error: null };
      } catch {
        lastWarmupResult = 'failed';
        lastWarmupError = 'PROVIDER_WARMUP_FAILED';
        return { triggered: true, result: lastWarmupResult, error: lastWarmupError };
      } finally {
        warmupInFlight = false;
      }
    },
    getPassiveReadiness() {
      return null;
    },
    recordSuccess() {},
    recordFailure() {},
    beginRecoveryAttempt() {
      return { allowed: true, retryAfterSec: null };
    },
    getDiagnostics() {
      return {
        warmupInFlight,
        lastWarmupTriggerAtMs,
        lastWarmupResult,
        lastWarmupError
      };
    }
  };
}

function createPassiveRemoteLifecycle({
  providerName,
  serviceId,
  availability = () => null,
  reasons = { recentFailures: 'PROVIDER_RECENT_FAILURES', idle: 'PROVIDER_IDLE_FAIL_OPEN' },
  passiveReadyGraceMs = 10 * 60_000,
  failOpenOnIdle = true,
  failureThreshold = 3,
  recoveryAttemptCooldownMs = 15_000
}) {
  let lastSuccessAtMs = 0;
  let lastFailureAtMs = 0;
  let consecutiveFailures = 0;
  let lastRecoveryAttemptAtMs = 0;

  function getPassiveReadiness(nowMs = Date.now()) {
    const unavailable = readProviderAvailability(availability);
    if (unavailable) return { ready: false, reason: unavailable.code };

    const lastActivityAtMs = Math.max(lastSuccessAtMs, lastFailureAtMs, 0);
    const idleMs = lastActivityAtMs > 0 ? Math.max(0, nowMs - lastActivityAtMs) : null;
    const failuresAreStale =
      lastFailureAtMs === 0 || nowMs - lastFailureAtMs > passiveReadyGraceMs;

    if (consecutiveFailures >= failureThreshold) {
      if (failOpenOnIdle && (failuresAreStale || (idleMs !== null && idleMs > passiveReadyGraceMs))) {
        return { ready: true, reason: reasons.idle };
      }

      return { ready: false, reason: reasons.recentFailures };
    }

    if (failOpenOnIdle && idleMs !== null && idleMs > passiveReadyGraceMs) {
      return { ready: true, reason: reasons.idle };
    }

    return { ready: true, reason: null };
  }

  return {
    mode: 'passive_remote',
    providerName,
    serviceId,
    async checkReadiness({ nowMs = Date.now() } = {}) {
      return getPassiveReadiness(nowMs);
    },
    async maybeWarmup() {
      return { triggered: false };
    },
    getPassiveReadiness,
    recordSuccess({ nowMs = Date.now() } = {}) {
      lastSuccessAtMs = nowMs;
      consecutiveFailures = 0;
    },
    recordFailure({ nowMs = Date.now() } = {}) {
      lastFailureAtMs = nowMs;
      consecutiveFailures += 1;
    },
    beginRecoveryAttempt({ nowMs = Date.now() } = {}) {
      const cooldownRemainingMs =
        lastRecoveryAttemptAtMs > 0
          ? recoveryAttemptCooldownMs - (nowMs - lastRecoveryAttemptAtMs)
          : 0;

      if (cooldownRemainingMs > 0) {
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil(cooldownRemainingMs / 1000))
        };
      }

      lastRecoveryAttemptAtMs = nowMs;
      return { allowed: true, retryAfterSec: null };
    },
    getDiagnostics() {
      return {
        lastSuccessAtMs,
        lastFailureAtMs,
        consecutiveFailures,
        lastRecoveryAttemptAtMs
      };
    }
  };
}

function createProviderLifecycle({ providerName, serviceId, adapter, mode = 'none', options = {} }) {
  let lifecycle;
  if (mode === 'active_probe') lifecycle = createActiveProbeLifecycle({ providerName, serviceId, adapter, ...options });
  else if (mode === 'passive_remote') lifecycle = createPassiveRemoteLifecycle({ providerName, serviceId, ...options });
  else if (mode === 'none') lifecycle = createNoopLifecycle({ providerName, serviceId, ...options });
  else throw new TypeError(`Unsupported lifecycle mode: ${mode}`);
  return Object.assign(lifecycle, {
    settings: options,
    canRecover: readiness => readiness?.reason === (options.reasons?.recentFailures || 'PROVIDER_RECENT_FAILURES'),
    recoveryError: options.recoveryError || (retryAfterSec => ({ status: 429, code: 'PROVIDER_RECOVERY_COOLDOWN',
      message: `Provider recovery cooldown active, retry after ${retryAfterSec} seconds.` }))
  });
}

module.exports = {
  createProviderLifecycle,
  createNoopLifecycle,
  createActiveProbeLifecycle,
  createPassiveRemoteLifecycle
};
