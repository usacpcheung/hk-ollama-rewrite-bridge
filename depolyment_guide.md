# Deployment Guide (hk-ollama-rewrite-bridge)

This guide explains how to deploy the service on a Linux server where **Ollama is already installed and running**.

---

## 1) Prerequisites on deployment server

Assumptions:
- Ollama service is already healthy and reachable at `127.0.0.1:11434`.
- Model is already available, or can be pulled:

```bash
ollama pull qwen2.5:3b-instruct
```

Install system packages (Ubuntu/Debian example):

```bash
sudo apt update
sudo apt install -y git curl apache2 nodejs npm
```

Check Node version (Node 18+ recommended):

```bash
node -v
npm -v
```

---

## 2) Where to clone the repo

Recommended path for this service:

```text
/opt/hk-ollama-rewrite-bridge
```

Create and assign ownership to deploy user (`hsadmin`):

```bash
sudo mkdir -p /opt/hk-ollama-rewrite-bridge
sudo chown -R hsadmin:hsadmin /opt/hk-ollama-rewrite-bridge
```

Clone as `hsadmin`:

```bash
sudo -u hsadmin -H bash -lc '
  cd /opt/hk-ollama-rewrite-bridge && \
  git clone <YOUR_GIT_REPO_URL> .
'
```

> Replace `<YOUR_GIT_REPO_URL>` with your repository URL.

---

## 3) App setup on server

Install dependencies:

```bash
sudo -u hsadmin -H bash -lc '
  cd /opt/hk-ollama-rewrite-bridge && \
  npm ci
'
```

Optional quick local run check:

```bash
sudo -u hsadmin -H bash -lc '
  cd /opt/hk-ollama-rewrite-bridge && \
  npm start
'
```

You should see it listening on:

```text
http://127.0.0.1:3001
```

Stop with `Ctrl+C` after checking.

---

## 4) Configure systemd service

The repo includes `systemd/rewrite-bridge.service`. Copy it into systemd and adjust paths if needed.

If you cloned to `/opt/hk-ollama-rewrite-bridge`, update these 2 fields in the service file:
- `WorkingDirectory=/opt/hk-ollama-rewrite-bridge`
- `ExecStart=/usr/bin/node /opt/hk-ollama-rewrite-bridge/server.js`

Deploy service:

```bash
sudo cp /opt/hk-ollama-rewrite-bridge/systemd/rewrite-bridge.service /etc/systemd/system/rewrite-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable rewrite-bridge
sudo systemctl start rewrite-bridge
```

Check status/logs:

```bash
sudo systemctl status rewrite-bridge --no-pager
sudo journalctl -u rewrite-bridge -f
```

---
### Environment-based tuning (no code changes)

Use either inline `Environment=` entries or an `EnvironmentFile=` to tune runtime knobs.

Example with `EnvironmentFile` (recommended):

1. Create `/etc/default/rewrite-bridge`:

```bash
sudo tee /etc/default/rewrite-bridge >/dev/null <<'ENV'
OLLAMA_KEEP_ALIVE=10m
OLLAMA_TIMEOUT_MS=45000
OLLAMA_COLD_TIMEOUT_MS=180000
WARMUP_PS_CACHE_MS=3000
WARMUP_PS_TIMEOUT_MS=1200
WARMUP_RETRY_AFTER_SEC=3
WARMUP_TRIGGER_TIMEOUT_MS=60000
WARMUP_ON_START=true
WARMUP_STARTUP_MAX_WAIT_MS=180000
WARMUP_STARTUP_RETRY_INTERVAL_MS=5000
ENV
```

2. Add to `/etc/systemd/system/rewrite-bridge.service` under `[Service]`:

```ini
EnvironmentFile=/etc/default/rewrite-bridge
```

Or set directly in unit file:

```ini
Environment=OLLAMA_KEEP_ALIVE=10m
Environment=OLLAMA_TIMEOUT_MS=45000
Environment=OLLAMA_COLD_TIMEOUT_MS=180000
Environment=WARMUP_PS_CACHE_MS=3000
Environment=WARMUP_PS_TIMEOUT_MS=1200
Environment=WARMUP_RETRY_AFTER_SEC=3
Environment=WARMUP_TRIGGER_TIMEOUT_MS=60000
Environment=WARMUP_ON_START=true
Environment=WARMUP_STARTUP_MAX_WAIT_MS=180000
Environment=WARMUP_STARTUP_RETRY_INTERVAL_MS=5000
```

3. Apply changes:

```bash
sudo systemctl daemon-reload
sudo systemctl restart rewrite-bridge
sudo systemctl status rewrite-bridge --no-pager
```

On 4GB VPS hosts, this profile is a good starting point. Tradeoff reminder:
- Longer `OLLAMA_KEEP_ALIVE` improves repeat-request latency.
- Longer keep-alive also increases steady-state RAM usage.
- `OLLAMA_KEEP_ALIVE=10m` is usually a balanced compromise for memory-constrained servers.

## 5) Configure Apache reverse proxy

Enable required Apache modules:

```bash
sudo a2enmod proxy proxy_http headers
sudo systemctl restart apache2
```

Use provided snippet `apache/proxy-snippet.conf`:

```apache
ProxyPass /api/rewrite-bridge/rewrite http://127.0.0.1:3001/rewrite
ProxyPassReverse /api/rewrite-bridge/rewrite http://127.0.0.1:3001/rewrite
ProxyPass /api/rewrite-bridge/model-status http://127.0.0.1:3001/model-status
ProxyPassReverse /api/rewrite-bridge/model-status http://127.0.0.1:3001/model-status

# Temporary legacy compatibility alias (deprecated; remove in next breaking-release window)
ProxyPass /api/rewrite http://127.0.0.1:3001/rewrite
ProxyPassReverse /api/rewrite http://127.0.0.1:3001/rewrite
```

Public clients should call the namespaced routes (`/api/rewrite-bridge/*`).
The bridge process itself still listens only on local internal routes (`/rewrite`, `/model-status`) at `127.0.0.1:3001`.

Add these lines inside your active VirtualHost (`:80` or `:443`) and reload Apache:

```bash
sudo apachectl configtest
sudo systemctl reload apache2
```

---


### Warm-up response behavior

When startup warm-up is running, `POST /api/rewrite-bridge/rewrite` returns `202` with warm-up codes. If startup budget is exceeded, API returns `503` with `MODEL_STARTUP_DEGRADED`. Clients should respect `Retry-After` and poll `/api/rewrite-bridge/model-status` every 2–3 seconds.

## 6) How to test on the server (direct app port)

Test direct service locally:

```bash
curl -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"佢啱啱先返到公司，等多陣。"}'
```

Expected shape:

```json
{"ok":true,"result":"..."}
```

Validation tests:

```bash
# Missing text
curl -i -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d '{}'

# Too long (example >200 chars)
LONG=$(head -c 201 < /dev/zero | tr '\0' 'a')
curl -i -sS http://127.0.0.1:3001/rewrite \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"$LONG\"}"
```

You should get:
- `400` for missing text
- `413` with `{"ok":false,"error":{"code":"TOO_LONG","message":"Max 200 characters"}}` for oversized input.

---

## 7) How to test from outside (through Apache reverse proxy)

Assume your domain is `rewrite.example.com`.

From any external machine:

```bash
curl -sS https://rewrite.example.com/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"你今日得唔得閒？"}'
```

Or with HTTP (if no TLS yet):

```bash
curl -sS http://rewrite.example.com/api/rewrite-bridge/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"你今日得唔得閒？"}'
```

Check namespaced status endpoint:

```bash
curl -sS https://rewrite.example.com/api/rewrite-bridge/model-status
```

If external test fails, check in this order:
1. `sudo systemctl status rewrite-bridge`
2. `curl http://127.0.0.1:3001/rewrite ...` on server
3. `sudo apachectl configtest`
4. `sudo journalctl -u rewrite-bridge -n 100 --no-pager`
5. Apache logs (`/var/log/apache2/error.log`, access log)
6. Firewall/security-group allows incoming 80/443

---

## 8) Updating to newer code

```bash
sudo -u hsadmin -H bash -lc '
  cd /opt/hk-ollama-rewrite-bridge && \
  git pull && \
  npm ci
'
sudo systemctl restart rewrite-bridge
```

---

## 9) Notes for production hardening

- Keep service bound to loopback (`127.0.0.1:3001`) and expose only Apache.
- Use HTTPS (Let’s Encrypt / certbot) at Apache layer.
- Consider log rotation/centralization for systemd and Apache logs.
- Monitor response times and timeout rates (`TIMEOUT` errors).
- **Large models may need higher cold timeout**: raise `OLLAMA_COLD_TIMEOUT_MS` (e.g. `120000-300000`) to avoid premature warming failures.
- **Keep-alive vs memory tradeoff**: higher `OLLAMA_KEEP_ALIVE` improves latency for subsequent requests but keeps model memory resident longer.


## 10) Operator validation checklist

```bash
# Startup loop attempts and transition
sudo systemctl restart rewrite-bridge
sudo journalctl -u rewrite-bridge -f

# serviceState should move starting -> ready (or degraded)
watch -n 2 "curl -sS http://127.0.0.1:3001/model-status"

# /rewrite returns 202 during startup, then 200 after ready
curl -i -sS http://127.0.0.1:3001/rewrite -H 'Content-Type: application/json' -d '{"text":"你今日得唔得閒？"}'

# Check no repeated concurrent warm-up attempts
sudo journalctl -u rewrite-bridge -n 300 --no-pager | rg 'Startup warmup attempt completed|warmupInFlight|MODEL_WARMUP_STARTED'
```
