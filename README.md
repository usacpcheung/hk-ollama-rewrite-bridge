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

## API

### `GET /model-status`

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

### `POST /rewrite`

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

- If `POST /rewrite` returns `202` / `MODEL_WARMING`, show a **“model is loading”** message.
- Retry submission, or poll `GET /model-status` every **2–3 seconds** until `status` becomes `ready`.
- Respect `Retry-After` when present.

## curl examples

### Check model status

```bash
curl -sS http://127.0.0.1:3001/model-status
```

### Normal request

```bash
curl -i -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"佢啱啱先返到公司，等多陣。"}'
```

### Missing text

```bash
curl -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### Too long (>200 chars)

```bash
curl -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"<put over-200-char text here>"}'
```

## Deployment

See detailed server deployment steps in `depolyment_guide.md`.
