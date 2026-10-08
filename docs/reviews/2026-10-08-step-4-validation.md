# Step 4 implementation review and validation

Date: 2026-10-08. Scope: transcription integration on
`codex/transcription-provider-step4`, based on PR #133 commit
`b14441891caa6e9f286c65865ecc1558f136a2a1`. This records repository/cloud tests;
it does not establish live VPS state. See the [architecture](../architecture/provider-abstraction-step-4.md).

## Implementation review

The Google selection moved from the service to configuration/composition and the
common registered provider factory. The service now consumes declared input
requirements, neutral recognition timeout/options and normalized transcript output.
Google owns model/language/project/region, ADC, native requests and errors. Shared
media preparation implements inline FLAC, WAV and PCM without accepting commands
or paths from an adapter. Existing Google output remains mono 16 kHz FLAC.

Review traced the whole affected request lifecycle: auth/origin checks, admission,
private upload, conversion queue, media subprocesses, recognition, response and
cleanup. The existing ownership structure was deliberately retained. No generic
race against the recognition promise releases permits on timeout. Normalized
results and prepared bytes are validated before success/provider invocation.
No public configuration settings, auth rules or routes changed.

Two boundary corrections are explicit rather than treated as compatibility:

- A native Google response such as `{ results: null }` previously became
  `422 NO_SPEECH` through truthy fallback. Invalid result containers and transcript
  types now return `502 TRANSCRIPTION_FAILED`. Legitimate missing/empty results
  still mean no speech; malformed arrays cannot yield partial success.
- Recognition checks elapsed time at settlement as well as the abort signal.
  An adapter returning after its deadline within a microtask turn cannot win
  merely because the timeout callback has not run yet. A deterministic clock test
  exercises this case. No late result is returned as successful transcription.

The new helper also rejects invalid normalized result envelopes and sanitizes
unexpected thrown exceptions. Adapters must translate native errors to safe
failure results; shared code cannot determine whether arbitrary adapter-authored
messages contain sensitive data.

## Automated coverage

The initial implementation included the parent branch's 321 tests plus 16 new
transcription boundary tests: **337 passed, zero failures/skips** on local Node 24. Tests include real FFmpeg, actual server composition
with a mocked Google SDK, and a registered alternative adapter on real HTTP routes.
The new cases cover:

- Real preparation and both HTTP aliases for WAV, raw PCM and FLAC at 8 kHz stereo;
  FFprobe independently verifies an additional 24 kHz stereo WAV case.
- Native request/response translation with unchanged public fields and text.
- Stricter provider duration/byte caps, malformed prepared input, rejected
  unsupported declarations and unchanged service ceilings.
- Authentication and origin rejection before adapter invocation.
- Both cancellation declarations: timeout response while files/permits remain
  held, late-success discard and successful recovery after native settlement.
- Abortable disconnect, repeated abort, conversion-waiter cancellation and a
  recognition deadline shorter than the total operation deadline.
- Ten simultaneous users with distinct signals/request IDs and out-of-order
  results; duplicate/excess rejection and cleanup.
- Malformed results, unexpected native exceptions, empty speech, normalized
  rate-limit errors, and healthy calls after errors.
- Google malformed native result shapes and already-aborted dispatch.
- Deadline expiration before the timer callback gets an event-loop turn.

The existing tests retain Google shared initialization/recovery and cancelled
waiters, ten-user concurrency, slow/truncated/oversized uploads, both aliases,
conversion limits, real browser media formats, missing/denied media executables,
cleanup failures and safe startup cleanup. Registry discovery and disabled
composition are tested with Google SDK loading prohibited.

## Additional cloud simulations

Re-ran actual-server simulations against this branch with controlled upstreams:

| Simulation | Result |
|---|---|
| Seven authentication variations over one keep-alive TCP connection | One socket; only the two authenticated requests reached the provider; no identity inheritance. |
| 80 mixed rewrite/T2A requests with out-of-order completion | All isolated responses/presets/formats matched; upstream concurrency stayed at or below four. |
| 30 queued requests behind occupied capacity; cancel 15 | Exactly 15 completed; cancelled work never reached upstream; both services recovered. |
| Real-media transcription with delayed fake Google recognition | Disconnected user's ownership stayed active (429); another user completed (200); original user recovered after settlement (200); zero leftover files. |
| 18 rewrite/T2A curl checks | Both aliases, rewrite JSON/stream/auth rejection, three audio formats and two output modes passed. |
| 12 transcription curl checks | Both aliases in enabled/disabled mode, missing auth, wrong multipart field, forbidden origin and successful real-media conversion passed; zero leftover files. |

The additional simulation scripts live outside the repository; committed regression
coverage is in `tests/transcription-boundary.test.js` and the existing suites.
All 305 local documentation links/anchors passed validation; archived original
plan content and the license remain unchanged. Node 22/24 CI is attached to the stacked PR. Consult its exact commit and check
results before using this branch as the next development base.

## Remaining limits and next gate

No further confirmed issue was found in the reviewed scope after these corrections.
This is not a proof of absence of race conditions or all provider SDK behavior.
No real credentials, paid recognition or VPS deployment were used. Real OIDC/proxy
sessions, Google credentials/quotas, worksheet integration and long-running
production behavior remain maintenance-window acceptance items.

A deadline-only adapter must enforce its native deadline and settle. If a defective
adapter never settles, the service retains its capacity/files rather than starting
unbounded replacement work. General provider configuration and remaining lifecycle
selection remain Step 5. The stack stays open/unmerged; future authorized increments
must use this Step 4 branch as their base. Production remains unchanged.


## Follow-up corrections after adversarial review

Review of commit `7867cc2` reproduced three issues, now corrected on the same PR:

| Issue and trigger | Correction |
|---|---|
| Failed recognition followed by slow deletion cleared the total timer before cleanup; a 120 ms request still had no response after 350 ms. Also reproduced on parent PR #133. | Keep the timer/listeners until cleanup settles. At the deadline send an already-selected error, or the usual timeout if none exists. Keep admission/file ownership until actual settlement; subsequent cleanup failure still blocks new admission. |
| Upload writes failing with ENOSPC/EACCES/EIO returned 400 INVALID_UPLOAD. Also reproduced on parent PR #133. | Classify known filesystem failures as 503 TRANSCRIPTION_UNAVAILABLE with Retry-After, and log only a fixed diagnostic code and allowlisted reason. Synchronous writer construction failures are also handled. Malformed multipart and interrupted input retain client-error behavior. |
| Rejected recognition skipped the elapsed-time check: a 10 ms budget with a 40 ms blocking/rejecting adapter returned 502. | Apply the same deadline check to both resolved and rejected operations, preserving prior cancellation. |

Six additional regression tests cover both aliases, blocked deletion, cleanup
failure after the response deadline, eight storage failure modes per alias,
post-failure recovery, synchronous/asynchronous rejection and cancellation precedence.
The new full-suite total is 343. Follow-up simulation and CI results are recorded
on the PR for its exact corrective commit; earlier counts above are historical.
