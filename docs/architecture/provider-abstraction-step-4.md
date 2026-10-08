# Step 4: production transcription provider boundary

Status: implemented on `codex/transcription-provider-step4`, stacked on PR #133
(`codex/service-provider-step3`, base `b14441891caa6e9f286c65865ecc1558f136a2a1`).
This describes the branch implementation, not a merged release or VPS deployment.
The [roadmap](provider-abstraction-roadmap.md) governs stacking and acceptance.

## Production flow and ownership

1. `server.js` composes transcription through
   [`configuration/transcription.js`](../../configuration/transcription.js). The
   existing env reader and Google defaults remain unchanged. Composition maps
   `googleMs` to neutral `recognitionMs`, removes native model/project/location/
   language fields from the service config and constructs the registered
   `google-speech/transcription` adapter through `providers/index.js`.
2. [`services/transcription.js`](../../services/transcription.js) retains auth-adjacent
   origin checks, per-user rate/admission, total admission, upload deadlines,
   conversion slots, private job directories, cleanup and the public response.
   It imports neither Google nor an environment reader. Disabled composition
   constructs no provider and never loads the Google SDK.
3. The adapter's `services.transcription.inputRequirements` is validated and
   copied into a frozen plan by
   [`lib/transcription-input-plan.js`](../../lib/transcription-input-plan.js).
   Service and provider caps combine by taking the smaller value.
4. [`lib/transcription-media.js`](../../lib/transcription-media.js) probes allowed
   uploaded containers/codecs, decodes bounded PCM and measures actual duration
   from sample count. It prepares the plan's output encoding/rate/channels.
   Prepared size is checked before loading the output into memory. Conversion
   retains a shared subprocess deadline and cancellation/kill/settlement behavior.
5. [`lib/transcription-recognition.js`](../../lib/transcription-recognition.js)
   validates prepared bytes/duration, invokes the common provider adapter,
   validates normalized results and discards late success. It awaits the native
   operation rather than racing its promise against cancellation.
6. Google owns ADC initialization/recovery, V2 request construction, native
   deadlines, transcript joining and error translation in
   [`providers/google-speech.js`](../../providers/google-speech.js). The service
   deletes audio before returning the existing JSON response.

Transcription intentionally retains its separate upload/conversion/admission
workflow. Registration shares construction and dispatch; it does not put audio
uploads in rewrite/T2A's provider-keyed queue or readiness lifecycle.

## Adapter contract

A registration needs `sync: true`, `streaming: false`, a factory, `mapError`, and
`services.transcription.sync`. The service handler declares:

```js
inputRequirements: {
  encoding: 'flac',          // flac | pcm_s16le | wav (16-bit PCM WAV)
  sampleRate: 16000,         // integer 8000..192000
  channels: 1,               // 1 | 2
  delivery: 'inline',
  cancellation: 'deadline-only', // abortable | deadline-only
  maxDurationSeconds: 60,
  maxPreparedBytes: 4 * 1024 * 1024
}
```

Caps must be positive finite values. The service caps remain the configured
maximum duration and 4 MiB of prepared audio; upload limits are independent.
Unsupported requirements fail at construction. Providers cannot supply shell
commands, paths, auth decisions or relaxed service limits.

Invocation receives:

```js
{
  requestId, timeoutMs, signal,
  audio: { content, durationSeconds, encoding, sampleRate, channels }
}
```

`content` is a Buffer. `pcm_s16le` has no container header. No temporary filename
is passed. The provider must settle only after work using the input has finished,
map native failures into `failureResult`, and return `successResult` with
`data.output.text`. Missing/non-string text or malformed result envelopes fail
with controlled 502 `TRANSCRIPTION_FAILED`; blank text is 422 `NO_SPEECH`.
Unexpected thrown native errors are sanitized. Failure results must contain a
valid 400–599 status, nonempty code and a safe message; adapter authors must never
copy sensitive native error text into that message.

Google uses FLAC/16000/mono, `chirp_3`, `yue-Hant-HK`, ADC and no automatic retries,
as before. Its direct-call `content` compatibility input remains supported;
production service dispatch uses the described `audio` object. Invalid native
Google result containers or transcript types fail instead of producing partial
success or treating malformed data as no speech. Legitimate empty results retain
`NO_SPEECH`.

## Cancellation, deadlines and resource ownership

The handler owns a total-operation AbortController. Recognition derives a child
signal with a deadline no greater than the provider timeout or remaining total
budget. Adapters receive both the signal and numeric timeout. The declaration
records capability; it never authorizes releasing resources just because abort
was requested.

- Before recognition, cancellation stops upload/conversion or removes a conversion
  waiter. No later provider call may start.
- An abortable adapter should cancel its native operation and settle after that
  cancellation completes. Admission remains held until then.
- A deadline-only adapter must apply the native deadline and await settlement.
  Google can abort initialization waiting but cannot cancel an issued recognition
  promise. Initialization is shared; one cancelled waiter does not retire a
  healthy client. Failed initialization permits a later fresh client.
- A recognition deadline requests abort and rejects late success after settlement.
  The total handler deadline still sends a prompt 504 even if native work has not
  settled. Do not use a detached `Promise.race` to free capacity early.
- Client disconnect, timeout and provider settlement cannot release capacity twice
  or write a second response. Per-user and total permits remain owned through
  outstanding work and cleanup, including after a timeout response.
- The job directory owns uploaded input, decoded PCM and prepared output. Success
  waits for deletion. Failure cleanup preserves the selected error; failed
  deletion latches storage failure, logs a safe code and blocks new admission.
  Existing dead-process startup cleanup remains unchanged.

An adapter which never settles despite its promised deadline retains admission;
this bounds concurrency but cannot recover the defective SDK operation. Adapter
contract tests and real-provider acceptance must verify deadline enforcement.

## Extension proof and remaining work

[`tests/transcription-boundary.test.js`](../../tests/transcription-boundary.test.js)
registers an alternative provider through the same factory/dispatch boundary and
runs real HTTP uploads and FFmpeg through the unchanged service workflow. It uses
WAV, raw PCM and FLAC at 8 kHz stereo, plus independently inspected 24 kHz stereo
WAV. It translates a different native result shape into the same public output.
Both cancellation declarations are tested for late settlement and retained capacity.

Adding a provider using these supported input modes requires an adapter,
registration, configuration integration, native translation tests and documentation.
Upload/auth/admission/HTTP response logic does not need provider-specific changes.
New transport modes such as remote URLs, streaming or asynchronous jobs require
an explicitly designed shared capability; this PR does not pretend to support them.

Step 5 still owns general env selection, credential/configuration guidance and
remaining lifecycle/readiness orchestration. No `TRANSCRIPTION_PROVIDER` setting
is added. Existing Google env settings remain valid. No live provider is added,
legacy voice controls are not retired, and rewrite/T2A formats remain unchanged.

## Validation and release gate

Retain the existing transcription/actual-server/media tests and full rewrite/T2A
suite. Additional tests cover alternate formats, stricter limits, invalid prepared
input/results, native response validation, auth/origin rejection, cancellation
while waiting for conversion, deadlines, native settlement ownership and recovery.
The [Step 4 review record](../reviews/2026-10-08-step-4-validation.md) records final
counts and simulations. Node 22/24 CI and manual curl checks are required.

Keep the PR stack open and the production version unchanged. Step 5 needs separate
authorization. Final maintenance-window VPS acceptance still checks real Google
credentials/quotas, OIDC/proxy sessions, worksheet behavior and operational cleanup.
