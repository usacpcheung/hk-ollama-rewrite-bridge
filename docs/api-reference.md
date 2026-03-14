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

## Service-scoped environment naming and compatibility

Rewrite service resolves configuration with this order:
1. New service-scoped keys
2. Legacy keys
3. Built-in defaults

Naming convention:
- `<SERVICE_ID>_PROVIDER`
- `<SERVICE_ID>_<PROVIDER>_MODEL` or `<SERVICE_ID>_PROVIDER_<PROVIDER>_MODEL`
- `<SERVICE_ID>_MAX_COMPLETION_TOKENS`, `<SERVICE_ID>_MAX_TEXT_LENGTH`
- Optional timeouts such as `<SERVICE_ID>_READY_TIMEOUT_MS`, `<SERVICE_ID>_COLD_TIMEOUT_MS`

### Compatibility table (rewrite)

| Legacy | Preferred |
|---|---|
| `OLLAMA_MODEL` | `REWRITE_OLLAMA_MODEL` / `REWRITE_PROVIDER_OLLAMA_MODEL` |
| `MINIMAX_MODEL` | `REWRITE_MINIMAX_MODEL` / `REWRITE_PROVIDER_MINIMAX_MODEL` |
| `OLLAMA_TIMEOUT_MS` | `REWRITE_READY_TIMEOUT_MS` |
| `OLLAMA_COLD_TIMEOUT_MS` | `REWRITE_COLD_TIMEOUT_MS` |

`REWRITE_PROVIDER`, `REWRITE_MAX_COMPLETION_TOKENS`, and `REWRITE_MAX_TEXT_LENGTH` remain valid as-is.

### Migration examples

Rewrite service:

```bash
REWRITE_PROVIDER=minimax \
REWRITE_MINIMAX_MODEL=M2-her \
REWRITE_MAX_COMPLETION_TOKENS=400
```

Hypothetical summarize service:

```bash
SUMMARIZE_PROVIDER=ollama \
SUMMARIZE_OLLAMA_MODEL=qwen2.5:7b-instruct
```

## 1) `POST /rewrite`

Rewrite HK colloquial Cantonese into formal Traditional Chinese.

### Debug logging toggle

Set environment variable `REWRITE_DEBUG_RAW_OUTPUT=true` to emit structured provider debug logs:
- `provider_request`: outbound provider payload shape (request body)
- `provider_response_meta`: response-side metadata such as usage counters

Sensitive values are redacted (`Authorization`, `apiKey`, `X-Bridge-Auth`, secrets/tokens).

Example journal check:

```bash
journalctl -u rewrite-bridge -n 200 --no-pager | rg '"eventType":"provider_(request|response_meta)"'
```

### Boolean environment-value parsing

`WARMUP_ON_START` and `MINIMAX_FAIL_OPEN_ON_IDLE` use shared boolean parsing semantics:

- True values: `1`, `true`, `yes`, `on`
- False values: `0`, `false`, `no`, `off`
- Parsing is case-insensitive; unset/empty values fall back to defaults.

### Runtime token-limit configuration

- `REWRITE_MAX_COMPLETION_TOKENS` controls provider output token budget for both `stream=false` and `stream=true` rewrite paths.
- Default: `300`.
- Validation: must be a positive integer in range `1-8192`; empty/invalid/out-of-range values are ignored and default is used.
- Provider mapping:
  - Ollama: forwarded as `options.num_predict`.
  - Minimax: forwarded as `max_completion_tokens`.

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
      "content": "把下方文字改寫為繁體書面語：\n我今日唔係好舒服，想請半日假。"
    }
  ],
  "stream": false
}
```

The bridge uses built-in system/user prompt construction for Minimax and ignores prompt-template environment-variable overrides.

### Success (`stream=false`)

`200 OK`

```json
{
  "ok": true,
  "result": "我今天身體不適，想請半天假。",
  "usage": {
    "prompt_eval_count": 18,
    "eval_count": 24
  }
}
```

### Success (`stream=true`)

`200 OK`, content-type: `application/x-ndjson`

Each line is JSON. Canonical chunk format:

```json
{"response":"我今天","done":false}
{"response":"身體不適，","done":false}
{"response":"想請半天假。","done":false}
{"response":"","done":true,"done_reason":"stop","usage":{"total_tokens":42}}
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

- Non-stream result always emits `{"ok":true,"result":"..."}` on success, with optional additive `usage` when provider metadata is available.
- Stream result always emits NDJSON chunks with `response` + `done` (+ optional `done_reason`, and optional `usage` on terminal done chunk).

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

