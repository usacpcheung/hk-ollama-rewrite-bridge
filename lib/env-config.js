function isEnvValueSet(value) {
  return value != null && String(value).trim() !== '';
}

function warnDeprecatedEnvAlias({ deprecatedKey, canonicalKey, warn = console.warn }) {
  warn(
    JSON.stringify({
      level: 'warn',
      msg: 'Deprecated env alias used',
      deprecatedKey,
      canonicalKey
    })
  );
}

function readEnvWithDeprecatedAliases({
  env = process.env,
  name,
  deprecatedNames = [],
  defaultValue,
  parse = (value) => value,
  warn = console.warn
}) {
  const canonicalRaw = env[name];
  if (isEnvValueSet(canonicalRaw)) {
    return {
      value: parse(canonicalRaw, name),
      source: { type: 'canonical', key: name }
    };
  }

  for (const deprecatedName of deprecatedNames) {
    const deprecatedRaw = env[deprecatedName];
    if (isEnvValueSet(deprecatedRaw)) {
      warnDeprecatedEnvAlias({ deprecatedKey: deprecatedName, canonicalKey: name, warn });
      return {
        value: parse(deprecatedRaw, deprecatedName),
        source: { type: 'deprecated', key: deprecatedName }
      };
    }
  }

  return {
    value: defaultValue,
    source: { type: 'default', key: null }
  };
}

module.exports = {
  readEnvWithDeprecatedAliases,
  warnDeprecatedEnvAlias
};
