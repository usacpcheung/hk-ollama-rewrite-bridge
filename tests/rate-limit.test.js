const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePositiveIntegerEnv,
  buildRateLimitPolicyFromEnv,
  resolveRateLimitPrincipal,
  createFixedWindowRateLimiter,
  createRateLimitMiddlewares
} = require('../middleware/rate-limit');

function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('parsePositiveIntegerEnv throws for invalid values', () => {
  assert.throws(
    () => withEnv({ RATE_LIMIT_GLOBAL_MAX_REQUESTS: 'abc' }, () => parsePositiveIntegerEnv('RATE_LIMIT_GLOBAL_MAX_REQUESTS', 10)),
    /Invalid RATE_LIMIT_GLOBAL_MAX_REQUESTS/
  );
});

test('buildRateLimitPolicyFromEnv resolves defaults and overrides', () => {
  const policy = withEnv(
    {
      RATE_LIMIT_GLOBAL_WINDOW_SEC: '120',
      RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS: '15',
      RATE_LIMIT_REWRITE_IP_MAX_REQUESTS: '5'
    },
    () => buildRateLimitPolicyFromEnv()
  );

  assert.equal(policy.global.windowSec, 120);
  assert.equal(policy.rewrite.auth.maxRequests, 15);
  assert.equal(policy.rewrite.ip.maxRequests, 5);
  assert.equal(policy.ops.maxRequests, 1000);
});


test('buildRateLimitPolicyFromEnv keeps rewrite defaults unchanged and adds conservative t2a defaults', () => {
  const policy = withEnv(
    {
      RATE_LIMIT_GLOBAL_WINDOW_SEC: null,
      RATE_LIMIT_GLOBAL_MAX_REQUESTS: null,
      RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC: null,
      RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS: null,
      RATE_LIMIT_REWRITE_IP_WINDOW_SEC: null,
      RATE_LIMIT_REWRITE_IP_MAX_REQUESTS: null,
      RATE_LIMIT_T2A_AUTH_WINDOW_SEC: null,
      RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: null,
      RATE_LIMIT_T2A_IP_WINDOW_SEC: null,
      RATE_LIMIT_T2A_IP_MAX_REQUESTS: null,
      RATE_LIMIT_OPS_WINDOW_SEC: null,
      RATE_LIMIT_OPS_MAX_REQUESTS: null
    },
    () => buildRateLimitPolicyFromEnv()
  );

  assert.deepEqual(policy.rewrite, {
    auth: { windowSec: 60, maxRequests: 60 },
    ip: { windowSec: 60, maxRequests: 20 }
  });
  assert.deepEqual(policy.t2a, {
    auth: { windowSec: 60, maxRequests: 30 },
    ip: { windowSec: 60, maxRequests: 10 }
  });
});

test('buildRateLimitPolicyFromEnv resolves t2a values from dedicated env keys only', () => {
  const policy = withEnv(
    {
      RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC: '90',
      RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS: '19',
      RATE_LIMIT_REWRITE_IP_WINDOW_SEC: '75',
      RATE_LIMIT_REWRITE_IP_MAX_REQUESTS: '7',
      RATE_LIMIT_T2A_AUTH_WINDOW_SEC: '45',
      RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: '9',
      RATE_LIMIT_T2A_IP_WINDOW_SEC: '30',
      RATE_LIMIT_T2A_IP_MAX_REQUESTS: '3'
    },
    () => buildRateLimitPolicyFromEnv()
  );

  assert.deepEqual(policy.rewrite, {
    auth: { windowSec: 90, maxRequests: 19 },
    ip: { windowSec: 75, maxRequests: 7 }
  });
  assert.deepEqual(policy.t2a, {
    auth: { windowSec: 45, maxRequests: 9 },
    ip: { windowSec: 30, maxRequests: 3 }
  });
});

test('invalid t2a env values fail with the same parsing contract', () => {
  assert.throws(
    () => withEnv({ RATE_LIMIT_T2A_AUTH_MAX_REQUESTS: 'nope' }, () => buildRateLimitPolicyFromEnv()),
    /Invalid RATE_LIMIT_T2A_AUTH_MAX_REQUESTS/
  );

  assert.throws(
    () => withEnv({ RATE_LIMIT_T2A_IP_WINDOW_SEC: '0' }, () => buildRateLimitPolicyFromEnv()),
    /Invalid RATE_LIMIT_T2A_IP_WINDOW_SEC/
  );
});

test('resolveRateLimitPrincipal prefers trusted identity and falls back to ip', () => {
  const fromIdentity = resolveRateLimitPrincipal({
    clientIdentity: { source: 'oidc', value: 'student@hs.edu.hk' }
  });
  assert.deepEqual(fromIdentity, { key: 'user:student@hs.edu.hk', principalType: 'user' });

  const fromAuth = resolveRateLimitPrincipal({
    auth: { email: 'teacher@hs.edu.hk' }
  });
  assert.deepEqual(fromAuth, { key: 'user:teacher@hs.edu.hk', principalType: 'user' });

  const fromIp = resolveRateLimitPrincipal({
    ip: '::ffff:198.51.100.20'
  });
  assert.deepEqual(fromIp, { key: 'ip:198.51.100.20', principalType: 'ip' });
});

test('resolveRateLimitPrincipal uses precomputed ip limiter key from client identity', () => {
  const principal = resolveRateLimitPrincipal({
    clientIdentity: {
      limiterKey: 'ip:203.0.113.9',
      source: 'ip',
      value: '203.0.113.9',
      remoteAddress: '127.0.0.1'
    },
    auth: { email: 'teacher@hs.edu.hk' },
    ip: '203.0.113.9',
    socket: { remoteAddress: '127.0.0.1' }
  });

  assert.deepEqual(principal, { key: 'ip:203.0.113.9', principalType: 'ip' });
});

test('resolveRateLimitPrincipal falls back to req.ip when client identity is missing', () => {
  const principal = resolveRateLimitPrincipal({
    ip: '::ffff:198.51.100.20',
    socket: { remoteAddress: '127.0.0.1' }
  });

  assert.deepEqual(principal, { key: 'ip:198.51.100.20', principalType: 'ip' });
});

test('fixed window limiter returns stable 429 contract with retry headers', () => {
  const limiter = createFixedWindowRateLimiter({
    policyScope: 'rewrite',
    getPolicy: () => ({ windowSec: 1, maxRequests: 1 }),
    resolvePrincipal: () => ({ key: 'user:tester@hs.edu.hk', principalType: 'user' })
  });

  const req = {};
  const firstRes = createRes();
  let firstNextCalled = false;
  limiter(req, firstRes, () => {
    firstNextCalled = true;
  });

  assert.equal(firstNextCalled, true);
  assert.equal(firstRes.statusCode, null);

  const secondRes = createRes();
  let secondNextCalled = false;
  limiter(req, secondRes, () => {
    secondNextCalled = true;
  });

  assert.equal(secondNextCalled, false);
  assert.equal(secondRes.statusCode, 429);
  assert.ok(Number(secondRes.headers['Retry-After']) >= 1);
  assert.equal(secondRes.body.error.code, 'RATE_LIMITED');
  assert.equal(secondRes.body.error.reason, 'RATE_LIMIT_EXCEEDED');
  assert.equal(secondRes.body.limit.scope, 'rewrite');
  assert.equal(secondRes.body.limit.principalType, 'user');
});


test('createRateLimitMiddlewares keeps rewrite and t2a limiter buckets isolated', () => {
  const { rewriteLimiter, t2aLimiter } = createRateLimitMiddlewares({
    global: { windowSec: 60, maxRequests: 999 },
    rewrite: {
      auth: { windowSec: 60, maxRequests: 1 },
      ip: { windowSec: 60, maxRequests: 1 }
    },
    t2a: {
      auth: { windowSec: 60, maxRequests: 2 },
      ip: { windowSec: 60, maxRequests: 2 }
    },
    ops: { windowSec: 60, maxRequests: 999 }
  });

  const req = {
    clientIdentity: {
      source: 'oidc',
      value: 'tester@hs.edu.hk',
      limiterKey: 'user:tester@hs.edu.hk'
    }
  };

  const firstRewriteRes = createRes();
  let firstRewriteNext = false;
  rewriteLimiter(req, firstRewriteRes, () => {
    firstRewriteNext = true;
  });
  assert.equal(firstRewriteNext, true);

  const secondRewriteRes = createRes();
  rewriteLimiter(req, secondRewriteRes, () => {});
  assert.equal(secondRewriteRes.statusCode, 429);
  assert.equal(secondRewriteRes.body.limit.scope, 'rewrite');

  const firstT2aRes = createRes();
  let firstT2aNext = false;
  t2aLimiter(req, firstT2aRes, () => {
    firstT2aNext = true;
  });
  assert.equal(firstT2aNext, true);

  const secondT2aRes = createRes();
  let secondT2aNext = false;
  t2aLimiter(req, secondT2aRes, () => {
    secondT2aNext = true;
  });
  assert.equal(secondT2aNext, true);

  const thirdT2aRes = createRes();
  t2aLimiter(req, thirdT2aRes, () => {});
  assert.equal(thirdT2aRes.statusCode, 429);
  assert.equal(thirdT2aRes.body.limit.scope, 't2a');
});
