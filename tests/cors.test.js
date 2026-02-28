const test = require('node:test');
const assert = require('node:assert/strict');

const { isOriginAllowed, normalizeCorsAllowlist, parseCorsAllowlist } = require('../cors');

test('normalizeCorsAllowlist trims whitespace and removes empty entries', () => {
  const normalized = normalizeCorsAllowlist('  https://*.example.com , , https://foo.example.com  ,   ');

  assert.deepEqual(normalized, ['https://*.example.com', 'https://foo.example.com']);
});

test('wildcard subdomain rule matches nested subdomains but not apex domain', () => {
  const rules = parseCorsAllowlist('https://*.example.com');

  assert.equal(isOriginAllowed('https://a.example.com', rules), true);
  assert.equal(isOriginAllowed('https://b.c.example.com', rules), true);
  assert.equal(isOriginAllowed('https://example.com', rules), false);
});

test('wildcard subdomain rule does not match different schemes', () => {
  const rules = parseCorsAllowlist('https://*.example.com');

  assert.equal(isOriginAllowed('http://a.example.com', rules), false);
});

test('entry without explicit port only matches default scheme port', () => {
  const rules = parseCorsAllowlist('https://*.example.com');

  assert.equal(isOriginAllowed('https://a.example.com:8443', rules), false);
});

test('entry with explicit port only matches the same port', () => {
  const rules = parseCorsAllowlist('https://*.example.com:8443');

  assert.equal(isOriginAllowed('https://a.example.com:8443', rules), true);
  assert.equal(isOriginAllowed('https://a.example.com', rules), false);
  assert.equal(isOriginAllowed('https://a.example.com:9443', rules), false);
});

test('standalone wildcard entry is invalid and ignored', () => {
  const rules = parseCorsAllowlist('*, https://allowed.example.com');

  assert.equal(isOriginAllowed('https://foo.example.com', rules), false);
  assert.equal(isOriginAllowed('https://allowed.example.com', rules), true);
});
