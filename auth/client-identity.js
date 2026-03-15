const DEFAULT_TRUSTED_PROXY_ADDRESSES = new Set(['127.0.0.1', '::1']);
const OIDC_LIMITER_HEADERS = ['X-Authenticated-Email', 'X-Authenticated-User', 'X-Authenticated-Subject'];

function normalizeRemoteAddress(value) {
  if (!value) {
    return '';
  }

  const trimmed = String(value).trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }

  return trimmed;
}

function parseTrustedProxyAddresses(rawValue) {
  if (!rawValue) {
    return new Set(DEFAULT_TRUSTED_PROXY_ADDRESSES);
  }

  return new Set(
    String(rawValue)
      .split(',')
      .map((item) => normalizeRemoteAddress(item))
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function extractTrustedOidcIdentity(req) {
  for (const headerName of OIDC_LIMITER_HEADERS) {
    const rawValue = req.get(headerName);
    const normalizedValue = (rawValue || '').trim().toLowerCase();
    if (!normalizedValue || normalizedValue.includes(',')) {
      continue;
    }

    return {
      headerName,
      value: normalizedValue
    };
  }

  return null;
}

function createClientIdentityResolver({ bridgeInternalAuthSecret, trustedProxyAddresses } = {}) {
  const trustedProxyAddressSet =
    trustedProxyAddresses instanceof Set
      ? trustedProxyAddresses
      : parseTrustedProxyAddresses(trustedProxyAddresses || process.env.TRUSTED_PROXY_ADDRESSES);

  return function resolveClientIdentity(req, _res, next) {
    const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress || req.ip || 'unknown');
    const trustHeader = (req.get('X-Bridge-Auth') || '').trim();
    const hasSharedSecret = Boolean(bridgeInternalAuthSecret);
    const fromTrustedProxy = trustedProxyAddressSet.has(remoteAddress);
    const hasValidProxyAuth = hasSharedSecret && trustHeader === bridgeInternalAuthSecret;

    const trustedOidcIdentity =
      fromTrustedProxy && hasValidProxyAuth ? extractTrustedOidcIdentity(req) : null;

    if (trustedOidcIdentity) {
      req.clientIdentity = {
        limiterKey: `oidc:${trustedOidcIdentity.value}`,
        source: 'oidc',
        headerName: trustedOidcIdentity.headerName,
        value: trustedOidcIdentity.value,
        remoteAddress
      };
      return next();
    }

    req.clientIdentity = {
      limiterKey: `ip:${remoteAddress || 'unknown'}`,
      source: 'ip',
      headerName: null,
      value: remoteAddress || 'unknown',
      remoteAddress: remoteAddress || 'unknown'
    };

    next();
  };
}

module.exports = {
  OIDC_LIMITER_HEADERS,
  createClientIdentityResolver,
  normalizeRemoteAddress,
  parseTrustedProxyAddresses
};
