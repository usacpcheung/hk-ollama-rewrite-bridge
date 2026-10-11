const { readEnvWithDeprecatedAliases } = require('../lib/env-config');
function createLifecycleReaders(env) {
  function parseBoundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      return null;
    }
    return parsed;
  }


  function parseDeprecatedEnvBoundedInteger(name, deprecatedNames, fallback, bounds = {}) {
    return readEnvWithDeprecatedAliases({ env,
      name,
      deprecatedNames,
      defaultValue: fallback,
      parse: (rawValue, sourceName) => {
        const parsed = parseBoundedInteger(rawValue, bounds);
        if (parsed == null) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: `Invalid ${sourceName}; using default`,
              provided: rawValue,
              fallback
            })
          );
          return fallback;
        }

        return parsed;
      }
    }).value;
  }

  function parseEnvMilliseconds(name, fallback, bounds = {}) {
    const rawValue = env[name];
    if (rawValue == null || rawValue.trim() === '') {
      return fallback;
    }

    const parsed = parseBoundedInteger(rawValue, { min: 0, ...bounds });
    if (parsed == null) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: `Invalid ${name}; using default`,
          provided: rawValue,
          fallback
        })
      );
      return fallback;
    }

    return parsed;
  }

  function parseDeprecatedEnvMilliseconds(name, deprecatedNames, fallback, bounds = {}) {
    return parseDeprecatedEnvBoundedInteger(name, deprecatedNames, fallback, { min: 0, ...bounds });
  }

  function parseDeprecatedEnvBoolean(name, deprecatedNames, fallback = false) {
    return readEnvWithDeprecatedAliases({ env,
      name,
      deprecatedNames,
      defaultValue: fallback,
      parse: (rawValue, sourceName) => {
        const normalized = String(rawValue).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) {
          return true;
        }

        if (['0', 'false', 'no', 'off'].includes(normalized)) {
          return false;
        }

        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: `Invalid ${sourceName}; using default`,
            provided: rawValue,
            fallback
          })
        );
        return fallback;
      }
    }).value;
  }

  return { parseEnvMilliseconds, parseDeprecatedEnvMilliseconds, parseDeprecatedEnvBoolean, parseDeprecatedEnvBoundedInteger };
}
module.exports = { createLifecycleReaders };
