# Provider abstraction — step 2 scope and acceptance gates

Status: implemented in this step-2 PR; pending review/merge, not deployed.
Implementation base: main `668e68e4e9ad72760b28bdc5b901e4d8659a249d`.
The operator's VPS deployment state has not been inspected. This PR does not
change the production pin or authorize deployment or later refactor stages.
See the [six-stage roadmap and deployment gates](provider-abstraction-roadmap.md)
and [registry implementation/extension contract](provider-registry.md).

## Target and current boundary

Keep existing rewrite, T2A and transcription services and public formats. Service
logic owns validation and workflow; adapters own native requests, protocol/model
handling and response normalization. Existing output contracts remain the consumer
boundary. Selecting an implemented provider/model should eventually use documented
environment settings plus restart; a new upstream protocol still needs adapter code.

Rewrite/T2A now use registered factories and per-service provider capabilities
with their existing service registry and shared invoker/output writer. Transcription constructs Google independently and owns its
upload/conversion/cancellation/cleanup lifecycle. See [runtime](runtime.md) and
[ADR 0002](adr/0002-service-provider-runtime-boundary.md). Output normalization
already exists, but it is not proof of complete provider interchangeability.

## Step 2: working provider registration and construction

The implementation covers the following agreed scope:

1. Specify contracts for sync and optional streaming invocation, normalized output,
   controlled errors, configuration ownership and optional lifecycle hooks. Reuse
   `lib/bridge-contract.js` and the existing adapter where possible.
2. Define capabilities per service/provider pair. Rewrite streaming must not imply
   T2A streaming. Voice IDs, warmup and unrelated methods must not become universal
   requirements for every future adapter.
3. Replace hardcoded rewrite/T2A provider construction in `providers/index.js` with
   registered provider factories and wire the existing runtime construction through
   that registry. Preserve Ollama rewrite, both MiniMax rewrite protocols and
   MiniMax T2A, including existing configuration resolution and lifecycle selection.
4. Test registration, configuration precedence/defaults, unsupported selections,
   capability selection and error timing. A fake additional adapter must be usable
   through the same construction path without editing service validators or output
   writers. Run existing HTTP contracts and add focused coverage where needed.

The deliverable is production code using the registry, not unused definitions or
another documentation-only preparation stage. The production VPS does not deploy
it yet: development merges and production deployment are separate actions.

Preserve current public behavior, environment names/defaults, voice presets and
raw MiniMax controls. Do not change the providers, models, protocols or credential
mechanisms selected by an existing configuration. Do not add automatic fallback.
Google transcription remains on its current construction/workflow path in this
stage and must not initialize when disabled. Service-workflow extraction and
startup-state redesign are later stages; add their missing coverage before moving
those boundaries. Design configuration/lifecycle interfaces now so later work fits.

## Acceptance criteria

- Existing 238-test baseline passes on Node 22/24 with no newly skipped media checks;
  new tests are additional meaningful checks, not assertions that weaken old ones.
- Contracts distinguish public service fields from native metadata. T2A `provider`
  is opaque metadata, not a required provider identifier. MiniMax's corrected
  MP3/WAV/PCM metadata and nested-response behavior remain intact.
- Existing nine voice presets and raw MiniMax compatibility remain unchanged.
  Provider mapping documentation states intended language and speaker sex and
  native tuning/prompt/reference mapping. Tests verify payloads; listening checks
  are separate evidence. No raw-ID retirement or new unsupported-control policy
  is silently introduced.
- No public service/format disappears. No automatic fallback, new cloud integration,
  deployment, or consumer migration is included.
- The PR maps each affected baseline row to tests and identifies any newly exposed
  gap before proposing broader production wiring changes.

## Gates before later migrations

| Proposed later change | Evidence required before changing production flow |
|---|---|
| Step-2 rewrite/T2A factory wiring (required in this stage) | Tests for existing configuration precedence/defaults, unsupported selections, disabled-service initialization, capability selection, and unchanged error timing; run the HTTP contracts before completing step 2. |
| Transcription composition or provider selection | Add an actual-server success path with fake recognition (no live cloud), complementing current component tests. Preserve upload/media bounds, separate capacity, cancellation ownership, late-result discard and cleanup-before-success/failure latching. |
| Rewrite startup/lifecycle extraction | Add deterministic HTTP coverage of the `MODEL_WARMUP_STARTED` startup branch and relevant state transitions, supplementing existing on-demand/degraded/passive tests. |
| New T2A provider or raw-control policy | Specify supported formats, preset mappings and exact unsupported-control status/code/validation order. Keep current MiniMax consumers working; never silently substitute a voice. |
| Raw-ID retirement | Separate consumer migration evidence and explicit removal decision; no date or removal is implied here. |

The baseline is ready to support this working-code step 2 with its required wiring tests. It does not clear the later
migrations automatically. Use the [baseline](compatibility-baseline.md) and
[current audit](../reviews/2026-10-06-main-baseline-audit.md) as evidence; a future
PR that expands this scope must satisfy the relevant gate first.
