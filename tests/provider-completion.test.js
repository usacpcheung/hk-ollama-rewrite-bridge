const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fixture, AUTH } = require('../test-support/server-fixture');
const { available, skipReason, ffmpeg, ffprobe } = require('../test-support/media-tools');
const { createProviderRegistry } = require('../lib/provider-registry');
const { resolveRewriteConfig } = require('../configuration/rewrite');
const { readTranscriptionConfig } = require('../lib/transcription-config');
const { createProviderLifecycle } = require('../providers/lifecycle');
const env = { NODE_OPTIONS: '--require=' + path.join(__dirname, '../test-support/step5-providers.cjs'),
  FIXTURE_KEY: 'test-only-secret', MINIMAX_API_KEY: '', TRANSCRIPTION_GOOGLE_PROJECT: '', GOOGLE_SDK_NODE_LOGGING: '*',
  REWRITE_STREAMING_ENABLED: 'true', TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_REQUESTS_PER_MINUTE: '60',
  TRANSCRIPTION_FFMPEG_PATH: ffmpeg, TRANSCRIPTION_FFPROBE_PATH: ffprobe };
function wav() {
  const b = Buffer.alloc(6444); b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(6400,40); return b;
}
async function transcribe(route, headers = AUTH) {
  const form = new FormData(); form.append('audio', new Blob([wav()]), 'input.wav');
  return fetch('http://127.0.0.1:3001' + route, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(10000) });
}
for (const selected of ['fixture-a', 'fixture-b']) {
  test(`actual server selects ${selected} for all three services without existing-provider credentials`, { timeout: 30000, skip: !available && skipReason }, async t => {
    const f = await fixture(t, { env: { ...env, REWRITE_PROVIDER: selected, T2A_PROVIDER: selected, TRANSCRIPTION_PROVIDER: selected,
      FIXTURE_REWRITE_MODEL: 'rewrite-v2', FIXTURE_T2A_MODEL: 'voice-v3', FIXTURE_TRANSCRIPTION_MODEL: 'recognition-v4' } });
    for (const route of ['/rewrite', '/api/rewrite']) {
      const r = await f.request(route, { body: { text: 'hello' } });
      assert.equal(r.status, 200); assert.equal((await r.json()).result, `${selected}:rewrite-v2:hello`);
      const stream = await f.request(route, { body: { text: 'hello', stream: true } });
      const chunks = (await stream.text()).trim().split('\n').map(JSON.parse);
      assert.equal(chunks.filter(x => x.done === true).length, 1);
      assert.equal(chunks.filter(x => !x.done).map(x => x.response).join(''), `${selected}:rewrite-v2:hello`);
    }
    for (const route of ['/t2a', '/api/t2a']) {
      for (const format of ['mp3', 'wav', 'pcm']) {
        const r = await f.request(route, { body: { text: 'hello', voice_choice: 'english_narrator_female', format, response_mode: 'base64_json' } });
        assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.format, format);
        assert.equal(Buffer.from(b.audio, 'base64').toString(), `${selected}:voice-v3:en:female:hello`);
      }
      const legacy = await f.request(route, { body: { text: 'hello', voice_id: 'old-voice' } });
      assert.equal(legacy.status, 422); assert.equal((await legacy.json()).error.code, 'LEGACY_VOICE_UNSUPPORTED');
    }
    for (const route of ['/transcriptions', '/api/transcriptions']) {
      const r = await transcribe(route); assert.equal(r.status, 200); const b = await r.json();
      assert.equal(b.result, `${selected}:recognition-v4:unaltered 广东话`); assert.equal(b.durationSeconds, 0.2);
      assert.deepEqual(await fs.readdir(f.directory), []);
      assert.equal((await transcribe(route, { ...AUTH, 'X-Bridge-Auth': 'wrong' })).status, 401);
    }
    assert.equal((await fetch('http://127.0.0.1:3001/readyz')).status, 200);
    assert.equal(f.calls.length, 0, 'no existing-provider upstream call');
  });
}

test('registered passive lifecycle recovers without native provider names in route decisions', { timeout: 20000 }, async t => {
  const f = await fixture(t, { env: { ...env, TRANSCRIPTION_ENABLED: 'false', REWRITE_PROVIDER: 'fixture-passive', T2A_PROVIDER: 'fixture-a' } });
  assert.equal((await f.request('/rewrite', { body: { text: 'FAIL' } })).status, 502);
  assert.equal((await f.request('/rewrite', { body: { text: 'FAIL' } })).status, 502);
  const cooldown = await f.request('/rewrite'); assert.equal(cooldown.status, 429);
  assert.equal((await cooldown.json()).error.code, 'PROVIDER_RECOVERY_COOLDOWN');
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await f.request('/rewrite')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:3001/readyz')).status, 200);
});

test('availability policies preserve validation-before-credentials and isolate services', { timeout: 20000 }, async t => {
  const f = await fixture(t, { env: { ...env, FIXTURE_KEY: '', TRANSCRIPTION_PROVIDER: 'fixture-a', REWRITE_PROVIDER: 'fixture-a', T2A_PROVIDER: 'fixture-b' } });
  for (const route of ['/rewrite', '/api/rewrite', '/t2a', '/api/t2a']) {
    assert.equal((await f.request(route, { body: { text: '' } })).status, 400);
    const r = await f.request(route); assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'FIXTURE_KEY_MISSING');
  }
  for (const route of ['/transcriptions', '/api/transcriptions']) {
    assert.equal((await transcribe(route, { ...AUTH, 'X-Bridge-Auth': 'wrong' })).status, 401);
    assert.equal((await transcribe(route, { ...AUTH, Origin: 'https://untrusted.example' })).status, 403);
    const r = await transcribe(route); assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'FIXTURE_KEY_MISSING');
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
  assert.equal((await fetch('http://127.0.0.1:3001/readyz')).status, 503);
  assert.equal(f.calls.length, 0);
});

test('selected configuration only invokes its registered reader; removing it never falls back', () => {
  const calls = [];
  const definitions = ['one', 'two'].map(provider => ({ provider, serviceId: 'rewrite', create() {},
    capabilities: { sync: true, streaming: false }, readConfiguration: () => { calls.push(provider); return { runtime: { model: provider } }; } }));
  const registry = createProviderRegistry(definitions);
  const options = { registry, env: { REWRITE_PROVIDER: 'two' }, selectedOnly: true,
    parseEnvBoundedInteger: (_raw, fallback) => fallback, parseEnvMilliseconds: (_raw, fallback) => fallback };
  const config = resolveRewriteConfig(options);
  assert.deepEqual(calls, ['two']); assert.deepEqual(Object.keys(config.providers), ['two']);
  const removed = createProviderRegistry(definitions.slice(0, 1));
  assert.throws(() => require('../providers').createProvider({ serviceConfig: { id: 'rewrite', provider: { selected: 'two' } } }, removed), /Unsupported/);
  assert.equal(removed.supports('one', 'rewrite'), true);
});

test('transcription selection is lazy when disabled and validates Google model/config only when selected', () => {
  assert.deepEqual(readTranscriptionConfig({ TRANSCRIPTION_PROVIDER: 'missing', GOOGLE_SDK_NODE_LOGGING: '*' }), { enabled: false });
  assert.throws(() => readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER: 'missing' }), /Missing configuration/);
  const c = readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project',
    TRANSCRIPTION_GOOGLE_MODEL: 'long', TRANSCRIPTION_GOOGLE_LANGUAGE: 'en-US' });
  assert.equal(c.providerConfig.model, 'long'); assert.equal(c.providerConfig.language, 'en-US');
  assert.throws(() => readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project', TRANSCRIPTION_GOOGLE_MODEL: 'invalid model' }), /MODEL/);
});

test('active lifecycle deduplicates simultaneous warmups and isolates instances', async () => {
  let finish; let calls = 0;
  const adapter = { checkReadiness: async () => ({ ready: true }), triggerWarmup: () => { calls++; return new Promise(r => { finish = r; }); } };
  const a = createProviderLifecycle({ providerName: 'new-provider', serviceId: 'rewrite', mode: 'active_probe', adapter, options: { warmupRetriggerWindowMs: 100 } });
  const first = a.maybeWarmup({ nowMs: 1000 });
  const other = await Promise.all(Array.from({ length: 20 }, () => a.maybeWarmup({ nowMs: 1000 })));
  assert.ok(other.every(r => !r.triggered)); assert.equal(calls, 1);
  finish({ ok: true }); await first;
  const b = createProviderLifecycle({ providerName: 'new-provider', serviceId: 'rewrite', mode: 'active_probe', adapter, options: { warmupRetriggerWindowMs: 100 } });
  const second = b.maybeWarmup({ nowMs: 1000 }); assert.equal(calls, 2); finish({ ok: true }); await second;
});

test('active lifecycle never probes or warms when configuration is unavailable', async () => {
  const unavailable = { status: 503, code: 'KEY_MISSING', message: 'Configure credentials.' };
  const lifecycle = createProviderLifecycle({ providerName: 'new-provider', serviceId: 'rewrite', mode: 'active_probe',
    adapter: { checkReadiness() { throw Error('unexpected probe'); }, triggerWarmup() { throw Error('unexpected warmup'); } },
    options: { availability: () => unavailable } });
  assert.deepEqual(await lifecycle.checkReadiness(), { ready: false, error: 'KEY_MISSING' });
  assert.deepEqual(await lifecycle.maybeWarmup(), { triggered: false });
});

test('registry rejects invalid configuration and active lifecycle declarations before invocation', () => {
  const base = { provider: 'fixture', serviceId: 'rewrite', capabilities: { sync: true, streaming: false, lifecycle: 'active_probe' },
    readConfiguration: () => ({ runtime: [] }), create: () => ({ services: { rewrite: { sync() {} } }, mapError() {} }) };
  const registry = createProviderRegistry([base]);
  assert.throws(() => registry.readConfiguration('fixture', 'rewrite', {}), /Invalid configuration/);
  assert.throws(() => registry.create({ serviceConfig: { id: 'rewrite', provider: { selected: 'fixture' } } }), /readiness\/warmup/);
  assert.throws(() => createProviderRegistry([{ ...base, capabilities: { ...base.capabilities, lifecycle: 'made-up' } }]), /Unsupported lifecycle/);
});


test('selected T2A format capabilities reject unavailable formats before invocation', { timeout: 20000 }, async t => {
  const f = await fixture(t, { env: { ...env, TRANSCRIPTION_ENABLED: 'false', REWRITE_PROVIDER: 'fixture-a', T2A_PROVIDER: 'fixture-wav' } });
  for (const route of ['/t2a', '/api/t2a']) {
    for (const format of [undefined, 'mp3', 'pcm']) {
      const r = await f.request(route, { body: { text: 'hello', format } });
      assert.equal(r.status, 422); assert.equal((await r.json()).error.code, 'AUDIO_FORMAT_UNSUPPORTED');
    }
    const r = await f.request(route, { body: { text: 'hello', format: 'wav' } });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /audio\/wav/);
    assert.match(await r.text(), /^fixture-wav:default-model:default:hello$/);
    assert.equal((await f.request(route, { body: { text: 'hello', format: 'invalid' } })).status, 400);
  }
  assert.equal((await f.request('/rewrite')).status, 200);
  assert.equal(f.calls.length, 0);
});


test('T2A-only registrations receive shell-compatible provider admission overrides', () => {
  const registry = createProviderRegistry([{ provider: 'audio-only', serviceId: 't2a', create() {},
    capabilities: { sync: true, streaming: false } }]);
  const config = resolveRewriteConfig({ registry, selectedOnly: true,
    env: { AUDIO_ONLY_MAX_CONCURRENCY: '2', AUDIO_ONLY_MAX_QUEUE_SIZE: '0', AUDIO_ONLY_MAX_WAIT_MS: '450' },
    parseEnvBoundedInteger: (raw, fallback) => raw === undefined ? fallback : Number(raw),
    parseEnvMilliseconds: (raw, fallback) => raw === undefined ? fallback : Number(raw) });
  assert.deepEqual(config.admission.byProvider['audio-only'], { maxConcurrency: 2, maxQueueSize: 0, maxWaitMs: 450 });
});

test('fresh server processes apply changed models while service provider selections remain independent', { timeout: 30000 }, async () => {
  for (const model of ['model-before', 'model-after']) {
    const cleanup = [];
    try {
      const f = await fixture({ after: fn => cleanup.push(fn) }, { env: { ...env, TRANSCRIPTION_ENABLED: 'false',
        REWRITE_PROVIDER: 'fixture-a', T2A_PROVIDER: 'fixture-b', FIXTURE_REWRITE_MODEL: model, FIXTURE_T2A_MODEL: model } });
      const rewrite = await f.request('/rewrite'); assert.equal(rewrite.status, 200);
      assert.ok((await rewrite.json()).result.startsWith('fixture-a:' + model + ':'));
      const audio = await f.request('/t2a', { body: { text: 'hello', response_mode: 'base64_json' } });
      assert.equal(audio.status, 200);
      assert.equal(Buffer.from((await audio.json()).audio, 'base64').toString(), 'fixture-b:' + model + ':default:hello');
    } finally { for (const close of cleanup.reverse()) await close(); }
  }
});
