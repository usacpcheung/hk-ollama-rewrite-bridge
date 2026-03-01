const express = require('express');
const crypto = require('crypto');
const OpenCC = require('opencc-js');
const { createProvider } = require('./providers');

const app = express();
const HOST = '127.0.0.1';
const PORT = 3001;
const MAX_TEXT_LENGTH = 200;
const REWRITE_PROVIDER = process.env.REWRITE_PROVIDER || 'ollama';

function parseBoundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
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

const OLLAMA_TIMEOUT_MS = parseEnvMilliseconds('OLLAMA_TIMEOUT_MS', 30_000, { max: 300_000 });
const OLLAMA_COLD_TIMEOUT_MS = parseEnvMilliseconds('OLLAMA_COLD_TIMEOUT_MS', 120_000, {
  max: 600_000
});
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct';
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
const MINIMAX_PASSIVE_READY_GRACE_MS = parseEnvMilliseconds(
  'MINIMAX_PASSIVE_READY_GRACE_MS',
  10 * 60_000,
  { max: 24 * 60 * 60_000 }
);
const MINIMAX_FAIL_OPEN_ON_IDLE = process.env.MINIMAX_FAIL_OPEN_ON_IDLE
  ? process.env.MINIMAX_FAIL_OPEN_ON_IDLE.toLowerCase() !== 'false'
  : true;
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
const WARMUP_ON_START = process.env.WARMUP_ON_START
  ? process.env.WARMUP_ON_START.toLowerCase() !== 'false'
  : true;
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


const MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'https://api.minimax.io/v1/text/chatcompletion_v2';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'M2-her';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';

const REWRITE_SYSTEM_PROMPT = process.env.REWRITE_SYSTEM_PROMPT ||
  '你是忠實改寫助手。請將以下香港口語廣東話改寫成正式書面繁體中文（zh-Hant）。\n'
  + '必須逐句保留原意與全部資訊（包括人物、時間、地點、數字、否定、因果、條件、語氣）。\n'
  + '只可改寫語體，不可新增、虛構、延伸、評論、解釋、總結或改變立場。\n'
  + '請移除口語贅詞、語氣助詞與寒暄開場（例如：喂、係、嘅、啦、囉、呀、唉、哦、嗯、咩），但只可移除不影響語義者，不得刪除任何實質內容詞。\n'
  + '若上述詞語出現在引號內容、專有名稱、品牌、口號、歌詞或其他關鍵語義位置，必須保留，不可硬改。\n'
  + '不得把內容寫成故事、對話續寫、創作文本或條列重組。\n'
  + '輸出格式：只輸出改寫後正文，不要標題、前言、註解、解釋、JSON、metadata 或引號。';
const REWRITE_USER_TEMPLATE = process.env.REWRITE_USER_TEMPLATE || '原文：{TEXT}';
const MINIMAX_SYSTEM_PROMPT =
  process.env.MINIMAX_SYSTEM_PROMPT !== undefined
    ? process.env.MINIMAX_SYSTEM_PROMPT
    : REWRITE_SYSTEM_PROMPT;
const MINIMAX_USER_TEMPLATE =
  process.env.MINIMAX_USER_TEMPLATE !== undefined
    ? process.env.MINIMAX_USER_TEMPLATE
    : REWRITE_USER_TEMPLATE;

function renderUserContent(userTemplate, text) {
  if (typeof userTemplate !== 'string' || userTemplate.length === 0) {
    return text;
  }

  if (userTemplate.includes('{TEXT}')) {
    return userTemplate.replace('{TEXT}', text);
  }

  return `${userTemplate}${text}`;
}

function buildRewritePrompt(systemPrompt, userTemplate, text) {
  const userContent = renderUserContent(userTemplate, text);
  const prompt = [systemPrompt, userContent]
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .join('\n\n');

  return {
    prompt,
    systemPrompt,
    userContent
  };
}

const provider = createProvider({
  provider: REWRITE_PROVIDER,
  ollamaUrl: OLLAMA_URL,
  ollamaPsUrl: OLLAMA_PS_URL,
  ollamaModel: OLLAMA_MODEL,
  ollamaKeepAlive: OLLAMA_KEEP_ALIVE,
  minimaxApiUrl: MINIMAX_API_URL,
  minimaxModel: MINIMAX_MODEL,
  minimaxApiKey: MINIMAX_API_KEY,
  minimaxSystemPrompt: MINIMAX_SYSTEM_PROMPT,
  minimaxUserTemplate: MINIMAX_USER_TEMPLATE
});

let modelPhase = 'unknown';
let lastProbeAtMs = 0;
let lastProbeReady = null;
let lastWarmAt = null;
let lastError = null;
let lastWarmupTriggerAtMs = 0;
let warmupInFlight = false;
let lastWarmupResult = null;
let lastWarmupError = null;
let serviceState = 'starting';
let startupWarmupAttempts = 0;
let startupWarmupDeadlineAtMs = null;
let lastRewriteSuccessAtMs = 0;
let lastRewriteFailureAtMs = 0;
let consecutiveRewriteFailures = 0;
let lastMinimaxRecoveryAttemptAtMs = 0;

const toHK = OpenCC.Converter({ from: 'cn', to: 'hk' });

app.use(express.json({ limit: '16kb' }));

function errorResponse(res, status, code, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    ...extra
  });
}

function requireAuthenticatedEmail(req, res) {
  const rawHeader = req.get('X-Authenticated-Email');
  const email = (rawHeader || '').trim().toLowerCase();

  if (!email) {
    errorResponse(res, 401, 'AUTH_REQUIRED', 'Login required');
    return null;
  }

  if (email.includes(',')) {
    errorResponse(res, 401, 'AUTH_HEADER_INVALID', 'Invalid authentication header');
    return null;
  }

  if (!email.endsWith('@hs.edu.hk')) {
    errorResponse(res, 403, 'FORBIDDEN_DOMAIN', 'Only hs.edu.hk accounts are allowed');
    return null;
  }

  return email;
}

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

function warmupWithinColdWindow(nowMs) {
  return lastWarmupTriggerAtMs > 0 && nowMs - lastWarmupTriggerAtMs < WARMUP_RETRIGGER_WINDOW_MS;
}

async function probeModelReady() {
  const timeoutMs = REWRITE_PROVIDER === 'minimax' ? MINIMAX_READINESS_TIMEOUT_MS : OLLAMA_PS_TIMEOUT_MS;
  return provider.checkReadiness({ timeoutMs });
}

function getMinimaxPassiveReadiness(nowMs = Date.now()) {
  if (!MINIMAX_API_KEY) {
    return { ready: false, reason: 'MINIMAX_API_KEY_MISSING' };
  }

  const lastActivityAtMs = Math.max(lastRewriteSuccessAtMs, lastRewriteFailureAtMs, 0);
  const idleMs = lastActivityAtMs > 0 ? Math.max(0, nowMs - lastActivityAtMs) : null;
  const failuresAreStale =
    lastRewriteFailureAtMs === 0 || nowMs - lastRewriteFailureAtMs > MINIMAX_PASSIVE_READY_GRACE_MS;

  if (consecutiveRewriteFailures >= MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD) {
    if (MINIMAX_FAIL_OPEN_ON_IDLE && (failuresAreStale || (idleMs !== null && idleMs > MINIMAX_PASSIVE_READY_GRACE_MS))) {
      return { ready: true, reason: 'MINIMAX_IDLE_FAIL_OPEN' };
    }

    return { ready: false, reason: 'MINIMAX_RECENT_FAILURES' };
  }

  if (MINIMAX_FAIL_OPEN_ON_IDLE && idleMs !== null && idleMs > MINIMAX_PASSIVE_READY_GRACE_MS) {
    return { ready: true, reason: 'MINIMAX_IDLE_FAIL_OPEN' };
  }

  return {
    ready: true,
    reason: null
  };
}

async function triggerWarmupIfNeeded(nowMs) {
  if (warmupInFlight || warmupWithinColdWindow(nowMs)) {
    return false;
  }

  warmupInFlight = true;
  lastWarmupTriggerAtMs = nowMs;

  try {
    const warmupResult = await provider.triggerWarmup({ timeoutMs: WARMUP_TRIGGER_TIMEOUT_MS });
    if (!warmupResult.ok) {
      lastWarmupResult = 'failed';
      lastWarmupError = warmupResult.error.detail || 'warmup_fetch_failed';
      return true;
    }

    lastWarmupResult = 'success';
    lastWarmupError = null;
    return true;
  } finally {
    warmupInFlight = false;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStartupWarmupLoop() {
  startupWarmupAttempts = 0;
  startupWarmupDeadlineAtMs = Date.now() + WARMUP_STARTUP_MAX_WAIT_MS;

  while (Date.now() < startupWarmupDeadlineAtMs) {
    startupWarmupAttempts += 1;
    const attemptStartedAtMs = Date.now();
    const triggered = await triggerWarmupIfNeeded(attemptStartedAtMs);
    const probeResult = await probeModelReady();

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
          lastWarmupResult,
          lastWarmupError
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
        lastWarmupResult,
        lastWarmupError
      })
    );

    await delay(Math.max(0, WARMUP_STARTUP_RETRY_INTERVAL_MS - (Date.now() - attemptStartedAtMs)));
  }

  serviceState = 'degraded';
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'Startup warmup loop exceeded max wait budget',
      serviceState,
      startupWarmupAttempts,
      startupWarmupDeadlineAt: startupWarmupDeadlineAtMs
        ? new Date(startupWarmupDeadlineAtMs).toISOString()
        : null,
      lastWarmupResult,
      lastWarmupError,
      lastProbeReady
    })
  );
}

app.get('/model-status', async (_req, res) => {
  const nowMs = Date.now();
  let probeReady = lastProbeReady;
  const isMinimax = REWRITE_PROVIDER === 'minimax';
  const minimaxPassiveReadiness = isMinimax ? getMinimaxPassiveReadiness(nowMs) : null;

  if (!isMinimax && nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
    const probeResult = await probeModelReady();
    lastProbeAtMs = nowMs;
    probeReady = probeResult.ready;
    if (probeResult.ready !== null) {
      lastProbeReady = probeResult.ready;
    }
  }

  if (isMinimax) {
    if (minimaxPassiveReadiness.ready) {
      promoteServiceReady();
    } else {
      modelPhase = 'warming';
    }
  } else {
    applyProbeState(probeReady);
  }

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
    warmupInFlight,
    lastWarmupTriggerAt: lastWarmupTriggerAtMs ? new Date(lastWarmupTriggerAtMs).toISOString() : null,
    lastWarmupResult,
    lastWarmupError,
    lastProbeReady,
    probeAgeMs: lastProbeAtMs ? Math.max(0, Date.now() - lastProbeAtMs) : null,
    minimaxPassiveReadiness: isMinimax
      ? {
          ...minimaxPassiveReadiness,
          lastRewriteSuccessAt: lastRewriteSuccessAtMs
            ? new Date(lastRewriteSuccessAtMs).toISOString()
            : null,
          lastRewriteFailureAt: lastRewriteFailureAtMs
            ? new Date(lastRewriteFailureAtMs).toISOString()
            : null,
          consecutiveRewriteFailures,
          lastRecoveryAttemptAt: lastMinimaxRecoveryAttemptAtMs
            ? new Date(lastMinimaxRecoveryAttemptAtMs).toISOString()
            : null,
          recoveryAttemptCooldownMs: MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS,
          passiveReadyGraceMs: MINIMAX_PASSIVE_READY_GRACE_MS,
          failOpenOnIdle: MINIMAX_FAIL_OPEN_ON_IDLE,
          failureThreshold: MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD
        }
      : null
  });
});

app.get('/healthz', (_req, res) => {
  return res.json({ ok: true });
});

app.get('/readyz', async (_req, res) => {
  const nowMs = Date.now();
  let probeReady = lastProbeReady;
  const isMinimax = REWRITE_PROVIDER === 'minimax';

  if (isMinimax) {
    const minimaxPassiveReadiness = getMinimaxPassiveReadiness(nowMs);
    if (minimaxPassiveReadiness.ready) {
      promoteServiceReady();
      return res.json({ ok: true, serviceState, reason: null });
    }

    modelPhase = 'warming';
    return res
      .status(503)
      .json({ ok: false, serviceState, reason: minimaxPassiveReadiness.reason || 'MINIMAX_NOT_READY' });
  }

  if (nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
    const probeResult = await probeModelReady();
    lastProbeAtMs = nowMs;
    probeReady = probeResult.ready;
    if (probeResult.ready !== null) {
      lastProbeReady = probeResult.ready;
    }
  }

  applyProbeState(probeReady);

  if (serviceState === 'ready') {
    if (probeReady === true) {
      return res.json({ ok: true, serviceState, reason: null });
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

app.post('/rewrite', async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  let email = null;
  let inputLength = 0;
  let requestPhase = modelPhase;
  let selectedTimeoutMs = OLLAMA_COLD_TIMEOUT_MS;
  let probeReady = lastProbeReady;
  let probeError = null;
  let warmupTriggeredNow = false;
  let minimaxRecoveryAttempt = false;
  const isMinimax = REWRITE_PROVIDER === 'minimax';

  try {
    email = requireAuthenticatedEmail(req, res);
    if (email === null) {
      return;
    }

    const { text, stream } = req.body || {};
    const streamRequested = stream === true || stream === 'true' || stream === 1 || stream === '1';

    if (typeof text !== 'string') {
      return errorResponse(res, 400, 'INVALID_INPUT', 'text is required');
    }

    const trimmedText = text.trim();
    inputLength = trimmedText.length;

    if (!trimmedText) {
      return errorResponse(res, 400, 'INVALID_INPUT', 'text is required');
    }

    if (trimmedText.length > MAX_TEXT_LENGTH) {
      return errorResponse(res, 413, 'TOO_LONG', 'Max 200 characters');
    }

    const { prompt, systemPrompt, userContent } = isMinimax
      ? buildRewritePrompt(MINIMAX_SYSTEM_PROMPT, MINIMAX_USER_TEMPLATE, trimmedText)
      : buildRewritePrompt(REWRITE_SYSTEM_PROMPT, REWRITE_USER_TEMPLATE, trimmedText);

    const nowMs = Date.now();
    const probeAgeMs = lastProbeAtMs ? Math.max(0, nowMs - lastProbeAtMs) : Number.POSITIVE_INFINITY;
    const shouldForceFreshReadyProbe =
      serviceState === 'ready' &&
      (probeReady === null || probeAgeMs > READY_REWRITE_STRICT_PROBE_MAX_AGE_MS);

    if (!isMinimax && (shouldForceFreshReadyProbe || nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS)) {
      const probeResult = await probeModelReady();
      lastProbeAtMs = nowMs;
      probeReady = probeResult.ready;
      probeError = probeResult.error;
      if (probeResult.ready !== null) {
        lastProbeReady = probeResult.ready;
      }
    }

    if (isMinimax) {
      const minimaxPassiveReadiness = getMinimaxPassiveReadiness(nowMs);
      probeReady = minimaxPassiveReadiness.ready;
      probeError = minimaxPassiveReadiness.reason;
      if (minimaxPassiveReadiness.ready) {
        promoteServiceReady();
      } else {
        modelPhase = 'warming';

        if (minimaxPassiveReadiness.reason === 'MINIMAX_RECENT_FAILURES') {
          const cooldownRemainingMs =
            lastMinimaxRecoveryAttemptAtMs > 0
              ? MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS - (nowMs - lastMinimaxRecoveryAttemptAtMs)
              : 0;

          if (cooldownRemainingMs > 0) {
            const retryAfterSec = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
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
          lastMinimaxRecoveryAttemptAtMs = nowMs;
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

    requestPhase = modelPhase;
    selectedTimeoutMs = requestPhase === 'ready' ? OLLAMA_TIMEOUT_MS : OLLAMA_COLD_TIMEOUT_MS;

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

    if (streamRequested) {
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

      let streamDoneSent = false;
      let streamedText = '';
      let streamedChunkEmitted = false;

      const writeStreamChunk = (payload) => {
        if (res.writableEnded) {
          return;
        }

        res.write(`${JSON.stringify(payload)}\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
      };

      const writeDoneChunk = (extra = {}) => {
        if (streamDoneSent) {
          return;
        }

        streamDoneSent = true;
        writeStreamChunk({ response: '', done: true, ...extra });
      };

      const rewriteResult = provider.rewriteStream
        ? await provider.rewriteStream({
            prompt,
            systemPrompt,
            userContent,
            timeoutMs: selectedTimeoutMs,
            onChunk: async (event) => {
              if (!event || typeof event !== 'object') {
                return;
              }

              if (event.type === 'chunk' && event.chunk && typeof event.chunk === 'object') {
                const chunk = event.chunk;
                const chunkResponse = typeof chunk.response === 'string' ? chunk.response : '';

                if (chunkResponse && !chunk.done) {
                  streamedText += chunkResponse;
                  streamedChunkEmitted = true;
                }

                if (chunk.done) {
                  const { done_reason: doneReason } = chunk;
                  writeDoneChunk(doneReason ? { done_reason: doneReason } : {});
                  return;
                }

                if (chunkResponse) {
                  writeStreamChunk({
                    ...chunk,
                    response: toHK(chunkResponse),
                    done: false
                  });
                }

                return;
              }

              if (event.type === 'token' && typeof event.text === 'string' && event.text.length > 0) {
                streamedText += event.text;
                streamedChunkEmitted = true;
                writeStreamChunk({ response: toHK(event.text), done: false });
                return;
              }

              if (event.type === 'done') {
                writeDoneChunk(event.reason ? { done_reason: event.reason } : {});
              }
            }
          })
        : await provider.rewrite({ prompt, systemPrompt, userContent, timeoutMs: selectedTimeoutMs });

      if (!rewriteResult.ok) {
        lastRewriteFailureAtMs = Date.now();
        consecutiveRewriteFailures += 1;
        const mappedError = rewriteResult.error || provider.mapError(new Error('unknown'));
        setLastError(mappedError.code, mappedError.message);
        writeStreamChunk({
          done: true,
          error: {
            code: mappedError.code,
            message: mappedError.message,
            status: mappedError.status || 502
          }
        });
        return res.end();
      }

      modelPhase = 'ready';
      lastRewriteSuccessAtMs = Date.now();
      consecutiveRewriteFailures = 0;
      lastWarmAt = new Date().toISOString();
      lastError = null;

      const finalResponse = (rewriteResult.data?.response || '').trim();
      const streamResponse = finalResponse || streamedText.trim();
      if (streamResponse && !streamedChunkEmitted) {
        const finalText = toHK(streamResponse);
        writeStreamChunk({ response: finalText, done: false });
      }

      writeDoneChunk({ done_reason: 'stop' });
      return res.end();
    }

    const rewriteResult = await provider.rewrite({ prompt, systemPrompt, userContent, timeoutMs: selectedTimeoutMs });
    if (!rewriteResult.ok) {
      lastRewriteFailureAtMs = Date.now();
      consecutiveRewriteFailures += 1;
      const mappedError = rewriteResult.error || provider.mapError(new Error('unknown'));
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
    lastRewriteSuccessAtMs = Date.now();
    consecutiveRewriteFailures = 0;
    lastWarmAt = new Date().toISOString();
    lastError = null;

    const modelText = (rewriteResult.data.response || '').trim();
    if (!modelText) {
      setLastError('OLLAMA_ERROR', 'Empty model response');
      return errorResponse(res, 502, 'OLLAMA_ERROR', 'Empty model response');
    }

    const finalText = toHK(modelText);
    return res.json({ ok: true, result: finalText });
  } finally {
    const elapsedMs = Date.now() - startedAt;
    const probeAgeMs = lastProbeAtMs ? Math.max(0, Date.now() - lastProbeAtMs) : null;
    console.log(
      JSON.stringify({
        requestId,
        ip,
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
        warmupInFlight,
        lastWarmupResult,
        lastWarmupError,
        lastWarmupTriggerAtMs
      })
    );
  }
});

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
  const providerInfo = provider.getInfo ? provider.getInfo() : {};
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Effective Ollama config',
      ...providerInfo,
      ollamaTimeoutMs: OLLAMA_TIMEOUT_MS,
      ollamaColdTimeoutMs: OLLAMA_COLD_TIMEOUT_MS,
      ollamaPsCacheMs: OLLAMA_PS_CACHE_MS,
      ollamaPsTimeoutMs: OLLAMA_PS_TIMEOUT_MS,
      warmupTriggerTimeoutMs: WARMUP_TRIGGER_TIMEOUT_MS,
      warmupRetriggerWindowMs: WARMUP_RETRIGGER_WINDOW_MS,
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
