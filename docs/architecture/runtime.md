# Current runtime and request flows

Reviewed against main `2a453d040506b909ada41842eed3f7b2347dbf82` on 2026-10-06. This describes code in the repository, not the live deployment. See the [API reference](../reference/api-reference.md) and [environment reference](../reference/env-reference.md) for external contracts and settings.

## Startup

[`server.js`](../../server.js) creates an Express listener at the fixed address `127.0.0.1:3001`. It loads the rewrite/T2A definitions from [`services/index.js`](../../services/index.js), constructs their runtimes through [`lib/service-runtime.js`](../../lib/service-runtime.js), and independently creates transcription through [`services/transcription.js`](../../services/transcription.js).

The rewrite/T2A runtimes contain the service, provider name, adapter, capabilities, timeouts and lifecycle. Rewrite defaults to Ollama; MiniMax can use legacy chat or the opt-in Anthropic Messages interface. T2A supports only MiniMax and defaults to `speech-2.6-hd`. Transcription is disabled unless explicitly enabled; its Google V2 profile is `chirp_3` / `yue-Hant-HK` in configured `us` or `eu`.

Provider lifecycle wiring is implemented, but startup state and several provider-specific decisions remain in `server.js`. [ADR 0002](adr/0002-service-provider-runtime-boundary.md) records this partial boundary.

## Shared middleware and trust

For matching JSON requests, the 16 KiB parser runs first. Client identity resolution follows, then the baseline limiter for non-ops routes. `/healthz` and `/readyz` instead use the ops limiter. `/model-status` uses the baseline limiter. These diagnostics routes have no backend header-auth middleware; their public protection comes from the proxy.

[`auth/header-auth.js`](../../auth/header-auth.js) checks the bridge secret, non-empty normalized email, comma rejection and allowed domain suffix. It does not validate OIDC tokens or check the source-address list. [`auth/client-identity.js`](../../auth/client-identity.js) separately requires a trusted socket address and matching bridge secret before accepting identity headers for a `user:*` limiter key; otherwise it uses `ip:*`. The first non-empty, non-comma-separated email/user/subject header wins. Keep loopback binding and gateway header stripping as the deployment boundary.

The “global” request policy is a baseline per resolved identity, not an aggregate request budget across users. State is process-local.

## Rewrite

Both `/rewrite` and `/api/rewrite` run the rewrite limiter, shared auth, then:

1. [`services/rewrite.js`](../../services/rewrite.js) trims and validates text, counts Unicode code points, selects streaming capability and builds provider prompts.
2. `server.js` applies rewrite readiness/warmup/recovery gates and selects ready/cold timeout. Ollama uses active readiness probes and warmup; MiniMax uses passive state based on API-key presence and observed requests, without synthetic paid probes.
3. [`lib/service-invoker.js`](../../lib/service-invoker.js) acquires admission by provider, invokes the adapter's sync/stream handler, and records lifecycle success/failure.
4. [`providers/ollama.js`](../../providers/ollama.js) or [`providers/minimax.js`](../../providers/minimax.js) parses transport responses into the [internal contract](adr/0001-internal-bridge-contract.md).
5. [`lib/service-output-writer.js`](../../lib/service-output-writer.js) applies HK Traditional Chinese conversion and writes public JSON or NDJSON. Rewrite JSON contains `ok`, `result` and optional `usage`; internal artifacts are not exposed.

`/readyz` and `/model-status` describe this rewrite lifecycle. Neither proves T2A or Google connectivity, nor guarantees the next request succeeds.

## T2A

Both `/t2a` and `/api/t2a` run the T2A limiter and shared auth. [`services/t2a.js`](../../services/t2a.js) rejects streaming, trims/validates text and controls, and resolves either raw voice settings or the complete preset from [`lib/t2a-voice-choices.js`](../../lib/t2a-voice-choices.js). A choice cannot be mixed with raw voice controls, even null ones.

The route checks supported provider/key, invokes through the shared admission/invocation path, and writes raw bytes or base64 JSON. T2A's lifecycle is a no-op; it does not consult rewrite readiness before invocation. The MiniMax adapter sends native settings, not `voice_choice`, and does not write audio to disk.

The current adapter always labels output `format` as MP3 although requested format is forwarded and bytes are unchanged. MIME values can reflect upstream metadata. This limitation is documented in the [API reference](../reference/api-reference.md#current-audio-format-metadata-limitation).

[`lib/admission-controller.js`](../../lib/admission-controller.js) has counters and queues per provider. Rewrite and T2A share a pool if both use MiniMax. Ollama and MiniMax have separate pools; `ADMISSION_*` supplies each pool's defaults, not a total process limit.

## Transcription

After the shared JSON parser and baseline limiter, both `/transcriptions` and `/api/transcriptions` set `Cache-Control: no-store`, run shared auth, then transcription middleware. Earlier parser/baseline-limiter rejections do not receive that header. Disabled mode returns 503 after auth. Enabled mode has its own limiter and handler:

1. Check allowed Origin / `Sec-Fetch-Site`, storage, one-active-request-per-authenticated-email and total admission capacity before receiving audio.
2. Create a private job directory and enforce exact multipart field `audio`, byte limit and receive deadline in [`lib/transcription-upload.js`](../../lib/transcription-upload.js).
3. Wait for a bounded conversion slot, probe actual media, reject unsupported content and enforce decoded duration. [`lib/transcription-media.js`](../../lib/transcription-media.js) normalizes accepted audio to mono 16 kHz FLAC with FFmpeg/FFprobe.
4. [`providers/google-speech.js`](../../providers/google-speech.js) uses ADC and the shared provider adapter for a V2 synchronous recognition request. Calls can run concurrently; retries are disabled.
5. Join recognized segments, delete audio, then return transcript/duration/request ID/timings. The caller may separately submit the transcript to rewrite; no automatic rewrite or job history exists.

Disconnects/deadlines abort local work. Once issued, the Google promise can settle later under its RPC deadline; admission remains occupied until settlement and late results are discarded. A response timeout does not undo billing.

A deletion failure blocks further admission in that process. Failed final cleanup logs a code and can leave files. [`lib/transcription-files.js`](../../lib/transcription-files.js) removes only matching dead-process job directories at startup. Operators must inspect survivors rather than assume deletion always succeeded.

## Widget and deployment examples

[`public/rewrite-widget/rewrite-widget.js`](../../public/rewrite-widget/rewrite-widget.js) calls the public rewrite/status namespace with cookies. `mount()` is asynchronous, the default UI limit is 100 UTF-16 code units, and the shared poller controls button readiness. It has no T2A/transcription UI. `server.js` has no static-file middleware; serve the assets through a frontend web server as in the [widget guide](../guides/rewrite-widget.md).

[`apache/proxy-snippet.conf`](../../apache/proxy-snippet.conf) is a configuration example, not proof of active routes. It protects the API namespace with OIDC, maps rewrite/status/health, comments out transcription and omits T2A. [`systemd/rewrite-bridge.service`](../../systemd/rewrite-bridge.service) uses `hsadmin` and `/workspace` paths; adapt the installed unit to the chosen account and checkout.

## Validation evidence

The existing tests cover request contracts, configuration, auth/identity, per-service limiters, provider lifecycle, admission, voice mappings, output writing and transcription/media behavior. The 2026-10-06 review ran `npm test` under Node 24.19.0: 203 passed, zero failures/skips, including real FFmpeg normalization. These local checks use mocked cloud providers and synthetic media; they do not establish deployment state or live recognition/speech quality.
