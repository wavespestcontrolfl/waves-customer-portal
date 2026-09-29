/**
 * Every name server code reads from annual-prepay-renewals' module ROOT must
 * be a real root export. Twice a caller destructured a helper that lived only
 * under _private and got undefined:
 *   - serviceMatchesCoverage: the one-step-prepay booking preflight 500'd;
 *   - coverageRowsForTerm: admin-cancellation.js's three reads threw and
 *     failed closed, so "End of paid coverage" always refused, every prepay
 *     refund went to manual calculation and a scoped cancel on a prepay
 *     account refused (2026-09-01 to 2026-09-29).
 * The callers' own unit tests mock this module with the name at the root, so
 * only a check against the REAL export shape catches it. Reads through
 * `._private` are deliberate and not checked here.
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const MODULE_PATH = String.raw`[^'"]*annual-prepay-renewals(?:\.js)?`;
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'dist']);

function serverSources(dir = SERVER, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverSources(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

// Comments out, so a path or name mentioned in one never reads as code.
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// The root names a destructuring pattern reads: defaults stripped, and a
// nested pattern (`_private: { a }`) reads only its own key.
function destructuredNames(pattern) {
  return pattern.replace(/(\w+)\s*:\s*\{[^{}]*\}/g, '$1')
    .split(',')
    .map((part) => part.split(/[:=]/)[0].trim())
    .filter((name) => name && !name.startsWith('...'));
}

// Every root read in one file: `const { a } = require(...)`,
// `require(...).a`, and through an alias `const R = require(...)`: `R.a` and
// `const { a } = R`.
function rootReads(source) {
  const src = withoutComments(source);
  const reads = [];
  for (const m of src.matchAll(new RegExp(String.raw`const\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*=\s*require\((['"])${MODULE_PATH}\2\)(\s*\._private)?`, 'g'))) {
    if (!m[3]) reads.push(...destructuredNames(m[1]));
  }
  for (const m of src.matchAll(new RegExp(String.raw`require\((['"])${MODULE_PATH}\1\)\.(\w+)`, 'g'))) reads.push(m[2]);
  for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\((['"])${MODULE_PATH}\2\)\s*;`, 'g'))) {
    // A standalone name only: `annual-prepay-renewals.js` or `x.renewals.y` is not the alias.
    for (const use of src.matchAll(new RegExp(String.raw`(?<![\w$.-])${m[1]}\.(\w+)`, 'g'))) reads.push(use[1]);
    for (const use of src.matchAll(new RegExp(String.raw`const\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*=\s*${m[1]}\s*;`, 'g'))) {
      reads.push(...destructuredNames(use[1]));
    }
  }
  return reads.filter((name) => name !== '_private');
}

describe('annual-prepay-renewals root exports', () => {
  const renewals = jest.requireActual('../services/annual-prepay-renewals');

  test('every root read of the module in server code names a real root export', () => {
    const missing = [];
    for (const file of serverSources()) {
      for (const name of new Set(rootReads(fs.readFileSync(file, 'utf8')))) {
        if (!(name in renewals)) missing.push(`${path.relative(SERVER, file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the scan sees the reads it guards: admin-cancellation.js reads coverageRowsForTerm from the root, and it is a function', () => {
    const src = fs.readFileSync(path.join(SERVER, 'services/admin-cancellation.js'), 'utf8');
    expect(rootReads(src)).toContain('coverageRowsForTerm');
    // Nested destructuring reads its key; a commented mention or a hyphenated path is not a read.
    const sample = [
      "const { a, _private: { b } } = require('./annual-prepay-renewals');",
      "const R = require('./annual-prepay-renewals');",
      '// R.fromAComment, and annual-prepay-renewals.js in prose',
      'R.c();',
      'const { d } = R;',
      'const { e } = R._private;',
    ].join('\n');
    expect(rootReads(sample).sort()).toEqual(['a', 'c', 'd']);
    expect(typeof renewals.coverageRowsForTerm).toBe('function');
    expect(renewals.coverageRowsForTerm).toBe(renewals._private.coverageRowsForTerm);
  });
});
