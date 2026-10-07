# Step 3: service intent and provider implementation

Status: implemented on `codex/service-provider-step3`, stacked on PR #132
(`codex/runtime-failure-corrections`) at
`2dc8253ef4b85909c074216386fe6019f771eea9`. The operator accepted the revised scope
including transcription contract design before authorizing implementation.
This is an incremental candidate, not a release or evidence of VPS acceptance.

## Purpose and accepted scope

Keep the worksheet and future callers independent of native provider requests.
A service owns its purpose, validation, workflow, limits and public output. An
adapter translates service intent into a provider's model/protocol/parameters and
normalizes the response. Adding a provider still needs code and tests; the eventual
operator experience should be a documented, bounded set of environment settings
and a restart. Registration alone does not yet complete that operator experience.

This step migrates rewrite and T2A request construction, establishes contracts for
all three services, and proves different adapter designs with local fixtures.
Transcription production composition/media migration is step 4. Remaining provider
configuration and lifecycle orchestration are step 5. See the standing
[stack and acceptance sequence](provider-abstraction-roadmap.md#development-and-testing-sequence).

## Implemented responsibilities

| Boundary | Owner and behavior in this branch |
|---|---|
| HTTP/auth/output | Existing routes, limiters, authentication and output writers. No endpoint, public field, output format or env setting changes. |
| Configuration | `configuration/rewrite.js` and `configuration/t2a.js` contain the moved readers with existing defaults, bounds, aliases and precedence. `configuration/services.js` composes those settings and the current T2A compatibility policy. |
| Rewrite service | `services/rewrite.js` validates text, supplies fixed rewrite instructions and output budget, and owns HK conversion. It does not select native prompt layouts. |
| T2A service | `services/t2a.js` validates text/output options and stable voice choices. An injected, pure request policy validates legacy controls and declares preset support. |
| Rewrite adapters | `providers/service-requests.js` assembles the existing Ollama/MiniMax prompts; native adapters own protocol/model calls and response parsing. |
| T2A adapter | `providers/minimax-t2a-compatibility.js` applies MiniMax defaults/raw controls; `providers/minimax-voices.js` owns all nine native preset mappings. |
| Transcription | Existing independent production workflow remains unchanged. The input-planning prototype and contract tests define the next boundary. |

The output contract remains [ADR 0001](adr/0001-internal-bridge-contract.md).
Providers return normalized results/events; public JSON, NDJSON and audio encoding
remain writer responsibilities. T2A's existing opaque `provider` metadata remains
in the public response; consumers should not treat it as a portable schema.

## Invocation contracts

The shared adapter receives `requestId`, `timeoutMs` and `signal` alongside the
service payload. Stream invocation also receives `onChunk`. Adapter implementations
must honor the available timeout, propagate cancellation where supported, map native
errors, and settle only when the work they own has ended. A response deadline is
not permission to release capacity while a native request continues. No automatic
retries, provider fallback, hot reload or arbitrary env-based module loading is added.

### Rewrite

`buildRequest(validated)` supplies:

```js
{ text, instructions, outputBudget }
```

`text` is trimmed and validated, `instructions` are server-controlled, and
`outputBudget` is the configured completion-token budget. Native implementations
translate that budget to their supported parameter and must document any different
unit or limitation. Callers cannot override instructions. Adapters choose chat
messages, a combined prompt or another protocol. Existing native prompts and token
budgets are unchanged, including literal `$` text handling. Results are normalized
text/usage; streaming events retain the shared terminal/error rules. HK conversion
stays outside the provider and uses request-local phrase state for streams.

### T2A

`buildRequest(validated)` supplies:

```js
{
  text,
  voiceSelection: { kind: 'preset', id }, // or default / legacy below
  audio: { sampleRate, bitrate, format, channel }
}
```

Other voice selections are `{ kind: 'default' }` and
`{ kind: 'legacy', controls }`. The legacy controls are a compatibility payload
understood by the selected provider policy, not a universal voice schema. Public
`response_mode` stays with the output writer and is not a native provider parameter.
Public MP3/WAV/PCM support and binary/base64 JSON contracts remain unchanged.

[`lib/t2a-voice-choices.js`](../../lib/t2a-voice-choices.js) defines the stable IDs
and minimum semantic intent: language (`yue`, `cmn`, `en`) and speaker sex
(`male`, `female`). An adapter author must explicitly document how each supported
choice maps to a native voice, descriptive prompt, language and other required
settings. These declarations cannot prove the provider's actual acoustic behavior;
listening acceptance remains necessary. Identity/timbre need not match across
providers, but the documented language/sex intent must be respected.

MiniMax mappings are preserved exactly in
[`providers/minimax-voices.js`](../../providers/minimax-voices.js). The description
adapter fixture demonstrates a female English narrator without requiring a
`voice_id`. Known choices unavailable in a supported provider return controlled
422 `VOICE_CHOICE_UNSUPPORTED`; there is no silent substitution.

The injected policy has `legacyFields`, `validateControls(body)` returning a
validation result, and `supportsVoiceChoice(id)`. Validation makes no provider call.
MiniMax's existing raw validation order, null handling, numeric coercion, defaults
and conflicts are unchanged. Unsupported configured providers use the compatibility
validator to preserve error timing, but are never invoked as MiniMax.

A new provider may reject legacy controls explicitly and document migration to
`voice_choice`; the fixture demonstrates this with a test-only controlled error.
No new production legacy rejection code or retirement date is introduced here.
The eventual retirement must remove the compatibility policy and callers through
an explicitly reviewed migration, without making voice IDs mandatory in the core
service. Do not silently reinterpret an old provider's raw voice ID for a new one.

### Transcription: contract now, production migration in step 4

[`lib/transcription-input-plan.js`](../../lib/transcription-input-plan.js) is a
pure, tested prototype, not wired into the current route. A provider declares
prepared-audio requirements: `encoding`, `sampleRate`, `channels`, `delivery`,
`cancellation`, `maxDurationSeconds` and `maxPreparedBytes`. The prototype supports
inline FLAC, PCM s16le or WAV, mono/stereo, and abortable or deadline-only calls.
Unsupported delivery modes fail explicitly; live streaming and asynchronous jobs
are not promised by this contract.

The service computes the stricter duration/prepared-byte limit, owns upload,
validation, conversion, temporary files and cleanup, and will pass prepared bytes
plus their audio description to the adapter. Uploaded-byte limits are separate
from prepared-byte limits. Provider requirements cannot relax upload/media/privacy
limits, supply executable commands, choose temporary paths or take over auth.
Configuration, model/language, SDK authentication and the native recognition request
belong behind the provider boundary.

The contract fixture compares current Google-compatible mono 16 kHz FLAC with a
48 kHz stereo PCM adapter, normalized transcript output, and both cancellation
modes. The current Google adapter is exercised with a mocked SDK; native work that
ignores abort retains capacity until settlement and cannot return late success.
These are contract proofs, not a claim that the generic input planner already
controls FFmpeg or the transcription handler.

Current production remains Google V2 `chirp_3` / `yue-Hant-HK`, normalized FLAC,
existing deadlines, independent per-user/conversion/admission limits, and
cleanup-before-success. Transcription never inherits rewrite text conversion.
PR #132 already closed the named actual-server success coverage gate with
`tests/transcription-composition.test.js`. Step 4 must retain and extend that
coverage while migrating this workflow using these contracts, including real-media,
disconnect, deadline, privacy and cleanup tests. See the [baseline](compatibility-baseline.md).

## Extension and remaining change impact

| Change | Contained work now | Work still required |
|---|---|---|
| Rewrite provider/protocol | Adapter factory, native request/response translation, normalized streaming/errors and tests | Integrate supported configuration and current readiness/key gates; step 5 removes remaining hardcoded orchestration. |
| T2A provider/model | Adapter, pure request policy, documented preset mappings/capabilities, output normalization and tests | Integrate config/policy selection and key gate; prove format support and raw-control rejection before exposure. |
| Transcription provider/model | Implement the agreed input requirements, recognition/result and cancellation contract | Step 4 production integration and step 5 configuration/lifecycle completion. |
| New service | Definition, validation/request/output contract and provider registration; `additionalServices` in `services/index.js` reuses runtime/invocation | Explicit HTTP route, auth/rate/admission policy, output writer, configuration, documentation and contract tests. Registration does not publish a route. |
| Remove provider | Remove registration/config selection/mappings after clients migrate | Announce unsupported settings and legacy controls; preserve unrelated services and test failure timing. |

Additional service IDs must be unique and non-empty; duplicates are rejected before
construction so registry lookup and runtime dispatch cannot select different definitions.
No dynamic plugin loader or automatic route discovery is introduced.

Remaining provider coupling is explicit: supported env names/allowlists in
`configuration/`, policy composition in `configuration/services.js`, credentials
and rewrite readiness/startup state in `server.js`, provider branches in
`providers/lifecycle.js`, and independent transcription construction. Moving env
readers out of service files does not by itself make new providers env-selectable.

## Review and validation gate

The parent PR #132 recorded 306 passing tests. This increment retains its defect
fixes and existing public HTTP assertions. New
[`tests/service-provider-separation.test.js`](../../tests/service-provider-separation.test.js)
proves alternative requests, description voices, transcription requirements and
cancellation, native defaults and additional-service registration. Existing tests
assert all nine MiniMax mappings, both rewrite protocols, aliases, output formats,
validation/error ordering, auth, admission and failure behavior.

Before proceeding: run the full suite and real-FFmpeg tests without skips, local
actual-server curl smoke checks, and Node 22/24 CI; inspect the assembled branch
and PR base. Keep this PR and its parents open. No live cloud credentials, paid
provider calls, VPS deployment or acoustic quality evaluation are established by
local fixtures. Step 4 requires separate implementation authorization.

### Local verification recorded 2026-10-07

- Full Node 24 suite: 313 passed, zero failures or skips, including real FFmpeg.
- Actual-server curl smoke: 18 checks passed across rewrite aliases/JSON/streaming,
  auth rejection, and T2A aliases/three audio formats/two response modes.
- Documentation navigation: 279 local links/anchors checked with no errors; the
  archived original voice plan body and license remain unchanged.
- Reviewed request translation, native defaults/preset identity, auth ordering,
  shared admission/cancellation, output writing and unchanged transcription ownership.
  The new additional-service entry point rejects duplicate IDs to prevent ambiguous
  dispatch; the native voice translator rejects unknown selection modes.
- No further confirmed defect was found in this review. Fixtures do not establish
  absence of all bugs; live authentication/provider/voice acceptance remains stage 6.
- Node 22/24 CI results for the pushed commit are recorded in the PR description.
