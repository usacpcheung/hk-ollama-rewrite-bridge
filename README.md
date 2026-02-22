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

### `POST /rewrite`

Request JSON:

```json
{ "text": "你今日得唔得閒？" }
```

Success:

```json
{ "ok": true, "result": "你今天有空嗎？" }
```

Error format:

```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

## curl examples

### Normal request

```bash
curl -sS http://127.0.0.1:3001/rewrite \
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
