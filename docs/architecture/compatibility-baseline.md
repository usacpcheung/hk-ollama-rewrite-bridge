# Service/provider compatibility baseline

Status: established by PR #128 and corrected by PR #129; reconciled with the
repository documentation against main `a50c47d150724820080a8e7d7861070b7a0ecc51` on
2026-10-06. See the [documentation index](../README.md), [current runtime](runtime.md),
and [API reference](../reference/api-reference.md).
PR 1 established the tests/documentation baseline. The corrective PR stacked on
PR #128 was merged as PR #129 and corrected the two defects below. Provider abstraction and raw-ID
retirement remain future work.

## Purpose and classification

The target is to keep existing worksheet-facing services and output formats while
separating service workflows from provider implementations. Selecting an already
implemented provider/model should require documented configuration and a restart.
Adding a provider or calling protocol still requires adapter code, configuration,
capability declarations, mappings, and tests; environment variables cannot implement
an unknown upstream API.

Use these classifications when reviewing later changes:

- **C — service contract:** preserve the public behavior across compatible providers.
- **L — legacy/provider compatibility:** preserve it for existing consumers and the
  applicable provider. Do not require unrelated providers to emulate native controls.
- **Q — observed quirk:** record and test today's behavior without making it a design
  goal. Changing it needs an explicit compatibility decision, separate from a refactor.

Characterization tests describe current behavior; they do not make defects permanent
contracts. Oversized JSON returning 500 (Q-01) and WAV audio carrying MP3 labels
(Q-02) were confirmed defects. The corrective PR replaces their assertions with
413 responses and consistent audio metadata, respectively; these corrected
expectations now form the baseline for abstraction work. The absence of `Retry-After` on admission overload is a separate
policy decision, not a confirmed defect: no reliable queue-availability estimate
is currently provided. Other behavior changes still need an explicit scope and
compatibility assessment rather than being incidental to structural refactoring.

## What is implemented today

[server.js](../../server.js) composes the HTTP middleware and routes.
[services/index.js](../../services/index.js) registers rewrite and T2A;
[providers/index.js](../../providers/index.js) selects their concrete providers.
The [service invoker](../../lib/service-invoker.js),
[provider lifecycle](../../providers/lifecycle.js), and
[output writer](../../lib/service-output-writer.js) already separate parts of those
paths. Provider construction now uses registered factories; service/provider capability
maps come from those registrations. Lifecycle policy, service config allowlists,
native factory options and route gates still depend on concrete integrations.

[Transcription](../../services/transcription.js) has its own multipart upload,
conversion, admission, cleanup, and HTTP response lifecycle. Its
[Google adapter](../../providers/google-speech.js) encapsulates recognition calls,
but transcription is not another entry in the rewrite/T2A service registry.
Its public result is independent of Google's native response shape; its workflow
and output composition have not yet been unified with the other services.

Consequently, the presence of adapters and normalized outputs is not evidence that
every service already supports interchangeable providers through configuration.

## Compatibility evidence

The tables identify source ownership and executable evidence. Test descriptions
in quotation marks are exact titles; other entries identify the relevant suite.
HTTP tests use local upstream fixtures. Transcription component tests inject a
Google client and media conversion fixture; real FFmpeg coverage is separate.

### Shared boundary and lifecycle

| ID / class | Current behavior to preserve or explicitly migrate | Source and evidence |
|---|---|---|
| HTTP-01 C | Both internal aliases of each service remain available: `/rewrite` and `/api/rewrite`, `/t2a` and `/api/t2a`, `/transcriptions` and `/api/transcriptions`. Missing/wrong bridge secret or missing email is 401 `AUTH_REQUIRED`; comma-separated email is 401 `AUTH_HEADER_INVALID`; disallowed domain is 403 `FORBIDDEN_DOMAIN`. | [server](../../server.js), [auth](../../auth/header-auth.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: all six aliases share the full auth rejection matrix”; successful aliases also covered by the service suites below. |
| HTTP-02 C | Identity derivation and authorization are distinct. Identity uses the trusted peer/secret rules before accepting an email principal, otherwise falls back to IP. Header authorization checks the configured secret and email/domain rules; it is not a full email-syntax validator or an independent peer-address gate. | [identity](../../auth/client-identity.js), [auth](../../auth/header-auth.js); [identity tests](../../tests/client-identity.test.js), [auth configuration tests](../../tests/header-auth-config.test.js), [auth parity tests](../../tests/rewrite-auth-parity.test.js). |
| HTTP-03 C | The baseline limiter runs before auth, spans services, and includes model status. Health/readiness are exempt from the baseline limiter but have a separate ops limiter. Rewrite/T2A service limiters also precede auth; enabled transcription's user limiter follows auth. Buckets remain distinct where configured; rate-limit errors have their existing 429 envelopes and retry metadata. | [server](../../server.js), [limiter](../../middleware/rate-limit/index.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: baseline limiting precedes auth, spans services and excludes ops” and “compatibility: JSON service limiters precede auth; enabled transcription limiter follows auth”; [limiter tests](../../tests/rate-limit.test.js). |
| HTTP-04 C/L | Rewrite and T2A using MiniMax share provider admission capacity. Full admission returns 503 `ADMISSION_OVERLOADED` with provider/reason metadata, without `Retry-After`. Once streaming headers are sent, overload is a terminal NDJSON error with embedded status 503 under HTTP 200. Expired queue entries must free capacity; providers otherwise have separate accounting. | [admission](../../lib/admission-controller.js), [invoker](../../lib/service-invoker.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: MiniMax rewrite and T2A share admission and streaming overload stays NDJSON”; [admission tests](../../tests/admission-controller.test.js), including “expired admission requests free queue space and cannot consume a later ticket”. |
| LIFE-01 C/L | Health is process liveness. Readiness reflects rewrite lifecycle, not aggregate readiness of all three services. Cold Ollama gates rewrite with 202/retry metadata while T2A remains usable; model readiness restores JSON and streaming rewrite. Exhausted startup budget gives degraded rewrite/ready responses while health and T2A remain available. | [server](../../server.js), [lifecycle](../../providers/lifecycle.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: Ollama warmup gates rewrite while T2A remains available, then both rewrite aliases recover” and “compatibility: exhausted Ollama startup budget degrades rewrite without failing health or T2A”; [lifecycle tests](../../tests/provider-lifecycle.test.js). |
| LIFE-02 L | MiniMax readiness/status are passive and do not make paid probes. Failure thresholds, fail-open policy, and recovery cooldown retain their current meanings. A cooldown rejection is 429 `MINIMAX_RECOVERY_COOLDOWN` with retry metadata. | [lifecycle](../../providers/lifecycle.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: MiniMax failure recovery cooldown is HTTP-visible and never triggers paid probes”; [lifecycle tests](../../tests/provider-lifecycle.test.js). |

### Service requests and outputs

| ID / class | Current behavior to preserve or explicitly migrate | Source and evidence |
|---|---|---|
| RW-01 C | Rewrite JSON is `{ ok, result }` with optional `usage`. Streaming is NDJSON with `response`, `done`, and applicable `done_reason`, `usage`, or `error`; terminal completion/error behavior remains stable. Provider failures after streaming starts cannot be converted into a new HTTP status. | [rewrite service](../../services/rewrite.js), [output writer](../../lib/service-output-writer.js); [API contract tests](../../tests/api-contract.test.js), “rewrite and t2a preserve current public HTTP response contracts” and “M3 Anthropic-compatible rewrite preserves public sync and streaming contracts”; [rewrite validation tests](../../tests/rewrite-validation.test.js), [output writer tests](../../tests/service-output-writer.test.js). |
| RW-02 C | Unicode-aware text budgets, validation codes, fixed server-side rewrite instructions, and Hong Kong text post-processing remain service behavior. Caller template overrides do not replace those instructions. Transcription must not inherit rewrite text conversion. | [rewrite service](../../services/rewrite.js); [rewrite validation tests](../../tests/rewrite-validation.test.js), [post-processing tests](../../tests/service-post-process.test.js); [transcription tests](../../tests/transcription.test.js), “transcription joins recognized segments without applying rewrite post-processing”. |
| RW-03 L | Ollama, MiniMax legacy, and MiniMax Anthropic-compatible wire protocols keep their existing request construction, stream parsing, error mapping, thinking exclusion, and optional usage handling. Native usage details are not promised to be identical across providers. | [Ollama](../../providers/ollama.js), [MiniMax](../../providers/minimax.js); [Ollama tests](../../tests/providers/ollama.test.js), [MiniMax tests](../../tests/providers/minimax.test.js), [API contract tests](../../tests/api-contract.test.js). |
| T2A-01 C | Default response is raw audio with existing content headers/disposition. `base64_json` retains `ok`, `audio`, `format`, `mime`, `contentType`, `size`, and `provider`. Request limits, supported modes, unsupported streaming, timeout isolation, and controlled unsupported-provider/missing-key errors remain intact. | [T2A service](../../services/t2a.js), [output writer](../../lib/service-output-writer.js); [route tests](../../tests/t2a-routes.test.js), [validation tests](../../tests/t2a-validation.test.js), [output writer tests](../../tests/service-output-writer.test.js). The `provider` field is an opaque provider-specific metadata object (or null), not a provider-name selector. MiniMax populates fields such as trace ID, source path, format and content type; consumers must not rely on native metadata staying identical across providers. |
| T2A-02 C/L | The current nine `voice_choice` presets resolve to provider-owned parameters. Both aliases and response modes retain their behavior. Unknown choices and conflicting controls follow current validation; preset objects are isolated from caller mutation. Native mapping values belong to MiniMax compatibility, not a universal voice schema. | [preset catalog](../../lib/t2a-voice-choices.js), [MiniMax mappings](../../providers/minimax-voices.js), [T2A service](../../services/t2a.js); [route tests](../../tests/t2a-routes.test.js), [preset tests](../../tests/t2a-voice-choices.test.js), [validation tests](../../tests/t2a-validation.test.js). |
| T2A-03 L | Existing raw `voice_id`, associated native tuning, and legacy environment defaults remain supported for current MiniMax/worksheet clients. New providers are not required to implement raw voice IDs. PR 1 neither removes these controls nor adds a new cross-provider rejection policy. | [T2A service](../../services/t2a.js), [MiniMax](../../providers/minimax.js); [route tests](../../tests/t2a-routes.test.js), [T2A configuration tests](../../tests/t2a-config-resolution.test.js), [MiniMax tests](../../tests/providers/minimax.test.js). |
| TR-01 C | Transcription is opt-in, authenticates both aliases even when disabled, and enforces its browser-origin policy. Success retains `ok`, `result`, `durationSeconds`, `requestId`, and `timings` (`conversionMs`, `transcriptionMs`, `totalMs`). Handler responses use `Cache-Control: no-store`. Recognition segments are trimmed/joined without rewrite conversion. | [transcription service](../../services/transcription.js); [transcription tests](../../tests/transcription.test.js), especially “transcription aliases preserve each transcript, configure the Google V2 call, and clean audio” and “transcription joins recognized segments without applying rewrite post-processing”; [HTTP tests](../../tests/service-compatibility.test.js) for actual-server middleware. See Q-01 for early errors. |
| TR-02 C | Multipart structure, byte limits, decoded-duration limits, actual audio validation, normalization, per-user active work, total admission, and conversion concurrency remain bounded. Timeout/disconnect must not release admission while outstanding provider work can still finish. Request results must not mix between users. | [transcription service](../../services/transcription.js), [media](../../lib/transcription-media.js); [transcription tests](../../tests/transcription.test.js), [media tests](../../tests/transcription-media.test.js), including real FFmpeg browser-format tests when installed. |
| TR-03 C/L | Current Google error mapping is controlled: code 8 → 429 `TRANSCRIPTION_RATE_LIMITED`; 4 → 504 `TRANSCRIPTION_TIMEOUT`; 7/16 → 503 `TRANSCRIPTION_UNAVAILABLE`; 13 → 502 `TRANSCRIPTION_FAILED`; empty speech → 422 `NO_SPEECH`. Responses omit raw provider details and include request IDs; 429/503 use `Retry-After: 10`. Google codes themselves belong inside its adapter. | [Google adapter](../../providers/google-speech.js), [transcription service](../../services/transcription.js); [transcription tests](../../tests/transcription.test.js), “provider errors and empty speech are controlled and never expose raw details”, plus initialization timeout/recovery/cancellation tests. |
| TR-04 C | Temporary audio is cleaned on success/failure. A deletion failure before success produces controlled unavailability; a final cleanup failure preserves an already chosen error. Both latch storage failure and block later provider work. Restart cleanup removes only matching dead-process job directories, preserving live jobs, links, and unrelated entries. | [transcription service](../../services/transcription.js); [transcription tests](../../tests/transcription.test.js), “transcription deletion failure prevents success and blocks later provider calls”, “transcription final cleanup failure preserves the original error and blocks admission”, and “restart cleanup removes only exact dead-process jobs and preserves live jobs, links and unrelated files”. |

### Configuration and observed quirks

| ID / class | Current behavior to preserve or explicitly migrate | Source and evidence |
|---|---|---|
| CFG-01 C/L | Service-scoped settings, defaults, bounds, canonical/legacy precedence, and alias warnings retain their current resolution. Protocol selection is explicit rather than inferred from a model name. Unsupported combinations fail under existing controlled behavior; there is no automatic switch to another provider. | [environment reader](../../lib/env-config.js), [rewrite configuration](../../configuration/rewrite.js), [T2A configuration](../../configuration/t2a.js), [transcription configuration](../../lib/transcription-config.js); [environment tests](../../tests/env-config.test.js), [boolean tests](../../tests/env-boolean-parsing.test.js), [rewrite configuration tests](../../tests/rewrite-config-resolution.test.js), [T2A configuration tests](../../tests/t2a-config-resolution.test.js), [runtime tests](../../tests/service-runtime.test.js), [transcription tests](../../tests/transcription.test.js). These suites cover representative resolution rules, not every possible environment combination. |
| Q-01 C (defect corrected) | The global 16 KiB JSON parser precedes authentication and transcription's no-store middleware. Malformed JSON returns 400 `INVALID_JSON`; oversized JSON returns 413 `PAYLOAD_TOO_LARGE` (previously 500 `INTERNAL_ERROR`). These early responses lack transcription request IDs/no-store. The baseline limiter can also respond before no-store. | [server](../../server.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: JSON parser rejects malformed and oversized bodies before auth on every POST alias” and baseline-limiter coverage. This concerns JSON requests, not the transcription multipart upload limit. |
| Q-02 C/L (defect corrected) | MiniMax audio bytes pass through without transcoding. Public format, MIME and filename now agree: `mp3`/`audio/mpeg`, `wav`/`audio/wav`, or `pcm`/`audio/pcm`. Recognized provider declarations take precedence over the request; missing declarations use the requested format. Unsupported or contradictory metadata returns controlled 502 `PROVIDER_ERROR`. Previously WAV bytes could carry MP3 labels. This uses provider declarations, not binary codec detection. | [MiniMax](../../providers/minimax.js), [output writer](../../lib/service-output-writer.js); [HTTP tests](../../tests/service-compatibility.test.js), “compatibility: MiniMax WAV bytes and public audio metadata agree”. The fixture tests opaque byte preservation and metadata, not WAV decoding. |
| Q-03 Q/L | `WARMUP_ON_START=false` marks service state `ready` but does not suppress on-demand Ollama warmup. A cold model can yield `MODEL_WARMING` and readiness 503 `MODEL_NOT_READY` with `serviceState: ready`. | [server](../../server.js); [HTTP tests](../../tests/service-compatibility.test.js), Ollama warmup/recovery case. Do not infer model readiness from the service-state string alone. |

## Voice portability and eventual legacy retirement

The intended portable request is a service-level `voice_choice`. For every provider
supporting a choice, its integrator must document the intended language and speaker
sex and how native voice IDs, descriptive prompts, reference voices, model settings,
and tuning implement that choice. A provider need not have a native voice-ID concept.
Payload tests establish that the documented mapping is sent; they cannot establish
the perceived voice or language quality. That needs provider-specific listening checks.

Keep existing raw-ID handling isolated as legacy compatibility in later work. A
future provider that cannot honor a requested legacy control should return a clear,
documented unsupported-control error rather than silently choose a different voice.
The exact error contract and validation ordering must be specified and tested in
the implementing PR. This is target behavior, not a claim about current support.
Retirement requires a separate consumer migration and removal decision; no date or
removal is introduced here. Portable workflows must not require raw IDs internally.

## Runtime defect corrections after the audit

The [2026-10-07 correction review](../reviews/2026-10-07-runtime-failure-corrections.md)
records explicitly authorized fixes to cancellation, streaming completion/backpressure,
JSON-read timeout classification and T2A upstream-auth classification. These defects
are not compatibility requirements. Preserve the corrected behavior in later refactors,
using the new [HTTP fault tests](../../tests/runtime-failures-http.test.js) and
[provider stream fault tests](../../tests/provider-stream-faults.test.js).
The registry/class-method correction is reviewed in parent PR #131. Runtime correction
PR #132 is stacked on `codex/provider-registry-step2`: its branch includes the registry,
while its diff against #131 contains the runtime corrections. Both remain open for testing;
the intended sequence is `main → #131 → #132`.

## Verification limits and the next refactor gate

Run `npm test` with Node.js 22 or 24. The suite serializes test files because real
server fixtures use the production localhost port. FFmpeg/FFprobe must be available
to exercise real media tests; inspect skip counts before claiming full coverage.
The new HTTP fixture excludes inherited provider settings and credentials and uses
local mock upstreams; it does not contact paid services.

PR 1 adds nine real-server HTTP cases, one admission-expiry case, and three
transcription cases. Existing transcription assertions also cover exact success
fields/timings, mapped errors/retry headers, and broader restart cleanup behavior.
The pre-PR1 suite had 203 tests; PR #128 passed 216. PR #129 expanded this to
238 passing tests, with zero failures or skips, including nested audio-metadata
coverage. These counts describe successive checkpoints, not competing baselines. Coverage remains deliberately bounded:

- No live provider/model quality, real Google credentials, billing behavior, Apache
  OIDC deployment, or worksheet UI is certified by these local tests.
- Transcription component tests still cover injected lifecycle/error/media cases.
  [Actual-server composition tests](../../tests/transcription-composition.test.js)
  now run both successful aliases with real FFmpeg and a preloaded fake Google SDK,
  including Google permission/quota/deadline errors, executable permission failure,
  upload timeout and cleanup. No live credentials are used.
- [Startup composition tests](../../tests/warmup-composition.test.js) now cover HTTP
  `MODEL_WARMUP_STARTED` and `Retry-After` on both aliases while T2A remains available.
  These close the previously named composition/startup examples, not every possible
  scheduling interleaving. [Runtime failure tests](../../tests/runtime-failure-units.test.js)
  add cancellation/timeout/release races and slow-output ownership checks.
- Provider wire fixtures and exact preset mappings are integration compatibility
  checks, not requirements to expose those native structures to service consumers.

For each later PR, identify affected rows, retain the applicable checks, and fill
any relevant coverage gap before moving behavior. Internal interfaces may change;
do not weaken public assertions merely to accommodate a new implementation. An
intentional API correction, legacy retirement, or changed error policy needs its own
documented compatibility decision and updated consumer guidance.


## Readiness decision after the merged-main audit

The baseline is usable for the [step 2 provider registration and construction](provider-abstraction-step-2.md).
The [fresh audit](../reviews/2026-10-06-main-baseline-audit.md) pins the merged-main
commit, documents source/test checks, and distinguishes existing coverage from
requirements to add before a later workflow migration. This is not evidence that
all services are already interchangeable or that every refactoring scope is safe.
Do not expand step 2 into transcription composition or startup-state extraction
without closing the corresponding coverage gates above first.

Development/deployment sequence is recorded in the [six-stage roadmap](provider-abstraction-roadmap.md). PR #130 does not implement step 2 or deploy the VPS.


## Step-2 construction coverage

The step-2 PR uses main `668e68e4e9ad72760b28bdc5b901e4d8659a249d` as its
implementation base. Existing 238 baseline tests remain unchanged except for an
additional HTTP case; new registry tests supplement them. Historical counts above
remain the record for PRs #128/#129, not the total after later additions.

- CFG-01/RW-03/T2A-01: existing configuration-resolution, provider-adapter, API and
  T2A route tests continue through registered production factories.
- New [registry tests](../../tests/provider-registry.test.js) cover lazy registration,
  duplicate/invalid definitions, factory conformance, isolated service capabilities,
  unchanged lifecycle selection, unsupported pairs without fallback, disabled
  Google initialization and a fake adapter through runtime/validation/output.
- New [HTTP coverage](../../tests/service-compatibility.test.js), “compatibility: unregistered Ollama T2A preserves validation order and does not affect rewrite”,
  checks both aliases and proves rejected T2A work makes no upstream calls.
- Transcription composition and startup-state branches are not moved. Their
  previously recorded coverage gates still apply to later stages.

See [registry boundaries and remaining work](provider-registry.md) before interpreting
this construction refactor as complete env-driven provider interchangeability.

## Whole-branch correction gate in PR #132

The assembled branch also corrects inherited defects found during its full review.
Literal prompt text must survive template insertion; unavailable readiness must not
reuse stale health; malformed provider text and empty Ollama streams must fail.
T2A provider failures and unrelated hexadecimal metadata cannot become audio success.
Streaming conversion must preserve whole-text OpenCC results across chunk boundaries;
public chunk fields and terminal metadata remain unchanged, but chunk count is not
fixed. The widget must require completion, honor body-read deadlines, count Unicode
code points, and distinguish model readiness from process availability.

Evidence: [whole-branch regressions](../../tests/whole-branch-regressions.test.js),
[widget regressions](../../tests/widget-regressions.test.js), and the existing
[HTTP contracts](../../tests/api-contract.test.js). The OpenCC parity check covers
every loaded dictionary entry split into UTF-16 units. Existing baseline counts above
are historical checkpoints; PR #132 records the final full-suite/CI results.
