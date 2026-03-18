const { normalizeRemoteAddress } = require('../../auth/client-identity');

function parsePositiveIntegerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const rawValue = process.env[name];
  if (rawValue == null || String(rawValue).trim() === '') {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: expected integer between ${min} and ${max}, received "${rawValue}"`);
  }

  return parsed;
}

function buildRateLimitPolicyFromEnv() {
  return {
    global: {
      windowSec: parsePositiveIntegerEnv('RATE_LIMIT_GLOBAL_WINDOW_SEC', 60, { max: 3600 }),
      maxRequests: parsePositiveIntegerEnv('RATE_LIMIT_GLOBAL_MAX_REQUESTS', 300, { max: 100000 })
    },
    rewrite: {
      auth: {
        windowSec: parsePositiveIntegerEnv('RATE_LIMIT_REWRITE_AUTH_WINDOW_SEC', 60, { max: 3600 }),
        maxRequests: parsePositiveIntegerEnv('RATE_LIMIT_REWRITE_AUTH_MAX_REQUESTS', 60, { max: 100000 })
      },
      ip: {
        windowSec: parsePositiveIntegerEnv('RATE_LIMIT_REWRITE_IP_WINDOW_SEC', 60, { max: 3600 }),
        maxRequests: parsePositiveIntegerEnv('RATE_LIMIT_REWRITE_IP_MAX_REQUESTS', 20, { max: 100000 })
      }
    },
    ops: {
      windowSec: parsePositiveIntegerEnv('RATE_LIMIT_OPS_WINDOW_SEC', 60, { max: 3600 }),
      maxRequests: parsePositiveIntegerEnv('RATE_LIMIT_OPS_MAX_REQUESTS', 1000, { max: 100000 })
    }
  };
}

function resolveRateLimitPrincipal(req) {
  const limiterKey = (req.clientIdentity?.limiterKey || '').trim();
  if (limiterKey) {
    return {
      key: limiterKey,
      principalType: req.clientIdentity?.source === 'oidc' ? 'user' : 'ip'
    };
  }

  if (req.clientIdentity?.source === 'oidc' && req.clientIdentity.value) {
    return {
      key: `user:${req.clientIdentity.value}`,
      principalType: 'user'
    };
  }

  if (req.clientIdentity?.source === 'ip' && req.clientIdentity.value) {
    const normalizedClientIp = normalizeRemoteAddress(req.clientIdentity.value);
    return {
      key: `ip:${normalizedClientIp || 'unknown'}`,
      principalType: 'ip'
    };
  }

  const authEmail = (req.auth?.email || '').trim().toLowerCase();
  if (authEmail) {
    return {
      key: `user:${authEmail}`,
      principalType: 'user'
    };
  }

  const normalizedIp = normalizeRemoteAddress(
    req.ip || req.socket?.remoteAddress || 'unknown'
  );

  return {
    key: `ip:${normalizedIp || 'unknown'}`,
    principalType: 'ip'
  };
}

function writeRateLimitExceeded(res, { retryAfterSec, policyScope, principalType, windowSec, maxRequests }) {
  res.set('Retry-After', String(retryAfterSec));

  return res.status(429).json({
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests, please retry later.',
      reason: 'RATE_LIMIT_EXCEEDED'
    },
    retryAfterSec,
    limit: {
      scope: policyScope,
      principalType,
      windowSec,
      maxRequests
    }
  });
}

function createFixedWindowRateLimiter({ policyScope, getPolicy, resolvePrincipal = resolveRateLimitPrincipal }) {
  const counters = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const principal = resolvePrincipal(req);
    const selectedPolicy = getPolicy(principal, req);
    const windowMs = selectedPolicy.windowSec * 1000;
    const nowMs = Date.now();
    const counterKey = `${policyScope}:${principal.key}`;

    const existing = counters.get(counterKey);
    if (!existing || existing.resetAtMs <= nowMs) {
      counters.set(counterKey, {
        count: 1,
        resetAtMs: nowMs + windowMs
      });
      return next();
    }

    if (existing.count >= selectedPolicy.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
      return writeRateLimitExceeded(res, {
        retryAfterSec,
        policyScope,
        principalType: principal.principalType,
        windowSec: selectedPolicy.windowSec,
        maxRequests: selectedPolicy.maxRequests
      });
    }

    existing.count += 1;
    return next();
  };
}

function createRateLimitMiddlewares(policy = buildRateLimitPolicyFromEnv()) {
  const globalLimiter = createFixedWindowRateLimiter({
    policyScope: 'global',
    getPolicy: () => policy.global
  });

  const rewriteLimiter = createFixedWindowRateLimiter({
    policyScope: 'rewrite',
    getPolicy: (principal) => (principal.principalType === 'user' ? policy.rewrite.auth : policy.rewrite.ip)
  });

  const opsLimiter = createFixedWindowRateLimiter({
    policyScope: 'ops',
    getPolicy: () => policy.ops
  });

  return {
    policy,
    globalLimiter,
    rewriteLimiter,
    opsLimiter
  };
}

module.exports = {
  buildRateLimitPolicyFromEnv,
  createFixedWindowRateLimiter,
  createRateLimitMiddlewares,
  parsePositiveIntegerEnv,
  resolveRateLimitPrincipal,
  writeRateLimitExceeded
};
