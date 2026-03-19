const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

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

async function startServerAndReadEffectiveConfig(overrides = {}) {
  const logLines = [];
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REWRITE_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'test-key',
      BRIDGE_INTERNAL_AUTH_SECRET: 'test-secret',
      ...overrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const collectLogs = (chunk) => {
    const lines = String(chunk)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    logLines.push(...lines);
  };

  serverProcess.stdout.on('data', collectLogs);
  serverProcess.stderr.on('data', collectLogs);

  await waitForServerReady(serverProcess);

  const config = logLines.reduce((found, line) => {
    if (found) {
      return found;
    }

    try {
      const parsed = JSON.parse(line);
      return parsed?.msg === 'Effective provider config' ? parsed : null;
    } catch {
      return null;
    }
  }, null);

  serverProcess.kill('SIGTERM');
  await new Promise((resolve) => serverProcess.once('exit', resolve));

  assert.ok(config, 'startup should emit effective config log line');
  return config;
}

test('WARMUP_ON_START accepts canonical true/false spellings', async () => {
  const falseCases = ['0', 'false', 'no', 'off'];
  for (const value of falseCases) {
    const config = await startServerAndReadEffectiveConfig({
      WARMUP_ON_START: value,
      MINIMAX_FAIL_OPEN_ON_IDLE: 'true'
    });
    assert.equal(config.warmupOnStart, false, `expected ${value} to parse as false`);
  }

  const trueCases = ['1', 'true', 'yes', 'on'];
  for (const value of trueCases) {
    const config = await startServerAndReadEffectiveConfig({
      WARMUP_ON_START: value,
      MINIMAX_FAIL_OPEN_ON_IDLE: 'false'
    });
    assert.equal(config.warmupOnStart, true, `expected ${value} to parse as true`);
  }
});

test('MINIMAX_FAIL_OPEN_ON_IDLE accepts canonical true/false spellings', async () => {
  const falseCases = ['0', 'false', 'no', 'off'];
  for (const value of falseCases) {
    const config = await startServerAndReadEffectiveConfig({
      WARMUP_ON_START: 'false',
      MINIMAX_FAIL_OPEN_ON_IDLE: value
    });
    assert.equal(config.minimaxFailOpenOnIdle, false, `expected ${value} to parse as false`);
  }

  const trueCases = ['1', 'true', 'yes', 'on'];
  for (const value of trueCases) {
    const config = await startServerAndReadEffectiveConfig({
      WARMUP_ON_START: 'false',
      MINIMAX_FAIL_OPEN_ON_IDLE: value
    });
    assert.equal(config.minimaxFailOpenOnIdle, true, `expected ${value} to parse as true`);
  }
});
