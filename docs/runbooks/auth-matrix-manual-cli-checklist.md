# Manual CLI Auth Matrix Validation (Post-Extraction)

This runbook verifies backend auth behavior and reverse-proxy hardening for **both protected routes**:

1. `POST /rewrite`
2. `POST /t2a`

Use this before rollout. Block rollout if local backend auth expectations fail, if hardened external behavior is not observed, or if gateway/OIDC controls are bypassed.

## 1) Security notes

- Do not paste real secrets or tokens into shell history.
- Use environment variables and placeholders only.
- The examples below intentionally use placeholders such as `<INTERNAL_SHARED_SECRET>` and `<OIDC_ACCESS_TOKEN>`.

## 2) Expected auth contract baseline

Protected local backend requests require:

- valid `X-Bridge-Auth`
- valid `X-Authenticated-Email`

The same auth envelope applies to both `/rewrite` and `/t2a`.

| Scenario | Required headers | Expected HTTP | Expected `error.code` |
|---|---|---:|---|
| Missing `X-Bridge-Auth` | valid email only | 401 | `AUTH_REQUIRED` |
| Wrong `X-Bridge-Auth` | wrong secret + valid email | 401 | `AUTH_REQUIRED` |
| Missing `X-Authenticated-Email` | valid secret only | 401 | `AUTH_REQUIRED` |
| Malformed multi-value email | valid secret + comma-separated values | 401 | `AUTH_HEADER_INVALID` |
| Non-allowed email domain | valid secret + non-`hs.edu.hk` email | 403 | `FORBIDDEN_DOMAIN` |
| Valid auth headers | valid secret + `@hs.edu.hk` email | not blocked by auth layer | N/A |

## 3) One-time environment setup

```bash
export LOCAL_BASE_URL="http://127.0.0.1:3001"
export EXTERNAL_BASE_URL="https://<YOUR_PUBLIC_BRIDGE_HOST>"
export BRIDGE_AUTH_SECRET="<INTERNAL_SHARED_SECRET>"
export OIDC_TOKEN="<OIDC_ACCESS_TOKEN>"

export REWRITE_PAYLOAD='{"text":"測試文字"}'
export T2A_PAYLOAD='{"text":"測試語音","response_mode":"base64_json"}'
```

## 4) Helper functions

```bash
call_local_rewrite() {
  local tag="$1"
  shift
  echo "\n===== LOCAL REWRITE :: ${tag} ====="
  curl -sS -i -X POST "${LOCAL_BASE_URL}/rewrite" \
    -H 'Content-Type: application/json' \
    "$@" \
    --data "${REWRITE_PAYLOAD}"
}

call_local_t2a() {
  local tag="$1"
  shift
  echo "\n===== LOCAL T2A :: ${tag} ====="
  curl -sS -i -X POST "${LOCAL_BASE_URL}/t2a" \
    -H 'Content-Type: application/json' \
    "$@" \
    --data "${T2A_PAYLOAD}"
}

call_external_rewrite() {
  local tag="$1"
  shift
  echo "\n===== EXTERNAL REWRITE :: ${tag} ====="
  curl -sS -i -X POST "${EXTERNAL_BASE_URL}/api/rewrite-bridge/rewrite" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${OIDC_TOKEN}" \
    "$@" \
    --data "${REWRITE_PAYLOAD}"
}

call_external_t2a() {
  local tag="$1"
  shift
  echo "\n===== EXTERNAL T2A :: ${tag} ====="
  curl -sS -i -X POST "${EXTERNAL_BASE_URL}/api/rewrite-bridge/t2a" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${OIDC_TOKEN}" \
    "$@" \
    --data "${T2A_PAYLOAD}"
}
```

## 5) Local backend auth matrix

Run the same matrix against both services.

### A. Missing `X-Bridge-Auth`

```bash
call_local_rewrite "missing bridge auth" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'

call_local_t2a "missing bridge auth" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'
```

Expected: `401 AUTH_REQUIRED`

### B. Wrong `X-Bridge-Auth`

```bash
call_local_rewrite "wrong bridge auth" \
  -H 'X-Bridge-Auth: wrong-secret' \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'

call_local_t2a "wrong bridge auth" \
  -H 'X-Bridge-Auth: wrong-secret' \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'
```

Expected: `401 AUTH_REQUIRED`

### C. Missing `X-Authenticated-Email`

```bash
call_local_rewrite "missing authenticated email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}"

call_local_t2a "missing authenticated email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}"
```

Expected: `401 AUTH_REQUIRED`

### D. Malformed multi-value email

```bash
call_local_rewrite "malformed multi email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk,other@hs.edu.hk'

call_local_t2a "malformed multi email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk,other@hs.edu.hk'
```

Expected: `401 AUTH_HEADER_INVALID`

### E. Non-allowed email domain

```bash
call_local_rewrite "forbidden domain" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@example.com'

call_local_t2a "forbidden domain" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@example.com'
```

Expected: `403 FORBIDDEN_DOMAIN`

### F. Valid auth headers

```bash
call_local_rewrite "valid headers" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'

call_local_t2a "valid headers" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'
```

Expected:
- request is accepted by the auth layer
- downstream provider errors are possible, but auth-specific `401/403` results above must not occur

## 6) External OIDC + proxy-hardening checks

### G. Missing OIDC bearer token

```bash
curl -sS -i -X POST "${EXTERNAL_BASE_URL}/api/rewrite-bridge/rewrite" \
  -H 'Content-Type: application/json' \
  --data "${REWRITE_PAYLOAD}"

curl -sS -i -X POST "${EXTERNAL_BASE_URL}/api/rewrite-bridge/t2a" \
  -H 'Content-Type: application/json' \
  --data "${T2A_PAYLOAD}"
```

Expected: rejected by the gateway.

### H. Invalid or expired OIDC token

```bash
curl -sS -i -X POST "${EXTERNAL_BASE_URL}/api/rewrite-bridge/rewrite" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer invalid-or-expired-token' \
  --data "${REWRITE_PAYLOAD}"

curl -sS -i -X POST "${EXTERNAL_BASE_URL}/api/rewrite-bridge/t2a" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer invalid-or-expired-token' \
  --data "${T2A_PAYLOAD}"
```

Expected: rejected by the gateway.

### I. Spoofed trusted headers must not influence external outcome

```bash
call_external_rewrite "spoofed trusted headers" \
  -H 'X-Bridge-Auth: wrong-secret' \
  -H 'X-Authenticated-Email: attacker@example.com'

call_external_t2a "spoofed trusted headers" \
  -H 'X-Bridge-Auth: wrong-secret' \
  -H 'X-Authenticated-Email: attacker@example.com'
```

Expected:
- proxy strips or overwrites caller-supplied trusted headers
- result must reflect gateway-injected trusted identity, not spoofed inbound values

## 7) Rollout gate

Block rollout if any of the following is true:

- any local backend scenario fails the documented auth contract
- external no-token or invalid-token calls are not rejected at the gateway boundary
- spoofed trusted headers affect backend auth decisions

Minimal checklist:

```text
[ ] Rewrite local auth matrix passed
[ ] T2A local auth matrix passed
[ ] Rewrite external gateway checks passed
[ ] T2A external gateway checks passed
[ ] Spoofed trusted headers are neutralized by proxy
```
