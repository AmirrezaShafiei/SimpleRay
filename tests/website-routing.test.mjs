import test from 'node:test';
import assert from 'node:assert/strict';
import {matchWebsiteRule, normalizeWebsiteRule} from '../frontend/routing.js';

test('website input accepts suffixes and extracts hosts from full URLs', () => {
  assert.equal(normalizeWebsiteRule(' .IR. '), '.ir');
  assert.equal(normalizeWebsiteRule('.AC.IR'), '.ac.ir');
  assert.equal(normalizeWebsiteRule('https://Research.IUMS.ac.ir:8443/login?next=%2F'), 'research.iums.ac.ir');
  assert.equal(normalizeWebsiteRule('https://bücher.example/a'), 'xn--bcher-kva.example');
  for (const invalid of ['..ir', '*.ir', 'http://127.0.0.1/path', 'https://[::1]/', 'ftp://example.com', 'https://user@example.com']) {
    assert.throws(() => normalizeWebsiteRule(invalid), invalid);
  }
});

test('route preview honors the most specific rule and DNS label boundaries', () => {
  const suffix = {domain: '.ir', route: 'direct'};
  const exception = {domain: 'research.iums.ac.ir', route: 'proxy'};
  const rules = [suffix, exception];
  assert.equal(matchWebsiteRule('lab.research.iums.ac.ir', rules), exception);
  assert.equal(matchWebsiteRule('sipad.iums.ac.ir', rules), suffix);
  assert.equal(matchWebsiteRule('ir.example.com', rules), undefined);
  assert.equal(matchWebsiteRule('exampleir.com', rules), undefined);
});
