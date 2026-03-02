const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const serverModulePath = path.resolve(__dirname, '../server.js');
const providersModulePath = path.resolve(__dirname, '../providers/index.js');

function loadServerWithMockedProvider(envOverrides = {}) {
  const originalEnv = { ...process.env };

  process.env = {
    ...process.env,
    WARMUP_ON_START: 'false',
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
        getInfo: () => ({ provider: 'mock' }),
        triggerWarmup: async () => ({ ok: true }),
        checkReadiness: async () => ({ ready: true, error: null }),
        rewrite: async () => ({ ok: true, data: { response: '測試結果' } }),
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

  return { server, restore };
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function rewriteRequest(baseUrl, emailHeader) {
  const headers = { 'Content-Type': 'application/json' };
  if (emailHeader !== undefined) {
    headers['X-Authenticated-Email'] = emailHeader;
  }

  return fetch(`${baseUrl}/rewrite`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: '你今日得唔得閒？' })
  });
}

test('default auth domain accepts @hs.edu.hk email', async () => {
  const { server, restore } = loadServerWithMockedProvider();

  try {
    await withServer(server.app, async (baseUrl) => {
      const response = await rewriteRequest(baseUrl, 'user@hs.edu.hk');
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(typeof body.result, 'string');
    });
  } finally {
    restore();
  }
});

test('custom auth domain accepts configured domain and rejects default domain', async () => {
  const { server, restore } = loadServerWithMockedProvider({
    AUTH_ALLOWED_EMAIL_DOMAIN: '@example.edu'
  });

  try {
    await withServer(server.app, async (baseUrl) => {
      const accepted = await rewriteRequest(baseUrl, 'user@example.edu');
      assert.equal(accepted.status, 200);

      const rejected = await rewriteRequest(baseUrl, 'user@hs.edu.hk');
      const rejectedBody = await rejected.json();
      assert.equal(rejected.status, 403);
      assert.equal(rejectedBody.error.code, 'FORBIDDEN_DOMAIN');
      assert.match(rejectedBody.error.message, /@example\.edu/);
    });
  } finally {
    restore();
  }
});

test('invalid auth domain env falls back to default @hs.edu.hk', async () => {
  const { server, restore } = loadServerWithMockedProvider({
    AUTH_ALLOWED_EMAIL_DOMAIN: '@@bad domain'
  });

  try {
    await withServer(server.app, async (baseUrl) => {
      const accepted = await rewriteRequest(baseUrl, 'user@hs.edu.hk');
      assert.equal(accepted.status, 200);

      const rejected = await rewriteRequest(baseUrl, 'user@example.edu');
      const rejectedBody = await rejected.json();
      assert.equal(rejected.status, 403);
      assert.equal(rejectedBody.error.code, 'FORBIDDEN_DOMAIN');
      assert.match(rejectedBody.error.message, /@hs\.edu\.hk/);
    });
  } finally {
    restore();
  }
});

test('auth error codes remain unchanged for missing and multi-value headers', async () => {
  const { server, restore } = loadServerWithMockedProvider();

  try {
    await withServer(server.app, async (baseUrl) => {
      const missing = await rewriteRequest(baseUrl);
      const missingBody = await missing.json();
      assert.equal(missing.status, 401);
      assert.equal(missingBody.error.code, 'AUTH_REQUIRED');

      const invalid = await rewriteRequest(baseUrl, 'a@hs.edu.hk,b@hs.edu.hk');
      const invalidBody = await invalid.json();
      assert.equal(invalid.status, 401);
      assert.equal(invalidBody.error.code, 'AUTH_HEADER_INVALID');
    });
  } finally {
    restore();
  }
});

test('normalizeAllowedEmailDomain normalizes leading @ and lowercase', () => {
  const { normalizeAllowedEmailDomain } = require('../server');

  assert.equal(normalizeAllowedEmailDomain('HS.EDU.HK'), '@hs.edu.hk');
  assert.equal(normalizeAllowedEmailDomain('  @Example.EDU  '), '@example.edu');
  assert.equal(normalizeAllowedEmailDomain(''), null);
  assert.equal(normalizeAllowedEmailDomain('@@example.edu'), null);
});
