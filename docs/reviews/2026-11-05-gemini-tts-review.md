# Gemini TTS review and correction

Scope: PR #148 stacked on #147 (f9cb0de), including route validation, provider
registration/admission, credential waits, synthesis, conversion and response writing.
No paid calls, VPS changes or merges were performed.

## Reproduced defects

1. The repeated-group base64 regex could throw RangeError for a valid long audio
   response. A synthetic 120-second PCM16/24 kHz mono WAV (5.76 MB of samples)
   produced GEMINI_TTS_ERROR/502 despite being inside the documented size/duration
   limits. Replaced the regex with bounded decode/re-encode equality validation.
   This also rejects non-canonical padding and bytes Buffer would otherwise ignore.
   Added an adapter-level failing-before/passing-after regression.
2. The MP3 validator allowed 128 kbps at 8, 11.025 and 12 kHz, but libmp3lame
   produced 64 kbps instead. Requests now reject bitrates above 64 kbps for those
   rates before inference, with INVALID_INPUT/400. Existing higher-rate limits
   remain unchanged. Confirmed with real FFmpeg/FFprobe that all 81 accepted
   combinations preserve requested rate and bitrate. Documentation updated.

## Deeper review and simulations

- Shared credentials: timeout of one waiter, successful independent waiter,
  credential failure followed by recovery, and no automatic inference replay.
- HTTP: both aliases, both response modes, three formats, authentication,
  invalid/over-limit inputs, quota errors, timeout and admission recovery.
- Coexistence: concurrent Gemini rewrite/TTS with shared provider capacity.
- Disconnect: a real HTTP client cancellation closes the upstream request and
  allows a subsequent request through the same provider admission slot.
- Conversion: real FFmpeg outputs, process cancellation, nonexistent and
  permission-denied executables, output-byte limit and malformed WAV headers.
- Provider bodies: truncation, malformed base64, invalid WAV, oversized response
  cancellation, and elapsed-deadline precedence over late conversion failures.

The long-audio regression uses synthetic audio and a stub converter to isolate
base64 validation; real conversion is exercised separately. These tests do not
establish long-text model latency, pronunciation, real billing enforcement or
real credential refresh behavior. Those remain VPS acceptance items. Mandarin and
English presets still require listening confirmation. No further actionable issue
was identified in this review; this is not a guarantee of absence of defects.

## Final validation

- Node 24.19.0: 522 passed, 0 failed/skipped.
- Node 22.23.4: 522 passed, 0 failed/skipped.
- Focused TTS adapter/HTTP review suite: 38 passed.
- Real FFmpeg/FFprobe matrix: 81 supported MP3 combinations matched requested settings.
- Approved standalone Cantonese presets: seven exact voice/style matches.
- Production dependency audit: zero vulnerabilities; dependency lock unchanged.
- Changed-document local links and diff whitespace checks passed.
