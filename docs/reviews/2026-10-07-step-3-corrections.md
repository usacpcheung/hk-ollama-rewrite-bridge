# Step-3 adversarial review and corrections

Review base: PR #133 at `e2d381584b54b5f624af52e88d592d2d1c19503c`, stacked on
PR #132 (`2dc8253ef4b85909c074216386fe6019f771eea9`). All four findings also
reproduced on the parent. The operator authorized fixes in the existing PR;
its base remains `codex/runtime-failure-corrections`. Nothing is merged or deployed.

## Confirmed findings and fixes

| Finding / reproduction | Correction | Regression evidence |
|---|---|---|
| A rewrite stream sends valid text, a non-string text field, then completion. Ollama, MiniMax legacy and Anthropic previously reported successful truncated output. | Reject malformed text/recognized delta containers and completion fields with a controlled terminal provider error. Preserve legitimate role/null-content metadata frames, reasoning events and unknown future event types. Streaming HTTP headers remain 200 once sent; the final NDJSON error carries status 502. | Both aliases, each native protocol, multiple malformed shapes and successful requests after failures in `tests/step3-review-regressions.test.js`; existing stream fault/usage/thinking/terminal tests remain intact. |
| An adapter returns a transcript artifact before WAV audio. Bytes come from the audio artifact but labels previously came from the transcript. | Resolve metadata from the selected audio artifact, with canonical MP3/WAV/PCM MIME labels. Reject unsupported/contradictory declarations before writing headers. Preserve legacy `meta.audio` priority without borrowing metadata from different artifact bytes. Global audio metadata can supplement artifact-only output; missing declarations retain the legacy MP3 default. | All three formats and both output modes; MIME-only/format-only declarations; conflicts, invalid types, malformed artifact lists and unrelated legacy bytes. |
| A registered class-based service handler uses private state or `this.client`. Direct invocation works, but shared dispatch loses its receiver and throws. | Bind service handlers to their owning handler object and legacy methods to their provider. Closures and already-bound methods remain supported. | Concurrent sync/streaming calls through two registered instances, frozen handlers, and direct legacy methods. |
| `{"text":"hello","speed":{"toString":"bad"}}` throws during numeric conversion and returns 500. The other numeric T2A fields have the same problem. | Catch failed numeric conversion and return existing field-specific 400 `INVALID_INPUT`. Preserve existing accepted numeric strings, coercion rules, omitted values, bounds and zero volume. | Both aliases × five fields × three malformed shapes, zero upstream calls, then a valid request with legacy numeric strings and volume zero. |

These corrections change defective behavior, not a desired compatibility feature.
No provider/model/env selection, voice mapping, authentication policy, retry policy,
transcription production workflow or public success field is changed.

## Additional simulations

Scratch simulations used the actual server with local upstreams and synthetic
credentials; scripts/logs were kept outside the checkout. They verified:

- 80 concurrent rewrite/T2A requests with out-of-order completion, distinct text,
  presets/raw voices, formats and results; observed upstream concurrency stayed at four.
- Seven requests on one keep-alive TCP connection, alternating valid users, missing
  authentication/cookie-only requests, wrong secret/domain and duplicate email headers.
  Only the two authorized requests reached the provider; identity did not carry over.
- Thirty queued requests behind two active calls: cancel fifteen, complete the rest,
  confirm cancelled requests never reached upstream, then verify both services recover.
- Upstream resets before/after response headers for rewrite and T2A, followed by
  successful recovery; the existing suite also covers stalled bodies and slow readers.
- Real-FFmpeg transcription with delayed mocked recognition: disconnect one user,
  retain that user's ownership until native settlement, admit another user, recover
  the first user afterward and leave no temporary files.
- 40,000 seeded old/new T2A input comparisons: 628 formerly throwing numeric cases
  now yield controlled validation errors; no other differences in validation/native
  payloads. Eleven thousand four hundred twenty inputs were accepted on both versions.

The repository suite adds eight regression tests with matrices inside them. The
final local Node 24 suite passed 321 tests without failures/skips; Node 22/24
CI results and final commit are recorded in PR #133. Eighteen actual-server curl
smoke checks passed across rewrite JSON/streaming/auth rejection and T2A
aliases/formats/output modes.

## Limits and next gate

No additional confirmed defect remained in the reviewed cases after correction.
Passing simulations do not establish absence of every race or malformed input.
Real browser/OIDC/Apache sessions, live provider credentials, acoustic quality and
production-duration endurance remain maintenance-window acceptance items.
Transcription migration is still step 4; configuration/lifecycle completion is
still step 5. Follow the [standing stack sequence](../architecture/provider-abstraction-roadmap.md#development-and-testing-sequence).
