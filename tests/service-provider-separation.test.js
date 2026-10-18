const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRegistry } = require('../lib/provider-registry');
const { createProvider, createProviderLifecycle } = require('../providers');
const { createProviderAdapter } = require('../lib/provider-adapter');
const { createServiceRuntimes } = require('../lib/service-runtime');
const { invokeServiceSync, invokeServiceStream } = require('../lib/service-invoker');
const { createServiceRegistry } = require('../services');
const { createRewriteServiceDefinition } = require('../services/rewrite');
const { createT2AServiceDefinition } = require('../services/t2a');
const { resolveRewriteConfig } = require('../configuration/rewrite');
const { resolveT2AConfig } = require('../configuration/t2a');
const { VOICE_INTENTS } = require('../lib/t2a-voice-choices');
const { successResult, failureResult, streamTextEvent, streamDoneEvent } = require('../lib/bridge-contract');
const { writeRewriteJsonSuccess, writeT2AOutput } = require('../lib/service-output-writer');
const { planTranscriptionInput } = require('../lib/transcription-input-plan');
const { createGoogleSpeechProvider } = require('../providers/google-speech');
const parse = (raw, fallback) => raw == null ? fallback : Number(raw);
const options = { env: {}, parseEnvBoundedInteger: parse, parseEnvMilliseconds: parse };
const error = () => ({ code: 'PROVIDER_ERROR', status: 502, message: 'Fixture failure' });
const response = () => ({ status() { return this; }, json(value) { this.body = value; } });
function runtime(service, definition) {
  const registry = createProviderRegistry([definition]);
  return createServiceRuntimes({ serviceRegistry: { list: () => [service] },
    createProvider: options => createProvider(options, registry), createProviderAdapter,
    createLifecycle: createProviderLifecycle }).get(service.id);
}
async function invoke(runtime, payload, signal) {
  return invokeServiceSync({ runtime, payload, requestId: 'contract-test', timeoutMs: 1234, signal,
    executeWithAdmission: async ({ execute }) => execute() });
}
test('alternate rewrite protocol consumes service intent without native request fields', async () => {
  const config = resolveRewriteConfig(options);
  config.provider = 'fixture'; config.providers.fixture = { model: 'alternate' };
  const service = createRewriteServiceDefinition({ config });
  let native;
  const r = runtime(service, { provider: 'fixture', serviceId: 'rewrite', capabilities: { sync: true, streaming: false },
    create: () => ({ name: 'fixture', mapError: error, services: { rewrite: { sync: async request => {
      assert.equal('prompt' in request, false); assert.equal('userContent' in request, false);
      native = { task: request.instructions, input: request.text, budget: request.outputBudget };
      return successResult({ response: '头发', usage: { tokens: 3 } });
    } } } }) });
  const validated = service.validateRequest({ body: { text: ' 保留 $& ' } });
  const result = await invoke(r, service.buildRequest(validated.value));
  assert.equal(native.input, '保留 $&'); assert.equal(native.budget, 300);
  assert.match(native.task, /保留原意/);
  const res = response();
  writeRewriteJsonSuccess({ res, service, response: result.data.response, usage: result.data.usage });
  assert.deepEqual(res.body, { ok: true, result: '頭髮', usage: { tokens: 3 } });
});
test('description-based T2A adapter supports presets without voice IDs or lifecycle methods', async () => {
  const config = resolveT2AConfig(options);
  config.provider = 'described'; config.providerSupported = true; config.providers.described = { model: 'descriptive' };
  const policy = { legacyFields: ['voice_id', 'language_boost', 'speed', 'volume', 'pitch'],
    validateControls: body => ['voice_id', 'language_boost', 'speed', 'volume', 'pitch'].some(key => Object.hasOwn(body, key))
      ? { ok: false, status: 422, code: 'LEGACY_VOICE_CONTROLS_UNSUPPORTED', message: 'Use voice_choice with this provider' }
      : { ok: true, value: {} }, supportsVoiceChoice: id => id === 'english_narrator_female' };
  const service = createT2AServiceDefinition({ config, requestPolicy: policy });
  let description;
  const r = runtime(service, { provider: 'described', serviceId: 't2a', capabilities: { sync: true, streaming: false, legacyVoiceControls: false },
    create: () => ({ name: 'described', mapError: error, services: { t2a: { sync: async request => {
      assert.equal('voice' in request, false); assert.equal('languageBoost' in request, false);
      const intent = VOICE_INTENTS[request.voiceSelection.id];
      description = `Speak ${intent.language} with a ${intent.sex} narrator voice.`;
      return successResult({ output: { text: '', artifacts: [{ kind: 'audio', data: Buffer.from('fixture audio'), format: 'wav', contentType: 'audio/wav' }] } });
    } } } }) });
  const validated = service.validateRequest({ body: { text: 'Hello', voice_choice: 'english_narrator_female', format: 'wav', response_mode: 'base64_json' } });
  assert.equal(validated.ok, true);
  const result = await invoke(r, service.buildRequest(validated.value));
  assert.equal(description, 'Speak en with a female narrator voice.');
  const res = response(); writeT2AOutput({ res, output: result.data.output, responseMode: validated.value.responseMode });
  assert.equal(res.body.format, 'wav'); assert.equal(res.body.ok, true);
  assert.equal(service.validateRequest({ body: { text: 'test', voice_choice: 'cantonese_male_1' } }).code, 'VOICE_CHOICE_UNSUPPORTED');
  assert.equal(service.validateRequest({ body: { text: 'test', voice_choice: 'english_narrator_female', voice_id: null } }).code, 'LEGACY_VOICE_CONTROLS_UNSUPPORTED');
});
test('transcription contract supports Google and different audio requirements without relaxing service limits', async () => {
  const limits = { maxDurationSeconds: 60, maxPreparedBytes: 4 * 1024 * 1024 };
  const google = planTranscriptionInput({ limits, requirements: { ...limits, encoding: 'flac', sampleRate: 16000, channels: 1, delivery: 'inline', cancellation: 'deadline-only' } });
  const alternate = planTranscriptionInput({ limits, requirements: { maxDurationSeconds: 30, maxPreparedBytes: 100 * 1024 * 1024, encoding: 'pcm_s16le', sampleRate: 48000, channels: 2, delivery: 'inline', cancellation: 'abortable' } });
  assert.equal(alternate.maxDurationSeconds, 30); assert.equal(alternate.maxPreparedBytes, limits.maxPreparedBytes);
  assert.equal(google.sampleRate, 16000); assert.equal(alternate.sampleRate, 48000);
  assert.throws(() => planTranscriptionInput({ limits, requirements: { ...google, delivery: 'async-job' } }), /Unsupported/);
  let captured;
  const native = createGoogleSpeechProvider({ project: 'fixture-project', location: 'us', model: 'chirp_3', language: 'yue-Hant-HK' },
    { createClient: () => ({ initialize: async () => {}, recognize: async request => { captured = request; return [{ results: [{ alternatives: [{ transcript: '原文' }] }] }]; } }) });
  const content = Buffer.from('prepared fixture'); const signal = new AbortController().signal;
  const result = await createProviderAdapter(native).invokeSync({ serviceId: 'transcription', payload: { content }, timeoutMs: 1000, signal });
  assert.equal(result.data.response, '原文'); assert.equal(captured.content, content); assert.equal(captured.config.model, 'chirp_3');
  const fake = createProviderAdapter({ name: 'alternate', mapError: error, services: { transcription: { sync: async request => {
    assert.equal(request.audio.encoding, 'pcm_s16le'); assert.equal(request.signal, signal);
    return successResult({ response: 'unchanged transcript' });
  } } } });
  const other = await fake.invokeSync({ serviceId: 'transcription', payload: { content, audio: alternate }, signal, timeoutMs: 1000 });
  assert.equal(other.data.response, 'unchanged transcript');
});
test('new service registration reuses runtime/invocation without editing existing service definitions', async () => {
  const service = { id: 'classify-fixture', provider: { selected: 'fixture' }, capabilities: { streaming: false },
    validateRequest: ({ body }) => ({ ok: true, value: { text: body.text } }), buildRequest: value => value };
  const services = createServiceRegistry({ ...options, additionalServices: [service] });
  assert.deepEqual(services.list().map(s => s.id), ['rewrite', 't2a', 'classify-fixture']);
  for (const extra of [{ id: 'rewrite' }, { id: '' }, { id: ' invalid ' }]) {
    assert.throws(() => createServiceRegistry({ ...options, additionalServices: [extra] }), /Service IDs/);
  }
  const r = runtime(services.get(service.id), { provider: 'fixture', serviceId: service.id, capabilities: { sync: true, streaming: false },
    create: () => ({ name: 'fixture', mapError: error, services: { [service.id]: { sync: async () => successResult({ output: { text: 'category-a' } }) } } }) });
  assert.equal((await invoke(r, { text: 'test' })).data.output.text, 'category-a');
});

test('transcription adapter cancellation retains capacity until native work settles and discards late success', async () => {
  const { createAdmissionController } = require('../lib/admission-controller');
  for (const cancellation of ['abortable', 'deadline-only']) {
    const admission = createAdmissionController({ globalLimits: { maxConcurrency: 1, maxQueueSize: 0 } });
    const controller = new AbortController();
    const reason = new Error('Contract deadline expired');
    let settle, started;
    const entered = new Promise(resolve => { started = resolve; });
    const adapter = createProviderAdapter({ name: 'fixture', mapError: error,
      services: { transcription: { sync: ({ signal }) => new Promise((resolve, reject) => {
        settle = () => resolve(successResult({ response: 'late text' }));
        if (cancellation === 'abortable') signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      }) } } });
    const pending = invokeServiceSync({ runtime: { providerName: 'fixture', service: { id: 'transcription' }, adapter },
      signal: controller.signal, timeoutMs: 1000,
      executeWithAdmission: async ({ providerName, signal, execute }) => {
        const ticket = await admission.acquire({ providerName, signal });
        try { return await execute(); } finally { ticket.release(); }
      } });
    const rejected = assert.rejects(pending, err => err === reason);
    await entered;
    controller.abort(reason);
    if (cancellation === 'deadline-only') {
      assert.equal(admission.getState().inFlight, 1);
      await assert.rejects(admission.acquire({ providerName: 'fixture' }), { code: 'ADMISSION_OVERLOADED' });
      settle();
    }
    await rejected;
    assert.equal(admission.getState().inFlight, 0);
  }
});

test('MiniMax compatibility applies native defaults and rejects unknown voice selection modes', () => {
  const { resolveMinimaxSpeechRequest } = require('../providers/minimax-t2a-compatibility');
  const defaults = resolveT2AConfig(options).providers.minimax.defaults;
  const request = { voiceSelection: { kind: 'default' }, audio: { format: 'wav' } };
  const native = resolveMinimaxSpeechRequest(request, defaults);
  assert.equal(native.languageBoost, 'Chinese,Yue');
  assert.equal(native.voice.voiceId, defaults.voiceId);
  assert.equal(native.audio.format, 'wav');
  assert.equal(resolveMinimaxSpeechRequest({ ...request, voiceSelection: { kind: 'legacy', controls: { volume: 0, languageBoost: 'English' } } }, defaults).voice.volume, 0);
  assert.throws(() => resolveMinimaxSpeechRequest({ ...request, voiceSelection: { kind: 'unknown' } }, defaults), /Unsupported voice selection/);
});


test('alternate rewrite streaming and errors use the shared result/event contract', async () => {
  const config = resolveRewriteConfig(options);
  config.provider = 'fixture';
  config.selectedProviderStreamingEnabled = true;
  config.providers.fixture = { model: 'alternate', capabilities: { streaming: true } };
  const service = createRewriteServiceDefinition({ config });
  const r = runtime(service, {
    provider: 'fixture', serviceId: 'rewrite', capabilities: { sync: true, streaming: true },
    create: () => ({ name: 'fixture', mapError: error, services: { rewrite: {
      sync: async () => failureResult({ code: 'FIXTURE_UNAVAILABLE', status: 503, message: 'Try again' }),
      stream: async request => {
        assert.equal(request.text, 'source');
        assert.equal(request.outputBudget, 300);
        assert.equal(request.timeoutMs, 1000);
        await request.onChunk(streamTextEvent({ text: '头发' }));
        await request.onChunk(streamDoneEvent({ reason: 'stop', usage: { tokens: 2 } }));
        return successResult({ response: '头发', usage: { tokens: 2 }, doneReason: 'stop' });
      }
    } } })
  });
  const payload = service.buildRequest(service.validateRequest({ body: { text: 'source' } }).value);
  const events = [];
  const result = await invokeServiceStream({ runtime: r, payload, timeoutMs: 1000,
    onChunk: async event => events.push(event), executeWithAdmission: async ({ execute }) => execute() });
  assert.equal(result.data.output.text, '头发');
  assert.deepEqual(events.map(event => event.type), ['text', 'done']);
  assert.equal(events[1].usage.tokens, 2);
  assert.deepEqual((await invoke(r, payload)).error, { code: 'FIXTURE_UNAVAILABLE', status: 503, message: 'Try again' });
});
