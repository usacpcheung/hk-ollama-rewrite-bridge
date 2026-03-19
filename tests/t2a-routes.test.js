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
      assert.equal(payload.voice_setting.voice_id, 'female-tianmei');
      assert.equal(payload.audio_setting.format, 'mp3');

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
    response_mode: 'base64_json'
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
