# API Reference (hk-ollama-rewrite-bridge)

This document reflects the current server implementation in `server.js` and provider adapters.

- Internal bind: `http://127.0.0.1:3001`
- Typical public namespace (via reverse proxy): `/api/rewrite-bridge/*`

All error responses use:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

## Authentication trust model (reverse-proxy deployments)

Protected routes (for example `POST /rewrite`) require two trusted headers from the reverse proxy:

- `X-Authenticated-Email`: normalized user email claim (must end with `@hs.edu.hk`)
- `X-Bridge-Auth`: shared secret that must match backend env `BRIDGE_INTERNAL_AUTH_SECRET`

Requests missing either trusted signal are rejected with `401 AUTH_REQUIRED`.

Reverse proxy must unset these headers from inbound client traffic and set them server-side only after successful auth.

---

## 1) `POST /rewrite`

Rewrite HK colloquial Cantonese into formal Traditional Chinese.

### Debug logging toggle

Set environment variable `REWRITE_DEBUG_RAW_OUTPUT=true` to write raw provider output (before HK conversion) into service logs.

Example journal check:

```bash
journalctl -u rewrite-bridge -n 200 --no-pager | rg "Raw provider rewrite output"
```

### Request body

```json
{
  "text": "你今日得唔得閒？",
  "stream": false
}
```

- `text` (required): string, trimmed, non-empty, max `REWRITE_MAX_TEXT_LENGTH` Unicode characters (default 200; capped at 600).
- `stream` (optional): supports `true`, `"true"`, `1`, `"1"` to enable NDJSON streaming.

### Calling methods

```bash
# internal route
curl -i -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'

# reverse-proxy route
curl -i -sS https://<your-domain>/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'
```


### Minimax message-role example

In Minimax mode, the bridge sends a role-split payload:

```json
{
  "model": "M2-her",
  "messages": [
    {
      "role": "system",
      "content": "你是忠實改寫助手。請將以下香港口語廣東話改寫成正式書面繁體中文（zh-Hant）。"
    },
    {
      "role": "user",
      "content": "原文：我今日唔係好舒服，想請半日假。"
    }
  ],
  "stream": false
}
```

If Minimax system prompt is unset/empty, it falls back to one `user` message for compatibility.

### Success (`stream=false`)

`200 OK`

```json
{
  "ok": true,
  "result": "我今天身體不適，想請半天假。"
}
```

### Success (`stream=true`)

`200 OK`, content-type: `application/x-ndjson`

Each line is JSON. Canonical chunk format:

```json
{"response":"我今天","done":false}
{"response":"身體不適，","done":false}
{"response":"想請半天假。","done":false}
{"response":"","done":true,"done_reason":"stop"}
```

### Warming/startup responses

`202 Accepted` + `Retry-After`

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

or

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

### Provider/state specific responses

- `202 MODEL_WARMING` can still occur in Ollama mode even when prior `/readyz` was green, because the rewrite path enforces a strict freshness check on readiness probe cache before forwarding requests.
- `429 MINIMAX_RECOVERY_COOLDOWN` (Minimax mode, bounded recovery cooldown active) + `Retry-After`.
- `503 MODEL_STARTUP_DEGRADED` (startup warmup budget exceeded and not in active Minimax recovery attempt).

Example (`429`):

```json
{
  "ok": false,
  "error": {
    "code": "MINIMAX_RECOVERY_COOLDOWN",
    "message": "Minimax recovery attempt cooldown active, retry after 10 seconds."
  },
  "retryAfterSec": 10
}
```

Example (`503`):

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

### Validation errors

- `400 INVALID_INPUT` when `text` missing/non-string/empty.
- `413 TOO_LONG` when over the configured max length in Unicode characters (`REWRITE_MAX_TEXT_LENGTH`, default 200).
- `400 INVALID_JSON` for malformed JSON body.

### Authentication/authorization errors

- `401 AUTH_REQUIRED` when `X-Bridge-Auth` is missing/invalid, or when authenticated email is absent.
- `401 AUTH_HEADER_INVALID` when `X-Authenticated-Email` is malformed (for example multiple values).
- `403 FORBIDDEN_DOMAIN` when authenticated email domain is not `hs.edu.hk`.

### Upstream/provider errors

Possible non-2xx statuses from rewrite path:

- `502` provider/model request failure
- `504` timeout (`MODEL_TIMEOUT` or `MODEL_COLD_START_TIMEOUT`)

Provider-specific error codes:

- Ollama: `OLLAMA_ERROR`, `MODEL_TIMEOUT`, `MODEL_COLD_START_TIMEOUT`
- Minimax: `PROVIDER_ERROR`, `PROVIDER_AUTH_ERROR`, `MODEL_TIMEOUT`, `MODEL_COLD_START_TIMEOUT`

Streaming error chunk example:

```json
{"done":true,"error":{"code":"PROVIDER_AUTH_ERROR","message":"Provider authentication failed","status":502}}
```

---

## 2) `GET /model-status`

Diagnostics endpoint for service state + warmup + readiness internals.

### Calling methods

```bash
curl -sS http://127.0.0.1:3001/model-status | jq
curl -sS https://<your-domain>/api/rewrite-bridge/model-status | jq
```

### Response (`200`)

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
  "probeAgeMs": 350,
  "minimaxPassiveReadiness": null
}
```

`status` can be:

- `warming`
- `ready`
- `degraded`

In Minimax mode, `minimaxPassiveReadiness` is an object containing:

- `ready`, `reason`
- `lastRewriteSuccessAt`, `lastRewriteFailureAt`
- `consecutiveRewriteFailures`
- `lastRecoveryAttemptAt`
- `recoveryAttemptCooldownMs`, `passiveReadyGraceMs`, `failOpenOnIdle`, `failureThreshold`

---

## 3) `GET /healthz`

Process liveness check.

### Calling methods

```bash
curl -i -sS http://127.0.0.1:3001/healthz
curl -i -sS https://<your-domain>/api/rewrite-bridge/healthz
```

### Response (`200`)

```json
{ "ok": true }
```

---

## 4) `GET /readyz`

Traffic-readiness gate.

### Calling methods

```bash
curl -i -sS http://127.0.0.1:3001/readyz
curl -i -sS https://<your-domain>/api/rewrite-bridge/readyz
```

### Success (`200`)

```json
{ "ok": true, "serviceState": "ready", "reason": null }
```

### Not ready (`503`)

```json
{ "ok": false, "serviceState": "starting", "reason": "STARTING_WARMUP" }
```

Possible `reason` values:

- Ollama mode: `MODEL_NOT_READY`, `MODEL_PROBE_UNAVAILABLE`, `STARTING_WARMUP`, `STARTUP_DEGRADED`
- Minimax mode: `MINIMAX_API_KEY_MISSING`, `MINIMAX_RECENT_FAILURES`, `MINIMAX_NOT_READY`

---

## 5) Global route/error behavior

### Unknown route

`404 NOT_FOUND`

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Not Found"
  }
}
```

### Malformed JSON

`400 INVALID_JSON`

### Unhandled server exception

`500 INTERNAL_ERROR`

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

## 6) Provider differences and result-shape normalization

The bridge normalizes provider output before returning data to clients.

- Non-stream result always emits `{"ok":true,"result":"..."}` on success.
- Stream result always emits NDJSON chunks with `response` + `done` (+ optional `done_reason`).

Backend parsing coverage currently includes:

- Ollama stream lines (`response`, `done`, `done_reason`).
- Minimax sync response variants:
  - `reply`
  - `choices[0].message.content`
  - `choices[0].text`
- Minimax SSE variants:
  - `choices[0].delta.content`
  - final `choices[0].message.content`
  - `choices[0].finish_reason`
  - terminal `[DONE]`

This allows clients to consume one stable external response contract regardless of selected provider.

