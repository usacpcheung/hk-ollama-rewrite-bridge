function createRewriteHeaderAuth({ bridgeInternalAuthSecret, errorResponse, onAuthFailure }) {
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

    if (!email.endsWith('@hs.edu.hk')) {
      reject(403, 'FORBIDDEN_DOMAIN', 'Only hs.edu.hk accounts are allowed');
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
