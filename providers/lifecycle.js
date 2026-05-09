function createNoopLifecycle({ providerName = 'unknown', serviceId = 'unknown' } = {}) {
  return {
    mode: 'none',
    providerName,
    serviceId,
    async checkReadiness() {
      return { ready: null, error: null };
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
  warmupRetriggerWindowMs
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
      return adapter.checkReadiness({ timeoutMs });
    },
    async maybeWarmup({ nowMs = Date.now(), timeoutMs } = {}) {
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
  apiKey,
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
    if (!apiKey) {
      return { ready: false, reason: 'MINIMAX_API_KEY_MISSING' };
    }

    const lastActivityAtMs = Math.max(lastSuccessAtMs, lastFailureAtMs, 0);
    const idleMs = lastActivityAtMs > 0 ? Math.max(0, nowMs - lastActivityAtMs) : null;
    const failuresAreStale =
      lastFailureAtMs === 0 || nowMs - lastFailureAtMs > passiveReadyGraceMs;

    if (consecutiveFailures >= failureThreshold) {
      if (failOpenOnIdle && (failuresAreStale || (idleMs !== null && idleMs > passiveReadyGraceMs))) {
        return { ready: true, reason: 'MINIMAX_IDLE_FAIL_OPEN' };
      }

      return { ready: false, reason: 'MINIMAX_RECENT_FAILURES' };
    }

    if (failOpenOnIdle && idleMs !== null && idleMs > passiveReadyGraceMs) {
      return { ready: true, reason: 'MINIMAX_IDLE_FAIL_OPEN' };
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

function createProviderLifecycle({
  providerName,
  serviceId,
  adapter,
  options = {}
}) {
  if (serviceId !== 'rewrite') {
    return createNoopLifecycle({ providerName, serviceId });
  }

  if (providerName === 'ollama') {
    return createActiveProbeLifecycle({
      providerName,
      serviceId,
      adapter,
      warmupRetriggerWindowMs: options.warmupRetriggerWindowMs
    });
  }

  if (providerName === 'minimax') {
    return createPassiveRemoteLifecycle({
      providerName,
      serviceId,
      apiKey: options.minimaxApiKey,
      passiveReadyGraceMs: options.minimaxPassiveReadyGraceMs,
      failOpenOnIdle: options.minimaxFailOpenOnIdle,
      failureThreshold: options.minimaxConsecutiveFailureThreshold,
      recoveryAttemptCooldownMs: options.minimaxRecoveryAttemptCooldownMs
    });
  }

  return createNoopLifecycle({ providerName, serviceId });
}

module.exports = {
  createProviderLifecycle,
  createNoopLifecycle,
  createActiveProbeLifecycle,
  createPassiveRemoteLifecycle
};
