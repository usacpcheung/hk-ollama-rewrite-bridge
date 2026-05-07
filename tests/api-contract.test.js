const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BASE_URL = 'http://127.0.0.1:3001';
const AUTH_SECRET = 'test-secret';

const authHeaders = {
  'X-Bridge-Auth': AUTH_SECRET,
  'X-Authenticated-Email': 'tester@hs.edu.hk'
};

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

function startMockProviderServer({ rewriteText, rewriteStreamText, audioBuffer }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const payload = raw ? JSON.parse(raw) : {};

        if (req.url === '/rewrite') {
          if (payload.stream === true) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({
              object: 'chat.completion.chunk',
              choices: [{ delta: { content: rewriteStreamText } }]
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              object: 'chat.completion',
              choices: [{ finish_reason: 'stop', message: { content: rewriteStreamText } }],
              usage: { total_tokens: 8 }
            })}\n\n`);
            res.end();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            reply: rewriteText,
            usage: { total_tokens: 6 }
          }));
          return;
        }

        if (req.url === '/t2a') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            trace_id: 'trace-contract-t2a',
            data: {
              audio: audioBuffer.toString('hex'),
              format: 'mp3',
              audio_length: audioBuffer.length
            }
          }));
          return;
        }

        res.writeHead(404).end();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function spawnBridge(envOverrides = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET,
      REWRITE_PROVIDER: 'minimax',
      REWRITE_STREAMING_ENABLED: 'true',
      MINIMAX_API_KEY: 'test-key',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
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

test('rewrite and t2a preserve current public HTTP response contracts', async (t) => {
  const audioBuffer = Buffer.from('contract mp3 payload '.repeat(4));
  const { server: mockServer, port } = await startMockProviderServer({
    rewriteText: '正式中文結果',
    rewriteStreamText: '串流正式中文',
    audioBuffer
  });
  t.after(() => mockServer.close());

  const serverProcess = spawnBridge({
    REWRITE_MINIMAX_API_URL: `http://127.0.0.1:${port}/rewrite`,
    T2A_MINIMAX_API_URL: `http://127.0.0.1:${port}/t2a`
  });
  t.after(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  await waitForServerReady(serverProcess);

  const rewriteResponse = await postJson('/rewrite', { text: '我今日想請假。' }, authHeaders);
  const rewriteBody = await rewriteResponse.json();
  assert.equal(rewriteResponse.status, 200);
  assert.deepEqual(Object.keys(rewriteBody).sort(), ['ok', 'result', 'usage']);
  assert.equal(rewriteBody.ok, true);
  assert.equal(rewriteBody.result, '正式中文結果');
  assert.deepEqual(rewriteBody.usage, { total_tokens: 6 });

  const rewriteStreamResponse = await postJson('/rewrite', {
    text: '我今日想請假。',
    stream: true
  }, authHeaders);
  const rewriteStreamBody = await rewriteStreamResponse.text();
  const rewriteStreamChunks = rewriteStreamBody.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rewriteStreamResponse.status, 200);
  assert.match(rewriteStreamResponse.headers.get('content-type') || '', /^application\/x-ndjson/);
  assert.deepEqual(rewriteStreamChunks, [
    { response: '串流正式中文', done: false },
    {
      response: '',
      done: true,
      usage: { total_tokens: 8 },
      done_reason: 'stop'
    }
  ]);

  const t2aBinaryResponse = await postJson('/t2a', { text: '你好，世界' }, authHeaders);
  const t2aBinaryBody = Buffer.from(await t2aBinaryResponse.arrayBuffer());
  assert.equal(t2aBinaryResponse.status, 200);
  assert.equal(t2aBinaryResponse.headers.get('content-type'), 'audio/mpeg');
  assert.equal(t2aBinaryResponse.headers.get('content-disposition'), 'inline; filename="speech.mp3"');
  assert.deepEqual(t2aBinaryBody, audioBuffer);

  const t2aJsonResponse = await postJson('/api/t2a', {
    text: '你好，世界',
    response_mode: 'base64_json'
  }, authHeaders);
  const t2aJsonBody = await t2aJsonResponse.json();
  assert.equal(t2aJsonResponse.status, 200);
  assert.deepEqual(Object.keys(t2aJsonBody).sort(), [
    'audio',
    'contentType',
    'format',
    'mime',
    'ok',
    'provider',
    'size'
  ]);
  assert.equal(t2aJsonBody.ok, true);
  assert.equal(t2aJsonBody.audio, audioBuffer.toString('base64'));
  assert.equal(t2aJsonBody.format, 'mp3');
  assert.equal(t2aJsonBody.mime, 'audio/mpeg');
  assert.equal(t2aJsonBody.contentType, 'audio/mpeg');
  assert.equal(t2aJsonBody.size, audioBuffer.length);
  assert.equal(t2aJsonBody.provider.traceId, 'trace-contract-t2a');
  assert.equal(t2aJsonBody.provider.audioLength, audioBuffer.length);
});
