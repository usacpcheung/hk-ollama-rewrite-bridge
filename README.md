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
| `OLLAMA_COLD_TIMEOUT_MS` | `90000` | Request timeout (ms) for cold/warming phases. |
| `OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Ollama status endpoint used to probe readiness. |
| `OLLAMA_PS_CACHE_MS` | `2000` | Cache TTL (ms) for readiness probe results. |
| `OLLAMA_PS_TIMEOUT_MS` | `1000` | Timeout (ms) for each `/api/ps` probe call. |
| `WARMUP_PS_CACHE_MS` | fallback alias | Legacy/alias for `OLLAMA_PS_CACHE_MS` when primary key is unset. |
| `WARMUP_PS_TIMEOUT_MS` | fallback alias | Legacy/alias for `OLLAMA_PS_TIMEOUT_MS` when primary key is unset. |
| `WARMUP_RETRY_AFTER_SEC` | auto `2-3` | Optional override for `Retry-After` in warming `202` responses. |

### Example startup with overrides

```bash
OLLAMA_KEEP_ALIVE=45m OLLAMA_TIMEOUT_MS=45000 OLLAMA_COLD_TIMEOUT_MS=180000 WARMUP_PS_CACHE_MS=3000 WARMUP_PS_TIMEOUT_MS=1200 WARMUP_RETRY_AFTER_SEC=3 npm start
```

## Public API path behind reverse proxy

Canonical public namespace is **`/api/rewrite-bridge/`**.

- `POST /api/rewrite-bridge/rewrite`
- `GET /api/rewrite-bridge/model-status`

Backend service still listens on local-only internal routes:

- `POST /rewrite`
- `GET /model-status`

### Compatibility note

`/api/rewrite` is kept as a temporary legacy alias for rewrite requests only.
New integrations should use `/api/rewrite-bridge/*` and migrate as soon as possible.
Planned removal of legacy `/api/rewrite` alias: next breaking-release window after all clients migrate.

## API

### `GET /model-status` (internal app route)

Returns model readiness info suitable for frontend polling.

Response JSON:

```json
{
  "status": "warming",
  "lastWarmAt": null,
  "lastError": null
}
```

- `status` is one of:
  - `warming`: model is still loading
  - `ready`: model is ready for rewrite requests
  - `degraded`: recent model/proxy errors occurred
- `lastWarmAt` is ISO-8601 timestamp of last successful warm/serve event.
- `lastError` is latest known error object (or `null`).

### `POST /rewrite` (internal app route)

Request JSON:

```json
{ "text": "你今日得唔得閒？" }
```

Success:

```json
{ "ok": true, "result": "你今天有空嗎？" }
```

Warming response (HTTP `202` + `Retry-After` header):

```json
{
  "ok": false,
  "error": { "code": "MODEL_WARMING", "message": "Model is loading" },
  "retryAfterSec": 2
}
```

Error format:

```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

### Frontend behavior recommendation

- If `POST /api/rewrite-bridge/rewrite` returns `202` / `MODEL_WARMING`, show a **“model is loading”** message.
- Retry submission, or poll `GET /api/rewrite-bridge/model-status` every **2–3 seconds** until `status` becomes `ready`.
- Respect `Retry-After` when present.

## curl examples

These examples use the public reverse-proxy namespace.

### Check model status

```bash
curl -sS https://rewrite.example.com/api/rewrite-bridge/model-status
```

### Normal request

```bash
curl -i -sS https://rewrite.example.com/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"佢啱啱先返到公司，等多陣。"}'
```

### Missing text

```bash
curl -sS https://rewrite.example.com/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### Too long (>200 chars)

```bash
curl -sS https://rewrite.example.com/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"<put over-200-char text here>"}'
```

## Troubleshooting tuning tips

- **Large models timing out during first request**: increase `OLLAMA_COLD_TIMEOUT_MS` (for example `120000-300000`) to accommodate model load time.
- **Frequent timeouts even after warm-up**: increase `OLLAMA_TIMEOUT_MS` incrementally and inspect request logs (`phase`, `selectedTimeoutMs`).
- **High memory usage on host**: reduce `OLLAMA_KEEP_ALIVE` so idle models unload sooner; longer keep-alive improves latency but uses more RAM.

## Deployment

See detailed server deployment steps in `depolyment_guide.md`.
