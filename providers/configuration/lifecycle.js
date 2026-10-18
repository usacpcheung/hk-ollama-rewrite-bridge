const { createLifecycleReaders } = require('../../configuration/lifecycle-values');
function ollamaLifecycle({ env = process.env, legacy = {} } = {}) {
  const { parseDeprecatedEnvMilliseconds } = createLifecycleReaders(env);
  const OLLAMA_PS_CACHE_MS = parseDeprecatedEnvMilliseconds(
    'REWRITE_OLLAMA_READINESS_CACHE_MS',
    ['OLLAMA_PS_CACHE_MS', 'WARMUP_PS_CACHE_MS'],
    2_000,
    { max: 30_000 }
  );
  // Deprecated env aliases kept for one compatibility window.
  // Prefer REWRITE_OLLAMA_READINESS_TIMEOUT_MS. Remove after production env files have migrated.
  const OLLAMA_PS_TIMEOUT_MS = parseDeprecatedEnvMilliseconds(
    'REWRITE_OLLAMA_READINESS_TIMEOUT_MS',
    ['OLLAMA_PS_TIMEOUT_MS', 'WARMUP_PS_TIMEOUT_MS'],
    1_000,
    { max: 10_000 }
  );
  const WARMUP_TRIGGER_TIMEOUT_MS = parseDeprecatedEnvMilliseconds(
    'REWRITE_OLLAMA_WARMUP_TRIGGER_TIMEOUT_MS',
    ['WARMUP_TRIGGER_TIMEOUT_MS'],
    60_000,
    { max: 300_000 }
  );
  // Deprecated env alias kept for one compatibility window.
  // Prefer REWRITE_OLLAMA_WARMUP_RETRIGGER_WINDOW_MS. Remove after production env files have migrated.
  const WARMUP_RETRIGGER_WINDOW_MS = parseDeprecatedEnvMilliseconds(
    'REWRITE_OLLAMA_WARMUP_RETRIGGER_WINDOW_MS',
    ['WARMUP_RETRIGGER_WINDOW_MS'],
    10_000,
    { max: 120_000 }
  );

  return { readinessCacheMs: OLLAMA_PS_CACHE_MS, readinessTimeoutMs: OLLAMA_PS_TIMEOUT_MS,
    warmupTimeoutMs: WARMUP_TRIGGER_TIMEOUT_MS,
    warmupRetriggerWindowMs: legacy.warmupRetriggerWindowMs ?? WARMUP_RETRIGGER_WINDOW_MS };
}
function minimaxAvailability({ env = process.env, minimaxApiKey, serviceConfig }) {
  return (minimaxApiKey ?? env.MINIMAX_API_KEY) ? null : { status: 503, code: 'MINIMAX_API_KEY_MISSING',
    message: `Minimax API key is missing; set MINIMAX_API_KEY to enable ${serviceConfig.id} requests.` };
}
function minimaxLifecycle({ env = process.env, legacy = {} } = {}) {
  const { parseDeprecatedEnvMilliseconds, parseDeprecatedEnvBoolean, parseDeprecatedEnvBoundedInteger, parseEnvMilliseconds } = createLifecycleReaders(env);
  const MINIMAX_PASSIVE_READY_GRACE_MS = parseDeprecatedEnvMilliseconds(
    'REWRITE_MINIMAX_PASSIVE_READY_GRACE_MS',
    ['MINIMAX_PASSIVE_READY_GRACE_MS'],
    10 * 60_000,
    { max: 24 * 60 * 60_000 }
  );
  // Deprecated env alias kept for one compatibility window.
  // Prefer REWRITE_MINIMAX_PASSIVE_FAIL_OPEN_ON_IDLE. Remove after production env files have migrated.
  const MINIMAX_FAIL_OPEN_ON_IDLE = parseDeprecatedEnvBoolean(
    'REWRITE_MINIMAX_PASSIVE_FAIL_OPEN_ON_IDLE',
    ['MINIMAX_FAIL_OPEN_ON_IDLE'],
    true
  );
  // Deprecated env alias kept for one compatibility window.
  // Prefer REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD. Remove after production env files have migrated.
  const MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD =
    parseDeprecatedEnvBoundedInteger('REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD', [
      'MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD'
    ], null, {
      min: 1,
      max: 100
    }) || 3;
  // Deprecated env alias kept for one compatibility window.
  // Prefer REWRITE_MINIMAX_PASSIVE_RECOVERY_COOLDOWN_MS. Remove after production env files have migrated.
  const MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS = parseDeprecatedEnvMilliseconds(
    'REWRITE_MINIMAX_PASSIVE_RECOVERY_COOLDOWN_MS',
    ['MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS'],
    15_000,
    { max: 10 * 60_000 }
  );

  return { readinessTimeoutMs: parseEnvMilliseconds('MINIMAX_READINESS_TIMEOUT_MS', 5000, { max: 30000 }),
    passiveReadyGraceMs: legacy.minimaxPassiveReadyGraceMs ?? MINIMAX_PASSIVE_READY_GRACE_MS,
    failOpenOnIdle: legacy.minimaxFailOpenOnIdle ?? MINIMAX_FAIL_OPEN_ON_IDLE,
    failureThreshold: legacy.minimaxConsecutiveFailureThreshold ?? MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD,
    recoveryAttemptCooldownMs: legacy.minimaxRecoveryAttemptCooldownMs ?? MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS,
    reasons: { recentFailures: 'MINIMAX_RECENT_FAILURES', idle: 'MINIMAX_IDLE_FAIL_OPEN', notReady: 'MINIMAX_NOT_READY' },
    recoveryError: retryAfterSec => ({ status: 429, code: 'MINIMAX_RECOVERY_COOLDOWN',
      message: `Minimax recovery attempt cooldown active, retry after ${retryAfterSec} seconds.` }) };
}
module.exports = { ollamaLifecycle, minimaxLifecycle, minimaxAvailability };
