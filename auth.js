function normalizeDomains(rawDomains) {
  if (!rawDomains || typeof rawDomains !== 'string') {
    return [];
  }

  return rawDomains
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function parseBearerToken(authHeader) {
  if (typeof authHeader !== 'string') {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    return null;
  }

  return match[1];
}

function isEmailDomainAuthorized(email, allowedDomains) {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return true;
  }

  if (typeof email !== 'string' || email.trim() === '') {
    return false;
  }

  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return false;
  }

  const domain = email.slice(atIndex + 1).toLowerCase();
  return allowedDomains.includes(domain);
}

function buildTokeninfoRequestUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  if (!url.searchParams.has('access_token')) {
    url.searchParams.set('access_token', token);
  }
  return url;
}

async function validateBearerToken({ token, tokeninfoUrl, timeoutMs = 5000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestUrl = buildTokeninfoRequestUrl(tokeninfoUrl, token);
    const response = await fetchImpl(requestUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    if (response.status === 400 || response.status === 401) {
      return { status: 'invalid' };
    }

    if (!response.ok) {
      return { status: 'upstream_error', detail: `tokeninfo_http_${response.status}` };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (_err) {
      return { status: 'upstream_error', detail: 'tokeninfo_invalid_json' };
    }

    return {
      status: 'valid',
      email: typeof payload.email === 'string' ? payload.email : null
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 'upstream_timeout', detail: 'tokeninfo_timeout' };
    }

    return { status: 'upstream_error', detail: err?.name || 'tokeninfo_network_error' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function authenticateRequest({ req, tokeninfoUrl, allowedEmailDomains, logger, fetchImpl }) {
  const token = parseBearerToken(req.get('Authorization'));
  if (!token) {
    logger?.('missing_or_malformed_token');
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }

  const validation = await validateBearerToken({
    token,
    tokeninfoUrl,
    timeoutMs: 5000,
    fetchImpl
  });

  if (validation.status === 'upstream_timeout' || validation.status === 'upstream_error') {
    logger?.(validation.status, validation.detail);
    return { ok: false, status: 503, body: { error: 'Auth service unavailable' } };
  }

  if (validation.status !== 'valid') {
    logger?.('invalid_token');
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }

  if (!isEmailDomainAuthorized(validation.email, allowedEmailDomains)) {
    logger?.('unauthorized_domain');
    return { ok: false, status: 403, body: { error: 'Forbidden' } };
  }

  return { ok: true, email: validation.email };
}

module.exports = {
  authenticateRequest,
  buildTokeninfoRequestUrl,
  isEmailDomainAuthorized,
  normalizeDomains,
  parseBearerToken,
  validateBearerToken
};
