# Provider abstraction — step 2 scope and acceptance gates

Status: proposed next implementation scope, not implemented by this document.
Based on merged main `a50c47d150724820080a8e7d7861070b7a0ecc51` (2026-10-06).
The repository previously recorded the baseline and long-term goal but no explicit
step-2 implementation scope. This document bounds the next PR; it does not claim
that an earlier implementation or approval completed the abstraction.

## Target and current boundary

Keep existing rewrite, T2A and transcription services and public formats. Service
logic owns validation and workflow; adapters own native requests, protocol/model
handling and response normalization. Existing output contracts remain the consumer
boundary. Selecting an implemented provider/model should eventually use documented
environment settings plus restart; a new upstream protocol still needs adapter code.

Today rewrite/T2A have a service registry, hardcoded provider factory and shared
invoker/output writer. Transcription constructs Google independently and owns its
upload/conversion/cancellation/cleanup lifecycle. See [runtime](runtime.md) and
[ADR 0002](adr/0002-service-provider-runtime-boundary.md). Output normalization
already exists, but it is not proof of complete provider interchangeability.

## Recommended next PR: explicit internal contracts and capabilities

Define and test the extension boundary before moving route workflows:

1. Specify service/provider contracts for sync and optional streaming invocation,
   normalized text/audio output, controlled errors, configuration ownership, and
   optional lifecycle hooks. Reuse `lib/bridge-contract.js` and the existing adapter
   where possible rather than creating a parallel result model.
2. Define capabilities per service/provider pair. A provider's rewrite streaming
   support must not imply T2A streaming. Distinguish invocation support, lifecycle
   support, supported output formats and optional legacy voice controls. Avoid
   requiring voice IDs, warmup, streaming or unrelated methods of every adapter.
3. Describe existing integrations with testable definitions: Ollama rewrite;
   MiniMax rewrite (legacy and Anthropic protocols) and T2A; Google transcription.
   Describing Google must not yet reroute its production lifecycle through the
   rewrite/T2A registry or initialize its client while transcription is disabled.
4. Add contract/conformance tests using local fixtures or fake providers. Prove
   supported and unsupported combinations explicitly. A fake new provider should
   satisfy the intended contract without editing service validators/output writers.
   This tests the proposed boundary, not a claim of production plugin discovery.

Keep existing production dispatch and workflow behavior during this contract-first
PR. Wiring the definitions into construction/configuration is a later, separately
reviewed migration. Do not introduce new public env selectors until implemented
and documented, change current unsupported-provider timing/status, or add fallback.
This bounded start is intentionally smaller than completing the whole abstraction.

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
| Provider factory/configuration wiring | Tests for existing configuration precedence/defaults, unsupported selections, disabled-service initialization, capability selection, and unchanged error timing; run the HTTP contracts. |
| Transcription composition or provider selection | Add an actual-server success path with fake recognition (no live cloud), complementing current component tests. Preserve upload/media bounds, separate capacity, cancellation ownership, late-result discard and cleanup-before-success/failure latching. |
| Rewrite startup/lifecycle extraction | Add deterministic HTTP coverage of the `MODEL_WARMUP_STARTED` startup branch and relevant state transitions, supplementing existing on-demand/degraded/passive tests. |
| New T2A provider or raw-control policy | Specify supported formats, preset mappings and exact unsupported-control status/code/validation order. Keep current MiniMax consumers working; never silently substitute a voice. |
| Raw-ID retirement | Separate consumer migration evidence and explicit removal decision; no date or removal is implied here. |

The baseline is ready to support this bounded step 2. It does not clear the later
migrations automatically. Use the [baseline](compatibility-baseline.md) and
[current audit](../reviews/2026-10-06-main-baseline-audit.md) as evidence; a future
PR that expands this scope must satisfy the relevant gate first.
