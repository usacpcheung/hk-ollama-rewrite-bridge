# Provider abstraction roadmap and production gates

Status: sequence recorded in PR #130, amended in PR #132 on 2026-10-07 to keep
the refactor stacked until VPS acceptance and operator approval. This is a plan,
not a claim that the implementation or VPS acceptance has happened.

## Immediate boundary

PR #130 was merged as `668e68e4e9ad72760b28bdc5b901e4d8659a249d`.
The operator planned to verify that commit on the VPS and pin it as production;
this repository does not establish whether that deployment occurred. Step-2 PR
creation was subsequently authorized. Step 2 and its corrective work are in open
PRs #131/#132. Step 3 was separately authorized and is implemented on the stacked
`codex/service-provider-step3` branch. Step 4 was subsequently authorized and is
implemented on `codex/transcription-provider-step4`; deployment and stages 5–6
remain separate actions.

Use an immutable commit or release as the production base, not a moving branch.
Retain the previously working VPS version until this base passes acceptance.
Before refactor development starts, confirm that merges into main do not trigger
auto-deployment: inspect the actual VPS pull/restart jobs or external automation.
The repository's test workflow alone cannot establish that no such automation exists.

## Six stages

| Stage | Working deliverable | Gate before proceeding |
|---|---|---|
| 1 — baseline (completed in repository) | Compatibility tests, defect corrections and reconciled documentation; PR #130 records the audit and plan. | Existing 238 tests pass; operator independently verifies and records the VPS production base. |
| 2 — provider registration/construction | Explicit per-service capabilities and registered provider factories actually used by rewrite/T2A runtime construction. | Registry/configuration/error-timing tests, fake-adapter extension test and HTTP regression suite. See [step 2](provider-abstraction-step-2.md). |
| 3 — service/provider separation | Rewrite/T2A native requests and voice mappings live behind adapters. Define contracts for all three services, including transcription audio requirements and cancellation. See [step 3](provider-abstraction-step-3.md). | Alternative rewrite/description-voice adapters, transcription contract proofs and HTTP tests preserve existing formats, nine voice mappings and legacy raw controls. Production transcription migration remains step 4. |
| 4 — transcription integration | Registered provider construction and production audio/recognition contracts, preserving transcription's distinct upload, conversion, cancellation, cleanup and capacity ownership. See [step 4](provider-abstraction-step-4.md). | Retain/extend actual-server success coverage with fake recognition added in PR #132; preserve component/media/privacy/failure tests. |
| 5 — configuration/lifecycle and extension completion | Resolve remaining provider-specific orchestration, finish operator configuration guidance and prove contained adapter extension. | Retain/extend startup MODEL_WARMUP_STARTED coverage added in PR #132; configuration/restart, readiness, errors and extension checks pass. |
| 6 — VPS acceptance/release | Deploy and evaluate the completed candidate during a maintenance window using the existing gateway/provider setup. | Real integration acceptance passes or restore the recorded production base. |

A stage may require multiple PRs. Keep every incremental branch working and reviewable.
Design configuration and lifecycle interfaces early, even when their implementation
finishes in stage 5. Preserve existing providers, configured models/protocols and
authentication mechanisms throughout the refactor. A new real cloud provider is a
separate integration task; use a fake adapter to test extensibility during refactoring.

## Development and testing sequence

After separate authorization to implement, create each incremental refactor PR from
and against the latest PR branch in the stack, not main. The current sequence is
`main → #131 (codex/provider-registry-step2) → #132 (codex/runtime-failure-corrections)
→ #133 (codex/service-provider-step3) → step 4 (codex/transcription-provider-step4)`;
the step-4 PR uses #133's branch as its base, and the next authorized increment
must use the step-4 branch. This is a standing rule
for all subsequent refactor increments, including corrective PRs, until acceptance.
PR #130 is already merged and is not the stack parent.

Keep the entire stack open and unmerged while development and testing proceed.
Run relevant tests, the full suite and Node 22/24 CI, and review each increment before
building the next one. Update affected API/env/design guidance in the same PR.
Before creating a PR, check the latest remote stack tip and verify both the branch
ancestry and GitHub base. Ask the operator if the intended base is unclear or a
change to this sequence is proposed; do not silently start from main.

The latest stack tip contains all preceding changes. Select its exact commit for
stage-6 VPS testing during the agreed maintenance window, retaining the approved
production baseline for rollback. Only after successful VPS acceptance and explicit
operator approval, merge oldest to newest. Update each remaining PR's base to the
appropriate surviving parent or updated main, resolve conflicts and recheck its diff
and CI before merging. If the tested candidate changes, repeat affected acceptance
checks and obtain approval for the revised candidate before release.

Production remains pinned while stages 2–5 proceed. VPS testing is not mandatory
after every stage. Local fixtures, HTTP tests and Node 22/24 CI provide incremental
checks; real FFmpeg coverage must not silently become skipped. Close any baseline
coverage gap before modifying the affected flow, rather than deferring it to stage 6.

Use an earlier VPS check only if a necessary SDK/authentication/runtime change
cannot be adequately verified locally. Decide and schedule it explicitly; do not
silently deploy an intermediate refactor branch. A separate public staging/OIDC installation is
not required by this plan. A private isolated instance remains an optional alternative.

## VPS acceptance and rollback

Before the stage-6 maintenance window:

- Select the exact candidate commit after stages 2–5 and CI pass. Record its lockfile,
  runtime prerequisites, required environment changes and acceptance checklist.
- Back up the currently working source/release, lockfile, private configuration,
  systemd unit/drop-ins and proxy configuration securely. Do not copy secrets into
  Git or review logs. Confirm the old configuration still works with the old version.
- Prepare a repeatable restoration procedure and budget time for it. Stop new work
  and allow admitted requests to settle before switching, especially transcription.

During the window, keep existing OIDC/proxy/auth configuration unless an explicitly
reviewed change requires otherwise. Use non-sensitive test input and controlled
real-provider calls. Check all enabled services through the existing public path:
rewrite JSON/streaming where enabled; T2A presets, legacy controls and binary/JSON
formats; transcription upload/result/cleanup and worksheet flow where deployed.
Check authentication, configuration selection after restart, readiness, invalid or
unsupported selection behavior, logs and response metadata. Follow the existing
[deployment guide](../guides/deployment-guide.md) and
[transcription checkpoints](../runbooks/transcription-deployment.md).

Accept the candidate only when required workflows and operator checks pass. If any
required check fails, stop new work, drain in-flight requests, restore the previous
source, compatible configuration and dependencies from its lockfile, restart, and
verify the previous service. Do not repair the candidate by ad hoc production edits.
Retain the baseline and backups until the new release is accepted.

Record candidate/base SHAs, test results, configuration changes (without secrets),
and the acceptance or rollback decision. CI success is evidence of local contracts,
not proof of live OIDC, provider access, voice quality or worksheet behavior.
