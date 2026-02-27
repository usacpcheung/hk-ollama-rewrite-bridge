# API Endpoint Result Guide (Current Implementation)

This document describes what each endpoint currently returns in this codebase, including status codes, response body shapes, and call examples.

> Base service bind: `http://127.0.0.1:3001` (internal).
>
> Public reverse-proxy path (if configured): `/api/rewrite-bridge/*`.

---

## 1) `POST /rewrite`

Rewrite Hong Kong colloquial Cantonese into formal Traditional Chinese.

### Request

**Headers**

- `Content-Type: application/json`

**Body**

```json
{
  "text": "你今日得唔得閒？"
}
```

### Validation rules

- `text` must exist and be a string.
- `text.trim()` must not be empty.
- max length: `200` characters.

### Possible responses

#### `200 OK` (rewrite success)

```json
{
  "ok": true,
  "result": "請問你今天有空嗎？"
}
```

#### `202 Accepted` (model warming at runtime)

Headers include `Retry-After: <seconds>`.

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_WARMING",
    "message": "Model is warming up, retry after 2 seconds."
  },
  "retryAfterSec": 2
}
```

#### `202 Accepted` (warm-up just triggered by this request)

Headers include `Retry-After: <seconds>`.

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_WARMUP_STARTED",
    "message": "Model wake-up started, retry after 2 seconds."
  },
  "retryAfterSec": 2
}
```

#### `503 Service Unavailable` (startup degraded)

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_STARTUP_DEGRADED",
    "message": "Model startup warm-up exceeded the configured wait budget. Please retry shortly and check service/Ollama status."
  },
  "serviceState": "degraded",
  "startupWarmupAttempts": 12,
  "startupWarmupDeadlineAt": "2026-01-01T10:00:00.000Z"
}
```

#### `400 Bad Request` (invalid input)

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "text is required"
  }
}
```

#### `413 Payload Too Large` (input over 200 chars)

```json
{
  "ok": false,
  "error": {
    "code": "TOO_LONG",
    "message": "Max 200 characters"
  }
}
```

#### `504 Gateway Timeout` (model timeout)

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_TIMEOUT",
    "message": "Model response timed out. Please retry."
  }
}
```

Or during cold path:

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_COLD_START_TIMEOUT",
    "message": "Model is warming up and took too long to respond. Please retry shortly."
  }
}
```

#### `502 Bad Gateway` (Ollama/network/response issue)

```json
{
  "ok": false,
  "error": {
    "code": "OLLAMA_ERROR",
    "message": "Failed to reach model"
  }
}
```

Other `OLLAMA_ERROR` messages used by current code:

- `Model request failed`
- `Invalid model response`
- `Empty model response`

### Example calls

```bash
# Internal route
curl -i -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'

# Public reverse-proxy route (if enabled)
curl -i -sS https://<your-domain>/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'
```

---

## 2) `GET /model-status`

Diagnostic endpoint for warm-up/probe state.

### `200 OK` response shape

```json
{
  "status": "ready",
  "serviceState": "ready",
  "startupWarmupAttempts": 2,
  "startupWarmupDeadlineAt": "2026-01-01T10:00:00.000Z",
  "lastWarmAt": "2026-01-01T09:59:50.000Z",
  "lastError": null,
  "warmupInFlight": false,
  "lastWarmupTriggerAt": "2026-01-01T09:59:45.000Z",
  "lastWarmupResult": "success",
  "lastWarmupError": null,
  "lastProbeReady": true,
  "probeAgeMs": 300
}
```

### Status meaning used by current code

- `status = "warming"`: model not ready yet.
- `status = "ready"`: service/model ready and no `lastError`.
- `status = "degraded"`: startup degraded OR there is `lastError` while reporting state.

### Example call

```bash
curl -sS http://127.0.0.1:3001/model-status | jq
```

---

## 3) `GET /healthz`

Simple process liveness check.

### `200 OK`

```json
{ "ok": true }
```

### Example call

```bash
curl -i -sS http://127.0.0.1:3001/healthz
```

---

## 4) `GET /readyz`

Traffic readiness gate.

### `200 OK` (ready)

```json
{ "ok": true, "serviceState": "ready", "reason": null }
```

### `503 Service Unavailable` (not ready)

```json
{ "ok": false, "serviceState": "starting", "reason": "STARTING_WARMUP" }
```

Other possible `reason` values in current code:

- `MODEL_NOT_READY`
- `MODEL_PROBE_UNAVAILABLE`
- `STARTUP_DEGRADED`

### Example call

```bash
curl -i -sS http://127.0.0.1:3001/readyz
```

---

## 5) Global fallback/error responses

### `404 Not Found` (unknown route)

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Not Found"
  }
}
```

### `400 Bad Request` (invalid JSON body)

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_JSON",
    "message": "Invalid JSON body"
  }
}
```

### `500 Internal Server Error` (unexpected app error)

```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error"
  }
}
```

---

## Notes for implementation in the current state

1. `POST /rewrite` is stateful against warm-up state (`serviceState`, `modelPhase`, probe cache); clients must handle transient `202` with `Retry-After` and retry logic.
2. Startup behavior is controlled by `WARMUP_ON_START`; if true, service begins in `starting` and may become `degraded` if startup warm-up exceeds `WARMUP_STARTUP_MAX_WAIT_MS`.
3. Readiness probing relies on Ollama `/api/ps` and may return unknown (`null` readiness) when timeout/network/invalid response happens; this can cause temporary non-ready behavior.
4. Error response envelope is consistent across handlers: `ok: false` + `error.code` + `error.message`.
5. `status` from `/model-status` is derived state and can be `degraded` even when service has been ready before (for example when `lastError` exists).
6. The app only listens on `127.0.0.1:3001`; external consumers need reverse proxy mapping to `/api/rewrite-bridge/*`.
7. Returned rewrite text is converted using OpenCC (`cn -> hk`) after Ollama response.

---

## Suggested client-side handling (practical)

- Treat `200` as success.
- Treat `202` (`MODEL_WARMUP_STARTED` / `MODEL_WARMING`) as retryable with `Retry-After` backoff.
- Treat `503 MODEL_STARTUP_DEGRADED` as temporary outage; show user-friendly message + operator alert.
- Treat `502/504` as upstream instability/timeouts; allow manual retry.
- Optionally poll `/model-status` (2-3s) when waiting for readiness.
