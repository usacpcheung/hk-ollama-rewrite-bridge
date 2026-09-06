const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createTranscriptionService } = require('../services/transcription');
const { createRewriteHeaderAuth } = require('../auth/header-auth');
const { writeJsonError } = require('../lib/output-writer');
const { readTranscriptionConfig } = require('../lib/transcription-config');
const { createGoogleSpeechProvider } = require('../providers/google-speech');
const { prepareDirectory } = require('../lib/transcription-files');
const { createConversionSlots } = require('../lib/transcription-slots');
const { TranscriptionError } = require('../lib/transcription-errors');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
  throw new Error('Condition did not become true');
}
async function fixture(t, { config: overrides = {}, recognize, normalize, disabled = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  const config = { ...readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project' }),
    directory, ratePerMinute: 60, ...overrides };
  const calls = [];
  const provider = createGoogleSpeechProvider(config, { createClient: () => ({
    recognize: async (request, options) => {
      calls.push({ request, options });
      if (recognize) return recognize(request, options);
      return [{ results: [{ alternatives: [{ transcript: request.content.toString() }] }] }];
    }
  }) });
  const service = createTranscriptionService({ config: disabled ? { enabled: false } : config, provider,
    normalize: normalize || (async (input) => ({ content: await fs.readFile(input), durationSeconds: 1 })) });
  const app = express();
  const auth = createRewriteHeaderAuth({ bridgeInternalAuthSecret: 'test-secret', errorResponse: writeJsonError });
  app.post(service.paths, auth, ...service.middleware);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function submit(text = '測試 I count six squares', { user = 'student', route = '/transcriptions', fields, signal, headers = {} } = {}) {
    const form = new FormData();
    if (fields) { for (const [name, value] of fields) form.append(name, value); }
    else form.append('audio', new Blob([text], { type: 'application/octet-stream' }), '../../untrusted-name');
    const response = await fetch(url + route, { method: 'POST', body: form, signal,
      headers: { ...(user ? { 'X-Bridge-Auth': 'test-secret', 'X-Authenticated-Email': `${user}@hs.edu.hk` } : {}), ...headers } });
    return { status: response.status, body: await response.json() };
  }
  return { submit, calls, directory, config, url };
}

test('transcription config is opt-in and rejects invalid enabled configuration', () => {
  assert.deepEqual(readTranscriptionConfig({}), { enabled: false });
  for (const values of [ { TRANSCRIPTION_ENABLED: 'yes' }, { TRANSCRIPTION_GOOGLE_PROJECT: '' },
    { TRANSCRIPTION_MAX_AUDIO_SECONDS: '61' }, { TRANSCRIPTION_MAX_CONCURRENCY: '0' },
    { TRANSCRIPTION_GOOGLE_LOCATION: '../elsewhere' }, { TRANSCRIPTION_TEMP_DIRECTORY: '/' } ]) {
    assert.throws(() => readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project', ...values }));
  }
  assert.throws(() => readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project', GOOGLE_SDK_NODE_LOGGING: '*' }));
  for (const origin of ['*', 'null', 'https://example.test/path', 'https://example.test/']) {
    assert.throws(() => readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project', TRANSCRIPTION_ALLOWED_ORIGINS: origin }));
  }
});

test('browser origins are explicitly allowed and cross-site uploads never reach Google', async t => {
  const f = await fixture(t, { config: { allowedOrigins: ['https://worksheet.example.test'] } });
  for (const headers of [ { Origin: 'https://attacker.example.test' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://worksheet.example.test', 'Sec-Fetch-Site': 'cross-site' } ]) {
    const result = await f.submit('cross-site', { headers });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'TRANSCRIPTION_ORIGIN_FORBIDDEN');
  }
  assert.equal(f.calls.length, 0);
  const allowed = await f.submit('allowed', { headers: { Origin: 'https://worksheet.example.test', 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(allowed.status, 200);
});

test('stalled Google initialization has a bounded wait and never starts a late billable RPC', async () => {
  let resolveInitialization;
  let initCalls = 0;
  let rpcCalls = 0;
  const config = readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project' });
  const provider = createGoogleSpeechProvider(config, { createClient: () => ({
    initialize: () => { initCalls++; return new Promise(resolve => { resolveInitialization = resolve; }); },
    recognize: () => { rpcCalls++; return [{ results: [] }]; }
  }) });
  const invoke = () => provider.services.transcription.sync({ content: Buffer.from('audio'), signal: new AbortController().signal, timeoutMs: 20 });
  const results = await Promise.all([invoke(), invoke()]);
  assert.ok(results.every(result => result.error.code === 'TRANSCRIPTION_TIMEOUT'));
  assert.equal(initCalls, 1);
  resolveInitialization();
  await delay(10);
  assert.equal(rpcCalls, 0);
});

test('Google initialization failures are controlled and cannot trigger a recognition call', async () => {
  let invoked = false;
  const config = readTranscriptionConfig({ TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_GOOGLE_PROJECT: 'test-project' });
  const provider = createGoogleSpeechProvider(config, { createClient: () => ({
    initialize: async () => { throw new Error('private-credential-path'); },
    recognize: () => { invoked = true; }
  }) });
  const result = await provider.services.transcription.sync({ content: Buffer.from('audio'), signal: new AbortController().signal, timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(invoked, false);
  assert.ok(!JSON.stringify(result).includes('private-credential-path'));
});

test('invalid actual audio never reaches Google and temporary upload files are removed', async t => {
  const f = await fixture(t, { normalize: async () => { throw new TranscriptionError(415, 'UNSUPPORTED_AUDIO', 'Unsupported audio.'); } });
  const result = await f.submit('a fake recording');
  assert.equal(result.status, 415);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal(f.calls.length, 0);
});

test('body framing is bounded even without Content-Length and malformed multipart fails cleanly', async t => {
  const f = await fixture(t, { config: { maxBytes: 1024 } });
  for (const [body, contentType, expected] of [
    ['x'.repeat(70000), 'multipart/form-data; boundary=abc', 413],
    ['--abc\r\nContent-Disposition: form-data; name="audio"; filename="test"\r\n\r\ntruncated', 'multipart/form-data; boundary=abc', 400],
    ['bad', 'multipart/form-data', 400],
    ['bad', 'audio/webm', 415]
  ]) {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(f.url + '/transcriptions', { method: 'POST', headers: {
        'Content-Type': contentType, 'Transfer-Encoding': 'chunked',
        'X-Bridge-Auth': 'test-secret', 'X-Authenticated-Email': 'test@hs.edu.hk'
      } }, res => { let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data })); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(result.status, expected);
  }
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal(f.calls.length, 0);
});

test('transcription aliases preserve each transcript, configure the Google V2 call, and clean audio', async t => {
  const f = await fixture(t);
  for (const route of ['/transcriptions', '/api/transcriptions']) {
    const result = await f.submit('廣東話 English', { route });
    assert.equal(result.status, 200);
    assert.equal(result.body.result, '廣東話 English');
    assert.equal(result.body.durationSeconds, 1);
    assert.match(result.body.requestId, /^[a-f0-9-]{36}$/);
    const { request, options } = f.calls.at(-1);
    assert.equal(request.recognizer, 'projects/test-project/locations/us/recognizers/_');
    assert.deepEqual(request.config, { autoDecodingConfig: {}, model: 'chirp_3', languageCodes: ['yue-Hant-HK'] });
    assert.equal(options.retry, null);
    assert.ok(options.timeout > 0 && options.timeout <= 60000);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('authentication gates disabled and enabled transcription', async t => {
  for (const disabled of [true, false]) {
    const f = await fixture(t, { disabled });
    assert.equal((await f.submit('test', { user: null })).status, 401);
    if (disabled) assert.equal((await f.submit()).body.error.code, 'TRANSCRIPTION_DISABLED');
    assert.equal(f.calls.length, 0);
  }
});

test('uploads enforce exact bytes and multipart structure before provider invocation', async t => {
  const f = await fixture(t, { config: { maxBytes: 1024 } });
  assert.equal((await f.submit('a'.repeat(1024))).status, 200);
  assert.equal((await f.submit('a'.repeat(1025))).body.error.code, 'AUDIO_TOO_LARGE');
  for (const fields of [[], [['wrong', new Blob(['audio'])]], [['audio', new Blob([])]],
    [['audio', new Blob(['a'])], ['audio', new Blob(['b'])]], [['audio', new Blob(['a'])], ['question', 'ignore this']]]) {
    assert.equal((await f.submit('', { fields })).status, 400);
  }
  await until(async () => (await fs.readdir(f.directory)).length === 0);
  assert.equal(f.calls.length, 1);
});

test('ten students complete out of order without response mixing; excess and duplicate work are rejected', async t => {
  const pending = new Map();
  const f = await fixture(t, { recognize: request => new Promise(resolve => pending.set(request.content.toString(), resolve)) });
  const requests = Array.from({ length: 10 }, (_, i) => f.submit(`answer-${i}`, { user: `student-${i}` }));
  await until(() => pending.size === 10);
  assert.equal((await f.submit('duplicate', { user: 'student-0' })).body.error.code, 'TRANSCRIPTION_ALREADY_ACTIVE');
  assert.equal((await f.submit('extra', { user: 'extra' })).body.error.code, 'TRANSCRIPTION_BUSY');
  for (let i = 9; i >= 0; i--) pending.get(`answer-${i}`)([{ results: [{ alternatives: [{ transcript: `result-${i}` }] }] }]);
  const results = await Promise.all(requests);
  results.forEach((result, i) => { assert.equal(result.status, 200); assert.equal(result.body.result, `result-${i}`); });
  assert.equal(new Set(results.map(result => result.body.requestId)).size, 10);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('conversion concurrency is bounded independently from Google calls', async t => {
  let conversions = 0;
  let peak = 0;
  const f = await fixture(t, { normalize: async input => {
    conversions++; peak = Math.max(peak, conversions);
    await delay(30);
    const content = await fs.readFile(input);
    conversions--;
    return { content, durationSeconds: 1 };
  } });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.submit(`answer-${i}`, { user: `s-${i}` })));
  assert.equal(peak, 2);
  assert.ok(results.every(result => result.status === 200));
});

test('provider errors and empty speech are controlled and never expose raw details', async t => {
  for (const [code, expectedStatus] of [[8, 429], [4, 504], [7, 503], [16, 503], [13, 502], [null, 422]]) {
    const f = await fixture(t, { recognize: async () => {
      if (code !== null) throw Object.assign(new Error('secret transcript credential path'), { code });
      return [{ results: [] }];
    } });
    const result = await f.submit();
    assert.equal(result.status, expectedStatus);
    assert.ok(!JSON.stringify(result).includes('secret'));
    await until(async () => (await fs.readdir(f.directory)).length === 0);
  }
});

test('total deadline responds promptly but retains admission until an outstanding provider call settles', async t => {
  let settle;
  const f = await fixture(t, { config: { totalMs: 80, concurrency: 1 }, recognize: () => new Promise(resolve => { settle = resolve; }) });
  const result = await f.submit();
  assert.equal(result.status, 504);
  assert.equal((await f.submit('next', { user: 'another' })).body.error.code, 'TRANSCRIPTION_BUSY');
  settle([{ results: [{ alternatives: [{ transcript: 'discarded' }] }] }]);
  await until(async () => (await fs.readdir(f.directory)).length === 0);
});

test('client disconnect retains admission during provider call, then removes files', async t => {
  let settle;
  const f = await fixture(t, { config: { concurrency: 1 }, recognize: () => new Promise(resolve => { settle = resolve; }) });
  const controller = new AbortController();
  const request = f.submit('cancelled', { signal: controller.signal });
  await until(() => settle);
  controller.abort();
  await assert.rejects(request);
  assert.equal((await f.submit('next', { user: 'another' })).status, 503);
  settle([{ results: [{ alternatives: [{ transcript: 'discarded' }] }] }]);
  await until(async () => (await fs.readdir(f.directory)).length === 0);
});

test('incomplete uploads time out and clean up without Google calls', async t => {
  const f = await fixture(t, { config: { uploadMs: 50 } });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/transcriptions', { method: 'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=testboundary',
      'X-Bridge-Auth': 'test-secret', 'X-Authenticated-Email': 'test@hs.edu.hk'
    } }, res => { let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) })); });
    req.on('error', reject);
    req.write('--testboundary\r\nContent-Disposition: form-data; name="audio"; filename="test"\r\nContent-Type: audio/webm\r\n\r\naudio');
  });
  assert.equal(result.status, 408);
  assert.equal(result.body.error.code, 'UPLOAD_TIMEOUT');
  await until(async () => (await fs.readdir(f.directory)).length === 0);
  assert.equal(f.calls.length, 0);
});

test('per-user rate limits do not block a different student', async t => {
  const f = await fixture(t, { config: { ratePerMinute: 1 } });
  assert.equal((await f.submit()).status, 200);
  assert.equal((await f.submit()).status, 429);
  assert.equal((await f.submit('other', { user: 'other' })).status, 200);
});

test('conversion queue cancellation removes the waiting entry', async () => {
  const acquire = createConversionSlots(1);
  const first = await acquire(new AbortController().signal);
  const controller = new AbortController();
  const waiting = acquire(controller.signal);
  controller.abort(new TranscriptionError(408, 'CANCELLED', 'cancelled'));
  await assert.rejects(waiting, { code: 'CANCELLED' });
  first();
  const release = await acquire(new AbortController().signal);
  release(); release();
});

test('restart cleanup preserves live-process jobs and unrelated files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const live = `job-${process.pid}-ABCdef`;
  await fs.mkdir(path.join(root, live));
  await fs.writeFile(path.join(root, 'unrelated'), 'keep');
  await prepareDirectory(root);
  assert.deepEqual((await fs.readdir(root)).sort(), [live, 'unrelated'].sort());
});
