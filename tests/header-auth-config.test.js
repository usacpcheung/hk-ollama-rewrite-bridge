const test = require('node:test');
const assert = require('node:assert/strict');

const { createRewriteHeaderAuth } = require('../auth/header-auth');

function runAuth({ allowedEmailDomain, headers }) {
  const response = {
    status: null,
    code: null,
    message: null
  };
  const req = {
    auth: null,
    get(name) {
      return headers[name] || '';
    }
  };
  const res = {};
  let nextCalled = false;

  const middleware = createRewriteHeaderAuth({
    bridgeInternalAuthSecret: 'secret',
    allowedEmailDomain,
    errorResponse: (_res, status, code, message) => {
      response.status = status;
      response.code = code;
      response.message = message;
    }
  });

  middleware(req, res, () => {
    nextCalled = true;
  });

  return { response, req, nextCalled };
}

test('rewrite auth defaults to hs.edu.hk allowed domain', () => {
  const result = runAuth({
    headers: {
      'X-Bridge-Auth': 'secret',
      'X-Authenticated-Email': 'tester@hs.edu.hk'
    }
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.auth.email, 'tester@hs.edu.hk');
});

test('rewrite auth allows configured email domain', () => {
  const result = runAuth({
    allowedEmailDomain: '@example.edu',
    headers: {
      'X-Bridge-Auth': 'secret',
      'X-Authenticated-Email': 'teacher@example.edu'
    }
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.auth.email, 'teacher@example.edu');
});

test('rewrite auth normalizes configured email domain without leading at sign', () => {
  const result = runAuth({
    allowedEmailDomain: 'example.edu',
    headers: {
      'X-Bridge-Auth': 'secret',
      'X-Authenticated-Email': 'teacher@example.edu'
    }
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.auth.email, 'teacher@example.edu');
});

test('rewrite auth rejects emails outside configured domain', () => {
  const result = runAuth({
    allowedEmailDomain: '@example.edu',
    headers: {
      'X-Bridge-Auth': 'secret',
      'X-Authenticated-Email': 'teacher@hs.edu.hk'
    }
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.code, 'FORBIDDEN_DOMAIN');
  assert.equal(result.response.message, 'Only example.edu accounts are allowed');
});

test('rewrite auth keeps invalid and missing auth behavior unchanged', () => {
  const missingAuth = runAuth({
    headers: {
      'X-Authenticated-Email': 'teacher@example.edu'
    }
  });
  const invalidMultiValue = runAuth({
    allowedEmailDomain: '@example.edu',
    headers: {
      'X-Bridge-Auth': 'secret',
      'X-Authenticated-Email': 'teacher@example.edu,other@example.edu'
    }
  });

  assert.equal(missingAuth.response.status, 401);
  assert.equal(missingAuth.response.code, 'AUTH_REQUIRED');
  assert.equal(invalidMultiValue.response.status, 401);
  assert.equal(invalidMultiValue.response.code, 'AUTH_HEADER_INVALID');
});
