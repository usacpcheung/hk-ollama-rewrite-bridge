# Registered provider construction

Current implementation includes Steps 2–5. Existing public contracts and built-in
provider defaults are preserved; Step 5 adds registered configuration/availability
and lifecycle selection. See the [Step 5 design](provider-abstraction-step-5.md).

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
| Google Speech / transcription | sync only | `none` | Inline FLAC/16 kHz/mono; deadline-only recognition |

Step 4 adds `google-speech/transcription` through the same registry.
`configuration/transcription.js` selects the registered adapter, while its service
retains independent upload/conversion/admission/cleanup. Disabled transcription
does not construct a provider or initialize the Google SDK. See [step 4](provider-abstraction-step-4.md).
The exported `PROVIDER_CAPABILITIES` is a rewrite-only compatibility view for direct
configuration consumers; server composition uses per-service views.

## Registration contract

`lib/provider-registry.js` accepts code-owned definitions containing:

- `provider`, `serviceId`: non-empty names identifying one unique pair.
- `create(options)`: synchronous factory receiving the resolved `serviceConfig`
  and existing construction options (endpoints, credentials,
  timeouts/options where applicable, and debug logger). Factories may initialize
  adapter objects but must not make paid requests during discovery/construction.
- `readConfiguration({env, ...})`: native validated settings as `{runtime, sources?}`.
- `availability(options)`: optional local controlled configuration error or null.
- `lifecycleOptions({env})`: optional validated neutral lifecycle settings.
- `requestPolicy`: required for registered T2A providers; validates native legacy
  controls and declares supported neutral presets.
- `capabilities`: `sync: true`, boolean `streaming`, optional lifecycle descriptor,
  audio format list and `legacyVoiceControls` flag. Capability snapshots and audio
  lists are frozen; discovering capabilities does not execute a factory.

A constructed adapter must expose `services[serviceId].sync`, a stream handler
exactly when declared, and `mapError`. Existing result/event shapes come from
`lib/bridge-contract.js`. Async invocation returns that result; stream callbacks use
its events. A malformed registration/factory fails as an internal programming error.
Factory adapters may be plain objects or class instances, including frozen objects.
The registry forwards interface methods bound to the original adapter so prototype
methods, getters and private state survive construction. Shared dispatch binds
`services[serviceId].sync/stream` to the owning service-handler object; legacy
rewrite methods retain the provider receiver.
Voice IDs and lifecycle methods are not required of every factory. Active-probe
implementations still need the methods consumed by the existing lifecycle factory.

Lifecycle descriptors now select mode-driven policy. T2A audio format declarations
are enforced by shared validation; request policy handles preset/raw-control support.
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

Step 5 extends the proof through actual server routes with environment-selected
alternative providers for all three services. Native readers and policies are
registered alongside factories; adding a supported implementation does not need
provider-name branches in routes. `providers/registrations.js` owns definitions.
Unknown enabled transcription also fails startup; disabled transcription is lazy.

Cancellation/deadlines remain service/adapter responsibilities. The registry adds
no retries or failover. Transcription keeps independent capacity/cleanup and the
server keeps rewrite startup state. New service routes and new transport modes
still require explicit design. Follow the [author guide](../guides/adding-a-provider.md)
and [roadmap](provider-abstraction-roadmap.md). Production remains pinned pending
separate maintenance-window acceptance.

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
adapter proofs and the transcription contract (integrated into production in step 4). Step 5 completes config/lifecycle selection through registered hooks; a new
provider still needs its reader, policy, native implementation and tests.
