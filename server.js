const express = require('express');
const crypto = require('crypto');
const { createProvider, createProviderLifecycle, PROVIDER_CAPABILITIES } = require('./providers');
const { createProviderAdapter } = require('./lib/provider-adapter');
const { createServiceRuntimes } = require('./lib/service-runtime');
const { createServiceRegistry } = require('./services');
const { createRewriteHeaderAuth } = require('./auth/header-auth');
const { createClientIdentityResolver } = require('./auth/client-identity');
const { createRateLimitMiddlewares } = require('./middleware/rate-limit');
const { createDebugLogger } = require('./providers/debug-logger');
const { createAdmissionController, isAdmissionOverloadError } = require('./lib/admission-controller');
const {
  writeJsonError,
  writeJsonSuccess,
  setStreamHeaders,
  createStreamWriter
} = require('./lib/output-writer');

const app = express();
const HOST = '127.0.0.1';
const PORT = 3001;
const BRIDGE_INTERNAL_AUTH_SECRET = (process.env.BRIDGE_INTERNAL_AUTH_SECRET || '').trim();

function parseExpressTrustProxy(rawValue, fallback = 'loopback') {
  if (rawValue == null || String(rawValue).trim() === '') {
    return fallback;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  if (normalized === 'loopback') {
    return 'loopback';
  }

  const hopCount = parseBoundedInteger(normalized, { min: 1, max: 32 });
  if (hopCount != null) {
    return hopCount;
  }

  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'Invalid EXPRESS_TRUST_PROXY; using default',
      provided: rawValue,
      fallback
    })
  );
  return fallback;
}

const EXPRESS_TRUST_PROXY = parseExpressTrustProxy(process.env.EXPRESS_TRUST_PROXY, 'loopback');
app.set('trust proxy', EXPRESS_TRUST_PROXY);

function parseBoundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}


function parseEnvBoundedInteger(name, fallback, bounds = {}) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim() === '') {
    return fallback;
  }

  const parsed = parseBoundedInteger(rawValue, bounds);
  if (parsed == null) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: `Invalid ${name}; using default`,
        provided: rawValue,
        fallback
      })
    );
    return fallback;
  }

  return parsed;
}

function parseEnvMilliseconds(name, fallback, bounds = {}) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim() === '') {
    return fallback;
  }

  const parsed = parseBoundedInteger(rawValue, { min: 0, ...bounds });
  if (parsed == null) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: `Invalid ${name}; using default`,
        provided: rawValue,
        fallback
      })
    );
    return fallback;
  }

  return parsed;
}

function parseEnvBoolean(name, fallback = false) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim() === '') {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: `Invalid ${name}; using default`,
      provided: rawValue,
      fallback
    })
  );
  return fallback;
}

const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_PS_URL = process.env.OLLAMA_PS_URL || 'http://127.0.0.1:11434/api/ps';
const OLLAMA_PS_CACHE_MS = parseEnvMilliseconds(
  'OLLAMA_PS_CACHE_MS',
  parseEnvMilliseconds('WARMUP_PS_CACHE_MS', 2_000, { max: 30_000 }),
  { max: 30_000 }
);
const OLLAMA_PS_TIMEOUT_MS = parseEnvMilliseconds(
  'OLLAMA_PS_TIMEOUT_MS',
  parseEnvMilliseconds('WARMUP_PS_TIMEOUT_MS', 1_000, { max: 10_000 }),
  { max: 10_000 }
);
const MINIMAX_READINESS_TIMEOUT_MS = parseEnvMilliseconds('MINIMAX_READINESS_TIMEOUT_MS', 5_000, {
  max: 30_000
});
const T2A_INVOKE_TIMEOUT_MS = parseEnvMilliseconds('T2A_INVOKE_TIMEOUT_MS', 30_000, {
  min: 1_000,
  max: 300_000
});
const MINIMAX_PASSIVE_READY_GRACE_MS = parseEnvMilliseconds(
  'MINIMAX_PASSIVE_READY_GRACE_MS',
  10 * 60_000,
  { max: 24 * 60 * 60_000 }
);
const MINIMAX_FAIL_OPEN_ON_IDLE = parseEnvBoolean('MINIMAX_FAIL_OPEN_ON_IDLE', true);
const MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD =
  parseBoundedInteger(process.env.MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD, {
    min: 1,
    max: 100
  }) || 3;
const MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS = parseEnvMilliseconds(
  'MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS',
  15_000,
  { max: 10 * 60_000 }
);
const READY_REWRITE_STRICT_PROBE_MAX_AGE_MS = parseEnvMilliseconds(
  'READY_REWRITE_STRICT_PROBE_MAX_AGE_MS',
  Math.min(1_000, OLLAMA_PS_CACHE_MS),
  { max: 30_000 }
);
const WARMUP_TRIGGER_TIMEOUT_MS = parseEnvMilliseconds('WARMUP_TRIGGER_TIMEOUT_MS', 60_000, {
  max: 300_000
});
const WARMUP_RETRIGGER_WINDOW_MS = parseEnvMilliseconds('WARMUP_RETRIGGER_WINDOW_MS', 10_000, {
  max: 120_000
});
const WARMUP_ON_START = parseEnvBoolean('WARMUP_ON_START', true);
const WARMUP_STARTUP_MAX_WAIT_MS = parseEnvMilliseconds('WARMUP_STARTUP_MAX_WAIT_MS', 180_000, {
  max: 900_000
});
const WARMUP_STARTUP_RETRY_INTERVAL_MS = parseEnvMilliseconds(
  'WARMUP_STARTUP_RETRY_INTERVAL_MS',
  5_000,
  { max: 60_000 }
);
const MODEL_WARMING_RETRY_AFTER_SEC = parseBoundedInteger(process.env.WARMUP_RETRY_AFTER_SEC, {
  min: 1,
  max: 30
}) || Math.min(3, Math.max(2, Math.ceil(OLLAMA_PS_CACHE_MS / 1000)));
const REWRITE_DEBUG_RAW_OUTPUT = parseEnvBoolean('REWRITE_DEBUG_RAW_OUTPUT', false);


const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';

function parseRawBoundedInteger(rawValue, fallback, bounds = {}, envName = 'value') {
  if (rawValue == null || String(rawValue).trim() === '') {
    return fallback;
  }

  const parsed = parseBoundedInteger(rawValue, bounds);
  if (parsed == null) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: `Invalid ${envName}; using default`,
        provided: rawValue,
        fallback
      })
    );
    return fallback;
  }

  return parsed;
}

function parseRawMilliseconds(rawValue, fallback, bounds = {}, envName = 'value') {
  return parseRawBoundedInteger(rawValue, fallback, { min: 0, ...bounds }, envName);
}

const serviceRegistry = createServiceRegistry({
  parseEnvBoundedInteger: (rawValue, fallback, bounds = {}, envName = 'value') =>
    parseRawBoundedInteger(rawValue, fallback, bounds, envName),
  parseEnvMilliseconds: (rawValue, fallback, bounds = {}, envName = 'value') =>
    parseRawMilliseconds(rawValue, fallback, bounds, envName),
  providerCapabilities: PROVIDER_CAPABILITIES
});
const rewriteServiceDefinition = serviceRegistry.get('rewrite');

const debugLog = createDebugLogger({
  enabled: REWRITE_DEBUG_RAW_OUTPUT,
  defaultProvider: rewriteServiceDefinition.provider.selected
});

const serviceRuntimes = createServiceRuntimes({
  serviceRegistry,
  createProvider,
  createProviderAdapter,
  createLifecycle: createProviderLifecycle,
  createProviderOptions: () => ({
    ollamaUrl: OLLAMA_URL,
    ollamaPsUrl: OLLAMA_PS_URL,
    ollamaKeepAlive: OLLAMA_KEEP_ALIVE,
    minimaxApiKey: MINIMAX_API_KEY,
    minimaxSystemPrompt: rewriteServiceDefinition?.prompts?.minimaxSystemPrompt,
    minimaxUserTemplate: rewriteServiceDefinition?.prompts?.minimaxUserTemplate,
    debugLog
  }),
  createLifecycleOptions: () => ({
    minimaxApiKey: MINIMAX_API_KEY,
    minimaxPassiveReadyGraceMs: MINIMAX_PASSIVE_READY_GRACE_MS,
    minimaxFailOpenOnIdle: MINIMAX_FAIL_OPEN_ON_IDLE,
    minimaxConsecutiveFailureThreshold: MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD,
    minimaxRecoveryAttemptCooldownMs: MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS,
    warmupRetriggerWindowMs: WARMUP_RETRIGGER_WINDOW_MS
  })
});
const rewriteRuntime = serviceRuntimes.get('rewrite');
const t2aRuntime = serviceRuntimes.get('t2a');
const rewriteService = rewriteRuntime.service;
const t2aService = t2aRuntime.service;
const rewriteProviderAdapter = rewriteRuntime.adapter;
const t2aProviderAdapter = t2aRuntime.adapter;
const rewriteLifecycle = rewriteRuntime.lifecycle;

const admissionController = createAdmissionController({
  globalLimits: rewriteService.provider.admission?.global || {},
  providerOverridesByName: rewriteService.provider.admission?.byProvider || {}
});

let modelPhase = 'unknown';
let lastProbeAtMs = 0;
let lastProbeReady = null;
let lastWarmAt = null;
let lastError = null;
let serviceState = 'starting';
let startupWarmupAttempts = 0;
let startupWarmupDeadlineAtMs = null;


app.use(express.json({ limit: '16kb' }));

const resolveClientIdentity = createClientIdentityResolver({
  bridgeInternalAuthSecret: BRIDGE_INTERNAL_AUTH_SECRET,
  preferExpressIp: EXPRESS_TRUST_PROXY !== false
});

app.use(resolveClientIdentity);

const { policy: rateLimitPolicy, globalLimiter, rewriteLimiter, t2aLimiter, opsLimiter } = createRateLimitMiddlewares();
const OPS_ENDPOINTS = new Set(['/healthz', '/readyz']);

app.use((req, res, next) => {
  if (OPS_ENDPOINTS.has(req.path)) {
    return next();
  }

  return globalLimiter(req, res, next);
});

function errorResponse(res, status, code, message, extra = {}) {
  return writeJsonError(res, status, code, message, extra);
}

function admissionOverloadResponse(res, overloadError) {
  const admission = overloadError?.admission || {};
  return errorResponse(
    res,
    overloadError?.status || 503,
    overloadError?.code || 'ADMISSION_OVERLOADED',
    overloadError?.message || 'Admission controller overloaded. Please retry shortly.',
    {
      reason: overloadError?.reason || 'overloaded',
      admission
    }
  );
}

async function executeWithAdmission({ providerName, requestId, execute }) {
  const ticket = await admissionController.acquire({ providerName, requestId });
  try {
    return await execute({ waitMs: ticket.waitMs });
  } finally {
    ticket.release();
  }
}

function getRewriteLifecycleDiagnostics() {
  return rewriteLifecycle?.getDiagnostics?.() || {};
}

const logRewriteRequest = ({
  req,
  requestId,
  startedAt,
  email = null,
  inputLength = 0,
  requestPhase = modelPhase,
  selectedTimeoutMs = rewriteService.timeouts.coldMs,
  probeReady = lastProbeReady,
  probeError = null,
  warmupTriggeredNow = false,
  minimaxRecoveryAttempt = false,
  auth = null
}) => {
  const elapsedMs = Date.now() - startedAt;
  const probeAgeMs = lastProbeAtMs ? Math.max(0, Date.now() - lastProbeAtMs) : null;
  const lifecycleDiagnostics = getRewriteLifecycleDiagnostics();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const limiterKey = req.clientIdentity?.limiterKey || `ip:${ip}`;
  const limiterSource = req.clientIdentity?.source || 'ip';
  const limiterHeader = req.clientIdentity?.headerName || null;

  console.log(
    JSON.stringify({
      requestId,
      ip,
      limiterKey,
      limiterSource,
      limiterHeader,
      email,
      inputLength,
      elapsedMs,
      phase: requestPhase,
      selectedTimeoutMs,
      probeReady,
      probeAgeMs,
      probeError,
      warmupTriggeredNow,
      minimaxRecoveryAttempt,
      warmupInFlight: lifecycleDiagnostics.warmupInFlight || false,
      lastWarmupResult: lifecycleDiagnostics.lastWarmupResult || null,
      lastWarmupError: lifecycleDiagnostics.lastWarmupError || null,
      lastWarmupTriggerAtMs: lifecycleDiagnostics.lastWarmupTriggerAtMs || 0,
      auth
    })
  );
};

function logProviderResponseMeta({ requestId, stream, usage, doneReason }) {
  debugLog({
    requestId,
    stream,
    eventType: 'provider_response_meta',
    payload: {
      usage: usage || null,
      ...(doneReason ? { doneReason } : {})
    }
  });
}

const rewriteHeaderAuth = createRewriteHeaderAuth({
  bridgeInternalAuthSecret: BRIDGE_INTERNAL_AUTH_SECRET,
  errorResponse,
  onAuthFailure: (req, authFailure) => {
    logRewriteRequest({
      req,
      requestId: crypto.randomUUID(),
      startedAt: Date.now(),
      requestPhase: modelPhase,
      selectedTimeoutMs: rewriteService.timeouts.coldMs,
      probeReady: lastProbeReady,
      auth: {
        status: authFailure.status,
        code: authFailure.code
      }
    });
  }
});



function setLastError(code, message) {
  lastError = { code, message, at: new Date().toISOString() };
}

function promoteServiceReady() {
  modelPhase = 'ready';
  serviceState = 'ready';
}

function applyProbeState(probeReady, { demoteReadyOnUnknown = false } = {}) {
  if (probeReady === true) {
    promoteServiceReady();
    return;
  }

  if (probeReady === false && modelPhase === 'ready') {
    modelPhase = 'warming';
    return;
  }

  if (demoteReadyOnUnknown && probeReady === null && serviceState === 'ready') {
    modelPhase = 'warming';
  }
}

async function probeModelReady() {
  const timeoutMs = rewriteLifecycle.mode === 'passive_remote' ? MINIMAX_READINESS_TIMEOUT_MS : OLLAMA_PS_TIMEOUT_MS;
  return rewriteLifecycle.checkReadiness({ timeoutMs, nowMs: Date.now() });
}

async function triggerWarmupIfNeeded(nowMs) {
  const warmupResult = await rewriteLifecycle.maybeWarmup({
    nowMs,
    timeoutMs: WARMUP_TRIGGER_TIMEOUT_MS
  });
  return warmupResult.triggered === true;
}

function getRewritePassiveReadiness(nowMs = Date.now()) {
  return rewriteLifecycle.getPassiveReadiness?.(nowMs) || null;
}

function getWarmupLogFields() {
  const diagnostics = getRewriteLifecycleDiagnostics();
  return {
    lastWarmupResult: diagnostics.lastWarmupResult || null,
    lastWarmupError: diagnostics.lastWarmupError || null
  };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStartupWarmupLoop() {
  startupWarmupAttempts = 0;
  startupWarmupDeadlineAtMs = Date.now() + WARMUP_STARTUP_MAX_WAIT_MS;

  if (rewriteLifecycle.mode === 'passive_remote') {
    startupWarmupAttempts += 1;
    const passiveReadiness = getRewritePassiveReadiness(Date.now());

    if (passiveReadiness.ready) {
      promoteServiceReady();
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'Startup passive readiness evaluated',
          provider: rewriteLifecycle.providerName,
          serviceState,
          startupWarmupAttempts,
          startupWarmupDeadlineAt: new Date(startupWarmupDeadlineAtMs).toISOString(),
          passiveReady: true,
          passiveReason: passiveReadiness.reason
        })
      );
      return;
    }

    modelPhase = 'warming';
    serviceState = 'degraded';
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'Startup passive readiness evaluated',
        provider: rewriteLifecycle.providerName,
        serviceState,
        startupWarmupAttempts,
        startupWarmupDeadlineAt: new Date(startupWarmupDeadlineAtMs).toISOString(),
        passiveReady: false,
        passiveReason: passiveReadiness.reason || 'MINIMAX_NOT_READY'
      })
    );
    return;
  }

  while (Date.now() < startupWarmupDeadlineAtMs) {
    startupWarmupAttempts += 1;
    const attemptStartedAtMs = Date.now();
    const triggered = await triggerWarmupIfNeeded(attemptStartedAtMs);
    const probeResult = await probeModelReady();
    const warmupLogFields = getWarmupLogFields();

    lastProbeAtMs = Date.now();
    if (probeResult.ready !== null) {
      lastProbeReady = probeResult.ready;
    }

    if (probeResult.ready === true) {
      promoteServiceReady();
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'Startup warmup loop completed',
          serviceState,
          startupWarmupAttempts,
          startupWarmupDeadlineAt: new Date(startupWarmupDeadlineAtMs).toISOString(),
          warmupTriggered: triggered,
          probeReady: probeResult.ready,
          probeError: probeResult.error,
          ...warmupLogFields
        })
      );
      return;
    }

    if (modelPhase === 'unknown') {
      modelPhase = 'warming';
    }

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'Startup warmup attempt completed',
        serviceState,
        startupWarmupAttempts,
        startupWarmupDeadlineAt: new Date(startupWarmupDeadlineAtMs).toISOString(),
        warmupTriggered: triggered,
        probeReady: probeResult.ready,
        probeError: probeResult.error,
        ...warmupLogFields
      })
    );

    await delay(Math.max(0, WARMUP_STARTUP_RETRY_INTERVAL_MS - (Date.now() - attemptStartedAtMs)));
  }

  serviceState = 'degraded';
  const warmupLogFields = getWarmupLogFields();
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'Startup warmup loop exceeded max wait budget',
      serviceState,
      startupWarmupAttempts,
      startupWarmupDeadlineAt: startupWarmupDeadlineAtMs
        ? new Date(startupWarmupDeadlineAtMs).toISOString()
        : null,
      ...warmupLogFields,
      lastProbeReady
    })
  );
}

app.get('/model-status', async (_req, res) => {
  const nowMs = Date.now();
  let probeReady = lastProbeReady;
  const usesPassiveReadiness = rewriteLifecycle.mode === 'passive_remote';
  const minimaxPassiveReadiness = usesPassiveReadiness ? getRewritePassiveReadiness(nowMs) : null;

  if (!usesPassiveReadiness && nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
    const probeResult = await probeModelReady();
    lastProbeAtMs = Date.now();
    probeReady = probeResult.ready;
    if (probeResult.ready !== null) {
      lastProbeReady = probeResult.ready;
    }
  }

  if (usesPassiveReadiness) {
    if (minimaxPassiveReadiness.ready) {
      promoteServiceReady();
    } else {
      modelPhase = 'warming';
      serviceState = 'degraded';
    }
  } else {
    applyProbeState(probeReady);
  }

  const lifecycleDiagnostics = getRewriteLifecycleDiagnostics();
  const lastWarmupTriggerAtMs = lifecycleDiagnostics.lastWarmupTriggerAtMs || 0;
  const lastRecoveryAttemptAtMs = lifecycleDiagnostics.lastRecoveryAttemptAtMs || 0;
  let status = 'warming';
  if (serviceState === 'degraded') {
    status = 'degraded';
  } else if (modelPhase === 'ready') {
    status = lastError ? 'degraded' : 'ready';
  } else if (lastError) {
    status = 'degraded';
  } else if (serviceState === 'starting') {
    status = 'warming';
  }

  return res.json({
    status,
    serviceState,
    startupWarmupAttempts,
    startupWarmupDeadlineAt: startupWarmupDeadlineAtMs
      ? new Date(startupWarmupDeadlineAtMs).toISOString()
      : null,
    lastWarmAt,
    lastError,
    warmupInFlight: lifecycleDiagnostics.warmupInFlight || false,
    lastWarmupTriggerAt: lastWarmupTriggerAtMs ? new Date(lastWarmupTriggerAtMs).toISOString() : null,
    lastWarmupResult: lifecycleDiagnostics.lastWarmupResult || null,
    lastWarmupError: lifecycleDiagnostics.lastWarmupError || null,
    lastProbeReady,
    probeAgeMs: lastProbeAtMs ? Math.max(0, Date.now() - lastProbeAtMs) : null,
    minimaxPassiveReadiness: usesPassiveReadiness
      ? {
          ...minimaxPassiveReadiness,
          lastRewriteSuccessAt: lifecycleDiagnostics.lastSuccessAtMs
            ? new Date(lifecycleDiagnostics.lastSuccessAtMs).toISOString()
            : null,
          lastRewriteFailureAt: lifecycleDiagnostics.lastFailureAtMs
            ? new Date(lifecycleDiagnostics.lastFailureAtMs).toISOString()
            : null,
          consecutiveRewriteFailures: lifecycleDiagnostics.consecutiveFailures || 0,
          lastRecoveryAttemptAt: lastRecoveryAttemptAtMs
            ? new Date(lastRecoveryAttemptAtMs).toISOString()
            : null,
          recoveryAttemptCooldownMs: MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS,
          passiveReadyGraceMs: MINIMAX_PASSIVE_READY_GRACE_MS,
          failOpenOnIdle: MINIMAX_FAIL_OPEN_ON_IDLE,
          failureThreshold: MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD
        }
      : null
  });
});

app.get('/healthz', opsLimiter, (_req, res) => {
  return writeJsonSuccess(res);
});

app.get('/readyz', opsLimiter, async (_req, res) => {
  const nowMs = Date.now();
  let probeReady = lastProbeReady;
  const usesPassiveReadiness = rewriteLifecycle.mode === 'passive_remote';

  if (usesPassiveReadiness) {
    const passiveReadiness = getRewritePassiveReadiness(nowMs);
    if (passiveReadiness.ready) {
      promoteServiceReady();
      return writeJsonSuccess(res, { serviceState, reason: null });
    }

    modelPhase = 'warming';
    serviceState = 'degraded';
    return res
      .status(503)
      .json({ ok: false, serviceState, reason: passiveReadiness.reason || 'MINIMAX_NOT_READY' });
  }

  if (nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
    const probeResult = await probeModelReady();
    lastProbeAtMs = Date.now();
    probeReady = probeResult.ready;
    if (probeResult.ready !== null) {
      lastProbeReady = probeResult.ready;
    }
  }

  applyProbeState(probeReady);

  if (serviceState === 'ready') {
    if (probeReady === true) {
      return writeJsonSuccess(res, { serviceState, reason: null });
    }

    if (probeReady === false) {
      return res.status(503).json({ ok: false, serviceState, reason: 'MODEL_NOT_READY' });
    }

    return res.status(503).json({ ok: false, serviceState, reason: 'MODEL_PROBE_UNAVAILABLE' });
  }

  let reason = 'MODEL_NOT_READY';
  if (serviceState === 'starting') {
    reason = 'STARTING_WARMUP';
  } else if (serviceState === 'degraded') {
    reason = 'STARTUP_DEGRADED';
  }

  return res.status(503).json({ ok: false, serviceState, reason });
});

app.post(
  [rewriteService.routes.legacyPath, rewriteService.routes.futureApiPath],
  rewriteLimiter,
  rewriteHeaderAuth,
  async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let email = null;
  let inputLength = 0;
  let requestPhase = modelPhase;
  let selectedTimeoutMs = rewriteService.timeouts.coldMs;
  let probeReady = lastProbeReady;
  let probeError = null;
  let warmupTriggeredNow = false;
  let minimaxRecoveryAttempt = false;
  let minimaxPassiveReason = null;
  const isMinimax = rewriteService.provider.selected === 'minimax';
  const usesPassiveReadiness = rewriteLifecycle.mode === 'passive_remote';

  try {
    email = req.auth?.email || null;

    const validationResult = rewriteService.validateRequest({ body: req.body });
    if (!validationResult.ok) {
      return errorResponse(res, validationResult.status, validationResult.code, validationResult.message);
    }

    const { trimmedText, streamRequested, inputCharCount } = validationResult.value;
    inputLength = inputCharCount;

    if (streamRequested && !rewriteService.capabilities.streaming) {
      return errorResponse(
        res,
        501,
        'STREAMING_UNSUPPORTED',
        `Streaming is not supported for service "${rewriteService.id}" with provider "${rewriteService.provider.selected}".`
      );
    }

    const { prompt, systemPrompt, userContent } = rewriteService.buildPrompt({ text: trimmedText, isMinimax });

    const nowMs = Date.now();
    const probeAgeMs = lastProbeAtMs ? Math.max(0, nowMs - lastProbeAtMs) : Number.POSITIVE_INFINITY;
    const shouldForceFreshReadyProbe =
      serviceState === 'ready' &&
      (probeReady === null || probeAgeMs > READY_REWRITE_STRICT_PROBE_MAX_AGE_MS);

    if (!usesPassiveReadiness && (shouldForceFreshReadyProbe || nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS)) {
      const probeResult = await probeModelReady();
      lastProbeAtMs = Date.now();
      probeReady = probeResult.ready;
      probeError = probeResult.error;
      if (probeResult.ready !== null) {
        lastProbeReady = probeResult.ready;
      }
    }

    if (usesPassiveReadiness) {
      const passiveReadiness = getRewritePassiveReadiness(nowMs);
      probeReady = passiveReadiness.ready;
      minimaxPassiveReason = passiveReadiness.reason;
      probeError = minimaxPassiveReason;
      if (passiveReadiness.ready) {
        promoteServiceReady();
      } else {
        modelPhase = 'warming';
        serviceState = 'degraded';

        if (passiveReadiness.reason === 'MINIMAX_RECENT_FAILURES') {
          const recoveryAttempt = rewriteLifecycle.beginRecoveryAttempt({ nowMs });
          if (!recoveryAttempt.allowed) {
            const retryAfterSec = recoveryAttempt.retryAfterSec;
            res.set('Retry-After', String(retryAfterSec));
            return errorResponse(
              res,
              429,
              'MINIMAX_RECOVERY_COOLDOWN',
              `Minimax recovery attempt cooldown active, retry after ${retryAfterSec} seconds.`,
              { retryAfterSec }
            );
          }

          minimaxRecoveryAttempt = true;
        }
      }
    } else {
      applyProbeState(probeReady, { demoteReadyOnUnknown: true });

      if (probeReady !== true) {
        warmupTriggeredNow = await triggerWarmupIfNeeded(nowMs);

        const postWarmupProbe = await probeModelReady();
        probeReady = postWarmupProbe.ready;
        probeError = postWarmupProbe.error;
        lastProbeAtMs = Date.now();
        if (postWarmupProbe.ready !== null) {
          lastProbeReady = postWarmupProbe.ready;
        }

        applyProbeState(probeReady);
        if (probeReady !== true) {
          modelPhase = 'warming';
        }
      }
    }

    if (isMinimax && probeReady !== true && minimaxPassiveReason === 'MINIMAX_API_KEY_MISSING') {
      return errorResponse(
        res,
        503,
        'MINIMAX_API_KEY_MISSING',
        'Minimax API key is missing; set MINIMAX_API_KEY to enable rewrite requests.'
      );
    }

    requestPhase = modelPhase;
    selectedTimeoutMs = requestPhase === 'ready' ? rewriteService.timeouts.readyMs : rewriteService.timeouts.coldMs;

    if (serviceState === 'starting') {
      res.set('Retry-After', String(MODEL_WARMING_RETRY_AFTER_SEC));
      if (warmupTriggeredNow) {
        return errorResponse(
          res,
          202,
          'MODEL_WARMUP_STARTED',
          `Model wake-up started, retry after ${MODEL_WARMING_RETRY_AFTER_SEC} seconds.`,
          { retryAfterSec: MODEL_WARMING_RETRY_AFTER_SEC }
        );
      }

      return errorResponse(
        res,
        202,
        'MODEL_WARMING',
        `Model is warming up, retry after ${MODEL_WARMING_RETRY_AFTER_SEC} seconds.`,
        { retryAfterSec: MODEL_WARMING_RETRY_AFTER_SEC }
      );
    }

    if (serviceState === 'degraded' && !minimaxRecoveryAttempt) {
      return errorResponse(
        res,
        503,
        'MODEL_STARTUP_DEGRADED',
        'Model startup warm-up exceeded the configured wait budget. Please retry shortly and check service/Ollama status.',
        {
          serviceState,
          startupWarmupAttempts,
          startupWarmupDeadlineAt: startupWarmupDeadlineAtMs
            ? new Date(startupWarmupDeadlineAtMs).toISOString()
            : null
        }
      );
    }

    if (requestPhase !== 'ready' && !minimaxRecoveryAttempt) {
      res.set('Retry-After', String(MODEL_WARMING_RETRY_AFTER_SEC));
      return errorResponse(
        res,
        202,
        'MODEL_WARMING',
        `Model is warming up, retry after ${MODEL_WARMING_RETRY_AFTER_SEC} seconds.`,
        { retryAfterSec: MODEL_WARMING_RETRY_AFTER_SEC }
      );
    }

    const streamEnabled = streamRequested && rewriteService.capabilities.streaming;

    if (streamEnabled) {
      if (!rewriteProviderAdapter.hasStreamHandler({ serviceId: rewriteService.id })) {
        return errorResponse(
          res,
          501,
          'STREAMING_UNSUPPORTED',
          `Streaming is not supported for service "${rewriteService.id}" with provider "${rewriteService.provider.selected}".`
        );
      }

      setStreamHeaders(res);
      let streamedText = '';
      let streamedChunkEmitted = false;
      let streamDoneEmitted = false;
      let streamDoneReason = 'stop';
      let finalUsage = null;

      const streamWriter = createStreamWriter(res);

      let rewriteResult;
      try {
        rewriteResult = await executeWithAdmission({
          providerName: rewriteService.provider.selected,
          requestId,
          execute: () => rewriteProviderAdapter.invokeStream({
            serviceId: rewriteService.id,
            requestId,
            payload: {
              prompt,
              systemPrompt,
              userContent
            },
            timeoutMs: selectedTimeoutMs,
            onChunk: async (event) => {
              if (!event || typeof event !== 'object') {
                return;
              }

              if (event.type === 'error' && event.error && typeof event.error === 'object') {
                streamWriter.writeError(event.error);
                return;
              }

              if (event.type === 'text' && typeof event.text === 'string' && event.text.length > 0) {
                streamedText += event.text;
                streamedChunkEmitted = true;
                const processedChunk = rewriteService.postProcessOutput({ payload: { response: event.text } });
                streamWriter.writeChunk({ response: processedChunk?.response || '', done: false });
                return;
              }

              if (event.type === 'done') {
                if (event.usage) {
                  finalUsage = event.usage;
                  streamWriter.setUsage(finalUsage);
                }
                streamDoneReason = event.reason || streamDoneReason;
                streamDoneEmitted = true;
                streamWriter.writeDone(streamDoneReason ? { done_reason: streamDoneReason } : {});
              }
            }
          })
        });
      } catch (error) {
        if (isAdmissionOverloadError(error)) {
          streamWriter.writeError({
            code: error.code,
            message: error.message,
            status: error.status || 503,
            reason: error.reason,
            admission: error.admission || {}
          });
          return res.end();
        }

        throw error;
      }

      if (!rewriteResult.ok) {
        rewriteLifecycle.recordFailure({ nowMs: Date.now() });
        const mappedError = rewriteResult.error || rewriteProviderAdapter.mapError(new Error('unknown'));
        setLastError(mappedError.code, mappedError.message);
        streamWriter.writeError({
          code: mappedError.code,
          message: mappedError.message,
          status: mappedError.status || 502
        });
        return res.end();
      }

      modelPhase = 'ready';
      rewriteLifecycle.recordSuccess({ nowMs: Date.now() });
      lastWarmAt = new Date().toISOString();
      lastError = null;

      const finalResponse = (rewriteResult.data?.response || '').trim();
      finalUsage = rewriteResult.data?.usage || finalUsage;
      streamWriter.setUsage(finalUsage);
      logProviderResponseMeta({
        requestId,
        stream: true,
        usage: finalUsage,
        doneReason: rewriteResult.data?.doneReason || streamDoneReason || 'stop'
      });
      const streamResponse = finalResponse || streamedText.trim();
      if (streamResponse && !streamedChunkEmitted) {
        const processedStreamResponse = rewriteService.postProcessOutput({ payload: { response: streamResponse } });
        streamWriter.writeChunk({ response: processedStreamResponse?.response || '', done: false });
      }

      if (!streamDoneEmitted) {
        streamWriter.writeDone({ done_reason: rewriteResult.data?.doneReason || streamDoneReason || 'stop' });
      }
      return res.end();
    }

    let rewriteResult;
    try {
      rewriteResult = await executeWithAdmission({
        providerName: rewriteService.provider.selected,
        requestId,
        execute: () => rewriteProviderAdapter.invokeSync({
          serviceId: rewriteService.id,
          requestId,
          payload: {
            prompt,
            systemPrompt,
            userContent
          },
          timeoutMs: selectedTimeoutMs
        })
      });
    } catch (error) {
      if (isAdmissionOverloadError(error)) {
        return admissionOverloadResponse(res, error);
      }

      throw error;
    }
    if (!rewriteResult.ok) {
      rewriteLifecycle.recordFailure({ nowMs: Date.now() });
      const mappedError = rewriteResult.error || rewriteProviderAdapter.mapError(new Error('unknown'));
      if (mappedError.code === 'MODEL_TIMEOUT' && requestPhase !== 'ready') {
        setLastError(
          'MODEL_COLD_START_TIMEOUT',
          'Model is warming up and took too long to respond. Please retry shortly.'
        );
        return errorResponse(
          res,
          504,
          'MODEL_COLD_START_TIMEOUT',
          'Model is warming up and took too long to respond. Please retry shortly.'
        );
      }

      setLastError(mappedError.code, mappedError.message);
      return errorResponse(res, mappedError.status || 502, mappedError.code, mappedError.message);
    }

    modelPhase = 'ready';
    rewriteLifecycle.recordSuccess({ nowMs: Date.now() });
    lastWarmAt = new Date().toISOString();
    lastError = null;

    const modelText = (rewriteResult.data.response || '').trim();
    const usage = rewriteResult.data?.usage || null;
    logProviderResponseMeta({ requestId, stream: false, usage, doneReason: 'stop' });
    if (!modelText) {
      setLastError('OLLAMA_ERROR', 'Empty model response');
      return errorResponse(res, 502, 'OLLAMA_ERROR', 'Empty model response');
    }

    const processedOutput = rewriteService.postProcessOutput({ payload: { result: modelText } });
    return writeJsonSuccess(res, { result: processedOutput?.result || '', ...(usage ? { usage } : {}) });
  } finally {
    logRewriteRequest({
      req,
      requestId,
      startedAt,
      email,
      inputLength,
      requestPhase,
      selectedTimeoutMs,
      probeReady,
      probeError,
      warmupTriggeredNow,
      minimaxRecoveryAttempt
    });
  }
});


app.post(
  [t2aService.routes.legacyPath, t2aService.routes.futureApiPath],
  t2aLimiter,
  rewriteHeaderAuth,
  async (req, res) => {
    const requestId = crypto.randomUUID();

    try {
      const validationResult = t2aService.validateRequest({ body: req.body });
      if (!validationResult.ok) {
        return errorResponse(res, validationResult.status, validationResult.code, validationResult.message);
      }

      const { trimmedText, responseMode, voice, audio } = validationResult.value;

      if (validationResult.value.streamRequested) {
        return errorResponse(res, 501, 'STREAMING_UNSUPPORTED', 'stream is not supported for t2a v1');
      }

      if (t2aService.provider.selected === 'minimax' && !MINIMAX_API_KEY) {
        return errorResponse(
          res,
          503,
          'MINIMAX_API_KEY_MISSING',
          'Minimax API key is missing; set MINIMAX_API_KEY to enable t2a requests.'
        );
      }

      let t2aResult;
      try {
        t2aResult = await executeWithAdmission({
          providerName: t2aService.provider.selected,
          requestId,
          execute: () => t2aProviderAdapter.invokeSync({
            serviceId: t2aService.id,
            requestId,
            payload: {
              text: trimmedText,
              voice,
              audio,
              languageBoost: validationResult.value.languageBoost,
              voiceModify: validationResult.value.voiceModify,
              outputFormat: validationResult.value.outputFormat
            },
            timeoutMs: t2aService.timeouts.invokeMs
          })
        });
      } catch (error) {
        if (isAdmissionOverloadError(error)) {
          return admissionOverloadResponse(res, error);
        }

        throw error;
      }

      if (!t2aResult.ok) {
        const mappedError = t2aResult.error || t2aProviderAdapter.mapError(new Error('unknown'));
        return errorResponse(res, mappedError.status || 502, mappedError.code, mappedError.message);
      }

      const output = t2aResult.data?.output || {};
      const audioBuffer = output?.meta?.audio || output?.artifacts?.find((artifact) => artifact?.kind === 'audio')?.data;
      const format = output?.meta?.format || output?.artifacts?.[0]?.format || 'mp3';
      const contentType = output?.meta?.contentType || output?.meta?.mime || output?.artifacts?.[0]?.contentType || 'audio/mpeg';
      const providerMeta = output?.meta?.provider || null;

      if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        return errorResponse(res, 502, 'PROVIDER_ERROR', 'Provider response did not include audio data');
      }

      if (responseMode === 'base64_json') {
        return writeJsonSuccess(res, {
          audio: audioBuffer.toString('base64'),
          format,
          mime: contentType,
          contentType,
          size: audioBuffer.length,
          provider: providerMeta
        });
      }

      res.status(200);
      res.set('Content-Type', contentType);
      res.set('Content-Length', String(audioBuffer.length));
      res.set('Content-Disposition', `inline; filename="speech.${format}"`);
      return res.end(audioBuffer);
    } catch (error) {
      if (error?.code === 'STREAMING_UNSUPPORTED') {
        return errorResponse(res, 501, 'STREAMING_UNSUPPORTED', 'stream is not supported for t2a v1');
      }

      throw error;
    }
  }
);

app.use((_req, res) => {
  return errorResponse(res, 404, 'NOT_FOUND', 'Not Found');
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return errorResponse(res, 400, 'INVALID_JSON', 'Invalid JSON body');
  }
  return errorResponse(res, 500, 'INTERNAL_ERROR', 'Internal server error');
});

app.listen(PORT, HOST, () => {
  const providerInfo = rewriteProviderAdapter.getInfo();
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Effective provider config',
      ...providerInfo,
      serviceReadyTimeoutMs: rewriteService.timeouts.readyMs,
      serviceColdTimeoutMs: rewriteService.timeouts.coldMs,
      t2aInvokeTimeoutMs: t2aService.timeouts.invokeMs,
      ollamaPsCacheMs: OLLAMA_PS_CACHE_MS,
      ollamaPsTimeoutMs: OLLAMA_PS_TIMEOUT_MS,
      warmupTriggerTimeoutMs: WARMUP_TRIGGER_TIMEOUT_MS,
      warmupRetriggerWindowMs: WARMUP_RETRIGGER_WINDOW_MS,
      rateLimitPolicy,
      rewriteDebugRawOutput: REWRITE_DEBUG_RAW_OUTPUT,
      warmupOnStart: WARMUP_ON_START,
      warmupStartupMaxWaitMs: WARMUP_STARTUP_MAX_WAIT_MS,
      warmupStartupRetryIntervalMs: WARMUP_STARTUP_RETRY_INTERVAL_MS,
      modelWarmingRetryAfterSec: MODEL_WARMING_RETRY_AFTER_SEC,
      serviceState,
      minimaxPassiveReadyGraceMs: MINIMAX_PASSIVE_READY_GRACE_MS,
      minimaxFailOpenOnIdle: MINIMAX_FAIL_OPEN_ON_IDLE,
      minimaxConsecutiveFailureThreshold: MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD,
      minimaxRecoveryAttemptCooldownMs: MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS
    })
  );
  console.log(`rewrite-bridge listening on http://${HOST}:${PORT}`);

  if (WARMUP_ON_START) {
    runStartupWarmupLoop().catch((err) => {
      serviceState = 'degraded';
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'Startup warmup loop failed',
          error: err?.name || 'startup_warmup_failed',
          serviceState
        })
      );
    });
  } else {
    serviceState = 'ready';
  }
});
