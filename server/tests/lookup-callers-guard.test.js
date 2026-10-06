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
    if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}
const files = walk(SERVER_ROOT);
const rel = (f) => path.relative(SERVER_ROOT, f).split(path.sep).join('/');

// Every local name a file gives a function: the name itself plus any alias
// bound from it (`const performLookup = lookup || require(...).performPropertyLookup`,
// `const { performPropertyLookup: lookupFn } = ...`, `const x = performPropertyLookup`).
function aliasesOf(src, name) {
  const names = new Set([name]);
  for (const m of src.matchAll(new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*\\b' + name + '\\b', 'g'))) names.add(m[1]);
  for (const m of src.matchAll(new RegExp(name + '\\s*:\\s*([A-Za-z_$][\\w$]*)', 'g'))) if (m[1] !== 'jest') names.add(m[1]);
  return [...names];
}
const lookupAliases = (src) => aliasesOf(src, 'performPropertyLookup');

// The one sanctioned place the scope decision is changed after the registry
// answered: the admin route turning the leg OFF for a whole-property job.
const SANCTIONED_OVERRIDE = { file: 'routes/property-lookup-v2.js', line: /^\s*if \(wholeProperty === true\) callerOptions\.commercialSuiteSizing = false;\s*$/ };

// Lines that CALL the lookup (not the definition, not a comment, not a jest mock).
function callLines(src, name) {
  const re = new RegExp('(?<![\\w.])' + name + '\\(');
  const def = new RegExp('function\\s+' + name + '\\(');
  const mock = new RegExp(name + ':\\s*jest');
  return src.split('\n').map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => re.test(line) && !/^\s*(\/\/|\*)/.test(line) && !def.test(line) && !mock.test(line));
}

// The modules that define or read `commercialSuiteSizing`. A new file under
// services/property-lookup/ is NOT one of them until it is listed here.
const OPTION_OWNERS = new Set([
  'routes/property-lookup-v2.js', // the sanctioned whole-property switch-off (checked line by line below)
  'services/property-lookup/lookup-callers.js', // the registry sets it
  'services/property-lookup/ai-property-lookup.js', // the lookup reads it
  'config/feature-gates.js', // the gate reader's doc comment
]);

describe('property-lookup callers declare their scope decision', () => {
  test('the registry and every entry are frozen; no file reassigns a policy field', () => {
    const { CALLERS, TRIO_CALLERS } = require('../services/property-lookup/lookup-callers');
    expect(Object.isFrozen(CALLERS)).toBe(true);
    expect(Object.isFrozen(TRIO_CALLERS)).toBe(true);
    for (const [id, entry] of Object.entries(CALLERS)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(() => { 'use strict'; entry.suiteSizing = !entry.suiteSizing; }).toThrow();
      expect(['staff', 'automation', 'customer', 'public']).toContain(entry.surface);
      expect(typeof entry.suiteSizing).toBe('boolean');
      expect(typeof entry.file).toBe('string');
      expect(id).toMatch(/^[a-z_]+$/);
    }
    // ...and no production line even tries: an assignment to a policy field
    // (`.suiteSizing =`, `.surface =`, `.file =` on a CALLERS entry) outside
    // the registry file is an offender regardless of the freeze.
    const offenders = [];
    for (const file of files) {
      const r = rel(file);
      if (r === 'services/property-lookup/lookup-callers.js') continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/CALLERS\b[^\n]*\.(suiteSizing|surface|file|why)\s*=[^=]/.test(line) || /\.suiteSizing\s*=[^=]/.test(line)) {
          offenders.push(`${r}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });


  test('every performPropertyLookup call site passes lookupOptionsFor(...)', () => {
    const offenders = [];
    // Actual lookup INVOCATIONS per file, counted independently of the
    // lookupOptionsFor(...) occurrences the id test counts: one callerOptions
    // reused for a second lookup in the same file is a second purpose too.
    const invocations = {};
    for (const file of files) {
      const r = rel(file);
      const src = fs.readFileSync(file, 'utf8');
      for (const name of lookupAliases(src)) for (const { line, n } of callLines(src, name)) {
        // The alias binding itself ("= lookup || require(...).performPropertyLookup") is not a call.
        if (new RegExp(`(const|let|var)\\s+${name}\\s*=`).test(line)) continue;
        invocations[r] = (invocations[r] || 0) + 1;
        // The options argument is lookupOptionsFor(...) on the line, or a
        // `callerOptions` variable built from it just above.
        const above = src.split('\n').slice(Math.max(0, n - 8), n).join('\n');
        if (!/lookupOptionsFor\(/.test(line) && !(/callerOptions/.test(line) && /callerOptions = lookupOptionsFor\(/.test(above))) {
          offenders.push(`${r}:${n}: ${line.trim()}`);
        }
        // No override of the decision at the call: the options argument may
        // not mention commercialSuiteSizing ("{ ...lookupOptionsFor('x'), commercialSuiteSizing: true }").
        if (/commercialSuiteSizing/.test(line)) offenders.push(`${r}:${n}: overrides the registry's scope decision`);
      }
      // ...and a caller never SETS the option anywhere else in its file
      // either, except the one sanctioned whole-property switch-off in the
      // admin route. Only the modules that define or read the option are
      // exempt, named one by one: any other file, the lookup directory
      // included, is a caller. A caller has no reason to spell the option
      // at all, so ANY non-comment mention is an offender: dot or bracket
      // assignment, a string key, Object.assign / defineProperty, a spread
      // of an object that names it, whatever the form.
      if (!OPTION_OWNERS.has(r)) {
        src.split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line) || !/commercialSuiteSizing(?!Live\b)/.test(line)) return;
          offenders.push(`${r}:${i + 1}: names commercialSuiteSizing outside the registry`);
        });
      } else if (r === SANCTIONED_OVERRIDE.file) {
        src.split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line) || !/callerOptions\s*(\.|\[)\s*['"`]?commercialSuiteSizing/.test(line)) return;
          if (!SANCTIONED_OVERRIDE.line.test(line)) offenders.push(`${r}:${i + 1}: unsanctioned override of callerOptions`);
        });
      }
    }
    expect(offenders).toEqual([]);
    // Each file's lookup invocations equal the `calls` its registry entries
    // declare for it, so a second performPropertyLookup in a declared file
    // fails here even when it reuses the first call's callerOptions.
    const declaredByFile = {};
    for (const c of Object.values(CALLERS)) declaredByFile[c.file] = (declaredByFile[c.file] || 0) + c.calls;
    expect(invocations).toEqual(declaredByFile);
  });

  test('every direct lookupPropertyFromAITrio caller (by any alias) is a declared bypass', () => {
    // The lookup's own internal use is pinned, not exempted: the defining
    // module makes no call (its `function` line and export are not calls),
    // and the lookup route composes the trio into a profile exactly once.
    // A second call in either file is a second purpose and fails here like
    // an undeclared caller does.
    const INTERNAL = { 'routes/property-lookup-v2.js': 1 };
    const found = {};
    for (const file of files) {
      const r = rel(file);
      const src = fs.readFileSync(file, 'utf8');
      const calls = aliasesOf(src, 'lookupPropertyFromAITrio').flatMap((name) => callLines(src, name)
        .filter(({ line }) => !new RegExp(`(const|let|var)\\s+${name}\\s*=`).test(line)));
      if (calls.length) found[r] = calls.length;
    }
    // Both directions, with the call count: a direct caller the registry
    // does not name is a new, unreviewed bypass; a registry entry with no
    // direct call left is stale; and a second call in a declared file is a
    // second purpose the one-line declaration does not cover.
    const declared = { ...INTERNAL, ...Object.fromEntries(Object.entries(TRIO_CALLERS).map(([f, d]) => [f, d.calls])) };
    expect(found).toEqual(declared);
  });

  test('every caller id is used in exactly the one file the registry binds it to, always as a single-quoted literal', () => {
    const uses = {};
    const nonCanonical = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      if (rel(file) === 'services/property-lookup/lookup-callers.js') continue;
      // Every call of lookupOptionsFor, however its first argument is written:
      // only a single-quoted literal id is accepted. A double-quoted string,
      // a template, a variable or an expression cannot be bound to a file
      // and is refused outright.
      for (const m of src.matchAll(/lookupOptionsFor\(\s*([^,)]*)/g)) {
        const arg = m[1].trim();
        const lit = arg.match(/^'([a-z_]+)'$/);
        if (lit) (uses[lit[1]] ||= []).push(rel(file));
        else nonCanonical.push(`${rel(file)}: lookupOptionsFor(${arg}`);
      }
    }
    expect(nonCanonical).toEqual([]);
    // Each id appears in its own file only, exactly `calls` times: a second
    // lookup purpose added to the same file is a new caller that must
    // declare its own policy (or a reviewed count bump), not a free reuse of
    // this one's suite-sizing decision.
    const expected = Object.fromEntries(Object.entries(CALLERS).map(([id, c]) => [id, { files: [c.file], calls: c.calls }]));
    const actual = Object.fromEntries(Object.entries(uses).map(([id, fs_]) => [id, { files: [...new Set(fs_)], calls: fs_.length }]));
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
      expect(Number.isInteger(c.calls) && c.calls >= 1).toBe(true);
      expect(c.why.length).toBeGreaterThan(8);
      expect(fs.existsSync(path.join(SERVER_ROOT, c.file))).toBe(true);
      if (c.surface === 'public' || c.surface === 'customer') expect(c.suiteSizing).toBe(false);
      expect(id).toMatch(/^[a-z_]+$/);
    }
  });
});
