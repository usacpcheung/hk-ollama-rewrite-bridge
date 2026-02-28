function normalizeCorsAllowlist(rawAllowlist) {
  if (typeof rawAllowlist !== 'string') {
    return [];
  }

  return rawAllowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getEffectivePort(url) {
  if (url.port) {
    return url.port;
  }

  if (url.protocol === 'https:') {
    return '443';
  }

  if (url.protocol === 'http:') {
    return '80';
  }

  return '';
}

function parseCorsAllowlist(rawAllowlist) {
  const normalizedEntries = normalizeCorsAllowlist(rawAllowlist);

  return normalizedEntries
    .map((entry) => {
      if (entry === '*') {
        return null;
      }

      let parsed;
      try {
        parsed = new URL(entry);
      } catch {
        return null;
      }

      if (!parsed.hostname) {
        return null;
      }

      const hasWildcardHost = parsed.hostname.startsWith('*.');
      if (hasWildcardHost) {
        const suffix = parsed.hostname.slice(2);
        if (!suffix) {
          return null;
        }

        return {
          type: 'wildcard-subdomain',
          protocol: parsed.protocol,
          suffix,
          hasExplicitPort: Boolean(parsed.port),
          port: getEffectivePort(parsed)
        };
      }

      return {
        type: 'exact',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        hasExplicitPort: Boolean(parsed.port),
        port: getEffectivePort(parsed)
      };
    })
    .filter(Boolean);
}

function isOriginAllowed(origin, rules) {
  if (typeof origin !== 'string' || !origin) {
    return false;
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  const originPort = getEffectivePort(parsedOrigin);

  return rules.some((rule) => {
    if (parsedOrigin.protocol !== rule.protocol) {
      return false;
    }

    if (rule.hasExplicitPort) {
      if (originPort !== rule.port) {
        return false;
      }
    } else {
      const defaultPort = rule.protocol === 'https:' ? '443' : rule.protocol === 'http:' ? '80' : '';
      if (originPort !== defaultPort) {
        return false;
      }
    }

    if (rule.type === 'exact') {
      return parsedOrigin.hostname === rule.hostname;
    }

    if (rule.type === 'wildcard-subdomain') {
      if (parsedOrigin.hostname === rule.suffix) {
        return false;
      }

      return parsedOrigin.hostname.endsWith(`.${rule.suffix}`);
    }

    return false;
  });
}

function createCorsMiddleware(rawAllowlist) {
  const rules = parseCorsAllowlist(rawAllowlist);

  return (req, res, next) => {
    const requestOrigin = req.headers.origin;

    if (isOriginAllowed(requestOrigin, rules)) {
      res.set('Access-Control-Allow-Origin', requestOrigin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  };
}

module.exports = {
  createCorsMiddleware,
  getEffectivePort,
  isOriginAllowed,
  normalizeCorsAllowlist,
  parseCorsAllowlist
};
