# Deployment Guide (hk-ollama-rewrite-bridge)

This guide documents production deployment for both implemented services:

- **Rewrite** via `POST /rewrite`
- **T2A** via `POST /t2a`

It covers provider selection, environment configuration, reverse-proxy setup, and post-deploy validation.

## 1) Prerequisites

- Linux host with systemd
- Node.js 18+
- App bound locally on `127.0.0.1:3001`
- Reverse proxy in front of the app for public exposure
- Choose providers:
  - Rewrite: `ollama` or `minimax`
  - T2A: current implementation uses a Minimax-compatible provider path
- For any Minimax-backed path: outbound internet access and `MINIMAX_API_KEY`

Ubuntu/Debian bootstrap:

```bash
sudo apt update
sudo apt install -y git curl nodejs npm apache2
node -v
npm -v
```

## 2) Clone and install

Recommended location:

```text
/opt/hk-ollama-rewrite-bridge
```

```bash
sudo mkdir -p /opt/hk-ollama-rewrite-bridge
sudo chown -R "$USER":"$USER" /opt/hk-ollama-rewrite-bridge
git clone <YOUR_GIT_REPO_URL> /opt/hk-ollama-rewrite-bridge
cd /opt/hk-ollama-rewrite-bridge
npm ci
```

Optional sanity run:

```bash
npm start
```

## 3) Provider selection and required settings

### Rewrite service

Set `REWRITE_PROVIDER`:

- `REWRITE_PROVIDER=ollama` for local Ollama rewrite generation
- `REWRITE_PROVIDER=minimax` for Minimax rewrite generation

Unsupported values fail startup.

#### Rewrite with Ollama

```env
REWRITE_PROVIDER=ollama
REWRITE_OLLAMA_URL=http://127.0.0.1:11434/api/generate
REWRITE_OLLAMA_PS_URL=http://127.0.0.1:11434/api/ps
REWRITE_OLLAMA_MODEL=qwen2.5:3b-instruct
OLLAMA_KEEP_ALIVE=30m
```

#### Rewrite with Minimax

```env
REWRITE_PROVIDER=minimax
REWRITE_MINIMAX_API_URL=https://api.minimax.io/v1/text/chatcompletion_v2
REWRITE_MINIMAX_MODEL=M2-her
MINIMAX_API_KEY=<SECRET>
```

### T2A service

The current T2A service resolves to a Minimax-compatible path even though it still exposes `T2A_PROVIDER` for service-scoped config consistency.

Recommended T2A settings:

```env
T2A_PROVIDER=minimax
T2A_MINIMAX_API_URL=https://api.minimax.io/v1/t2a_v2
T2A_MINIMAX_MODEL=speech-2.6-hd
T2A_MINIMAX_VOICE_ID=Cantonese_ProfessionalHost（F)
T2A_MINIMAX_SPEED=1
T2A_MINIMAX_VOLUME=1
T2A_MINIMAX_PITCH=0
T2A_INVOKE_TIMEOUT_MS=30000
MINIMAX_API_KEY=<SECRET>
```

If `MINIMAX_API_KEY` is missing, Minimax-backed traffic cannot succeed and readiness can report `MINIMAX_API_KEY_MISSING` on Minimax rewrite paths.

## 4) Example production env file

Example `/etc/default/rewrite-bridge`:

```bash
REWRITE_PROVIDER=ollama
REWRITE_OLLAMA_MODEL=qwen2.5:3b-instruct
REWRITE_OLLAMA_URL=http://127.0.0.1:11434/api/generate
REWRITE_OLLAMA_PS_URL=http://127.0.0.1:11434/api/ps
REWRITE_MAX_TEXT_LENGTH=200
REWRITE_MAX_COMPLETION_TOKENS=300

T2A_PROVIDER=minimax
T2A_MINIMAX_API_URL=https://api.minimax.io/v1/t2a_v2
T2A_MINIMAX_MODEL=speech-2.6-hd
T2A_MINIMAX_VOICE_ID=Cantonese_ProfessionalHost（F)
T2A_MAX_TEXT_LENGTH=200
T2A_INVOKE_TIMEOUT_MS=30000

MINIMAX_API_KEY=<SECRET>
BRIDGE_INTERNAL_AUTH_SECRET=<SECRET>
EXPRESS_TRUST_PROXY=loopback
TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1
```

## 5) Environment reference

### Core service variables

| Variable | Default | Purpose |
|---|---|---|
| `REWRITE_PROVIDER` | `ollama` | Rewrite provider selection. |
| `REWRITE_MAX_TEXT_LENGTH` | `200` | Rewrite input-length cap. |
| `REWRITE_MAX_COMPLETION_TOKENS` | `300` | Rewrite upstream token budget. |
| `T2A_PROVIDER` | `minimax` | T2A provider selection abstraction. |
| `T2A_MAX_TEXT_LENGTH` | `200` | T2A input-length cap. |
| `T2A_INVOKE_TIMEOUT_MS` | `30000` | T2A provider timeout. |
| `MINIMAX_API_KEY` | empty | Required for Minimax-backed traffic. |

### Rewrite / Ollama lifecycle variables

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_KEEP_ALIVE` | `30m` | Keep model resident. |
| `OLLAMA_PS_CACHE_MS` | `2000` | Readiness probe cache TTL. |
| `OLLAMA_PS_TIMEOUT_MS` | `1000` | Timeout per readiness probe. |
| `REWRITE_READY_TIMEOUT_MS` | `30000` | Rewrite ready-phase timeout. |
| `REWRITE_COLD_TIMEOUT_MS` | `120000` | Rewrite cold/warming timeout. |
| `WARMUP_ON_START` | `true` | Run startup warmup. |
| `WARMUP_STARTUP_MAX_WAIT_MS` | `180000` | Startup warmup budget. |
| `WARMUP_STARTUP_RETRY_INTERVAL_MS` | `5000` | Delay between startup warmup attempts. |
| `WARMUP_TRIGGER_TIMEOUT_MS` | `60000` | Warmup trigger timeout. |
| `WARMUP_RETRIGGER_WINDOW_MS` | `10000` | Warmup retrigger cooldown. |
| `WARMUP_RETRY_AFTER_SEC` | auto | `Retry-After` for warming responses. |
| `READY_REWRITE_STRICT_PROBE_MAX_AGE_MS` | derived | Max age before strict rewrite re-probe. |

### T2A defaults and aliases

| Variable | Default | Purpose |
|---|---|---|
| `T2A_MINIMAX_API_URL` | `https://api.minimax.io/v1/t2a_v2` | Preferred T2A endpoint. |
| `T2A_PROVIDER_MINIMAX_API_URL` | same | Alternate preferred T2A endpoint key. |
| `T2A_URL` | same | Short alias for T2A endpoint. |
| `T2A_MINIMAX_MODEL` | `speech-2.6-hd` | Preferred T2A model. |
| `T2A_PROVIDER_MINIMAX_MODEL` | same | Alternate preferred T2A model key. |
| `T2A_MODEL` | same | Short alias for T2A model. |
| `T2A_MINIMAX_VOICE_ID` | `Cantonese_ProfessionalHost（F)` | Default voice ID. |
| `T2A_MINIMAX_SPEED` | `1` | Default speed. |
| `T2A_MINIMAX_VOLUME` | `1` | Default volume. |
| `T2A_MINIMAX_PITCH` | `0` | Default pitch. |
| `MINIMAX_T2A_*` | legacy | Legacy fallback aliases for endpoint/model/voice/speed/volume/pitch. |

### Auth, trust, and rate limiting

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_INTERNAL_AUTH_SECRET` | empty | Shared proxy-to-backend secret. |
| `TRUSTED_PROXY_ADDRESSES` | `127.0.0.1,::1` | Sources allowed to forward identity headers. |
| `EXPRESS_TRUST_PROXY` | `loopback` | Client-IP derivation mode. |
| `RATE_LIMIT_GLOBAL_*` | varies | Global non-ops fixed-window limiter. |
| `RATE_LIMIT_REWRITE_*` | varies | Rewrite fixed-window limiter. |
| `RATE_LIMIT_T2A_*` | varies | T2A fixed-window limiter. |
| `RATE_LIMIT_OPS_*` | varies | Health/readiness limiter. |
| `ADMISSION_MAX_CONCURRENCY` | `4` | Shared admission concurrency cap. |
| `ADMISSION_MAX_QUEUE_SIZE` | `100` | Shared admission queue cap. |
| `ADMISSION_MAX_WAIT_MS` | `15000` | Shared admission queue wait cap. |

## 6) systemd setup

Use `systemd/rewrite-bridge.service` and ensure install paths match.

```bash
sudo cp /opt/hk-ollama-rewrite-bridge/systemd/rewrite-bridge.service /etc/systemd/system/rewrite-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable rewrite-bridge
sudo systemctl restart rewrite-bridge
sudo systemctl status rewrite-bridge --no-pager
```

Confirm the unit loads `/etc/default/rewrite-bridge`:

```ini
EnvironmentFile=-/etc/default/rewrite-bridge
```

## 7) Apache reverse proxy

Enable modules:

```bash
sudo a2enmod proxy proxy_http headers auth_openidc
sudo systemctl restart apache2
```

Use `apache/proxy-snippet.conf` as the hardened baseline.

Important hardening rules:

- Strip inbound trusted headers from callers.
- Inject trusted headers only after successful OIDC/auth.
- Keep backend on loopback only.
- Protect both rewrite and T2A when they are exposed publicly.

### Canonical route mapping

```apache
ProxyPass /api/rewrite-bridge/rewrite http://127.0.0.1:3001/rewrite
ProxyPassReverse /api/rewrite-bridge/rewrite http://127.0.0.1:3001/rewrite
ProxyPass /api/rewrite-bridge/t2a http://127.0.0.1:3001/t2a
ProxyPassReverse /api/rewrite-bridge/t2a http://127.0.0.1:3001/t2a
ProxyPass /api/rewrite-bridge/model-status http://127.0.0.1:3001/model-status
ProxyPassReverse /api/rewrite-bridge/model-status http://127.0.0.1:3001/model-status
ProxyPass /api/rewrite-bridge/healthz http://127.0.0.1:3001/healthz
ProxyPassReverse /api/rewrite-bridge/healthz http://127.0.0.1:3001/healthz
ProxyPass /api/rewrite-bridge/readyz http://127.0.0.1:3001/readyz
ProxyPassReverse /api/rewrite-bridge/readyz http://127.0.0.1:3001/readyz

<Location "/api/rewrite-bridge">
    AuthType openid-connect
    Require valid-user
</Location>

RequestHeader unset X-Authenticated-Email
RequestHeader unset X-Authenticated-User
RequestHeader unset X-Authenticated-Subject
RequestHeader unset X-Bridge-Auth
RequestHeader set X-Authenticated-Email "%{OIDC_CLAIM_email}e" env=OIDC_CLAIM_email
RequestHeader set X-Bridge-Auth "<shared-secret-from-secret-store>"
```

Validate and reload:

```bash
sudo apachectl configtest
sudo systemctl reload apache2
```

## 8) Post-deploy verification

### Health and readiness

```bash
curl -i -sS http://127.0.0.1:3001/healthz
curl -i -sS http://127.0.0.1:3001/readyz
curl -sS http://127.0.0.1:3001/model-status | jq
```

### Rewrite smoke test

```bash
curl -i -sS http://127.0.0.1:3001/rewrite   -H 'Content-Type: application/json'   -H 'X-Bridge-Auth: <shared-secret>'   -H 'X-Authenticated-Email: tester@hs.edu.hk'   -d '{"text":"你今日得唔得閒？"}'
```

### T2A smoke test

```bash
curl -i -sS http://127.0.0.1:3001/t2a   -H 'Content-Type: application/json'   -H 'X-Bridge-Auth: <shared-secret>'   -H 'X-Authenticated-Email: tester@hs.edu.hk'   -d '{"text":"你好，歡迎使用","response_mode":"base64_json"}'
```

Expected behavior:

- `healthz` returns `200 {"ok":true}` while process is up.
- `readyz` may return `503` during rewrite startup warmup.
- Rewrite may return `202` while Ollama is warming.
- T2A should return `200` when auth, rate limits, and provider config are valid.
- `429 RATE_LIMITED` and `503 ADMISSION_OVERLOADED` remain possible on either protected route.

## 9) Troubleshooting focus areas

### Rewrite startup problems

- Check `/model-status` for `serviceState`, warmup counters, and recent errors.
- Verify Ollama process/model state if `REWRITE_PROVIDER=ollama`.
- Verify `MINIMAX_API_KEY` if `REWRITE_PROVIDER=minimax`.

### T2A failures

- Confirm `MINIMAX_API_KEY` is present.
- Verify `T2A_MINIMAX_API_URL` and `T2A_MINIMAX_MODEL`.
- Check whether caller is requesting unsupported `stream=true`.
- Check client option ranges for `speed`, `volume`, `pitch`, `sample_rate`, `bitrate`, and `format`.

### Auth/proxy failures

- Confirm proxy strips inbound trusted headers.
- Confirm proxy injects `X-Authenticated-Email` and `X-Bridge-Auth` after auth.
- Re-run the manual auth matrix in `docs/runbooks/auth-matrix-manual-cli-checklist.md`.
