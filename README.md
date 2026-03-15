# hk-ollama-rewrite-bridge

Production-ready Node.js Express bridge that rewrites Hong Kong colloquial Cantonese into formal Traditional Chinese via configurable backend providers (`ollama` or `minimax`).

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
- `tests/providers/minimax.test.js`: validates Minimax SSE frame normalization and done/fallback streaming behavior.

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
| `REWRITE_MINIMAX_MODEL` | `M2-her` | Preferred rewrite Minimax model key. |
| `REWRITE_PROVIDER_MINIMAX_MODEL` | `M2-her` | Alternate preferred rewrite Minimax model key. |
| `REWRITE_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Preferred rewrite Minimax endpoint key. |
| `REWRITE_PROVIDER_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Alternate preferred rewrite Minimax endpoint key. |
| `REWRITE_READY_TIMEOUT_MS` | `30000` | Preferred rewrite request timeout (ms) when model is in ready phase. |
| `REWRITE_COLD_TIMEOUT_MS` | `120000` | Preferred rewrite request timeout (ms) during cold/warming phases. |
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
- `GET /api/rewrite-bridge/model-status`
- `GET /api/rewrite-bridge/healthz`
- `GET /api/rewrite-bridge/readyz`

Backend service still listens on local-only internal routes:

- `POST /rewrite`
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
- In Apache/Nginx, **unset inbound** `X-Authenticated-Email` and `X-Bridge-Auth` from clients.
- Re-set both headers server-side after successful OIDC/auth processing.
- Keep the shared secret out of git and inject via secret management.

Use `apache/proxy-snippet.conf` as the baseline hardened proxy configuration.

## API

Detailed endpoint contracts, response formats, streaming behavior, and provider-specific result normalization are documented in `docs/api-reference.md`.

### Forward-compatible response convention

- Primary rewrite response remains JSON.
- Text output remains text-first in `result` for current rewrite behavior.
- Encoded payloads, when introduced, should be added as explicit artifact fields (such as `artifacts[].encoding` + `artifacts[].data`) rather than overloading `result`.
- Artifact fields are forward-compatible, optional, and service/provider-dependent; clients should treat them as additive metadata and should not assume they are present today.

Current `stream=false` success response shape:

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

### `GET /healthz` / `GET /readyz`

Intended audience:
- `/healthz`: infra/process liveness checks (`200` if process is up).
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
