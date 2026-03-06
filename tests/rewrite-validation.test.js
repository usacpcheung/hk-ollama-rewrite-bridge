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
