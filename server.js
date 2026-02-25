const express = require('express');
const crypto = require('crypto');
const OpenCC = require('opencc-js');

const app = express();
const HOST = '127.0.0.1';
const PORT = 3001;
const MAX_TEXT_LENGTH = 200;

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
const READY_REWRITE_STRICT_PROBE_MAX_AGE_MS = parseEnvMilliseconds(
  'READY_REWRITE_STRICT_PROBE_MAX_AGE_MS',
  Math.min(1_000, OLLAMA_PS_CACHE_MS),
  { max: 30_000 }
);
const WARMUP_TRIGGER_TIMEOUT_MS = parseEnvMilliseconds('WARMUP_TRIGGER_TIMEOUT_MS', 60_000, {
  max: 300_000
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

const toHK = OpenCC.Converter({ from: 'cn', to: 'hk' });

const PROMPT_TEMPLATE =
  '將以下香港口語廣東話改寫成正式書面繁體中文，必須保留原意與所有細節（包括否定、因果、條件、語氣），不得刪減或總結，只輸出改寫後正文。\n\n原文：{TEXT}';

app.use(express.json({ limit: '16kb' }));

function errorResponse(res, status, code, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    ...extra
  });
}

function setLastError(code, message) {
  lastError = { code, message, at: new Date().toISOString() };
}

function warmupWithinColdWindow(nowMs) {
  return lastWarmupTriggerAtMs > 0 && nowMs - lastWarmupTriggerAtMs < OLLAMA_COLD_TIMEOUT_MS;
}

async function probeModelReady() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_PS_TIMEOUT_MS);

  try {
    const response = await fetch(OLLAMA_PS_URL, { signal: controller.signal });
    if (!response.ok) {
      return { ready: null, error: `ps_http_${response.status}` };
    }

    let psJson;
    try {
      psJson = await response.json();
    } catch (_err) {
      return { ready: null, error: 'ps_invalid_json' };
    }

    const models = Array.isArray(psJson.models) ? psJson.models : [];
    const ready = models.some((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      return entry.name === OLLAMA_MODEL || entry.model === OLLAMA_MODEL;
    });

    return { ready, error: null };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ready: null, error: 'ps_timeout' };
    }
    return { ready: null, error: 'ps_fetch_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

async function triggerWarmupIfNeeded(nowMs) {
  if (warmupInFlight || warmupWithinColdWindow(nowMs)) {
    return false;
  }

  warmupInFlight = true;
  lastWarmupTriggerAtMs = nowMs;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WARMUP_TRIGGER_TIMEOUT_MS);

  try {
    const warmupResponse = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'hi',
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          temperature: 0,
          num_predict: 1
        }
      }),
      signal: controller.signal
    });

    if (!warmupResponse.ok) {
      lastWarmupResult = 'failed';
      lastWarmupError = `warmup_http_${warmupResponse.status}`;
      return true;
    }

    lastWarmupResult = 'success';
    lastWarmupError = null;
    return true;
  } catch (err) {
    lastWarmupResult = 'failed';
    lastWarmupError = err.name === 'AbortError' ? 'warmup_timeout' : 'warmup_fetch_failed';
    return true;
  } finally {
    warmupInFlight = false;
    clearTimeout(timeout);
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
      modelPhase = 'ready';
      serviceState = 'ready';
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

  if (nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
    const probeResult = await probeModelReady();
    lastProbeAtMs = nowMs;
    probeReady = probeResult.ready;
    if (probeResult.ready !== null) {
      lastProbeReady = probeResult.ready;
    }
  }

  if (probeReady === false && modelPhase === 'ready') {
    modelPhase = 'warming';
  }

  let status = 'warming';
  if (modelPhase === 'ready') {
    status = lastError ? 'degraded' : 'ready';
  } else if (lastError) {
    status = 'degraded';
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
    probeAgeMs: lastProbeAtMs ? Math.max(0, Date.now() - lastProbeAtMs) : null
  });
});

app.get('/healthz', (_req, res) => {
  return res.json({ ok: true });
});

app.get('/readyz', async (_req, res) => {
  if (serviceState === 'ready') {
    const nowMs = Date.now();
    let probeReady = lastProbeReady;

    if (nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
      const probeResult = await probeModelReady();
      lastProbeAtMs = nowMs;
      probeReady = probeResult.ready;
      if (probeResult.ready !== null) {
        lastProbeReady = probeResult.ready;
      }
    }

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
  let inputLength = 0;
  let requestPhase = modelPhase;
  let selectedTimeoutMs = OLLAMA_COLD_TIMEOUT_MS;
  let probeReady = lastProbeReady;
  let probeError = null;
  let warmupTriggeredNow = false;

  try {
    const { text } = req.body || {};

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

    const prompt = PROMPT_TEMPLATE.replace('{TEXT}', trimmedText);

    const nowMs = Date.now();
    const probeAgeMs = lastProbeAtMs ? Math.max(0, nowMs - lastProbeAtMs) : Number.POSITIVE_INFINITY;
    const shouldForceFreshReadyProbe =
      serviceState === 'ready' &&
      (probeReady === null || probeAgeMs > READY_REWRITE_STRICT_PROBE_MAX_AGE_MS);

    if (shouldForceFreshReadyProbe || nowMs - lastProbeAtMs >= OLLAMA_PS_CACHE_MS) {
      const probeResult = await probeModelReady();
      lastProbeAtMs = nowMs;
      probeReady = probeResult.ready;
      probeError = probeResult.error;
      if (probeResult.ready !== null) {
        lastProbeReady = probeResult.ready;
      }
    }

    if (serviceState === 'ready' && probeReady === true) {
      modelPhase = 'ready';
    } else if (probeReady === false || (serviceState === 'ready' && probeReady === null)) {
      modelPhase = 'warming';
    }

    if (probeReady !== true) {
      warmupTriggeredNow = await triggerWarmupIfNeeded(nowMs);

      const postWarmupProbe = await probeModelReady();
      probeReady = postWarmupProbe.ready;
      probeError = postWarmupProbe.error;
      lastProbeAtMs = Date.now();
      if (postWarmupProbe.ready !== null) {
        lastProbeReady = postWarmupProbe.ready;
      }

      if (probeReady === true) {
        modelPhase = 'ready';
        serviceState = 'ready';
      } else {
        modelPhase = 'warming';
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

    if (serviceState === 'degraded') {
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

    if (requestPhase !== 'ready') {
      res.set('Retry-After', String(MODEL_WARMING_RETRY_AFTER_SEC));
      return errorResponse(
        res,
        202,
        'MODEL_WARMING',
        `Model is warming up, retry after ${MODEL_WARMING_RETRY_AFTER_SEC} seconds.`,
        { retryAfterSec: MODEL_WARMING_RETRY_AFTER_SEC }
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), selectedTimeoutMs);

    let ollamaResponse;
    try {
      ollamaResponse = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt,
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: {
            temperature: 0.2,
            num_predict: 300
          }
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        if (requestPhase === 'ready') {
          setLastError('MODEL_TIMEOUT', 'Model response timed out. Please retry.');
          return errorResponse(res, 504, 'MODEL_TIMEOUT', 'Model response timed out. Please retry.');
        }
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
      setLastError('OLLAMA_ERROR', 'Failed to reach model');
      return errorResponse(res, 502, 'OLLAMA_ERROR', 'Failed to reach model');
    } finally {
      clearTimeout(timeout);
    }

    if (!ollamaResponse.ok) {
      setLastError('OLLAMA_ERROR', 'Model request failed');
      return errorResponse(res, 502, 'OLLAMA_ERROR', 'Model request failed');
    }

    modelPhase = 'ready';
    lastWarmAt = new Date().toISOString();
    lastError = null;

    let ollamaJson;
    try {
      ollamaJson = await ollamaResponse.json();
    } catch (_err) {
      setLastError('OLLAMA_ERROR', 'Invalid model response');
      return errorResponse(res, 502, 'OLLAMA_ERROR', 'Invalid model response');
    }

    const modelText = (ollamaJson.response || '').trim();
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
        inputLength,
        elapsedMs,
        phase: requestPhase,
        selectedTimeoutMs,
        probeReady,
        probeAgeMs,
        probeError,
        warmupTriggeredNow,
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
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Effective Ollama config',
      ollamaUrl: OLLAMA_URL,
      ollamaPsUrl: OLLAMA_PS_URL,
      ollamaModel: OLLAMA_MODEL,
      ollamaKeepAlive: OLLAMA_KEEP_ALIVE,
      ollamaTimeoutMs: OLLAMA_TIMEOUT_MS,
      ollamaColdTimeoutMs: OLLAMA_COLD_TIMEOUT_MS,
      ollamaPsCacheMs: OLLAMA_PS_CACHE_MS,
      ollamaPsTimeoutMs: OLLAMA_PS_TIMEOUT_MS,
      warmupTriggerTimeoutMs: WARMUP_TRIGGER_TIMEOUT_MS,
      warmupOnStart: WARMUP_ON_START,
      warmupStartupMaxWaitMs: WARMUP_STARTUP_MAX_WAIT_MS,
      warmupStartupRetryIntervalMs: WARMUP_STARTUP_RETRY_INTERVAL_MS,
      modelWarmingRetryAfterSec: MODEL_WARMING_RETRY_AFTER_SEC,
      serviceState
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
