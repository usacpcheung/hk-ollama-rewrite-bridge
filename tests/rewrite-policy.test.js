const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolveRewriteConfig } = require('../configuration/rewrite');
const { createRewriteServiceDefinition } = require('../services/rewrite');
const { resolveRewritePolicy } = require('../services/rewrite-policies');
const baseline = require('../test-support/current-v1-prompt.cjs');
const parse = (raw, fallback) => raw == null ? fallback : Number(raw);
const config = env => resolveRewriteConfig({ env, parseEnvBoundedInteger: parse, parseEnvMilliseconds: parse });

test('policy default and explicit current-v1 preserve the exact accepted main prompt', () => {
  for (const env of [{}, { REWRITE_POLICY: 'current-v1' }]) {
    const service = createRewriteServiceDefinition({ config: config(env) });
    assert.equal(service.policyId, 'current-v1');
    assert.equal(service.instructions, baseline);
    assert.deepEqual(service.buildRequest({ trimmedText: '測試' }), {
      text: '測試', instructions: baseline, outputBudget: 300
    });
  }
});

test('policy selection is provider independent and captured at service construction', () => {
  for (const provider of ['minimax', 'ollama']) {
    const env = { REWRITE_PROVIDER: provider, REWRITE_POLICY: 'hk-school-v1' };
    const resolved = config(env);
    const service = createRewriteServiceDefinition({ config: resolved });
    env.REWRITE_POLICY = resolved.policy = 'current-v1';
    const result = service.validateRequest({ body: {
      text: ' 測試 ', policy: 'current-v1', REWRITE_POLICY: 'current-v1', instructions: 'override'
    } });
    assert.equal(result.ok, true);
    assert.equal(service.provider.selected, provider);
    assert.equal(service.policyId, 'hk-school-v1');
    assert.equal(service.buildRequest(result.value).instructions, resolveRewritePolicy('hk-school-v1').instructions);
    assert.notEqual(service.instructions, baseline);
    const restarted = createRewriteServiceDefinition({ config: config(env) });
    assert.equal(restarted.instructions, baseline);
  }
});

test('invalid policy values fail closed without echoing their contents', () => {
  for (const value of ['', ' ', 'HK-SCHOOL-V1', 'other', '__proto__', 'constructor', null, 1]) {
    assert.throws(() => config({ REWRITE_POLICY: value }), {
      message: 'REWRITE_POLICY must be current-v1, hk-school-v1 or hk-school-v2'
    });
  }
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { PATH: process.env.PATH, REWRITE_POLICY: 'private-invalid-value' },
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REWRITE_POLICY must be/);
  assert.doesNotMatch(result.stderr, /private-invalid-value/);
  assert.doesNotMatch(result.stdout, /listening/);
});


test('school-v2 is exactly the evaluated candidate B and can roll back to current-v1', () => {
  const expectedHash = '51f7fd33ac9c1b719124f524aa63d5a1906c816ec4b671fd7b252527381a260a';
  const service = createRewriteServiceDefinition({ config: config({ REWRITE_PROVIDER: 'minimax', REWRITE_POLICY: 'hk-school-v2' }) });
  assert.equal(require('node:crypto').createHash('sha256').update(service.instructions).digest('hex'), expectedHash);
  assert.equal(service.policyId, 'hk-school-v2');
  assert.equal(service.buildRequest({ trimmedText: '測試' }).instructions, service.instructions);
  assert.equal(createRewriteServiceDefinition({ config: config({ REWRITE_PROVIDER: 'minimax', REWRITE_POLICY: 'current-v1' }) }).instructions, baseline);
});
