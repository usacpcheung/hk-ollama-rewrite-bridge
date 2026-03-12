const test = require('node:test');
const assert = require('node:assert/strict');
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

async function postRewrite(text) {
  const response = await fetch(`${BASE_URL}/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    body: JSON.stringify({ text })
  });

  const body = await response.json();
  return { status: response.status, body };
}

test('POST /rewrite max-length validation counts Unicode characters instead of UTF-16 code units', async (t) => {
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      WARMUP_ON_START: 'false',
      REWRITE_MAX_TEXT_LENGTH: '4',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const bmpWithinLimit = await postRewrite('測試文字');
  assert.notEqual(bmpWithinLimit.status, 413);
  assert.notEqual(bmpWithinLimit.body?.error?.code, 'TOO_LONG');

  const bmpOverLimit = await postRewrite('測試文字超');
  assert.equal(bmpOverLimit.status, 413);
  assert.equal(bmpOverLimit.body?.error?.code, 'TOO_LONG');

  const surrogateWithinLimit = await postRewrite('a😊bc');
  assert.notEqual(surrogateWithinLimit.status, 413);
  assert.notEqual(surrogateWithinLimit.body?.error?.code, 'TOO_LONG');

  const surrogateOverLimit = await postRewrite('a😊bcd');
  assert.equal(surrogateOverLimit.status, 413);
  assert.equal(surrogateOverLimit.body?.error?.code, 'TOO_LONG');
});

const http = require('node:http');

function startMockMinimaxServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}



test('POST /rewrite sends one user message with minimax default template when system prompt is empty', async (t) => {
  let capturedMessages = null;
  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      capturedMessages = payload.messages;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: '改寫完成' }));
    });
  });

  t.after(() => {
    mockServer.close();
  });

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET,
      MINIMAX_API_URL: `http://127.0.0.1:${port}/v1/text/chatcompletion_v2`,
      MINIMAX_API_KEY: 'minimax-test-key',
      MINIMAX_SYSTEM_PROMPT: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await fetch(`${BASE_URL}/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    body: JSON.stringify({ text: '我今日唔係好舒服，想請半日假。' })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(capturedMessages, [
    {
      role: 'user',
      content: '把下方文字改寫為繁體書面語：\n我今日唔係好舒服，想請半日假。'
    }
  ]);
});

test('POST /rewrite stream done chunk includes usage and debug logs redact secrets', async (t) => {
  const minimaxSecret = 'minimax-test-key';
  const { server: mockServer, port } = await startMockMinimaxServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: { content: '你好' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { content: '你好' } }], usage: { total_tokens: 6 } })}\n\n`);
      res.end();
    });
  });

  t.after(() => {
    mockServer.close();
  });

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET,
      REWRITE_DEBUG_RAW_OUTPUT: 'true',
      MINIMAX_API_URL: `http://127.0.0.1:${port}/v1/text/chatcompletion_v2`,
      MINIMAX_API_KEY: minimaxSecret
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logLines = [];
  const collectLogs = (chunk) => {
    const lines = String(chunk).split('\n').map((line) => line.trim()).filter(Boolean);
    logLines.push(...lines);
  };
  serverProcess.stdout.on('data', collectLogs);
  serverProcess.stderr.on('data', collectLogs);

  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const response = await fetch(`${BASE_URL}/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    body: JSON.stringify({ text: '測試', stream: true })
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  const chunks = body.trim().split('\n').map((line) => JSON.parse(line));
  const doneChunk = chunks.find((chunk) => chunk.done === true);
  assert.ok(doneChunk);
  assert.deepEqual(doneChunk.usage, { total_tokens: 6 });

  const providerRequestLog = logLines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((entry) => entry && entry.eventType === 'provider_request');

  assert.ok(providerRequestLog);
  const loggedHeaders = providerRequestLog.payload?.headers || providerRequestLog.headers;
  assert.ok(loggedHeaders);
  assert.equal(loggedHeaders.Authorization, '[REDACTED]');

  const allLogs = logLines.join('\n');
  assert.equal(allLogs.includes(minimaxSecret), false);
  assert.equal(allLogs.includes(AUTH_SECRET), false);
});
