function createRewriteHeaderAuth({ bridgeInternalAuthSecret, errorResponse }) {
  return function rewriteHeaderAuth(req, res, next) {
    const trustHeader = (req.get('X-Bridge-Auth') || '').trim();

    if (!bridgeInternalAuthSecret || trustHeader !== bridgeInternalAuthSecret) {
      errorResponse(res, 401, 'AUTH_REQUIRED', 'Login required');
      return;
    }

    const rawHeader = req.get('X-Authenticated-Email');
    const email = (rawHeader || '').trim().toLowerCase();

    if (!email) {
      errorResponse(res, 401, 'AUTH_REQUIRED', 'Login required');
      return;
    }

    if (email.includes(',')) {
      errorResponse(res, 401, 'AUTH_HEADER_INVALID', 'Invalid authentication header');
      return;
    }

    if (!email.endsWith('@hs.edu.hk')) {
      errorResponse(res, 403, 'FORBIDDEN_DOMAIN', 'Only hs.edu.hk accounts are allowed');
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
