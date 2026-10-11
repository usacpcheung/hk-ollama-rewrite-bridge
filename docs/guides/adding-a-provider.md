# Adding, switching or retiring a provider

Operators configure implemented integrations. Provider developers implement new
integrations behind the service contracts. Both preserve the public API described
in the [API reference](../reference/api-reference.md).

## Operator: select an implemented provider

1. Check the registered pair and the provider's model/protocol/format/preset support.
   Built-ins are Ollama/rewrite, MiniMax/rewrite, MiniMax/T2A and
   Google Speech/transcription. There is no automatic failover.
2. Set `REWRITE_PROVIDER`, `T2A_PROVIDER` or `TRANSCRIPTION_PROVIDER` and that
   provider's documented settings from the [env reference](../reference/env-reference.md).
   Transcription additionally requires `TRANSCRIPTION_ENABLED=true`.
3. Supply credentials privately to the service process. Use Google ADC for Google;
   `MINIMAX_API_KEY` is shared by both MiniMax service integrations. Never send
   provider credentials/voice IDs to clients when a preset suffices.
4. Restart to apply settings. Model/protocol choices already implemented by an
   adapter require configuration and restart; a new protocol/SDK requires code
   and deployment. There is no configuration hot reload.
5. Check an authenticated request for each enabled service, not just `/readyz`.
   Check outputs, language/voice, format metadata and errors using non-sensitive
   input. Restore the previous settings/release if acceptance fails.

For example, an already configured Google deployment can explicitly retain:

```dotenv
TRANSCRIPTION_ENABLED=true
TRANSCRIPTION_PROVIDER=google-speech
TRANSCRIPTION_GOOGLE_MODEL=chirp_3
TRANSCRIPTION_GOOGLE_LANGUAGE=yue-Hant-HK
```

Project, region, ADC, origins and media/storage settings are still required as
applicable. Other Google model/language values pass syntax checks only; verify
V2 synchronous recognition, region/language support and quality before adoption.
A changed model identifier cannot enable an unimplemented calling method.

Unknown rewrite and enabled transcription selections fail startup. Unknown T2A
retains its historical request-time `501 UNSUPPORTED_PROVIDER` after validation.
Disabled transcription does not read its native settings or initialize its SDK.

## Developer: implement a provider/service registration

Add the adapter and native reader under `providers/`, then add one definition per
supported service to `providers/registrations.js`. Do not add native selection
branches to routes or shared service workflows. Names are stable lowercase IDs;
environment values select code-owned entries, never module paths. Provider-scoped
admission/streaming env suffixes uppercase the ID and replace non-alphanumeric
characters with underscores (`audio-only` → `AUDIO_ONLY_MAX_CONCURRENCY`).
Choose IDs with distinct env prefixes. Rewrite/T2A share a pool for the same ID;
transcription keeps its separate service limits.

```js
{
  provider: 'example',
  serviceId: 'rewrite',
  capabilities: { sync: true, streaming: false, lifecycle: 'none' },
  readConfiguration: ({ env }) => ({ runtime: readExampleSettings(env) }),
  availability: ({ env = process.env }) => env.EXAMPLE_API_KEY ? null : {
    status: 503, code: 'EXAMPLE_KEY_MISSING', message: 'Configure EXAMPLE_API_KEY.'
  },
  create: ({ serviceConfig, env = process.env }) => createExampleAdapter({
    ...serviceConfig.provider.runtime, apiKey: env.EXAMPLE_API_KEY
  })
}
```

This is a contract sketch, not a bundled provider. Readers must validate their
settings and return an object `runtime` (optional `sources` metadata). Keep secrets
out of source/diagnostic metadata. Factories are synchronous/lazy construction,
not paid health checks. Availability is a synchronous local configuration check:
return `null` or a controlled `{status, code, message}` with no secrets/network I/O.
It should not throw for ordinary missing configuration.

The adapter exposes `services[serviceId].sync`, `mapError`, optional `getInfo` and
`stream` exactly when declared. Use `lib/bridge-contract.js` result/events and
sanitized errors. Honor request `signal` and `timeoutMs`; do not add hidden retries
or release capacity while upstream work is still active. Native content is data,
not executable instructions for the bridge. Normalize actual audio format/bytes
and errors before they reach output writers.

Choose `none`, `active_probe` or `passive_remote` for rewrite. `active_probe`
requires `checkReadiness` and `triggerWarmup` methods returning controlled results;
probes must honor timeouts, catch ordinary transport failures and must not throw
unhandled rejections into status endpoints. `lifecycleOptions({env})` returns
validated neutral cache/probe/warmup or passive grace/threshold/cooldown settings.
An optional `reasons` object/recovery error builder can preserve public native
compatibility codes. Refer to `providers/configuration/lifecycle.js` for built-ins.
Non-rewrite services do not acquire a new readiness gate by declaring a mode;
keep their service-specific admission/deadline rules.

### Service requirements

| Service | Provider responsibilities | Shared behavior retained |
|---|---|---|
| Rewrite | Translate text/instructions/output budget to native prompts; normalize text/usage/stream events/errors; declare lifecycle | Validation, auth, OpenCC processing, NDJSON output, admission/deadlines |
| T2A | `requestPolicy`, preset/default/legacy translation, audio artifacts and declared `audioFormats` | Text/audio validation, voice intent, aliases, binary/base64 output |
| Transcription | Native config with positive `timeoutMs`, `inputRequirements`, recognition/errors and cancellation contract | Auth/origin, upload/media limits, preparation, deadlines, cleanup and capacity ownership |

T2A `requestPolicy` supplies `validateControls(body)`, `supportsVoiceChoice(id)` and
`legacyFields`. Validation returns `{ok:true,value:{...}}` or a controlled
`{ok:false,status,code,message}`. `voice_choice` is neutral intent, not a native ID.
For every supported preset, document its language, speaker sex, native voice ID
or prompt, model/options and all other mapped parameters. A mapping declaration
cannot prove acoustic correctness: test native payloads and listen during live
acceptance. Unsupported presets return `422 VOICE_CHOICE_UNSUPPORTED`.

Raw `voice_id`, language boost, speed, volume and pitch remain MiniMax compatibility
controls. A description-based provider can reject their presence with a clear
controlled error (for example `422 LEGACY_VOICE_UNSUPPORTED`) and document migration
to `voice_choice`. Do not fabricate native IDs, silently ignore controls or silently
select a different language/sex. Declare actual MP3/WAV/PCM support; unsupported
valid formats receive `422 AUDIO_FORMAT_UNSUPPORTED`, including default MP3 if
that adapter cannot produce it. Any conversion needed must be explicitly designed.

Transcription supports inline FLAC/WAV/PCM and the validated bounds in
`lib/transcription-input-plan.js`. Declare abortable or deadline-only recognition
accurately. A timeout/disconnect may end the HTTP response before an SDK settles;
capacity remains held through settlement and cleanup. Do not apply rewrite text
normalization to transcripts. See [Step 4](../architecture/provider-abstraction-step-4.md)
for full media/result/cancellation contracts. New transport modes require design.

### Extension acceptance

Test native translation plus actual HTTP paths for selected env configuration,
model/options, missing credentials, invalid configuration, malformed results,
timeout/disconnect, and capability rejection. Test unrelated services with different
providers to prove isolation. For transcription run real FFmpeg and verify cleanup;
for streaming verify exactly one terminal event. Keep all existing public contract
assertions. Use the test-only registrations in `test-support/step5-providers.cjs`
as an extension example, never as production integration or acoustic evidence.

Adding a new service still needs its own definition, public request/output contract,
route/auth/rate/admission policy and tests; registration does not publish endpoints.

## Retirement and safe switching

1. Inventory deployed settings and client use of provider-specific raw controls.
   Announce replacement capabilities, unsupported formats/presets and migration.
2. Implement/test the replacement, switch through a controlled restart and verify
   all affected consumers (including the worksheet). Keep the old release/config
   available for rollback. Never remap an old raw ID silently.
3. Remove the old registration and provider-only code/docs only after migration.
   Remove one service pair without breaking other pairs using that provider.
4. Test old selections fail explicitly at the documented startup/request boundary,
   unrelated services still work and credentials are no longer required for the
   unselected/removed integration. Do not add automatic fallback.

Legacy MiniMax raw voice controls are **not retired** by Step 5. Their future removal
requires a separate compatibility decision and migration notice. The refactor only
ensures that new providers need not implement that legacy contract.
