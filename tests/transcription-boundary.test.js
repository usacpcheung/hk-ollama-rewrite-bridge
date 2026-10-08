const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createTranscriptionService } = require('../services/transcription');
const { createTranscriptionService: configured } = require('../configuration/transcription');
const { createProvider, providerRegistry } = require('../providers');
const { createProviderRegistry } = require('../lib/provider-registry');
const { createProviderAdapter } = require('../lib/provider-adapter');
const { planTranscriptionInput } = require('../lib/transcription-input-plan');
const { recognizeAudio } = require('../lib/transcription-recognition');
const { normalizeAudio, runMedia } = require('../lib/transcription-media');
const { createGoogleSpeechProvider } = require('../providers/google-speech');
const { successResult, failureResult } = require('../lib/bridge-contract');
const { createRewriteHeaderAuth } = require('../auth/header-auth');
const { writeJsonError } = require('../lib/output-writer');
const { ffmpeg, ffprobe, available, skipReason } = require('../test-support/media-tools');
const requirements = { encoding: 'wav', sampleRate: 8000, channels: 2, delivery: 'inline',
  cancellation: 'abortable', maxDurationSeconds: 60, maxPreparedBytes: 4 * 1024 * 1024 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); }
  throw new Error('Condition did not become true');
}
function wav() {
  const b = Buffer.alloc(44 + 3200);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(3200, 40); return b;
}
async function fixture(t, { inputRequirements = requirements, sync = async () => successResult({ response: '广东话 unchanged' }),
  normalize = async input => ({ content: await fs.readFile(input), durationSeconds: 0.1 }), config: overrides = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcription-boundary-'));
  const calls = [];
  const registry = createProviderRegistry([{ provider: 'alternative', serviceId: 'transcription',
    capabilities: { sync: true, streaming: false, lifecycle: 'none' },
    create: () => ({ name: 'alternative', mapError: () => ({ status: 502, code: 'TRANSCRIPTION_FAILED', message: 'Failed' }),
      services: { transcription: { inputRequirements, sync: request => { calls.push(request); return sync(request); } } } }) }]);
  const provider = createProvider({ serviceConfig: { id: 'transcription', provider: { selected: 'alternative' } } }, registry);
  const config = { enabled: true, directory, allowedOrigins: ['https://worksheet.example.test'],
    concurrency: 2, conversions: 1, ratePerMinute: 60, maxBytes: 10000, maxSeconds: 60,
    uploadMs: 2000, conversionMs: 15000, recognitionMs: 2000, totalMs: 5000, ffmpeg, ffprobe, ...overrides };
  const service = createTranscriptionService({ config, provider, normalize });
  const app = express();
  app.post(service.paths, createRewriteHeaderAuth({ bridgeInternalAuthSecret: 'test-secret', errorResponse: writeJsonError }), ...service.middleware);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(directory, { recursive: true, force: true }); });
  async function submit({ user = 'alice', route = '/transcriptions', signal, headers = {}, content = wav() } = {}) {
    const form = new FormData(); form.append('audio', new Blob([content]), 'test.wav');
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', body: form,
      signal: signal || AbortSignal.timeout(10000), headers: {
        'X-Bridge-Auth': 'test-secret', 'X-Authenticated-Email': `${user}@hs.edu.hk`, ...headers } });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return { submit, calls, directory };
}

test('Google construction uses the registry and neutral service validates declarations', () => {
  assert.equal(providerRegistry.supports('google-speech', 'transcription'), true);
  assert.equal(providerRegistry.supports('google-speech', 'rewrite'), false);
  const provider = createProvider({ serviceConfig: { id: 'transcription', provider: { selected: 'google-speech', runtime: { location: 'us' } } } });
  assert.equal(provider.services.transcription.inputRequirements.encoding, 'flac');
  assert.equal(provider.services.transcription.inputRequirements.cancellation, 'deadline-only');
  assert.throws(() => createTranscriptionService({ config: { enabled: true, recognitionMs: 1000 }, provider: { services: {} } }), /sync handler/);
  assert.throws(() => planTranscriptionInput({ requirements: { ...requirements, delivery: 'remote-url' }, limits: requirements }), /Unsupported/);
  assert.throws(() => planTranscriptionInput({ requirements: { ...requirements, maxPreparedBytes: Infinity }, limits: requirements }), /Invalid/);
  const plan = planTranscriptionInput({ requirements, limits: { maxDurationSeconds: 2, maxPreparedBytes: 128 } });
  assert.equal(plan.maxDurationSeconds, 2); assert.equal(plan.maxPreparedBytes, 128);
  // Even a hostile provider getter cannot be reached in disabled composition.
  assert.equal(configured({ config: { enabled: false }, provider: { get services() { throw Error('not lazy'); } } }).paths.length, 2);
});

test('alternative registered provider uses real conversion and unchanged HTTP outputs on both aliases', { skip: !available && skipReason }, async t => {
  for (const encoding of ['wav', 'pcm_s16le', 'flac']) {
    const f = await fixture(t, { inputRequirements: { ...requirements, encoding }, normalize: normalizeAudio,
      sync: async ({ audio, requestId, timeoutMs, signal }) => {
        assert.equal(audio.encoding, encoding); assert.equal(audio.sampleRate, 8000); assert.equal(audio.channels, 2);
        assert.equal(audio.durationSeconds, 0.1); assert.ok(requestId); assert.ok(timeoutMs > 0); assert.equal(signal.aborted, false);
        if (encoding === 'wav') assert.equal(audio.content.toString('ascii', 0, 4), 'RIFF');
        if (encoding === 'flac') assert.equal(audio.content.toString('ascii', 0, 4), 'fLaC');
        if (encoding === 'pcm_s16le') assert.equal(audio.content.length, 3200);
        // An unrelated native API/response shape is translated only here.
        const native = { segments: [{ words: '广东话 unchanged' }] };
        return successResult({ output: { text: native.segments.map(s => s.words).join(' ') } });
      } });
    for (const route of ['/transcriptions', '/api/transcriptions']) {
      const r = await f.submit({ route }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.result, '广东话 unchanged'); assert.equal(r.body.durationSeconds, 0.1);
      assert.deepEqual(Object.keys(r.body).sort(), ['durationSeconds', 'ok', 'requestId', 'result', 'timings']);
      assert.deepEqual(await fs.readdir(f.directory), []);
    }
  }
});

test('alternative adapter cannot bypass header authentication or origin restrictions', async t => {
  const f = await fixture(t);
  for (const [headers, status] of [[{ 'X-Bridge-Auth': 'wrong' }, 401],
    [{ 'X-Authenticated-Email': 'alice@other.example' }, 403],
    [{ Origin: 'https://attacker.example' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403]]) {
    assert.equal((await f.submit({ headers })).status, status);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.submit({ headers: { Origin: 'https://worksheet.example.test' } })).status, 200);
});

for (const cancellation of ['abortable', 'deadline-only']) {
  test(`${cancellation}: total timeout retains files and capacity until native settlement; recovery follows`, async t => {
    const entered = deferred(); const settle = deferred(); const cancelled = deferred(); let count = 0;
    const f = await fixture(t, { inputRequirements: { ...requirements, cancellation }, config: { totalMs: 250, concurrency: 1 },
      sync: async ({ signal }) => {
        if (++count > 1) return successResult({ response: 'recovered' });
        signal.addEventListener('abort', cancelled.resolve, { once: true }); entered.resolve();
        await settle.promise; return successResult({ response: 'discarded late success' });
      } });
    const pending = f.submit(); await entered.promise;
    assert.equal((await pending).status, 504); await cancelled.promise;
    assert.equal((await f.submit()).body.error.code, 'TRANSCRIPTION_ALREADY_ACTIVE');
    assert.equal((await f.submit({ user: 'bob' })).body.error.code, 'TRANSCRIPTION_BUSY');
    assert.equal((await fs.readdir(f.directory)).length, 1);
    settle.resolve(); await until(async () => (await fs.readdir(f.directory)).length === 0);
    assert.equal((await f.submit()).body.result, 'recovered');
  });
}

test('abortable adapter settles on disconnect and releases capacity exactly once', async t => {
  const entered = deferred(); const cancelled = deferred(); let count = 0;
  const f = await fixture(t, { config: { concurrency: 1 }, sync: ({ signal }) => {
    if (++count > 1) return successResult({ response: 'recovered' });
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => {
      cancelled.resolve(); reject(signal.reason);
    }, { once: true }); entered.resolve(); });
  } });
  const controller = new AbortController(); const pending = f.submit({ signal: controller.signal });
  const rejected = assert.rejects(pending); await entered.promise; controller.abort(); controller.abort();
  await rejected; await cancelled.promise; await until(async () => (await fs.readdir(f.directory)).length === 0);
  assert.equal((await f.submit()).status, 200);
  assert.equal((await f.submit({ user: 'bob' })).status, 200);
});

test('cancelled conversion waiter never starts conversion or recognition', async t => {
  const entered = deferred(); const settle = deferred(); let conversions = 0;
  const f = await fixture(t, { normalize: async input => {
    conversions++; entered.resolve(); await settle.promise;
    return { content: await fs.readFile(input), durationSeconds: 0.1 };
  } });
  const first = f.submit(); await entered.promise;
  const controller = new AbortController(); const second = f.submit({ user: 'bob', signal: controller.signal });
  const rejected = assert.rejects(second);
  await until(async () => (await fs.readdir(f.directory)).length === 2);
  // A fully written second upload proves it reached (or is approaching) the queue.
  await until(async () => {
    const dirs = await fs.readdir(f.directory);
    return (await Promise.all(dirs.map(d => fs.stat(path.join(f.directory, d, 'upload')).catch(() => ({ size: 0 }))))).every(s => s.size > 0);
  });
  controller.abort(); await rejected;
  await until(async () => (await fs.readdir(f.directory)).length === 1);
  settle.resolve(); assert.equal((await first).status, 200);
  assert.equal(conversions, 1); assert.equal(f.calls.length, 1);
});

test('recognition deadline rejects late success and preserves invocation ownership', async t => {
  const entered = deferred(); const cancelled = deferred(); const settle = deferred();
  const f = await fixture(t, { config: { recognitionMs: 40, totalMs: 3000, concurrency: 1 },
    sync: async ({ signal, timeoutMs }) => {
      assert.ok(timeoutMs <= 40); signal.addEventListener('abort', cancelled.resolve, { once: true });
      entered.resolve(); await settle.promise; return successResult({ response: 'late' });
    } });
  const pending = f.submit(); await entered.promise; await cancelled.promise;
  assert.equal((await f.submit({ user: 'bob' })).status, 503);
  settle.resolve(); const r = await pending;
  assert.equal(r.status, 504); assert.equal(r.body.error.code, 'TRANSCRIPTION_TIMEOUT');
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('malformed normalized results and thrown native errors are controlled, sanitized and cleaned', async t => {
  let response;
  const f = await fixture(t, { sync: async () => { if (response instanceof Error) throw response; return response; } });
  for (const value of [null, {}, { ok: true, data: { response: 'legacy-only' } },
    { ok: true, data: { output: { text: 123 } } }, { ok: false, error: { status: 200, message: 'private', code: 'BAD' } },
    new Error('private credentials and transcript')]) {
    response = value; const r = await f.submit();
    assert.equal(r.status, 502); assert.equal(r.body.error.code, 'TRANSCRIPTION_FAILED');
    assert.ok(!JSON.stringify(r.body).includes('private')); assert.deepEqual(await fs.readdir(f.directory), []);
  }
  response = successResult({ response: '  ' }); assert.equal((await f.submit()).body.error.code, 'NO_SPEECH');
  response = failureResult({ status: 429, code: 'TRANSCRIPTION_RATE_LIMITED', message: 'Try later' });
  const limited = await f.submit(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '10');
  response = successResult({ response: 'recovered' }); assert.equal((await f.submit()).body.result, 'recovered');
});

test('invalid or oversized prepared input never reaches the provider', async t => {
  let audio;
  const f = await fixture(t, { inputRequirements: { ...requirements, maxPreparedBytes: 10, maxDurationSeconds: 2 }, normalize: async () => audio });
  for (audio of [{ content: Buffer.alloc(11), durationSeconds: 1 }, { content: Buffer.alloc(1), durationSeconds: 3 },
    { content: Buffer.alloc(0), durationSeconds: 1 }, { content: 'unbounded text', durationSeconds: 1 },
    { content: Buffer.alloc(1), durationSeconds: NaN }]) {
    assert.equal((await f.submit()).body.error.code, 'INVALID_AUDIO');
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
  assert.equal(f.calls.length, 0);
});

test('real preparation enforces stricter provider duration/byte caps before recognition', { skip: !available && skipReason }, async t => {
  for (const caps of [{ maxDurationSeconds: 0.05 }, { maxPreparedBytes: 100 }]) {
    const f = await fixture(t, { inputRequirements: { ...requirements, ...caps }, normalize: normalizeAudio });
    const r = await f.submit(); assert.equal(r.status, caps.maxDurationSeconds ? 413 : 422);
    assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('real alternative format metadata is stereo at declared rate', { skip: !available && skipReason }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcription-format-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.wav'); await fs.writeFile(input, wav());
  const config = { ffmpeg, ffprobe, conversionMs: 15000, maxSeconds: 1, inputPlan: { ...requirements, sampleRate: 24000 } };
  await normalizeAudio(input, directory, config, new AbortController().signal);
  const metadata = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(directory, 'normalized.wav')],
    { signal: new AbortController().signal, timeoutMs: 15000 }));
  assert.equal(metadata.streams[0].sample_rate, '24000'); assert.equal(metadata.streams[0].channels, 2);
});

test('Google malformed native results are failures rather than partial success or no-speech', async () => {
  let response;
  const provider = createGoogleSpeechProvider({ location: 'us' }, { createClient: () => ({ recognize: async () => [response] }) });
  for (response of [null, [], { results: 'bad' }, { results: [null] }, { results: [{ alternatives: {} }] },
    { results: [{ alternatives: [{ transcript: 'valid prefix' }] }, { alternatives: [{ transcript: 123 }] }] }]) {
    const result = await provider.services.transcription.sync({ audio: { content: Buffer.from('audio') }, timeoutMs: 1000, signal: new AbortController().signal });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'TRANSCRIPTION_FAILED');
  }
});

test('already-aborted recognition never invokes the adapter', async () => {
  const controller = new AbortController(); const reason = new Error('cancelled'); controller.abort(reason);
  let calls = 0;
  await assert.rejects(recognizeAudio({ signal: controller.signal, adapter: createProviderAdapter({ services: { transcription: { sync: () => { calls++; } } } }) }), error => error === reason);
  assert.equal(calls, 0);
});


test('alternative transcription completes out of order with isolated users, deadlines and results', async t => {
  const pending = new Map();
  const f = await fixture(t, { config: { concurrency: 10 }, sync: request => new Promise(resolve => {
    pending.set(request.audio.content.toString(), { resolve, request });
  }) });
  const requests = Array.from({ length: 10 }, (_, i) => f.submit({ user: `student-${i}`, content: Buffer.from(`audio-${i}`) }));
  await until(() => pending.size === 10);
  assert.equal(new Set([...pending.values()].map(p => p.request.signal)).size, 10);
  assert.equal((await f.submit({ user: 'student-0' })).body.error.code, 'TRANSCRIPTION_ALREADY_ACTIVE');
  assert.equal((await f.submit({ user: 'extra' })).body.error.code, 'TRANSCRIPTION_BUSY');
  for (let i = 9; i >= 0; i--) pending.get(`audio-${i}`).resolve(successResult({ response: `transcript-${i}` }));
  const results = await Promise.all(requests);
  results.forEach((r, i) => { assert.equal(r.status, 200); assert.equal(r.body.result, `transcript-${i}`); });
  assert.equal(new Set(results.map(r => r.body.requestId)).size, 10);
  assert.deepEqual(await fs.readdir(f.directory), []);
});


test('recognition rejects completion past the deadline even before the timer callback runs', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const adapter = createProviderAdapter({ services: { transcription: { sync: async () => {
    now += 101;
    return successResult({ response: 'late without yielding to timers' });
  } } } });
  await assert.rejects(recognizeAudio({ adapter, audio: { content: Buffer.from('audio'), durationSeconds: 1 },
    inputPlan: requirements, requestId: 'late', signal: new AbortController().signal, timeoutMs: 100 }), { code: 'TRANSCRIPTION_TIMEOUT' });
});

for (const route of ['/transcriptions', '/api/transcriptions']) {
  test(`${route}: failed-request cleanup preserves the error and bounds the response wait`, { timeout: 10000 }, async t => {
    const entered = deferred(); const release = deferred(); let fail = true;
    const f = await fixture(t, { config: { totalMs: 150, concurrency: 1 }, sync: async () => fail
      ? failureResult({ status: 502, code: 'TRANSCRIPTION_FAILED', message: 'Recognition failed.' })
      : successResult({ response: 'recovered' }) });
    const original = fs.rm.bind(fs);
    t.mock.method(fs, 'rm', async (target, options) => {
      if (fail && String(target).startsWith(path.join(f.directory, 'job-'))) { entered.resolve(); await release.promise; }
      return original(target, options);
    });
    t.after(() => release.resolve());
    const pending = f.submit({ route }); await entered.promise;
    // The client gets the selected error while deletion is still blocked.
    const result = await pending;
    assert.equal(result.status, 502); assert.equal(result.body.error.code, 'TRANSCRIPTION_FAILED');
    assert.equal((await fs.readdir(f.directory)).length, 1);
    assert.equal((await f.submit({ route })).body.error.code, 'TRANSCRIPTION_ALREADY_ACTIVE');
    assert.equal((await f.submit({ route, user: 'bob' })).body.error.code, 'TRANSCRIPTION_BUSY');
    fail = false; release.resolve();
    await until(async () => !(await fs.readdir(f.directory)).length);
    assert.equal((await f.submit({ route })).body.result, 'recovered');
  });
}

test('cleanup failure after the deadline response preserves the response and blocks new admission', { timeout: 10000 }, async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { config: { totalMs: 150 }, sync: async () => failureResult({ status: 502, code: 'TRANSCRIPTION_FAILED', message: 'Failed.' }) });
  const original = fs.rm.bind(fs); const logs = [];
  t.mock.method(console, 'error', message => logs.push(JSON.parse(message)));
  t.mock.method(fs, 'rm', async (target, options) => {
    if (String(target).startsWith(path.join(f.directory, 'job-'))) { entered.resolve(); await release.promise; throw new Error('private cleanup failure'); }
    return original(target, options);
  });
  t.after(() => release.resolve());
  const pending = f.submit(); await entered.promise;
  assert.equal((await pending).status, 502);
  release.resolve(); await until(() => logs.length === 1);
  assert.equal(logs[0].code, 'TRANSCRIPTION_CLEANUP_FAILED');
  assert.equal((await f.submit({ user: 'bob' })).body.error.code, 'TRANSCRIPTION_UNAVAILABLE');
});

test('upload filesystem failures return sanitized 503 on both aliases and recover', { timeout: 15000 }, async t => {
  const fileSystem = require('node:fs'); const { Writable } = require('node:stream');
  const original = fileSystem.createWriteStream.bind(fileSystem);
  const f = await fixture(t); let failure; const logs = [];
  t.mock.method(console, 'error', message => logs.push(JSON.parse(message)));
  t.mock.method(fileSystem, 'createWriteStream', (target, options) => {
    if (failure && String(target).startsWith(f.directory)) {
      if (failure === 'sync') throw new Error('private path and credentials');
      return new Writable({ write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('private path and credentials'), { code: failure }));
      } });
    }
    return original(target, options);
  });
  for (const route of ['/transcriptions', '/api/transcriptions']) {
    for (failure of ['ENOSPC', 'EACCES', 'EIO', 'EROFS', 'EDQUOT', 'EMFILE', 'ENOENT', 'sync']) {
      const before = f.calls.length;
      const result = await f.submit({ route });
      assert.equal(result.status, 503); assert.equal(result.body.error.code, 'TRANSCRIPTION_UNAVAILABLE');
      assert.equal(result.headers.get('retry-after'), '10');
      assert.equal(f.calls.length, before); assert.deepEqual(await fs.readdir(f.directory), []);
      assert.equal(logs.at(-1).code, 'TRANSCRIPTION_UPLOAD_STORAGE_FAILED');
      assert.equal(logs.at(-1).reason, failure === 'sync' ? 'WRITE_FAILED' : failure);
      assert.ok(!JSON.stringify([result.body, logs]).includes('private'));
    }
    failure = null;
    assert.equal((await f.submit({ route })).status, 200);
  }
  assert.equal(logs.length, 16);
});

test('recognition deadline covers rejected promises and synchronous exceptions before timers run', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  for (const asynchronous of [false, true]) {
    const reject = () => { now += 101; throw new Error('private late native failure'); };
    const adapter = createProviderAdapter({ services: { transcription: { sync: asynchronous ? async () => reject() : reject } } });
    await assert.rejects(recognizeAudio({ adapter, audio: { content: Buffer.from('audio'), durationSeconds: 1 },
      inputPlan: requirements, signal: new AbortController().signal, timeoutMs: 100 }), { status: 504, code: 'TRANSCRIPTION_TIMEOUT' });
  }
});

test('recognition preserves client cancellation when rejection also exceeds the deadline', async t => {
  const { TranscriptionError } = require('../lib/transcription-errors');
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const controller = new AbortController();
  const reason = new TranscriptionError(408, 'TRANSCRIPTION_CANCELLED', 'Cancelled.');
  const adapter = createProviderAdapter({ services: { transcription: { sync: async () => {
    controller.abort(reason); now += 101; throw new Error('late failure');
  } } } });
  await assert.rejects(recognizeAudio({ adapter, audio: { content: Buffer.from('audio'), durationSeconds: 1 },
    inputPlan: requirements, signal: controller.signal, timeoutMs: 100 }), error => error === reason);
});
