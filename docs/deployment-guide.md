# Deployment Guide (hk-ollama-rewrite-bridge)

This guide documents production deployment for the rewrite bridge, including **provider selection** (`ollama` or `minimax`), startup behavior, readiness semantics, and reverse-proxy setup.

## 1) Prerequisites

- Linux host with systemd.
- Node.js 18+.
- This app bound locally on `127.0.0.1:3001`.
- Choose one backend provider:
  - **Ollama**: local Ollama API reachable (default `127.0.0.1:11434`).
  - **Minimax**: outbound internet access + valid `MINIMAX_API_KEY`.

Ubuntu/Debian bootstrap:

```bash
sudo apt update
sudo apt install -y git curl nodejs npm apache2
node -v
npm -v
```

---

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

Optional local sanity run:

```bash
npm start
# listen: http://127.0.0.1:3001
```

---

## 3) Provider selection and required settings

The runtime provider is chosen by `REWRITE_PROVIDER`.

- `REWRITE_PROVIDER=ollama` (default)
- `REWRITE_PROVIDER=minimax`

If an unsupported provider name is set, process startup fails immediately (`Unsupported provider: <name>`), so ensure this value is valid before restart.

### 3.1 Ollama mode

Minimum required:

- Ollama service running.
- Model available in Ollama (default `qwen2.5:3b-instruct`).

Useful settings:

```env
REWRITE_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434/api/generate
OLLAMA_PS_URL=http://127.0.0.1:11434/api/ps
OLLAMA_MODEL=qwen2.5:3b-instruct
OLLAMA_KEEP_ALIVE=30m
```

### 3.2 Minimax mode

Minimum required:

- Valid API key (`MINIMAX_API_KEY`).

Useful settings:

```env
REWRITE_PROVIDER=minimax
MINIMAX_API_URL=https://api.minimax.io/v1/text/chatcompletion_v2
MINIMAX_MODEL=M2-her
MINIMAX_API_KEY=<SECRET>
```

If key is missing, readiness returns non-ready with reason `MINIMAX_API_KEY_MISSING`, and rewrite requests stay unavailable except fail-open behavior on specific passive-readiness paths.

---

## 4) Full environment variable reference

### Core

| Variable | Default | Purpose |
|---|---|---|
| `REWRITE_PROVIDER` | `ollama` | Backend provider (`ollama` or `minimax`). |
| `REWRITE_MAX_TEXT_LENGTH` | `200` | Max accepted rewrite input length (allowed 1-600; invalid values fallback to default). |

### Ollama request/warmup

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama generate endpoint. |
| `OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Ollama process/model readiness endpoint. |
| `OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Model name to use. |
| `OLLAMA_KEEP_ALIVE` | `30m` | Keep model in memory. |
| `OLLAMA_TIMEOUT_MS` | `30000` | Request timeout when already `ready`. |
| `OLLAMA_COLD_TIMEOUT_MS` | `120000` | Cold/warming request timeout. |
| `OLLAMA_PS_CACHE_MS` | `2000` | Probe cache window. |
| `OLLAMA_PS_TIMEOUT_MS` | `1000` | Timeout per readiness probe call. |
| `WARMUP_PS_CACHE_MS` | alias fallback | Legacy alias fallback for `OLLAMA_PS_CACHE_MS`. |
| `WARMUP_PS_TIMEOUT_MS` | alias fallback | Legacy alias fallback for `OLLAMA_PS_TIMEOUT_MS`. |
| `READY_REWRITE_STRICT_PROBE_MAX_AGE_MS` | `min(1000, OLLAMA_PS_CACHE_MS)` | Maximum staleness of probe before strict re-check on rewrite. |

### Startup/warmup lifecycle

| Variable | Default | Purpose |
|---|---|---|
| `WARMUP_TRIGGER_TIMEOUT_MS` | `60000` | Timeout for warmup trigger requests. |
| `WARMUP_RETRIGGER_WINDOW_MS` | `10000` | Prevents duplicate warmup triggers within this window. |
| `WARMUP_ON_START` | `true` | Run startup warmup loop at boot. |
| `WARMUP_STARTUP_MAX_WAIT_MS` | `180000` | Startup wait budget before entering `degraded`. |
| `WARMUP_STARTUP_RETRY_INTERVAL_MS` | `5000` | Delay between startup warmup attempts. |
| `WARMUP_RETRY_AFTER_SEC` | auto (2-3) | Retry-After for warming responses. |

### Minimax readiness resilience

| Variable | Default | Purpose |
|---|---|---|
| `MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Minimax endpoint. |
| `MINIMAX_MODEL` | `M2-her` | Minimax model. |
| `MINIMAX_API_KEY` | empty | Minimax API key. |
| `MINIMAX_READINESS_TIMEOUT_MS` | `5000` | Timeout for explicit Minimax readiness check helper. |
| `MINIMAX_PASSIVE_READY_GRACE_MS` | `600000` | Failure staleness window for passive readiness. |
| `MINIMAX_FAIL_OPEN_ON_IDLE` | `true` | Allows readiness to stay green when idle. |
| `MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD` | `3` | Failures needed before strict non-ready behavior. |
| `MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS` | `15000` | Cooldown between bounded Minimax recovery attempts (`429` during cooldown). |

---

## 5) systemd setup

Use `systemd/rewrite-bridge.service` and ensure paths match your install location.

Example `/etc/default/rewrite-bridge`:

```bash
sudo tee /etc/default/rewrite-bridge >/dev/null <<'ENV'
REWRITE_PROVIDER=ollama
OLLAMA_KEEP_ALIVE=10m
OLLAMA_COLD_TIMEOUT_MS=180000
WARMUP_ON_START=true
WARMUP_STARTUP_MAX_WAIT_MS=180000
WARMUP_STARTUP_RETRY_INTERVAL_MS=5000
ENV
```

The shipped unit already loads `/etc/default/rewrite-bridge` by default (optional if missing). Confirm this line exists under `[Service]`:

```ini
EnvironmentFile=-/etc/default/rewrite-bridge
```

Enable and start:

```bash
sudo cp /opt/hk-ollama-rewrite-bridge/systemd/rewrite-bridge.service /etc/systemd/system/rewrite-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable rewrite-bridge
sudo systemctl restart rewrite-bridge
sudo systemctl status rewrite-bridge --no-pager
```

---

## 6) Apache reverse proxy

Enable modules:

```bash
sudo a2enmod proxy proxy_http headers auth_openidc
sudo systemctl restart apache2
```

OIDC integration is required when exposing API on `:443` and enforcing access control.

- `server.js` validates `X-Authenticated-Email` before allowing rewrite calls.
- Apache must inject a trusted OIDC email claim into this header.
- The backend hard-codes `@hs.edu.hk` domain allow-listing.

Use `apache/proxy-snippet.conf` as the base, and replace all sensitive placeholders:

- `OIDCProviderMetadataURL`
- `OIDCClientID`
- `OIDCClientSecret`
- `OIDCRedirectURI`
- `OIDCCryptoPassphrase`

Minimum required header handling (must be present in your active VirtualHost):

- Unset inbound `X-Authenticated-Email` and `X-Bridge-Auth` from clients.
- Set trusted `X-Authenticated-Email` from OIDC claim mapping.
- Set trusted `X-Bridge-Auth` to the same shared secret value as backend `BRIDGE_INTERNAL_AUTH_SECRET`.

Map canonical public namespace `/api/rewrite-bridge/*` to internal routes:

```apache
ProxyPass /api/rewrite-bridge/rewrite http://127.0.0.1:3001/rewrite
ProxyPassReverse /api/rewrite-bridge/rewrite http://127.0.0.1:3001/rewrite
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
RequestHeader unset X-Bridge-Auth
RequestHeader set X-Authenticated-Email "%{OIDC_CLAIM_email}e" env=OIDC_CLAIM_email
RequestHeader set X-Bridge-Auth "<REPLACE_WITH_STRONG_SHARED_SECRET>"
```

Optional legacy compatibility alias:

```apache
ProxyPass /api/rewrite http://127.0.0.1:3001/rewrite
ProxyPassReverse /api/rewrite http://127.0.0.1:3001/rewrite
```

Validate and reload:

```bash
sudo apachectl configtest
sudo systemctl reload apache2
```

---

## 7) Post-deploy verification

```bash
curl -i -sS http://127.0.0.1:3001/healthz
curl -i -sS http://127.0.0.1:3001/readyz
curl -sS http://127.0.0.1:3001/model-status | jq
curl -i -sS http://127.0.0.1:3001/rewrite -H 'Content-Type: application/json' -d '{"text":"你今日得唔得閒？"}'
```

Expected behavior:

- `healthz` returns `200 {"ok":true}` while process is up.
- `readyz` can return `503` during warmup/startup.
- `rewrite` may return `202` while warming, `200` when ready.
- In Minimax fail-closed recovery windows, `rewrite` may return `429 MINIMAX_RECOVERY_COOLDOWN` with `Retry-After`.

---

## 8) Troubleshooting checklist

```bash
sudo systemctl status rewrite-bridge --no-pager
sudo journalctl -u rewrite-bridge -n 200 --no-pager
curl -sS http://127.0.0.1:3001/model-status | jq
```

Common causes:

- Wrong `REWRITE_PROVIDER` value -> process fails at startup.
- Minimax mode without `MINIMAX_API_KEY` -> readiness remains non-ready.
- Ollama unavailable or model not loaded -> prolonged warming / degraded startup.
- Too-aggressive timeout values on small VPS -> frequent timeout or warmup failures.

For auth boundary verification after deployment, use `docs/runbooks/auth-matrix-manual-cli-checklist.md`.
