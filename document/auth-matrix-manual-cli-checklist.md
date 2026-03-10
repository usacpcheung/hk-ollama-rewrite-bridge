# Manual CLI Auth Matrix Validation (Post-Extraction)

This runbook verifies that the `/rewrite` authentication contract is identical in both request paths after extraction/deployment:

1. **Server-side CLI path** (direct local backend reachability).
2. **External CLI path** (through reverse proxy + OIDC gateway).

Use this before rollout. **If any scenario returns a different status/error contract between the two paths, block rollout immediately.**

---

## 1) Security Notes

- Do **not** paste real secrets/tokens into shell history or docs.
- Use stubs/placeholders in commands below and inject real values via environment variables only.
- The examples below intentionally use placeholders such as `<INTERNAL_SHARED_SECRET>` and `<OIDC_ACCESS_TOKEN>`.

---

## 2) Expected Auth Contract (Baseline)

For `POST /rewrite` with JSON body (`{"text":"測試文字"}`), expected auth outcomes are:

| Scenario | Required headers | Expected HTTP | Expected `error.code` | Expected `error.message` |
|---|---|---:|---|---|
| Missing `X-Bridge-Auth` | `X-Authenticated-Email: tester@hs.edu.hk` only | 401 | `AUTH_REQUIRED` | `Login required` |
| Wrong `X-Bridge-Auth` | `X-Bridge-Auth: wrong-secret`, valid email | 401 | `AUTH_REQUIRED` | `Login required` |
| Missing `X-Authenticated-Email` | valid `X-Bridge-Auth` only | 401 | `AUTH_REQUIRED` | `Login required` |
| Malformed multi-value email | valid secret + `tester@hs.edu.hk,other@hs.edu.hk` | 401 | `AUTH_HEADER_INVALID` | `Invalid authentication header` |
| Non-allowed email domain | valid secret + `tester@example.com` | 403 | `FORBIDDEN_DOMAIN` | `Only hs.edu.hk accounts are allowed` |
| Valid auth headers | valid secret + `tester@hs.edu.hk` | **Not 401/403 due to auth layer** | N/A | N/A |

> Notes:
> - In the valid-auth scenario, downstream provider behavior may still return a non-2xx for non-auth reasons. The auth acceptance check is that it must not fail with the auth-specific 401/403 contracts above.

---

## 3) One-Time Environment Setup

```bash
# Local backend path (direct access)
export LOCAL_BASE_URL="http://127.0.0.1:3001"

# External path (reverse proxy + OIDC protection)
export EXTERNAL_BASE_URL="https://<YOUR_PUBLIC_BRIDGE_HOST>"

# Shared secret configured on backend + trusted proxy
export BRIDGE_AUTH_SECRET="<INTERNAL_SHARED_SECRET>"

# OIDC token for external gateway (obtain via your org flow)
export OIDC_TOKEN="<OIDC_ACCESS_TOKEN>"

# Reusable payload
export REWRITE_PAYLOAD='{"text":"測試文字"}'
```

Optional helper (pretty print if `jq` exists):

```bash
command -v jq >/dev/null && export PRETTY='| jq . || cat' || export PRETTY='| cat'
```

---

## 4) Function Templates (Local vs External)

```bash
call_local() {
  local tag="$1"
  shift
  echo "\n===== LOCAL :: ${tag} ====="
  curl -sS -i -X POST "${LOCAL_BASE_URL}/rewrite" \
    -H 'Content-Type: application/json' \
    "$@" \
    --data "${REWRITE_PAYLOAD}"
}

call_external() {
  local tag="$1"
  shift
  echo "\n===== EXTERNAL :: ${tag} ====="
  curl -sS -i -X POST "${EXTERNAL_BASE_URL}/rewrite" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${OIDC_TOKEN}" \
    "$@" \
    --data "${REWRITE_PAYLOAD}"
}
```

---

## 5) Execute Full Matrix in Both Contexts

Run each scenario twice: once with `call_local`, once with `call_external`.

### A. Missing `X-Bridge-Auth`

```bash
call_local "missing bridge auth" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'

call_external "missing bridge auth" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'
```

Expected for both paths:
- HTTP `401`
- JSON error: `code=AUTH_REQUIRED`, `message=Login required`

### B. Wrong `X-Bridge-Auth`

```bash
call_local "wrong bridge auth" \
  -H 'X-Bridge-Auth: wrong-secret' \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'

call_external "wrong bridge auth" \
  -H 'X-Bridge-Auth: wrong-secret' \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'
```

Expected for both paths:
- HTTP `401`
- JSON error: `code=AUTH_REQUIRED`, `message=Login required`

### C. Missing `X-Authenticated-Email`

```bash
call_local "missing authenticated email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}"

call_external "missing authenticated email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}"
```

Expected for both paths:
- HTTP `401`
- JSON error: `code=AUTH_REQUIRED`, `message=Login required`

### D. Malformed multi-value email

```bash
call_local "malformed multi email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk,other@hs.edu.hk'

call_external "malformed multi email" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk,other@hs.edu.hk'
```

Expected for both paths:
- HTTP `401`
- JSON error: `code=AUTH_HEADER_INVALID`, `message=Invalid authentication header`

### E. Non-allowed email domain

```bash
call_local "forbidden domain" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@example.com'

call_external "forbidden domain" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@example.com'
```

Expected for both paths:
- HTTP `403`
- JSON error: `code=FORBIDDEN_DOMAIN`, `message=Only hs.edu.hk accounts are allowed`

### F. Valid auth headers

```bash
call_local "valid headers" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'

call_external "valid headers" \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk'
```

Expected for both paths:
- Request is accepted by auth layer (must **not** return auth-specific `401/403` contracts above).
- If non-auth failures appear (provider/network), investigate separately but do not classify as auth drift.

---

## 6) OIDC Boundary-Specific Negative Checks (External Path)

These checks ensure the reverse proxy/auth gateway is actually enforcing OIDC.

### G. Missing OIDC bearer token (external only)

```bash
curl -sS -i -X POST "${EXTERNAL_BASE_URL}/rewrite" \
  -H 'Content-Type: application/json' \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk' \
  --data "${REWRITE_PAYLOAD}"
```

Expected:
- Rejected by gateway (commonly `401`/`302` depending on gateway mode).
- Must **not** bypass gateway and reach backend as authenticated traffic.

### H. Invalid/expired OIDC bearer token (external only)

```bash
curl -sS -i -X POST "${EXTERNAL_BASE_URL}/rewrite" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer invalid-or-expired-token' \
  -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
  -H 'X-Authenticated-Email: tester@hs.edu.hk' \
  --data "${REWRITE_PAYLOAD}"
```

Expected:
- Rejected by gateway with unauthorized response.
- Must not be treated as a valid authenticated call.

---

## 7) Drift Detection and Rollout Gate

A rollout **must be blocked** if any of these is true:

- Status code mismatch between local and external for scenarios A–F.
- `error.code` mismatch between local and external for scenarios A–F.
- `error.message` mismatch between local and external for scenarios A–F.
- External OIDC negative checks (G/H) are not rejected at gateway boundary.

Minimal manual gate checklist:

```text
[ ] A–F local results captured
[ ] A–F external results captured
[ ] A–F parity confirmed (status + error.code + error.message)
[ ] G/H rejected by OIDC gateway
[ ] No auth contract drift detected
```

If any item fails: **STOP rollout**, file incident, and compare gateway header forwarding + backend auth configuration before retry.

---

## 8) Suggested Evidence Capture

Store evidence in CI artifact or change ticket:

- Timestamp and environment identifier.
- Sanitized command transcript for A–H.
- Per-scenario decision: `PASS` / `FAIL`.
- Final gate verdict: `ROLL OUT` or `BLOCK`.

