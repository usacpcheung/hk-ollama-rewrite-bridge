# API Reference (hk-ollama-rewrite-bridge)

This document reflects the current server implementation and is intended for downstream applications that integrate with the API.

- Internal bind: `http://127.0.0.1:3001`
- Typical public namespace via reverse proxy: `/api/rewrite-bridge/*`
- Protected routes: `POST /rewrite`, `POST /t2a`, `POST /transcriptions` (and their `/api/` aliases)

## Transcription

Public route: `POST /api/rewrite-bridge/transcriptions`, proxied to internal
`POST /transcriptions` (also available as `/api/transcriptions`). Uses the same
trusted-header authentication and domain policy as rewrite. Google credentials
are never sent to the browser. This is one request/response per completed recording;
there is no job identifier to poll and no server-triggered rewrite call.

Browser requests must come from an exact `TRANSCRIPTION_ALLOWED_ORIGINS` entry;
cross-site uploads are rejected. This protects authenticated multipart uploads
from cross-site form submission. No cross-origin browser access is enabled.
Authenticated server-to-server calls may omit Origin.

Send `multipart/form-data` containing exactly one file named `audio`, with no
additional fields and no Content-Encoding. Maximum audio size is 20 MiB plus
64 KiB for multipart framing; maximum duration is 60 decoded seconds (both can
be configured lower). Empty files, multiple audio streams, video, and unsupported
codecs fail validation. Supported actual media: PCM WAV (8/16/24/32-bit integer
or 32-bit float), native FLAC, MP3, AAC in MP4/M4A/MOV, and Opus in WebM/OGG.
One or two channels and sample rates 8–192 kHz are allowed. File extensions and
declared MIME types are not used to validate media. All accepted audio is decoded
to mono 16 kHz, then encoded as FLAC for Google.

Success (`200`, JSON, `Cache-Control: no-store`):

```json
{
  "ok": true,
  "result": "Recognized speech text",
  "durationSeconds": 31.808,
  "requestId": "a-response-correlation-uuid",
  "timings": { "conversionMs": 250, "transcriptionMs": 6000, "totalMs": 6400 }
}
```

Timings above are illustrative, not a latency promise. `conversionMs` excludes
waiting for a conversion slot; `totalMs` includes admission-to-response processing
and upload. Segments are joined with newlines. `result` is transcription, not
rewritten or guaranteed Traditional Chinese. Preserve it before calling rewrite;
Google credentials, provider payloads, original filenames and audio are not returned.

Defaults: up to 10 admitted requests across users, including uploads and work
waiting for either of 2 conversion slots. One active request per user. Six requests
per user per minute, plus the existing global limiter. Google calls run concurrently.
No automatic retries: ambiguous failures can already have incurred charges.

| Status | Error code | Meaning |
|---|---|---|
| 401 / 403 | Existing auth codes | Same authentication/domain checks as rewrite. |
| 403 | `TRANSCRIPTION_ORIGIN_FORBIDDEN` | Browser origin is not allowed or request is cross-site. |
| 400 | `INVALID_UPLOAD` | Missing, empty, malformed, extra or interrupted multipart input. |
| 408 | `UPLOAD_TIMEOUT` | Upload exceeds its total receive deadline (default 120 s). |
| 408 | `TRANSCRIPTION_CANCELLED` | Work was cancelled; normally the disconnected client receives no response. |
| 413 | `AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG` | Size or decoded duration limit exceeded. |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_AUDIO` | Unsupported request format or actual media. |
| 422 | `INVALID_AUDIO`, `NO_SPEECH` | Cannot decode audio or no transcript was recognized. |
| 429 | `RATE_LIMITED` | Existing-style per-user/global request limit. |
| 429 | `TRANSCRIPTION_ALREADY_ACTIVE` | This user has unfinished work. |
| 429 | `TRANSCRIPTION_RATE_LIMITED` | Google quota/capacity rejection. |
| 503 | `TRANSCRIPTION_DISABLED` | Feature is not enabled. |
| 503 | `TRANSCRIPTION_BUSY` | Total admission slots are occupied. |
| 503 | `AUDIO_PROCESSOR_UNAVAILABLE`, `TRANSCRIPTION_UNAVAILABLE` | Local processor/storage, credentials, or service access unavailable. |
| 504 | `AUDIO_PROCESSING_TIMEOUT`, `TRANSCRIPTION_TIMEOUT` | Conversion, provider or total deadline exceeded. |
| 502 | `TRANSCRIPTION_FAILED` | Other provider failure; internal details are suppressed. |

Errors use `{ ok: false, error: { code, message } }`, with `requestId` where assigned.
429/503 handler responses include `Retry-After: 10`; request-rate limiting uses
its window's remaining time. Upload rejection can close the connection.

Disconnecting cancels local upload/conversion work. If Google has already received
the RPC, it may still finish and be charged; its result is discarded, and capacity
is released only after settlement. The total deadline can return 504 while such
a call is still settling. Audio is deleted on success/failure/cancellation; only
an in-flight request holds the transcript in memory. Startup cleanup removes
matching abandoned job directories for dead processes. No job history is stored.

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

- `X-Authenticated-Email`: normalized authenticated user email ending with configured `BRIDGE_AUTH_ALLOWED_EMAIL_DOMAIN`
- `X-Bridge-Auth`: shared secret matching backend `BRIDGE_INTERNAL_AUTH_SECRET`

Requests missing either trusted signal are rejected with `401 AUTH_REQUIRED`.

Reverse proxy must strip these headers from inbound client traffic and set them server-side only after successful auth.

### Client identity and limiter key extraction

`req.clientIdentity.limiterKey` resolves as follows:

1. `user:<value>` only when:
   - source address is in `BRIDGE_TRUSTED_PROXY_ADDRESSES`
   - `X-Bridge-Auth` matches `BRIDGE_INTERNAL_AUTH_SECRET`
   - first non-empty trusted identity header exists in this order:
     1. `X-Authenticated-Email`
     2. `X-Authenticated-User`
     3. `X-Authenticated-Subject`
2. Otherwise, `ip:*` fallback is used.

With `BRIDGE_EXPRESS_TRUST_PROXY=loopback` or a numeric hop count, Express-derived client IP is used for the IP fallback path. With `BRIDGE_EXPRESS_TRUST_PROXY=false`, socket remote address is used.

### Rate-limiting layers

Rate limiting uses fixed-window policies:

- Global baseline for non-ops routes via `RATE_LIMIT_GLOBAL_*`
- Rewrite route limiter via `RATE_LIMIT_REWRITE_*`
- T2A route limiter via `RATE_LIMIT_T2A_*`
- Ops limiter for `/healthz` and `/readyz` via `RATE_LIMIT_OPS_*`

T2A shares the same admission-controller execution path as rewrite, so concurrency and queue limits are still driven by the shared admission settings.

For the canonical env reference and defaults, see `docs/env-reference.md`.

## Configuration reference

Environment variables are documented centrally in `docs/env-reference.md`.
This API reference only describes request and response contracts.

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
| `text` | string | Yes | Trimmed, non-empty, max `REWRITE_MAX_TEXT_LENGTH` Unicode characters (default 200; configurable up to 4,000). |
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

Stream chunks may carry text in either `response` (canonical) or `result` (compatibility) fields.
Clients should accept both and append whichever field is present.

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
- Provider model and protocol changes, including opt-in MiniMax M3, are internal to the bridge and do not change this request or response contract.
- MiniMax thinking/reasoning fields are not exposed to callers.

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
  "language_boost": "Chinese,Yue",
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
| `language_boost` | string | No | Non-empty string forwarded to the selected provider. Omitted defaults to `Chinese,Yue`. |
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
- `language_boost="Chinese,Yue"` when the caller omits `language_boost`
- `voice_modify={"pitch":0,"intensity":0,"timbre":0}`
- `output_format="hex"`

The caller may override `language_boost`; the other values above are implementation defaults, not caller-supplied request fields.

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
  --data '{"text":"Hello, welcome","response_mode":"base64_json","voice_id":"English_expressive_narrator","language_boost":"English","speed":1.1,"sample_rate":32000,"bitrate":128000,"format":"mp3"}'
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
