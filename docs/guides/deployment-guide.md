# Deployment Guide (hk-ollama-rewrite-bridge)

This guide documents deployment for the two JSON services:

- **Rewrite** via `POST /rewrite`
- **T2A** via `POST /t2a`

It covers provider selection, environment configuration, reverse-proxy setup, and post-deploy validation. The opt-in transcription backend is also implemented; use the separate [transcription runbook](../runbooks/transcription-deployment.md) for media tools, Google credentials and upload proxy settings. These are repository examples, not a record of the live deployment.

## 1) Prerequisites

- Linux host with systemd
- Node.js 22+ (CI tests Node 22 and 24)
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

Confirm `node -v` is at least 22; distro packages may be older. Use a supported Node release before installing dependencies.

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
npm ci --ignore-scripts
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
REWRITE_MINIMAX_API_FORMAT=legacy-chat
REWRITE_MINIMAX_API_URL=https://api.minimax.io/v1/text/chatcompletion_v2
REWRITE_MINIMAX_MODEL=M2-her
MINIMAX_API_KEY=<SECRET>
```

#### Opt-in rewrite with MiniMax M3

```env
REWRITE_PROVIDER=minimax
REWRITE_MINIMAX_API_FORMAT=anthropic
REWRITE_MINIMAX_ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
REWRITE_MINIMAX_MODEL=MiniMax-M3
MINIMAX_API_KEY=<SECRET>
```

Deploy M3 support first while retaining the legacy production values. Test M3
on staging or a separate instance before switching traffic. No caller API
change is required. The Anthropic SDK appends `/v1/messages`, so do not include
that suffix in `REWRITE_MINIMAX_ANTHROPIC_BASE_URL`.

### T2A service

`T2A_PROVIDER=minimax` is the only supported T2A selection. Unsupported explicit selections return `501 UNSUPPORTED_PROVIDER` on requests without falling back to MiniMax. They do not fail rewrite startup or make `/readyz` test T2A.

Recommended T2A settings:

```env
T2A_PROVIDER=minimax
T2A_MINIMAX_API_URL=https://api.minimax.io/v1/t2a_v2
T2A_MINIMAX_MODEL=speech-2.6-hd
T2A_MINIMAX_VOICE_ID="Cantonese_ProfessionalHost（F)"
T2A_MINIMAX_SPEED=1
T2A_MINIMAX_VOLUME=1
T2A_MINIMAX_PITCH=0
T2A_INVOKE_TIMEOUT_MS=30000
MINIMAX_API_KEY=<SECRET>
```

If `MINIMAX_API_KEY` is missing, Minimax-backed traffic cannot succeed and readiness can report `MINIMAX_API_KEY_MISSING` on Minimax rewrite paths.

To roll rewrite back from M3, restore:

```env
REWRITE_MINIMAX_API_FORMAT=legacy-chat
REWRITE_MINIMAX_API_URL=https://api.minimax.io/v1/text/chatcompletion_v2
REWRITE_MINIMAX_MODEL=M2-her
```

Then restart the bridge. Downstream applications do not need to be redeployed.

## 4) Example production env file

Example `/etc/default/rewrite-bridge`:

```env
REWRITE_PROVIDER=ollama
REWRITE_OLLAMA_MODEL=qwen2.5:3b-instruct
REWRITE_OLLAMA_URL=http://127.0.0.1:11434/api/generate
REWRITE_OLLAMA_PS_URL=http://127.0.0.1:11434/api/ps
REWRITE_MAX_TEXT_LENGTH=200
REWRITE_MAX_COMPLETION_TOKENS=300

T2A_PROVIDER=minimax
T2A_MINIMAX_API_URL=https://api.minimax.io/v1/t2a_v2
T2A_MINIMAX_MODEL=speech-2.6-hd
T2A_MINIMAX_VOICE_ID="Cantonese_ProfessionalHost（F)"
T2A_MAX_TEXT_LENGTH=200
T2A_INVOKE_TIMEOUT_MS=30000

MINIMAX_API_KEY=<SECRET>
BRIDGE_INTERNAL_AUTH_SECRET=<SECRET>
BRIDGE_EXPRESS_TRUST_PROXY=loopback
BRIDGE_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1
```

### Worksheet rewrite profile

For a record → transcribe → rewrite → student edit workflow, use these
explicit overrides in the existing bridge environment file:

```env
REWRITE_MAX_TEXT_LENGTH=2000
REWRITE_MAX_COMPLETION_TOKENS=4096
```

The code permits an input setting up to 4,000 Unicode characters, but the profile
above accepts only 2,000. Existing defaults remain 200 characters and 300 output
tokens. A larger output allowance is a maximum, not a requested answer length.
If later accepting 4,000 characters, test with an 8,192-token output allowance;
tokenization varies, so neither pairing guarantees a complete answer.

The incoming JSON body still has a separate 16 KiB limit, including JSON syntax
and escaped characters. Prefer normal UTF-8 JSON rather than escaping every
Chinese character. The system prompt is added on the server and does not count
toward this incoming body limit. Align the worksheet/widget character limit with
the configured backend limit before exposing longer input to students.

Validate long mixed-language answers for preserved meaning, completion, latency
and actual token usage before rollout. Keep the original transcript available
if rewriting fails or is incomplete. This profile does not enable transcription;
enable the implemented Google backend separately using the [transcription runbook](../runbooks/transcription-deployment.md). The recording UI is outside this repository.

## 5) Environment reference

The canonical environment reference is [environment settings](../reference/env-reference.md).

Use canonical names from that document for new deployments. Deprecated aliases
remain supported and emit startup warnings when used. The code defines no
removal date or release window; retirement needs a separate migration decision.

## 6) systemd setup

Inspect `systemd/rewrite-bridge.service` before copying it: the checked-in example uses `User=hsadmin` and `/workspace/hk-ollama-rewrite-bridge` for `WorkingDirectory` and `ExecStart`. For the `/opt` installation above, edit the installed unit to the actual service account and paths. The repository template does not include FFmpeg sandbox access, `UMask=0077` or a transcription runtime directory; those are covered by the transcription runbook.

```bash
sudo cp /opt/hk-ollama-rewrite-bridge/systemd/rewrite-bridge.service /etc/systemd/system/rewrite-bridge.service
sudoedit /etc/systemd/system/rewrite-bridge.service
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

Use `apache/proxy-snippet.conf` as the baseline and inspect it before installation. It maps rewrite and ops routes and comments out transcription; it currently omits T2A. Add the T2A mapping below to the deployed vhost. It also retains the protected legacy `/api/rewrite` public alias.

The sample uses interactive `AuthType openid-connect`; the public curl examples use an authenticated session cookie jar. Bearer-token acceptance depends on separate gateway configuration.

Important hardening rules:

- Strip inbound trusted headers from callers.
- Inject trusted headers only after successful OIDC/auth.
- Keep backend on loopback only.
- Protect rewrite, T2A and enabled transcription when exposed publicly. The baseline protects the entire `/api/rewrite-bridge` namespace, including model status and health.
- Strip caller-supplied `X-Forwarded-For`, `X-Forwarded-Proto` and `Forwarded` before forwarding so client-IP fallback uses the actual connection.
- The backend has no OIDC flow or proxy-source authorization check; the trusted address setting controls limiter identity.

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

RequestHeader unset X-Forwarded-For
RequestHeader unset X-Forwarded-Proto
RequestHeader unset Forwarded
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
- `readyz` may return `503` during rewrite startup warmup or MiniMax recent-failure/missing-key states. It checks rewrite only; it does not verify T2A or Google.
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
- Re-run the [manual auth matrix](../runbooks/auth-matrix-manual-cli-checklist.md).
