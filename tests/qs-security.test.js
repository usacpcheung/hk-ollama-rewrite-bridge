'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const qs = require('qs');

// GHSA-6pq8-jhm2-2vcw: guard the installed transitive dependency.
// The bridge does not currently serialize untrusted data with comma format.
for (const encodeValuesOnly of [false, true]) {
  test(`qs comma serialization handles hostile objects (encodeValuesOnly=${encodeValuesOnly})`, () => {
    const inputs = [
      JSON.parse('{"a":[{"toString":"x"}]}'),
      qs.parse('a[0][toString]=x', { allowPrototypes: true }),
      { a: [Object.assign(Object.create(null), { b: 'c' })] },
      { a: [[{ toString: 'x' }]] },
    ];
    for (const input of inputs) {
      assert.equal(qs.stringify(input, { arrayFormat: 'comma', encodeValuesOnly }),
        'a=%5Bobject%20Object%5D');
    }
  });
}
test('qs preserves ordinary query parsing and serialization', () => {
  assert.deepEqual(qs.parse('a[b]=c&list[0]=one&list[1]=two', { allowPrototypes: true }),
    { a: { b: 'c' }, list: ['one', 'two'] });
  assert.equal(qs.stringify({ a: ['one', 'two'] }, { arrayFormat: 'comma' }), 'a=one%2Ctwo');
  assert.equal(qs.stringify({ a: ['one', 'two'] }), 'a%5B0%5D=one&a%5B1%5D=two');
});
