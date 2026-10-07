# hk-ollama-rewrite-bridge

Node.js Express bridge that exposes AI services behind shared authentication and provider adapters:

- **Rewrite**: converts Hong Kong colloquial Cantonese into formal Traditional Chinese.
- **T2A (text-to-audio)**: generates Cantonese-oriented speech audio through the Minimax-compatible provider path.
- **Transcription (opt-in)**: transcribes completed recordings through Google Cloud Speech-to-Text V2 Chirp 3.

This README is the top-level operator and integrator guide. Start with the [documentation index](docs/README.md), or use the [API reference](docs/reference/api-reference.md) for exact endpoint contracts.

## Worksheet audio transcription (opt-in)

Authenticated callers upload multipart field `audio` to public
`POST /api/rewrite-bridge/transcriptions` (internal `/transcriptions` or
`/api/transcriptions`). Success returns `{ ok: true, result, durationSeconds,
requestId, timings }`. The client can then pass `result` to rewrite and let the
student edit. This change supplies the backend, not the worksheet recording UI.

Transcription is disabled by default. Enable with `TRANSCRIPTION_ENABLED=true`,
`TRANSCRIPTION_GOOGLE_PROJECT`, the worksheet's `TRANSCRIPTION_ALLOWED_ORIGINS`,
and server-side Application Default Credentials.
It uses `chirp_3`, `yue-Hant-HK`, and the `us` endpoint by default. No Whisper daemon
is needed. Uploads are limited to 20 MiB and 60 decoded seconds; FFmpeg normalizes
audio to mono 16 kHz FLAC. Ten requests can be admitted, two conversions can run,
and each user can have one active request. Audio deletion is attempted after
processing; successful responses follow cleanup. Cleanup failures block further
admission until restart. The bridge does not retain transcripts. Limits are
configurable and process-local.

Follow the [checkpoint deployment guide](docs/runbooks/transcription-deployment.md) before
enabling public access. See the [API contract](docs/reference/api-reference.md#transcription)
and [environment settings](docs/reference/env-reference.md#transcription) for details.

## What is implemented

### Services

| Service | Internal route | Typical public route | Purpose |
|---|---|---|---|
| Rewrite | `POST /rewrite` | `POST /api/rewrite-bridge/rewrite` | Rewrite colloquial Cantonese into formal Traditional Chinese. |
| T2A | `POST /t2a` | `POST /api/rewrite-bridge/t2a` | Generate speech audio from validated input text. |
| Transcription | `POST /transcriptions` | `POST /api/rewrite-bridge/transcriptions` | Transcribe a completed audio recording (opt-in). |
| Model status | `GET /model-status` | `GET /api/rewrite-bridge/model-status` | Diagnostics for frontend polling and operators. |
| Health | `GET /healthz` | `GET /api/rewrite-bridge/healthz` | Process liveness. |
| Ready | `GET /readyz` | `GET /api/rewrite-bridge/readyz` | Rewrite-readiness gate; does not check T2A or Google. |

### Runtime architecture

- Express server bound to `127.0.0.1:3001` only.
- Service registry in `services/` composes rewrite/T2A definitions using the readers in `configuration/`.
- Transcription has an independent upload/conversion lifecycle and admission limits in `services/transcription.js`, using the shared provider adapter with `providers/google-speech.js`.
- Provider adapters normalize upstream behavior so route handlers can keep a stable API contract.
- Protected JSON routes (`/rewrite`, `/api/rewrite`, `/t2a`, `/api/t2a`) share:
  - trusted-header auth
  - client identity derivation
  - layered fixed-window rate limiting
  - provider-keyed admission control (shared when services use the same provider)
  - JSON error envelope conventions
- Transcription aliases share header auth and the global rate limiter, with separate per-user rate limits, admission and conversion slots.
- The bridge does not serve the widget assets; host `public/rewrite-widget/` on your web server. See the [widget guide](docs/guides/rewrite-widget.md).

Rewrite/T2A construction now uses registered provider factories with capabilities
scoped to each service. Existing provider/model/environment settings and public
formats are unchanged. Google transcription retains its separate lifecycle; this
implements step-3 rewrite/T2A request separation, not completion of provider interchangeability.
See the [step-3 contracts](docs/architecture/provider-abstraction-step-3.md) for
provider-owned native payloads/voice mappings and transcription contract design. See the
[registry contract](docs/architecture/provider-registry.md).

## Requirements

- Node.js 22+ (CI tests Node 22 and 24)
- For rewrite with Ollama: Ollama reachable at `127.0.0.1:11434` and the configured model pulled
- For rewrite or T2A with Minimax: outbound network access and `MINIMAX_API_KEY`
- For enabled transcription: FFmpeg/FFprobe, Google Cloud Speech-to-Text access and server-side ADC

## Install

```bash
npm ci --ignore-scripts
```

## Run

```bash
npm start
```

The server listens on `http://127.0.0.1:3001`.

## Tests

All automated tests live under `tests/`.

Before changing service/provider boundaries, use the
[compatibility baseline](docs/architecture/compatibility-baseline.md). It maps
current behavior to code and tests, distinguishes portable contracts from legacy
provider behavior and observed quirks, and records verification limits.

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

Media integration tests require FFmpeg and FFprobe. Install both or set
`TEST_FFMPEG_PATH` and `TEST_FFPROBE_PATH` to their executables. Tests that need
unavailable tools report explicit skips; mocked media and upload-timeout tests
still run. Check skip counts: full transcription/media verification requires
zero skips, as in CI where both tools are installed.

## API corrections before provider refactoring

JSON bodies exceeding the 16 KiB parser limit return **413 `PAYLOAD_TOO_LARGE`**
(previously 500). Clients should reduce the payload instead of retrying it unchanged.
T2A retains MP3, WAV, and PCM output: JSON `format`/MIME and binary filenames now
match the normalized provider format instead of always using MP3 labels. Missing
provider metadata uses the requested format; conflicting or unsupported declarations
return controlled 502 `PROVIDER_ERROR`. No audio transcoding is added. Consumers
should use returned metadata rather than assume `.mp3`. Admission `Retry-After`
policy is unchanged. See the [API reference](docs/reference/api-reference.md).

## Quick start for app developers

Public examples below use a private cookie jar containing an authenticated gateway
session, matching the checked-in Apache `AuthType openid-connect` configuration.
Replace the host and cookie-jar path. Bearer tokens are an alternative only when
the gateway is explicitly configured to accept them; the bridge does not validate
them. T2A also requires adding the proxy mapping from the deployment guide.

### Rewrite request

```bash
curl -sS 'https://<your-domain>/api/rewrite-bridge/rewrite' \
  --cookie '/path/to/private-authenticated-cookie-jar' \
  -H 'Content-Type: application/json' \
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
curl -sS 'https://<your-domain>/api/rewrite-bridge/t2a' \
  --cookie '/path/to/private-authenticated-cookie-jar' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，歡迎使用","response_mode":"binary"}' \
  --output speech.mp3
```

### T2A request returning JSON-wrapped base64 audio

```bash
curl -sS 'https://<your-domain>/api/rewrite-bridge/t2a' \
  --cookie '/path/to/private-authenticated-cookie-jar' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello, welcome","response_mode":"base64_json","voice_choice":"english_narrator_female","format":"mp3"}'
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

### Stable T2A voice choices

Callers can send a stable `voice_choice` instead of provider-specific voice controls:

```json
{"text":"你好，歡迎使用","voice_choice":"cantonese_narrator_female"}
```

There are seven Cantonese choices (three male character presets, three female character presets and a female narrator), plus `mandarin_narrator_female` and `english_narrator_female`. The bridge maps each ID to MiniMax's voice, language and delivery settings. See the [voice catalogue and exact settings](docs/reference/api-reference.md#stable-voice-choices).

A choice is a complete preset: do not combine it with `voice_id`, `language_boost`, `speed`, `volume` or `pitch`, including null values. Invalid or conflicting choices return `400 INVALID_INPUT`. Audio format and response mode remain independent. Named presets use their explicit settings rather than generic environment voice defaults.

Existing requests without `voice_choice` retain raw voice controls, environment defaults and binary/base64 response contracts. No new environment variables are required. The configured provider and model are unchanged; existing consumers are not migrated automatically.

## How downstream apps should integrate

### 1) Choose the right endpoint

- Use `/rewrite` when you need transformed text.
- Use `/t2a` when you need generated audio.
- Use `/transcriptions` for a completed recording when enabled; the caller decides whether to submit its transcript to rewrite.
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

- Rewrite input is capped by `REWRITE_MAX_TEXT_LENGTH` (default 200 Unicode characters; configurable up to 4,000).
- For a worksheet recording workflow, explicitly configure `REWRITE_MAX_TEXT_LENGTH=2000` and `REWRITE_MAX_COMPLETION_TOKENS=4096`. These are starting settings for validation, not a guarantee that every rewrite will fit its output budget. Existing defaults remain unchanged. See the [deployment guide](docs/guides/deployment-guide.md#worksheet-rewrite-profile).
- T2A input is capped by `T2A_MAX_TEXT_LENGTH` (default 200; configurable from 1 to 1,000). Integer settings above 1,000 clamp to 1,000; malformed, fractional, or non-positive settings fall back to 200. Unset or blank settings use 200.
- Both input limits are application budget controls for usage and spending, not provider capability limits. They count Unicode code points after trimming surrounding whitespace. Raising the T2A ceiling adds operator flexibility while retaining an explicit cap; existing valid settings and the default remain unchanged.
- T2A option ranges are validated server-side, so client apps should pre-validate where possible to give better UX.

### 5) Treat optional metadata as additive

Rewrite may include optional `usage`. Internal provider artifacts are not exposed by the current rewrite response writer. T2A JSON mode includes provider metadata. Apps should rely on the stable core fields first:

- Rewrite: `ok`, `result`
- T2A JSON mode: `ok`, `audio`, `format`, `mime`/`contentType`, `size`

## Environment variables

The canonical environment reference is `docs/reference/env-reference.md`.

Use canonical names from that document for new deployments. Deprecated aliases
remain supported and emit startup warnings when used. The code defines no
removal date or release window; retirement needs a separate migration decision. The docs intentionally avoid duplicating the full env table here so that
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

The route auth middleware checks the trimmed shared secret and a trimmed, lowercased email header. Missing email or a missing/wrong secret returns `401 AUTH_REQUIRED`; comma-separated email values return `401 AUTH_HEADER_INVALID`; a disallowed domain suffix returns `403 FORBIDDEN_DOMAIN`. It does not perform full email syntax validation.

`BRIDGE_TRUSTED_PROXY_ADDRESSES` controls whether identity headers become a user-based rate-limit key; it is not an additional route authorization check. Keep the loopback-only listener and proxy header stripping in place. The bridge does not validate browser bearer tokens or OIDC sessions itself.

Deployment requirements:

- Set a strong `BRIDGE_INTERNAL_AUTH_SECRET`.
- Unset inbound `X-Authenticated-Email`, `X-Authenticated-User`, `X-Authenticated-Subject`, and `X-Bridge-Auth` at the proxy.
- Re-set trusted values server-side after successful auth.
- Keep the shared secret outside git.

## Public API path behind reverse proxy

Canonical public namespace:

- `POST /api/rewrite-bridge/rewrite`
- `POST /api/rewrite-bridge/t2a`
- `POST /api/rewrite-bridge/transcriptions` (opt-in proxy mapping)
- `GET /api/rewrite-bridge/model-status`
- `GET /api/rewrite-bridge/healthz`
- `GET /api/rewrite-bridge/readyz`

Internal loopback routes remain:

- `POST /rewrite` and `POST /api/rewrite`
- `POST /t2a` and `POST /api/t2a`
- `POST /transcriptions` and `POST /api/transcriptions`
- `GET /model-status`
- `GET /healthz`
- `GET /readyz`

## Response and client-handling guidance

### Rewrite

- `stream=false` or omitted returns JSON with `result`.
- `stream=true` is supported only when the selected provider supports it and rewrite streaming env toggles resolve to enabled; otherwise the API returns `501 STREAMING_UNSUPPORTED`.
- Downstream apps should branch on `ok` and treat `usage` as optional.

### T2A

- `response_mode=binary` returns raw audio bytes.
- `response_mode=base64_json` returns JSON with base64 audio.
- `stream=true` is rejected with `501 STREAMING_UNSUPPORTED` in v1.
- The bridge does not write generated audio to disk.
- MiniMax normalizes declared audio format and MIME, including nested response wrappers, and uses the requested format when metadata is absent. Binary filenames and JSON labels agree; contradictory or unsupported declarations return a controlled 502. Bytes are not transcoded. See the [T2A contract](docs/reference/api-reference.md#2-post-t2a).

## API and deployment docs

- [Documentation index](docs/README.md)
- [Environment reference](docs/reference/env-reference.md)
- [Exact endpoint contracts](docs/reference/api-reference.md)
- [Caller guide](docs/guides/rewrite-t2a-api-calling-reference.md)
- [Deployment guide](docs/guides/deployment-guide.md)
- [Transcription deployment runbook](docs/runbooks/transcription-deployment.md)
- [Auth validation runbook](docs/runbooks/auth-matrix-manual-cli-checklist.md)
- [Browser rewrite widget guide](docs/guides/rewrite-widget.md)
- [Current runtime architecture](docs/architecture/runtime.md)
- [Current documentation audit and baseline readiness](docs/reviews/2026-10-06-main-baseline-audit.md)
- [Refactor roadmap and deployment gates](docs/architecture/provider-abstraction-roadmap.md)
- [Step 2 scope and acceptance gates](docs/architecture/provider-abstraction-step-2.md)

## Runtime failure handling

Rewrite and T2A cancel queued work when the caller disconnects and forward cancellation
to active provider requests. Admission is released only after invocation settles;
client cancellation does not count as a provider-readiness failure. Cancellation is
best effort and cannot undo work already accepted or billed by a remote provider.

Streaming waits for downstream capacity, has a 1 MiB pending-output limit and a
30-second maximum drain wait (also interrupted by the provider deadline or disconnect),
and emits no text after a terminal event. Native Ollama/legacy MiniMax parsing rejects
incomplete or malformed streams and bounds its pending input buffer at 1 MiB.
A disconnected or persistently blocked client may receive a closed connection rather
than a terminal error frame. Existing successful output formats are unchanged.

MiniMax/Ollama timeouts while reading JSON remain timeout errors. T2A recognizes
upstream 401/403 even when a proxy returns HTML instead of JSON. See the
[runtime correction review](docs/reviews/2026-10-07-runtime-failure-corrections.md)
and [API reference](docs/reference/api-reference.md).

## Reviewed runtime and widget corrections

Rewrite prompt insertion preserves literal dollar sequences. Provider text must be a
nonempty string; malformed responses return controlled provider errors. Empty Ollama
streams end with an error rather than successful completion. Streaming Chinese
conversion keeps phrase context across chunks and flushes before the terminal event;
chunk boundaries may change, while NDJSON fields and concatenated output stay stable.

Readiness caches the latest probe result, including unavailable results. The widget
requires a terminal streaming event, ignores trailing text, retains timeouts until body
consumption finishes, and counts Unicode code points like the backend. Destroying a
widget cancels its active rewrite. A warming model does not become ready merely because
the bridge process is running.

MiniMax T2A rejects nonzero provider status before decoding audio. Supported audio keys
are `audio`, `audio_hex`, `audioHex`, and `audio_data` inside the recognized
`data`, `output`, `outputs` (including arrays), and `wrapper` containers; the existing
`data.wrapper.payload` variant is retained. Existing direct response candidates remain
supported. Arbitrary hexadecimal metadata is not audio; unrecognized response layouts
fail with 502 `PROVIDER_ERROR`. Output formats remain MP3/WAV/PCM without transcoding.
