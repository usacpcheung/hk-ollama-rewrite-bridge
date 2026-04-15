# Rewrite & T2A API Calling Reference

This document is a caller-focused reference for integrating with the bridge APIs.
All request/response contracts below are based on the current server and service code.

- Service bind address (default): `http://127.0.0.1:3001`
- JSON parser limit: `16kb` request body size
- Protected endpoints: both Rewrite and T2A require trusted auth headers

---

## 1) Authentication and required headers

Both Rewrite and T2A routes are protected by the same header-based gate:

- `X-Bridge-Auth`: must exactly match server env `BRIDGE_INTERNAL_AUTH_SECRET`
- `X-Authenticated-Email`: must be a single email ending with `@hs.edu.hk`

If authentication fails, responses are:

- `401 AUTH_REQUIRED` (missing/invalid auth)
- `401 AUTH_HEADER_INVALID` (invalid email header format, e.g. comma-separated)
- `403 FORBIDDEN_DOMAIN` (email domain is not `hs.edu.hk`)

### Deployment expectation (Apache + OIDC)

These protected API paths are designed to be exposed publicly **through a trusted reverse proxy** (for example Apache with an OIDC module), not by direct internet access to the bridge process.

- The bridge validates trusted upstream headers (`X-Bridge-Auth` and `X-Authenticated-Email`), and does not implement interactive OIDC login flows itself.
- Reverse proxy should perform user authentication, inject trusted headers server-side, and strip any client-supplied versions of these headers.
- Keep the bridge service internal/private (default bind is localhost) and only publish proxy routes.

### Minimal working request headers

```http
Content-Type: application/json
X-Bridge-Auth: <bridge-secret>
X-Authenticated-Email: user@hs.edu.hk
```

---

## 2) Rewrite API

### 2.1 Endpoints and method

- `POST /rewrite`
- `POST /api/rewrite`

Both routes are equivalent.

### 2.2 Request body

```json
{
  "text": "我今日唔係好舒服，想請半日假。",
  "stream": false
}
```

### 2.3 Parameters

| Field | Type | Required | Supported values | Notes |
|---|---|---|---|---|
| `text` | string | Yes | non-empty string | Trimmed before validation; Unicode character count limit applies. |
| `stream` | boolean/string/number | No | `true`, `"true"`, `1`, `"1"` to enable stream mode | Any other value is treated as non-stream request. |

### 2.4 Limitations

- `text` max length comes from `REWRITE_MAX_TEXT_LENGTH` (default `200`, hard max `600`).
- Empty or missing `text` returns `400 INVALID_INPUT`.
- Over-limit text returns `413 TOO_LONG`.
- Streaming only works if selected provider supports streaming **and** streaming is enabled by env config.
  - Otherwise: `501 STREAMING_UNSUPPORTED`.
- During warmup/degraded states, Rewrite may return temporary non-200 responses such as:
  - `202 MODEL_WARMING`
  - `202 MODEL_WARMUP_STARTED`
  - `503 MODEL_STARTUP_DEGRADED`

### 2.5 Success response (non-stream)

`200 OK`

```json
{
  "ok": true,
  "result": "我今天身體不適，想請半天假。",
  "usage": {
    "...": "provider-specific usage object"
  }
}
```

Notes:

- `usage` may be omitted if provider does not return usage.
- Rewrite output is post-processed to Traditional Chinese (HK variant).

### 2.6 Success response (stream)

`Content-Type: application/x-ndjson; charset=utf-8`

Example chunk sequence:

```json
{"response":"我今天","done":false}
{"response":"身體不適，想請半天假。","done":false}
{"response":"","done":true,"done_reason":"stop","usage":{"totalTokens":28}}
```

Error in stream mode is emitted as one terminal NDJSON object:

```json
{"done":true,"error":{"code":"PROVIDER_ERROR","message":"...","status":502}}
```

### 2.7 Rewrite curl examples

#### Non-stream

```bash
curl -i -sS 'http://127.0.0.1:3001/rewrite' \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <bridge-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"我今日唔係好舒服，想請半日假。"}'
```

#### Stream mode

```bash
curl -N -i -sS 'http://127.0.0.1:3001/api/rewrite' \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <bridge-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你今日可唔可以幫我跟進？","stream":true}'
```

---

## 3) T2A API (Text-to-Audio)

### 3.1 Endpoints and method

- `POST /t2a`
- `POST /api/t2a`

Both routes are equivalent.

### 3.2 Request body

```json
{
  "text": "你好，世界",
  "voice_id": "Cantonese_ProfessionalHost（F)",
  "speed": 1,
  "volume": 1,
  "pitch": 0,
  "sample_rate": 32000,
  "bitrate": 128000,
  "format": "mp3",
  "response_mode": "binary"
}
```

### 3.3 Parameters

| Field | Type | Required | Range / Allowed values | Default |
|---|---|---|---|---|
| `text` | string | Yes | non-empty string | - |
| `stream` | boolean/string/number | No | If truthy as `true`/`"true"`/`1`/`"1"`, request is rejected | - |
| `voice_id` | string | No | non-empty string | env default voice ID |
| `speed` | number | No | `0.5` to `2` | env/default value |
| `volume` | number | No | `0` to `10` | env/default value |
| `pitch` | number | No | `-12` to `12` | env/default value |
| `sample_rate` | integer | No | `8000` to `48000` | `32000` |
| `bitrate` | integer | No | `32000` to `320000` | `128000` |
| `format` | string | No | `mp3`, `wav`, `pcm` | `mp3` |
| `response_mode` | string | No | `binary` / `default` / `base64_json` / `base64-json` | `binary` |

### 3.4 Limitations

- `text` max length from `T2A_MAX_TEXT_LENGTH` (default `200`, hard max `600`).
- Streaming is **not supported** for T2A v1.
  - If `stream` is requested, server returns `501 STREAMING_UNSUPPORTED`.
- If provider is Minimax and `MINIMAX_API_KEY` is missing, server returns:
  - `503 MINIMAX_API_KEY_MISSING`
- Output audio returned by this bridge is currently normalized to MP3 metadata in the provider layer.
  - Even when `format` is accepted in request validation, callers should treat the returned payload as MP3-compatible output.

### 3.5 Success response when `response_mode=binary` (default)

- HTTP status: `200`
- Response body: raw audio bytes
- Response headers include:
  - `Content-Type`: provider content type (fallback `audio/mpeg`)
  - `Content-Length`
  - `Content-Disposition: inline; filename="speech.<format>"`

### 3.6 Success response when `response_mode=base64_json`

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
    "traceId": "trace-...",
    "audioLength": 12345
  }
}
```

### 3.7 T2A curl examples

#### Binary audio (default)

```bash
curl -i -sS 'http://127.0.0.1:3001/t2a' \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <bridge-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你好，世界"}' \
  --output speech.mp3
```

#### Base64 JSON response

```bash
curl -i -sS 'http://127.0.0.1:3001/api/t2a' \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <bridge-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{"text":"你好，世界","response_mode":"base64_json"}'
```

#### Parameterized request

```bash
curl -i -sS 'http://127.0.0.1:3001/t2a' \
  -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: <bridge-secret>' \
  -H 'X-Authenticated-Email: user@hs.edu.hk' \
  --data '{
    "text":"早晨，各位同學",
    "voice_id":"Cantonese_ProfessionalHost（F)",
    "speed":1.1,
    "volume":1.0,
    "pitch":0,
    "sample_rate":32000,
    "bitrate":128000,
    "format":"mp3",
    "response_mode":"binary"
  }' \
  --output morning.mp3
```

---

## 4) Common error format

All JSON errors follow:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

Some errors include additional fields like `retryAfterSec`, `reason`, `limit`, or `admission`.

---

## 5) Practical integration checklist

1. Always send both trusted headers from your reverse proxy (never from untrusted client traffic directly).
2. Validate text length client-side before sending.
3. For T2A, choose one response path:
   - binary download (`response_mode` omitted), or
   - JSON transport (`response_mode=base64_json`).
4. Handle temporary Rewrite warmup responses (`202`/`503`) with retry logic.
5. Handle `429 RATE_LIMITED` using `Retry-After`.
6. Handle provider-level failures (`502`/`503`) gracefully in caller UI.
