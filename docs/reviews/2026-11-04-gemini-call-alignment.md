# Gemini API-call alignment — 2026-11-04

Base: #140 at `d6dfcd198ea713c1430d07b80e3088bf6ecb1f19`.
This increment stacks on `codex/gemini-rewrite-provider`, not main. No production
configuration change, live provider call or merge is part of implementation.

## Before and after

- The old adapter sent raw input and omitted temperature. It now matches the
  diagnostic's user prefix and explicit temperature 0.15. Service-owned policy
  text is passed unchanged; no semantic policy is copied into the provider.
- The wire generation configuration matches the diagnostic: temperature,
  maxOutputTokens from the server budget, LOW thinking. Removed redundant explicit
  candidateCount=1; response decoding still requires exactly one candidate.
- global maps to aiplatform.googleapis.com with locations/global and the selected
  Gemini model. us/eu and malformed location values fail before credentials/network.
  Regional ID syntax remains available, without claiming model/region support.
- Missing model/location settings retain defaults; explicit empty settings fail.
- Added monotonic elapsed-time checks around asynchronous boundaries so late
  credentials or response completion cannot succeed just because the timer callback
  has not run. Shared cancellation and sanitized error envelopes remain intact.

## Deliberate diagnostic differences

The direct diagnostic uses fresh HTTPS HTTP/1.1 connections (`agent:false`). The
bridge retains Node fetch and its connection management: replacing transport is
not justified by the measured data and would enlarge the cancellation/streaming
change. Real-fetch stalled-body tests and subsequent VPS acceptance are required;
no claim of identical connection reuse or latency is made.

The diagnostic authenticates separately before its inference timer; the bridge's
invocation budget includes credential waiting, preserving a bounded user-facing
wait. Admission queue, proxy and browser deadlines are separate. ADC is lazy and
coalesced; SDK-managed credential caching/refresh remains in google-auth-library.
Credential failure recovery tests use synthetic tokens and do not prove a real
service account's future expiry/refresh behavior. No inference retry is added.

The bridge retains strict terminal validation, a 1 MiB response bound, redirects
rejected, sanitized errors, and service-owned quote/OpenCC processing. The direct
quality report does not include every one of these bridge behaviors.

## Validation and remaining acceptance

Focused tests assert exact URL, operation, authorization/content-type headers and
payload for JSON and streaming; location/empty configuration validation; late
credentials; stalled real-fetch bodies including reasoning-only SSE; successive
credential results without inference replay; and all three service policies on
both public aliases with concurrent JSON/stream calls and ignored caller settings.
Retained MiniMax-M3/Anthropic/adaptive settings do not affect Gemini requests.
Quote tests preserve literal input quotations while allowing normal OpenCC outside
them. Existing T2A, transcription, authentication and provider tests remain required.

Full suite/audit results are recorded in the PR. Live bridge/VPS acceptance is
pending: keep MiniMax production unchanged, test the candidate on MiniMax first,
then Gemini global with policyB/4096/60000ms and streaming enabled; demonstrate
configuration rollback. Model quotation changes and ambiguous meaning remain
language-review concerns. No code can guarantee improved provider availability.

## Follow-up review and corrections

Two confirmed adapter defects were reproduced before correction:

1. **Late rejected operations bypassed elapsed deadline classification.** A fetch
   rejection after the invocation budget, with the timer callback delayed by event
   loop work, returned GEMINI_ERROR/502 rather than MODEL_TIMEOUT/504. The catch
   path now checks the same monotonic deadline as the success path before mapping
   errors. Reproductions cover both JSON and streaming with a deliberately delayed
   transport rejection; no inference retry is introduced.
2. **Interrupted response bodies were misclassified as malformed content.** Native
   fetch throws TypeError when the peer drops a connection during body reading.
   The adapter previously classified every such TypeError as invalid Gemini data.
   UTF-8 decoding errors are now caught at the decoder itself, while connection
   errors remain GEMINI_ERROR/502. Loopback servers reproduce a socket reset after
   headers/partial content, for both JSON and SSE. Invalid UTF-8 still yields
   GEMINI_INVALID_RESPONSE, and incomplete streams never emit successful done.

The broader pass covers concurrent credential waiters with independent cancellation,
quota errors with never-ending bodies, response cleanup, public HTTP authentication/
quota/connection errors and admission recovery. Production and external providers
are not involved in these simulations. These fixes improve error accuracy; they
cannot eliminate upstream latency or connection failures.
