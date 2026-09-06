# Environment Reference

This is the canonical reference for supported environment variables. New
configuration should use the canonical names below. Deprecated aliases are kept
for one compatibility window and emit startup warnings when used.

## Naming Model

Use the most specific stable scope:

| Scope | Pattern | Example |
|---|---|---|
| Bridge-wide | `BRIDGE_<SETTING>` | `BRIDGE_INTERNAL_AUTH_SECRET` |
| Service | `<SERVICE>_<SETTING>` | `REWRITE_MAX_TEXT_LENGTH` |
| Service provider | `<SERVICE>_<PROVIDER>_<SETTING>` | `REWRITE_MINIMAX_MODEL` |
| Lifecycle | `<SERVICE>_<PROVIDER>_<LIFECYCLE>_<SETTING>` | `REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD` |

Legacy fallback is allowed for old variable names only. Provider identity must
not silently fall back to another provider.

## Bridge And Auth

| Variable | Default | Meaning |
|---|---:|---|
| `BRIDGE_INTERNAL_AUTH_SECRET` | empty | Shared secret expected in `X-Bridge-Auth` for protected routes. |
| `BRIDGE_AUTH_ALLOWED_EMAIL_DOMAIN` | `@hs.edu.hk` | Required suffix for `X-Authenticated-Email`. |
| `BRIDGE_TRUSTED_PROXY_ADDRESSES` | `127.0.0.1,::1` | Proxy source addresses allowed to forward trusted identity headers. |
| `BRIDGE_EXPRESS_TRUST_PROXY` | `loopback` | Express `trust proxy` setting for client IP derivation. Accepts `false`, `loopback`, or hop count. |
| `BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT` | `false` | Enables provider raw/debug logging with sensitive fields redacted. |
| `MINIMAX_API_KEY` | empty | Shared Minimax API key used by Minimax-backed rewrite and T2A paths. |

## Rewrite Service

| Variable | Default | Meaning |
|---|---:|---|
| `REWRITE_PROVIDER` | `ollama` | Rewrite backend provider. Supported today: `ollama`, `minimax`. |
| `REWRITE_MAX_TEXT_LENGTH` | `200` | Max accepted rewrite input length in Unicode characters; range 1–4,000. Worksheet starting profile: 2,000. |
| `REWRITE_MAX_COMPLETION_TOKENS` | `300` | Completion-token budget sent to rewrite providers; range 1–8,192. Worksheet starting profile: 4,096. Tokens are not characters. |
| `REWRITE_READY_INVOKE_TIMEOUT_MS` | `30000` | Provider invocation timeout when rewrite is considered ready. |
| `REWRITE_COLD_INVOKE_TIMEOUT_MS` | `120000` | Provider invocation timeout during cold/warming rewrite phases. |
| `REWRITE_STREAMING_ENABLED` | `false` | Service-level rewrite streaming toggle. |
| `REWRITE_PROVIDER_STREAMING_ENABLED` | `false` | Alternate service-level rewrite streaming toggle. |
| `REWRITE_<PROVIDER>_STREAMING_ENABLED` | `false` | Provider-specific rewrite streaming toggle, for example `REWRITE_MINIMAX_STREAMING_ENABLED`. |

## Rewrite Ollama Provider

| Variable | Default | Meaning |
|---|---:|---|
| `REWRITE_OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Ollama model for rewrite. |
| `REWRITE_PROVIDER_OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Alternate Ollama model key. |
| `REWRITE_OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama generate endpoint. |
| `REWRITE_PROVIDER_OLLAMA_URL` | same | Alternate Ollama generate endpoint key. |
| `REWRITE_OLLAMA_PS_URL` | `http://127.0.0.1:11434/api/ps` | Ollama readiness endpoint. |
| `REWRITE_PROVIDER_OLLAMA_PS_URL` | same | Alternate Ollama readiness endpoint key. |
| `REWRITE_OLLAMA_READINESS_CACHE_MS` | `2000` | Cache duration for Ollama active readiness probes. |
| `REWRITE_OLLAMA_READINESS_TIMEOUT_MS` | `1000` | Timeout for Ollama active readiness probes. |
| `REWRITE_OLLAMA_WARMUP_TRIGGER_TIMEOUT_MS` | `60000` | Timeout for Ollama warmup trigger calls. |
| `REWRITE_OLLAMA_WARMUP_RETRIGGER_WINDOW_MS` | `10000` | Minimum window before retriggering Ollama warmup. |
| `OLLAMA_KEEP_ALIVE` | `30m` | Ollama keep-alive option sent on generate calls. |

## Rewrite Minimax Provider And Passive Lifecycle

| Variable | Default | Meaning |
|---|---:|---|
| `REWRITE_MINIMAX_MODEL` | `M2-her` | Minimax model for rewrite. |
| `REWRITE_PROVIDER_MINIMAX_MODEL` | `M2-her` | Alternate Minimax rewrite model key. |
| `REWRITE_MINIMAX_API_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | Minimax rewrite endpoint. |
| `REWRITE_PROVIDER_MINIMAX_API_URL` | same | Alternate Minimax rewrite endpoint key. |
| `REWRITE_MINIMAX_API_FORMAT` | `legacy-chat` | Minimax rewrite protocol. Supported: `legacy-chat`, `anthropic`. |
| `REWRITE_PROVIDER_MINIMAX_API_FORMAT` | `legacy-chat` | Alternate Minimax rewrite protocol key. |
| `REWRITE_MINIMAX_ANTHROPIC_BASE_URL` | `https://api.minimax.io/anthropic` | Base URL for the Anthropic SDK; the SDK appends `/v1/messages`. |
| `REWRITE_PROVIDER_MINIMAX_ANTHROPIC_BASE_URL` | same | Alternate Anthropic base URL key. |
| `REWRITE_MINIMAX_PASSIVE_READY_GRACE_MS` | `600000` | Grace window used by passive Minimax rewrite readiness state. |
| `REWRITE_MINIMAX_PASSIVE_FAIL_OPEN_ON_IDLE` | `true` | Allows passive readiness to recover after stale failures without paid probes. |
| `REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD` | `3` | Consecutive rewrite failures before passive readiness reports recent failures. |
| `REWRITE_MINIMAX_PASSIVE_RECOVERY_COOLDOWN_MS` | `15000` | Cooldown between recovery attempts after passive recent failures. |

Minimax rewrite readiness is passive. The bridge does not send synthetic paid
readiness or warmup requests to Minimax.

For opt-in MiniMax M3 rewrite:

```env
REWRITE_PROVIDER=minimax
REWRITE_MINIMAX_API_FORMAT=anthropic
REWRITE_MINIMAX_ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
REWRITE_MINIMAX_MODEL=MiniMax-M3
```

The legacy model, endpoint, and protocol remain the defaults. API format is
never inferred from the model name. M3 thinking is explicitly disabled by the
rewrite transport and is not configurable.

## T2A Service And Minimax Provider

T2A is structured as a service runtime, but only Minimax-compatible T2A is
implemented today. `T2A_PROVIDER` is an official selector with `minimax` as the
only supported value. Unknown explicit values fail with controlled
`UNSUPPORTED_PROVIDER` responses and do not call Minimax.

| Variable | Default | Meaning |
|---|---:|---|
| `T2A_PROVIDER` | `minimax` | T2A provider selector. Supported today: `minimax`. |
| `T2A_MAX_TEXT_LENGTH` | `200` | Max accepted T2A input length in Unicode characters. |
| `T2A_INVOKE_TIMEOUT_MS` | `30000` | T2A provider invocation timeout. |
| `T2A_MINIMAX_API_URL` | `https://api.minimax.io/v1/t2a_v2` | Minimax T2A endpoint. |
| `T2A_PROVIDER_MINIMAX_API_URL` | same | Alternate Minimax T2A endpoint key. |
| `T2A_URL` | same | Short alias for the current T2A endpoint. |
| `T2A_MINIMAX_MODEL` | `speech-2.6-hd` | Minimax T2A model. |
| `T2A_PROVIDER_MINIMAX_MODEL` | same | Alternate Minimax T2A model key. |
| `T2A_MODEL` | same | Short alias for current T2A model. |
| `T2A_MINIMAX_VOICE_ID` | `Cantonese_ProfessionalHost（F)` | Default T2A voice ID. |
| `T2A_PROVIDER_MINIMAX_VOICE_ID` | same | Alternate default voice key. |
| `T2A_VOICE_ID` | same | Short alias for default T2A voice. |
| `T2A_MINIMAX_SPEED` | `1` | Default speech speed. |
| `T2A_PROVIDER_MINIMAX_SPEED` | `1` | Alternate default speed key. |
| `T2A_SPEED` | `1` | Short alias for default speed. |
| `T2A_MINIMAX_VOLUME` | `1` | Default speech volume. |
| `T2A_PROVIDER_MINIMAX_VOLUME` | `1` | Alternate default volume key. |
| `T2A_VOLUME` | `1` | Short alias for default volume. |
| `T2A_MINIMAX_PITCH` | `0` | Default speech pitch. |
| `T2A_PROVIDER_MINIMAX_PITCH` | `0` | Alternate default pitch key. |
| `T2A_PITCH` | `0` | Short alias for default pitch. |

## Startup And Ops Lifecycle

| Variable | Default | Meaning |
|---|---:|---|
| `WARMUP_ON_START` | `true` | Run rewrite startup lifecycle evaluation on process start. |
| `WARMUP_STARTUP_MAX_WAIT_MS` | `180000` | Max startup warmup wait budget. |
| `WARMUP_STARTUP_RETRY_INTERVAL_MS` | `5000` | Startup warmup retry interval. |
| `WARMUP_RETRY_AFTER_SEC` | derived | `Retry-After` value for warming responses. |
| `READY_REWRITE_STRICT_PROBE_MAX_AGE_MS` | derived | Max Ollama readiness probe age before strict rewrite re-probe. |
| `MINIMAX_READINESS_TIMEOUT_MS` | `5000` | Deprecated/no-op for current passive Minimax rewrite lifecycle; retained for compatibility. |

## Rate Limit And Admission

| Variable | Default | Meaning |
|---|---:|---|
| `RATE_LIMIT_GLOBAL_WINDOW_SEC` | `60` | Global non-ops limiter window. |
| `RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `300` | Global non-ops limiter budget. |
| `RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC` | `60` | Rewrite authenticated-principal window. |
| `RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS` | `60` | Rewrite authenticated-principal budget. |
| `RATE_LIMIT_REWRITE_IP_WINDOW_SEC` | `60` | Rewrite IP fallback window. |
| `RATE_LIMIT_REWRITE_IP_MAX_REQUESTS` | `20` | Rewrite IP fallback budget. |
| `RATE_LIMIT_T2A_AUTH_WINDOW_SEC` | `60` | T2A authenticated-principal window. |
| `RATE_LIMIT_T2A_AUTH_MAX_REQUESTS` | `30` | T2A authenticated-principal budget. |
| `RATE_LIMIT_T2A_IP_WINDOW_SEC` | `60` | T2A IP fallback window. |
| `RATE_LIMIT_T2A_IP_MAX_REQUESTS` | `10` | T2A IP fallback budget. |
| `RATE_LIMIT_OPS_WINDOW_SEC` | `60` | Health/readiness route window. |
| `RATE_LIMIT_OPS_MAX_REQUESTS` | `1000` | Health/readiness route budget. |
| `ADMISSION_MAX_CONCURRENCY` | `4` | Shared admission max concurrency. |
| `ADMISSION_MAX_QUEUE_SIZE` | `100` | Shared admission queue size. |
| `ADMISSION_MAX_WAIT_MS` | `15000` | Shared admission max queue wait. |
| `<PROVIDER>_MAX_CONCURRENCY` | unset | Provider-wide admission concurrency override, for example `OLLAMA_MAX_CONCURRENCY`. |
| `<PROVIDER>_MAX_QUEUE_SIZE` | unset | Provider-wide admission queue override. |
| `<PROVIDER>_MAX_WAIT_MS` | unset | Provider-wide admission wait override. |

## Deprecated Aliases

Deprecated aliases still work for one compatibility window. Canonical names win
when both are set.

| Deprecated alias | Canonical name |
|---|---|
| `REWRITE_DEBUG_RAW_OUTPUT` | `BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT` |
| `TRUSTED_PROXY_ADDRESSES` | `BRIDGE_TRUSTED_PROXY_ADDRESSES` |
| `EXPRESS_TRUST_PROXY` | `BRIDGE_EXPRESS_TRUST_PROXY` |
| `AUTH_ALLOWED_EMAIL_DOMAIN` | `BRIDGE_AUTH_ALLOWED_EMAIL_DOMAIN` |
| `REWRITE_READY_TIMEOUT_MS` | `REWRITE_READY_INVOKE_TIMEOUT_MS` |
| `REWRITE_COLD_TIMEOUT_MS` | `REWRITE_COLD_INVOKE_TIMEOUT_MS` |
| `MINIMAX_PASSIVE_READY_GRACE_MS` | `REWRITE_MINIMAX_PASSIVE_READY_GRACE_MS` |
| `MINIMAX_FAIL_OPEN_ON_IDLE` | `REWRITE_MINIMAX_PASSIVE_FAIL_OPEN_ON_IDLE` |
| `MINIMAX_CONSECUTIVE_FAILURE_THRESHOLD` | `REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD` |
| `MINIMAX_RECOVERY_ATTEMPT_COOLDOWN_MS` | `REWRITE_MINIMAX_PASSIVE_RECOVERY_COOLDOWN_MS` |
| `OLLAMA_PS_CACHE_MS` | `REWRITE_OLLAMA_READINESS_CACHE_MS` |
| `WARMUP_PS_CACHE_MS` | `REWRITE_OLLAMA_READINESS_CACHE_MS` |
| `OLLAMA_PS_TIMEOUT_MS` | `REWRITE_OLLAMA_READINESS_TIMEOUT_MS` |
| `WARMUP_PS_TIMEOUT_MS` | `REWRITE_OLLAMA_READINESS_TIMEOUT_MS` |
| `WARMUP_TRIGGER_TIMEOUT_MS` | `REWRITE_OLLAMA_WARMUP_TRIGGER_TIMEOUT_MS` |
| `WARMUP_RETRIGGER_WINDOW_MS` | `REWRITE_OLLAMA_WARMUP_RETRIGGER_WINDOW_MS` |
| `OLLAMA_TIMEOUT_MS` | `REWRITE_READY_INVOKE_TIMEOUT_MS` |
| `OLLAMA_COLD_TIMEOUT_MS` | `REWRITE_COLD_INVOKE_TIMEOUT_MS` |
| `OLLAMA_MODEL` | `REWRITE_OLLAMA_MODEL` |
| `OLLAMA_URL` | `REWRITE_OLLAMA_URL` |
| `OLLAMA_PS_URL` | `REWRITE_OLLAMA_PS_URL` |
| `MINIMAX_MODEL` | `REWRITE_MINIMAX_MODEL` |
| `MINIMAX_API_URL` | `REWRITE_MINIMAX_API_URL` |
| `MINIMAX_T2A_URL` | `T2A_MINIMAX_API_URL` |
| `MINIMAX_T2A_MODEL` | `T2A_MINIMAX_MODEL` |
| `MINIMAX_T2A_VOICE_ID` | `T2A_MINIMAX_VOICE_ID` |
| `MINIMAX_T2A_SPEED` | `T2A_MINIMAX_SPEED` |
| `MINIMAX_T2A_VOLUME` | `T2A_MINIMAX_VOLUME` |
| `MINIMAX_T2A_PITCH` | `T2A_MINIMAX_PITCH` |
