# Rewrite & T2A API Calling Reference

This document is a caller-focused reference for integrating with the bridge APIs.
All request/response contracts below are based on the current server and service code.

- Service bind address (default): `http://127.0.0.1:3001`
- JSON parser limit: `16kb` request body size (oversize JSON currently maps to `500 INTERNAL_ERROR`; text budgets independently return `413 TOO_LONG`)
- Protected endpoints: both Rewrite and T2A require trusted auth headers

---

## 1) Authentication and required headers

Both Rewrite and T2A routes are protected by the same header-based gate:

- `X-Bridge-Auth`: must match `BRIDGE_INTERNAL_AUTH_SECRET` after trimming surrounding whitespace
- `X-Authenticated-Email`: trimmed and lowercased, non-empty, without commas, and ending with configured `BRIDGE_AUTH_ALLOWED_EMAIL_DOMAIN` (default `@hs.edu.hk`). The bridge checks this suffix, not full email syntax.

If authentication fails, responses are:

- `401 AUTH_REQUIRED` (missing email or missing/wrong shared secret)
- `401 AUTH_HEADER_INVALID` (invalid email header format, e.g. comma-separated)
- `403 FORBIDDEN_DOMAIN` (email domain does not match `BRIDGE_AUTH_ALLOWED_EMAIL_DOMAIN`)

### Deployment expectation (Apache + OIDC)

These protected API paths are designed to be exposed publicly **through a trusted reverse proxy** (for example Apache with an OIDC module), not by direct internet access to the bridge process.

- The bridge validates trusted upstream headers (`X-Bridge-Auth` and `X-Authenticated-Email`), and does not implement interactive OIDC login flows itself.
- Reverse proxy should perform user authentication, inject trusted headers server-side, and strip any client-supplied versions of these headers.
- Keep the bridge service internal/private (default bind is localhost) and only publish proxy routes.

`BRIDGE_TRUSTED_PROXY_ADDRESSES` controls user-based limiter identity, not route authorization. Backend auth does not enforce a proxy source-address allowlist. The global and service rate limiters run before rewrite/T2A auth, so 429 can precede an auth error.

Public callers send their gateway session cookie or bearer token only when the gateway supports it. The sample Apache OIDC configuration uses `AuthType openid-connect` and does not by itself establish a bearer-token API.

### Minimal working local backend request headers

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

- `text` max length comes from `REWRITE_MAX_TEXT_LENGTH` (default `200`, hard max `4000`). This is an application budget control for usage and spending, not a provider capability limit.
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
| `voice_choice` | string | No | case-sensitive known preset ID; conflicts with raw voice controls | absent (legacy settings) |
| `voice_id` | string | No | non-empty string, only without `voice_choice` | env default voice ID |
| `language_boost` | string | No | non-empty string, only without `voice_choice` | `Chinese,Yue` |
| `speed` | number | No | `0.5` to `2` | env/default value |
| `volume` | number | No | `0` to `10` | env/default value |
| `pitch` | number | No | `-12` to `12` | env/default value |
| `sample_rate` | integer | No | `8000` to `48000` | `32000` |
| `bitrate` | integer | No | `32000` to `320000` | `128000` |
| `format` | string | No | `mp3`, `wav`, `pcm` | `mp3` |
| `response_mode` | string | No | `binary` / `default` / `base64_json` / `base64-json` | `binary` |

### 3.3.1 Provider-independent voice choices

```json
{
  "text": "Hello, welcome",
  "voice_choice": "english_narrator_female",
  "response_mode": "base64_json"
}
```

Use a stable ID from the [voice catalogue](../reference/api-reference.md#stable-voice-choices). Each ID includes the language and full voice tuning; the bridge translates it to the selected provider's native settings. The initial catalogue has seven Cantonese choices plus Putonghua and English female narration. No provider or model change is implied.

When using `voice_choice`, omit `voice_id`, `language_boost`, `speed`, `volume` and `pitch`. Supplying any of them, including null, returns `400 INVALID_INPUT`. Choice IDs are trimmed but case-sensitive; null, empty, non-string and unknown choices also return `400 INVALID_INPUT`. Output format/rate/bitrate and response mode keep their current defaults and validation.

A known choice without a mapping in a supported provider fails with `422 VOICE_CHOICE_UNSUPPORTED`, without falling back. An unsupported T2A provider still returns `501 UNSUPPORTED_PROVIDER`. Currently only MiniMax is supported and all nine choices have mappings.

Without `voice_choice`, all existing raw settings and omitted-field environment defaults continue to work. Existing consumers need no changes to keep using these requests.

### 3.4 Limitations

- `text` max length from `T2A_MAX_TEXT_LENGTH` (default `200`, configurable range `1`–`1000`). Integer settings above `1000` clamp to `1000`; malformed, fractional, or non-positive settings fall back to `200`. Unset or blank settings use `200`. This is an application budget control for usage and spending, not a provider capability limit.
- Streaming is **not supported** for T2A v1.
  - If `stream` is requested, server returns `501 STREAMING_UNSUPPORTED`.
- If provider is Minimax and `MINIMAX_API_KEY` is missing, server returns:
  - `503 MINIMAX_API_KEY_MISSING`
- `format` is forwarded to MiniMax and returned bytes are not transcoded. The adapter currently labels output `format` as `mp3` and binary filenames as `speech.mp3` even for WAV/PCM requests; MIME values may reflect upstream metadata. Use MP3 for consistent metadata. Do not assume a WAV/PCM request returned MP3 bytes based on the filename. See the [metadata limitation](../reference/api-reference.md#current-audio-format-metadata-limitation).

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
curl -sS 'http://127.0.0.1:3001/t2a' \
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
curl -sS 'http://127.0.0.1:3001/t2a' \
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

1. Have the proxy inject both trusted headers after gateway authentication. Public clients must not know the bridge shared secret.
2. Validate text length client-side before sending.
3. For T2A, choose one response path:
   - binary download (`response_mode` omitted), or
   - JSON transport (`response_mode=base64_json`).
4. Handle temporary Rewrite warmup responses (`202`/`503`) with retry logic.
5. Handle `429 RATE_LIMITED` using `Retry-After`.
6. Handle provider-level failures (`502`/`503`) gracefully in caller UI.
