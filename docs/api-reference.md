# API Reference (hk-ollama-rewrite-bridge)

This document reflects the current server implementation and is intended for downstream applications that integrate with the API.

- Internal bind: `http://127.0.0.1:3001`
- Typical public namespace via reverse proxy: `/api/rewrite-bridge/*`
- Protected routes: `POST /rewrite`, `POST /t2a`

## Global conventions

### Error envelope

All JSON error responses use this shape:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

Extra top-level fields may be included for retry or diagnostic purposes, for example `retryAfterSec`, `limit`, `reason`, `serviceState`, or `admission`.

### Authentication trust model

Protected routes require trusted proxy auth headers:

- `X-Authenticated-Email`: normalized authenticated user email ending with `@hs.edu.hk`
- `X-Bridge-Auth`: shared secret matching backend `BRIDGE_INTERNAL_AUTH_SECRET`

Requests missing either trusted signal are rejected with `401 AUTH_REQUIRED`.

Reverse proxy must strip these headers from inbound client traffic and set them server-side only after successful auth.

### Client identity and limiter key extraction

`req.clientIdentity.limiterKey` resolves as follows:

1. `user:<value>` only when:
   - source address is in `TRUSTED_PROXY_ADDRESSES`
   - `X-Bridge-Auth` matches `BRIDGE_INTERNAL_AUTH_SECRET`
   - first non-empty trusted identity header exists in this order:
     1. `X-Authenticated-Email`
     2. `X-Authenticated-User`
     3. `X-Authenticated-Subject`
2. Otherwise, `ip:*` fallback is used.

With `EXPRESS_TRUST_PROXY=loopback` or a numeric hop count, Express-derived client IP is used for the IP fallback path. With `EXPRESS_TRUST_PROXY=false`, socket remote address is used.

### Rate-limiting layers

Rate limiting uses fixed-window policies:

- Global baseline for non-ops routes via `RATE_LIMIT_GLOBAL_*`
- Rewrite route limiter via `RATE_LIMIT_REWRITE_*`
- T2A route limiter via `RATE_LIMIT_T2A_*`
- Ops limiter for `/healthz` and `/readyz` via `RATE_LIMIT_OPS_*`

T2A shares the same admission-controller execution path as rewrite, so concurrency and queue limits are still driven by the shared admission settings.

| Variable | Default | Meaning |
|---|---:|---|
| `RATE_LIMIT_GLOBAL_WINDOW_SEC` | `60` | Global baseline window length. |
| `RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `300` | Global baseline request budget. |
| `RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC` | `60` | Rewrite authenticated principal window. |
| `RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS` | `60` | Rewrite authenticated principal budget. |
| `RATE_LIMIT_REWRITE_IP_WINDOW_SEC` | `60` | Rewrite IP fallback window. |
| `RATE_LIMIT_REWRITE_IP_MAX_REQUESTS` | `20` | Rewrite IP fallback budget. |
| `RATE_LIMIT_T2A_AUTH_WINDOW_SEC` | `60` | T2A authenticated principal window. |
| `RATE_LIMIT_T2A_AUTH_MAX_REQUESTS` | `30` | T2A authenticated principal budget. |
| `RATE_LIMIT_T2A_IP_WINDOW_SEC` | `60` | T2A IP fallback window. |
| `RATE_LIMIT_T2A_IP_MAX_REQUESTS` | `10` | T2A IP fallback budget. |
| `RATE_LIMIT_OPS_WINDOW_SEC` | `60` | Ops route window. |
| `RATE_LIMIT_OPS_MAX_REQUESTS` | `1000` | Ops route budget. |

## Service-scoped configuration model

Configuration resolves with this general pattern:

1. service-scoped keys
2. legacy keys
3. built-in defaults

Naming conventions:

- `<SERVICE_ID>_PROVIDER`
- `<SERVICE_ID>_<PROVIDER>_MODEL` or `<SERVICE_ID>_PROVIDER_<PROVIDER>_MODEL`
- `<SERVICE_ID>_MAX_TEXT_LENGTH`
- rewrite only: `<SERVICE_ID>_MAX_COMPLETION_TOKENS`
- service-specific timeouts such as `REWRITE_READY_TIMEOUT_MS`, `REWRITE_COLD_TIMEOUT_MS`, `T2A_INVOKE_TIMEOUT_MS`

### Rewrite compatibility mapping

| Legacy | Preferred |
|---|---|
| `OLLAMA_MODEL` | `REWRITE_OLLAMA_MODEL` / `REWRITE_PROVIDER_OLLAMA_MODEL` |
| `OLLAMA_URL` | `REWRITE_OLLAMA_URL` / `REWRITE_PROVIDER_OLLAMA_URL` |
| `OLLAMA_PS_URL` | `REWRITE_OLLAMA_PS_URL` / `REWRITE_PROVIDER_OLLAMA_PS_URL` |
| `MINIMAX_MODEL` | `REWRITE_MINIMAX_MODEL` / `REWRITE_PROVIDER_MINIMAX_MODEL` |
| `MINIMAX_API_URL` | `REWRITE_MINIMAX_API_URL` / `REWRITE_PROVIDER_MINIMAX_API_URL` |
| `OLLAMA_TIMEOUT_MS` | `REWRITE_READY_TIMEOUT_MS` |
| `OLLAMA_COLD_TIMEOUT_MS` | `REWRITE_COLD_TIMEOUT_MS` |

### T2A compatibility mapping

| Legacy | Preferred |
|---|---|
| `MINIMAX_T2A_URL` | `T2A_MINIMAX_API_URL` / `T2A_PROVIDER_MINIMAX_API_URL` / `T2A_URL` |
| `MINIMAX_T2A_MODEL` | `T2A_MINIMAX_MODEL` / `T2A_PROVIDER_MINIMAX_MODEL` / `T2A_MODEL` |
| `MINIMAX_T2A_VOICE_ID` | `T2A_MINIMAX_VOICE_ID` / `T2A_PROVIDER_MINIMAX_VOICE_ID` / `T2A_VOICE_ID` |
| `MINIMAX_T2A_SPEED` | `T2A_MINIMAX_SPEED` / `T2A_PROVIDER_MINIMAX_SPEED` / `T2A_SPEED` |
| `MINIMAX_T2A_VOLUME` | `T2A_MINIMAX_VOLUME` / `T2A_PROVIDER_MINIMAX_VOLUME` / `T2A_VOLUME` |
| `MINIMAX_T2A_PITCH` | `T2A_MINIMAX_PITCH` / `T2A_PROVIDER_MINIMAX_PITCH` / `T2A_PITCH` |

## 1) `POST /rewrite`

Rewrite Hong Kong colloquial Cantonese into formal Traditional Chinese.

### Routes

- Internal: `POST /rewrite`
- Typical public route: `POST /api/rewrite-bridge/rewrite`

### Request body

```json
{
  "text": "你今日得唔得閒？",
  "stream": false
}
```

#### Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | Yes | Trimmed, non-empty, max `REWRITE_MAX_TEXT_LENGTH` Unicode characters. |
| `stream` | boolean/string/number | No | `true`, `"true"`, `1`, `"1"` request NDJSON streaming; only works when provider capability and env toggles both allow it. |

### Rewrite request examples

```bash
curl -i -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <shared-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'
```

```bash
curl -i -sS https://<your-domain>/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'
```

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

`artifacts` and `usage` are optional additive metadata.

### Success (`stream=true`)

`200 OK` with `Content-Type: application/x-ndjson`

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

A similar `202` contract may also use `MODEL_WARMUP_STARTED`.

### Common non-2xx responses

- `400 INVALID_INPUT`
- `400 INVALID_JSON`
- `401 AUTH_REQUIRED`
- `401 AUTH_HEADER_INVALID`
- `403 FORBIDDEN_DOMAIN`
- `413 TOO_LONG`
- `429 RATE_LIMITED`
- `429 MINIMAX_RECOVERY_COOLDOWN`
- `501 STREAMING_UNSUPPORTED`
- `503 MODEL_STARTUP_DEGRADED`
- `503 ADMISSION_OVERLOADED`
- provider-mapped failures such as `OLLAMA_ERROR`, `PROVIDER_ERROR`, `PROVIDER_AUTH_ERROR`
- `504 MODEL_TIMEOUT` or `MODEL_COLD_START_TIMEOUT`

### Client integration notes for rewrite

- Use non-streaming JSON if your app only needs final text.
- Use streaming only when you explicitly need progressive rendering and your environment enables it.
- Always handle `202` and `503` gracefully; do not assume the model is immediately ready after process start.

## 2) `POST /t2a`

Generate speech audio from validated text input using the T2A service definition.

### Routes

- Internal: `POST /t2a`
- Internal alternate: `POST /api/t2a`
- Typical public route: `POST /api/rewrite-bridge/t2a`

### Runtime behavior

- T2A uses `T2A_INVOKE_TIMEOUT_MS` for provider invocation timeout.
- `stream=true` is not supported in v1.
- Default provider is Minimax-compatible.
- Server-side defaults are applied for voice and audio settings when optional fields are omitted.

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

#### Field reference

| Field | Type | Required | Accepted values / behavior |
|---|---|---|---|
| `text` | string | Yes | Trimmed, non-empty, max `T2A_MAX_TEXT_LENGTH` Unicode characters. |
| `response_mode` | string | No | `binary`, `default`, `base64_json`, `base64-json`. Omitted defaults to `binary`. |
| `voice_id` | string | No | Non-empty string. Defaults from T2A env config. |
| `speed` | number | No | `0.5` to `2`. Defaults from T2A env config. |
| `volume` | number | No | `0` to `10`. Defaults from T2A env config. |
| `pitch` | number | No | `-12` to `12`. Defaults from T2A env config. |
| `sample_rate` | integer | No | `8000` to `48000`. Defaults to `32000`. |
| `bitrate` | integer | No | `32000` to `320000`. Defaults to `128000`. |
| `format` | string | No | `mp3`, `wav`, or `pcm`. Defaults to `mp3`. |
| `stream` | boolean/string/number | No | If truthy in the supported forms, request is rejected with `501 STREAMING_UNSUPPORTED`. |

### Effective server-side defaults

If optional fields are omitted, T2A resolves to:

```json
{
  "voice_id": "Cantonese_ProfessionalHost（F)",
  "speed": 1,
  "volume": 1,
  "pitch": 0,
  "sample_rate": 32000,
  "bitrate": 128000,
  "format": "mp3"
}
```

In addition, upstream Minimax requests are sent with:

- `stream=false`
- `audio_setting.channel=1`
- `language_boost="Chinese,Yue"`
- `voice_modify={"pitch":0,"intensity":0,"timbre":0}`
- `output_format="hex"`

These are implementation defaults, not caller-supplied request fields in the current public API.

### Calling examples

#### Binary response for playback/download

```bash
curl -i -sS http://127.0.0.1:3001/t2a \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <shared-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你好，歡迎使用","response_mode":"binary"}' \
  --output speech.mp3
```

#### JSON response for apps that want a single JSON payload

```bash
curl -i -sS http://127.0.0.1:3001/t2a \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <shared-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你好，歡迎使用","response_mode":"base64_json","voice_id":"Cantonese_ProfessionalHost（F)","speed":1.1,"sample_rate":32000,"bitrate":128000,"format":"mp3"}'
```

### Binary success (`response_mode=binary` or omitted)

`200 OK`

Typical headers:

- `Content-Type: audio/mpeg`
- `Content-Length: <bytes>`
- `Content-Disposition: inline; filename="speech.mp3"`

Body: raw audio bytes.

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
- provider-mapped failures such as `PROVIDER_AUTH_ERROR`, `PROVIDER_ERROR`, `MODEL_TIMEOUT`

### Client integration notes for T2A

- Prefer `binary` when your app can handle bytes directly.
- Prefer `base64_json` when you need to keep the response inside a JSON contract.
- Validate numeric options client-side before sending them so users get immediate feedback.
- The bridge does not persist audio files; callers are responsible for storing, caching, or replaying the returned data.

## 3) `GET /model-status`

Diagnostics endpoint for frontend polling and operator troubleshooting.

### Routes

- Internal: `GET /model-status`
- Typical public route: `GET /api/rewrite-bridge/model-status`

### Example response

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

### Notes

- This endpoint describes rewrite service readiness, startup warmup, and Minimax passive-readiness information.
- It is useful for UI state and operations dashboards.
- It is not a guarantee that the next protected request will succeed; callers must still handle real route responses.

## 4) `GET /healthz`

Process liveness check.

### Response

`200 OK`

```json
{ "ok": true }
```

## 5) `GET /readyz`

Traffic-readiness gate.

### Success

`200 OK`

```json
{ "ok": true, "serviceState": "ready", "reason": null }
```

### Not ready

`503 Service Unavailable`

```json
{ "ok": false, "serviceState": "starting", "reason": "STARTING_WARMUP" }
```

Possible `reason` values include:

- Ollama mode: `MODEL_NOT_READY`, `MODEL_PROBE_UNAVAILABLE`, `STARTING_WARMUP`, `STARTUP_DEGRADED`
- Minimax mode: `MINIMAX_API_KEY_MISSING`, `MINIMAX_RECENT_FAILURES`, `MINIMAX_NOT_READY`

## Downstream application checklist

When building another app on top of this API, implement the following:

1. Call the public `/api/rewrite-bridge/*` routes in production.
2. Send JSON with `Content-Type: application/json` for rewrite and T2A requests.
3. Handle `401`, `403`, `429`, `503`, and provider timeout errors as first-class outcomes.
4. For T2A, choose `binary` vs `base64_json` intentionally based on your transport and UI needs.
5. Treat optional response metadata as additive rather than required.
6. Do not rely on undocumented fields or internal-only defaults beyond what is listed in this document.
