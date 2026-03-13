const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');

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

function startMockOllamaServer(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b-instruct' }] }));
        return;
      }

      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });

      req.on('end', () => {
        const payload = JSON.parse(raw || '{}');
        state.generatePayloads.push(payload);

        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write('{"response":"第一段","done":false}\n');
          setTimeout(() => {
            res.end('{"done":true,"done_reason":"stop"}\n');
          }, 150);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: '完整結果', done: true }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('POST /api/rewrite forwards stream intent and preserves JSON response for non-stream', async (t) => {
  const state = { generatePayloads: [] };
  const { server: mockServer, port } = await startMockOllamaServer(state);
  t.after(() => mockServer.close());

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'ollama',
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET,
      OLLAMA_URL: `http://127.0.0.1:${port}/api/generate`,
      OLLAMA_PS_URL: `http://127.0.0.1:${port}/api/ps`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await fetch(`${BASE_URL}/api/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    body: JSON.stringify({ text: '我今日唔係好舒服。' })
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.result, 'string');
  assert.equal(state.generatePayloads.length > 0, true);
  assert.equal(state.generatePayloads.at(-1).stream, false);
});

test('POST /api/rewrite streams NDJSON chunks without full buffering when stream=true', async (t) => {
  const state = { generatePayloads: [] };
  const { server: mockServer, port } = await startMockOllamaServer(state);
  t.after(() => mockServer.close());

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'ollama',
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET,
      OLLAMA_URL: `http://127.0.0.1:${port}/api/generate`,
      OLLAMA_PS_URL: `http://127.0.0.1:${port}/api/ps`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await fetch(`${BASE_URL}/api/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    body: JSON.stringify({ text: '我今日唔係好舒服。', stream: true })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/x-ndjson/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const firstChunkStart = Date.now();
  const firstRead = await reader.read();
  const firstChunkElapsedMs = Date.now() - firstChunkStart;

  assert.equal(firstRead.done, false);
  const firstChunkText = decoder.decode(firstRead.value, { stream: true });
  assert.match(firstChunkText, /"done":false/);
  assert.equal(firstChunkElapsedMs < 140, true);

  let fullBody = firstChunkText;
  while (true) {
    const nextRead = await reader.read();
    if (nextRead.done) {
      break;
    }
    fullBody += decoder.decode(nextRead.value, { stream: true });
  }
  fullBody += decoder.decode();

  assert.match(fullBody, /"done":true/);
  assert.equal(state.generatePayloads.length > 0, true);
  assert.equal(state.generatePayloads.at(-1).stream, true);
});
