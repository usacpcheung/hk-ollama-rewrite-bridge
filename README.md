# hk-ollama-rewrite-bridge

Production-ready Node.js Express bridge that rewrites Hong Kong colloquial Cantonese into formal Traditional Chinese via local Ollama.

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
| `WARMUP_ON_START` | `true` | Enable startup warm-up loop at boot. |
| `WARMUP_STARTUP_MAX_WAIT_MS` | `180000` | Startup warm-up budget before service transitions to degraded startup state. |
| `WARMUP_STARTUP_RETRY_INTERVAL_MS` | `5000` | Delay between startup warm-up attempts. |

### Example startup with overrides

```bash
OLLAMA_KEEP_ALIVE=10m OLLAMA_TIMEOUT_MS=45000 OLLAMA_COLD_TIMEOUT_MS=180000 WARMUP_PS_CACHE_MS=3000 WARMUP_PS_TIMEOUT_MS=1200 WARMUP_RETRY_AFTER_SEC=3 WARMUP_TRIGGER_TIMEOUT_MS=60000 WARMUP_STARTUP_MAX_WAIT_MS=180000 WARMUP_STARTUP_RETRY_INTERVAL_MS=5000 npm start
```

## Small VPS recommended profile

For 2–4 vCPU / 4GB RAM class hosts:

```bash
WARMUP_TRIGGER_TIMEOUT_MS=60000
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

Backend service still listens on local-only internal routes:

- `POST /rewrite`
- `GET /model-status`
- `GET /healthz`
- `GET /readyz`

## API

### `GET /model-status` (internal app route)

Returns model readiness info suitable for frontend polling.

Warm-up metadata includes: `status`, `serviceState`, `startupWarmupAttempts`, `startupWarmupDeadlineAt`, `warmupInFlight`, `lastWarmupTriggerAt`, `lastWarmupResult`, `lastWarmupError`.

### `POST /rewrite` (internal app route)

- During startup warm-up (`serviceState=starting`), returns HTTP `202` and `Retry-After` with `MODEL_WARMUP_STARTED` or `MODEL_WARMING`.
- If startup warm-up budget is exhausted (`serviceState=degraded`), returns HTTP `503` with `MODEL_STARTUP_DEGRADED` and actionable remediation text.
- Once ready, returns HTTP `200` with `{ "ok": true, "result": "..." }`.

### `GET /healthz` / `GET /readyz`

- `/healthz` is liveness only (`200` if process is up).
- `/readyz` is readiness (`200` only when `serviceState=ready`, otherwise `503`).

## Frontend behavior recommendation

- If `POST /api/rewrite-bridge/rewrite` returns `202`, show a **model loading** message and retry using `Retry-After`.
- If it returns `503` with `MODEL_STARTUP_DEGRADED`, tell users to retry later and alert operators.
- Poll `GET /api/rewrite-bridge/model-status` every **2–3 seconds** until `serviceState` is `ready`.

## Deployment

See detailed server deployment steps in `depolyment_guide.md`.

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
