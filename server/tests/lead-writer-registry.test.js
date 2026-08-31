/**
 * Lead-writer registry contract (#3137 groundwork; no behavior change).
 *
 * Deterministic source scan, no DB: every `leads` INSERT site under server/
 * must be registered in config/lead-writer-registry.js with a stable anchor
 * and a declared identity resolver (or 'none' + reason). Mirrors the
 * "classify every tool" pattern of intelligence-bar-write-gate-contract.test.js.
 *
 *  - a NEW insert site that is not registered → FAIL (declare its resolver)
 *  - a registered site that no longer exists → FAIL (stale registry)
 *  - 'none' without a reason → FAIL
 *  - a named resolver the file never references → FAIL (no paper resolvers)
 */

const fs = require('fs');
const path = require('path');

const { LEAD_WRITERS, PENDING_RULING_REASON } = require('../config/lead-writer-registry');

const SERVER_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'coverage']);
// The registry's own anchors are string literals that look like insert sites.
const SKIP_FILES = new Set(['config/lead-writer-registry.js']);

// Every knex spelling of "insert into leads" seen in this repo plus the ones
// a new writer could plausibly reach for. `\s*` between the builder and
// `.insert` covers the multi-line `db('leads')\n  .insert({` form.
const INSERT_PATTERNS = [
  /\b[A-Za-z_$][\w$]*\(\s*['"`]leads['"`]\s*\)\s*\.\s*insert\s*\(/g,
  /\b[A-Za-z_$][\w$]*\s*\.\s*table\s*\(\s*['"`]leads['"`]\s*\)\s*\.\s*insert\s*\(/g,
  /\.into\(\s*['"`]leads['"`]\s*\)/g,
  /\binsert\s*\(\s*['"`]leads['"`]\s*\)/g,
  /\bbatchInsert\s*\(\s*['"`]leads['"`]/g,
  /\bfrom\(\s*['"`]leads['"`]\s*\)\s*\.\s*insert\s*\(/g,
];

// Aliased-builder form: a `leads` query builder stored in a variable first
// (`const leads = trx('leads'); ... leads.insert(...)`). The declaration must
// NOT be awaited — `const rows = await db('leads')...` is an executed query,
// not a stored builder. Covers `qb('leads')` and `qb.table('leads')` heads.
const ALIAS_DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:\s*\.\s*table)?\s*\(\s*['"`]leads['"`]\s*\)/g;

function aliasInsertPatterns(src) {
  const patterns = [];
  ALIAS_DECL_RE.lastIndex = 0;
  let decl;
  while ((decl = ALIAS_DECL_RE.exec(src))) {
    const name = decl[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(`\\b${name}\\s*\\.\\s*insert\\s*\\(`, 'g'));
  }
  return patterns;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// [{ file, line, anchor }] — anchor is the trimmed text of the line where the
// match begins, which is what the registry keys on.
function scanLeadInsertSites() {
  const sites = [];
  for (const abs of walk(SERVER_ROOT).sort()) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const lines = src.split('\n');
    const seen = new Set();
    for (const pattern of [...INSERT_PATTERNS, ...aliasInsertPatterns(src)]) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        if (seen.has(line)) continue;
        seen.add(line);
        sites.push({
          file: rel,
          line,
          anchor: lines[line - 1].trim(),
        });
      }
    }
  }
  return sites;
}

const key = (site) => `${site.file} :: ${site.anchor}`;

describe('lead-writer registry (#3137 groundwork)', () => {
  const scanned = scanLeadInsertSites();

  test('scanner finds the known writer population (sanity — not a cap)', () => {
    // Guards against the scan silently returning nothing (regex drift, wrong
    // root). The exact set is asserted below; this only proves the scan ran.
    expect(scanned.length).toBeGreaterThanOrEqual(10);
    expect(scanned.some((s) => s.file === 'services/call-recording-processor.js')).toBe(true);
  });

  test('every scanned insert site is registered (new writer must declare a resolver)', () => {
    const registered = new Set(LEAD_WRITERS.map(key));
    const unregistered = scanned.filter((s) => !registered.has(key(s)));
    expect(unregistered.map((s) => `${s.file}:${s.line} — ${s.anchor}`)).toEqual([]);
  });

  test('every registered site still exists (stale registry)', () => {
    const present = new Set(scanned.map(key));
    const stale = LEAD_WRITERS.filter((w) => !present.has(key(w)));
    expect(stale.map(key)).toEqual([]);
  });

  test('registry anchors are unique within their file and registry has no duplicates', () => {
    const keys = LEAD_WRITERS.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const w of LEAD_WRITERS) {
      const src = fs.readFileSync(path.join(SERVER_ROOT, w.file), 'utf8');
      const occurrences = src.split('\n').filter((l) => l.trim() === w.anchor).length;
      expect({ site: key(w), occurrences }).toEqual({ site: key(w), occurrences: 1 });
    }
  });

  test('every entry is well-formed: server-relative file, non-numeric anchor, resolver declared', () => {
    for (const w of LEAD_WRITERS) {
      expect(typeof w.file).toBe('string');
      expect(w.file.startsWith('server/')).toBe(false);
      expect(fs.existsSync(path.join(SERVER_ROOT, w.file))).toBe(true);
      expect(typeof w.anchor).toBe('string');
      expect(w.anchor.length).toBeGreaterThan(8);
      expect(/^\d+$/.test(w.anchor)).toBe(false);
      expect(typeof w.context).toBe('string');
      expect(typeof w.identityResolver).toBe('string');
      expect(w.identityResolver.length).toBeGreaterThan(0);
    }
  });

  test("'none' requires a reason; a named resolver must actually be referenced by the file", () => {
    for (const w of LEAD_WRITERS) {
      if (w.identityResolver === 'none') {
        expect({ site: key(w), reason: typeof w.reason }).toEqual({ site: key(w), reason: 'string' });
        expect(w.reason.length).toBeGreaterThan(10);
        continue;
      }
      const src = fs.readFileSync(path.join(SERVER_ROOT, w.file), 'utf8');
      const identifier = w.identityResolver.split(/[\s(]/)[0];
      const referenced = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src);
      expect({ site: key(w), resolver: identifier, referenced }).toEqual({ site: key(w), resolver: identifier, referenced: true });
    }
  });

  test('PENDING_RULING_REASON is frozen text (a new writer must bring its own justification)', () => {
    expect(PENDING_RULING_REASON).toBe('pre-existing — dedup pending #3137 ruling');
    const pending = LEAD_WRITERS.filter((w) => w.reason === PENDING_RULING_REASON);
    // Snapshot of the pre-existing resolver-less population. Entries may be
    // REMOVED as writers adopt a resolver; adding a new file here is a policy
    // violation, not a fix for a red run.
    expect(pending.map((w) => w.file).sort()).toEqual([
      'routes/admin-leads.js',
      'routes/public-lawn-assessment.js',
      'routes/public-lawn-diagnostic.js',
      'routes/public-pest-identifier.js',
      'routes/public-property-lookup.js',
      'routes/public-quote.js',
      'routes/tech-field-lead.js',
      'routes/tech-lawn-diagnostic.js',
      'services/referral-engine.js',
    ]);
  });
});
