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

Protected routes (for example `POST /rewrite` and `POST /t2a`) require two trusted headers from the reverse proxy:

- `X-Authenticated-Email`: normalized user email claim (must end with `@hs.edu.hk`)
- `X-Bridge-Auth`: shared secret that must match backend env `BRIDGE_INTERNAL_AUTH_SECRET`

Requests missing either trusted signal are rejected with `401 AUTH_REQUIRED`.

Reverse proxy must unset these headers from inbound client traffic and set them server-side only after successful auth.

`EXPRESS_TRUST_PROXY` controls whether Express should derive client IP from forwarded headers. Allowed values are `false`, `loopback`, or numeric hop count (`1`, `2`, ...). Use `loopback` when Apache/Nginx is local; avoid broad `true` because it trusts all upstream forwarding metadata.

### Limiter key identity extraction

Request middleware computes `req.clientIdentity.limiterKey` with this logic:

1. Use `user:<value>` only when all conditions are true:
   - socket remote address is in `TRUSTED_PROXY_ADDRESSES` (default `127.0.0.1,::1`)
   - `X-Bridge-Auth` exactly matches `BRIDGE_INTERNAL_AUTH_SECRET`
   - first non-empty trusted identity header exists in this order:
     1. `X-Authenticated-Email`
     2. `X-Authenticated-User`
     3. `X-Authenticated-Subject`
2. Otherwise use `ip:*` fallback identity: when `EXPRESS_TRUST_PROXY` is enabled (recommended `loopback` for local reverse proxy), key on Express-computed `req.ip`; when `EXPRESS_TRUST_PROXY=false`, key on socket `remoteAddress`.

Because trusted OIDC headers are ignored when source IP or shared secret checks fail, direct public backend access cannot spoof limiter identity with forged OIDC headers.

---


## Rate-limiting policy and environment

Rate limiting uses layered fixed-window policies:
- Global baseline limiter for non-ops routes (`RATE_LIMIT_GLOBAL_*`).
- Rewrite service limiter (`POST /rewrite`) with principal-aware quotas:
  - Authenticated/trusted identity (`user:*`) uses `RATE_LIMIT_REWRITE_AUTH_*`.
  - IP fallback (`ip:*`) uses `RATE_LIMIT_REWRITE_IP_*`.
- T2A service limiter (`POST /t2a`) with principal-aware quotas:
  - Authenticated/trusted identity (`user:*`) uses `RATE_LIMIT_T2A_AUTH_*`.
  - IP fallback (`ip:*`) uses `RATE_LIMIT_T2A_IP_*`.
- Ops limiter for `/healthz` and `/readyz` (`RATE_LIMIT_OPS_*`, relaxed defaults).
- Admission controls remain shared through rewrite/provider admission settings; T2A does not introduce separate admission env vars.

Invalid rate-limit env values fail fast during startup.

| Variable | Default | Meaning |
|---|---:|---|
| `RATE_LIMIT_GLOBAL_WINDOW_SEC` | `60` | Global baseline window length (seconds). |
| `RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `300` | Global baseline max requests per principal/window. |
| `RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC` | `60` | Rewrite authenticated principal window length. |
| `RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS` | `60` | Rewrite authenticated principal request budget. |
| `RATE_LIMIT_REWRITE_IP_WINDOW_SEC` | `60` | Rewrite IP-fallback window length. |
| `RATE_LIMIT_REWRITE_IP_MAX_REQUESTS` | `20` | Rewrite IP-fallback request budget. |
| `RATE_LIMIT_T2A_AUTH_WINDOW_SEC` | `60` | T2A authenticated principal window length. |
| `RATE_LIMIT_T2A_AUTH_MAX_REQUESTS` | `30` | T2A authenticated principal request budget. |
| `RATE_LIMIT_T2A_IP_WINDOW_SEC` | `60` | T2A IP-fallback window length. |
| `RATE_LIMIT_T2A_IP_MAX_REQUESTS` | `10` | T2A IP-fallback request budget. |
| `RATE_LIMIT_OPS_WINDOW_SEC` | `60` | Ops endpoint window length. |
| `RATE_LIMIT_OPS_MAX_REQUESTS` | `1000` | Ops endpoint request budget. |

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
- Streaming toggle keys: `<SERVICE_ID>_STREAMING_ENABLED`, `<SERVICE_ID>_PROVIDER_STREAMING_ENABLED`, optional `<SERVICE_ID>_<PROVIDER>_STREAMING_ENABLED`
- Admission defaults: `ADMISSION_MAX_CONCURRENCY`, `ADMISSION_MAX_QUEUE_SIZE`, `ADMISSION_MAX_WAIT_MS`
- Optional provider admission overrides: `<PROVIDER>_MAX_CONCURRENCY`, `<PROVIDER>_MAX_QUEUE_SIZE`, `<PROVIDER>_MAX_WAIT_MS`

### Compatibility table (rewrite)

| Legacy | Preferred |
|---|---|
| `OLLAMA_MODEL` | `REWRITE_OLLAMA_MODEL` / `REWRITE_PROVIDER_OLLAMA_MODEL` |
| `OLLAMA_URL` | `REWRITE_OLLAMA_URL` / `REWRITE_PROVIDER_OLLAMA_URL` |
| `OLLAMA_PS_URL` | `REWRITE_OLLAMA_PS_URL` / `REWRITE_PROVIDER_OLLAMA_PS_URL` |
| `MINIMAX_MODEL` | `REWRITE_MINIMAX_MODEL` / `REWRITE_PROVIDER_MINIMAX_MODEL` |
| `MINIMAX_API_URL` | `REWRITE_MINIMAX_API_URL` / `REWRITE_PROVIDER_MINIMAX_API_URL` |
| `OLLAMA_TIMEOUT_MS` | `REWRITE_READY_TIMEOUT_MS` |
| `OLLAMA_COLD_TIMEOUT_MS` | `REWRITE_COLD_TIMEOUT_MS` |
| (none) | `REWRITE_STREAMING_ENABLED` / `REWRITE_PROVIDER_STREAMING_ENABLED` / `REWRITE_<PROVIDER>_STREAMING_ENABLED` |

`REWRITE_PROVIDER`, `REWRITE_MAX_COMPLETION_TOKENS`, and `REWRITE_MAX_TEXT_LENGTH` remain valid as-is.

Streaming capability for the selected provider resolves with this precedence:
1. `REWRITE_STREAMING_ENABLED`
2. `REWRITE_PROVIDER_STREAMING_ENABLED`
3. `REWRITE_<PROVIDER>_STREAMING_ENABLED` (for example `REWRITE_OLLAMA_STREAMING_ENABLED`)

Accepted values are `true`/`false` and `1`/`0` (case-insensitive). Unset or invalid values default to `false`.

Effective streaming support is computed as:
`providerSupportsStreaming && envStreamingEnabled`

This preserves provider hard limits while allowing operator control.

### Migration examples

Rewrite service:

```bash
REWRITE_PROVIDER=minimax \
REWRITE_MINIMAX_MODEL=M2-her \
REWRITE_MINIMAX_API_URL=https://api.minimax.io/v1/text/chatcompletion_v2 \
REWRITE_OLLAMA_URL=http://127.0.0.1:11434/api/generate \
REWRITE_OLLAMA_PS_URL=http://127.0.0.1:11434/api/ps \
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
  - Server-side capability still applies: streaming runs only when provider supports it and env-controlled streaming capability resolves to enabled; otherwise API returns `501 STREAMING_UNSUPPORTED`.

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

### Forward-compatible response convention

- Primary response remains JSON.
- Rewrite output remains text-first today via `result`.
- Encoded values (for example hex/base64) must be nested in explicit fields such as `artifacts[].encoding` and `artifacts[].data`, rather than overloading `result`.
- Encoded artifact fields are optional and service-dependent.

### Success (`stream=false`)

`200 OK`

```json
{
  "ok": true,
  "result": "我今天身體不適，想請半天假。",
  "artifacts": [
    {
      "kind": "provider_trace",
      "encoding": "base64",
      "data": "eyJwcm92aWRlciI6Im1pbmltYXgifQ=="
    }
  ],
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
- `429 RATE_LIMITED` when any configured limiter budget is exceeded, with `Retry-After` and a stable payload contract.
- `503 ADMISSION_OVERLOADED` when admission queue is full or queue wait time exceeds budget (`reason` is `queue_full` or `wait_timeout`).

Example (`429 RATE_LIMITED`):

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests, please retry later.",
    "reason": "RATE_LIMIT_EXCEEDED"
  },
  "retryAfterSec": 12,
  "limit": {
    "scope": "rewrite",
    "principalType": "user",
    "windowSec": 60,
    "maxRequests": 60
  }
}
```

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

Example (`503 ADMISSION_OVERLOADED`):

```json
{
  "ok": false,
  "error": {
    "code": "ADMISSION_OVERLOADED",
    "message": "Admission controller overloaded. Please retry shortly."
  },
  "reason": "queue_full",
  "admission": {
    "provider": "ollama",
    "maxConcurrency": 4,
    "maxQueueSize": 100,
    "maxWaitMs": 15000,
    "queueDepth": 100,
    "inFlight": 4
  }
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


## 1b) `POST /t2a`

Generate speech audio from validated text input using the T2A service definition.

### Routes

- Internal: `POST /t2a`
- Internal alternate: `POST /api/t2a`
- Typical public reverse-proxy mapping: `POST /api/rewrite-bridge/t2a`

### Middleware parity

T2A uses the same middleware chain and request identity behavior as rewrite:
- `express.json()` body parsing
- shared `req.clientIdentity` resolution from `auth/client-identity.js`
- global limiter + service-specific route limiter (`RATE_LIMIT_REWRITE_*` for rewrite, `RATE_LIMIT_T2A_*` for T2A)
- shared header auth from `auth/header-auth.js`
- shared admission controller execution wrapper sourced from rewrite/provider admission config
- shared JSON error envelope and provider error mapping pattern

### Request body

```json
{
  "text": "你好，歡迎使用",
  "response_mode": "binary",
  "voice_id": "Cantonese_ProfessionalHost（F)",
  "speed": 1,
  "volume": 1,
  "pitch": 0,
  "sample_rate": 32000,
  "bitrate": 128000,
  "format": "mp3"
}
```

Validation rules:
- `text` is required, trimmed, non-empty, and capped by `T2A_MAX_TEXT_LENGTH` Unicode characters.
- `response_mode` accepts `binary`, `default`, `base64_json`, or `base64-json`.
- `voice_id` must be a non-empty string when provided.
- `speed` must be between `0.5` and `2`.
- `volume` must be between `0` and `10`.
- `pitch` must be between `-12` and `12`.
- `sample_rate` must be an integer between `8000` and `48000`.
- `bitrate` must be an integer between `32000` and `320000`.
- `format` must be one of `mp3`, `wav`, or `pcm`.
- `stream=true` is not supported in v1 and returns `501 STREAMING_UNSUPPORTED`.
- Upstream Minimax requests are sent with `stream=false`, `audio_setting.channel=1`, `language_boost="Chinese,Yue"`, `voice_modify={ pitch: 0, intensity: 0, timbre: 0 }`, and `output_format="hex"`.

### Binary success (default)

`200 OK`

Headers:
- `Content-Type: audio/mpeg`
- `Content-Length: <bytes>`
- `Content-Disposition: inline; filename="speech.mp3"`

Body: raw MP3 bytes.

### JSON success (`response_mode=base64_json`)

`200 OK`

```json
{
  "ok": true,
  "audio": "<base64-audio>",
  "format": "mp3",
  "mime": "audio/mpeg",
  "contentType": "audio/mpeg",
  "size": 12345,
  "provider": {
    "traceId": "trace-123",
    "audioLength": 12345,
    "sourcePath": "data.audio"
  }
}
```

The bridge does not write audio files to disk; it returns provider audio bytes directly from memory.

### Common non-2xx responses

- `400 INVALID_INPUT`
- `401 AUTH_REQUIRED`
- `401 AUTH_HEADER_INVALID`
- `403 FORBIDDEN_DOMAIN`
- `413 TOO_LONG`
- `429 RATE_LIMITED`
- `501 STREAMING_UNSUPPORTED`
- `503 MINIMAX_API_KEY_MISSING`
- `503 ADMISSION_OVERLOADED`
- provider-mapped upstream failures such as `PROVIDER_AUTH_ERROR`, `PROVIDER_ERROR`, or `MODEL_TIMEOUT`

### Examples

```bash
curl -i -sS http://127.0.0.1:3001/t2a \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <shared-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你好，歡迎使用"}' \
  --output speech.mp3
```

```bash
curl -i -sS http://127.0.0.1:3001/t2a \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <shared-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你好，歡迎使用","response_mode":"base64_json"}'
```

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
