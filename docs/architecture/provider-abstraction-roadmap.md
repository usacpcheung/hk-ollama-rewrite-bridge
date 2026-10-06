# Provider abstraction roadmap and production gates

Status: agreed sequence, recorded in PR #130 on 2026-10-06. This is a plan,
not a claim that the implementation or VPS acceptance has happened.

## Immediate boundary

Finish and merge the documentation/planning PR #130 first. The operator will then
update the VPS to that main commit, verify the existing services, and record the
exact deployed commit as the production base. Its deployment state is not known
from this repository. No step-2 implementation PR or later development stage is
authorized by this documentation update; wait for the operator's next instruction.

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
| 3 — service/provider separation | Native request/protocol/model handling and voice mappings live behind adapters; service validation/workflow and outputs retain their contracts. | Adapter and HTTP tests preserve existing formats, nine voice mappings and legacy raw controls. |
| 4 — transcription integration | Common provider-selection boundary without losing transcription's distinct upload, conversion, cancellation, cleanup and capacity ownership. | Add actual-server success coverage with fake recognition before changing composition; retain component/media/privacy/failure tests. |
| 5 — configuration/lifecycle and extension completion | Resolve remaining provider-specific orchestration, finish operator configuration guidance and prove contained adapter extension. | Cover startup MODEL_WARMUP_STARTED before extraction; configuration/restart, readiness, errors and extension checks pass. |
| 6 — VPS acceptance/release | Deploy and evaluate the completed candidate during a maintenance window using the existing gateway/provider setup. | Real integration acceptance passes or restore the recorded production base. |

A stage may require multiple PRs. Keep every merged stage working and reviewable.
Design configuration and lifecycle interfaces early, even when their implementation
finishes in stage 5. Preserve existing providers, configured models/protocols and
authentication mechanisms throughout the refactor. A new real cloud provider is a
separate integration task; use a fake adapter to test extensibility during refactoring.

## Development and testing sequence

After separate authorization to implement, create each incremental PR from updated
main, run relevant tests plus the full suite, review and merge, then start the next
stage. Sequential PRs against main are the default; do not keep the whole refactor
stacked on #130. Update affected API/env/design guidance with each implementation.

Production remains pinned while stages 2–5 proceed. VPS testing is not mandatory
after every stage. Local fixtures, HTTP tests and Node 22/24 CI provide incremental
checks; real FFmpeg coverage must not silently become skipped. Close any baseline
coverage gap before modifying the affected flow, rather than deferring it to stage 6.

Use an earlier VPS check only if a necessary SDK/authentication/runtime change
cannot be adequately verified locally. Decide and schedule it explicitly; do not
silently deploy intermediate main. A separate public staging/OIDC installation is
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
