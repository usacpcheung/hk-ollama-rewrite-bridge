# hk-ollama-rewrite-bridge

Production-ready Node.js Express bridge that exposes two API services behind a shared auth, rate-limit, and provider-adapter layer:

- **Rewrite**: converts Hong Kong colloquial Cantonese into formal Traditional Chinese.
- **T2A (text-to-audio)**: generates Cantonese-oriented speech audio through the Minimax-compatible provider path.

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
  -d '{"text":"你好，歡迎使用","response_mode":"base64_json","voice_id":"Cantonese_ProfessionalHost（F)","speed":1.1,"format":"mp3"}'
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

## Service-scoped environment naming

Services resolve runtime config with a service prefix:

- `<SERVICE_ID>_PROVIDER`
- `<SERVICE_ID>_<PROVIDER>_MODEL` or `<SERVICE_ID>_PROVIDER_<PROVIDER>_MODEL`
- `<SERVICE_ID>_MAX_COMPLETION_TOKENS`, `<SERVICE_ID>_MAX_TEXT_LENGTH`
- Optional service-specific timeouts such as `<SERVICE_ID>_READY_TIMEOUT_MS`, `<SERVICE_ID>_COLD_TIMEOUT_MS`, or `T2A_INVOKE_TIMEOUT_MS`
- Rewrite-only streaming toggles: `<SERVICE_ID>_STREAMING_ENABLED`, `<SERVICE_ID>_PROVIDER_STREAMING_ENABLED`, optional `<SERVICE_ID>_<PROVIDER>_STREAMING_ENABLED`

Resolution order:
1. New service-scoped keys
2. Legacy keys
3. Built-in defaults

Legacy fallback emits a deprecation warning only when a new equivalent exists and only the legacy key is used.

### Compatibility mapping (rewrite)

| Legacy key | New key |
|---|---|
| `OLLAMA_MODEL` | `REWRITE_OLLAMA_MODEL` or `REWRITE_PROVIDER_OLLAMA_MODEL` |
| `OLLAMA_URL` | `REWRITE_OLLAMA_URL` or `REWRITE_PROVIDER_OLLAMA_URL` |
| `OLLAMA_PS_URL` | `REWRITE_OLLAMA_PS_URL` or `REWRITE_PROVIDER_OLLAMA_PS_URL` |
| `MINIMAX_MODEL` | `REWRITE_MINIMAX_MODEL` or `REWRITE_PROVIDER_MINIMAX_MODEL` |
| `MINIMAX_API_URL` | `REWRITE_MINIMAX_API_URL` or `REWRITE_PROVIDER_MINIMAX_API_URL` |
| `OLLAMA_TIMEOUT_MS` | `REWRITE_READY_TIMEOUT_MS` |
| `OLLAMA_COLD_TIMEOUT_MS` | `REWRITE_COLD_TIMEOUT_MS` |

### Compatibility mapping (T2A)

| Legacy key | New key |
|---|---|
| `MINIMAX_T2A_URL` | `T2A_MINIMAX_API_URL`, `T2A_PROVIDER_MINIMAX_API_URL`, or `T2A_URL` |
| `MINIMAX_T2A_MODEL` | `T2A_MINIMAX_MODEL`, `T2A_PROVIDER_MINIMAX_MODEL`, or `T2A_MODEL` |
| `MINIMAX_T2A_VOICE_ID` | `T2A_MINIMAX_VOICE_ID`, `T2A_PROVIDER_MINIMAX_VOICE_ID`, or `T2A_VOICE_ID` |
| `MINIMAX_T2A_SPEED` | `T2A_MINIMAX_SPEED`, `T2A_PROVIDER_MINIMAX_SPEED`, or `T2A_SPEED` |
| `MINIMAX_T2A_VOLUME` | `T2A_MINIMAX_VOLUME`, `T2A_PROVIDER_MINIMAX_VOLUME`, or `T2A_VOLUME` |
| `MINIMAX_T2A_PITCH` | `T2A_MINIMAX_PITCH`, `T2A_PROVIDER_MINIMAX_PITCH`, or `T2A_PITCH` |

## Environment variables

### Core service selection and limits

| Key | Default | Meaning |
|---|---:|---|
| `REWRITE_PROVIDER` | `ollama` | Rewrite backend provider (`ollama` or `minimax`). |
| `REWRITE_MAX_TEXT_LENGTH` | `200` | Max accepted `text` length for `POST /rewrite` in Unicode characters (1-600). |
| `REWRITE_MAX_COMPLETION_TOKENS` | `300` | Rewrite completion-token budget sent upstream. |
| `T2A_PROVIDER` | `minimax` | T2A provider selector. Current implementation resolves to Minimax-compatible T2A handling. |
| `T2A_MAX_TEXT_LENGTH` | `200` | Max accepted `text` length for `POST /t2a` in Unicode characters (1-600). |
| `T2A_INVOKE_TIMEOUT_MS` | `30000` | Provider invoke timeout for T2A requests only. |

### Rewrite provider config

| Key | Default | Meaning |
|---|---:|---|
| `REWRITE_OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Preferred Ollama model key. |
| `REWRITE_PROVIDER_OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Alternate preferred Ollama model key. |
| `REWRITE_OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Preferred Ollama generate endpoint. |
| `REWRITE_PROVIDER_OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Alternate preferred Ollama generate endpoint. |
| `REWRITE_OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Preferred Ollama readiness endpoint. |
| `REWRITE_PROVIDER_OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Alternate preferred Ollama readiness endpoint. |
| `REWRITE_MINIMAX_MODEL` | `M2-her` | Preferred rewrite Minimax model. |
| `REWRITE_PROVIDER_MINIMAX_MODEL` | `M2-her` | Alternate preferred rewrite Minimax model. |
| `REWRITE_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Preferred rewrite Minimax endpoint. |
| `REWRITE_PROVIDER_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Alternate preferred rewrite Minimax endpoint. |
| `REWRITE_READY_TIMEOUT_MS` | `30000` | Rewrite timeout for ready phase. |
| `REWRITE_COLD_TIMEOUT_MS` | `120000` | Rewrite timeout during cold/warming phases. |
| `REWRITE_STREAMING_ENABLED` | `false` | Service-level streaming toggle. |
| `REWRITE_PROVIDER_STREAMING_ENABLED` | `false` | Alternate service-level streaming toggle. |
| `REWRITE_<PROVIDER>_STREAMING_ENABLED` | `false` | Optional provider-specific streaming toggle. |

### T2A provider config

| Key | Default | Meaning |
|---|---:|---|
| `T2A_MINIMAX_API_URL` | `https://api.minimax.io/v1/t2a_v2` | Preferred T2A Minimax endpoint. |
| `T2A_PROVIDER_MINIMAX_API_URL` | `https://api.minimax.io/v1/t2a_v2` | Alternate preferred T2A Minimax endpoint. |
| `T2A_URL` | `https://api.minimax.io/v1/t2a_v2` | Short alias for T2A endpoint. |
| `T2A_MINIMAX_MODEL` | `speech-2.6-hd` | Preferred T2A model. |
| `T2A_PROVIDER_MINIMAX_MODEL` | `speech-2.6-hd` | Alternate preferred T2A model. |
| `T2A_MODEL` | `speech-2.6-hd` | Short alias for T2A model. |
| `T2A_MINIMAX_VOICE_ID` | `Cantonese_ProfessionalHost（F)` | Default voice ID. |
| `T2A_PROVIDER_MINIMAX_VOICE_ID` | `Cantonese_ProfessionalHost（F)` | Alternate default voice ID key. |
| `T2A_VOICE_ID` | `Cantonese_ProfessionalHost（F)` | Short alias for default voice ID. |
| `T2A_MINIMAX_SPEED` | `1` | Default speech speed. |
| `T2A_PROVIDER_MINIMAX_SPEED` | `1` | Alternate default speed key. |
| `T2A_SPEED` | `1` | Short alias for default speed. |
| `T2A_MINIMAX_VOLUME` | `1` | Default volume. |
| `T2A_PROVIDER_MINIMAX_VOLUME` | `1` | Alternate default volume key. |
| `T2A_VOLUME` | `1` | Short alias for default volume. |
| `T2A_MINIMAX_PITCH` | `0` | Default pitch. |
| `T2A_PROVIDER_MINIMAX_PITCH` | `0` | Alternate default pitch key. |
| `T2A_PITCH` | `0` | Short alias for default pitch. |
| `MINIMAX_T2A_URL` | `https://api.minimax.io/v1/t2a_v2` | Legacy endpoint fallback. |
| `MINIMAX_T2A_MODEL` | `speech-2.6-hd` | Legacy model fallback. |
| `MINIMAX_T2A_VOICE_ID` | `Cantonese_ProfessionalHost（F)` | Legacy voice fallback. |
| `MINIMAX_T2A_SPEED` | `1` | Legacy speed fallback. |
| `MINIMAX_T2A_VOLUME` | `1` | Legacy volume fallback. |
| `MINIMAX_T2A_PITCH` | `0` | Legacy pitch fallback. |

### Shared infra and auth config

| Key | Default | Meaning |
|---|---:|---|
| `MINIMAX_API_KEY` | empty | Required for Minimax rewrite and T2A traffic. |
| `BRIDGE_INTERNAL_AUTH_SECRET` | empty | Shared secret that trusted proxy must inject on protected routes. |
| `TRUSTED_PROXY_ADDRESSES` | `127.0.0.1,::1` | Addresses allowed to forward trusted identity headers. |
| `EXPRESS_TRUST_PROXY` | `loopback` | Express trust-proxy mode for client IP derivation. |
| `RATE_LIMIT_GLOBAL_WINDOW_SEC` | `60` | Global non-ops limiter window. |
| `RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `300` | Global non-ops limiter budget. |
| `RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC` | `60` | Rewrite user-scoped limiter window. |
| `RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS` | `60` | Rewrite user-scoped limiter budget. |
| `RATE_LIMIT_REWRITE_IP_WINDOW_SEC` | `60` | Rewrite IP fallback limiter window. |
| `RATE_LIMIT_REWRITE_IP_MAX_REQUESTS` | `20` | Rewrite IP fallback limiter budget. |
| `RATE_LIMIT_T2A_AUTH_WINDOW_SEC` | `60` | T2A user-scoped limiter window. |
| `RATE_LIMIT_T2A_AUTH_MAX_REQUESTS` | `30` | T2A user-scoped limiter budget. |
| `RATE_LIMIT_T2A_IP_WINDOW_SEC` | `60` | T2A IP fallback limiter window. |
| `RATE_LIMIT_T2A_IP_MAX_REQUESTS` | `10` | T2A IP fallback limiter budget. |
| `ADMISSION_MAX_CONCURRENCY` | `4` | Shared admission max concurrency. |
| `ADMISSION_MAX_QUEUE_SIZE` | `100` | Shared admission queue size. |
| `ADMISSION_MAX_WAIT_MS` | `15000` | Shared admission max queue wait. |

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

- Exact endpoint contracts: `docs/api-reference.md`
- Deployment guide: `docs/deployment-guide.md`
- Auth validation runbook: `docs/runbooks/auth-matrix-manual-cli-checklist.md`
- Browser rewrite widget notes: `public/rewrite-widget/README_rewrite_widget.md`
