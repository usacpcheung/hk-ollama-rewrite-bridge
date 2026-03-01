const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const serverModulePath = path.resolve(__dirname, '../server.js');
const providersModulePath = path.resolve(__dirname, '../providers/index.js');

function loadServerWithMockedProvider(envOverrides = {}) {
  const originalEnv = { ...process.env };
  const triggerWarmupCalls = [];

  process.env = {
    ...process.env,
    REWRITE_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'test-key',
    WARMUP_STARTUP_MAX_WAIT_MS: '50',
    WARMUP_STARTUP_RETRY_INTERVAL_MS: '5',
    ...envOverrides
  };

  delete require.cache[serverModulePath];
  delete require.cache[providersModulePath];

  require.cache[providersModulePath] = {
    id: providersModulePath,
    filename: providersModulePath,
    loaded: true,
    exports: {
      createProvider: () => ({
        getInfo: () => ({ provider: 'minimax' }),
        triggerWarmup: async () => {
          triggerWarmupCalls.push(Date.now());
          return { ok: true };
        },
        checkReadiness: async () => ({ ready: true, error: null }),
        rewrite: async () => ({ ok: true, data: { response: 'ok' } }),
        mapError: (err) => ({ code: 'ERROR', message: err.message, status: 500 })
      })
    }
  };

  const server = require(serverModulePath);

  const restore = () => {
    process.env = originalEnv;
    delete require.cache[serverModulePath];
    delete require.cache[providersModulePath];
  };

  return { server, triggerWarmupCalls, restore };
}

test('minimax startup warmup loop skips active warmup by default', async () => {
  const { server, triggerWarmupCalls, restore } = loadServerWithMockedProvider({
    MINIMAX_ACTIVE_STARTUP_PROBE: ''
  });

  try {
    await server.runStartupWarmupLoop();
    assert.equal(triggerWarmupCalls.length, 0);
  } finally {
    restore();
  }
});

test('minimax startup passive probe path does not call active warmup when explicitly enabled', async () => {
  const { server, triggerWarmupCalls, restore } = loadServerWithMockedProvider({
    MINIMAX_ACTIVE_STARTUP_PROBE: 'true'
  });

  try {
    await server.runStartupWarmupLoop();
    assert.equal(triggerWarmupCalls.length, 0);
  } finally {
    restore();
  }
});
