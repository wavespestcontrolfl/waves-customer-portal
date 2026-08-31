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
// a new writer could plausibly reach for. CHAIN allows intermediate chained
// calls between the `leads` builder head and `.insert(` — e.g.
// `db('leads').returning('*').insert(...)` — with paren-free arguments; it
// also covers the multi-line `db('leads')\n  .insert({` form (zero segments,
// `\s*` spans the newline).
const CHAIN = String.raw`(?:\s*\.\s*(?!insert\b)[\w$]+\s*\([^()]*\))*`;
const Q = '[\'"`]'; // quote class incl. backtick
const INSERT_PATTERNS = [
  new RegExp(String.raw`\b[A-Za-z_$][\w$]*\(\s*${Q}leads${Q}\s*\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
  // `.table('leads')` with ANY prefix — `db.table(...)`, `db.withSchema('public').table(...)`.
  new RegExp(String.raw`\.\s*table\s*\(\s*${Q}leads${Q}\s*\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
  /\.into\(\s*['"`]leads['"`]\s*\)/g,
  /\binsert\s*\(\s*['"`]leads['"`]\s*\)/g,
  /\bbatchInsert\s*\(\s*['"`]leads['"`]/g,
  new RegExp(String.raw`\bfrom\(\s*${Q}leads${Q}\s*\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
];

// Aliased-builder form: a `leads` query builder stored in a variable first
// (`const leads = trx('leads'); ... leads.insert(...)`). The declaration must
// NOT be awaited — `const rows = await db('leads')...` is an executed query,
// not a stored builder. Covers `qb('leads')` and `qb.table('leads')` heads,
// including a schema-qualified head (`db.withSchema('public').table('leads')`)
// via the same CHAIN of intermediate calls the direct patterns allow.
const ALIAS_DECL_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:${CHAIN}\s*\.\s*table)?\s*\(\s*${Q}leads${Q}\s*\)`,
  'g'
);

function aliasInsertPatterns(src) {
  const patterns = [];
  ALIAS_DECL_RE.lastIndex = 0;
  let decl;
  while ((decl = ALIAS_DECL_RE.exec(src))) {
    const name = decl[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(String.raw`\b${name}${CHAIN}\s*\.\s*insert\s*\(`, 'g'));
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

// [{ line, anchor }] for one file's source — anchor is the trimmed text of
// the line where the match begins, which is what the registry keys on.
function scanSourceForLeadInserts(src) {
  const lines = src.split('\n');
  const seen = new Set();
  const sites = [];
  for (const pattern of [...INSERT_PATTERNS, ...aliasInsertPatterns(src)]) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      if (seen.has(line)) continue;
      seen.add(line);
      sites.push({ line, anchor: lines[line - 1].trim() });
    }
  }
  return sites;
}

function scanLeadInsertSites() {
  const sites = [];
  for (const abs of walk(SERVER_ROOT).sort()) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    for (const site of scanSourceForLeadInserts(fs.readFileSync(abs, 'utf8'))) {
      sites.push({ file: rel, ...site });
    }
  }
  return sites;
}

const key = (site) => `${site.file} :: ${site.anchor}`;

describe('lead insert scanner — supported knex chain shapes (synthetic fixtures)', () => {
  const found = (src) => scanSourceForLeadInserts(src).map((s) => s.anchor);

  test.each([
    ['direct insert', "const [l] = await db('leads').insert({ a: 1 });"],
    ['multi-line insert', "const [l] = await db('leads')\n  .insert({ a: 1 });"],
    ['chained before insert', "await db('leads').returning('*').insert({ a: 1 });"],
    ['table builder', "await db.table('leads').insert({ a: 1 });"],
    ['withSchema + table', "await db.withSchema('public').table('leads').insert({ a: 1 });"],
    ['into form', "await knex.insert({ a: 1 }).into('leads');"],
    ['batchInsert', "await db.batchInsert('leads', rows);"],
    ['stored builder alias', "const leads = trx('leads');\nawait leads.insert({ a: 1 });"],
    ['stored table alias', "const t = db.table('leads');\nawait t.returning('id').insert({ a: 1 });"],
    ['stored withSchema table alias', "const leads = db.withSchema('public').table('leads');\nawait leads.insert({ a: 1 });"],
  ])('detects: %s', (_name, src) => {
    expect(scanSourceForLeadInserts(src).length).toBeGreaterThanOrEqual(1);
  });

  test.each([
    ['awaited read is not a builder alias', "const rows = await db('leads').where({ id });\nrows.insert = noop;"],
    ['read-only query', "const open = await db('leads').where({ status: 'new' }).select('id');"],
    ['insert into another table', "await db('lead_activities').insert({ a: 1 });"],
  ])('ignores: %s', (_name, src) => {
    expect(found(src)).toEqual([]);
  });
});

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

  // The enclosing top-level statement's span: nearest column-0 opener line at
  // or above the anchor, through the first column-0 closer at or after it.
  // Scopes the "no paper resolvers" check to the top-level statement holding
  // the registered insert — a function, or the containing object literal when
  // the insert lives in a method (call-recording-processor). Coarser than a
  // real AST scope but deterministic, and it rejects the failure Codex named:
  // a resolver mentioned only in imports, comments, or a sibling top-level
  // function is not evidence for THIS site.
  function enclosingTopLevelSpan(lines, idx) {
    let start = idx;
    while (start > 0 && !/^[A-Za-z_$(]/.test(lines[start])) start--;
    let end = idx;
    while (end < lines.length - 1 && !/^[}\])]/.test(lines[end])) end++;
    return lines.slice(start, end + 1).join('\n');
  }

  test("'none' requires a reason; a named resolver must be referenced within the insert's enclosing function", () => {
    for (const w of LEAD_WRITERS) {
      if (w.identityResolver === 'none') {
        expect({ site: key(w), reason: typeof w.reason }).toEqual({ site: key(w), reason: 'string' });
        expect(w.reason.length).toBeGreaterThan(10);
        continue;
      }
      const lines = fs.readFileSync(path.join(SERVER_ROOT, w.file), 'utf8').split('\n');
      const anchorIdx = lines.findIndex((l) => l.trim() === w.anchor);
      expect({ site: key(w), anchorFound: anchorIdx >= 0 }).toEqual({ site: key(w), anchorFound: true });
      const span = enclosingTopLevelSpan(lines, anchorIdx);
      const identifier = w.identityResolver.split(/[\s(]/)[0];
      const referenced = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(span);
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
