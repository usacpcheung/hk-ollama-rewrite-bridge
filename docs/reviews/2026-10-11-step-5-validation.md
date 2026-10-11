# Step 5 implementation and local validation

Scope: `codex/provider-completion-step5` based on PR #134 head
`59684ad870b95bad171972def978259ceb75fc20`. This is repository/cloud simulation
evidence, not a VPS deployment record. The PR records final commit and CI results.

## Changes reviewed

- Native model/options/env aliases and lifecycle settings now belong to provider
  readers/registrations. Production composes only selected native configuration.
- Rewrite lifecycle mode, availability and recovery error policy no longer depend
  on native provider-name branches in shared orchestration.
- T2A request policy is selected from registration. Shared validation rejects a
  valid but undeclared audio format without silently converting/substituting it.
- Transcription gets an env-selected registered provider and optional availability
  check, preserving upload/media/cancellation/deadline/cleanup ownership.
- Google adds model/language selectors within its existing V2 request protocol.
- Provider-keyed admission includes T2A-only integrations and normalizes new
  provider IDs to shell-compatible env prefixes. Built-in names are unchanged.
- Active references, roadmap, operator switching, provider authoring, preset mapping
  and retirement guidance reflect the implemented boundary.

## Validation

Local Node 24 full suite: **355 passed, zero failures or skips**, including real
FFmpeg and all 343 parent tests. Two existing test files change only internal
composition: lifecycle construction now uses the registration wrapper, and direct
Google factory tests receive the native provider config object. Public assertions
are retained. Twelve new Step 5 tests cover:

- Actual server environment selection of two alternative providers across rewrite,
  T2A and transcription; unchanged aliases/JSON/NDJSON/base64/binary contracts.
- Distinct native model values, description-based voices with language/sex intent,
  real PCM media preparation and unmodified transcription text.
- Missing credentials, validation/auth/origin ordering, no upstream calls on
  rejection, disabled transcription laziness and unknown selections.
- Selected-reader isolation, removed registration without fallback, invalid
  factory/config/lifecycle declarations and Google model/language validation.
- Concurrent warmup deduplication and instance isolation; unavailable providers
  never probe/warm; passive failure/recovery/cooldown with a new provider name.
- Unsupported valid audio formats rejected explicitly, including unavailable
  default MP3, while malformed formats retain INVALID_INPUT.
- Admission env overrides for a T2A-only provider and new model settings applied
  across fresh processes with independently selected rewrite/T2A providers.

The new availability HTTP test was additionally extended after the full run to
cover transcription auth/origin precedence and no-file rejection; the focused
extension suite was rerun. Final CI verifies the committed aggregate suite.

Additional actual-server simulations and curl checks:

| Scenario | Result |
|---|---|
| 80 concurrent mixed rewrite/T2A requests | Correct per-request payloads, voices/formats/results; upstream concurrency stayed within four slots. |
| 30 queued requests, 15 cancelled | Cancelled work never invoked; 15 completed; later requests recovered capacity. |
| Seven auth variations on one TCP connection | No identity inheritance; only authenticated requests invoked the provider. |
| Transcription disconnect with delayed SDK settlement | Same user rejected while active, other user served; capacity restored and files removed after settlement. |
| Eight adversarial transcription checks | Prior deadline/cleanup/storage fixes preserved, including 100 recognition races, media cancellation and authentication isolation. |
| 30 curl requests | 18 rewrite/T2A checks and 12 transcription checks passed across both aliases. |

Fixtures use local upstreams, synthetic credentials/media and mocked SDKs. The
extension preload belongs to tests; no production env flag loads arbitrary code.
The initial extension fixture assumed an incorrect PCM byte length; correcting it
to 19,200 bytes for 0.2 s × 24 kHz × stereo × 16-bit resolved that test-only failure.
The external adversarial script initially lacked module resolution from its scratch
directory; rerunning with the repository dependency path passed all eight cases.
Neither harness failure required weakening a production assertion.

## Review decisions and limits

Review caught a gap where audio-format descriptors were merely informational.
The shared T2A check and HTTP regression now enforce declared support. It also
ensures provider admission configuration includes T2A-only registrations; no native
route branch is needed to configure their pool.

No further confirmed defect remained from these local checks. This does not prove
absence of bugs or establish live OIDC session behavior, Google credentials/quota,
model/region/language availability, MiniMax protocols or acoustic voice quality.
Those remain Step 6 maintenance-window acceptance with existing production auth
and provider setup. The stack remains unmerged; no VPS changes were made.

Use the [current Step 5 design](../architecture/provider-abstraction-step-5.md),
[author/operator guide](../guides/adding-a-provider.md) and
[roadmap acceptance/rollback procedure](../architecture/provider-abstraction-roadmap.md).


## Corrective review checkpoint (2026-10-11)

A subsequent fault-injection review reproduced four defects on the original Step 5
head. The earlier no-further-defect statement describes that earlier test scope;
these findings and their corrections supersede it.

| Finding and trigger | Correction and regression evidence |
|---|---|
| A new adapter throws from availability/readiness/warmup, or returns a rejected asynchronous availability result. Unhandled failures could terminate the process. | Local availability checks validate their synchronous result, observe rejected promises and return sanitized `503 PROVIDER_UNAVAILABLE`. Active probe/warmup exceptions become controlled lifecycle failures. Actual HTTP tests verify auth precedence, both transcription aliases and continued health/rewrite/T2A operation. |
| Two readiness requests overlap and the older ready result arrives after a newer unavailable result. | Active lifecycle consumers share one in-flight probe; availability is checked again before accepting its result. Tests hold the native probe open across concurrent status/ready requests, check failure/recovery and change availability during the probe. |
| Parsing/provider work blocks the event loop beyond the invocation budget, before the timeout callback can run. Rewrite/T2A could accept a late result or stream frame. | A monotonic deadline starts after admission and is checked before invocation, before each emitted chunk and after settlement. Both rewrite providers/aliases and T2A aliases return timeout; HTTP streaming emits one timeout terminal event. Caller cancellation wins and unsettled provider work retains capacity. |
| A queue wait expires while its timeout callback is delayed, then a slot becomes free. | Expiry is checked at the slot handoff using a monotonic clock. Tests cover exact expiry, expired entries ahead of live work, observed cancellation, stale timers and repeated release without capacity leaks. |

The second review extended the elapsed-time guard to active readiness and warmup:
a blocked event loop cannot turn an expired probe/warmup into success. It also
covered late thrown provider errors and availability loss during an active probe.
These related cases are fixed in the same corrective change.

The regression suite adds 20 cases to the original 355-test baseline. The final
local Node 24 aggregate run passed **375 tests, zero failures or skips**, including
real FFmpeg. Final commit CI is recorded in the PR. The extra simulations were
rerun with these corrective boundaries: 12 scenarios passed (80 mixed requests,
30 queued/15 cancelled requests, reused-connection authentication isolation,
transcription late settlement/cleanup, storage failures and 100 recognition races).
All 30 curl checks passed again. The final readiness/warmup elapsed-time addition
is covered by the aggregate regression suite.

One initial HTTP availability regression hit `EPIPE` while streaming its FormData
body into an intentionally early connection-closing rejection. A targeted repeat
passed; that hook-containment fixture now uses a fully buffered valid multipart
body to avoid testing upload transport timing accidentally. Existing streaming
upload/cancellation tests remain intact. All 19 cases passed after this fixture
adjustment, before the final readiness/warmup test was added.

No further confirmed defect remained in this corrective review. The test boundary
is still local upstreams, synthetic identities and mocked SDKs, with real HTTP and
FFmpeg. No live OIDC/provider/VPS acceptance is claimed. A custom provider must
still implement bounded network operations and settle after cancellation: elapsed
checks reject late results but cannot interrupt a blocked JavaScript event loop or
force a never-settling adapter to finish. Capacity is deliberately retained until
native work settles. The stack remains open and the VPS unchanged.
