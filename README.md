# hk-ollama-rewrite-bridge

Production-ready Node.js Express bridge that rewrites Hong Kong colloquial Cantonese into formal Traditional Chinese and exposes Minimax-backed text-to-audio (T2A) generation via configurable backend providers (`ollama` or `minimax`).

## Requirements

- Node.js 18+
- Ollama running locally at `127.0.0.1:11434`
- Model pulled: `qwen2.5:3b-instruct`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Server binds to `127.0.0.1:3001` only.

## Tests

All automated tests are centralized under `tests/` so they are easy to discover and run.

- `tests/rewrite-validation.test.js`: validates input and body-parsing guards (`INVALID_INPUT`, `TOO_LONG`, `INVALID_JSON`).
- `tests/rewrite-auth-parity.test.js`: validates auth and domain policy behavior for rewrite access control headers.
- `tests/providers/ollama.test.js`: validates Ollama stream parsing/error handling for malformed or incomplete JSONL responses.
- `tests/providers/minimax.test.js`: validates Minimax SSE frame normalization, done/fallback streaming behavior, and T2A response normalization.
- `tests/t2a-routes.test.js`: validates T2A route auth, validation, binary/JSON responses, and rewrite regression coverage.

Run all tests:

```bash
npm test
```

## Service-scoped environment naming

Services now resolve runtime config with a service prefix:

- `<SERVICE_ID>_PROVIDER` (for example `REWRITE_PROVIDER`, future `SUMMARIZE_PROVIDER`)
- `<SERVICE_ID>_<PROVIDER>_MODEL` or `<SERVICE_ID>_PROVIDER_<PROVIDER>_MODEL` (for example `REWRITE_OLLAMA_MODEL`, `REWRITE_PROVIDER_MINIMAX_MODEL`)
- `<SERVICE_ID>_MAX_COMPLETION_TOKENS`, `<SERVICE_ID>_MAX_TEXT_LENGTH`
- Optional service-level timeout keys such as `<SERVICE_ID>_READY_TIMEOUT_MS` and `<SERVICE_ID>_COLD_TIMEOUT_MS`
- Streaming capability toggle keys: `<SERVICE_ID>_STREAMING_ENABLED`, `<SERVICE_ID>_PROVIDER_STREAMING_ENABLED`, and optional provider-specific `<SERVICE_ID>_<PROVIDER>_STREAMING_ENABLED`

Resolution order for rewrite service:
1. New service-scoped keys (preferred)
2. Legacy keys (fallback, still accepted)
3. Hardcoded defaults

Legacy fallback emits a deprecation warning only when a new equivalent exists and only the legacy key is used.

### Compatibility mapping (rewrite)

| Legacy key | New key |
|---|---|
| `OLLAMA_MODEL` | `REWRITE_OLLAMA_MODEL` (or `REWRITE_PROVIDER_OLLAMA_MODEL`) |
| `OLLAMA_URL` | `REWRITE_OLLAMA_URL` (or `REWRITE_PROVIDER_OLLAMA_URL`) |
| `OLLAMA_PS_URL` | `REWRITE_OLLAMA_PS_URL` (or `REWRITE_PROVIDER_OLLAMA_PS_URL`) |
| `MINIMAX_MODEL` | `REWRITE_MINIMAX_MODEL` (or `REWRITE_PROVIDER_MINIMAX_MODEL`) |
| `MINIMAX_API_URL` | `REWRITE_MINIMAX_API_URL` (or `REWRITE_PROVIDER_MINIMAX_API_URL`) |
| `OLLAMA_TIMEOUT_MS` | `REWRITE_READY_TIMEOUT_MS` |
| `OLLAMA_COLD_TIMEOUT_MS` | `REWRITE_COLD_TIMEOUT_MS` |
| `REWRITE_MAX_COMPLETION_TOKENS` | `REWRITE_MAX_COMPLETION_TOKENS` (already service-scoped) |
| `REWRITE_MAX_TEXT_LENGTH` | `REWRITE_MAX_TEXT_LENGTH` (already service-scoped) |
| `REWRITE_PROVIDER` | `REWRITE_PROVIDER` (already service-scoped) |
| (none) | `REWRITE_STREAMING_ENABLED` / `REWRITE_PROVIDER_STREAMING_ENABLED` / `REWRITE_<PROVIDER>_STREAMING_ENABLED` |

### Migration examples

Rewrite service today:

```bash
REWRITE_PROVIDER=minimax \
REWRITE_MINIMAX_MODEL=M2-her \
REWRITE_MINIMAX_API_URL=https://api.minimax.io/v1/text/chatcompletion_v2 \
REWRITE_OLLAMA_URL=http://127.0.0.1:11434/api/generate \
REWRITE_OLLAMA_PS_URL=http://127.0.0.1:11434/api/ps \
REWRITE_MAX_COMPLETION_TOKENS=400 \
REWRITE_READY_TIMEOUT_MS=45000 \
REWRITE_COLD_TIMEOUT_MS=180000 \
npm start
```

Hypothetical future summarize service:

```bash
SUMMARIZE_PROVIDER=ollama \
SUMMARIZE_OLLAMA_MODEL=qwen2.5:7b-instruct \
SUMMARIZE_MAX_COMPLETION_TOKENS=600
```

## Environment Variables

Tune runtime behavior without code changes:

| Key | Default | Meaning |
|---|---:|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Legacy fallback for rewrite Ollama generate endpoint; prefer `REWRITE_OLLAMA_URL` or `REWRITE_PROVIDER_OLLAMA_URL`. |
| `OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Legacy fallback for rewrite Ollama model; prefer `REWRITE_OLLAMA_MODEL` or `REWRITE_PROVIDER_OLLAMA_MODEL`. |
| `OLLAMA_KEEP_ALIVE` | `30m` | Ollama keep-alive duration; longer keeps model loaded longer. |
| `REWRITE_OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Preferred rewrite Ollama model key. |
| `REWRITE_PROVIDER_OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Alternate preferred rewrite Ollama model key. |
| `REWRITE_OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Preferred rewrite Ollama generate endpoint key. |
| `REWRITE_PROVIDER_OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Alternate preferred rewrite Ollama generate endpoint key. |
| `REWRITE_OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Preferred rewrite Ollama readiness endpoint key. |
| `REWRITE_PROVIDER_OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Alternate preferred rewrite Ollama readiness endpoint key. |
| `REWRITE_STREAMING_ENABLED` | `false` | Preferred service-scoped streaming toggle. Accepted values: `true`/`false`, `1`/`0` (case-insensitive). Invalid/unset values resolve to `false`. |
| `REWRITE_PROVIDER_STREAMING_ENABLED` | `false` | Alternate service-scoped streaming toggle checked after `REWRITE_STREAMING_ENABLED`. Same accepted values and fallback behavior. |
| `REWRITE_<PROVIDER>_STREAMING_ENABLED` | `false` | Optional provider-specific variant for the selected provider (for example `REWRITE_OLLAMA_STREAMING_ENABLED`). Checked after the two service-level keys. |
| `OLLAMA_TIMEOUT_MS` | `30000` | Legacy fallback for rewrite ready timeout; prefer `REWRITE_READY_TIMEOUT_MS`. |
| `OLLAMA_COLD_TIMEOUT_MS` | `120000` | Legacy fallback for rewrite cold timeout; prefer `REWRITE_COLD_TIMEOUT_MS`. |
| `OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Legacy fallback for rewrite Ollama readiness endpoint; prefer `REWRITE_OLLAMA_PS_URL` or `REWRITE_PROVIDER_OLLAMA_PS_URL`. |
| `OLLAMA_PS_CACHE_MS` | `2000` | Cache TTL (ms) for readiness probe results. |
| `OLLAMA_PS_TIMEOUT_MS` | `1000` | Timeout (ms) for each `/api/ps` probe call. |
| `WARMUP_PS_CACHE_MS` | fallback alias | Legacy/alias for `OLLAMA_PS_CACHE_MS` when primary key is unset. |
| `WARMUP_PS_TIMEOUT_MS` | fallback alias | Legacy/alias for `OLLAMA_PS_TIMEOUT_MS` when primary key is unset. |
| `WARMUP_RETRY_AFTER_SEC` | auto `2-3` | Optional override for `Retry-After` in warming `202` responses. |
| `WARMUP_TRIGGER_TIMEOUT_MS` | `60000` | Timeout (ms) for each warm-up trigger call; higher helps cold loads complete on tiny VPS. |
| `WARMUP_RETRIGGER_WINDOW_MS` | `10000` | Cooldown window (ms) before another warm-up trigger is allowed; recommend `5000-15000` (max `120000`). |
| `READY_REWRITE_STRICT_PROBE_MAX_AGE_MS` | `min(1000, OLLAMA_PS_CACHE_MS)` | When service state is `ready`, forces a fresh Ollama readiness probe if cached probe age exceeds this limit. Helps avoid stale-ready rewrites after upstream restarts. |
| `WARMUP_ON_START` | `true` | Enable startup warm-up loop at boot. Boolean parser accepts true: `1`,`true`,`yes`,`on`; false: `0`,`false`,`no`,`off` (case-insensitive). |
| `WARMUP_STARTUP_MAX_WAIT_MS` | `180000` | Startup warm-up budget before service transitions to degraded startup state. |
| `WARMUP_STARTUP_RETRY_INTERVAL_MS` | `5000` | Delay between startup warm-up attempts. |
| `REWRITE_MAX_TEXT_LENGTH` | `200` | Max accepted `text` length for `POST /rewrite` in Unicode characters (1-600). |
| `REWRITE_MAX_COMPLETION_TOKENS` | `300` | Max completion tokens sent to both Ollama (`num_predict`) and Minimax (`max_completion_tokens`) for `POST /rewrite` stream and non-stream paths. Must be an integer in range `1-8192`; invalid/empty values fall back to `300`. |
| `REWRITE_PROVIDER` | `ollama` | Rewrite backend provider (`ollama` or `minimax`). |
| `T2A_PROVIDER` | `minimax` | T2A backend provider. Currently resolves to Minimax-compatible T2A handling. |
| `T2A_MAX_TEXT_LENGTH` | `200` | Max accepted `text` length for `POST /t2a` in Unicode characters (1-600). |
| `T2A_MINIMAX_API_URL` | `https://api.minimaxi.chat/v1/t2a_v2` | Preferred T2A Minimax endpoint key. |
| `T2A_PROVIDER_MINIMAX_API_URL` | `https://api.minimaxi.chat/v1/t2a_v2` | Alternate preferred T2A Minimax endpoint key. |
| `T2A_URL` | `https://api.minimaxi.chat/v1/t2a_v2` | Alternate preferred T2A endpoint alias. |
| `T2A_MINIMAX_MODEL` | `speech-02-hd` | Preferred T2A Minimax model key. |
| `T2A_PROVIDER_MINIMAX_MODEL` | `speech-02-hd` | Alternate preferred T2A Minimax model key. |
| `T2A_MODEL` | `speech-02-hd` | Alternate preferred T2A model alias. |
| `T2A_MINIMAX_VOICE_ID` | `female-tianmei` | Preferred default T2A voice ID. |
| `T2A_PROVIDER_MINIMAX_VOICE_ID` | `female-tianmei` | Alternate preferred default T2A voice ID. |
| `T2A_VOICE_ID` | `female-tianmei` | Alternate preferred default T2A voice alias. |
| `T2A_MINIMAX_SPEED` | `1` | Preferred default T2A speaking speed. |
| `T2A_PROVIDER_MINIMAX_SPEED` | `1` | Alternate preferred default T2A speaking speed. |
| `T2A_SPEED` | `1` | Alternate preferred default T2A speed alias. |
| `T2A_MINIMAX_VOLUME` | `1` | Preferred default T2A volume. |
| `T2A_PROVIDER_MINIMAX_VOLUME` | `1` | Alternate preferred default T2A volume. |
| `T2A_VOLUME` | `1` | Alternate preferred default T2A volume alias. |
| `T2A_MINIMAX_PITCH` | `0` | Preferred default T2A pitch. |
| `T2A_PROVIDER_MINIMAX_PITCH` | `0` | Alternate preferred default T2A pitch. |
| `T2A_PITCH` | `0` | Alternate preferred default T2A pitch alias. |
| `MINIMAX_T2A_URL` | `https://api.minimaxi.chat/v1/t2a_v2` | Legacy fallback for T2A Minimax endpoint. |
| `MINIMAX_T2A_MODEL` | `speech-02-hd` | Legacy fallback for T2A Minimax model. |
| `MINIMAX_T2A_VOICE_ID` | `female-tianmei` | Legacy fallback for T2A default voice ID. |
| `MINIMAX_T2A_SPEED` | `1` | Legacy fallback for T2A default speed. |
| `MINIMAX_T2A_VOLUME` | `1` | Legacy fallback for T2A default volume. |
| `MINIMAX_T2A_PITCH` | `0` | Legacy fallback for T2A default pitch. |
| `REWRITE_MINIMAX_MODEL` | `M2-her` | Preferred rewrite Minimax model key. |
| `REWRITE_PROVIDER_MINIMAX_MODEL` | `M2-her` | Alternate preferred rewrite Minimax model key. |
| `REWRITE_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Preferred rewrite Minimax endpoint key. |
| `REWRITE_PROVIDER_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Alternate preferred rewrite Minimax endpoint key. |
| `REWRITE_READY_TIMEOUT_MS` | `30000` | Preferred rewrite request timeout (ms) when model is in ready phase. |
| `REWRITE_COLD_TIMEOUT_MS` | `120000` | Preferred rewrite request timeout (ms) during cold/warming phases. |
| `ADMISSION_MAX_CONCURRENCY` | `4` | Global admission limit for concurrent provider executions across rewrite requests. |
| `ADMISSION_MAX_QUEUE_SIZE` | `100` | Global max queued rewrite requests waiting for admission when concurrency is exhausted. |
| `ADMISSION_MAX_WAIT_MS` | `15000` | Global max wait time in queue before request is rejected as overloaded. |
| `<PROVIDER>_MAX_CONCURRENCY` | unset | Optional provider-specific admission concurrency override (for example `OLLAMA_MAX_CONCURRENCY`, `MINIMAX_MAX_CONCURRENCY`). Falls back to global value when unset. |
| `<PROVIDER>_MAX_QUEUE_SIZE` | unset | Optional provider-specific admission queue-size override (for example `OLLAMA_MAX_QUEUE_SIZE`). Falls back to global value when unset. |
| `<PROVIDER>_MAX_WAIT_MS` | unset | Optional provider-specific admission queue wait-time override (for example `MINIMAX_MAX_WAIT_MS`). Falls back to global value when unset. |
| `REWRITE_DEBUG_RAW_OUTPUT` | `false` | Enable structured debug logs for provider rewrite requests/response metadata (`provider_request`, `provider_response_meta`), including request body and usage when available. Sensitive headers/secrets are redacted. |
| `MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Legacy fallback for rewrite Minimax endpoint; prefer `REWRITE_MINIMAX_API_URL` or `REWRITE_PROVIDER_MINIMAX_API_URL`. |
| `MINIMAX_MODEL` | `M2-her` | Legacy fallback for rewrite Minimax model; prefer `REWRITE_MINIMAX_MODEL` or `REWRITE_PROVIDER_MINIMAX_MODEL`. |
| `MINIMAX_API_KEY` | empty | Minimax API key. `/readyz` returns `MINIMAX_API_KEY_MISSING` if unset in Minimax mode. |
| `MINIMAX_READINESS_TIMEOUT_MS` | `5000` | Timeout for Minimax readiness checks (kept for compatibility; passive readiness does not actively probe from control-plane routes). |
| `MINIMAX_PASSIVE_READY_GRACE_MS` | `600000` | Passive readiness grace window (ms). If failures are stale beyond this window, readiness returns to green when policy allows. |
| `MINIMAX_FAIL_OPEN_ON_IDLE` | `true` | Keep Minimax readiness green during idle periods to avoid false red caused only by inactivity. Boolean parser accepts true: `1`,`true`,`yes`,`on`; false: `0`,`false`,`no`,`off` (case-insensitive). |
| `MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD` | `3` | Consecutive rewrite-failure threshold before Minimax readiness can be marked degraded. |
| `MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS` | `15000` | Cooldown (ms) that rate-limits Minimax bounded recovery attempts when strict readiness is fail-closed on recent failures. |
| `BRIDGE_INTERNAL_AUTH_SECRET` | empty (required in production) | Shared secret that must match `X-Bridge-Auth` from reverse proxy before backend accepts `X-Authenticated-Email`. Leave unset only for local/dev setups where auth is intentionally disabled. |
| `TRUSTED_PROXY_ADDRESSES` | `127.0.0.1,::1` | Comma-separated remote addresses allowed to forward trusted OIDC identity headers for limiter keying (`X-Authenticated-Email`, `X-Authenticated-User`, `X-Authenticated-Subject`). Non-matching sources always fall back to `ip:*` fallback identity. |
| `EXPRESS_TRUST_PROXY` | `loopback` | Express `trust proxy` mode used for client-IP derivation. Allowed values are `false`, `loopback`, or a numeric hop count (`1`, `2`, …). Unsafe free-form values are ignored with warning and fallback to `loopback`. Avoid broad `true`, which trusts all upstream proxy metadata. |
| `RATE_LIMIT_GLOBAL_WINDOW_SEC` | `60` | Global baseline fixed-window duration in seconds for non-ops routes. |
| `RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `300` | Global baseline fixed-window request budget per principal for non-ops routes. |
| `RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC` | `60` | Rewrite fixed-window duration (seconds) for authenticated principals (`user:*`). |
| `RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS` | `60` | Rewrite fixed-window request budget for authenticated principals (`user:*`). |
| `RATE_LIMIT_REWRITE_IP_WINDOW_SEC` | `60` | Rewrite fixed-window duration (seconds) for IP fallback principals (`ip:*`). |
| `RATE_LIMIT_REWRITE_IP_MAX_REQUESTS` | `20` | Rewrite fixed-window request budget for IP fallback principals (`ip:*`). |
| `RATE_LIMIT_T2A_AUTH_WINDOW_SEC` | `60` | T2A fixed-window duration (seconds) for authenticated principals (`user:*`). |
| `RATE_LIMIT_T2A_AUTH_MAX_REQUESTS` | `30` | T2A fixed-window request budget for authenticated principals (`user:*`). |
| `RATE_LIMIT_T2A_IP_WINDOW_SEC` | `60` | T2A fixed-window duration (seconds) for IP fallback principals (`ip:*`). |
| `RATE_LIMIT_T2A_IP_MAX_REQUESTS` | `10` | T2A fixed-window request budget for IP fallback principals (`ip:*`). |
| `RATE_LIMIT_OPS_WINDOW_SEC` | `60` | Ops endpoint (`/healthz`, `/readyz`) fixed-window duration in seconds (relaxed by default). |
| `RATE_LIMIT_OPS_MAX_REQUESTS` | `1000` | Ops endpoint fixed-window request budget (relaxed by default). |

### Streaming capability control

Selected-provider streaming is enabled only when both conditions are true:

1. Provider capability declares streaming support (`providerSupportsStreaming=true`).
2. A valid streaming env toggle resolves to `true` using this precedence: `REWRITE_STREAMING_ENABLED` → `REWRITE_PROVIDER_STREAMING_ENABLED` → `REWRITE_<PROVIDER>_STREAMING_ENABLED`.

If unset or invalid, the toggle defaults to `false`. This means streaming is opt-in even when the provider supports it.

### Example startup with overrides

```bash
OLLAMA_KEEP_ALIVE=10m OLLAMA_TIMEOUT_MS=45000 OLLAMA_COLD_TIMEOUT_MS=180000 REWRITE_MAX_COMPLETION_TOKENS=400 WARMUP_PS_CACHE_MS=3000 WARMUP_PS_TIMEOUT_MS=1200 WARMUP_RETRY_AFTER_SEC=3 WARMUP_TRIGGER_TIMEOUT_MS=60000 WARMUP_RETRIGGER_WINDOW_MS=10000 WARMUP_STARTUP_MAX_WAIT_MS=180000 WARMUP_STARTUP_RETRY_INTERVAL_MS=5000 npm start
```

## Small VPS recommended profile

For 2–4 vCPU / 4GB RAM class hosts:

```bash
WARMUP_TRIGGER_TIMEOUT_MS=60000
WARMUP_RETRIGGER_WINDOW_MS=10000
OLLAMA_COLD_TIMEOUT_MS=180000
WARMUP_STARTUP_MAX_WAIT_MS=180000
WARMUP_STARTUP_RETRY_INTERVAL_MS=5000
OLLAMA_KEEP_ALIVE=10m
```

Longer keep-alive improves latency but increases RAM usage.


### Minimax role-split prompt example

When `REWRITE_PROVIDER=minimax`, requests are serialized as chat `messages`:

```json
[
  {
    "role": "system",
    "content": "你是忠實改寫助手。請將以下香港口語廣東話改寫成正式書面繁體中文（zh-Hant）。"
  },
  {
    "role": "user",
    "content": "原文：我今日唔係好舒服，想請半日假。"
  }
]
```

The bridge uses built-in prompt construction for Minimax and does not support runtime prompt-template overrides via environment variables.

## Public API path behind reverse proxy

Canonical public namespace is **`/api/rewrite-bridge/`**.

- `POST /api/rewrite-bridge/rewrite`
- `POST /api/rewrite-bridge/t2a`
- `GET /api/rewrite-bridge/model-status`
- `GET /api/rewrite-bridge/healthz`
- `GET /api/rewrite-bridge/readyz`

Backend service still listens on local-only internal routes:

- `POST /rewrite`
- `POST /t2a`
- `GET /model-status`
- `GET /healthz`
- `GET /readyz`

## Reverse-proxy authentication hardening

To prevent header spoofing, backend authentication now requires **two trust signals** on protected routes:

1. `X-Authenticated-Email` (set by trusted proxy from IdP claim)
2. `X-Bridge-Auth` (shared secret set by trusted proxy only)

Backend enforces that `X-Bridge-Auth` exactly matches `BRIDGE_INTERNAL_AUTH_SECRET` before it will trust `X-Authenticated-Email`. If either signal is missing/invalid, the API returns `401 AUTH_REQUIRED`.

Deployment requirements:

- Set a strong random `BRIDGE_INTERNAL_AUTH_SECRET` in the rewrite-bridge runtime environment.
- In Apache/Nginx, **unset inbound** `X-Authenticated-Email`, `X-Authenticated-User`, `X-Authenticated-Subject`, and `X-Bridge-Auth` from clients.
- Re-set trusted auth headers server-side after successful OIDC/auth processing.
- Keep the shared secret out of git and inject via secret management.

Use `apache/proxy-snippet.conf` as the baseline hardened proxy configuration.

Set `EXPRESS_TRUST_PROXY=loopback` when your reverse proxy is on the same host and forwards requests from loopback. Do not set `EXPRESS_TRUST_PROXY=true`; broad trust lets arbitrary upstream paths influence `req.ip` and weakens IP-based controls.

### Limiter key identity extraction

For request identity keying, middleware resolves `req.clientIdentity.limiterKey` as:

1. `user:<value>` when request source IP is trusted (`TRUSTED_PROXY_ADDRESSES`, default `127.0.0.1,::1`), `X-Bridge-Auth` matches `BRIDGE_INTERNAL_AUTH_SECRET`, and one trusted OIDC header is present.
2. Otherwise `ip:*` fallback is used: with `EXPRESS_TRUST_PROXY` enabled (recommended `loopback` when Apache/Nginx is local) it keys on Express-computed `req.ip` (real client IP); when `EXPRESS_TRUST_PROXY=false`, it keys on socket remote address.

Trusted OIDC header precedence is:

1. `X-Authenticated-Email`
2. `X-Authenticated-User`
3. `X-Authenticated-Subject`

This prevents direct public callers from spoofing identity headers because OIDC headers are ignored unless both trusted-proxy source and shared-secret checks pass.


## API

Detailed endpoint contracts, response formats, streaming behavior, and provider-specific result normalization are documented in `docs/api-reference.md`.

### Forward-compatible response convention

- Primary rewrite response remains JSON.
- Text output remains text-first in `result` for current rewrite behavior.
- Encoded payloads (for example hex/base64) must be added as explicit artifact fields (such as `artifacts[].encoding` + `artifacts[].data`) rather than overloading `result`.
- Artifact fields are optional and service/provider-dependent; clients should treat them as additive metadata.

Example response with text plus an optional encoded artifact:

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

## Deployment

Deployment/runbook documentation (systemd, reverse proxy, provider settings, and readiness troubleshooting) is in `docs/deployment-guide.md`.
Manual auth validation checklist is in `docs/runbooks/auth-matrix-manual-cli-checklist.md`.


### `GET /model-status` (internal app route)

Diagnostics endpoint for frontend polling and operator debugging.

Warm-up metadata includes: `status`, `serviceState`, `startupWarmupAttempts`, `startupWarmupDeadlineAt`, `warmupInFlight`, `lastWarmupTriggerAt`, `lastWarmupResult`, `lastWarmupError`.

### `POST /rewrite` (internal app route)

- During startup warm-up (`serviceState=starting`), returns HTTP `202` and `Retry-After` with `MODEL_WARMUP_STARTED` or `MODEL_WARMING`.
- If startup warm-up budget is exhausted (`serviceState=degraded`), returns HTTP `503` with `MODEL_STARTUP_DEGRADED` and actionable remediation text.
- Control-plane probes can self-heal state: when readiness probe becomes healthy again, service state can auto-recover from `degraded` to `ready`.
- Once ready, returns HTTP `200` with `{ "ok": true, "result": "..." }` and optional additive `usage` metadata when provider usage counters are available.
- Layered rate limiting is enforced with a global baseline plus rewrite-service quotas by principal type (`user:*` first, `ip:*` fallback).
- Exceeded quotas return `429 RATE_LIMITED`, include `Retry-After` seconds, and a stable payload with `error.reason=RATE_LIMIT_EXCEEDED` and retry metadata.
- Admission overload (queue full or queue wait timeout) returns `503 ADMISSION_OVERLOADED` with a consistent payload shape that includes `reason` (`queue_full` or `wait_timeout`) and `admission` limit metadata. Shared admission controls still come from rewrite/provider admission settings in `services/rewrite.js`, so rewrite and T2A continue to share the same execute-with-admission path.

### `GET /healthz` / `GET /readyz`

Intended audience:
- `/healthz`: infra/process liveness checks (`200` if process is up).
- `/healthz` and `/readyz` use separate relaxed ops limiter settings (`RATE_LIMIT_OPS_*`) and are excluded from the global baseline limiter.
- `/readyz`: traffic gating for load balancers (`200` only when `serviceState=ready`, otherwise `503`).
- `/model-status`: richer diagnostics for UI polling and operator troubleshooting.

If exposed through public VirtualHost, protect `/api/rewrite-bridge/healthz` and `/api/rewrite-bridge/readyz` with allowlist/auth or private-network-only controls.

`/readyz` response contract:

```json
{ "ok": true, "serviceState": "ready", "reason": null }
```

```json
{ "ok": false, "serviceState": "starting", "reason": "STARTING_WARMUP" }
```

Other possible `reason` values: `STARTUP_DEGRADED`, `MODEL_NOT_READY`, `MODEL_PROBE_UNAVAILABLE`, `MINIMAX_API_KEY_MISSING`, `MINIMAX_RECENT_FAILURES`.

Response stability note: `/readyz` always includes `ok`, `serviceState`, and `reason` (with `reason: null` on success); frontend clients should branch on `ok` and treat `reason` as nullable.


### Minimax readiness policy (passive / non-synthetic)

When `REWRITE_PROVIDER=minimax`, readiness is **passive**:
- `/readyz` and `/model-status` do **not** send synthetic upstream chat-completion probes.
- Rewrite preflight in `POST /rewrite` also avoids synthetic `checkReadiness()` traffic.
- Readiness is inferred from local observations: API key presence, recent rewrite success/failure timestamps, and consecutive failure count.

This keeps readiness checks non-billable and avoids probe-induced usage/cost spikes. Tradeoff: upstream outages may be detected less immediately when traffic is idle.

Policy details:
- `MINIMAX_FAIL_OPEN_ON_IDLE=true` (also `1`, `yes`, `on`) keeps the time/idle fail-open behavior. Once failures are old enough (or traffic has been idle past `MINIMAX_PASSIVE_READY_GRACE_MS`), passive readiness can return to green.
- `MINIMAX_FAIL_OPEN_ON_IDLE=false` (also `0`, `no`, `off`) is strict fail-closed after threshold failures: elapsed time alone does not recover readiness; a successful rewrite is required to clear failure streak state.

Controlled recovery-attempt mechanism (backend guardrail):
- Even in strict fail-closed state (`MINIMAX_RECENT_FAILURES`), backend allows bounded `POST /rewrite` recovery attempts to break deadlock.
- Attempts are globally rate-limited by `MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS`.
- If cooldown is active, `POST /rewrite` returns `429 MINIMAX_RECOVERY_COOLDOWN` with `Retry-After`.
- Non-recoverable readiness failures (for example `MINIMAX_API_KEY_MISSING`) remain hard denied.

Operationally:
- Ready (`200`) when passive policy allows traffic.
- Not ready (`503`) with deterministic reason codes such as `MINIMAX_API_KEY_MISSING` or `MINIMAX_RECENT_FAILURES`.
- `/model-status` includes passive-readiness diagnostics (`lastRewriteSuccessAt`, `lastRewriteFailureAt`, `consecutiveRewriteFailures`, recovery cooldown metadata, policy reason/knobs) for troubleshooting without external probe traffic.

## Frontend behavior recommendation

- If `POST /api/rewrite-bridge/rewrite` returns `202`, show a **model loading** message and retry using `Retry-After`.
- If it returns `503` with `MODEL_STARTUP_DEGRADED`, tell users to retry later and alert operators.
- Poll `GET /api/rewrite-bridge/model-status` every **2–3 seconds** until `serviceState` is `ready`.

## Deployment

See detailed server deployment steps in `docs/deployment-guide.md`.
For post-deploy auth boundary validation, run the checklist in `docs/runbooks/auth-matrix-manual-cli-checklist.md`.

## Operator validation checklist

```bash
# 1) Start service and watch startup warm-up attempts + transition
sudo systemctl restart rewrite-bridge
sudo journalctl -u rewrite-bridge -f

# 2) Observe serviceState starting -> ready/degraded
watch -n 2 "curl -sS http://127.0.0.1:3001/model-status"

# 3) Verify /rewrite behavior during warm-up and after ready
curl -i -sS http://127.0.0.1:3001/rewrite -H 'Content-Type: application/json' -d '{"text":"你今日得唔得閒？"}'

# 4) Confirm single in-flight warm-up behavior
sudo journalctl -u rewrite-bridge -n 200 --no-pager | rg 'Startup warmup attempt completed|warmupInFlight|MODEL_WARMUP_STARTED'
```


### `POST /t2a` (internal app route)

Protected T2A routes use the same auth middleware, client-identity resolver, global/rewrite rate-limit integration, and admission-control flow as rewrite routes.

Request body:

```json
{
  "text": "你好，歡迎使用",
  "response_mode": "binary"
}
```

Supported fields:
- `text` (required): trimmed, non-empty string, max `T2A_MAX_TEXT_LENGTH` Unicode characters.
- `response_mode` (optional): `binary`/`default` for raw MP3 bytes, or `base64_json` for JSON-wrapped base64 audio.
- `voice_id`, `speed`, `volume`, `pitch` (optional): voice controls passed through to Minimax.
- `sample_rate`, `bitrate`, `format` (optional): audio options validated against the T2A service definition.
- `stream=true` is rejected with `501 STREAMING_UNSUPPORTED`.

Binary success returns `200 OK` with `Content-Type: audio/mpeg`, `Content-Length`, and `Content-Disposition: inline; filename="speech.mp3"`.

JSON success returns:

```json
{
  "ok": true,
  "audio": "<base64>",
  "format": "mp3",
  "mime": "audio/mpeg",
  "contentType": "audio/mpeg",
  "size": 12345,
  "provider": {
    "traceId": "trace-123"
  }
}
```

The bridge does not persist MP3 files on disk; audio is streamed directly from provider response data back to the caller.
