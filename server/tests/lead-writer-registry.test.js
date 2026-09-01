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

const { LEAD_WRITERS, PENDING_RULING_REASON, DYNAMIC_TABLE_INSERTS } = require('../config/lead-writer-registry');

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
// Segment arguments allow ONE level of nested parens, so a chain like
// `.modify((qb) => qb.where('active', true))` doesn't stop the walk.
const CHAIN = String.raw`(?:\s*\.\s*(?!insert\b)[\w$]+\s*\((?:[^()]|\([^()]*\))*\))*`;
const Q = '[\'"`]'; // quote class incl. backtick
// Optional schema qualifier INSIDE the literal too — knex accepts
// `db('public.leads')` as a schema-qualified table name.
const LITERAL_LEADS = String.raw`${Q}(?:[\w$]+\.)?leads${Q}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The knex builder shapes, built for a given "table token": the quoted
// literal, or an identifier a constant-resolution pass found bound to the
// string 'leads' in the same file (the repo's `const TABLE = 'leads';
// await db(TABLE).insert(` pattern — cf. services/local-news-store.js).
function knexInsertPatterns(token) {
  return [
    new RegExp(String.raw`\b[A-Za-z_$][\w$]*\(\s*${token}\s*\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
    // `.table(X)` with ANY prefix — `db.table(...)`, `db.withSchema('public').table(...)`.
    new RegExp(String.raw`\.\s*table\s*\(\s*${token}\s*\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
    new RegExp(String.raw`\.into\(\s*${token}\s*\)`, 'g'),
    new RegExp(String.raw`\binsert\s*\(\s*${token}\s*\)`, 'g'),
    new RegExp(String.raw`\bbatchInsert\s*\(\s*${token}`, 'g'),
    new RegExp(String.raw`\bfrom\(\s*${token}\s*\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
  ];
}

// Raw SQL — `db.raw('INSERT INTO leads ...')` in any casing/quoting, with
// an optional schema qualifier (`public.leads`, `"public"."leads"`). Word
// characters after `leads` (lead_activities etc.) break the \b and don't
// match. Also fires on a comment SAYING "insert into leads" — that's fine,
// registering (or rewording) it is cheaper than an unscanned writer form.
const RAW_SQL_INSERT_RE = new RegExp(
  String.raw`\binsert\s+into\s+(?:only\s+)?(?:${Q}?[\w$]+${Q}?\s*\.\s*)?${Q}?leads\b`,
  'gi'
);

// Constant-resolution pass: identifiers bound to the string 'leads'
// (`const TABLE = 'leads';`). Each becomes an extra table token, so every
// builder shape above — and the stored-builder alias below — is also scanned
// with the identifier in place of the literal. The terminator lookahead
// keeps `const x = 'leads' + suffix` (a computed name, not this table) out.
const CONST_DECL_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${LITERAL_LEADS}\s*(?=[;,)\]\n])`,
  'g'
);

function leadsTableTokens(src) {
  const tokens = [LITERAL_LEADS];
  CONST_DECL_RE.lastIndex = 0;
  let m;
  while ((m = CONST_DECL_RE.exec(src))) tokens.push(String.raw`\b${escapeRe(m[1])}\b`);
  return tokens;
}

// Aliased-builder form: a `leads` query builder stored in a variable first
// (`const leads = trx('leads'); ... leads.insert(...)`). The declaration must
// NOT be awaited — `const rows = await db('leads')...` is an executed query,
// not a stored builder. Covers `qb(X)` and `qb.table(X)` heads, including a
// schema-qualified head (`db.withSchema('public').table(X)`) via the same
// CHAIN of intermediate calls the direct patterns allow, for X = the literal
// or a resolved constant.
function aliasInsertPatterns(src, token) {
  const declRe = new RegExp(
    String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:${CHAIN}\s*\.\s*table)?\s*\(\s*${token}\s*\)`,
    'g'
  );
  const patterns = [];
  let decl;
  while ((decl = declRe.exec(src))) {
    patterns.push(new RegExp(String.raw`\b${escapeRe(decl[1])}${CHAIN}\s*\.\s*insert\s*\(`, 'g'));
  }
  return patterns;
}

// Dynamic-table inserts: the table argument is an identifier or member
// expression (`db(table)`, `db(config.table)`), so the scanner cannot prove
// it is not 'leads'. A site is RESOLVED (and skipped) when a same-file
// constant binds the expression's root identifier to a string literal — the
// literal either is leads-shaped (the main scan owns it) or provably is not.
// Everything else must appear in DYNAMIC_TABLE_INSERTS with a reason its
// table set can never contain 'leads'.
// Newline-preserving comment/string blanking for the dynamic scan — a regex
// or label STRING that spells `.into(table)` (contract-tests/validators)
// must not read as a dynamic insert. Newlines survive so line numbers stay
// aligned with the original source.
function blankCommentsAndStrings(code) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  // Template literals: blank the string TEXT but PRESERVE the code inside
  // ${...} substitutions (length- and newline-preserving) — so
  // db(`${schema}.leads`) leaves `schema` visible, reads as a non-blank
  // argument, and is classified dynamic instead of vanishing entirely.
  const blankTemplate = (s) => {
    let out = '';
    let depth = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (depth === 0 && c === '$' && s[i + 1] === '{') { depth = 1; out += '  '; i += 1; continue; }
      if (depth > 0) {
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; out += ' '; continue; }
        out += c === '\n' || depth > 0 ? c : ' ';
        continue;
      }
      out += c === '\n' ? c : ' ';
    }
    return out;
  };
  return code
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p) => p + blank(m.slice(p.length)))
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
    .replace(/`(?:\\.|[^`\\])*`/g, blankTemplate);
}

// ANY table argument, running over BLANKED code: a pure string-literal
// argument blanks to whitespace (skipped — the literal scan owns it), while
// an identifier, member, call (`resolveTable(kind)` — one nesting level),
// conditional, or concatenation survives blanking and is treated as dynamic.
// No top-level comma (a two-argument call is not a knex builder head).
const DYN_EXPR = String.raw`((?:[^(),]|\([^()]*\))+)`;
const DYNAMIC_INSERT_PATTERNS = [
  new RegExp(String.raw`\b[A-Za-z_$][\w$]*\s*\(${DYN_EXPR}\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
  new RegExp(String.raw`\.\s*table\s*\(${DYN_EXPR}\)${CHAIN}\s*\.\s*insert\s*\(`, 'g'),
  new RegExp(String.raw`\bbatchInsert\s*\(${DYN_EXPR},`, 'g'),
  new RegExp(String.raw`\.into\(${DYN_EXPR}\)`, 'g'),
];

function scanSourceForDynamicTableInserts(src) {
  const lines = src.split('\n');
  const code = blankCommentsAndStrings(src); // patterns run on CODE only …
  const endsByLine = new Map();
  const exprByLine = new Map();
  // … but constant resolution reads the ORIGINAL source (the literal lives
  // in a string). Resolution requires a MODULE-LEVEL `const` (column 0 —
  // cannot be reassigned) whose name is SCREAMING_SNAKE, the repo's table
  // constant convention. A lowercase identifier is treated as shadowable
  // (`const table = 'audit'` can be shadowed by a like-named parameter the
  // file-wide regex cannot scope) and conservatively stays dynamic.
  const isResolved = (rawExpr) => {
    const expr = rawExpr.trim();
    if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(expr)) return false; // computed — never resolved
    const root = expr.split('.')[0];
    if (!/^[A-Z][A-Z0-9_]*$/.test(root)) return false; // shadowable name
    return new RegExp(String.raw`^const\s+${escapeRe(root)}\s*=\s*${Q}[\w.]+${Q}`, 'm').test(src);
  };
  const record = (index, matchLen, expr) => {
    if (!expr.trim()) return; // pure string literal, blanked — the literal scan owns it
    if (isResolved(expr)) return;
    const line = code.slice(0, index).split('\n').length;
    if (!endsByLine.has(line)) endsByLine.set(line, new Set());
    endsByLine.get(line).add(index + matchLen);
    if (!exprByLine.has(line)) exprByLine.set(line, expr.trim());
  };
  for (const pattern of DYNAMIC_INSERT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(code))) record(m.index, m[0].length, m[1]);
  }
  // Stored builders over a dynamic table — `const target = db(table);
  // await target.insert(row);` — the dynamic mirror of the alias pass.
  const dynDeclRe = new RegExp(
    String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:${CHAIN}\s*\.\s*table)?\s*\(${DYN_EXPR}\)`,
    'g'
  );
  let decl;
  while ((decl = dynDeclRe.exec(code))) {
    if (!decl[2].trim() || isResolved(decl[2])) continue;
    const useRe = new RegExp(String.raw`\b${escapeRe(decl[1])}${CHAIN}\s*\.\s*insert\s*\(`, 'g');
    let use;
    while ((use = useRe.exec(code))) record(use.index, use[0].length, decl[2]);
  }
  return [...endsByLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, ends]) => ({
      line,
      anchor: lines[line - 1].trim(),
      expr: exprByLine.get(line),
      siteCount: ends.size,
    }));
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(?:js|jsx|cjs|mjs)$/.test(entry.name)) {
      // Every executable JS extension the repo's lint config accepts — a
      // writer in a .cjs/.mjs module must not escape the scan.
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// [{ line, anchor, siteCount }] for one file's source — anchor is the
// trimmed text of the line where the match begins, which is what the
// registry keys on. Distinct sites are told apart by match END position:
// two patterns covering the SAME insert (`db.table('leads').insert(` also
// matches the bare-builder shape) end at the same character and count once,
// while two inserts sharing one source line end at different characters and
// surface as siteCount 2 — which the contract below rejects, because two
// same-line sites cannot get distinguishable anchor keys.
function scanSourceForLeadInserts(src) {
  const lines = src.split('\n');
  const endsByLine = new Map();
  const patterns = [RAW_SQL_INSERT_RE];
  for (const token of leadsTableTokens(src)) {
    patterns.push(...knexInsertPatterns(token), ...aliasInsertPatterns(src, token));
  }
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      if (!endsByLine.has(line)) endsByLine.set(line, new Set());
      endsByLine.get(line).add(m.index + m[0].length);
    }
  }
  return [...endsByLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, ends]) => ({ line, anchor: lines[line - 1].trim(), siteCount: ends.size }));
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

function scanDynamicTableInsertSites() {
  const sites = [];
  for (const abs of walk(SERVER_ROOT).sort()) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    for (const site of scanSourceForDynamicTableInserts(fs.readFileSync(abs, 'utf8'))) {
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
    ['raw SQL insert', "await db.raw('INSERT INTO leads (name) VALUES (?)', [name]);"],
    ['raw SQL insert, template + quoted table', 'await db.raw(`insert into "leads" (name) values (?)`, [name]);'],
    ['raw SQL insert, schema-qualified', "await db.raw('INSERT INTO public.leads (name) VALUES (?)', [name]);"],
    ['raw SQL insert, quoted schema-qualified', 'await db.raw(`insert into "public"."leads" (name) values (?)`, [name]);'],
    ['constant table name', "const TABLE = 'leads';\nawait db(TABLE).insert({ a: 1 });"],
    ['constant table name via batchInsert', "const TABLE = 'leads';\nawait db.batchInsert(TABLE, rows);"],
    ['constant table name through stored builder', "const TABLE = 'leads';\nconst b = trx(TABLE);\nawait b.insert({ a: 1 });"],
    ['schema-qualified table literal', "await db('public.leads').insert({ a: 1 });"],
    ['nested-paren chain segment', "await db('leads').modify((qb) => qb.where('active', true)).insert(row);"],
    ['raw SQL insert with ONLY', "await db.raw('INSERT INTO ONLY leads (name) VALUES (?)', [name]);"],
  ])('detects: %s', (_name, src) => {
    expect(scanSourceForLeadInserts(src).length).toBeGreaterThanOrEqual(1);
  });

  test.each([
    ['awaited read is not a builder alias', "const rows = await db('leads').where({ id });\nrows.insert = noop;"],
    ['read-only query', "const open = await db('leads').where({ status: 'new' }).select('id');"],
    ['insert into another table', "await db('lead_activities').insert({ a: 1 });"],
    ['raw SQL insert into another table', "await db.raw('INSERT INTO lead_activities (a) VALUES (?)', [1]);"],
    ['constant bound to another table', "const TABLE = 'lead_activities';\nawait db(TABLE).insert({ a: 1 });"],
    ['computed table name is not the constant form', "const t = 'leads' + suffix;\nawait audit(t);"],
  ])('ignores: %s', (_name, src) => {
    expect(found(src)).toEqual([]);
  });

  test('two inserts sharing one line surface as TWO sites on that line', () => {
    const sites = scanSourceForLeadInserts("await db('leads').insert(a); await db('leads').insert(b);");
    expect(sites).toHaveLength(1);
    expect(sites[0].siteCount).toBe(2);
  });

  test('overlapping patterns on ONE insert count once', () => {
    const sites = scanSourceForLeadInserts("await db.withSchema('p').table('leads').insert({ a: 1 });");
    expect(sites).toHaveLength(1);
    expect(sites[0].siteCount).toBe(1);
  });

  test('dynamic-table scan: a parameterized insert is flagged; a const-resolved one is not', () => {
    const flagged = scanSourceForDynamicTableInserts(
      'async function store({ table, row }) {\n  await db(table).insert(row);\n}'
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].expr).toBe('table');
    const resolved = scanSourceForDynamicTableInserts(
      "const TABLE = 'other_things';\nawait db(TABLE).insert({ a: 1 });"
    );
    expect(resolved).toEqual([]);
  });

  test('dynamic-table scan: stored builder over a dynamic table is flagged; a reassignable let is not proof', () => {
    const stored = scanSourceForDynamicTableInserts(
      'async function store(table, row) {\n  const target = db(table);\n  await target.insert(row);\n}'
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].expr).toBe('table');
    const reassigned = scanSourceForDynamicTableInserts(
      "let table = 'audit';\ntable = requestedTable;\nawait db(table).insert(row);"
    );
    expect(reassigned).toHaveLength(1);
  });

  test('dynamic-table scan: computed expressions and shadowable lowercase constants stay dynamic', () => {
    const computed = scanSourceForDynamicTableInserts('await db(resolveTable(kind)).insert(row);');
    expect(computed).toHaveLength(1);
    expect(computed[0].expr).toBe('resolveTable(kind)');
    // A lowercase module const is shadowable by a like-named parameter the
    // file-wide regex cannot scope — conservatively dynamic.
    const shadowable = scanSourceForDynamicTableInserts(
      "const table = 'audit';\nasync function f(table, row) {\n  await db(table).insert(row);\n}"
    );
    expect(shadowable).toHaveLength(1);
  });

  test('dynamic-table scan: an interpolated template table is dynamic; a plain template literal is not', () => {
    const interpolated = scanSourceForDynamicTableInserts('await db(`${schema}.leads`).insert(row);');
    expect(interpolated).toHaveLength(1);
    const plain = scanSourceForDynamicTableInserts('await db(`other_things`).insert(row);');
    expect(plain).toEqual([]);
  });

  test('dynamic-table scan: two dynamic inserts on one line surface as TWO sites', () => {
    const sites = scanSourceForDynamicTableInserts('await db(a).insert(x); await db(b).insert(y);');
    expect(sites).toHaveLength(1);
    expect(sites[0].siteCount).toBe(2);
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

  test('every dynamic-table insert is allowlisted with a never-leads reason (and the allowlist is live)', () => {
    const dynamic = scanDynamicTableInsertSites();
    const allowed = new Set(DYNAMIC_TABLE_INSERTS.map(key));
    const unlisted = dynamic.filter((s) => !allowed.has(key(s)));
    expect(unlisted.map((s) => `${s.file}:${s.line} — ${s.anchor} (expr: ${s.expr})`)).toEqual([]);
    // Same rule as the literal scan: two dynamic inserts on one line cannot
    // get distinguishable allowlist keys.
    expect(dynamic.filter((s) => s.siteCount > 1).map(key)).toEqual([]);
    // The allowlist entry is bound to the TABLE EXPRESSION, not just the
    // anchor — swapping `db(photoTable)` for `db(req.body.table)` behind an
    // unchanged insert line changes the expr and forces a re-review of the
    // never-leads reason.
    const byKey = new Map(DYNAMIC_TABLE_INSERTS.map((w) => [key(w), w]));
    for (const s of dynamic) {
      const entry = byKey.get(key(s));
      if (!entry) continue; // already reported above
      expect({ site: key(s), expr: s.expr }).toEqual({ site: key(s), expr: entry.expr });
    }
    const present = new Set(dynamic.map(key));
    const stale = DYNAMIC_TABLE_INSERTS.filter((w) => !present.has(key(w)));
    expect(stale.map(key)).toEqual([]);
    for (const w of DYNAMIC_TABLE_INSERTS) {
      expect({ site: key(w), reason: typeof w.reason }).toEqual({ site: key(w), reason: 'string' });
      expect(w.reason.length).toBeGreaterThan(10);
      expect(/never leads/i.test(w.reason)).toBe(true);
    }
  });

  test('a source line hosts at most one lead insert (same-line sites cannot be registered distinctly)', () => {
    const multi = scanned.filter((s) => s.siteCount > 1);
    expect(multi.map((s) => `${s.file}:${s.line} — ${s.anchor}`)).toEqual([]);
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

  // Innermost enclosing function/method for the anchor line, by indentation:
  // walk upward keeping the smallest indent seen; each line at a smaller
  // indent is an enclosing construct, and the first one that reads as a
  // function header (function decl/expr, arrow, object method — control
  // keywords excluded) starts the span, falling back to column 0. The span
  // ends at the first closer at or below the header's indent. eslint's
  // enforced indentation (lint-staged) is what makes this sound without a
  // real JS parser. Scopes the "no paper resolvers" check to the METHOD
  // holding the registered insert — a resolver mentioned only in imports,
  // comments, or a sibling method is not evidence for THIS site.
  const FUNCTION_HEADER_RE = /(?:\bfunction\b|=>|^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b)[\w$]+\s*\([^()]*\)\s*{\s*$|^\s*[\w$]+\s*:\s*(?:async\b|function\b|\())/;
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  function enclosingFunctionSpan(lines, idx) {
    let threshold = indentOf(lines[idx]);
    let start = 0;
    for (let i = idx - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      const ind = indentOf(l);
      if (ind >= threshold) continue;
      threshold = ind;
      if (FUNCTION_HEADER_RE.test(l) || ind === 0) { start = i; break; }
    }
    const startIndent = indentOf(lines[start]);
    let end = lines.length - 1;
    for (let j = idx + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t && indentOf(lines[j]) <= startIndent && /^[}\])]/.test(t)) { end = j; break; }
    }
    return lines.slice(start, end + 1).join('\n');
  }

  // Strip comments and string/template literals so `// TODO: use
  // findReusableCallLead` or a log string is not resolver evidence — only an
  // identifier in live code counts. Regex-based, not a lexer: `://` inside a
  // string survives the line-comment pass (the (^|[^:]) guard), and any
  // over-stripping only makes the check STRICTER, never lets evidence in.
  // The evidence bar stays "identifier appears in code", not "call
  // expression" — two registered resolvers (dedupEmail, nameConflicts) are
  // variables driving inline lookups, not callables.
  function stripCommentsAndStrings(code) {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');
  }

  test("'none' requires a reason; a named resolver must be referenced in live code within the insert's enclosing function", () => {
    for (const w of LEAD_WRITERS) {
      if (w.identityResolver === 'none') {
        expect({ site: key(w), reason: typeof w.reason }).toEqual({ site: key(w), reason: 'string' });
        expect(w.reason.length).toBeGreaterThan(10);
        continue;
      }
      const lines = fs.readFileSync(path.join(SERVER_ROOT, w.file), 'utf8').split('\n');
      const anchorIdx = lines.findIndex((l) => l.trim() === w.anchor);
      expect({ site: key(w), anchorFound: anchorIdx >= 0 }).toEqual({ site: key(w), anchorFound: true });
      const span = stripCommentsAndStrings(enclosingFunctionSpan(lines, anchorIdx));
      const identifier = w.identityResolver.split(/[\s(]/)[0];
      const referenced = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(span);
      expect({ site: key(w), resolver: identifier, referenced }).toEqual({ site: key(w), resolver: identifier, referenced: true });
    }
  });

  test('PENDING_RULING_REASON is frozen text (a new writer must bring its own justification)', () => {
    expect(PENDING_RULING_REASON).toBe('pre-existing — dedup pending #3137 ruling');
    const pending = LEAD_WRITERS.filter((w) => w.reason === PENDING_RULING_REASON);
    // The pre-existing resolver-less population, frozen by FULL site key
    // (file :: anchor). The pending set must stay a SUBSET of this list:
    // entries LEAVE it as writers adopt a resolver (that's the #3137
    // rollout, and it must go green, not red); any key OUTSIDE it — a new
    // file, OR a rewritten/moved insert in a listed file keeping
    // PENDING_RULING_REASON — is a policy violation, not a fix for a red run
    // (a rewrite is a re-review; a new writer brings its own justification).
    const FROZEN_PENDING_KEYS = new Set([
      "routes/admin-leads.js :: const [lead] = await db('leads').insert({",
      "routes/public-lawn-assessment.js :: const [lead] = await trx('leads').insert({",
      "routes/public-lawn-diagnostic.js :: const [lead] = await trx('leads').insert({",
      "routes/public-pest-identifier.js :: const [lead] = await trx('leads').insert({",
      "routes/public-property-lookup.js :: [lead] = await db('leads').insert({",
      "routes/public-quote.js :: const rows = await db('leads').insert({",
      "routes/tech-field-lead.js :: const [lead] = await db('leads')",
      "routes/tech-lawn-diagnostic.js :: const [lead] = await trx('leads').insert({",
      "services/referral-engine.js :: const [lead] = await db('leads').insert({",
    ]);
    const pendingKeys = new Set(pending.map(key));
    // No key outside the frozen list may be pending (a new or rewritten
    // writer brings its own justification)…
    expect(pending.map(key).filter((k) => !FROZEN_PENDING_KEYS.has(k))).toEqual([]);
    // …and a site that adopts a resolver must DELETE its key from this list
    // in the SAME PR — a deliberate, reviewed one-line edit that is the
    // rollout ceremony, and which stops a later regression back to
    // 'none' + PENDING_RULING_REASON from passing silently.
    expect([...FROZEN_PENDING_KEYS].filter((k) => !pendingKeys.has(k))).toEqual([]);
  });
});
