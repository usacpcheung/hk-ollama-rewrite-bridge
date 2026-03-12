function isSensitiveKey(key) {
  return /^(authorization|proxy-authorization|api[-_]?key|x-bridge-auth|bridge_internal_auth_secret|access_token|refresh_token|id_token|token|secret|cookie|set-cookie|passwd|password)$/i.test(String(key));
}

function redactSensitiveValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        if (isSensitiveKey(key)) {
          return [key, '[REDACTED]'];
        }

        return [key, redactSensitiveValue(entryValue)];
      })
    );
  }

  return value;
}

function sanitizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.keys(headers).map((key) => [key, isSensitiveKey(key) ? '[REDACTED]' : headers[key]])
  );
}

function createDebugLogger({ enabled, defaultProvider } = {}) {
  return function debugLog({ requestId, provider, stream, eventType, payload = {} }) {
    if (!enabled) {
      return;
    }

    const safePayload = redactSensitiveValue(payload);

    console.log(
      JSON.stringify({
        level: 'debug',
        requestId: requestId || null,
        provider: provider || defaultProvider || null,
        stream: Boolean(stream),
        eventType,
        ...safePayload
      })
    );
  };
}

module.exports = {
  createDebugLogger,
  redactSensitiveValue,
  sanitizeHeaders
};
