'use strict';
/*
 * Version handling for update checks.
 *
 * Release feeds are inconsistent about where they put a version: some use a
 * `version` field, some use `tag_name`, and some only have a human-readable
 * name that happens to contain one.
 */

// Split "v 0.3.2-rc1" into a numeric core and a pre-release label. Anything
// that does not look like a version is treated as a label so comparisons never
// throw on tags such as "main" or "nightly".
function splitVersion(value) {
  const cleaned = String(value == null ? '' : value).replace(/^[v=]\s*/i, '').trim();
  const match = cleaned.match(/^(\d+(?:\.\d+)*)(?:[-+._]?(.*))?$/);
  if (!match) return { core: [], pre: cleaned };
  return { core: match[1].split('.').map(Number), pre: (match[2] || '').trim() };
}

function compareVersions(a, b) {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i++) {
    const x = va.core[i] || 0;
    const y = vb.core[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  // Same release number: a pre-release sorts before the final release.
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  return va.pre.localeCompare(vb.pre);
}

function pickVersion(info) {
  const candidates = [info && info.version, info && info.tag_name, info && info.name]
    .filter(Boolean)
    .map(v => String(v).replace(/^[v=]\s*/i, '').trim());
  return candidates.find(v => /^\d+(\.\d+){0,3}/.test(v)) || candidates[0] || '';
}

module.exports = { compareVersions, pickVersion };
