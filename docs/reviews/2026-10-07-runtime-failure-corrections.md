# Runtime failure corrections — 2026-10-07

This corrective branch is based on main `668e68e4e9ad72760b28bdc5b901e4d8659a249d`.
It fixes existing defects reproduced on main and step-2 PR #131. The registry's
prototype-method copying defect is fixed separately in #131; the six runtime
corrections here can be reviewed without the registry implementation. No deployment
or live-provider verification is implied.

## Corrected behavior

| Reproduction before correction | Corrected behavior | Evidence |
|---|---|---|
| Disconnect a queued T2A client while rewrite holds MiniMax capacity: abandoned work still reaches upstream. Disconnect an active client: upstream continues occupying admission. | Remove cancelled queue entries, forward caller abort to fetch/SDK, check cancellation again after admission, retain active admission until settlement, skip health accounting for cancelled callers. | `tests/runtime-failures-http.test.js`, `tests/runtime-failure-units.test.js` |
| Malformed MiniMax legacy SSE or EOF before completion produces successful `done`. | Invalid data frames and missing completion are controlled errors; comments/keepalives and valid UTF-8 fragments remain supported. | HTTP fault tests and `tests/provider-stream-faults.test.js` |
| `[DONE]` followed by text emits text after completion; a socket left open after completion retains capacity. | Terminal state stops upstream reading; writer suppresses trailing events. Also corrected in Ollama and Anthropic streaming. Final-message fallback, combined delta/finish frames, and terminal usage are preserved. | HTTP tests across all three rewrite protocols |
| `res.write(false)` is ignored, so a paused client can accumulate output. | Await drain with caller/provider cancellation, 30s maximum wait, and 1 MiB pending output guard. Native parser pending input is capped at 1 MiB. Closed/blocked sockets are destroyed when error delivery is impossible. | Real paused HTTP socket test, blocked-callback deadline tests, listener cleanup and oversized-input tests |
| Partial JSON then timeout returns invalid-provider-response 502. | Preserve abort reason; return 504 `MODEL_TIMEOUT`. Ollama's readiness JSON-read timeout is preserved too. | MiniMax rewrite/T2A, Ollama and Anthropic actual-server deadline cases |
| T2A upstream 401/403 with HTML loses the provider-auth error code. | Check HTTP status before parsing the response body; retain sanitized `PROVIDER_AUTH_ERROR`. | JSON/HTML × 401/403/429/500 × rewrite/T2A HTTP matrix |

Cancellation is best effort. The bridge cannot undo billing or guarantee that a remote
service honors transport cancellation. Shared Ollama readiness/warmup work keeps its
existing bounded lifecycle; cancellation prevents a disconnected caller's subsequent
inference/admission work, rather than cancelling shared startup work for other callers.

## Coverage added

- Real server, local upstream fault injection and synthetic credentials; no paid calls.
- Concurrent rewrite/T2A execution, queued and active disconnects, overload recovery,
  timeouts before headers and during JSON reads, malformed/truncated/late streams,
  and isolation of authentication failures from upstream calls.
- Fifty admission race rounds with 500 queued operations, double-release checks,
  cancel/timeout listener cleanup, and active work that ignores cancellation until
  explicitly settled.
- Real paused output socket, per-provider blocked-output deadlines, fragmented UTF-8,
  terminal cleanup and oversized upstream frames.
- Full `server.js` transcription success on both aliases with real FFmpeg and a
  preloaded mock Google SDK, provider permission/quota/deadline errors, denied
  FFmpeg execution, stalled uploads and cleanup before/after failures.
- Full-server `MODEL_WARMUP_STARTED` plus retry metadata on both aliases.

The Google SDK preload is test-only, selected explicitly by the fixture's child
process. Production code has no SDK-injection switch. All fault fixtures use the
existing production composition and localhost-only binding.

## Validation and limits

Final suite counts, Node 22/24 CI results and combined-branch verification are
recorded in the PR description. The earlier audit's 238-test count remains a
historical checkpoint, not the count for this corrective branch.

Local simulations do not certify real OIDC/Apache sessions, provider permissions,
production proxy settings, speech quality, billing cancellation, or long-duration
production load. The planned VPS acceptance remains a separate operator action.
