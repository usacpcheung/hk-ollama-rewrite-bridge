const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authenticateRequest,
  buildTokeninfoRequestUrl,
  isEmailDomainAuthorized,
  normalizeDomains,
  parseBearerToken,
  validateBearerToken
} = require('../auth');

test('parseBearerToken handles malformed and valid headers', () => {
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken('Token abc'), null);
  assert.equal(parseBearerToken('Bearer'), null);
  assert.equal(parseBearerToken('Bearer abc.def'), 'abc.def');
});

test('normalizeDomains trims and lowercases values', () => {
  assert.deepEqual(normalizeDomains(' Example.com, test.org ,,Sub.Domain '), [
    'example.com',
    'test.org',
    'sub.domain'
  ]);
});

test('isEmailDomainAuthorized validates against allowlist', () => {
  assert.equal(isEmailDomainAuthorized('user@example.com', []), true);
  assert.equal(isEmailDomainAuthorized('user@example.com', ['example.com']), true);
  assert.equal(isEmailDomainAuthorized('user@other.com', ['example.com']), false);
});

test('buildTokeninfoRequestUrl appends access_token query param', () => {
  const url = buildTokeninfoRequestUrl('https://auth.example/tokeninfo', 'abc123');
  assert.equal(url.toString(), 'https://auth.example/tokeninfo?access_token=abc123');
});

test('validateBearerToken marks 401 response as invalid token', async () => {
  const result = await validateBearerToken({
    token: 'bad',
    tokeninfoUrl: 'https://auth.example/tokeninfo',
    fetchImpl: async () => ({ ok: false, status: 401 })
  });

  assert.deepEqual(result, { status: 'invalid' });
});

test('authenticateRequest returns 503 when tokeninfo fetch errors', async () => {
  const req = { get: () => 'Bearer abc123' };
  const logs = [];

  const result = await authenticateRequest({
    req,
    tokeninfoUrl: 'https://auth.example/tokeninfo',
    allowedEmailDomains: ['example.com'],
    logger: (category) => logs.push(category),
    fetchImpl: async () => {
      throw new Error('network down');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'Auth service unavailable' });
  assert.deepEqual(logs, ['upstream_error']);
});

test('authenticateRequest returns 403 for unauthorized email domain', async () => {
  const req = { get: () => 'Bearer abc123' };
  const logs = [];

  const result = await authenticateRequest({
    req,
    tokeninfoUrl: 'https://auth.example/tokeninfo',
    allowedEmailDomains: ['example.com'],
    logger: (category) => logs.push(category),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ email: 'user@other.com' })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: 'Forbidden' });
  assert.deepEqual(logs, ['unauthorized_domain']);
});
