// Test harness: install code-owned definitions before production composition loads.
// No production env flag loads plugins; this preload only belongs to the tests.
const definitions = require('../providers/registrations');
const { successResult, failureResult, streamTextEvent, streamDoneEvent } = require('../lib/bridge-contract');
const { VOICE_INTENTS } = require('../lib/t2a-voice-choices');
const controls = ['voice_id', 'language_boost', 'speed', 'volume', 'pitch'];
for (const name of ['fixture-a', 'fixture-b', 'fixture-passive', 'fixture-wav']) {
  for (const serviceId of ['rewrite', 't2a', 'transcription']) {
    definitions.push({ provider: name, serviceId,
      capabilities: { sync: true, streaming: serviceId === 'rewrite',
        lifecycle: serviceId !== 'rewrite' || name === 'fixture-a' ? 'none' : name === 'fixture-b' ? 'active_probe' : 'passive_remote',
        ...(serviceId === 't2a' ? { audioFormats: name === 'fixture-wav' ? ['wav'] : ['mp3', 'wav', 'pcm'], legacyVoiceControls: false } : {}) },
      readConfiguration: ({ env }) => ({ runtime: { model: env[`FIXTURE_${serviceId.toUpperCase()}_MODEL`] || 'default-model', timeoutMs: 1000 } }),
      availability: ({ env = process.env }) => env.FIXTURE_KEY ? null : { status: 503, code: 'FIXTURE_KEY_MISSING', message: 'Configure fixture key.' },
      lifecycleOptions: () => ({ readinessCacheMs: 0, warmupRetriggerWindowMs: 10, failureThreshold: 1,
        recoveryAttemptCooldownMs: 1000, failOpenOnIdle: false }),
      requestPolicy: { legacyFields: controls,
        validateControls: body => controls.some(k => Object.hasOwn(body || {}, k))
          ? { ok: false, status: 422, code: 'LEGACY_VOICE_UNSUPPORTED', message: 'Use voice_choice with this provider.' } : { ok: true, value: {} },
        supportsVoiceChoice: id => Boolean(VOICE_INTENTS[id]) },
      create: ({ serviceConfig }) => {
        let ready = false;
        const prefix = `${name}:${serviceConfig.provider.runtime.model}:`;
        const result = request => {
          if (request.text === 'FAIL') return failureResult({ status: 502, code: 'FIXTURE_FAILED', message: 'Failure.' });
          if (serviceId === 'rewrite') return successResult({ response: prefix + request.text });
          if (serviceId === 't2a') {
            const intent = VOICE_INTENTS[request.voiceSelection.id];
            const description = intent ? `${intent.language}:${intent.sex}` : 'default';
            return successResult({ output: { artifacts: [{ kind: 'audio', format: request.audio.format,
              data: Buffer.from(prefix + description + ':' + request.text) }] } });
          }
          const a = request.audio;
          if (a.encoding !== 'pcm_s16le' || a.sampleRate !== 24000 || a.channels !== 2 || a.content.length !== 19200) throw Error('incorrect preparation');
          return successResult({ response: prefix + 'unaltered 广东话' });
        };
        return { name, getInfo: () => ({ provider: name, model: serviceConfig.provider.runtime.model }),
          mapError: () => ({ status: 502, code: 'FIXTURE_FAILED', message: 'Failure.' }),
          checkReadiness: async () => ({ ready, error: null }),
          triggerWarmup: async () => { ready = true; return { ok: true }; },
          services: { [serviceId]: { sync: async request => result(request),
            ...(serviceId === 'rewrite' ? { stream: async request => {
              const response = result(request); if (!response.ok) return response;
              await request.onChunk(streamTextEvent({ text: response.data.output.text }));
              await request.onChunk(streamDoneEvent({ reason: 'stop' })); return response;
            } } : {}),
            ...(serviceId === 'transcription' ? { inputRequirements: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 2,
              delivery: 'inline', cancellation: 'abortable', maxDurationSeconds: 60, maxPreparedBytes: 4194304 } } : {})
          } }
        };
      }
    });
  }
}
