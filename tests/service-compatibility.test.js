const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Exercise the actual server composition. Cloud endpoints and credentials are
// replaced here; no production exports or test hooks are needed.
const AUTH = {
  'X-Bridge-Auth': 'compatibility-test-secret',
  'X-Authenticated-Email': 'student@hs.edu.hk'
};
const AUDIO = Buffer.from('synthetic audio bytes for HTTP contract checks '.repeat(2));
const POST_ROUTES = ['/rewrite', '/api/rewrite', '/t2a', '/api/t2a', '/transcriptions', '/api/transcriptions'];
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function fixture(t, { env = {}, handle } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-compatibility-'));
  const calls = [];
  let bridge;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body });
      if (handle?.(req, res, body)) return;
      if (req.url === '/rewrite') return json(res, 200, { reply: '正式文字' });
      if (req.url === '/t2a') return json(res, 200, {
        data: { audio: AUDIO.toString('hex'), format: 'mp3', audio_length: AUDIO.length }
      });
      json(res, 404, {});
    });
  });
  // Register before listen/spawn so even a failed fixture is cleaned up.
  t.after(async () => {
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
      const exited = once(bridge, 'exit');
      bridge.kill('SIGTERM');
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const providerUrl = `http://127.0.0.1:${upstream.address().port}`;
  bridge = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    // Deliberately exclude inherited bridge/provider settings and credentials.
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH['X-Bridge-Auth'],
      WARMUP_ON_START: 'false',
      REWRITE_PROVIDER: 'minimax',
      REWRITE_STREAMING_ENABLED: 'true',
      REWRITE_MINIMAX_API_URL: `${providerUrl}/rewrite`,
      REWRITE_MINIMAX_ANTHROPIC_BASE_URL: `${providerUrl}/anthropic`,
      REWRITE_OLLAMA_URL: `${providerUrl}/generate`,
      REWRITE_OLLAMA_PS_URL: `${providerUrl}/ps`,
      T2A_MINIMAX_API_URL: `${providerUrl}/t2a`,
      MINIMAX_API_KEY: 'synthetic-test-key',
      TRANSCRIPTION_ENABLED: 'false',
      TRANSCRIPTION_GOOGLE_PROJECT: 'test-project',
      TRANSCRIPTION_TEMP_DIRECTORY: directory,
      RATE_LIMIT_GLOBAL_MAX_REQUESTS: '1000',
      RATE_LIMIT_REWRITE_IP_MAX_REQUESTS: '1000',
      RATE_LIMIT_T2A_IP_MAX_REQUESTS: '1000',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge startup timed out')), 10_000);
    let output = '';
    bridge.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('rewrite-bridge listening on http://127.0.0.1:3001')) {
        clearTimeout(timer);
        resolve();
      }
    });
    bridge.stderr.resume();
    bridge.once('error', error => { clearTimeout(timer); reject(error); });
    bridge.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Bridge exited during startup: ${code}/${signal}`));
    });
  });
  const request = (route, { body = { text: '測試' }, headers = AUTH, raw, method = 'POST' } = {}) =>
    fetch(`http://127.0.0.1:3001${route}`, {
      method,
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(method === 'POST' ? { body: raw === undefined ? JSON.stringify(body) : raw } : {}),
      signal: AbortSignal.timeout(10_000)
    });
  return { request, calls };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  return body;
}

test('compatibility: all six aliases share the full auth rejection matrix', async t => {
  const f = await fixture(t);
  const cases = [
    [{ 'X-Authenticated-Email': 'student@hs.edu.hk' }, 401, 'AUTH_REQUIRED'],
    [{ ...AUTH, 'X-Bridge-Auth': 'wrong' }, 401, 'AUTH_REQUIRED'],
    [{ 'X-Bridge-Auth': AUTH['X-Bridge-Auth'] }, 401, 'AUTH_REQUIRED'],
    [{ ...AUTH, 'X-Authenticated-Email': 'one@hs.edu.hk,two@hs.edu.hk' }, 401, 'AUTH_HEADER_INVALID'],
    [{ ...AUTH, 'X-Authenticated-Email': 'student@example.com' }, 403, 'FORBIDDEN_DOMAIN']
  ];
  for (const route of POST_ROUTES) {
    for (const [headers, status, code] of cases) {
      const response = await f.request(route, { headers });
      await expectError(response, status, code);
      if (route.endsWith('/transcriptions')) assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(f.calls.length, 0);
});

test('compatibility: JSON parser rejects malformed and oversized bodies before auth on every POST alias', async t => {
  const f = await fixture(t);
  for (const route of POST_ROUTES) {
    for (const [raw, status, code] of [
      ['{', 400, 'INVALID_JSON'],
      [JSON.stringify({ text: 'x'.repeat(17_000) }), 413, 'PAYLOAD_TOO_LARGE']
    ]) {
      const response = await f.request(route, { raw, headers: {} });
      const body = await expectError(response, status, code);
      assert.equal(response.headers.get('cache-control'), null);
      assert.equal(Object.hasOwn(body, 'requestId'), false);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('compatibility: baseline limiting precedes auth, spans services and excludes ops', async t => {
  const f = await fixture(t, { env: { RATE_LIMIT_GLOBAL_MAX_REQUESTS: '1' } });
  await expectError(await f.request('/rewrite', { headers: {} }), 401, 'AUTH_REQUIRED');
  for (const route of ['/t2a', '/transcriptions']) {
    const response = await f.request(route, { headers: {} });
    const body = await expectError(response, 429, 'RATE_LIMITED');
    assert.equal(body.limit.scope, 'global');
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(response.headers.get('cache-control'), null);
  }
  await expectError(await f.request('/model-status', { method: 'GET', headers: {} }), 429, 'RATE_LIMITED');
  for (const route of ['/healthz', '/readyz']) {
    const response = await f.request(route, { method: 'GET', headers: {} });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  // A different trusted identity gets its own baseline window.
  await expectError(await f.request('/rewrite', { body: {} }), 400, 'INVALID_INPUT');
  await expectError(await f.request('/t2a', { body: {} }), 429, 'RATE_LIMITED');
  await expectError(await f.request('/t2a', {
    body: {}, headers: { ...AUTH, 'X-Authenticated-Email': 'another@hs.edu.hk' }
  }), 400, 'INVALID_INPUT');
  assert.equal(f.calls.length, 0, 'ops checks must not make paid readiness probes');
});

test('compatibility: JSON service limiters precede auth; enabled transcription limiter follows auth', async t => {
  const f = await fixture(t, { env: {
    RATE_LIMIT_REWRITE_IP_MAX_REQUESTS: '1', RATE_LIMIT_T2A_IP_MAX_REQUESTS: '1',
    TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_REQUESTS_PER_MINUTE: '1'
  } });
  for (const service of ['rewrite', 't2a']) {
    await expectError(await f.request(`/${service}`, { headers: {} }), 401, 'AUTH_REQUIRED');
    const body = await expectError(await f.request(`/api/${service}`, { headers: {} }), 429, 'RATE_LIMITED');
    assert.equal(body.limit.scope, service);
  }
  // Unsupported media cannot reach Google. Unauthenticated attempts must not
  // consume the authenticated student's transcription service window.
  const upload = { raw: 'auth-only probe', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' } };
  for (const route of ['/transcriptions', '/api/transcriptions']) {
    await expectError(await f.request(route, { ...upload, headers: {
      ...upload.headers, 'X-Bridge-Auth': 'wrong'
    } }), 401, 'AUTH_REQUIRED');
  }
  await expectError(await f.request('/transcriptions', upload), 415, 'UNSUPPORTED_MEDIA_TYPE');
  const limited = await f.request('/api/transcriptions', upload);
  const body = await expectError(limited, 429, 'RATE_LIMITED');
  assert.equal(body.limit.scope, 'transcription');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  await expectError(await f.request('/transcriptions', { ...upload, headers: {
    ...upload.headers, 'X-Authenticated-Email': 'another@hs.edu.hk'
  } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(f.calls.length, 0);
});

test('compatibility: Ollama warmup gates rewrite while T2A remains available, then both rewrite aliases recover', async t => {
  let ready = false;
  const f = await fixture(t, { env: {
    REWRITE_PROVIDER: 'ollama', REWRITE_OLLAMA_MODEL: 'contract-model',
    REWRITE_OLLAMA_READINESS_CACHE_MS: '0', REWRITE_OLLAMA_WARMUP_RETRIGGER_WINDOW_MS: '120000'
  }, handle: (req, res, body) => {
    if (req.url === '/ps') { json(res, 200, { models: ready ? [{ name: 'contract-model' }] : [] }); return true; }
    if (req.url !== '/generate') return false;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ response: '广东话', done: false }) + '\n' + JSON.stringify({ response: '', done: true }) + '\n');
    } else json(res, 200, { response: body.prompt === 'hi' ? 'warm' : '广东话', done: true });
    return true;
  } });
  const warming = await f.request('/rewrite');
  // WARMUP_ON_START=false sets serviceState=ready, but still permits on-demand
  // warmup; that path reports MODEL_WARMING even when this request triggers it.
  const started = await expectError(warming, 202, 'MODEL_WARMING');
  assert.equal(Number(warming.headers.get('retry-after')), started.retryAfterSec);
  await expectError(await f.request('/api/rewrite'), 202, 'MODEL_WARMING');
  const notReady = await f.request('/readyz', { method: 'GET', headers: {} });
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), { ok: false, serviceState: 'ready', reason: 'MODEL_NOT_READY' });
  const audio = await f.request('/t2a');
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO);
  assert.equal(f.calls.filter(call => call.path === '/generate').length, 1, 'warmup is retrigger-suppressed');
  ready = true;
  for (const route of ['/rewrite', '/api/rewrite']) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: '廣東話' });
    const stream = await f.request(route, { body: { text: '測試', stream: true } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /^application\/x-ndjson/);
    const events = (await stream.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => !event.done).map(event => event.response).join(''), '廣東話');
    assert.equal(events.filter(event => event.done).length, 1);
    assert.equal(events.at(-1).done, true);
    assert.ok(events.every(event => !event.error));
  }
  const recovered = await f.request('/readyz', { method: 'GET', headers: {} });
  assert.deepEqual(await recovered.json(), { ok: true, serviceState: 'ready', reason: null });
});

test('compatibility: exhausted Ollama startup budget degrades rewrite without failing health or T2A', async t => {
  const f = await fixture(t, { env: {
    REWRITE_PROVIDER: 'ollama', WARMUP_ON_START: 'true', WARMUP_STARTUP_MAX_WAIT_MS: '0'
  }, handle: (req, res) => {
    if (req.url === '/ps') { json(res, 200, { models: [] }); return true; }
    if (req.url === '/generate') { json(res, 200, { response: 'warm', done: true }); return true; }
    return false;
  } });
  const response = await f.request('/rewrite');
  const body = await expectError(response, 503, 'MODEL_STARTUP_DEGRADED');
  assert.equal(body.serviceState, 'degraded');
  const readiness = await f.request('/readyz', { method: 'GET', headers: {} });
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).reason, 'STARTUP_DEGRADED');
  const health = await f.request('/healthz', { method: 'GET', headers: {} });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const audio = await f.request('/api/t2a');
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO);
});

test('compatibility: MiniMax failure recovery cooldown is HTTP-visible and never triggers paid probes', async t => {
  const f = await fixture(t, { env: {
    REWRITE_MINIMAX_PASSIVE_FAILURE_THRESHOLD: '1',
    REWRITE_MINIMAX_PASSIVE_FAIL_OPEN_ON_IDLE: 'false',
    REWRITE_MINIMAX_PASSIVE_RECOVERY_COOLDOWN_MS: '600000'
  }, handle: (req, res) => {
    if (req.url !== '/rewrite') return false;
    json(res, 500, {});
    return true;
  } });
  await expectError(await f.request('/rewrite'), 502, 'PROVIDER_ERROR');
  const readiness = await f.request('/readyz', { method: 'GET', headers: {} });
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).reason, 'MINIMAX_RECENT_FAILURES');
  const status = await f.request('/model-status', { method: 'GET', headers: {} });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).minimaxPassiveReadiness.ready, false);
  assert.equal(f.calls.length, 1);
  await expectError(await f.request('/api/rewrite'), 502, 'PROVIDER_ERROR'); // One recovery attempt.
  const cooldown = await f.request('/rewrite');
  const body = await expectError(cooldown, 429, 'MINIMAX_RECOVERY_COOLDOWN');
  assert.equal(Number(cooldown.headers.get('retry-after')), body.retryAfterSec);
  assert.ok(body.retryAfterSec > 0);
  assert.equal(f.calls.length, 2);
});

test('compatibility: MiniMax rewrite and T2A share admission and streaming overload stays NDJSON', async t => {
  let release;
  const entered = new Promise(resolve => { release = resolve; });
  let finishRewrite;
  const f = await fixture(t, { env: { MINIMAX_MAX_CONCURRENCY: '1', MINIMAX_MAX_QUEUE_SIZE: '0' }, handle: (req, res) => {
    if (req.url !== '/rewrite') return false;
    finishRewrite = () => json(res, 200, { reply: '完成' });
    release();
    return true;
  } });
  const first = f.request('/rewrite');
  // Bound the wait even if a regression rejects before reaching the provider.
  await Promise.race([entered, first.then(() => { throw new Error('Rewrite was not held at upstream'); })]);
  try {
    const busy = await f.request('/t2a');
    const body = await expectError(busy, 503, 'ADMISSION_OVERLOADED');
    assert.equal(body.reason, 'queue_full');
    assert.equal(body.admission.provider, 'minimax');
    assert.equal(busy.headers.get('retry-after'), null);
    const stream = await f.request('/api/rewrite', { body: { text: '測試', stream: true } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /^application\/x-ndjson/);
    const events = (await stream.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].done, true);
    assert.equal(events[0].error.code, 'ADMISSION_OVERLOADED');
    assert.equal(events[0].error.status, 503);
    assert.equal(f.calls.length, 1);
  } finally { finishRewrite(); }
  const completed = await first;
  assert.equal(completed.status, 200);
  await completed.json();
  const next = await f.request('/api/t2a');
  assert.equal(next.status, 200);
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), AUDIO);
  assert.equal(f.calls.length, 2, 'admission is released after successful invocation');
});

test('compatibility: MiniMax WAV bytes and public audio metadata agree', async t => {
  const f = await fixture(t, { handle: (req, res, body) => {
    if (req.url !== '/t2a') return false;
    json(res, 200, { output: { data: { audio: AUDIO.toString('hex') },
      extra_info: { audio_format: body.audio_setting.format } } });
    return true;
  } });
  const binary = await f.request('/t2a', { body: { text: '測試', format: 'wav' } });
  assert.equal(binary.status, 200);
  assert.equal(binary.headers.get('content-type'), 'audio/wav');
  assert.equal(binary.headers.get('content-disposition'), 'inline; filename="speech.wav"');
  assert.equal(Number(binary.headers.get('content-length')), AUDIO.length);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), AUDIO);
  const wrapped = await f.request('/api/t2a', { body: { text: '測試', format: 'wav', response_mode: 'base64_json' } });
  assert.equal(wrapped.status, 200);
  const body = await wrapped.json();
  assert.equal(body.format, 'wav');
  assert.equal(body.mime, 'audio/wav');
  assert.equal(body.contentType, 'audio/wav');
  assert.deepEqual(Buffer.from(body.audio, 'base64'), AUDIO);
  assert.ok(f.calls.every(call => call.body.audio_setting.format === 'wav'));
});

test('compatibility: unregistered Ollama T2A preserves validation order and does not affect rewrite', async t => {
  const f = await fixture(t, { env: { T2A_PROVIDER: 'ollama' } });
  for (const route of ['/t2a', '/api/t2a']) {
    await expectError(await f.request(route, { headers: {} }), 401, 'AUTH_REQUIRED');
    await expectError(await f.request(route, { body: { text: '' } }), 400, 'INVALID_INPUT');
    await expectError(await f.request(route, { body: { text: '', stream: true } }), 501, 'STREAMING_UNSUPPORTED');
    await expectError(await f.request(route, { body: { text: 'x'.repeat(201) } }), 413, 'TOO_LONG');
    await expectError(await f.request(route), 501, 'UNSUPPORTED_PROVIDER');
    await expectError(await f.request(route, { body: { text: '測試', voice_choice: 'cantonese_male_1' } }), 501, 'UNSUPPORTED_PROVIDER');
  }
  assert.equal(f.calls.length, 0);
  const rewrite = await f.request('/rewrite');
  assert.equal(rewrite.status, 200);
  assert.deepEqual(await rewrite.json(), { ok: true, result: '正式文字' });
  assert.equal(f.calls.length, 1);
});

for (const policy of ['current-v1', 'hk-school-v1']) {
  for (const [provider, apiFormat] of [['minimax', 'legacy-chat'], ['minimax', 'anthropic'], ['ollama', 'legacy-chat']]) {
    test(`policy: ${provider}/${apiFormat}/${policy} keeps server selection through aliases, streaming and concurrent calls`, async t => {
      const expected = require('../services/rewrite-policies').resolveRewritePolicy(policy).instructions;
      const f = await fixture(t, { env: {
        REWRITE_PROVIDER: provider, REWRITE_POLICY: policy, REWRITE_OLLAMA_MODEL: 'policy-model',
        REWRITE_MINIMAX_API_FORMAT: apiFormat
      }, handle: (req, res, body) => {
        if (req.url === '/ps') { json(res, 200, { models: [{ name: 'policy-model' }] }); return true; }
        if (req.url === '/anthropic/v1/messages') {
          if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const events = [
              { type: 'message_start', message: { id: 'policy-fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '广东话' } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
              { type: 'message_stop' }
            ];
            res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
          } else json(res, 200, { content: [{ type: 'text', text: '广东话' }], stop_reason: 'end_turn' });
          return true;
        }
        if (!['/rewrite', '/generate'].includes(req.url)) return false;
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': provider === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' });
          res.end(provider === 'ollama'
            ? '{"response":"广东话","done":false}\n{"response":"","done":true}\n'
            : 'data: {"choices":[{"delta":{"content":"广东话"}}]}\n\ndata: [DONE]\n\n');
        } else json(res, 200, provider === 'ollama' ? { response: '广东话', done: true } : { reply: '广东话' });
        return true;
      } });
      const headers = { ...AUTH, 'X-Rewrite-Policy': 'override', REWRITE_POLICY: 'override' };
      for (const route of ['/rewrite', '/api/rewrite']) {
        const results = await Promise.all([false, true].map(stream => f.request(`${route}?policy=override&REWRITE_POLICY=override`, {
          headers, body: { text: '測試', stream, policy: 'override', rewrite_policy: 'override', REWRITE_POLICY: 'override', instructions: 'override' }
        })));
        assert.equal(results[0].status, 200);
        assert.deepEqual(await results[0].json(), { ok: true, result: '廣東話' });
        assert.equal(results[1].status, 200);
        const events = (await results[1].text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.filter(e => !e.done).map(e => e.response).join(''), '廣東話');
        assert.equal(events.filter(e => e.done).length, 1);
        assert.equal(events.at(-1).done, true);
        assert.ok(events.every(e => !e.error));
      }
      const calls = f.calls.filter(call => ['/rewrite', '/generate', '/anthropic/v1/messages'].includes(call.path));
      assert.equal(calls.length, 4);
      for (const { body } of calls) {
        if (provider === 'minimax') {
          assert.equal(apiFormat === 'anthropic' ? body.system : body.messages.find(m => m.role === 'system').content, expected);
          assert.deepEqual(body.messages.find(m => m.role === 'user').content, apiFormat === 'anthropic'
            ? [{ type: 'text', text: '把下方文字改寫為繁體書面語：\n測試' }] : '把下方文字改寫為繁體書面語：\n測試');
        } else {
          assert.ok(body.prompt.includes(expected));
          assert.ok(body.prompt.includes('測試'));
          assert.ok(!body.prompt.includes('override'));
        }
      }
      await expectError(await f.request('/rewrite', { headers: {} }), 401, 'AUTH_REQUIRED');
      await expectError(await f.request('/api/rewrite', { body: { text: '' } }), 400, 'INVALID_INPUT');
      assert.equal(f.calls.filter(c => ['/rewrite', '/generate', '/anthropic/v1/messages'].includes(c.path)).length, 4);
      const audio = await f.request('/api/t2a');
      assert.equal(audio.status, 200);
      assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO);
    });
  }
}

for (const policy of ['current-v1', 'hk-school-v1']) {
  test(`quotations: ${policy} preserves alias and JSON/stream equivalence`, async t => {
    const raw = '老师写「唔該晒」，然后说「係」。';
    const f = await fixture(t, { env: { REWRITE_POLICY: policy }, handle: (req, res, body) => {
      if (req.url !== '/rewrite') return false;
      if (!body.stream) { json(res, 200, { reply: raw }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const content of raw.split('')) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return true;
    } });
    for (const route of ['/rewrite','/api/rewrite']) {
      const text = '老師寫「唔該晒」，然後說「係」。';
      const sync = await f.request(route, { body: { text } });
      const expected = policy === 'hk-school-v1' ? '老師寫「唔該晒」，然後説「係」。' : '老師寫「唔該曬」，然後説「係」。';
      assert.equal(sync.status, 200); assert.equal((await sync.json()).result, expected);
      const stream = await f.request(route, { body: { text, stream: true } });
      assert.equal(stream.status, 200);
      const events = (await stream.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.filter(e => !e.done).map(e => e.response).join(''), expected);
      assert.equal(events.filter(e => e.done).length, 1);
      assert.ok(events.every(e => !e.error));
    }
  });
}
test('quotations: cancelling a partial quote cannot contaminate the next HTTP request', async t => {
  const f = await fixture(t, { env: { REWRITE_POLICY: 'hk-school-v1' }, handle: (req, res, body) => {
    if (req.url !== '/rewrite') return false;
    if (!body.stream) { json(res, 200, { reply: '「唔該晒」' }); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"前文「唔該"}}]}\n\n');
    return true; // Hold upstream until the client cancellation aborts it.
  } });
  const first = await f.request('/rewrite', { body: { text: '「唔該晒」', stream: true } });
  const reader = first.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  const next = await f.request('/api/rewrite', { body: { text: '沒有引文' } });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).result, '「唔該曬」');
});
