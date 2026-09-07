# Google Chirp 3 transcription deployment

This is an opt-in backend for completed worksheet recordings. The browser submits
one recording to the authenticated bridge, receives a transcript, then calls the
existing rewrite endpoint. The student reviews and edits before submitting.
There is no Python daemon, job polling API, automatic rewrite or worksheet UI in
this backend change. Keep the existing Whisper service stopped and disabled.

## Reviewed configuration

- Google Cloud Speech-to-Text **V2**, `chirp_3`, `us`, `yue-Hant-HK`.
- The initial VPS experiment succeeded with mono 16 kHz FLAC. Every upload is
  decoded and normalized to that format; declaring a MIME type does not bypass validation.
- Google lists US/EU multi-regions; its current Chirp 3 guide marks Cantonese as
  Preview. Actual project access must be checked before rollout. Google AI Studio
  keys/credits are not used for this Google Cloud service.
- Use Application Default Credentials (ADC) with the existing service account
  granted `roles/speech.client` on the configured project. Do not grant Owner or
  Editor. No bucket, named recognizer, or Google Files upload is required.
- Ten requests may be admitted at once, including uploads and processing; one
  active request per authenticated user. Two audio conversions run simultaneously.
  Remaining admitted requests wait for conversion, not for a serial transcription
  worker. Google quota and rewrite concurrency remain separate constraints.

Official references, checked 2026-09-06:
[Chirp 3 model and locations](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3),
[short audio recognition](https://docs.cloud.google.com/speech-to-text/docs/sync-recognize),
[quotas](https://docs.cloud.google.com/speech-to-text/docs/quotas),
[ADC configuration](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc).

## 1. Inspect and back up before deployment

Use a reviewed checkout of this PR. Preserve the currently deployed program,
package lock, environment file, systemd unit/drop-ins, and Apache configuration
in a root-only backup directory. Record the current commit and service state.
Do not switch a running production checkout to an unreviewed branch.

Inspect the real `rewrite-bridge.service` with `systemctl cat`: the repository's
generic unit example is not a replacement for the existing `/opt` deployment.
Check Node (`node --version`; use Node 22 or newer), `ffmpeg -version`,
`ffprobe -version`, available disk, and Google Cloud API/billing/IAM configuration.
On Ubuntu/Debian, install FFmpeg through the system package manager if absent:

```bash
sudo apt update
sudo apt install ffmpeg
```

The Node Google SDK and multipart parser are pinned in `package-lock.json`.
Deploy with `npm ci --ignore-scripts`; do not run `npm update` on the VPS.
Keep OS FFmpeg security updates current and repeat media tests after upgrades.

## 2. Private runtime directory and credentials

The following examples assume the existing service account is `rewrite-bridge`.
Adapt only after checking the live unit's User and Group:

```bash
sudo install -d -o rewrite-bridge -g rewrite-bridge -m 0700 /var/lib/rewrite-bridge/transcriptions
sudo install -d -o root -g rewrite-bridge -m 0750 /etc/rewrite-bridge
sudo install -o root -g rewrite-bridge -m 0640 \
  /home/administrator/.google-cloud-credentials/worksheet-speech-vps.json \
  /etc/rewrite-bridge/google-speech.json
```

The application must be able to read the service-account file, but cannot modify
it. Keep credentials outside the repository and never paste their contents into
logs or a PR. The original private administrator copy need not be changed.

## 3. Add opt-in configuration

Use `sudoedit /etc/default/rewrite-bridge` to add the following alongside the
existing settings. Preserve current auth and provider values. Keep the file
root-owned with mode 0600; systemd reads it before switching service identity.

```bash
TRANSCRIPTION_ENABLED=true
TRANSCRIPTION_GOOGLE_PROJECT=worksheet-chirp-test
TRANSCRIPTION_GOOGLE_LOCATION=us
TRANSCRIPTION_ALLOWED_ORIGINS=https://your-worksheet-host.example
GOOGLE_APPLICATION_CREDENTIALS=/etc/rewrite-bridge/google-speech.json
TRANSCRIPTION_TEMP_DIRECTORY=/var/lib/rewrite-bridge/transcriptions
TRANSCRIPTION_MAX_CONCURRENCY=10
TRANSCRIPTION_CONVERSION_CONCURRENCY=2
TRANSCRIPTION_REQUESTS_PER_MINUTE=6
REWRITE_MAX_TEXT_LENGTH=2000
REWRITE_MAX_COMPLETION_TOKENS=4096
```

Replace the example origin with the worksheet's actual HTTPS origin (scheme and
host, no path or trailing slash). Browser requests with an Origin header require
an exact configured match; cross-site browser requests are rejected. Server-side
smoke checks without an Origin header still require the usual bridge authentication.
No CORS access is granted to other sites.

Leave `GOOGLE_SDK_NODE_LOGGING` unset/empty. Enabling transcription with SDK
payload logging enabled fails configuration validation. Do not enable gRPC or
HTTP payload tracing. The bridge's rewrite provider debug setting does not enable
transcription logging. Do not log recordings or real transcripts in Apache, Node,
or an external monitoring service.

For the live systemd service, ensure `UMask=0077`. If its sandbox restricts writes,
allow `/var/lib/rewrite-bridge/transcriptions`. Confirm it can read the credential
path and execute FFmpeg/FFprobe. Preserve the existing loopback bind and unit
settings; there is no need to modify Whisper's unit. After installing reviewed
source and dependencies, reload the unit only if changed and restart the bridge.

## 4. Verify locally before exposing the route

1. Verify `rewrite-bridge.service` is active and existing rewrite/T2A smoke checks
   still work. `/healthz` and `/readyz` retain their existing semantics and do not
   prove Google connectivity.
2. An unauthenticated `POST http://127.0.0.1:3001/transcriptions` must return 401.
3. Run the explicit smoke helper with a non-sensitive test recording. It makes
   **one billable request**. In a privileged shell, load the bridge's trusted
   environment without printing it, set `TRANSCRIPTION_TEST_EMAIL` to an allowed
   test account, then execute:

```bash
node /opt/hk-ollama-rewrite-bridge/scripts/transcription-smoke.js /path/to/test-audio.m4a
```

Do not put the shared secret in command arguments or shell history. The helper
prints only status, timings and character count. Add `--show-transcript` only
when intentionally inspecting a non-sensitive transcript.

4. Test a 30-second and a near-60-second recording from each target browser.
   Encoder padding can extend decoded duration; the eventual UI should stop
   recording slightly before the server's strict 60-second boundary.
5. After individual success, explicitly run a small concurrent test using distinct
   test identities. Start with two, then ten only after checking quota and cost.
   Verify each response matches its own recording and record conversion and
   transcription timings separately. Requests above the configured total limit
   receive `503 TRANSCRIPTION_BUSY`; same-user overlap receives 429.
6. Verify the private directory is empty after completion, invalid uploads and
   cancellation. Restart cleanup removes only matching job directories for dead
   processes, and preserves live-process/unknown files. PID reuse can postpone
   stale-file removal; inspect any survivors manually while the service is stopped.

Tests use synthetic audio and a fake Google client; they establish local behavior,
not Cantonese accuracy, project quota or live-cloud latency. `npm test` runs media
checks when FFmpeg/FFprobe are available; CI installs both. On developer machines,
`TEST_FFMPEG_PATH` and `TEST_FFPROBE_PATH` can select test binaries.

## 5. Apache and worksheet integration checkpoint

Add these mappings within the existing protected namespace only after local
verification. The route must inherit the same OIDC policy, identity headers and
shared-secret injection as rewrite:

```apache
ProxyPass /api/rewrite-bridge/transcriptions http://127.0.0.1:3001/transcriptions timeout=210
ProxyPassReverse /api/rewrite-bridge/transcriptions http://127.0.0.1:3001/transcriptions
```

Review the live Apache upload limits, request-read timeouts and authentication
configuration before reloading (`apachectl configtest`). Allow 20 MiB audio plus
64 KiB multipart framing; limits that are smaller will reject before Node. Confirm
unauthenticated public requests cannot reach Google. Never expose port 3001.

The later worksheet client should retain the transcript, then call rewrite with
that text alone. Display uploading/transcribing/rewriting stages, prevent duplicate
submission, and preserve the original if rewrite fails. Do not automatically retry
ambiguous transcription timeouts: Google may already have processed and billed
the request. Cancellation/disconnection stops local work where possible; an
already-issued Google RPC is allowed to finish under its deadline and its result
is discarded. Admission remains held until it settles. This is not a billing undo.

The 2,000-character rewrite profile is distinct from an assignment's answer limit.
Retain an over-limit transcript for editing instead of silently clipping it.
Output-budget exhaustion handling for rewriting and worksheet UI are follow-up
work; a longer input allowance alone does not guarantee a complete rewrite.

## Costs, rollback and removal

Cloud requests are billed through Google Cloud, not the AI Studio prepaid balance.
Project budget alerts are not a hard spending stop. Admission and per-user rate
limits are process-local and reset on restart; they are not monthly cost caps.
Review billing/quota after acceptance tests and keep transcription disabled when
not in use. Student audio is sent to the configured US/EU region: confirm the
school's external-processing and retention requirements before student rollout.

To pause: set `TRANSCRIPTION_ENABLED=false` and restart the bridge. Existing
rewrite/T2A remain available. Remove the new Apache mapping if appropriate.
For rollback, restore the backed-up source and lockfile, run `npm ci --ignore-scripts`,
restore previous rewrite-limit settings, and restart; the old code cannot use a
2,000-character setting. Restore Apache/unit backups only if those were changed.

To remove permanently, first stop admission and wait for active requests to settle.
Inspect the dedicated runtime directory before deleting leftover audio. Remove
the dedicated credential copy and related env settings only after confirming
they are not used elsewhere; revoke its Google key only when it is no longer
needed by any test or service. Do not remove the independent Whisper installation.
