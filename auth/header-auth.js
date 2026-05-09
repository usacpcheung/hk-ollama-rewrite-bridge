function createRewriteHeaderAuth({
  bridgeInternalAuthSecret,
  errorResponse,
  onAuthFailure,
  allowedEmailDomain = '@hs.edu.hk'
}) {
  const rawAllowedEmailDomain = String(allowedEmailDomain || '@hs.edu.hk').trim().toLowerCase();
  const normalizedAllowedEmailDomain = rawAllowedEmailDomain.startsWith('@')
    ? rawAllowedEmailDomain
    : `@${rawAllowedEmailDomain}`;
  const forbiddenDomainMessage = normalizedAllowedEmailDomain === '@hs.edu.hk'
    ? 'Only hs.edu.hk accounts are allowed'
    : `Only ${normalizedAllowedEmailDomain.replace(/^@/, '')} accounts are allowed`;

  return function rewriteHeaderAuth(req, res, next) {
    const reject = (status, code, message) => {
      if (typeof onAuthFailure === 'function') {
        try {
          onAuthFailure(req, { status, code, message });
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'rewrite auth failure logging callback failed',
              code,
              error: error && error.message ? error.message : 'unknown'
            })
          );
        }
      }

      errorResponse(res, status, code, message);
    };

    const trustHeader = (req.get('X-Bridge-Auth') || '').trim();

    if (!bridgeInternalAuthSecret || trustHeader !== bridgeInternalAuthSecret) {
      reject(401, 'AUTH_REQUIRED', 'Login required');
      return;
    }

    const rawHeader = req.get('X-Authenticated-Email');
    const email = (rawHeader || '').trim().toLowerCase();

    if (!email) {
      reject(401, 'AUTH_REQUIRED', 'Login required');
      return;
    }

    if (email.includes(',')) {
      reject(401, 'AUTH_HEADER_INVALID', 'Invalid authentication header');
      return;
    }

    if (!email.endsWith(normalizedAllowedEmailDomain)) {
      reject(403, 'FORBIDDEN_DOMAIN', forbiddenDomainMessage);
      return;
    }

    req.auth = {
      ...(req.auth || {}),
      email
    };

    next();
  };
}

module.exports = {
  createRewriteHeaderAuth
};
