const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProviderLifecycle,
  createPassiveRemoteLifecycle
} = require('../providers/lifecycle');

test('ollama rewrite lifecycle actively probes readiness and warmup through adapter', async () => {
  const calls = [];
  const lifecycle = createProviderLifecycle({
    providerName: 'ollama',
    serviceId: 'rewrite',
    adapter: {
      checkReadiness: async ({ timeoutMs }) => {
        calls.push(['checkReadiness', timeoutMs]);
        return { ready: true, error: null };
      },
      triggerWarmup: async ({ timeoutMs }) => {
        calls.push(['triggerWarmup', timeoutMs]);
        return { ok: true, data: null };
      }
    },
    options: {
      warmupRetriggerWindowMs: 10_000
    }
  });

  assert.equal(lifecycle.mode, 'active_probe');
  assert.deepEqual(await lifecycle.checkReadiness({ timeoutMs: 123 }), { ready: true, error: null });
  assert.deepEqual(await lifecycle.maybeWarmup({ nowMs: 1_000, timeoutMs: 456 }), {
    triggered: true,
    result: 'success',
    error: null
  });
  assert.deepEqual(await lifecycle.maybeWarmup({ nowMs: 1_500, timeoutMs: 789 }), { triggered: false });
  assert.deepEqual(calls, [
    ['checkReadiness', 123],
    ['triggerWarmup', 456]
  ]);
  assert.equal(lifecycle.getDiagnostics().lastWarmupResult, 'success');
});

test('minimax rewrite lifecycle uses passive readiness without adapter calls', async () => {
  const lifecycle = createProviderLifecycle({
    providerName: 'minimax',
    serviceId: 'rewrite',
    adapter: {
      checkReadiness: async () => {
        throw new Error('must not actively probe minimax');
      },
      triggerWarmup: async () => {
        throw new Error('must not warm minimax');
      }
    },
    options: {
      minimaxApiKey: '',
      minimaxPassiveReadyGraceMs: 10_000,
      minimaxFailOpenOnIdle: true,
      minimaxConsecutiveFailureThreshold: 2,
      minimaxRecoveryAttemptCooldownMs: 5_000
    }
  });

  assert.equal(lifecycle.mode, 'passive_remote');
  assert.deepEqual(await lifecycle.checkReadiness({ nowMs: 1_000 }), {
    ready: false,
    reason: 'MINIMAX_API_KEY_MISSING'
  });
  assert.deepEqual(await lifecycle.maybeWarmup(), { triggered: false });
});

test('minimax passive lifecycle tracks failures, cooldown, success reset, and idle fail-open', () => {
  const lifecycle = createPassiveRemoteLifecycle({
    providerName: 'minimax',
    serviceId: 'rewrite',
    apiKey: 'test-key',
    passiveReadyGraceMs: 10_000,
    failOpenOnIdle: true,
    failureThreshold: 2,
    recoveryAttemptCooldownMs: 5_000
  });

  assert.deepEqual(lifecycle.getPassiveReadiness(1_000), { ready: true, reason: null });

  lifecycle.recordFailure({ nowMs: 2_000 });
  assert.deepEqual(lifecycle.getPassiveReadiness(2_100), { ready: true, reason: null });

  lifecycle.recordFailure({ nowMs: 3_000 });
  assert.deepEqual(lifecycle.getPassiveReadiness(3_100), {
    ready: false,
    reason: 'MINIMAX_RECENT_FAILURES'
  });

  assert.deepEqual(lifecycle.beginRecoveryAttempt({ nowMs: 3_100 }), {
    allowed: true,
    retryAfterSec: null
  });
  assert.deepEqual(lifecycle.beginRecoveryAttempt({ nowMs: 4_000 }), {
    allowed: false,
    retryAfterSec: 5
  });

  assert.deepEqual(lifecycle.getPassiveReadiness(14_000), {
    ready: true,
    reason: 'MINIMAX_IDLE_FAIL_OPEN'
  });

  lifecycle.recordSuccess({ nowMs: 15_000 });
  const diagnostics = lifecycle.getDiagnostics();
  assert.equal(diagnostics.lastSuccessAtMs, 15_000);
  assert.equal(diagnostics.consecutiveFailures, 0);
  assert.deepEqual(lifecycle.getPassiveReadiness(15_100), { ready: true, reason: null });
});

test('non-rewrite lifecycle defaults to no probe and no warmup', async () => {
  const lifecycle = createProviderLifecycle({
    providerName: 'minimax',
    serviceId: 't2a',
    adapter: {}
  });

  assert.equal(lifecycle.mode, 'none');
  assert.deepEqual(await lifecycle.checkReadiness(), { ready: null, error: null });
  assert.deepEqual(await lifecycle.maybeWarmup(), { triggered: false });
  assert.equal(lifecycle.getPassiveReadiness(), null);
  assert.deepEqual(lifecycle.getDiagnostics(), {});
});
