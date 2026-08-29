# hk-ollama-rewrite-bridge

Production-ready Node.js Express bridge that exposes two API services behind a shared auth, rate-limit, and provider-adapter layer:

- **Rewrite**: converts Hong Kong colloquial Cantonese into formal Traditional Chinese.
- **T2A (text-to-audio)**: generates Cantonese-oriented speech audio through the Minimax-compatible provider path.

The repository also contains the source and deployment guide for a private Faster
Whisper transcription companion daemon under `services/whisper-asr/`. It is not yet
exposed by the Node bridge or public Apache routes. See
[`services/whisper-asr/README.md`](services/whisper-asr/README.md). Its private job
routes require a server-only 64-character lowercase hexadecimal bearer token.

This README is the top-level operator and integrator guide. For exact endpoint contracts, see `docs/api-reference.md`.

## What is implemented

### Services

| Service | Internal route | Typical public route | Purpose |
|---|---|---|---|
| Rewrite | `POST /rewrite` | `POST /api/rewrite-bridge/rewrite` | Rewrite colloquial Cantonese into formal Traditional Chinese. |
| T2A | `POST /t2a` | `POST /api/rewrite-bridge/t2a` | Generate speech audio from validated input text. |
| Model status | `GET /model-status` | `GET /api/rewrite-bridge/model-status` | Diagnostics for frontend polling and operators. |
| Health | `GET /healthz` | `GET /api/rewrite-bridge/healthz` | Process liveness. |
| Ready | `GET /readyz` | `GET /api/rewrite-bridge/readyz` | Traffic-readiness gate. |

### Runtime architecture

- Express server bound to `127.0.0.1:3001` only.
- Service registry in `services/` resolves service-scoped configuration for both rewrite and T2A.
- Provider adapters normalize upstream behavior so route handlers can keep a stable API contract.
- Protected routes (`/rewrite`, `/t2a`) share:
  - trusted-header auth
  - client identity derivation
  - layered fixed-window rate limiting
  - admission control
  - JSON error envelope conventions

## Requirements

- Node.js 18+
- For rewrite with Ollama: Ollama reachable at `127.0.0.1:11434` and the configured model pulled
- For rewrite or T2A with Minimax: outbound network access and `MINIMAX_API_KEY`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

The server listens on `http://127.0.0.1:3001`.

## Tests

All automated tests live under `tests/`.

- `tests/rewrite-validation.test.js`: rewrite request validation.
- `tests/rewrite-auth-parity.test.js`: auth/domain enforcement behavior.
- `tests/providers/ollama.test.js`: Ollama parsing and error handling.
- `tests/providers/minimax.test.js`: Minimax rewrite + T2A normalization.
- `tests/t2a-config-resolution.test.js`: T2A env/config resolution.
- `tests/t2a-validation.test.js`: T2A request validation.
- `tests/t2a-routes.test.js`: T2A route auth, validation, binary/JSON responses, and shared middleware behavior.

Run the full suite:

```bash
npm test
```

## Quick start for app developers

### Rewrite request

```bash
curl -sS https://<your-domain>/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <gateway-token-if-applicable>' \
  -d '{"text":"我今日唔係好舒服，想請半日假。"}'
```

Example success body:

```json
{
  "ok": true,
  "result": "我今天身體不適，想請半天假。"
}
```

### T2A request returning binary audio

```bash
curl -sS https://<your-domain>/api/rewrite-bridge/t2a \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <gateway-token-if-applicable>' \
  -d '{"text":"你好，歡迎使用","response_mode":"binary"}' \
  --output speech.mp3
```

### T2A request returning JSON-wrapped base64 audio

```bash
curl -sS https://<your-domain>/api/rewrite-bridge/t2a \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <gateway-token-if-applicable>' \
  -d '{"text":"Hello, welcome","response_mode":"base64_json","voice_id":"English_expressive_narrator","language_boost":"English","speed":1.1,"format":"mp3"}'
```

Example success body:

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

## How downstream apps should integrate

### 1) Choose the right endpoint

- Use `/rewrite` when you need transformed text.
- Use `/t2a` when you need generated audio.
- Use `/model-status` for UX hints or admin dashboards, not as a hard prerequisite before every request.

### 2) Handle both auth and gateway behavior

In production, public callers usually go through a reverse proxy that performs OIDC/auth and injects trusted backend headers. Browser or server apps should call the **public** `/api/rewrite-bridge/*` routes, not the internal loopback routes.

### 3) Pick the T2A response mode intentionally

- `response_mode: "binary"` or omitted:
  - best for direct playback or file download pipelines
  - returns raw bytes with `Content-Type`
- `response_mode: "base64_json"`:
  - best for apps that need a single JSON response
  - larger payload because audio is base64 encoded

### 4) Respect validation limits

- Rewrite input is capped by `REWRITE_MAX_TEXT_LENGTH`.
- T2A input is capped by `T2A_MAX_TEXT_LENGTH`.
- T2A option ranges are validated server-side, so client apps should pre-validate where possible to give better UX.

### 5) Treat optional metadata as additive

Rewrite may include optional `usage` and `artifacts`. T2A JSON mode includes provider metadata. Apps should rely on the stable core fields first:

- Rewrite: `ok`, `result`
- T2A JSON mode: `ok`, `audio`, `format`, `mime`/`contentType`, `size`

## Environment variables

The canonical environment reference is `docs/env-reference.md`.

Use canonical names from that document for new deployments. Deprecated aliases
remain supported for one compatibility window and emit startup warnings when
used. The docs intentionally avoid duplicating the full env table here so that
operators have one source of truth.

### Opt-in MiniMax M3 rewrite

MiniMax M3 is supported through MiniMax's recommended Anthropic-compatible
Messages interface without changing the public rewrite API:

```env
REWRITE_PROVIDER=minimax
REWRITE_MINIMAX_API_FORMAT=anthropic
REWRITE_MINIMAX_ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
REWRITE_MINIMAX_MODEL=MiniMax-M3
```

The default remains `M2-her` with `legacy-chat`. Existing callers continue to
send the same `/rewrite` request and receive the same JSON or NDJSON response.
The SDK appends `/v1/messages` to the configured Anthropic base URL. Rollback
only requires restoring the legacy format and model values and restarting the
bridge.

## Reverse-proxy authentication hardening

Protected routes require **two trusted signals**:

1. `X-Authenticated-Email`
2. `X-Bridge-Auth`

The backend trusts `X-Authenticated-Email` only when `X-Bridge-Auth` matches `BRIDGE_INTERNAL_AUTH_SECRET` and the request comes from a trusted proxy source. If either signal is missing or invalid, protected routes return `401 AUTH_REQUIRED`.

Deployment requirements:

- Set a strong `BRIDGE_INTERNAL_AUTH_SECRET`.
- Unset inbound `X-Authenticated-Email`, `X-Authenticated-User`, `X-Authenticated-Subject`, and `X-Bridge-Auth` at the proxy.
- Re-set trusted values server-side after successful auth.
- Keep the shared secret outside git.

## Public API path behind reverse proxy

Canonical public namespace:

- `POST /api/rewrite-bridge/rewrite`
- `POST /api/rewrite-bridge/t2a`
- `GET /api/rewrite-bridge/model-status`
- `GET /api/rewrite-bridge/healthz`
- `GET /api/rewrite-bridge/readyz`

Internal loopback routes remain:

- `POST /rewrite`
- `POST /t2a`
- `POST /api/t2a`
- `GET /model-status`
- `GET /healthz`
- `GET /readyz`

## Response and client-handling guidance

### Rewrite

- `stream=false` or omitted returns JSON with `result`.
- `stream=true` is supported only when the selected provider supports it and rewrite streaming env toggles resolve to enabled; otherwise the API returns `501 STREAMING_UNSUPPORTED`.
- Downstream apps should branch on `ok` and treat `usage`/`artifacts` as optional.

### T2A

- `response_mode=binary` returns raw audio bytes.
- `response_mode=base64_json` returns JSON with base64 audio.
- `stream=true` is rejected with `501 STREAMING_UNSUPPORTED` in v1.
- The bridge does not write generated audio to disk.

## API and deployment docs

- Environment reference: `docs/env-reference.md`
- Exact endpoint contracts: `docs/api-reference.md`
- Deployment guide: `docs/deployment-guide.md`
- Auth validation runbook: `docs/runbooks/auth-matrix-manual-cli-checklist.md`
- Browser rewrite widget notes: `public/rewrite-widget/README_rewrite_widget.md`
