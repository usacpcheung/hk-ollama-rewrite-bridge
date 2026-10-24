# Gemini rewrite migration and administrator-selected policies

Status: accepted design, PR 1 documentation/evaluation fixtures only (2026-10-24).
No Gemini rewrite adapter or policy selector is implemented by this PR. Proposed
settings below must not be copied into production until their implementation and
acceptance are complete. [Current runtime](runtime.md) remains authoritative.

## Purpose and boundaries

Consolidate operations on Google Cloud one service at a time, starting with
rewriting, while improving Cantonese understanding and Hong Kong school register.
Keep the provider-agnostic architecture: service policy supplies instructions;
adapters translate native requests, authentication, results and errors. Gemini
selection must not change the public API or require worksheet changes.

Transcription already uses Google Speech; keep it unchanged. MiniMax T2A, all nine
voice presets, raw voice compatibility and current formats remain unchanged.
Google TTS migration is a separate future decision. No automatic provider fallback,
hot reload, provisioned capacity or custom exact-dollar accounting is included.

## Verified baseline and evidence limits

Repository base: `9bb1e59315eb959b0e2895bcfa7e02b50e81ebfc` (main after PRs
131–135, 136 and 138). The operator reported final VPS automated acceptance:
41 passed, zero failures/skips, successful worksheet web tests and zero npm audit
vulnerabilities. This is operator-reported deployment evidence from the prior
rollout, not a new inspection of the VPS. Recheck the actual running revision,
configuration and deployment automation before the next release.

During preparation the operator confirmed the generative API was enabled, the
VPS service identity had Speech Client and Vertex AI User roles, and one direct
VPS request to `gemini-3.8-flash` at `global` returned HTTP 200, STOP, 38 prompt and
9 candidate tokens with ON_DEMAND usage. This proves that request's access only;
it does not certify streaming, sustained quota or full language quality. Global
is not a Hong Kong data-residency guarantee. Reconfirm model lifecycle, pricing,
location and data-processing suitability before deployment.

## Administrator-only configuration contract (proposed)

| Setting | Intended meaning |
|---|---|
| `REWRITE_PROVIDER=google-gemini` | Select the new registered rewrite provider; retain existing provider default during migration |
| `REWRITE_GOOGLE_MODEL=gemini-3.8-flash` | Initial evaluated model; validate against implemented native protocol |
| `REWRITE_GOOGLE_PROJECT` | Operator's Google Cloud project |
| `REWRITE_GOOGLE_LOCATION=global` | Initial verified endpoint location |
| `REWRITE_POLICY=current-v1` | Exact existing production instruction text; initial default when absent |
| `REWRITE_POLICY=hk-school-v1` | Approved school policy in the linked specification |

Policy is resolved at startup and applies consistently until restart. Invalid
values fail startup with a clear configuration error. Public body/query/header
fields cannot select or override it. Preserve current unknown-field handling;
do not add an API parameter or accidentally reject previously tolerated fields.
A policy-like caller field has no effect. Log the policy ID, not submitted text.

Both policies are service-owned and available to compatible rewrite adapters.
Provider and policy selection are independent. Test each proposed rollback
combination; success with Gemini does not prove school-policy quality elsewhere.

Preserve current-v1 verbatim from `services/rewrite.js` at the baseline revision,
including instruction ordering and punctuation. Preserve existing OpenCC
postprocessing and JSON/NDJSON shapes. Prompt changes cannot alter auth, limits,
validation or output contracts. Existing APIs remain defined by the
[API reference](../reference/api-reference.md).

## Ordered PR stack

1. **PR 1 (this plan):** specification, 60 approved evaluation fixtures, rubric,
   administrator-only selection design, migration/rollback/retirement gates.
   Base latest verified main; no source, dependencies, tests or workflows changed.
2. **PR 2:** branch from and target PR 1's branch. Add lazy Gemini registration,
   configuration and ADC authentication, sync/stream translation, sanitized
   errors, cancellation/deadline/admission behaviour and compatibility tests.
   Keep existing prompt/default provider. Unselected Gemini must not require
   credentials or initialize its SDK. No paid startup probes or hidden retries.
3. **PR 3:** branch from and target PR 2's branch. Implement current-v1 and
   hk-school-v1, administrator configuration and a bounded offline evaluator.
   This PR must update API/env guidance and root README to distinguish the new
   supported configuration from unchanged public requests.

Future corrective increments stack on the latest open tip, never independently
on main. Verify ancestry and GitHub base each time; ask if unclear. Keep the stack
open until final maintenance-window acceptance and explicit merge approval.
Only PR 1 is authorized now; later implementation requires separate authorization.
The previous provider-abstraction stack is already merged and is not this stack's
parent. See the [original roadmap](provider-abstraction-roadmap.md) for history.

## Engineering and language acceptance

Run the full suite for implementation PRs, including real FFmpeg where available.
Add Gemini tests for JSON and streaming, final framing, usage, authentication,
quota/cap rejection, safety blocks, empty/malformed output, slow responses,
disconnects, elapsed deadlines, concurrency isolation and capacity recovery.
Do not expose provider reasoning as rewritten text. Treat cap/quota errors as
controlled failures without retrying or falling back to another paid provider.
A terminal truncation must not be reported as a complete successful rewrite.

Policy tests cover absent/current/school/invalid settings, caller attempts to
select policy, independent provider selection and restart behaviour. Verify
original current-v1 instructions exactly. Run regressions for existing providers,
TTS, transcription, auth and all route aliases and response formats.

Use the [evaluation protocol](../evaluation/README.md) and
[approved specification](../reference/hk-school-rewrite-specification.md).
Start with about ten varied cases, review, then execute all 60 with explicit paid
call authorization. Compare Gemini/current and Gemini/school on a bounded subset;
use existing-provider comparisons where useful and affordable. Full triple runs
are not mandatory. Human language acceptance is required; exact matching or an
LLM judge alone is insufficient. Rerun affected and previously passing cases after
policy revisions. No unresolved meaning failures at acceptance.

## Spending controls

Operator screenshots show a $1 monthly Vertex AI cap in Configured state and a
$2 alerts-only overall budget. The latter includes savings and appears billing-
account scoped; currency and precise scope should be reconfirmed. These are
reported controls, not settings managed by this repository. Cap alerts use
50/80/100%; the shown overall alerts use 50/90/100%.

Vertex AI cap does not cover Speech-to-Text. Enforcement is not instantaneous and
in-flight requests can accrue charges. There is no guaranteed combined $2 ceiling.
Do not disable project billing. Estimate evaluation costs using current prices,
including billable reasoning where applicable, and confirm remaining allowance
before each live batch. Rate, input, output and concurrency bounds supplement
billing controls. Do not implement a custom monthly ledger in these PRs.

References (recheck when deploying):
- [Google spend cap scope and limitations](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
- [Gemini model guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash)

## Maintenance rollout and rollback

Development and offline evaluation do not replace the running bridge or bind its
port. Paid evaluation shares project quota/budget. Before deployment, verify no
automatic pull/restart deployment will move production unexpectedly.

Record exact running commit/configuration; preserve source, dependency, systemd,
proxy and private-configuration backups with restrictive permissions and checksums.
Prepare exact release and configuration rollback commands before stopping service.
Update the acceptance launcher's pinned SHA and review provider-specific
assumptions; do not bypass its process/checksum guards.

Restrict traffic and drain active requests including transcription. Stop bridge,
deploy exact reviewed commit, install locked dependencies, select Gemini and the
accepted policy, and restart. This briefly interrupts all services in this process;
it is not a zero-downtime plan. Run automated acceptance and normal worksheet
OIDC/rewrite/TTS/transcription tests. On failure keep maintenance active and restore
configuration or the previous release/dependencies as appropriate. End maintenance
only after successful acceptance. With operator approval, merge PRs in order using
history-preserving merges and verify final main's file tree equals the tested tree.

## Observation and retirement

Keep current-v1 and the previous provider available for an operator-chosen period
of a few months; there is no automatic expiry. Preserve rollback credentials and
backups securely. Configuration rollback requires restart; release rollback must
restore dependencies as well as code/configuration.

Retirement requires a separate approved PR after reviewing production quality,
remaining users and rollback needs. Update default/migration documentation;
explicit selection of a removed ID must fail clearly, not silently switch policy.
Keep historical specifications/evaluation evidence. Remove compatibility code only
after inspecting its callers/tests. TTS migration is separately planned afterward.
