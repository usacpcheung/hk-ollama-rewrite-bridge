# Manual CLI Auth Matrix Validation

Use this runbook to verify shared backend auth and reverse-proxy behavior for rewrite, T2A and transcription, including their internal aliases. Transcription is protected even when disabled. The checked-in Apache sample uses OIDC session authentication; a bearer-token gateway requires its own configuration.

These are manual deployment checks, not evidence that a live server has been tested. Prefer an isolated instance with provider mocks for valid rewrite/T2A probes. Real valid requests can incur provider charges. The transcription auth probe below deliberately uses an unsupported request body so it never reaches Google.

## 1) Expected backend behavior

The shared gate checks a trimmed `X-Bridge-Auth` matching the configured secret and a trimmed/lowercased non-empty `X-Authenticated-Email` without commas and with the allowed domain suffix. It does not fully validate email syntax or check the socket address against `BRIDGE_TRUSTED_PROXY_ADDRESSES`. That address setting gates rate-limit identity extraction.

| Scenario | Headers | HTTP / code |
|---|---|---|
| Missing bridge auth | Valid email only | `401 AUTH_REQUIRED` |
| Wrong bridge auth | Wrong secret + valid email | `401 AUTH_REQUIRED` |
| Missing email | Valid secret only | `401 AUTH_REQUIRED` |
| Comma-separated emails | Valid secret + multiple values | `401 AUTH_HEADER_INVALID` |
| Disallowed domain | Valid secret + outside-domain email | `403 FORBIDDEN_DOMAIN` |
| Valid headers | Matching secret + allowed suffix | Passes auth; later validation, provider or capacity errors remain possible |

The global limiter precedes auth on all routes. Rewrite/T2A route limiters also precede auth; enabled transcription's service limiter follows it. Keep test attempts within budgets or wait for their windows so a 429 does not mask the auth result. Loopback binding, gateway authentication and stripping spoofed headers remain part of the deployment boundary.

The shared JSON parser runs even earlier. Use valid JSON in rewrite/T2A auth
probes: malformed JSON returns `400 INVALID_JSON`, and a body above 16 KiB
currently returns `500 INTERNAL_ERROR`, before the auth matrix applies. The
octet-stream transcription probe below avoids the JSON parser.

## 2) Setup

Load the shared secret into an environment variable from your secure operator environment without printing it. Do not paste real secrets/tokens into commands or shell history. Replace the example allowed account/domain to match the deployment.

```bash
export LOCAL_BASE_URL="http://127.0.0.1:3001"
export EXTERNAL_BASE_URL="https://<YOUR_PUBLIC_BRIDGE_HOST>"
export BRIDGE_AUTH_SECRET="<INTERNAL_SHARED_SECRET>"
export TEST_EMAIL="tester@hs.edu.hk"
export REWRITE_PAYLOAD='{"text":"測試文字"}'
export T2A_PAYLOAD='{"text":"測試語音","response_mode":"base64_json"}'

# Choose the authentication method configured by your gateway.
GATEWAY_AUTH_ARGS=(--cookie "/path/to/private-authenticated-cookie-jar")
# For a gateway explicitly configured for bearer tokens, use instead:
# GATEWAY_AUTH_ARGS=(-H "Authorization: Bearer ${OIDC_TOKEN}")
```

## 3) Local helpers

```bash
call_local() {
  local route="$1"
  shift
  case "$route" in
    /rewrite|/api/rewrite)
      curl -sS -i "${LOCAL_BASE_URL}${route}" \
        -H 'Content-Type: application/json' "$@" --data "${REWRITE_PAYLOAD}"
      ;;
    /t2a|/api/t2a)
      curl -sS -i "${LOCAL_BASE_URL}${route}" \
        -H 'Content-Type: application/json' "$@" --data "${T2A_PAYLOAD}"
      ;;
    /transcriptions|/api/transcriptions)
      curl -sS -i "${LOCAL_BASE_URL}${route}" \
        -H 'Content-Type: application/octet-stream' "$@" --data-binary 'auth-only probe'
      ;;
  esac
}
```

## 4) Run each local scenario on all aliases

```bash
for route in /rewrite /api/rewrite /t2a /api/t2a /transcriptions /api/transcriptions; do
  # 401 AUTH_REQUIRED
  call_local "$route" -H "X-Authenticated-Email: ${TEST_EMAIL}"
  call_local "$route" -H 'X-Bridge-Auth: wrong-secret' \
    -H "X-Authenticated-Email: ${TEST_EMAIL}"
  call_local "$route" -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}"

  # 401 AUTH_HEADER_INVALID
  call_local "$route" -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
    -H "X-Authenticated-Email: ${TEST_EMAIL},other@hs.edu.hk"

  # 403 FORBIDDEN_DOMAIN (choose a domain outside your configured allowlist)
  call_local "$route" -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
    -H 'X-Authenticated-Email: tester@example.com'

  # Auth passes; valid rewrite/T2A bodies can call their configured providers.
  call_local "$route" -H "X-Bridge-Auth: ${BRIDGE_AUTH_SECRET}" \
    -H "X-Authenticated-Email: ${TEST_EMAIL}"
done
```

With valid transcription auth, the deliberately unsupported body returns `415 UNSUPPORTED_MEDIA_TYPE` when enabled and available, or `503 TRANSCRIPTION_DISABLED` when disabled. Storage unavailability may also return 503. It must not return an auth-specific 401/403. Use the [transcription deployment runbook](transcription-deployment.md) for an actual multipart success check.

## 5) Gateway and header-hygiene checks

Run on exposed public routes. Include transcription only after its proxy mapping is enabled. The checked-in snippet omits T2A; add its mapping as described in the [deployment guide](../guides/deployment-guide.md) before expecting an external T2A success path.

For each route, make a request without cookies/tokens. A protected interactive OIDC gateway may redirect to login; a configured API token gateway may return 401/403. Do not follow redirects when inspecting this check. The request must not reach a paid provider operation. Repeat with an invalid/expired credential for the gateway's actual authentication mode; do not assume it accepts bearer tokens because an OIDC module is installed.

```bash
curl -sS -i "${EXTERNAL_BASE_URL}/api/rewrite-bridge/rewrite" \
  -H 'Content-Type: application/json' --data "${REWRITE_PAYLOAD}"
curl -sS -i "${EXTERNAL_BASE_URL}/api/rewrite-bridge/t2a" \
  -H 'Content-Type: application/json' --data "${T2A_PAYLOAD}"
curl -sS -i "${EXTERNAL_BASE_URL}/api/rewrite-bridge/transcriptions" \
  -H 'Content-Type: application/octet-stream' --data-binary 'auth-only probe'
```

With an authenticated allowed-domain gateway session, send spoofed trusted headers. The proxy must remove/overwrite them and use its authenticated identity:

```bash
curl -sS -i "${EXTERNAL_BASE_URL}/api/rewrite-bridge/rewrite" \
  "${GATEWAY_AUTH_ARGS[@]}" -H 'Content-Type: application/json' \
  -H 'X-Bridge-Auth: wrong-secret' -H 'X-Authenticated-Email: attacker@example.com' \
  -H 'X-Authenticated-User: attacker' -H 'X-Authenticated-Subject: attacker' \
  --data "${REWRITE_PAYLOAD}"
```

Repeat for T2A with its JSON body and transcription with the unsupported body above. Check deployed forwarding-header stripping (`X-Forwarded-For`, `X-Forwarded-Proto`, `Forwarded`) as well as all four identity/secret headers. The backend's address list alone does not authorize/reject a request.

## 6) Deployment checklist

- [ ] Rewrite local matrix passes on both aliases.
- [ ] T2A local matrix passes on both aliases.
- [ ] Transcription local matrix passes on both aliases, including disabled mode.
- [ ] Unauthenticated and expired-credential requests are stopped at the gateway for every exposed service.
- [ ] Spoofed identity/secret headers do not change the gateway-derived backend identity.
- [ ] Forwarding headers are reconstructed from actual connection metadata.
- [ ] Loopback listener and configured trusted-proxy identity behavior match the deployment.

Investigate mismatches before rollout; do not interpret a gateway redirect, limiter rejection or provider failure as proof that the backend auth case passed.
