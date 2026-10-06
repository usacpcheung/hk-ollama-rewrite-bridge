const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createProviderRegistry } = require('../lib/provider-registry');
const { createProvider, providerRegistry, createProviderLifecycle } = require('../providers');
const { createServiceRegistry } = require('../services');
const { createServiceRuntimes } = require('../lib/service-runtime');
const { createProviderAdapter } = require('../lib/provider-adapter');
const { invokeServiceSync } = require('../lib/service-invoker');
const { writeT2AOutput } = require('../lib/service-output-writer');
const { successResult } = require('../lib/bridge-contract');
const parse = (raw, fallback) => raw === undefined ? fallback : Number(raw);

function definition(overrides = {}) {
  return { provider: 'fixture', serviceId: 't2a', capabilities: { sync: true, streaming: false },
    create: () => ({ services: { t2a: { sync: async () => successResult({ response: '' }) } },
      mapError: () => ({ status: 502, code: 'PROVIDER_ERROR', message: 'fixture failure' }) }), ...overrides };
}

test('registrations are lazy, reject duplicates, and isolate frozen per-service capabilities', () => {
  let calls = 0;
  const capabilities = { sync: true, streaming: false, audioFormats: ['wav'] };
  const entry = definition({ capabilities, create: () => { calls++; throw new Error('factory called'); } });
  const registry = createProviderRegistry([entry]);
  capabilities.audioFormats.push('mp3');
  capabilities.streaming = true;
  const caps = registry.capabilitiesFor('t2a');
  assert.equal(caps.fixture.streaming, false);
  assert.deepEqual(caps.fixture.audioFormats, ['wav']);
  assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps.fixture));
  assert.throws(() => caps.fixture.audioFormats.push('pcm'), TypeError);
  assert.deepEqual(registry.capabilitiesFor('rewrite'), {});
  assert.equal(calls, 0);
  assert.throws(() => createProviderRegistry([entry, entry]), /Duplicate provider registration/);
  assert.throws(() => createProviderRegistry([definition({ create: null })]), TypeError);
  assert.throws(() => registry.create({ serviceConfig: { id: 'rewrite', provider: { selected: 'fixture' } } }), /Unregistered/);
  assert.equal(calls, 0);
});

test('declared sync and stream support must have callable factory handlers', () => {
  for (const create of [() => null, () => ({ services: { t2a: {} }, mapError() {} }),
    () => ({ services: { t2a: { sync() {} } } })]) {
    const registry = createProviderRegistry([definition({ create })]);
    assert.throws(() => createProvider({ serviceConfig: { id: 't2a', provider: { selected: 'fixture' } } }, registry), /violates contract/);
  }
  const mismatch = createProviderRegistry([definition({ create: () => ({
    services: { t2a: { sync() {}, stream() {} } }, mapError() {}
  }) })]);
  assert.throws(() => createProvider({ serviceConfig: { id: 't2a', provider: { selected: 'fixture' } } }, mismatch), /violates contract/);
  const registry = createProviderRegistry([definition({ capabilities: { sync: true, streaming: true } })]);
  assert.throws(() => createProvider({ serviceConfig: { id: 't2a', provider: { selected: 'fixture' } } }, registry), /violates contract/);
});

test('production composition uses per-service capabilities and keeps lifecycle selection', () => {
  const serviceRegistry = createServiceRegistry({ parseEnvBoundedInteger: parse, parseEnvMilliseconds: parse,
    providerCapabilitiesForService: providerRegistry.capabilitiesFor });
  assert.equal(serviceRegistry.get('rewrite').capabilities.byProvider.minimax.streaming, true);
  assert.equal(serviceRegistry.get('t2a').capabilities.byProvider.minimax.streaming, false);
  assert.deepEqual(providerRegistry.capabilitiesFor('t2a').minimax.audioFormats, ['mp3', 'wav', 'pcm']);
  assert.equal(providerRegistry.supports('ollama', 't2a'), false);
  assert.equal(providerRegistry.supports('google', 'transcription'), false);
  const runtimes = createServiceRuntimes({ serviceRegistry, createProvider, createProviderAdapter,
    createLifecycle: createProviderLifecycle });
  assert.equal(runtimes.get('t2a').capabilities.streaming, false);
  assert.equal(runtimes.get('t2a').capabilities.legacyVoiceControls, true);
  assert.equal(runtimes.get('t2a').lifecycle.mode, 'none');
  assert.equal(runtimes.get('rewrite').capabilities.streaming, serviceRegistry.get('rewrite').capabilities.streaming);
  for (const [selected, mode] of [['ollama', 'active_probe'], ['minimax', 'passive_remote']]) {
    const service = { id: 'rewrite', provider: { selected, runtime: {} }, capabilities: { streaming: false } };
    const runtime = createServiceRuntimes({ serviceRegistry: { list: () => [service] }, createProvider,
      createProviderAdapter, createLifecycle: createProviderLifecycle }).get('rewrite');
    assert.equal(runtime.lifecycle.mode, mode);
    assert.equal(runtime.capabilities.lifecycle, mode);
    assert.equal(runtime.capabilities.streaming, false, 'configuration disables an available stream capability');
  }
});

test('unsupported T2A selections defer rejection; unsupported rewrite never falls back', async () => {
  let constructed = 0;
  const registry = createProviderRegistry([definition({ create: () => { constructed++; throw new Error('unexpected'); } })]);
  for (const selected of ['ollama', 'missing', '__proto__', 'constructor']) {
    const instance = createProvider({ serviceConfig: { id: 't2a', provider: { selected } } }, registry);
    assert.equal(instance.getInfo().provider, selected);
    const result = await createProviderAdapter(instance).invokeSync({ serviceId: 't2a' });
    assert.equal(result.error.status, 501);
    assert.equal(result.error.code, 'UNSUPPORTED_PROVIDER_SERVICE');
    assert.throws(() => createProvider({ serviceConfig: { id: 'rewrite', provider: { selected } } }, registry), /Unsupported provider/);
  }
  assert.equal(constructed, 0);
});

test('a fake additional audio provider uses real runtime, validation, invocation and output without native voice or lifecycle methods', async () => {
  const bytes = Buffer.from('fixture audio');
  let received;
  const registry = createProviderRegistry([definition({
    capabilities: { sync: true, streaming: false, audioFormats: ['wav'], legacyVoiceControls: false },
    create: ({ serviceConfig }) => {
      assert.equal(serviceConfig.provider.runtime.model, 'fixture-model');
      return { name: 'fixture', services: { t2a: { sync: async payload => {
        received = payload;
        return successResult({ output: { text: '', artifacts: [{ kind: 'audio', data: bytes,
          format: 'wav', contentType: 'audio/wav' }] } });
      } } }, mapError: () => ({ status: 502, code: 'PROVIDER_ERROR', message: 'fixture failure' }) };
    }
  })]);
  const existing = createServiceRegistry({ parseEnvBoundedInteger: parse, parseEnvMilliseconds: parse }).get('t2a');
  // This tests the construction boundary. Current env readers/public route gates
  // deliberately do not accept a new production provider in this step.
  const service = { ...existing, provider: { selected: 'fixture', runtime: { model: 'fixture-model' } } };
  const validation = service.validateRequest({ body: { text: ' hello ', format: 'wav', response_mode: 'base64_json' } });
  assert.equal(validation.ok, true);
  assert.equal(service.validateRequest({ body: { text: '' } }).code, 'INVALID_INPUT');
  const runtimes = createServiceRuntimes({ serviceRegistry: { list: () => [service] },
    createProvider: options => createProvider(options, registry), createProviderAdapter, createLifecycle: createProviderLifecycle });
  const runtime = runtimes.get('t2a');
  const result = await invokeServiceSync({ runtime, requestId: 'fixture-request', timeoutMs: 321,
    payload: { text: validation.value.trimmedText, audio: validation.value.audio },
    executeWithAdmission: async ({ providerName, execute }) => { assert.equal(providerName, 'fixture'); return execute(); } });
  assert.equal(received.text, 'hello');
  assert.equal(received.timeoutMs, 321);
  assert.equal(received.requestId, 'fixture-request');
  const res = { status() { return this; }, json(body) { this.body = body; } };
  assert.equal(writeT2AOutput({ res, output: result.data.output, responseMode: validation.value.responseMode }).ok, true);
  assert.deepEqual(res.body, { ok: true, audio: bytes.toString('base64'), format: 'wav', mime: 'audio/wav',
    contentType: 'audio/wav', size: bytes.length, provider: null });
  assert.equal(runtime.capabilities.legacyVoiceControls, false);
});

test('registry discovery and disabled transcription never initialize the Google SDK', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name === '@google-cloud/speech') throw new Error('Unexpected Google SDK initialization');
      return load.call(this, name, ...args);
    };
    const { providerRegistry } = require('./providers');
    providerRegistry.capabilitiesFor('rewrite');
    providerRegistry.capabilitiesFor('t2a');
    require('./services/transcription').createTranscriptionService({ config: { enabled: false } });
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
