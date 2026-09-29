const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BASE_URL = 'http://127.0.0.1:3001';
const AUTH_SECRET = 'test-secret';

function waitForServerReady(serverProcess, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for test server to start'));
      }
    }, timeoutMs);

    const handleOutput = (chunk) => {
      const text = String(chunk);
      if (text.includes('rewrite-bridge listening on http://127.0.0.1:3001') && !settled) {
        settled = true;
        clearTimeout(deadline);
        resolve();
      }
    };

    const handleExit = (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`Test server exited early (code=${code}, signal=${signal})`));
      }
    };

    serverProcess.stdout.on('data', handleOutput);
    serverProcess.stderr.on('data', handleOutput);
    serverProcess.once('exit', handleExit);
  });
}

function startMockMinimaxServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function spawnBridge(envOverrides = {}) {
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET,
      REWRITE_PROVIDER: 'minimax',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return serverProcess;
}

async function postJson(pathname, body, headers = {}) {
  return fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

const authHeaders = {
  'X-Bridge-Auth': AUTH_SECRET,
  'X-Authenticated-Email': 'tester@hs.edu.hk'
};

test('t2a routes return binary audio by default and preserve rewrite regression behavior', async (t) => {
  const expectedAudio = Buffer.from('route-level mp3 payload '.repeat(4));
  let rewriteCalls = 0;
  let t2aCalls = 0;

  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      if (req.url === '/rewrite') {
        rewriteCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply: `正式：${payload.messages?.[1]?.content || ''}` }));
        return;
      }

      if (req.url === '/t2a') {
        t2aCalls += 1;
        assert.equal(payload.language_boost, 'Chinese,Yue');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          trace_id: 'trace-route-binary',
          data: {
            audio: expectedAudio.toString('hex'),
            format: 'mp3',
            audio_length: expectedAudio.length
          }
        }));
        return;
      }

      res.writeHead(404).end();
    });
  });
  t.after(() => mockServer.close());

  const serverProcess = spawnBridge({
    REWRITE_MINIMAX_API_URL: `http://127.0.0.1:${port}/rewrite`,
    T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`,
    MINIMAX_API_KEY: 'test-key'
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const t2aResponse = await postJson('/t2a', { text: '你好，世界' }, authHeaders);
  const binaryBuffer = Buffer.from(await t2aResponse.arrayBuffer());

  assert.equal(t2aResponse.status, 200);
  assert.equal(t2aResponse.headers.get('content-type'), 'audio/mpeg');
  assert.equal(t2aResponse.headers.get('content-disposition'), 'inline; filename="speech.mp3"');
  assert.deepEqual(binaryBuffer, expectedAudio);

  const rewriteResponse = await postJson('/rewrite', { text: '我今日想請假。' }, authHeaders);
  const rewriteBody = await rewriteResponse.json();

  assert.equal(rewriteResponse.status, 200);
  assert.equal(rewriteBody.ok, true);
  assert.match(rewriteBody.result, /^正式：把下方文字改寫為繁體書面語：/);
  assert.equal(rewriteCalls, 1);
  assert.equal(t2aCalls, 1);
});

test('t2a routes return base64 JSON when requested', async (t) => {
  const expectedAudio = Buffer.from('json audio payload '.repeat(5));

  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      assert.equal(payload.stream, false);
      assert.equal(payload.voice_setting.voice_id, 'English_expressive_narrator');
      assert.equal(payload.audio_setting.format, 'mp3');
      assert.equal(payload.audio_setting.channel, 1);
      assert.equal(payload.language_boost, 'English');
      assert.deepEqual(payload.voice_modify, { pitch: 0, intensity: 0, timbre: 0 });
      assert.equal(payload.output_format, 'hex');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        trace_id: 'trace-route-json',
        data: {
          audio: expectedAudio.toString('hex'),
          format: 'mp3',
          audio_length: 1234,
          subtitles: [{ text: '你好', start_ms: 0, end_ms: 200 }]
        }
      }));
    });
  });
  t.after(() => mockServer.close());

  const serverProcess = spawnBridge({
    T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`,
    MINIMAX_API_KEY: 'test-key'
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await postJson('/api/t2a', {
    text: '你好，世界',
    response_mode: 'base64_json',
    voice_id: 'English_expressive_narrator',
    language_boost: ' English '
  }, authHeaders);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.audio, expectedAudio.toString('base64'));
  assert.equal(body.format, 'mp3');
  assert.equal(body.mime, 'audio/mpeg');
  assert.equal(body.contentType, 'audio/mpeg');
  assert.equal(body.size, expectedAudio.length);
  assert.equal(body.provider.traceId, 'trace-route-json');
  assert.equal(body.provider.audioLength, 1234);
});



test('t2a routes expose isolated T2A timeout config at startup', async (t) => {
  const expectedAudio = Buffer.from('isolated timeout audio');

  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        trace_id: 'trace-timeout-isolation',
        data: {
          audio: expectedAudio.toString('hex'),
          format: 'mp3',
          audio_length: expectedAudio.length
        }
      }));
    });
  });
  t.after(() => mockServer.close());

  const serverProcess = spawnBridge({
    T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`,
    MINIMAX_API_KEY: 'test-key',
    T2A_INVOKE_TIMEOUT_MS: '2000',
    REWRITE_READY_TIMEOUT_MS: '50'
  });
  let startupOutput = '';
  serverProcess.stdout.on('data', (chunk) => {
    startupOutput += String(chunk);
  });
  serverProcess.stderr.on('data', (chunk) => {
    startupOutput += String(chunk);
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  assert.match(startupOutput, /"serviceReadyTimeoutMs":50/);
  assert.match(startupOutput, /"t2aInvokeTimeoutMs":2000/);

});

test('t2a routes reject unsupported stream requests with a stable error', async (t) => {
  const serverProcess = spawnBridge({ MINIMAX_API_KEY: 'test-key' });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await postJson('/t2a', { text: '你好', stream: true }, authHeaders);
  const body = await response.json();

  assert.equal(response.status, 501);
  assert.equal(body.error.code, 'STREAMING_UNSUPPORTED');
  assert.equal(body.error.message, 'stream is not supported for t2a v1');
});

test('t2a routes enforce existing auth and identity gatekeeping', async (t) => {
  const serverProcess = spawnBridge({ MINIMAX_API_KEY: 'test-key' });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const missingAuthResponse = await postJson('/t2a', { text: '你好' });
  const missingAuthBody = await missingAuthResponse.json();
  assert.equal(missingAuthResponse.status, 401);
  assert.equal(missingAuthBody.error.code, 'AUTH_REQUIRED');

  const invalidDomainResponse = await postJson('/t2a', { text: '你好' }, {
    'X-Bridge-Auth': AUTH_SECRET,
    'X-Authenticated-Email': 'tester@example.com'
  });
  const invalidDomainBody = await invalidDomainResponse.json();
  assert.equal(invalidDomainResponse.status, 403);
  assert.equal(invalidDomainBody.error.code, 'FORBIDDEN_DOMAIN');

  const invalidIdentityResponse = await postJson('/t2a', { text: '你好' }, {
    'X-Bridge-Auth': AUTH_SECRET,
    'X-Authenticated-Email': 'tester@hs.edu.hk,other@hs.edu.hk'
  });
  const invalidIdentityBody = await invalidIdentityResponse.json();
  assert.equal(invalidIdentityResponse.status, 401);
  assert.equal(invalidIdentityBody.error.code, 'AUTH_HEADER_INVALID');
});

test('t2a routes reject requests when Minimax API key is missing', async (t) => {
  const serverProcess = spawnBridge();
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await postJson('/t2a', { text: '你好' }, authHeaders);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'MINIMAX_API_KEY_MISSING');
});

test('t2a routes reject unsupported providers without calling Minimax', async (t) => {
  let minimaxCalls = 0;
  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    minimaxCalls += 1;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'should not be called' }));
    });
  });
  t.after(() => mockServer.close());

  const serverProcess = spawnBridge({
    T2A_PROVIDER: 'unknown-provider',
    T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`,
    MINIMAX_API_KEY: 'test-key'
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  for (const pathname of ['/t2a', '/api/t2a']) {
    const response = await postJson(pathname, { text: '你好' }, authHeaders);
    const body = await response.json();

    assert.equal(response.status, 501);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'UNSUPPORTED_PROVIDER');
    assert.equal(body.error.message, 'Provider "unknown-provider" is not supported for t2a');
  }

  assert.equal(minimaxCalls, 0);
});

test('T2A configured budgets preserve alias and audio contracts without invoking over-limit input', async (t) => {
  const captured = [];
  const audio = Buffer.from('mock mp3 budget boundary '.repeat(4));
  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { audio: audio.toString('hex'), format: 'mp3' } }));
    });
  });
  t.after(() => mockServer.close());
  for (const [setting, limit] of [['', 200], ['500', 500], ['1000', 1000], ['1001', 1000], ['bad', 200]]) {
    const bridge = spawnBridge({
      MINIMAX_API_KEY: 'test-key', T2A_MAX_TEXT_LENGTH: setting,
      T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`
    });
    try {
      await waitForServerReady(bridge);
      const text = '中'.repeat(limit - 2) + '😊。';
      for (const path of ['/t2a', '/api/t2a']) {
        const response_mode = path === '/t2a' ? 'binary' : 'base64_json';
        const accepted = await postJson(path, { text: `  ${text}\n`, response_mode }, authHeaders);
        assert.equal(accepted.status, 200);
        assert.equal(captured.at(-1).text, text);
        if (response_mode === 'binary') {
          assert.match(accepted.headers.get('content-type'), /audio\/mpeg/);
          assert.ok(accepted.headers.get('content-disposition'));
          assert.deepEqual(Buffer.from(await accepted.arrayBuffer()), audio);
        } else {
          const body = await accepted.json();
          assert.equal(body.ok, true);
          assert.equal(body.audio, audio.toString('base64'));
          assert.equal(body.size, audio.length);
        }
        const callsBefore = captured.length;
        const rejected = await postJson(path, { text: text + '！' }, authHeaders);
        assert.equal(rejected.status, 413);
        assert.equal((await rejected.json()).error.code, 'TOO_LONG');
        assert.equal(captured.length, callsBefore);
      }
    } finally {
      if (bridge.exitCode === null) {
        const exited = new Promise((resolve) => bridge.once('exit', resolve));
        bridge.kill('SIGTERM');
        await exited;
      }
    }
  }
});

test('t2a routes preserve validation errors for invalid, missing, and overlong text', async (t) => {
  const serverProcess = spawnBridge({
    MINIMAX_API_KEY: 'test-key',
    T2A_MAX_TEXT_LENGTH: '4'
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const invalidTextResponse = await postJson('/t2a', { text: 123 }, authHeaders);
  const invalidTextBody = await invalidTextResponse.json();
  assert.equal(invalidTextResponse.status, 400);
  assert.equal(invalidTextBody.error.code, 'INVALID_INPUT');

  const missingTextResponse = await postJson('/t2a', {}, authHeaders);
  const missingTextBody = await missingTextResponse.json();
  assert.equal(missingTextResponse.status, 400);
  assert.equal(missingTextBody.error.code, 'INVALID_INPUT');

  const overlongResponse = await postJson('/t2a', { text: 'a😊bcd' }, authHeaders);
  const overlongBody = await overlongResponse.json();
  assert.equal(overlongResponse.status, 413);
  assert.equal(overlongBody.error.code, 'TOO_LONG');
});


test('rewrite and t2a routes use independent service-specific limiter buckets', async (t) => {
  const expectedAudio = Buffer.from('independent limiter audio payload');
  let rewriteCalls = 0;
  let t2aCalls = 0;

  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.url === '/rewrite') {
        rewriteCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply: '正式：獨立配額測試' }));
        return;
      }

      if (req.url === '/t2a') {
        t2aCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          trace_id: 'trace-rate-limit-split',
          data: {
            audio: expectedAudio.toString('hex'),
            format: 'mp3',
            audio_length: expectedAudio.length
          }
        }));
        return;
      }

      res.writeHead(404).end();
    });
  });
  t.after(() => mockServer.close());

  const serverProcess = spawnBridge({
    REWRITE_MINIMAX_API_URL: `http://127.0.0.1:${port}/rewrite`,
    T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`,
    MINIMAX_API_KEY: 'test-key',
    RATE_LIMIT_GLOBAL_MAX_REQUESTS: '20',
    RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC: '60',
    RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS: '1',
    RATE_LIMIT_T2A_AUTH_WINDOW_SEC: '60',
    RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: '2'
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const rewriteFirst = await postJson('/rewrite', { text: '我今日想請假。' }, authHeaders);
  const rewriteFirstBody = await rewriteFirst.json();
  assert.equal(rewriteFirst.status, 200);
  assert.equal(rewriteFirstBody.ok, true);

  const rewriteSecond = await postJson('/rewrite', { text: '我聽日會返學。' }, authHeaders);
  const rewriteSecondBody = await rewriteSecond.json();
  assert.equal(rewriteSecond.status, 429);
  assert.equal(rewriteSecondBody.error.code, 'RATE_LIMITED');
  assert.equal(rewriteSecondBody.limit.scope, 'rewrite');

  const t2aFirst = await postJson('/t2a', { text: '你好，世界' }, authHeaders);
  assert.equal(t2aFirst.status, 200);
  assert.equal(await t2aFirst.arrayBuffer().then((buf) => Buffer.from(buf).equals(expectedAudio)), true);

  const t2aSecond = await postJson('/t2a', { text: '你好，再見' }, authHeaders);
  assert.equal(t2aSecond.status, 200);

  const t2aThird = await postJson('/t2a', { text: '你好，第三次' }, authHeaders);
  const t2aThirdBody = await t2aThird.json();
  assert.equal(t2aThird.status, 429);
  assert.equal(t2aThirdBody.error.code, 'RATE_LIMITED');
  assert.equal(t2aThirdBody.limit.scope, 't2a');

  assert.equal(rewriteCalls, 1);
  assert.equal(t2aCalls, 2);
});

// Expected values are the reviewed public choices, independently of the resolver.
const reviewedVoiceChoices = [
  ['cantonese_male_1', 'Cantonese_PlayfulMan', 1.1, -1, 'Chinese,Yue'],
  ['cantonese_male_2', 'Cantonese_PlayfulMan', 1.1, 3, 'Chinese,Yue'],
  ['cantonese_male_3', 'Cantonese_ProfessionalHost（M)', 1.1, 1, 'Chinese,Yue'],
  ['cantonese_female_1', 'Cantonese_CuteGirl', 1.1, 2, 'Chinese,Yue'],
  ['cantonese_female_2', 'Cantonese_GentleLady', 1.1, 0, 'Chinese,Yue'],
  ['cantonese_female_3', 'Cantonese_KindWoman', 1.1, 1, 'Chinese,Yue'],
  ['cantonese_narrator_female', 'Cantonese_ProfessionalHost（F)', 1, 0, 'Chinese,Yue'],
  ['mandarin_narrator_female', 'Chinese (Mandarin)_News_Anchor', 1, 0, 'Chinese'],
  ['english_narrator_female', 'English_compelling_lady1', 0.85, 0, 'English']
];

async function captureVoiceRequests(t, envOverrides = {}) {
  const captured = [];
  const audio = Buffer.from('voice contract audio '.repeat(4));
  const { server, port } = await startMockMinimaxServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        trace_id: 'voice-contract',
        data: { audio: audio.toString('hex'), format: 'mp3', audio_length: audio.length }
      }));
    });
  });
  let bridge;
  t.after(async () => {
    if (bridge?.exitCode === null) {
      const exited = new Promise((resolve) => bridge.once('exit', resolve));
      bridge.kill('SIGTERM');
      await exited;
    }
    await new Promise((resolve) => server.close(resolve));
  });
  bridge = spawnBridge({
    MINIMAX_API_KEY: 'test-key',
    T2A_PROVIDER: 'minimax',
    T2A_MINIMAX_API_URL: 'http://127.0.0.1:' + port + '/t2a',
    T2A_MINIMAX_MODEL: 'speech-2.6-hd',
    T2A_MINIMAX_VOICE_ID: 'Cantonese_ProfessionalHost（F)',
    T2A_MINIMAX_SPEED: '1', T2A_MINIMAX_VOLUME: '1', T2A_MINIMAX_PITCH: '0',
    T2A_MAX_TEXT_LENGTH: '200',
    RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: '100', RATE_LIMIT_GLOBAL_MAX_REQUESTS: '1000',
    ...envOverrides
  });
  await waitForServerReady(bridge);
  return { captured, audio };
}

test('all nine voice choices preserve both route aliases and audio response contracts', async (t) => {
  const { captured, audio } = await captureVoiceRequests(t, {
    // Named choices must not inherit generic tuning overrides.
    T2A_MINIMAX_VOICE_ID: 'override-voice', T2A_MINIMAX_SPEED: '0.6',
    T2A_MINIMAX_VOLUME: '4', T2A_MINIMAX_PITCH: '-5'
  });
  for (const [choice, voiceId, speed, pitch, languageBoost] of reviewedVoiceChoices) {
    for (const path of ['/t2a', '/api/t2a']) {
      for (const mode of [undefined, 'base64_json']) {
        const response = await postJson(path, {
          text: '  你好，Hello！ ', voice_choice: ' ' + choice + ' ', response_mode: mode,
          sample_rate: 24000, bitrate: 64000
        }, authHeaders);
        assert.equal(response.status, 200, choice + ' ' + path);
        assert.deepEqual(captured.at(-1), {
          model: 'speech-2.6-hd', text: '你好，Hello！', stream: false,
          voice_setting: { voice_id: voiceId, speed, vol: 1, pitch },
          audio_setting: { sample_rate: 24000, bitrate: 64000, format: 'mp3', channel: 1 },
          language_boost: languageBoost, voice_modify: { pitch: 0, intensity: 0, timbre: 0 },
          output_format: 'hex'
        });
        if (mode === undefined) {
          assert.equal(response.headers.get('content-type'), 'audio/mpeg');
          assert.equal(response.headers.get('content-disposition'), 'inline; filename="speech.mp3"');
          assert.equal(response.headers.get('content-length'), String(audio.length));
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
        } else {
          const body = await response.json();
          assert.deepEqual(Object.keys(body).sort(), ['ok', 'audio', 'format', 'mime', 'contentType', 'size', 'provider'].sort());
          assert.equal(body.ok, true);
          assert.equal(body.audio, audio.toString('base64'));
          assert.equal(body.format, 'mp3');
          assert.equal(body.mime, 'audio/mpeg');
          assert.equal(body.contentType, 'audio/mpeg');
          assert.equal(body.size, audio.length);
          assert.equal(body.provider.traceId, 'voice-contract');
        }
      }
    }
  }
  assert.equal(captured.length, 36);
});

test('voice choice errors and gatekeeping never invoke MiniMax', async (t) => {
  const { captured } = await captureVoiceRequests(t);
  for (const path of ['/t2a', '/api/t2a']) {
    for (const choice of [null, '', '   ', 1, false, {}, [], 'missing', '__proto__', 'constructor', 'CANTONESE_MALE_1']) {
      const response = await postJson(path, { text: '你好', voice_choice: choice }, authHeaders);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'INVALID_INPUT');
    }
    for (const field of ['voice_id', 'language_boost', 'speed', 'volume', 'pitch']) {
      for (const value of [null, field === 'voice_id' ? 'raw-voice' : field === 'language_boost' ? 'English' : 1]) {
        const response = await postJson(path, { text: '你好', voice_choice: 'cantonese_male_1', [field]: value }, authHeaders);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'INVALID_INPUT');
      }
    }
    for (const [body, headers, status, code] of [
      [{ text: '你好', voice_choice: 'cantonese_male_1' }, {}, 401, 'AUTH_REQUIRED'],
      [{ text: '你好', voice_choice: 'cantonese_male_1' }, { ...authHeaders, 'X-Authenticated-Email': 'other@example.com' }, 403, 'FORBIDDEN_DOMAIN'],
      [{ text: '你好', voice_choice: 'cantonese_male_1', stream: true }, authHeaders, 501, 'STREAMING_UNSUPPORTED'],
      [{ text: '中'.repeat(201), voice_choice: 'cantonese_male_1' }, authHeaders, 413, 'TOO_LONG']
    ]) {
      const response = await postJson(path, body, headers);
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
  }
  assert.equal(captured.length, 0);
});

test('named choices preserve missing-key and unsupported-provider errors', async (t) => {
  for (const [env, status, code] of [
    [{ MINIMAX_API_KEY: '' }, 503, 'MINIMAX_API_KEY_MISSING'],
    [{ T2A_PROVIDER: 'unknown-provider' }, 501, 'UNSUPPORTED_PROVIDER']
  ]) {
    await t.test(code, async (subtest) => {
      const { captured } = await captureVoiceRequests(subtest, env);
      for (const path of ['/t2a', '/api/t2a']) {
        const response = await postJson(path, { text: '你好', voice_choice: 'cantonese_male_1' }, authHeaders);
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.code, code);
      }
      assert.equal(captured.length, 0);
    });
  }
});

test('existing worksheet and roleplay raw requests preserve explicit and inherited settings', async (t) => {
  const fixtures = [
    { voice_id: 'Cantonese_ProfessionalHost（F)', language_boost: 'Chinese,Yue' },
    { voice_id: 'Chinese (Mandarin)_News_Anchor', language_boost: 'Chinese' },
    { voice_id: 'English_compelling_lady1', language_boost: 'English', speed: 0.85 },
    {},
    { voice_id: 'Cantonese_PlayfulMan', speed: 1.1, volume: 1, pitch: -1 },
    { voice_id: 'Cantonese_PlayfulMan', speed: 1.1, volume: 1, pitch: 3 },
    { voice_id: 'Cantonese_CuteGirl', speed: 1.1, volume: 1, pitch: 2 },
    { voice_id: 'Cantonese_GentleLady', speed: 1.1, volume: 1, pitch: 0 }
  ];
  for (const defaults of [
    { voiceId: 'Cantonese_ProfessionalHost（F)', speed: 1, volume: 1, pitch: 0 },
    { voiceId: 'custom-default', speed: 0.7, volume: 2, pitch: -2 }
  ]) {
    await t.test(defaults.voiceId, async (subtest) => {
      const { captured, audio } = await captureVoiceRequests(subtest, {
        T2A_MINIMAX_VOICE_ID: defaults.voiceId,
        T2A_MINIMAX_SPEED: String(defaults.speed), T2A_MINIMAX_VOLUME: String(defaults.volume),
        T2A_MINIMAX_PITCH: String(defaults.pitch)
      });
      for (const fixture of fixtures) {
        for (const path of ['/t2a', '/api/t2a']) {
          const response = await postJson(path, { text: '原有設定', ...fixture }, authHeaders);
          assert.equal(response.status, 200);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
          assert.deepEqual(captured.at(-1).voice_setting, {
            voice_id: fixture.voice_id ?? defaults.voiceId, speed: fixture.speed ?? defaults.speed,
            vol: fixture.volume ?? defaults.volume, pitch: fixture.pitch ?? defaults.pitch
          });
          assert.equal(captured.at(-1).language_boost, fixture.language_boost ?? 'Chinese,Yue');
          assert.deepEqual(captured.at(-1).voice_modify, { pitch: 0, intensity: 0, timbre: 0 });
          assert.equal(captured.at(-1).model, 'speech-2.6-hd');
        }
      }
      assert.equal(captured.length, 16);
    });
  }
});
