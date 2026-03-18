const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClientIdentityResolver,
  parseTrustedProxyAddresses,
  normalizeRemoteAddress
} = require('../auth/client-identity');

function createReq({ headers = {}, remoteAddress = '127.0.0.1', ip = null } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    headers: normalized,
    ip,
    socket: { remoteAddress },
    get(name) {
      return normalized[String(name).toLowerCase()];
    }
  };
}

test('normalizeRemoteAddress strips IPv6 IPv4 prefix', () => {
  assert.equal(normalizeRemoteAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeRemoteAddress('127.0.0.1'), '127.0.0.1');
});

test('parseTrustedProxyAddresses returns localhost defaults', () => {
  const defaults = parseTrustedProxyAddresses('');
  assert.ok(defaults.has('127.0.0.1'));
  assert.ok(defaults.has('::1'));
});

test('uses trusted oidc header as limiter key only when proxy source is trusted and shared secret matches', () => {
  const resolver = createClientIdentityResolver({
    bridgeInternalAuthSecret: 'shared-secret',
    trustedProxyAddresses: new Set(['127.0.0.1'])
  });

  const req = createReq({
    headers: {
      'X-Bridge-Auth': 'shared-secret',
      'X-Authenticated-Email': 'Tester@HS.EDU.HK'
    },
    remoteAddress: '127.0.0.1'
  });

  resolver(req, {}, () => {});

  assert.deepEqual(req.clientIdentity, {
    limiterKey: 'user:tester@hs.edu.hk',
    source: 'oidc',
    headerName: 'X-Authenticated-Email',
    value: 'tester@hs.edu.hk',
    remoteAddress: '127.0.0.1'
  });
});

test('falls back to ip limiter key when request is from non-trusted source even with spoofed headers', () => {
  const resolver = createClientIdentityResolver({
    bridgeInternalAuthSecret: 'shared-secret',
    trustedProxyAddresses: new Set(['127.0.0.1'])
  });

  const req = createReq({
    headers: {
      'X-Bridge-Auth': 'shared-secret',
      'X-Authenticated-Email': 'spoofed@hs.edu.hk',
      'X-Forwarded-For': '203.0.113.88'
    },
    ip: '203.0.113.88',
    remoteAddress: '198.51.100.24'
  });

  resolver(req, {}, () => {});

  assert.deepEqual(req.clientIdentity, {
    limiterKey: 'ip:198.51.100.24',
    source: 'ip',
    headerName: null,
    value: '198.51.100.24',
    remoteAddress: '198.51.100.24'
  });
});

test('falls back to ip limiter key when auth secret is missing', () => {
  const resolver = createClientIdentityResolver({
    bridgeInternalAuthSecret: '',
    trustedProxyAddresses: new Set(['127.0.0.1'])
  });

  const req = createReq({
    headers: {
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    },
    remoteAddress: '127.0.0.1'
  });

  resolver(req, {}, () => {});

  assert.equal(req.clientIdentity.limiterKey, 'ip:127.0.0.1');
  assert.equal(req.clientIdentity.source, 'ip');
});

test('uses Express-computed req.ip for fallback limiter identity only when enabled', () => {
  const trustedProxyAddresses = new Set(['127.0.0.1']);

  const withTrustProxyResolver = createClientIdentityResolver({
    bridgeInternalAuthSecret: 'shared-secret',
    trustedProxyAddresses,
    preferExpressIp: true
  });

  const withoutTrustProxyResolver = createClientIdentityResolver({
    bridgeInternalAuthSecret: 'shared-secret',
    trustedProxyAddresses,
    preferExpressIp: false
  });

  const trustedProxyReq = createReq({
    headers: {
      'X-Bridge-Auth': 'shared-secret'
    },
    ip: '203.0.113.9',
    remoteAddress: '127.0.0.1'
  });

  withTrustProxyResolver(trustedProxyReq, {}, () => {});
  assert.equal(trustedProxyReq.clientIdentity.limiterKey, 'ip:203.0.113.9');
  assert.equal(trustedProxyReq.clientIdentity.remoteAddress, '127.0.0.1');

  const strictReq = createReq({
    headers: {
      'X-Bridge-Auth': 'shared-secret'
    },
    ip: '203.0.113.9',
    remoteAddress: '127.0.0.1'
  });

  withoutTrustProxyResolver(strictReq, {}, () => {});
  assert.equal(strictReq.clientIdentity.limiterKey, 'ip:127.0.0.1');
  assert.equal(strictReq.clientIdentity.remoteAddress, '127.0.0.1');
});
