const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const BASE_URL = 'http://127.0.0.1:3001';
const AUTH_SECRET = 'test-secret';

const AUTH_BASELINE_MATRIX = [
  {
    name: 'missing X-Bridge-Auth',
    headers: { 'X-Authenticated-Email': 'tester@hs.edu.hk' },
    expected: {
      status: 401,
      errorCode: 'AUTH_REQUIRED',
      errorMessage: 'Login required'
    }
  },
  {
    name: 'wrong X-Bridge-Auth',
    headers: {
      'X-Bridge-Auth': 'wrong-secret',
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    expected: {
      status: 401,
      errorCode: 'AUTH_REQUIRED',
      errorMessage: 'Login required'
    }
  },
  {
    name: 'missing X-Authenticated-Email',
    headers: { 'X-Bridge-Auth': AUTH_SECRET },
    expected: {
      status: 401,
      errorCode: 'AUTH_REQUIRED',
      errorMessage: 'Login required'
    }
  },
  {
    name: 'malformed X-Authenticated-Email (comma multi-value)',
    headers: {
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@hs.edu.hk,other@hs.edu.hk'
    },
    expected: {
      status: 401,
      errorCode: 'AUTH_HEADER_INVALID',
      errorMessage: 'Invalid authentication header'
    }
  },
  {
    name: 'non-@hs.edu.hk email',
    headers: {
      'X-Bridge-Auth': AUTH_SECRET,
      'X-Authenticated-Email': 'tester@example.com'
    },
    expected: {
      status: 403,
      errorCode: 'FORBIDDEN_DOMAIN',
      errorMessage: 'Only hs.edu.hk accounts are allowed'
    }
  }
];

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

async function postRewrite(headers = {}) {
  const response = await fetch(`${BASE_URL}/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify({ text: '測試文字' })
  });

  const body = await response.json();
  return { status: response.status, body };
}

test('POST /rewrite auth baseline parity matrix', async (t) => {
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      WARMUP_ON_START: 'false',
      BRIDGE_INTERNAL_AUTH_SECRET: AUTH_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logLines = [];
  const collectLogs = (chunk) => {
    const lines = String(chunk)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

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

  for (const scenario of AUTH_BASELINE_MATRIX) {
    const result = await postRewrite(scenario.headers);

    assert.equal(result.status, scenario.expected.status, `${scenario.name} status mismatch`);
    assert.equal(result.body?.error?.code, scenario.expected.errorCode, `${scenario.name} error.code mismatch`);
    assert.equal(result.body?.error?.message, scenario.expected.errorMessage, `${scenario.name} error.message mismatch`);
  }

  const authFailureLogLines = logLines.filter((line) => line.includes('"auth":{'));
  assert.ok(authFailureLogLines.length >= AUTH_BASELINE_MATRIX.length, 'auth failures should still emit request logs');

  const authFailureCodes = new Set(
    authFailureLogLines
      .map((line) => {
        try {
          return JSON.parse(line)?.auth?.code || null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  assert.ok(authFailureCodes.has('AUTH_REQUIRED'));
  assert.ok(authFailureCodes.has('AUTH_HEADER_INVALID'));
  assert.ok(authFailureCodes.has('FORBIDDEN_DOMAIN'));

  const validHeadersResult = await postRewrite({
    'X-Bridge-Auth': AUTH_SECRET,
    'X-Authenticated-Email': 'tester@hs.edu.hk'
  });

  assert.notEqual(validHeadersResult.status, 401);
  assert.notEqual(validHeadersResult.status, 403);
  assert.notEqual(validHeadersResult.body?.error?.code, 'AUTH_REQUIRED');
  assert.notEqual(validHeadersResult.body?.error?.code, 'AUTH_HEADER_INVALID');
  assert.notEqual(validHeadersResult.body?.error?.code, 'FORBIDDEN_DOMAIN');
});
