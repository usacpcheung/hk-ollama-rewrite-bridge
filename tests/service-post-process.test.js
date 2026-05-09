const test = require('node:test');
const assert = require('node:assert/strict');

const { createRewriteServiceDefinition } = require('../services/rewrite');
const { createServiceRegistry } = require('../services');

function parseBounded(rawValue, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

test('rewrite service postProcessOutput converts only rewrite text fields', () => {
  const rewriteService = createRewriteServiceDefinition({
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {}
  });

  const processed = rewriteService.postProcessOutput({
    payload: {
      response: '面条和电脑',
      result: '面条和电脑',
      untouched: '面条和电脑',
      nested: { response: '面条和电脑' }
    }
  });

  assert.equal(processed.response, '麪條和電腦');
  assert.equal(processed.result, '麪條和電腦');
  assert.equal(processed.untouched, '面条和电脑');
  assert.deepEqual(processed.nested, { response: '面条和电脑' });
});

test('service registry injects identity postProcessOutput for services without a hook', () => {
  const registry = createServiceRegistry({
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {}
  });

  const service = registry.get('rewrite');
  const payload = { result: '面条和电脑', usage: { total_tokens: 10 } };
  const processed = service.postProcessOutput({ payload });

  assert.notEqual(processed, null);
  assert.equal(typeof service.postProcessOutput, 'function');
  assert.equal(processed.usage.total_tokens, 10);
});

test('service registry list includes both rewrite and t2a services', () => {
  const registry = createServiceRegistry({
    parseEnvBoundedInteger: parseBounded,
    parseEnvMilliseconds: parseBounded,
    providerCapabilities: {}
  });

  const serviceIds = registry.list().map((service) => service.id);

  assert.deepEqual(serviceIds, ['rewrite', 't2a']);
});
