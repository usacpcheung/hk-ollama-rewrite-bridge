const test = require('node:test');
const assert = require('node:assert/strict');

const { readEnvWithDeprecatedAliases } = require('../lib/env-config');

test('readEnvWithDeprecatedAliases prefers canonical env over deprecated alias', () => {
  const warnings = [];
  const result = readEnvWithDeprecatedAliases({
    env: {
      BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT: 'true',
      REWRITE_DEBUG_RAW_OUTPUT: 'false'
    },
    name: 'BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT',
    deprecatedNames: ['REWRITE_DEBUG_RAW_OUTPUT'],
    defaultValue: 'default',
    warn: (line) => warnings.push(line)
  });

  assert.equal(result.value, 'true');
  assert.deepEqual(result.source, { type: 'canonical', key: 'BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT' });
  assert.deepEqual(warnings, []);
});

test('readEnvWithDeprecatedAliases reads deprecated alias and emits warning', () => {
  const warnings = [];
  const result = readEnvWithDeprecatedAliases({
    env: {
      REWRITE_DEBUG_RAW_OUTPUT: 'true'
    },
    name: 'BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT',
    deprecatedNames: ['REWRITE_DEBUG_RAW_OUTPUT'],
    defaultValue: 'default',
    warn: (line) => warnings.push(JSON.parse(line))
  });

  assert.equal(result.value, 'true');
  assert.deepEqual(result.source, { type: 'deprecated', key: 'REWRITE_DEBUG_RAW_OUTPUT' });
  assert.deepEqual(warnings, [
    {
      level: 'warn',
      msg: 'Deprecated env alias used',
      deprecatedKey: 'REWRITE_DEBUG_RAW_OUTPUT',
      canonicalKey: 'BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT'
    }
  ]);
});

test('readEnvWithDeprecatedAliases returns default when no env is set', () => {
  const result = readEnvWithDeprecatedAliases({
    env: {},
    name: 'BRIDGE_PROVIDER_DEBUG_RAW_OUTPUT',
    deprecatedNames: ['REWRITE_DEBUG_RAW_OUTPUT'],
    defaultValue: false
  });

  assert.equal(result.value, false);
  assert.deepEqual(result.source, { type: 'default', key: null });
});
