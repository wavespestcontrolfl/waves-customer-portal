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

// Every local name the file gives the lookup: the function itself plus any
// alias bound from it (`const performLookup = lookup || require(...).performPropertyLookup`,
// `const { performPropertyLookup: lookupFn } = ...`, `const x = performPropertyLookup`).
function lookupAliases(src) {
  const names = new Set(['performPropertyLookup']);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*\bperformPropertyLookup\b/g)) names.add(m[1]);
  for (const m of src.matchAll(/performPropertyLookup\s*:\s*([A-Za-z_$][\w$]*)/g)) if (m[1] !== 'jest') names.add(m[1]);
  return [...names];
}

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
      for (const name of lookupAliases(src)) for (const { line, n } of callLines(src, name)) {
        if (/module\.exports/.test(line)) continue;
        // The alias binding itself ("= lookup || require(...).performPropertyLookup") is not a call.
        if (new RegExp(`(const|let|var)\\s+${name}\\s*=`).test(line)) continue;
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

  test('every caller id is used in exactly the one file the registry binds it to', () => {
    const uses = {};
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/lookupOptionsFor\('([a-z_]+)'/g)) (uses[m[1]] ||= []).push(rel(file));
    }
    const expected = Object.fromEntries(Object.entries(CALLERS).map(([id, c]) => [id, [c.file]]));
    // Each id appears in its own file only (a file may call it more than once).
    const actual = Object.fromEntries(Object.entries(uses).map(([id, fs_]) => [id, [...new Set(fs_)]]));
    expect(actual).toEqual(expected);
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
      expect(fs.existsSync(path.join(SERVER_ROOT, c.file))).toBe(true);
      if (c.surface === 'public' || c.surface === 'customer') expect(c.suiteSizing).toBe(false);
      expect(id).toMatch(/^[a-z_]+$/);
    }
  });
});
