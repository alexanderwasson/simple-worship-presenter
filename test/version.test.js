'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compareVersions, pickVersion } = require('../src/version');

test('version comparison', async t => {
  await t.test('orders ordinary versions', () => {
    assert.equal(compareVersions('0.3.1', '0.3.2'), -1);
    assert.equal(compareVersions('0.3.2', '0.3.1'), 1);
    assert.equal(compareVersions('0.3.2', '0.3.2'), 0);
    assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
    assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  });

  await t.test('accepts a v prefix and surrounding whitespace', () => {
    assert.equal(compareVersions('v0.3.1', '0.3.2'), -1);
    assert.equal(compareVersions(' 0.3.2 ', 'v0.3.2'), 0);
  });

  await t.test('handles differing segment counts', () => {
    assert.equal(compareVersions('0.3', '0.3.1'), -1);
    assert.equal(compareVersions('0.3.1', '0.3'), 1);
    assert.equal(compareVersions('0.3.0', '0.3'), 0);
  });

  await t.test('does not throw on non-numeric tags', () => {
    assert.doesNotThrow(() => compareVersions('a', '0.3.2'));
    assert.doesNotThrow(() => compareVersions('', '0.3.2'));
    assert.doesNotThrow(() => compareVersions('main', 'latest'));
  });

  await t.test('sorts release qualifiers after the base version', () => {
    assert.equal(compareVersions('0.3.2-rc1', '0.3.2'), -1);
    assert.equal(compareVersions('0.3.2', '0.3.2-rc1'), 1);
  });
});

test('picking a version from a release payload', async t => {
  await t.test('prefers an explicit version field', () => {
    assert.equal(pickVersion({ version: '1.2.3', tag_name: 'zzz', name: 'Anything' }), '1.2.3');
  });

  await t.test('falls back to the tag when it looks like a version', () => {
    assert.equal(pickVersion({ tag_name: 'v2.0.0', name: 'A release' }), '2.0.0');
  });

  await t.test('uses the name when the tag is not a version', () => {
    // This is the real shape that broke: the tag was "a", the name held the version.
    assert.equal(pickVersion({ tag_name: 'a', name: 'v 0.3.1' }), '0.3.1');
  });

  await t.test('handles a v prefix with a space', () => {
    assert.equal(pickVersion({ name: 'v 0.3.2' }), '0.3.2');
    assert.equal(pickVersion({ tag_name: 'v 1.0.0' }), '1.0.0');
  });

  await t.test('returns whatever it can when nothing is a version', () => {
    assert.equal(pickVersion({ tag_name: 'nightly' }), 'nightly');
    assert.equal(pickVersion({}), '');
    assert.equal(pickVersion(null), '');
  });
});
