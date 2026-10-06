/**
 * Source guard (address-match PR 7): every production call of
 * performPropertyLookup in server/ passes through lookupOptionsFor(), so the
 * commercial-suite scope decision (opt-in or not) is declared ONCE, in
 * lookup-callers.js, and a new caller cannot slip in with an undeclared
 * decision. Direct callers of lookupPropertyFromAITrio are held to the same
 * registry (TRIO_CALLERS). Filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');
const { CALLERS, TRIO_CALLERS, lookupOptionsFor } = require('../services/property-lookup/lookup-callers');

const SERVER_ROOT = path.join(__dirname, '..');
// The whole production tree under server/ (not an allow-list of folders): a
// caller added under middleware/, utils/, models/ or anywhere else is held
// to the registry too.
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist', 'fixtures']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out); continue; }
    if (entry.name.endsWith('.js')) out.push(path.join(dir, entry.name));
  }
  return out;
}
const files = walk(SERVER_ROOT);
const rel = (f) => path.relative(SERVER_ROOT, f).split(path.sep).join('/');

// Lines that CALL the lookup (not the definition, not a comment, not a jest mock).
function callLines(src, name) {
  const re = new RegExp('(?<![\\w.])' + name + '\\(');
  const def = new RegExp('function\\s+' + name + '\\(');
  const mock = new RegExp(name + ':\\s*jest');
  return src.split('\n').map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => re.test(line) && !/^\s*(\/\/|\*)/.test(line) && !def.test(line) && !mock.test(line));
}

describe('property-lookup callers declare their scope decision', () => {
  test('every performPropertyLookup call site passes lookupOptionsFor(...)', () => {
    const offenders = [];
    for (const file of files) {
      const r = rel(file);
      const src = fs.readFileSync(file, 'utf8');
      for (const { line, n } of callLines(src, 'performPropertyLookup')) {
        if (/module\.exports/.test(line)) continue;
        // The options argument is lookupOptionsFor(...) on the line, or a
        // `callerOptions` variable built from it just above.
        const above = src.split('\n').slice(Math.max(0, n - 8), n).join('\n');
        if (!/lookupOptionsFor\(/.test(line) && !(/callerOptions/.test(line) && /callerOptions = lookupOptionsFor\(/.test(above))) {
          offenders.push(`${r}:${n}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every direct lookupPropertyFromAITrio caller is a declared bypass', () => {
    const offenders = [];
    for (const file of files) {
      const r = rel(file);
      if (r === 'routes/property-lookup-v2.js' || r.startsWith('services/property-lookup/')) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (callLines(src, 'lookupPropertyFromAITrio').length && !TRIO_CALLERS[r]) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  test('the registry names every caller id the code uses, and only those', () => {
    const used = new Set();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/lookupOptionsFor\('([a-z_]+)'/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual(Object.keys(CALLERS).sort());
  });

  test('lookupOptionsFor: opt-in only for declared callers, never from the call site', () => {
    expect(lookupOptionsFor('admin_estimate_tool', { refresh: true })).toEqual({ refresh: true, commercialSuiteSizing: true });
    expect(lookupOptionsFor('estimator_engine', { persist: false })).toEqual({ persist: false, commercialSuiteSizing: true });
    expect(lookupOptionsFor('public_quote', { cacheOnly: true, commercialSuiteSizing: true })).toEqual({ cacheOnly: true });
    expect(lookupOptionsFor('report_cross_sell')).toEqual({});
    expect(() => lookupOptionsFor('nope')).toThrow(/unknown property-lookup caller/);
    for (const [id, c] of Object.entries(CALLERS)) {
      expect(['staff', 'automation', 'public', 'customer']).toContain(c.surface);
      expect(typeof c.suiteSizing).toBe('boolean');
      expect(c.why.length).toBeGreaterThan(8);
      if (c.surface === 'public' || c.surface === 'customer') expect(c.suiteSizing).toBe(false);
      expect(id).toMatch(/^[a-z_]+$/);
    }
  });
});
