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

## 5) Configure Apache reverse proxy

Enable required Apache modules:

```bash
sudo a2enmod proxy proxy_http headers
sudo systemctl restart apache2
```

Use provided snippet `apache/proxy-snippet.conf`:

```apache
ProxyPass /api/rewrite http://127.0.0.1:3001/rewrite
ProxyPassReverse /api/rewrite http://127.0.0.1:3001/rewrite
```

Add these lines inside your active VirtualHost (`:80` or `:443`) and reload Apache:

```bash
sudo apachectl configtest
sudo systemctl reload apache2
```

---

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
curl -sS https://rewrite.example.com/api/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"你今日得唔得閒？"}'
```

Or with HTTP (if no TLS yet):

```bash
curl -sS http://rewrite.example.com/api/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"text":"你今日得唔得閒？"}'
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
