# Merged-main documentation and baseline audit — 2026-10-06

## Scope and conclusion

Source of truth: freshly fetched main
`a50c47d150724820080a8e7d7861070b7a0ecc51`, after PRs #128, #129 and #127.
This is a new review of the merged tree, not an inference from those PRs' success.
The audit covers all 17 tracked Markdown documents and LICENSE. Source, tests,
configuration and example assets were inspected as evidence; only Markdown changes
are proposed. No live provider, deployed gateway or external consumer was inspected.

Current behavior and the corrected baseline agree, subject to the documentation
corrections below. The baseline is ready for the provider-registration/construction step
in [step 2](../architecture/provider-abstraction-step-2.md). It is not sufficient to
unconditionally approve transcription or startup-workflow extraction: the baseline
already identifies missing integration coverage for those changes.

## Document inventory and disposition

Paths below are relative to the repository root. “Keep” means valid/useful for its
stated scope, not a guarantee about live deployments or all possible inputs.

| Document | Decision | Code/evidence checked and result |
|---|---|---|
| `README.md` | Amend | Routes in `server.js`, provider selection, `lib/service-output-writer.js`, transcription lifecycle and corrected audio metadata match. Remove unsupported alias-expiry promise; link current audit/next-step scope. |
| `AGENTS.md` | Amend | All six aliases exist. Extend explicit preservation rules to transcription fields and lifecycle; reference coverage gates so its separate workflow is not overlooked. |
| `LICENSE` | Keep unchanged | Repository license is not a runtime plan; preserve its exact blob. |
| `docs/README.md` | Amend | Index all active references plus the baseline, next-step scope and this audit; distinguish the historical review. |
| `docs/reference/api-reference.md` | Amend | Checked parser/auth/limiter order, validators, output writers, MiniMax metadata normalization, Google error mapping and media/upload lifecycle. Add corrected 413 to endpoint error lists and clarify opaque T2A provider metadata. |
| `docs/reference/env-reference.md` | Amend | `lib/env-config.js`, service readers, `lib/transcription-config.js`, server lifecycle and script settings support the defaults/precedence. Readers contain no alias-expiry date/window; remove that claim. |
| `docs/guides/rewrite-t2a-api-calling-reference.md` | Amend | Validators and HTTP writers support the examples and modes. Correct remaining unconditional MP3-MIME fallback wording: the MiniMax adapter uses the requested format if declarations are absent. |
| `docs/guides/deployment-guide.md` | Amend | Source binds loopback; checked-in Apache omits T2A and comments out transcription; systemd uses hsadmin/workspace paths. Guide correctly requires adaptation. Remove alias-expiry promise. |
| `docs/guides/rewrite-widget.md` | Keep | `public/rewrite-widget/rewrite-widget.js`: async mount, shared poller, UTF-16 UI limit, cookies, rewrite-only UI. No Express static hosting. Deployment examples remain examples. |
| `docs/runbooks/auth-matrix-manual-cli-checklist.md` | Amend | `auth/header-auth.js`, identity resolver and server ordering match the matrix. Narrow “all routes” to service aliases: health/readiness have the separate ops limiter. |
| `docs/runbooks/transcription-deployment.md` | Keep | Google V2 config, strict logging settings, media allowlist, ADC initialization, private directories, deadlines and cleanup align with `services/transcription.js`, `providers/google-speech.js` and `lib/transcription-*`. External/cloud checks are clearly operational prerequisites, not repo-certified results. |
| `docs/architecture/runtime.md` | Keep; refresh reviewed commit | Registry contains rewrite/T2A only; provider factory/server still branch on native integrations; transcription owns separate workflow/capacity. Corrected parser/audio behavior remains accurate. |
| `docs/architecture/adr/0001-internal-bridge-contract.md` | Amend; retain active | `lib/bridge-contract.js`, adapter and writers implement these result shapes. Clarify that transcription uses its own HTTP handler, not the rewrite/T2A output writer. Accepted decision is still in force. |
| `docs/architecture/adr/0002-service-provider-runtime-boundary.md` | Keep; refresh reviewed commit | `services/index.js`, `providers/index.js`, runtime/invoker/lifecycle modules and server branches confirm partial implementation. It does not claim complete abstraction. |
| `docs/architecture/compatibility-baseline.md` | Amend | Source/test references exist; defects are corrected, not protected. Fix T2A `provider` description (metadata object/null, not identity selector), clarify ops limiting, record current commit and bounded readiness decision. |
| `docs/past/README.md` | Keep | Correctly identifies completed plans as historical, not implementation instructions. |
| `docs/past/plans/t2a-voice-choice-pr-plan.md` | Keep archived | All nine IDs/native mappings exist in `lib/t2a-voice-choices.js`, validation in `services/t2a.js` and HTTP mapping tests. Original plan body remains unchanged. Historical deployment/listening statements are explicitly not current verification. |
| `docs/reviews/2026-10-06-documentation-review.md` | Keep historical review | Dated evidence of earlier main snapshots and reconciliation, with supersession notice. `reviews/` holds audit history; it is not an active planning folder. Do not overwrite past findings with current behavior. |

The only retired implementation plan is already under `docs/past/plans/`.
No still-valid ADR or operational runbook should be archived simply because it is
old. The new step-2 scope is agreed future work under `architecture/`, explicitly
separated from implemented behavior. There is no need for another folder shuffle.

## Baseline checks and practical limits

- Traced real server composition: global JSON parser, trusted identity, baseline
  limiter, route-specific auth/limits, provider invocation, output writing and errors.
- Confirmed 413 `PAYLOAD_TOO_LARGE` and format/MIME/filename consistency, including
  nested/array audio metadata and controlled conflicting-declaration failures.
- Checked baseline test-title references against tracked tests. The HTTP fixture
  launches actual `server.js` with local mock upstreams; transcription success tests
  mount the service separately with an injected Google client/media conversion.
- Checked Google component error/cancellation/cleanup coverage and real media tests.
  These establish local contracts; they do not prove live recognition or voice quality.
- Verified that startup HTTP coverage includes on-demand recovery and degraded startup,
  but not `MODEL_WARMUP_STARTED`. This remains a gate before moving that branch.
- Existing workflow runs `npm test` on Node 22/24, with serial test files and FFmpeg
  installed. Passing counts alone do not establish exhaustive branch coverage.

There was no checked-in step-2 scope. The revised step-2 plan implements registered provider factories and wires existing
rewrite/T2A runtimes through them, with configuration/capability/conformance tests
and unchanged public behavior. Transcription composition, startup extraction and
voice retirement have explicit prerequisites. The six-stage roadmap separates
development merges from deployment; PR #130 itself remains documentation-only. This prevents “baseline ready” from being mistaken
for “all provider abstraction completed” or permission to move uncovered workflows.

## Validation record

See this audit PR's checks for the final Node 22/24 CI result. Local validation
results are recorded below. The reviewed source
commit above is immutable; the documentation-only PR naturally has a different SHA.

- `npm test`: 238 passed, zero failures/skips on Node 24; real FFmpeg tests ran.
- 234 local Markdown links/heading targets and 19 exact baseline test titles passed.
- 32 shell examples passed `bash -n`; operational/deployment commands were not run.
- Archived plan body and LICENSE are unchanged; all non-Markdown Git objects/modes
  match the reviewed main. No source, test, dependency, workflow or configuration edit.
- `git diff --check` passed. CI must pass on the audit PR before it is merged.
