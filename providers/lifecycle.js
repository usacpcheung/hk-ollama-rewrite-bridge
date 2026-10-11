function createNoopLifecycle({ providerName = 'unknown', serviceId = 'unknown', availability = () => null } = {}) {
  return {
    mode: 'none',
    providerName,
    serviceId,
    async checkReadiness() {
      if (serviceId !== 'rewrite') return { ready: null, error: null };
      const error = availability();
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
      const unavailable = availability();
      if (unavailable) return Promise.resolve({ ready: false, error: unavailable.code });
      return adapter.checkReadiness({ timeoutMs });
    },
    async maybeWarmup({ nowMs = Date.now(), timeoutMs } = {}) {
      if (availability()) return { triggered: false };
      if (warmupInFlight || warmupWithinColdWindow(nowMs)) {
        return { triggered: false };
      }

      warmupInFlight = true;
      lastWarmupTriggerAtMs = nowMs;

      try {
        const warmupResult = await adapter.triggerWarmup({ timeoutMs });
        if (!warmupResult.ok) {
          lastWarmupResult = 'failed';
          lastWarmupError = warmupResult.error?.detail || 'warmup_fetch_failed';
          return { triggered: true, result: lastWarmupResult, error: lastWarmupError };
        }

        lastWarmupResult = 'success';
        lastWarmupError = null;
        return { triggered: true, result: lastWarmupResult, error: null };
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
    const unavailable = availability();
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
