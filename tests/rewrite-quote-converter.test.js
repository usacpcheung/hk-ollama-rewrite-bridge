const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuotePreservingConverter } = require('../lib/rewrite-quote-converter');
const { createRewriteServiceDefinition } = require('../services/rewrite');
const { resolveRewriteConfig } = require('../configuration/rewrite');
const OpenCC = require('opencc-js');
const toHK = OpenCC.Converter({ from: 'cn', to: 'hk' });
const make = policy => createRewriteServiceDefinition({ config: resolveRewriteConfig({
  env: { REWRITE_POLICY: policy }, parseEnvBoundedInteger: (v,d) => v == null ? d : Number(v),
  parseEnvMilliseconds: (v,d) => v == null ? d : Number(v)
}) });
const scenarios = [
  ['老師寫「唔該晒」', '老师写「唔該晒」，头发。', '老師寫「唔該晒」，頭髮。'],
  ['「係」「唔係」', '「是」或「不是」', '「是」或「不是」'],
  ['「他说『唔該晒』」', '「他说『唔該晒』」头发', '「他说『唔該晒』」頭髮'],
  ['『唔該晒』', '「他说了好多好多话：『唔該晒』」', '「他説了好多好多話：『唔該晒』」'],
  ['「唔該晒」', '「唔該晒」「唔該晒」', '「唔該晒」「唔該晒」'],
  ['“唔該晒” and "唔該晒" and ‘唔該晒’', '“唔該晒” "唔該晒" ‘唔該晒’', '“唔該晒” "唔該晒" ‘唔該晒’'],
  ['「唔該晒」', '「唔該晒', '「唔該曬'],
  ['「唔該晒', '「唔該晒」', '「唔該曬」'],
  ['「唔該晒」', '头发😀「唔該晒」头发', '頭髮😀「唔該晒」頭髮'],
  ['「唔該晒」', '「唔該曬」', '「唔該曬」'],
  ['「唔該晒」', '唔該晒', '唔該曬'],
  ['"唔該晒"', '\\"唔該晒\\"', '\\"唔該曬\\"'],
  ['no quotations', "don't change 头发", "don't change 頭髮"],
  ['「唔該晒」', '「' + '发'.repeat(100) + '『尾巴』', '「' + '發'.repeat(100) + '『尾巴』']
];
for (const [index, [input, raw, expected]] of scenarios.entries()) {
  test(`quotation conversion ${index}: sync and every streaming split agree`, () => {
    const school = make('hk-school-v1');
    assert.equal(school.postProcessOutput({ inputText: input, payload: { result: raw } }).result, expected);
    for (let split = 0; split <= raw.length; split++) {
      const c = school.createStreamConverter({ inputText: input });
      assert.equal(c.write(raw.slice(0,split)) + c.write(raw.slice(split)) + c.write('',true), expected);
    }
    const c = createQuotePreservingConverter(input);
    assert.equal(raw.split('').map(char => c.write(char)).join('') + c.write('',true), expected);
    const legacy = make('current-v1');
    assert.equal(legacy.postProcessOutput({ inputText: input, payload: { result: raw } }).result, toHK(raw));
  });
}
test('abandoned converter cannot leak partial quotations into another request', () => {
  const first = createQuotePreservingConverter('「唔該晒」');
  first.write('「唔該');
  assert.equal(createQuotePreservingConverter('').write('「唔該晒」',true), '「唔該曬」');
  assert.equal(first.write('晒」',true),'「唔該晒」');
});
test('unterminated streaming quotations emit bounded progress before finalization', () => {
  const converter = createQuotePreservingConverter('「唔該晒」');
  const output = converter.write('「' + '头发'.repeat(10000));
  assert.ok(output.length > 19000, 'cannot buffer the complete response until done');
  assert.equal(output + converter.write('',true), toHK('「' + '头发'.repeat(10000)));
});
