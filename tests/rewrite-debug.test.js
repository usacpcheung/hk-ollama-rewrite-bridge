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

function createMinimaxStubServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '測試' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-debug',
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: '正式書面中文' }
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function postRewrite({ text, stream = false, debugHeader, expectStream = false }) {
  const response = await fetch(`${BASE_URL}/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk',
      ...(debugHeader ? { 'X-Debug-Raw': debugHeader } : {})
    },
    body: JSON.stringify({ text, stream })
  });

  if (expectStream) {
    const raw = await response.text();
    return {
      status: response.status,
      lines: raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    };
  }

  return { status: response.status, body: await response.json() };
}

test('rewrite debug payload gate: off by default, on when env and header enabled', async (t) => {
  const minimaxStub = await createMinimaxStubServer();
  t.after(() => minimaxStub.server.close());

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      MINIMAX_API_STYLE: 'openai_compatible',
      MINIMAX_OPENAI_BASE_URL: minimaxStub.baseUrl,
      MINIMAX_MODEL: 'M2-her',
      MINIMAX_API_KEY: 'test-key',
      WARMUP_ON_START: 'false',
      REWRITE_DEBUG_RAW_RESPONSE: 'true',
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

  const debugOff = await postRewrite({ text: '你今日好嗎？' });
  assert.equal(debugOff.status, 200);
  assert.equal(debugOff.body.ok, true);
  assert.equal('debug' in debugOff.body, false);

  const debugOn = await postRewrite({ text: '你今日好嗎？', debugHeader: '1' });
  assert.equal(debugOn.status, 200);
  assert.equal(debugOn.body.ok, true);
  assert.equal(typeof debugOn.body.debug, 'object');
  assert.equal(debugOn.body.debug.finishReason, 'stop');
  assert.equal(typeof debugOn.body.debug.snippetLength, 'number');
});

test('rewrite stream emits done chunk with debug payload when enabled', async (t) => {
  const minimaxStub = await createMinimaxStubServer();
  t.after(() => minimaxStub.server.close());

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      MINIMAX_API_STYLE: 'openai_compatible',
      MINIMAX_OPENAI_BASE_URL: minimaxStub.baseUrl,
      MINIMAX_MODEL: 'M2-her',
      MINIMAX_API_KEY: 'test-key',
      WARMUP_ON_START: 'false',
      REWRITE_DEBUG_RAW_RESPONSE: 'true',
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

  const streamResult = await postRewrite({
    text: '我想請半日假',
    stream: true,
    debugHeader: '1',
    expectStream: true
  });

  assert.equal(streamResult.status, 200);
  const doneLine = streamResult.lines.find((entry) => entry.done === true);
  assert.ok(doneLine);
  assert.equal(doneLine.done_reason, 'stop');
  assert.equal(typeof doneLine.debug, 'object');
  assert.equal(doneLine.debug.finishReason, 'stop');
});
