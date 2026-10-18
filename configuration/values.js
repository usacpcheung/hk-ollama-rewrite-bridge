function readPreferredEnv(env, keys = []) {
  for (const key of keys) {
    const raw = env[key];
    if (raw != null && raw.trim() !== '') {
      return { key, value: raw };
    }
  }
  return null;
}

function parseBooleanFlag(raw, fallback) {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return fallback;
}

function parseEnumValue(raw, fallback, supportedValues) {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  return supportedValues.has(normalized) ? normalized : fallback;
}

function readWithLegacyFallback({
  env,
  preferredKeys,
  legacyKeys,
  parse,
  defaultValue,
  warnLegacyUsage,
  warningLabel
}) {
  const parseWithValidity = (raw) => {
    const invalidMarker = Symbol('invalid-env-value');
    const parsed = parse(raw, invalidMarker);

    return {
      isValid: parsed !== invalidMarker,
      value: parsed
    };
  };

  const preferred = readPreferredEnv(env, preferredKeys);
  if (preferred) {
    const preferredParsed = parseWithValidity(preferred.value);
    if (preferredParsed.isValid) {
      return {
        value: preferredParsed.value,
        source: { type: 'preferred', key: preferred.key }
      };
    }
  }

  const legacy = readPreferredEnv(env, legacyKeys);
  if (legacy) {
    const legacyParsed = parseWithValidity(legacy.value);
    if (legacyParsed.isValid) {
      warnLegacyUsage({
        legacyKey: legacy.key,
        preferredKeys,
        warningLabel
      });
      return {
        value: legacyParsed.value,
        source: { type: 'legacy', key: legacy.key }
      };
    }
  }

  return {
    value: defaultValue,
    source: { type: 'default', key: null }
  };
}

function parseFiniteNumber(raw, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}


module.exports = { readWithLegacyFallback, parseBooleanFlag, parseEnumValue, parseFiniteNumber };
