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

- `tests/providers/ollama.test.js`: validates Ollama stream parsing/error handling for malformed or incomplete JSONL responses.
- `tests/providers/minimax.test.js`: validates Minimax SSE frame normalization and done/fallback streaming behavior.

Run all tests:

```bash
npm test
```

## Environment Variables

Tune runtime behavior without code changes:

| Key | Default | Meaning |
|---|---:|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama generate endpoint used by `POST /rewrite`. |
| `OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Model name sent in rewrite requests. |
| `OLLAMA_KEEP_ALIVE` | `30m` | Ollama keep-alive duration; longer keeps model loaded longer. |
| `OLLAMA_TIMEOUT_MS` | `30000` | Request timeout (ms) when model is in `ready` phase. |
| `OLLAMA_COLD_TIMEOUT_MS` | `120000` | Request timeout (ms) for cold/warming phases. Recommend `120000-180000` for low-power VPS. |
| `OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Ollama status endpoint used to probe readiness. |
| `OLLAMA_PS_CACHE_MS` | `2000` | Cache TTL (ms) for readiness probe results. |
| `OLLAMA_PS_TIMEOUT_MS` | `1000` | Timeout (ms) for each `/api/ps` probe call. |
| `WARMUP_PS_CACHE_MS` | fallback alias | Legacy/alias for `OLLAMA_PS_CACHE_MS` when primary key is unset. |
| `WARMUP_PS_TIMEOUT_MS` | fallback alias | Legacy/alias for `OLLAMA_PS_TIMEOUT_MS` when primary key is unset. |
| `WARMUP_RETRY_AFTER_SEC` | auto `2-3` | Optional override for `Retry-After` in warming `202` responses. |
| `WARMUP_TRIGGER_TIMEOUT_MS` | `60000` | Timeout (ms) for each warm-up trigger call; higher helps cold loads complete on tiny VPS. |
| `WARMUP_RETRIGGER_WINDOW_MS` | `10000` | Cooldown window (ms) before another warm-up trigger is allowed; recommend `5000-15000` (max `120000`). |
| `WARMUP_ON_START` | `true` | Enable startup warm-up loop at boot. |
| `WARMUP_STARTUP_MAX_WAIT_MS` | `180000` | Startup warm-up budget before service transitions to degraded startup state. |
| `WARMUP_STARTUP_RETRY_INTERVAL_MS` | `5000` | Delay between startup warm-up attempts. |
| `REWRITE_PROVIDER` | `ollama` | Rewrite backend provider (`ollama` or `minimax`). |
| `MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Minimax chat-completion endpoint used when `REWRITE_PROVIDER=minimax`. |
| `MINIMAX_MODEL` | `M2-her` | Minimax model name used for rewrite requests. |
| `MINIMAX_API_KEY` | empty | Minimax API key. `/readyz` returns `MINIMAX_API_KEY_MISSING` if unset in Minimax mode. |
| `MINIMAX_READINESS_TIMEOUT_MS` | `5000` | Timeout for Minimax readiness checks (kept for compatibility; passive readiness does not actively probe from control-plane routes). |
| `MINIMAX_PASSIVE_READY_GRACE_MS` | `600000` | Passive readiness grace window (ms). If failures are stale beyond this window, readiness returns to green when policy allows. |
| `MINIMAX_FAIL_OPEN_ON_IDLE` | `true` | Keep Minimax readiness green during idle periods to avoid false red caused only by inactivity. |
| `MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD` | `3` | Consecutive rewrite-failure threshold before Minimax readiness can be marked degraded. |
| `MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS` | `15000` | Cooldown (ms) that rate-limits Minimax bounded recovery attempts when strict readiness is fail-closed on recent failures. |

### Example startup with overrides

```bash
OLLAMA_KEEP_ALIVE=10m OLLAMA_TIMEOUT_MS=45000 OLLAMA_COLD_TIMEOUT_MS=180000 WARMUP_PS_CACHE_MS=3000 WARMUP_PS_TIMEOUT_MS=1200 WARMUP_RETRY_AFTER_SEC=3 WARMUP_TRIGGER_TIMEOUT_MS=60000 WARMUP_RETRIGGER_WINDOW_MS=10000 WARMUP_STARTUP_MAX_WAIT_MS=180000 WARMUP_STARTUP_RETRY_INTERVAL_MS=5000 npm start
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

## API

Detailed endpoint contracts, response formats, streaming behavior, and provider-specific result normalization are documented in `docs/api-reference.md`.

## Deployment

Deployment/runbook documentation (systemd, reverse proxy, provider settings, and readiness troubleshooting) is in `docs/depolyment_guide.md`.


### `GET /model-status` (internal app route)

Diagnostics endpoint for frontend polling and operator debugging.

Warm-up metadata includes: `status`, `serviceState`, `startupWarmupAttempts`, `startupWarmupDeadlineAt`, `warmupInFlight`, `lastWarmupTriggerAt`, `lastWarmupResult`, `lastWarmupError`.

### `POST /rewrite` (internal app route)

- During startup warm-up (`serviceState=starting`), returns HTTP `202` and `Retry-After` with `MODEL_WARMUP_STARTED` or `MODEL_WARMING`.
- If startup warm-up budget is exhausted (`serviceState=degraded`), returns HTTP `503` with `MODEL_STARTUP_DEGRADED` and actionable remediation text.
- Control-plane probes can self-heal state: when readiness probe becomes healthy again, service state can auto-recover from `degraded` to `ready`.
- Once ready, returns HTTP `200` with `{ "ok": true, "result": "..." }`.

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
- `MINIMAX_FAIL_OPEN_ON_IDLE=true` keeps the time/idle fail-open behavior. Once failures are old enough (or traffic has been idle past `MINIMAX_PASSIVE_READY_GRACE_MS`), passive readiness can return to green.
- `MINIMAX_FAIL_OPEN_ON_IDLE=false` is strict fail-closed after threshold failures: elapsed time alone does not recover readiness; a successful rewrite is required to clear failure streak state.

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

See detailed server deployment steps in `docs/depolyment_guide.md`.

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
