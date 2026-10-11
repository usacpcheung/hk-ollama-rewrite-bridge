# Step 5: registered configuration and lifecycle completion

Implemented on `codex/provider-completion-step5`, stacked on PR #134
(`codex/transcription-provider-step4`, base commit
`59684ad870b95bad171972def978259ceb75fc20`). This is the current design of the
implemented boundary, not authorization to deploy or merge. Step 6 remains the
maintenance-window VPS acceptance in the [roadmap](provider-abstraction-roadmap.md).

## Achieved boundary

```text
HTTP/auth/output contract
  → service validation, request intent, deadlines and admission
  → selected registered provider: native configuration + policy + adapter
  → native SDK/HTTP protocol
  → normalized result/artifact/event → existing public output writer
```

`providers/registrations.js` owns the supported provider/service pairs and their
factory, configuration reader, capabilities, optional availability/lifecycle hooks
and T2A request policy. `lib/provider-registry.js` validates registration/factory
contracts. Discovery does not instantiate providers or make network calls.

Service configuration selects the registered reader. Production reads only the
selected pair's native settings; unused providers do not impose credentials or
native configuration requirements. Rewrite/T2A direct resolver inspection retains
its older all-provider mode, while production composition explicitly selects only
one. Common service settings and backwards-compatible default provider names stay
in service composition. Native model/protocol/endpoints/options and lifecycle env
aliases live under `providers/configuration/`.

| Service | Operator selection | Preserved built-ins | Service-owned work |
|---|---|---|---|
| Rewrite | `REWRITE_PROVIDER` | Ollama; MiniMax legacy/Anthropic | Text validation, conversion, streaming, deadlines, readiness gates and admission |
| T2A | `T2A_PROVIDER` | MiniMax | Text/audio validation, voice intent, binary/base64 output and admission |
| Transcription | `TRANSCRIPTION_PROVIDER` (new) | Google Speech V2 | Upload/origin/auth, media validation/preparation, recognition deadline, cleanup and separate capacity |

Google model/language are configurable using `TRANSCRIPTION_GOOGLE_MODEL` and
`TRANSCRIPTION_GOOGLE_LANGUAGE`; defaults remain `chirp_3` and `yue-Hant-HK`.
Its FLAC/16 kHz/mono inline request profile and deadline-only SDK ownership remain.
Syntax validation is not proof that a model supports this region/language/call.
No live alternative model/provider was added or certified by this refactor.

## Availability and lifecycle

Routes ask their runtime for a controlled availability error instead of testing
native credentials. MiniMax keeps `503 MINIMAX_API_KEY_MISSING` and existing
validation order. Google ADC remains lazy; startup/readiness does not preflight
cloud credentials. Transcription checks optional provider availability after
identity/origin validation, before admission/upload processing.

Rewrite lifecycle is selected by declared mode:

- `active_probe`: adapter readiness/warmup methods; deduplicated warmup with
  provider-configured cache, timeout and retrigger values. Missing availability
  prevents probing/warming.
- `passive_remote`: process-local success/failure observation, idle policy,
  single recovery attempt and cooldown. MiniMax's existing public reasons and
  cooldown errors come from its registration policy.
- `none`: no probe or warmup; rewrite is eligible when its availability policy
  permits it. This is not proof of remote reachability.

The server still owns rewrite startup/ready/warming/degraded state and shared
HTTP gates. `/readyz` is still rewrite-only. Transcription does not inherit rewrite
warmup, readiness, admission or retries. T2A likewise has no readiness probe.
Historical model-status/log keys such as `minimaxPassiveReadiness` and
`ollamaPsCacheMs` remain compatibility labels; they do not select native code.
The unsupported-T2A policy preserves old validation order for unknown selections;
it is a compatibility-only path, not the policy for a newly registered provider.

## Extension and retirement

For an existing service/protocol capability, adding a provider changes its adapter,
provider config/policy, registration, tests and documentation. Shared routes,
auth/output writers and service workflows need no provider-name branches.
See the [author guide](../guides/adding-a-provider.md) for precise contracts.

T2A providers map stable `voice_choice` intent to native voices or descriptions.
Document language, speaker sex and every native parameter, as well as unsupported
presets. MiniMax raw controls remain supported; another provider can explicitly
reject them without implementing fake IDs. Format declarations are enforced:
unsupported valid formats return `422 AUDIO_FORMAT_UNSUPPORTED`; existing MiniMax
formats and malformed-input errors are unchanged. No silent format fallback occurs.

Removing a provider requires caller/operator migration, removing its registration
and docs, and testing explicit unsupported behavior. There is no automatic provider
fallback. Existing-service replacement is contained; adding a new service still
needs route, auth/admission, request/output contract and service-specific tests.
Remote URL audio, asynchronous jobs and live streaming transcription remain outside
this synchronous inline contract and require separate design.

## Verification and release boundary

`tests/provider-completion.test.js` installs test-only registrations before normal
server composition, then changes environment selections across fresh processes.
It proves rewrite JSON/NDJSON, T2A formats/voice intent, real-FFmpeg transcription
and existing HTTP output through alternative providers without route edits. It also
covers selected-reader isolation, removal without fallback, missing credentials,
active warmup concurrency, passive recovery and format capability rejection.
The preload is a test harness, not a production plugin loader.

Retain the full previous suite, including startup `MODEL_WARMUP_STARTED`, auth,
queue/disconnect ownership, slow recognition/cleanup, malformed results and storage
failure cases. Record final test counts, CI and simulations in the PR. Unit/local
HTTP proof does not establish OIDC sessions, live credentials, cloud quota,
voice quality, model availability or worksheet integration.

The stack stays open and production stays pinned. After review and Node 22/24 CI,
select the exact latest candidate SHA and separately record the actual working VPS
baseline, private configuration backup, maintenance window and rollback procedure.
Run the roadmap's Step 6 checklist through the existing gateway. No new public
OIDC installation is required. Merge only after acceptance and explicit approval.
