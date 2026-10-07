# Registered provider construction

Implemented in the step-2 PR based on main
`668e68e4e9ad72760b28bdc5b901e4d8659a249d`. Public APIs, supported env selections,
protocol/model defaults, auth, admission, voice presets and raw controls are unchanged.

## Production path

`server.js` supplies `providerRegistry.capabilitiesFor(serviceId)` to
`services/index.js`. Readers in `configuration/` resolve environment settings and
streaming enablement. `createServiceRuntimes` calls `createProvider`, which selects
a registered pair and constructs its adapter. The invoker and output writers retain
the existing contracts. This is actual production wiring, not an unused registry.

| Provider / service | Invocation | Lifecycle descriptor | Audio / legacy controls |
|---|---|---|---|
| Ollama / rewrite | sync, stream | `active_probe` | Not applicable |
| MiniMax / rewrite | sync, stream; legacy or Anthropic protocol | `passive_remote` | Not applicable |
| MiniMax / T2A | sync only | `none` | MP3/WAV/PCM; existing raw voice controls |

No Google registration is added. Disabled transcription does not initialize the
Google SDK, and enabled transcription continues through its independent service.
The exported `PROVIDER_CAPABILITIES` is a rewrite-only compatibility view for direct
configuration consumers; server composition uses per-service views.

## Registration contract

`lib/provider-registry.js` accepts code-owned definitions containing:

- `provider`, `serviceId`: non-empty names identifying one unique pair.
- `create(options)`: synchronous factory receiving the resolved `serviceConfig`
  and existing construction options (endpoints, credentials,
  timeouts/options where applicable, and debug logger). Factories may initialize
  adapter objects but must not make paid requests during discovery/construction.
- `capabilities`: `sync: true`, boolean `streaming`, optional lifecycle descriptor,
  audio format list and `legacyVoiceControls` flag. Capability snapshots and audio
  lists are frozen; discovering capabilities does not execute a factory.

A constructed adapter must expose `services[serviceId].sync`, a stream handler
exactly when declared, and `mapError`. Existing result/event shapes come from
`lib/bridge-contract.js`. Async invocation returns that result; stream callbacks use
its events. A malformed registration/factory fails as an internal programming error.
Factory adapters may be plain objects or class instances, including frozen objects.
The registry forwards interface methods bound to the original adapter so prototype
methods, getters and private state survive construction.
Voice IDs and lifecycle methods are not required of every factory. Active-probe
implementations still need the methods consumed by the existing lifecycle factory.

Lifecycle/audio/legacy descriptors document support; they do not replace current
lifecycle selection, request validation or unsupported-control policy in this stage.
Configured service capabilities override descriptive factory capabilities in the
runtime, so available rewrite streaming remains disabled unless configuration enables it.

Registries are instance-local; there is no mutable global plugin loader or env-based
module import. Duplicate pairs fail explicitly. Missing pairs never fall back.
The production wrapper preserves existing behavior: unsupported rewrite selection
fails startup, unsupported T2A selection survives construction and fails at the
existing route gate after validation. Ollama/T2A is unregistered and no Ollama
factory is invoked for that rejected pair.

## Extension proof and remaining boundaries

`tests/provider-registry.test.js` registers a fake additional audio adapter, passes
it through the same `createProvider` wrapper and runtime/invoker, uses the unchanged
T2A validator, and writes the existing base64 JSON contract using artifacts. It
requires neither native voice IDs nor readiness/warmup methods. No cloud calls occur.

This proves the construction boundary, not public acceptance of arbitrary env
provider names. Current config readers and route support/key checks still know
existing providers, native voice mapping now lives in `providers/minimax-voices.js`, and
lifecycle policy still branches in `providers/lifecycle.js`. Adding a real provider
still requires an explicit supported configuration/mapping integration in later
stages; registration alone does not bypass validation or route gates.

Credential/model/protocol interpretation remains in provider-specific factory
functions. Payload normalization, audio metadata corrections, transcription
capacity/cleanup and startup orchestration are not rewritten here. Cancellation
and deadlines remain service/adapter responsibilities under the existing flows;
the registry adds no retries, failover or lifecycle state machine.

Before stages 3–5, use the [roadmap](provider-abstraction-roadmap.md) and
[baseline gates](compatibility-baseline.md). Production remains pinned until the
operator's separately planned acceptance; this PR does not establish VPS state.


## Historical step-2 verification

The full local suite passes 246 tests with zero failures/skips (238 existing,
seven registry cases, one additional HTTP case). Actual-server curl smoke checks
verify rewrite JSON, oversized JSON on all six aliases, and MP3/WAV/PCM binary
and JSON output on both T2A aliases. Local upstreams and synthetic credentials
are used; these checks neither deploy nor call paid providers. Documentation
validation checks 246 local links and 20 exact baseline test-title references.
The PR's Node 22/24 CI is the merge-time verification for its final commit.

## Step-3 request boundary

Factories now translate service-owned rewrite/T2A requests into native payloads.
The pure T2A compatibility policy is composed in `configuration/services.js`.
See [step 3](provider-abstraction-step-3.md) for payloads, preset intent, alternative
adapter proofs and the transcription contract prototype. Config/lifecycle selection
is still incomplete; registration alone does not add a supported env selection.
