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
// Segment arguments allow TWO levels of nested parens, so ordinary Knex
// callback chains — `.modify((qb) => qb.where('active', true))` and
// `.modify(qb => qb.whereIn('id', ids.map(fn)))` — don't stop the walk.
const CHAIN = String.raw`(?:\s*\??\.\s*(?!insert\b)[\w$]+\s*\((?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\))*`;
const Q = '[\'"`]'; // quote class incl. backtick
// `.insert(` in either spelling — dot access or literal bracket access
// (`db('leads')['insert'](row)`).
const INSERT_CALL = String.raw`(?:\??\.\s*insert|\[\s*['"\x60]insert['"\x60]\s*\])\s*\(`;
// `.table(` / `.from(` in either spelling too — `db['table']('leads')`.
const TABLE_SEL = String.raw`(?:\??\.\s*table|\[\s*['"\x60]table['"\x60]\s*\])`;
const FROM_SEL = String.raw`(?:\??\.\s*from|\bfrom|\[\s*['"\x60]from['"\x60]\s*\])`;
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
    // Optional factory call between the identifier and the table argument —
    // the `getDb()('leads')` callable-factory style (routes/knowledge.js).
    new RegExp(String.raw`\b[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(\s*${token}\s*\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
    // `.table(X)` with ANY prefix — `db.table(...)`, `db.withSchema('public').table(...)`.
    new RegExp(String.raw`${TABLE_SEL}\s*\(\s*${token}\s*\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
    // `.into` only AS PART OF an insert chain — `db.select('*').into(x)`
    // reads, it doesn't create.
    new RegExp(String.raw`${INSERT_CALL}(?:[^()]|\([^()]*\))*\)${CHAIN}\s*\.into\(\s*${token}\s*\)`, 'g'),
    new RegExp(String.raw`\.into\(\s*${token}\s*\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
    // Table selected AFTER the insert — `db.insert(row).table('leads')`,
    // the insert-first analog of `.into`.
    new RegExp(String.raw`${INSERT_CALL}(?:[^()]|\([^()]*\))*\)${CHAIN}\s*${TABLE_SEL}\s*\(\s*${token}\s*\)`, 'g'),
    new RegExp(String.raw`\binsert\s*\(\s*${token}\s*\)`, 'g'),
    new RegExp(String.raw`\bbatchInsert\s*\(\s*${token}`, 'g'),
    new RegExp(String.raw`${FROM_SEL}\s*\(\s*${token}\s*\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
  ];
}

// Raw SQL — `db.raw('INSERT INTO leads ...')` in any casing/quoting, with
// an optional schema qualifier (`public.leads`, `"public"."leads"`) and the
// optional ONLY keyword. Word characters after `leads` (lead_activities
// etc.) break the \b and don't match. The scan runs on comment-blanked
// source, so a comment merely saying "insert into leads" is not a site.
// Keyword separator: whitespace OR a string-fragment boundary
// (`'INSERT ' + 'INTO leads'`) — constant SQL split at token boundaries is
// still one statement. (A mid-word split is deliberate obfuscation beyond
// textual scanning.)
const RAW_SEP = String.raw`(?:\s*${Q}\s*\+\s*${Q}\s*|\s*\/\*[\s\S]*?\*\/\s*|\s*--[^\n]*\n\s*|\s+)`;
const RAW_SQL_INSERT_RE = new RegExp(
  String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?(?:${Q}?[\w$]+${Q}?\s*\.\s*)?${Q}?leads\b`,
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

// Every simple `A = B;` identifier assignment in one pass — the alias
// closures consume these in memory instead of re-scanning the source.
const assignPairsCache = new Map();
function simpleAssignPairs(src) {
  let pairs = assignPairsCache.get(src);
  if (pairs) return pairs;
  pairs = [];
  const re = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;,)\n]/g;
  let m;
  while ((m = re.exec(src))) pairs.push([m[1], m[2]]);
  assignPairsCache.set(src, pairs);
  return pairs;
}

// A raw-SQL match counts only in an EXECUTABLE raw-query context: a `raw(`
// opener shortly before the match, OR the SQL stored in a constant that is
// later PASSED to raw (`const SQL = 'INSERT …'; db.raw(SQL)`). A doc
// constant never handed to raw is ignored.
function inRawContext(code, idx) {
  // Nearest preceding `raw(` whose call is still OPEN at the match: walk
  // paren depth on the fully blanked view (SQL-string parens are blanked
  // there), so a long CTE cannot outrun a fixed window.
  const bare = blankCommentsAndStrings(code);
  const rawAt = bare.lastIndexOf('raw', idx);
  if (rawAt !== -1 && idx - rawAt < 20000) {
    const open = bare.indexOf('(', rawAt);
    if (open !== -1 && open < idx) {
      let depth = 0;
      let inside = true;
      for (let k = open; k < idx; k += 1) {
        if (bare[k] === '(') depth += 1;
        else if (bare[k] === ')') { depth -= 1; if (depth === 0) { inside = false; break; } }
      }
      if (inside && depth >= 1) return true;
    }
  }
  if (/\braw\s*\(/.test(code.slice(Math.max(0, idx - 300), idx))) return true;
  // The declaration may sit on an earlier line (`const SQL =\n  'INSERT…'`):
  // look back a short window and require only whitespace/quotes/glue between
  // the `=` and the match.
  const back = code.slice(Math.max(0, idx - 200), idx);
  const decl = back.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[\s'"\x60+]*$/);
  if (decl) return new RegExp(String.raw`\braw\s*\(\s*${escapeRe(decl[1])}\b`).test(code);
  return false;
}

// Function-shaped factories with BALANCED bodies of any nesting depth: find
// every `function NAME(...) {` and block-bodied arrow head, walk the body to
// its matching brace, and report the name when the body RETURNS a builder
// matching bodyRe (whose first capture is returned for the caller).
function balancedFunctionBodies(src) {
  const out = [];
  const headRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{|\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{|(?<![.\w$])(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g;
  let h;
  while ((h = headRe.exec(src))) {
    const name = h[1] || h[3] || h[6];
    if (!name) continue;
    const params = (h[2] ?? h[4] ?? h[5] ?? h[7] ?? '')
      .split(',')
      .map((x) => x.trim().replace(/^\.\.\./, '').split(/[=\s]/)[0])
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
    let depth = 1;
    let j = headRe.lastIndex;
    for (; j < src.length && depth > 0; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
    }
    out.push({ name, params, body: src.slice(headRe.lastIndex, j) });
  }
  return out;
}

function balancedBodyFactories(src, bodyRe) {
  const out = [];
  for (const { name, body } of balancedFunctionBodies(src)) {
    bodyRe.lastIndex = 0;
    const bm = bodyRe.exec(body);
    if (bm) out.push({ name, capture: bm[1] });
  }
  return out;
}

// In-file INSERTION HELPERS: functions whose own parameter drives the
// insert (`function writeRow(builder, row) { return builder.insert(row); }`).
// A leads builder handed to one of these is created at the CALL site, which
// is therefore the registered writer. A helper that only reads its builder
// parameter (`whereBuilderWarrantyExpiring(qb)`) is not one.
function insertingHelperNames(src) {
  const names = new Set();
  for (const { name, params, body } of balancedFunctionBodies(src)) {
    for (const param of params) {
      if (new RegExp(String.raw`\b${escapeRe(param)}${CHAIN}\s*${INSERT_CALL}`).test(body)) names.add(name);
    }
  }
  return names;
}

function leadsTableTokens(src) {
  const tokens = [{ token: LITERAL_LEADS, name: null }];
  CONST_DECL_RE.lastIndex = 0;
  let m;
  while ((m = CONST_DECL_RE.exec(src))) tokens.push({ token: String.raw`\b${escapeRe(m[1])}\b`, name: m[1] });
  return tokens;
}

// Lexical approximation for a SHADOWED constant name: the declaration that
// governs a use site is the nearest preceding `const NAME = '…'` in the
// file. `function a() { const TABLE = 'leads'; … }` and `function b() {
// const TABLE = 'audit'; db(TABLE).insert(row); }` bind different tables;
// only the site whose nearest declaration says 'leads' is a lead writer.
// (Declaration-before-use is how every table constant in this repo reads;
// a hoisted `var` used before its declaration would fall to the literal
// walk-back and count — erring toward flagging.)
function nearestDeclBindsLeads(code, name, idx) {
  const declRe = new RegExp(String.raw`\b(?:const|let|var)\s+${escapeRe(name)}\s*=\s*(['"\x60])([^'"\x60]*)\1`, 'g');
  let value = null;
  let d;
  while ((d = declRe.exec(code)) && d.index < idx) value = d[2];
  return value === null || value === 'leads';
}

// Aliased-builder form: a `leads` query builder stored in a variable first
// (`const leads = trx('leads'); ... leads.insert(...)`). The declaration must
// NOT be awaited — `const rows = await db('leads')...` is an executed query,
// not a stored builder. Covers `qb(X)` and `qb.table(X)` heads, including a
// schema-qualified head (`db.withSchema('public').table(X)`) via the same
// CHAIN of intermediate calls the direct patterns allow, for X = the literal
// or a resolved constant.
function aliasInsertPatterns(src, token) {
  // Declaration keyword OPTIONAL — a builder stored by a later assignment
  // (`let target; target = db('leads');`) is the same stored-builder form.
  // Optional factory call after the head identifier — `getDb()('leads')`.
  const declRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?(?:${CHAIN}\s*(?:\.\s*(?:table|from)|\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*\(\s*${token}\s*\)`,
    'g'
  );
  const patternsExtra = [];
  const builders = new Set();
  const factories = new Set();
  let decl;
  while ((decl = declRe.exec(src))) builders.add(decl[1]);
  // Conditional/logical initializers — `const target = cond ? db('leads')
  // : db('audit');` — anything holding a leads builder anywhere in its
  // (non-awaited) initializer is a stored builder.
  const condDeclRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![^;]{0,200}\bawait\b)[^;]{0,200}?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(\s*${token}\s*\)`,
    'g'
  );
  let cnd;
  while ((cnd = condDeclRe.exec(src))) builders.add(cnd[1]);
  // Builders stored in OBJECT PROPERTIES — `const queries = { lead:
  // db('leads') }; queries.lead.insert(row)`. The use pattern keys on the
  // property name reached through any object.
  const propDeclRe = new RegExp(
    String.raw`([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(\s*${token}\s*\)`,
    'g'
  );
  const props = new Set();
  let pd;
  while ((pd = propDeclRe.exec(src))) props.add(pd[1]);
  // A leads builder CONSTRUCTED AS AN ARGUMENT to an in-file insertion
  // helper (`writeRow(db('leads'), row)`): the construction site is the
  // registered writer.
  for (const helper of insertingHelperNames(src)) {
    patternsExtra.push(new RegExp(
      String.raw`\b${escapeRe(helper)}\s*\((?:[^()]|\([^()]*\))*?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(\s*${token}\s*\)`,
      'g'
    ));
  }
  // Arrow FACTORY returning the builder — `const baseQuery = () =>
  // db('leads'); … baseQuery().insert(row)` (the v2-promotion-readiness
  // idiom). Parenthesized or bare parameter lists both count.
  const factoryRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{(?:[^{}]|\{[^{}]*\})*?\breturn\s+)?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(\s*${token}\s*\)`,
    'g'
  );
  let fac;
  while ((fac = factoryRe.exec(src))) factories.add(fac[1]);
  // Function/block-arrow factories with BALANCED bodies of any depth —
  // `function baseQuery() { try { … } finally { … } return db('leads'); }`.
  const returnRe = new RegExp(String.raw`\breturn\b[^;]{0,160}?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?(?:\s*(?:\??\.\s*(?:table|from)|\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*\(\s*(${token})\s*\)`);
  for (const f of balancedBodyFactories(src, returnRe)) factories.add(f.name);
  // TRANSITIVE aliases: `const target = base;` makes `target` the same
  // builder (or factory), to a fixpoint. One pass collects every simple
  // identifier-to-identifier assignment; the closure runs in memory.
  const pairs = simpleAssignPairs(src);
  for (const set of [builders, factories]) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b] of pairs) {
        if (set.has(b) && !set.has(a)) { set.add(a); grew = true; }
      }
    }
  }
  const patterns = [...patternsExtra];
  for (const n of builders) {
    patterns.push(new RegExp(String.raw`\b${escapeRe(n)}${CHAIN}\s*${INSERT_CALL}`, 'g'));
  }
  for (const pn of props) {
    patterns.push(new RegExp(String.raw`\b[A-Za-z_$][\w$]*\s*(?:\.\s*${escapeRe(pn)}|\[\s*['"\x60]${escapeRe(pn)}['"\x60]\s*\])${CHAIN}\s*${INSERT_CALL}`, 'g'));
  }
  for (const n of factories) {
    patterns.push(new RegExp(String.raw`\b${escapeRe(n)}\s*\([^()]*\)${CHAIN}\s*${INSERT_CALL}`, 'g'));
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
// Newline- and length-preserving comment/string blanking — a regex or label
// STRING that spells `.into(table)` must not read as a dynamic insert, and a
// string containing '/*' must not swallow the live code after it. A SINGLE
// lexical pass tracks string vs. comment state, so delimiters inside strings
// are string content, never syntax. Template literals blank their text but
// PRESERVE the code inside ${...} substitutions — db(`${schema}.leads`)
// leaves `schema` visible and reads as a dynamic argument. (Regex literals
// are not lexed; a quote inside one can over-blank to end-of-line, which
// only errs toward flagging.)
function lexBlank(code, { keepStrings = false } = {}) {
  const n = code.length;
  let out = '';
  const blank = (c) => { out += c === '\n' ? '\n' : ' '; };
  const emitStr = (c) => { if (keepStrings) out += c; else blank(c); };
  // Last significant (non-whitespace) code character — a `/` after one of
  // these starts a REGEX LITERAL, not division. Its content (quotes
  // included) is data and blanks out, so `db(/'/.test(kind) ? t : f)` does
  // not derail the string lexer.
  let lastSig = '';
  const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
  let i = 0;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d !== '/' && d !== '*'
      && (lastSig === '' || REGEX_PRECEDERS.includes(lastSig) || (() => {
        // A regex can also follow an expression-start KEYWORD — `return
        // /'/…` — where lastSig is the keyword's final letter.
        const kw = out.slice(-24).trimEnd().match(/([A-Za-z_$][\w$]*)$/);
        return Boolean(kw) && ['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'].includes(kw[1]);
      })())) {
      blank(c); i += 1;
      let inClass = false;
      while (i < n && code[i] !== '\n') {
        const ch = code[i];
        if (ch === '\\') { blank(ch); i += 1; if (i < n) { blank(code[i]); i += 1; } continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        blank(ch); i += 1;
        if (ch === '/' && !inClass) break;
      }
      lastSig = '/';
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') { blank(code[i]); i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      blank(c); blank(d); i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { blank(code[i]); i += 1; }
      if (i < n) { blank('*'); blank('/'); i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      // Buffer the whole string, then decide: in keepStrings mode a string
      // is preserved only when it PLAUSIBLY names a table (a short
      // word/dot token) or is SQL text (starts with a SQL keyword) — a
      // code-shaped doc string ("await db('leads').insert(row)") blanks
      // out so it can never read as a live writer.
      let buf = c;
      i += 1;
      while (i < n && code[i] !== c && code[i] !== '\n') {
        if (code[i] === '\\') { buf += code[i]; i += 1; }
        if (i < n) { buf += code[i]; i += 1; }
      }
      if (i < n) { buf += code[i]; i += 1; }
      const content = buf.slice(1, buf[buf.length - 1] === c ? -1 : undefined);
      // Keep a string UNLESS it embeds quote characters — that's what makes
      // a doc string code-shaped ("await db('leads').insert(row)"): its
      // inner quotes would otherwise read as live table literals. Two
      // exceptions stay scannable: quote-free content (table names, plain
      // SQL fragments) and content that STARTS as a SQL statement —
      // `"INSERT INTO leads (status) VALUES ('new')"` is a real writer
      // even with quoted values inside.
      const sqlBody = content.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n?)*/, '');
      const plausible = !/['"`]/.test(content) || /^(?:insert|update|delete|select|with|merge)\b/i.test(sqlBody);
      // Method-name strings survive even FULL blanking, so bracket
      // selectors (db['table'](x)) stay visible to the dynamic scan.
      const methodName = /^(?:insert|table|from)$/.test(content);
      for (const ch of buf) {
        if ((keepStrings && plausible) || methodName) out += ch;
        else out += ch === '\n' ? '\n' : ' ';
      }
      lastSig = c; // after a string, `/` is division
      continue;
    }
    if (c === '`') {
      emitStr(c); i += 1;
      let depth = 0;
      while (i < n) {
        if (depth === 0 && code[i] === '\\') { emitStr(code[i]); i += 1; if (i < n) { emitStr(code[i]); i += 1; } continue; }
        if (depth === 0 && code[i] === '`') { emitStr(code[i]); i += 1; break; }
        if (depth === 0 && code[i] === '$' && code[i + 1] === '{') { depth = 1; out += keepStrings ? '${' : '  '; i += 2; continue; }
        if (depth > 0) {
          if (code[i] === '{') depth += 1;
          else if (code[i] === '}') {
            depth -= 1;
            if (depth === 0) { out += keepStrings ? '}' : ' '; i += 1; continue; }
          }
          out += code[i]; i += 1;
          continue;
        }
        emitStr(code[i]); i += 1;
      }
      lastSig = '`';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }
  return out;
}
// Several contract passes lex the same ~1600 sources — cache per source
// string so each file is lexed at most once per mode.
const lexCache = new Map();
function cachedLex(code, keepStrings) {
  let entry = lexCache.get(code);
  if (!entry) { entry = {}; lexCache.set(code, entry); }
  const key = keepStrings ? 'keep' : 'bare';
  if (!(key in entry)) entry[key] = lexBlank(code, { keepStrings });
  return entry[key];
}
// Full blanking (strings + comments gone) — the dynamic scan's view.
const blankCommentsAndStrings = (code) => cachedLex(code, false);
// Comments-only blanking (strings preserved) — the LITERAL scan's view, so
// `db(/* primary table */ 'leads').insert(` reads as an ordinary literal
// insert, and a comment merely SAYING "insert into leads" is not a site.
const blankComments = (code) => cachedLex(code, true);

// ANY table argument, running over BLANKED code: a pure string-literal
// argument blanks to whitespace (skipped — the literal scan owns it), while
// an identifier, member, call (`resolveTable(kind)` — one nesting level),
// conditional, or concatenation survives blanking and is treated as dynamic.
// No top-level comma (a two-argument call is not a knex builder head); two
// nesting levels, matching CHAIN, so `resolveTable(config.get('kind'))`
// reads as one argument.
const DYN_EXPR = String.raw`((?:[^(),]|\((?:[^()]|\([^()]*\))*\))+)`;
const DYNAMIC_INSERT_PATTERNS = [
  new RegExp(String.raw`\b[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(${DYN_EXPR}\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
  new RegExp(String.raw`${TABLE_SEL}\s*\(${DYN_EXPR}\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
  new RegExp(String.raw`\bbatchInsert\s*\(${DYN_EXPR},`, 'g'),
  new RegExp(String.raw`${INSERT_CALL}(?:[^()]|\([^()]*\))*\)${CHAIN}\s*\.into\(${DYN_EXPR}\)`, 'g'),
  new RegExp(String.raw`\.into\(${DYN_EXPR}\)${CHAIN}\s*${INSERT_CALL}`, 'g'),
  new RegExp(String.raw`${INSERT_CALL}(?:[^()]|\([^()]*\))*\)${CHAIN}\s*${TABLE_SEL}\s*\(${DYN_EXPR}\)`, 'g'),
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
    // The declaration must TERMINATE right after the literal — a computed
    // initializer (`const TABLE = 'lead' + suffix`) proves nothing.
    if (!new RegExp(String.raw`^const\s+${escapeRe(root)}\s*=\s*${Q}[\w.]+${Q}\s*;?\s*$`, 'm').test(src)) return false;
    // …and the name must not be REBOUND anywhere else in the file — an
    // indented declaration or a parameter shadowing the module const means
    // the insert may read a different binding, so it stays dynamic.
    const indentedDecl = new RegExp(String.raw`^[\t ]+(?:const|let|var)\s+(?:\{[^{}\n]*)?\b${escapeRe(root)}\b`, 'm');
    const paramBinding = new RegExp(String.raw`[(,]\s*(?:\{[^{}]*)?\b${escapeRe(root)}\b[^()]*\)\s*(?:=>|\{)`);
    const bareArrowParam = new RegExp(String.raw`\b${escapeRe(root)}\s*=>`);
    return !indentedDecl.test(code) && !paramBinding.test(code) && !bareArrowParam.test(code);
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
  // A dynamic-table builder handed to an in-file insertion helper
  // (`writeRow(db(table), row)`) — the dynamic mirror of the helper pass.
  for (const helper of insertingHelperNames(code)) {
    const useRe = new RegExp(String.raw`\b${escapeRe(helper)}\s*\((?:[^()]|\([^()]*\))*?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(${DYN_EXPR}\)`, 'g');
    let use;
    while ((use = useRe.exec(code))) record(use.index, use[0].length, use[1]);
  }
  // Stored builders over a dynamic table — `const target = db(table);
  // await target.insert(row);` — the dynamic mirror of the alias pass.
  const dynDeclRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?(?:${CHAIN}\s*(?:\.\s*(?:table|from)|\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*\(${DYN_EXPR}\)`,
    'g'
  );
  const dynBuilders = new Map(); // name -> table expr
  let decl;
  while ((decl = dynDeclRe.exec(code))) {
    if (!decl[2].trim() || isResolved(decl[2])) continue;
    dynBuilders.set(decl[1], decl[2]);
  }
  // Conditional initializers holding a dynamic builder anywhere.
  const dynCondDeclRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![^;]{0,200}\bawait\b)[^;?]{0,120}\?[^;]{0,160}?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(${DYN_EXPR}\)`,
    'g'
  );
  let cnd;
  while ((cnd = dynCondDeclRe.exec(code))) {
    if (!cnd[2].trim() || isResolved(cnd[2]) || dynBuilders.has(cnd[1])) continue;
    dynBuilders.set(cnd[1], cnd[2]);
  }
  // Builders stored in OBJECT PROPERTIES over a dynamic table —
  // `const queries = { lead: db(table) }; queries.lead.insert(row)`.
  const dynPropDeclRe = new RegExp(
    String.raw`([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(${DYN_EXPR}\)`,
    'g'
  );
  const seenDynProps = new Set();
  let pdd;
  while ((pdd = dynPropDeclRe.exec(code))) {
    if (!pdd[2].trim() || isResolved(pdd[2]) || seenDynProps.has(pdd[1])) continue;
    seenDynProps.add(pdd[1]);
    // Cheap precheck before the heavy use-pattern: the file must even
    // mention `.prop` and an insert call.
    if (!code.includes(`.${pdd[1]}`)) continue;
    const useRe = new RegExp(String.raw`\b[A-Za-z_$][\w$]*\s*(?:\.\s*${escapeRe(pdd[1])}|\[\s*['"\x60]${escapeRe(pdd[1])}['"\x60]\s*\])${CHAIN}\s*${INSERT_CALL}`, 'g');
    let use;
    while ((use = useRe.exec(code))) record(use.index, use[0].length, pdd[2]);
  }
  // Transitive aliases inherit the table expression (in-memory closure
  // over one assignment-pair pass).
  const dynPairs = simpleAssignPairs(code);
  let grewDyn = true;
  while (grewDyn) {
    grewDyn = false;
    for (const [a, b] of dynPairs) {
      if (dynBuilders.has(b) && !dynBuilders.has(a)) { dynBuilders.set(a, dynBuilders.get(b)); grewDyn = true; }
    }
  }
  for (const [n, expr] of dynBuilders) {
    const useRe = new RegExp(String.raw`\b${escapeRe(n)}${CHAIN}\s*${INSERT_CALL}`, 'g');
    let use;
    while ((use = useRe.exec(code))) record(use.index, use[0].length, expr);
  }
  // Arrow FACTORY over a dynamic table — `const q = (t) => db(t); …
  // q(x).insert(row)` — the dynamic mirror of the literal factory pass.
  const dynFactoryRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{(?:[^{}]|\{[^{}]*\})*?\breturn\s+)?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\(${DYN_EXPR}\)`,
    'g'
  );
  let fac;
  while ((fac = dynFactoryRe.exec(code))) {
    if (!fac[2].trim() || isResolved(fac[2])) continue;
    const useRe = new RegExp(String.raw`\b${escapeRe(fac[1])}\s*\([^()]*\)${CHAIN}\s*${INSERT_CALL}`, 'g');
    let use;
    while ((use = useRe.exec(code))) record(use.index, use[0].length, fac[2]);
  }
  // Function/block-arrow factories over a dynamic table, balanced bodies.
  const dynReturnRe = new RegExp(String.raw`\breturn\b[^;]{0,160}?[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?(?:\s*(?:\??\.\s*(?:table|from)|\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*\(${DYN_EXPR}\)`);
  for (const f of balancedBodyFactories(code, dynReturnRe)) {
    if (!f.capture || !f.capture.trim() || isResolved(f.capture)) continue;
    const useRe = new RegExp(String.raw`(?<!function )\b${escapeRe(f.name)}\s*\([^()]*\)${CHAIN}\s*${INSERT_CALL}`, 'g');
    let use;
    while ((use = useRe.exec(code))) record(use.index, use[0].length, f.capture);
  }
  // Raw SQL with a DYNAMIC target — `INSERT INTO ${table}` or
  // `'INSERT INTO ' + table` — scanned on the ORIGINAL source (the SQL text
  // lives in strings blanking removes; blanking is length-preserving, so
  // offsets are interchangeable). Same rule as the knex shapes: resolved
  // only by a SCREAMING_SNAKE module const, else allowlist or reject.
  const RAW_DYNAMIC_RES = [
    // Optional literal schema qualifier and/or identifier quote around the
    // interpolated target — `INSERT INTO public.${table}` and
    // `INSERT INTO "${table}"` are both valid PostgreSQL.
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?(?:["'\x60]?[\w$]+["'\x60]?\s*\.\s*)?["'\x60]?\$\{([^}]+)\}`, 'gi'),
    // Concatenated target — a bare identifier/member OR a parenthesized
    // expression (`'INSERT INTO ' + (kind ? 'leads' : 'audit')`).
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?(?:[\w$]+\.)?['"\x60]\s*\+\s*(\([^()]*\)|[\w$.[\]]+)`, 'gi'),
    // Knex identifier bindings at the table position — positional (??) or
    // named (:table:), with an optional literal schema qualifier
    // (`public.??`) — the bound value is runtime data, so it is dynamic by
    // definition (never resolvable).
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?(?:["'\x60]?[\w$]+["'\x60]?\s*\.\s*)?(\?\?)`, 'gi'),
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?(?:["'\x60]?[\w$]+["'\x60]?\s*\.\s*)?(:[\w$]+:)`, 'gi'),
  ];
  // Comment-blanked but STRING-PRESERVING view (offsets identical): the SQL
  // text lives in strings, but a COMMENT mentioning `INSERT INTO ${table}`
  // is documentation, not a writer.
  const codeStr = blankComments(src);
  for (const re of RAW_DYNAMIC_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(codeStr))) {
      if (!inRawContext(codeStr, m.index)) continue;
      record(m.index, m[0].length, m[1]);
    }
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
  // Comment-normalized, string-preserving view: an inline comment inside a
  // builder call (`db(/* primary table */ 'leads')`) reads as whitespace,
  // and a comment merely SAYING "insert into leads" is not a site.
  const code = blankComments(src);
  const endsByLine = new Map();
  const patterns = [RAW_SQL_INSERT_RE];
  const constOf = new Map();
  for (const { token, name } of leadsTableTokens(code)) {
    const group = [...knexInsertPatterns(token), ...aliasInsertPatterns(code, token)];
    if (name) for (const p of group) constOf.set(p, name);
    patterns.push(...group);
  }
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(code))) {
      if (pattern === RAW_SQL_INSERT_RE && !inRawContext(code, m.index)) continue;
      if (constOf.has(pattern) && !nearestDeclBindsLeads(code, constOf.get(pattern), m.index)) continue;
      const line = code.slice(0, m.index).split('\n').length;
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
    ['callable-factory builder', "await getDb()('leads').insert(row);"],
    ['inline comment in builder call', "await db(/* primary table */ 'leads').insert(row);"],
    ['assigned-later stored builder', "let target;\ntarget = db('leads');\nawait target.insert(row);"],
    ['factory-returned stored builder', "const target = getDb()('leads');\nawait target.insert(row);"],
    ['arrow factory returning the builder', "const baseQuery = () => db('leads');\nawait baseQuery().insert(row);"],
    ['table selected after insert', "await db.insert(row).table('leads');"],
    ['bracket-notation insert', "await db('leads')['insert'](row);"],
    ['raw SQL split at a token boundary', "await db.raw('INSERT ' + 'INTO leads (name) VALUES (?)', [name]);"],
    ['raw SQL with quoted values inside', 'await db.raw("INSERT INTO leads (status) VALUES (\'new\')");'],
    ['named function factory', "function baseQuery() { return db('leads'); }\nawait baseQuery().insert(row);"],
    ['named factory with statements before return', "function baseQuery() { audit(); return db('leads'); }\nawait baseQuery().insert(row);"],
    ['optional-chain insert', "await db('leads')?.insert(row);"],
    ['raw MERGE with insert action', "await db.raw('MERGE INTO leads USING src ON leads.id = src.id WHEN NOT MATCHED THEN INSERT (a) VALUES (src.a)');"],
    ['SQL comment between INSERT and INTO', "await db.raw('INSERT /* audit */ INTO leads (a) VALUES (?)', [a]);"],
    ['stored from-builder', "const target = db.from('leads');\nawait target.insert(row);"],
    ['bracket-accessed table selector', "await db['table']('leads').insert(row);"],
    ['bracket-accessed from selector', "await db['from']('leads').insert(row);"],
    ['factory with a nested block before return', "function baseQuery() { if (audit) { audit(); } return db('leads'); }\nawait baseQuery().insert(row);"],
    ['factory with deep nesting before return', "function baseQuery() { try { if (a) { audit(); } } finally { cleanup(); } return db('leads'); }\nawait baseQuery().insert(row);"],
    ['conditional builder initializer', "const target = useLeads ? db('leads') : db('audit');\nawait target.insert(row);"],
    ['SQL constant passed to raw', "const SQL = 'INSERT INTO leads (a) VALUES (?)';\nawait db.raw(SQL, [a]);"],
    ['multiline SQL constant passed to raw', "const SQL =\n  'INSERT INTO leads (a) VALUES (?)';\nawait db.raw(SQL, [a]);"],
    ['multiline conditional builder', "const target = useLeads\n  ? db('leads')\n  : db('audit');\nawait target.insert(row);"],
    ['class-method factory', "class Queries {\n  base() { return db('leads'); }\n}\nawait queries.base().insert(row);"],
    ['builder stored in an object property', "const queries = { lead: db('leads') };\nawait queries.lead.insert(row);"],
    ['factory returning a table-selected builder', "function baseQuery() { return db.table('leads'); }\nawait baseQuery().insert(row);"],
    ['factory with a conditional return', "function q() { return useLeads ? db('leads') : db('audit'); }\nawait q().insert(row);"],
    ['bracket access to a stored property builder', "const queries = { lead: db('leads') };\nawait queries['lead'].insert(row);"],
    ['builder passed into an in-file insertion helper', "function writeRow(builder, row) { return builder.insert(row); }\nawait writeRow(db('leads'), row);"],
    ['triple-nested chain arguments', "await db('leads').modify(qb => qb.whereIn('id', ids.map(id => normalize(id)))).insert(row);"],
    ['long CTE raw insert', "await db.raw(`WITH src AS (SELECT a FROM staging WHERE flag = true AND note = 'x' AND created_at > now() - interval '7 days' AND a IS NOT NULL AND b IS NOT NULL AND c IS NOT NULL AND d IS NOT NULL AND e IS NOT NULL AND f IS NOT NULL AND g IS NOT NULL AND h IS NOT NULL AND i IS NOT NULL AND j IS NOT NULL) INSERT INTO leads (a) SELECT a FROM src`);"],
    ['SQL line comment between keywords', 'await db.raw(`INSERT -- audit\nINTO leads (a) VALUES (?)`, [a]);'],
    ['block-bodied arrow factory', "const baseQuery = () => { audit(); return db('leads'); };\nawait baseQuery().insert(row);"],
    ['transitive stored-builder alias', "const base = db('leads');\nconst target = base;\nawait target.insert(row);"],
    ['raw SQL behind a leading SQL comment', 'await db.raw("/* audit */ INSERT INTO leads (status) VALUES (\'new\')");'],
    ['nested-paren chain segment', "await db('leads').modify((qb) => qb.where('active', true)).insert(row);"],
    ['doubly nested chain segment', "await db('leads').modify(qb => qb.whereIn('id', ids.map(fn))).insert(row);"],
    ['raw SQL insert with ONLY', "await db.raw('INSERT INTO ONLY leads (name) VALUES (?)', [name]);"],
  ])('detects: %s', (_name, src) => {
    expect(scanSourceForLeadInserts(src).length).toBeGreaterThanOrEqual(1);
  });

  test.each([
    ['awaited read is not a builder alias', "const rows = await db('leads').where({ id });\nrows.insert = noop;"],
    ['read-only query', "const open = await db('leads').where({ status: 'new' }).select('id');"],
    ['insert into another table', "await db('lead_activities').insert({ a: 1 });"],
    ['raw SQL insert into another table', "await db.raw('INSERT INTO lead_activities (a) VALUES (?)', [1]);"],
    ['code-shaped doc string is not a writer', 'const example = "await db(\'leads\').insert(row)";'],
    ['SQL constant never executed is not a writer', "const example = 'INSERT INTO leads (a) VALUES (?)';"],
    ['select-into read is not a writer', "await db.select('*').into('leads');"],
    ['constant bound to another table', "const TABLE = 'lead_activities';\nawait db(TABLE).insert({ a: 1 });"],
    ['builder passed into a read-only helper', "function scoped(qb) { return qb.where('active', true); }\nawait scoped(db('leads'));"],
    ['computed table name is not the constant form', "const t = 'leads' + suffix;\nawait audit(t);"],
    ['update-only MERGE cannot create a lead', "await db.raw('MERGE INTO leads USING src ON leads.id = src.id WHEN MATCHED THEN UPDATE SET a = src.a');"],
    ['update-only MERGE mentioning insert in a value', "await db.raw('MERGE INTO leads USING src ON leads.id = src.id WHEN MATCHED THEN UPDATE SET note = insert_reviewed');"],
  ])('ignores: %s', (_name, src) => {
    expect(found(src)).toEqual([]);
  });

  test('a shadowed table constant binds per nearest declaration, not file-wide', () => {
    const src = "function a() {\n  const TABLE = 'leads';\n  return db(TABLE).insert(lead);\n}\nfunction b() {\n  const TABLE = 'audit';\n  return db(TABLE).insert(entry);\n}";
    expect(found(src)).toEqual(['return db(TABLE).insert(lead);']);
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
    const viaHelper = scanSourceForDynamicTableInserts(
      'function writeRow(builder, row) { return builder.insert(row); }\nawait writeRow(db(table), row);'
    );
    expect(viaHelper).toHaveLength(1);
    expect(viaHelper[0].expr).toBe('table');
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

  test('dynamic-table scan: computed const initializer is not resolution; dynamic raw SQL targets are flagged', () => {
    const computedConst = scanSourceForDynamicTableInserts(
      "const TABLE = 'lead' + suffix;\nawait db(TABLE).insert(row);"
    );
    expect(computedConst).toHaveLength(1);
    const rawTemplate = scanSourceForDynamicTableInserts(
      'await db.raw(`INSERT INTO ${table} (a) VALUES (?)`, [a]);'
    );
    expect(rawTemplate).toHaveLength(1);
    expect(rawTemplate[0].expr).toBe('table');
    const rawConcat = scanSourceForDynamicTableInserts(
      "await db.raw('INSERT INTO ' + table + ' (a) VALUES (?)', [a]);"
    );
    expect(rawConcat).toHaveLength(1);
    const rawBound = scanSourceForDynamicTableInserts(
      "await db.raw('INSERT INTO ?? (a) VALUES (?)', [table, a]);"
    );
    expect(rawBound).toHaveLength(1);
    expect(rawBound[0].expr).toBe('??');
    const rawNamedBound = scanSourceForDynamicTableInserts(
      "await db.raw('INSERT INTO :table: (a) VALUES (:a)', { table, a });"
    );
    expect(rawNamedBound).toHaveLength(1);
    expect(rawNamedBound[0].expr).toBe(':table:');
    const rawSchemaBound = scanSourceForDynamicTableInserts(
      "await db.raw('INSERT INTO public.?? (a) VALUES (?)', [table, a]);"
    );
    expect(rawSchemaBound).toHaveLength(1);
    expect(rawSchemaBound[0].expr).toBe('??');
    const nestedComputed = scanSourceForDynamicTableInserts(
      "await db(resolveTable(config.get('kind'))).insert(row);"
    );
    expect(nestedComputed).toHaveLength(1);
    const quotedRawTemplate = scanSourceForDynamicTableInserts(
      'await db.raw(`INSERT INTO "${table}" (a) VALUES (?)`, [a]);'
    );
    expect(quotedRawTemplate).toHaveLength(1);
    const schemaRawTemplate = scanSourceForDynamicTableInserts(
      'await db.raw(`INSERT INTO public.${table} (a) VALUES (?)`, [a]);'
    );
    expect(schemaRawTemplate).toHaveLength(1);
    const stringWithCommentDelims = scanSourceForDynamicTableInserts(
      "const start = '/*';\nawait db(table).insert(row);\nconst end = '*/';"
    );
    expect(stringWithCommentDelims).toHaveLength(1);
    const factoryDynamic = scanSourceForDynamicTableInserts('await getDb()(table).insert(row);');
    expect(factoryDynamic).toHaveLength(1);
    // A literal raw table with interpolated VALUES stays with the literal scan.
    const rawLiteralTable = scanSourceForDynamicTableInserts(
      'await db.raw(`INSERT INTO other_things (a) VALUES (${a})`);'
    );
    expect(rawLiteralTable).toEqual([]);
  });

  test('dynamic-table scan: a quote inside a regex literal does not derail the lexer; uppercase consts shadowed elsewhere stay dynamic', () => {
    const regexArg = scanSourceForDynamicTableInserts(
      "await db(/'/.test(kind) ? table : fallback).insert(row);"
    );
    expect(regexArg).toHaveLength(1);
    const returnRegex = scanSourceForDynamicTableInserts(
      "function f(kind, table, row) {\n  return /'/.test(kind) ? db(table).insert(row) : null;\n}"
    );
    expect(returnRegex).toHaveLength(1);
    const shadowedUpper = scanSourceForDynamicTableInserts(
      "const TABLE = 'audit';\nasync function f(TABLE, row) {\n  await db(TABLE).insert(row);\n}"
    );
    expect(shadowedUpper).toHaveLength(1);
    const bareArrowShadow = scanSourceForDynamicTableInserts(
      "const TABLE = 'audit';\nconst write = TABLE => db(TABLE).insert(row);"
    );
    expect(bareArrowShadow).toHaveLength(1);
    const parenConcatRaw = scanSourceForDynamicTableInserts(
      "await db.raw('INSERT INTO ' + (kind ? 'lead_things' : 'audit') + ' (a) VALUES (?)', [a]);"
    );
    expect(parenConcatRaw).toHaveLength(1);
    const dynArrowFactory = scanSourceForDynamicTableInserts(
      'const q = (t) => db(t);\nawait q(x).insert(row);'
    );
    expect(dynArrowFactory).toHaveLength(1);
    const bracketDynSelector = scanSourceForDynamicTableInserts("await db['table'](table).insert(row);");
    expect(bracketDynSelector).toHaveLength(1);
    const condDynBuilder = scanSourceForDynamicTableInserts('const target = c ? db(a) : db(b);\nawait target.insert(row);');
    expect(condDynBuilder.length).toBeGreaterThanOrEqual(1);
    const insertThenTable = scanSourceForDynamicTableInserts('await db.insert(row).table(target);');
    expect(insertThenTable).toHaveLength(1);
    const rawCommentSep = scanSourceForDynamicTableInserts(
      "await db.raw('INSERT /* audit */ INTO ' + table + ' (a) VALUES (?)', [a]);"
    );
    expect(rawCommentSep).toHaveLength(1);
    const rawCommentMention = scanSourceForDynamicTableInserts(
      '// legacy shape: INSERT INTO ${table} (a) VALUES (?)\nconst x = 1;'
    );
    expect(rawCommentMention).toEqual([]);
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
    // And two dynamic sites may not share one key at all — a second insert
    // with an identical trimmed line + expression elsewhere in the file
    // would silently ride the first site's allowlist entry.
    const dynKeys = dynamic.map(key);
    expect(dynKeys.filter((k, i) => dynKeys.indexOf(k) !== i)).toEqual([]);
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

  test("dynamic-table helpers: every allowlist entry declares a caller contract, and every CALLER satisfies it (the never-leads reason isn't just prose)", () => {
    const files = walk(SERVER_ROOT).map((abs) => ({
      rel: path.relative(SERVER_ROOT, abs).split(path.sep).join('/'),
      src: fs.readFileSync(abs, 'utf8'),
    }));
    const leadsShaped = (t) => /^(?:[\w$]+\.)?leads$/i.test(t);
    const assertNotLeads = (where, t) => {
      expect({ where, table: t, leads: leadsShaped(t) }).toEqual({ where, table: t, leads: false });
    };

    for (const w of DYNAMIC_TABLE_INSERTS) {
      const cc = w.callerContract;
      // A new dynamic helper cannot ride in on prose alone — it must declare
      // a contract of a kind this test knows how to enforce.
      expect({ site: key(w), kind: cc && cc.kind }).toEqual({ site: key(w), kind: expect.any(String) });

      if (cc.kind === 'config-literals') {
        // Scoped to the DECLARED config object (balanced-brace extraction),
        // where every listed prop must be a direct literal assignment.
        // Spreads (`...runtimeConfig`), object SHORTHAND, and QUOTED or
        // COMPUTED keys are rejected outright — each would source a table
        // from runtime past this matcher.
        const src = files.find((f) => f.rel === w.file).src;
        const code = blankComments(src);
        const bare = blankCommentsAndStrings(src); // same offsets, strings gone
        const declMatch = code.match(new RegExp(String.raw`\bconst\s+${escapeRe(cc.object)}\s*=\s*\{`));
        // A let/var binding could be REBOUND wholesale (TYPES = req.body).
        const rebindable = bare.match(new RegExp(String.raw`\b(?:let|var)\s+${escapeRe(cc.object)}\b`));
        expect({ file: w.file, rebindableDecl: rebindable && rebindable[0] })
          .toEqual({ file: w.file, rebindableDecl: null });
        expect({ file: w.file, object: cc.object, found: Boolean(declMatch) })
          .toEqual({ file: w.file, object: cc.object, found: true });
        const openIdx = code.indexOf('{', declMatch.index);
        let depth = 0;
        let end = openIdx;
        for (; end < code.length; end += 1) {
          if (bare[end] === '{') depth += 1;
          else if (bare[end] === '}') { depth -= 1; if (depth === 0) break; }
        }
        const objText = code.slice(openIdx, end + 1);
        const objBare = bare.slice(openIdx, end + 1);
        // The config must stay IMMUTABLE after declaration — a later
        // property write (TYPES.lawn.table = x) or Object.assign /
        // defineProperty over it would feed the insert a runtime table.
        const mutationReFor = (name) => new RegExp(
          String.raw`\b${escapeRe(name)}\b\s*(?:\.[\w$]+|\[[^\]]*\])+\s*=[^=]|Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\([^)]*\b${escapeRe(name)}\b`
        );
        const mutation = bare.match(mutationReFor(cc.object));
        expect({ file: w.file, mutation: mutation && mutation[0].trim() })
          .toEqual({ file: w.file, mutation: null });
        // Mutations THROUGH aliases too — followed TRANSITIVELY to a
        // fixpoint: `const cfg = TYPES.lawn; const alias = cfg;
        // alias.table = x` is caught because `alias` inherits governed
        // status from `cfg`, which inherits it from the object.
        const governed = new Set([cc.object]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const name of [...governed]) {
            const aliasRe = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${escapeRe(name)}\b`, 'g');
            let al;
            while ((al = aliasRe.exec(bare))) {
              if (!governed.has(al[1])) { governed.add(al[1]); grew = true; }
            }
            // DESTRUCTURED bindings from a governed name are governed too:
            // `const { lawn: config } = TYPES` binds `config`.
            const destrRe = new RegExp(String.raw`\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*${escapeRe(name)}\b`, 'g');
            let de;
            while ((de = destrRe.exec(bare))) {
              for (const part of de[1].split(',')) {
                const bound = part.includes(':') ? part.split(':')[1] : part;
                const id = bound.trim().split(/[=\s]/)[0];
                if (/^[A-Za-z_$][\w$]*$/.test(id) && !governed.has(id)) { governed.add(id); grew = true; }
              }
            }
          }
        }
        for (const name of governed) {
          if (name === cc.object) continue; // checked above
          const aliasMutation = bare.match(mutationReFor(name));
          expect({ file: w.file, alias: name, mutation: aliasMutation && aliasMutation[0].trim() })
            .toEqual({ file: w.file, alias: name, mutation: null });
          // A let/var alias could be REBOUND wholesale (config = req.body).
          const rb = bare.match(new RegExp(String.raw`\b(?:let|var)\s+${escapeRe(name)}\b`));
          expect({ file: w.file, alias: name, rebindableDecl: rb && rb[0] })
            .toEqual({ file: w.file, alias: name, rebindableDecl: null });
        }
        expect({ file: w.file, spreads: (objBare.match(/\.\.\./g) || []).length })
          .toEqual({ file: w.file, spreads: 0 });
        // EVERY top-level entry must be an OBJECT LITERAL declaring each
        // governed prop as a literal — `extra: runtimeConfig` (nothing to
        // inspect) or an entry missing a governed prop fails.
        const inner = objBare.slice(1, -1);
        const innerText = objText.slice(1, -1);
        let dEnt = 0;
        let segStart = 0;
        const entries = [];
        for (let k = 0; k <= inner.length; k += 1) {
          const chS = inner[k];
          if (chS === '{' || chS === '(' || chS === '[') dEnt += 1;
          else if (chS === '}' || chS === ')' || chS === ']') dEnt -= 1;
          else if ((chS === ',' && dEnt === 0) || k === inner.length) {
            if (inner.slice(segStart, k).trim()) entries.push({ segS: inner.slice(segStart, k), segT: innerText.slice(segStart, k) });
            segStart = k + 1;
          }
        }
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const propAlt = cc.props.map(escapeRe).join('|');
        for (const { segS, segT } of entries) {
          const label = segT.trim().slice(0, 40);
          expect({ file: w.file, entry: label, objectLiteral: /^\s*[\w$]+\s*:\s*\{/.test(segS) })
            .toEqual({ file: w.file, entry: label, objectLiteral: true });
          // Accessors could compute a governed prop at read time.
          const getter = segS.match(new RegExp(String.raw`\b(?:get|set)\s+(?:${propAlt})\b`));
          expect({ file: w.file, entry: label, accessor: getter && getter[0] })
            .toEqual({ file: w.file, entry: label, accessor: null });
          // Governed props must be DIRECT TOP-LEVEL data properties of the
          // entry — a literal nested in a sub-object is not what
          // config.table reads. Depth-1 blanking of the entry's object.
          const bIdx = segS.indexOf('{');
          let dT = 0;
          let topT = '';
          for (let k2 = bIdx; k2 < segS.length; k2 += 1) {
            const st = segS[k2];
            const chT = segT[k2];
            if (st === '{') { dT += 1; topT += dT === 1 ? chT : ' '; continue; }
            if (st === '}') { dT -= 1; topT += dT === 0 ? chT : ' '; continue; }
            topT += dT === 1 ? chT : ' ';
          }
          for (const p of cc.props) {
            const literal = new RegExp(String.raw`\b${escapeRe(p)}\s*:\s*'[\w.]+'`).test(topT);
            expect({ file: w.file, entry: label, prop: p, topLevelLiteral: literal })
              .toEqual({ file: w.file, entry: label, prop: p, topLevelLiteral: true });
          }
        }
        const shorthand = [...objBare.matchAll(new RegExp(String.raw`[{,]\s*(?:${propAlt})\s*(?=[,}])`, 'g'))];
        expect(shorthand.map((s) => s[0].trim())).toEqual([]);
        const noncanonical = [...objText.matchAll(new RegExp(String.raw`(?:["'\x60](?:${propAlt})["'\x60]\s*:|\[\s*["'\x60](?:${propAlt})["'\x60]\s*\])`, 'g'))];
        expect(noncanonical.map((s) => s[0])).toEqual([]);
        // ANY computed key inside the governed object ([key]: …) can
        // resolve to a governed prop at runtime — rejected outright.
        const computedCfgKey = objBare.match(/\[[^\]\n]*\]\s*:/);
        expect({ file: w.file, computedKey: computedCfgKey && computedCfgKey[0] })
          .toEqual({ file: w.file, computedKey: null });
        const assignments = [...objText.matchAll(new RegExp(String.raw`\b(?:${propAlt})\s*:\s*('[\w.]+'|[^,}\n]+)`, 'g'))];
        const literals = [];
        for (const a of assignments) {
          const v = a[1].trim();
          const lit = v.match(/^'([\w.]+)'$/);
          expect({ file: w.file, assignment: a[0].trim(), literal: Boolean(lit) })
            .toEqual({ file: w.file, assignment: a[0].trim(), literal: true });
          literals.push(lit[1]);
          assertNotLeads(`${w.file} config`, lit[1]);
        }
        expect(literals.length).toBeGreaterThanOrEqual(cc.minValues);
      } else if (cc.kind === 'positional-call') {
        // In-file helper: EVERY invocation is enumerated, and its arguments
        // are split by balanced-paren depth — a computed earlier argument
        // (upsertChunked(getTrx(), …)) cannot hide the call. The table
        // argument must be a LITERAL non-leads table.
        // Locate calls on FULLY blanked code (comments/strings are not
        // invocations); read arguments from the string-preserving view.
        const fileSrc = files.find((f) => f.rel === w.file).src;
        const bareCode = blankCommentsAndStrings(fileSrc);
        const code = blankComments(fileSrc);
        const re = new RegExp(String.raw`(?<!function )\b${escapeRe(cc.helper)}\s*\(`, 'g');
        let m;
        let callCount = 0;
        while ((m = re.exec(bareCode))) {
          callCount += 1;
          const args = [];
          let depth = 1;
          let start = re.lastIndex;
          for (let j = re.lastIndex; j < code.length && depth > 0; j += 1) {
            const ch = code[j];
            if (ch === '(') depth += 1;
            else if (ch === ')') { depth -= 1; if (depth === 0) args.push(code.slice(start, j)); }
            else if (ch === ',' && depth === 1) { args.push(code.slice(start, j)); start = j + 1; }
          }
          const t = (args[cc.argIndex] || '').trim();
          const lit = t.match(/^'([\w.]+)'$/);
          expect({ call: `${w.file}@${m.index}`, arg: t, literal: Boolean(lit) })
            .toEqual({ call: `${w.file}@${m.index}`, arg: t, literal: true });
          assertNotLeads(`${w.file} ${cc.helper}`, lit[1]);
        }
        expect(callCount).toBeGreaterThanOrEqual(cc.minCallers);
        // Aliasing the in-file helper (const upsert = upsertChunked) would
        // route calls around the name-based enumeration — a bare (non-call)
        // reference in live code is rejected. Module-internal, so there is
        // no require/exports exception.
        const bareFile = blankCommentsAndStrings(files.find((f) => f.rel === w.file).src);
        // Literal bracket access hides the helper name in a string.
        const bracketRef = blankComments(fileSrc).match(new RegExp(String.raw`\[\s*['"\x60]${escapeRe(cc.helper)}['"\x60]\s*\]`));
        expect({ file: w.file, bracketAccess: bracketRef && bracketRef[0] })
          .toEqual({ file: w.file, bracketAccess: null });
        const refRe2 = new RegExp(String.raw`\b${escapeRe(cc.helper)}\b(?!\s*\()`, 'g');
        let r2;
        while ((r2 = refRe2.exec(bareFile))) {
          const ls = bareFile.lastIndexOf('\n', r2.index) + 1;
          const le = bareFile.indexOf('\n', r2.index);
          const lt = bareFile.slice(ls, le === -1 ? bareFile.length : le).trim();
          expect({ ref: `${w.file}: ${lt}`, aliased: true }).toEqual({ ref: `${w.file}: ${lt}`, aliased: false });
        }
      } else if (cc.kind === 'object-call') {
        // Exported helper: EVERY invocation anywhere under server/ — not
        // just object-literal ones — is enumerated. A call passing a
        // variable (`storeFunnelPhotos(opts)`) is unresolvable and fails
        // outright; an object-literal call must bind the prop to a literal
        // (or the declared indirect expression, whose own values another
        // entry's contract validates).
        let callers = 0;
        for (const { rel, src } of files) {
          // Locate calls on FULLY blanked code (a comment or log string
          // saying "storeFunnelPhotos(opts)" is not an invocation); read
          // the argument from the string-preserving view at the same
          // offsets (the binding values are string literals).
          const bareSrc = blankCommentsAndStrings(src);
          const codeSrc = blankComments(src);
          const re = new RegExp(String.raw`(?<!function )\b${escapeRe(cc.helper)}\s*\(`, 'g');
          let m;
          while ((m = re.exec(bareSrc))) {
            callers += 1;
            // STRUCTURE (braces, boundaries) reads from the fully blanked
            // view — a '}' inside a string value must not close the object;
            // CONTENT (binding values) reads from the string-preserving
            // view. The walk runs to the BALANCED closing brace with no
            // size cap, so a long argument cannot hide a late override
            // beyond a window.
            let openAbs = re.lastIndex;
            while (openAbs < bareSrc.length && /\s/.test(bareSrc[openAbs])) openAbs += 1;
            const objectLiteral = bareSrc[openAbs] === '{';
            expect({ caller: `${rel}@${m.index}`, objectLiteral })
              .toEqual({ caller: `${rel}@${m.index}`, objectLiteral: true });
            let depth = 0;
            let endAbs = openAbs;
            for (; endAbs < bareSrc.length; endAbs += 1) {
              if (bareSrc[endAbs] === '{') depth += 1;
              else if (bareSrc[endAbs] === '}') { depth -= 1; if (depth === 0) break; }
            }
            const after = codeSrc.slice(openAbs, endAbs + 1);
            const afterBare = bareSrc.slice(openAbs, endAbs + 1);
            const openIdx = 0;
            const end = afterBare.length - 1;
            // Only TOP-LEVEL properties of the call's object count — a
            // matching prop nested one level down ({ options: { table: … } })
            // is not the binding the helper reads. Nested braces blank out.
            let d2 = 0;
            let top = '';
            for (let k = openIdx; k <= end; k += 1) {
              const struct = afterBare[k];
              const ch = after[k];
              if (struct === '{') { d2 += 1; top += d2 === 1 ? ch : ' '; continue; }
              if (struct === '}') { d2 -= 1; top += d2 === 0 ? ch : ' '; continue; }
              top += d2 === 1 ? ch : ' ';
            }
            // A top-level spread could overwrite the binding after the
            // fact, and a duplicate binding means the LAST one wins — both
            // make the matched value unreliable, so both are rejected.
            expect({ caller: `${rel}@${m.index}`, topSpreads: (top.match(/\.\.\./g) || []).length })
              .toEqual({ caller: `${rel}@${m.index}`, topSpreads: 0 });
            const bindCount = (top.match(new RegExp(String.raw`\b${escapeRe(cc.prop)}\s*:`, 'g')) || []).length;
            expect({ caller: `${rel}@${m.index}`, bindCount }).toEqual({ caller: `${rel}@${m.index}`, bindCount: 1 });
            // A quoted or computed spelling of the key (["'\x60]table["'\x60]
            // or ['table']:) is a duplicate the count above can't see — the
            // later property wins at runtime, so any such form fails.
            const sneakyKey = top.match(new RegExp(String.raw`["'\x60]${escapeRe(cc.prop)}["'\x60]\s*[:\]]`));
            expect({ caller: `${rel}@${m.index}`, sneakyKey: sneakyKey && sneakyKey[0] })
              .toEqual({ caller: `${rel}@${m.index}`, sneakyKey: null });
            // ANY computed property key at the top level ([key]: …) can
            // resolve to the protected prop at runtime — rejected outright.
            const computedKey = top.match(/\[[^\]]*\]\s*:/);
            expect({ caller: `${rel}@${m.index}`, computedKey: computedKey && computedKey[0] })
              .toEqual({ caller: `${rel}@${m.index}`, computedKey: null });
            // The COMPLETE value must be the literal or the indirect
            // expression — a delimiter must follow, so `'lead' + 's'` and
            // `config.photoTableSuffix` don't pass on a prefix. The
            // indirect expression is accepted ONLY in its declared file
            // (indirectFile) — the config-literals contract validates that
            // file's config; any other caller's `config` is unproven and
            // must use a literal.
            const indirectOk = cc.allowIndirect && rel === cc.indirectFile;
            const bindRe = new RegExp(
              String.raw`\b${escapeRe(cc.prop)}\s*:\s*(?:'([\w.]+)'${indirectOk ? `|${escapeRe(cc.allowIndirect)}\\b` : ''})\s*(?=[,}\n])`
            );
            const bound = top.match(bindRe);
            expect({ caller: `${rel}@${m.index}`, bound: Boolean(bound) })
              .toEqual({ caller: `${rel}@${m.index}`, bound: true });
            if (bound[1]) assertNotLeads(rel, bound[1]);
          }
        }
        expect(callers).toBeGreaterThanOrEqual(cc.minCallers);
        // LITERAL BRACKET ACCESS to the governed export —
        // require('…')['storeFunnelPhotos'](…) — hides the name inside a
        // string, invisible to the call scan; rejected wherever it appears
        // (scanned on the string-preserving view).
        for (const { rel, src } of files) {
          const bracket = blankComments(src).match(new RegExp(String.raw`\[\s*['"\x60]${escapeRe(cc.helper)}['"\x60]\s*\]`));
          expect({ file: rel, bracketAccess: bracket && bracket[0] })
            .toEqual({ file: rel, bracketAccess: null });
        }
        // Aliasing the helper (const savePhotos = storeFunnelPhotos) would
        // route calls around this name-based scan — every bare (non-call)
        // reference in live code is rejected, except require /
        // module.exports destructuring lines. Runs on fully blanked code so
        // string mentions (e.g. the registry's own config) don't count.
        for (const { rel, src } of files) {
          const code = blankCommentsAndStrings(src);
          const refRe = new RegExp(String.raw`\b${escapeRe(cc.helper)}\b(?!\s*\()`, 'g');
          let r;
          while ((r = refRe.exec(code))) {
            const lineStart = code.lastIndexOf('\n', r.index) + 1;
            const lineEnd = code.indexOf('\n', r.index);
            const lineText = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);
            // require / module.exports lines are allowed ONLY in canonical
            // shorthand form: a rename (`{ helper: alias }` / `{ alias:
            // helper }`) or a property-access pull-out
            // (`require(...).helper`) re-routes calls around the name scan
            // and is rejected.
            const renamed = new RegExp(String.raw`\b${escapeRe(cc.helper)}\s*:|:\s*${escapeRe(cc.helper)}\b`).test(lineText);
            const propertyAccess = code[r.index - 1] === '.';
            const allowed = /\brequire\s*\(|\bmodule\.exports\b/.test(lineText) && !renamed && !propertyAccess;
            expect({ ref: `${rel}: ${lineText.trim()}`, allowed })
              .toEqual({ ref: `${rel}: ${lineText.trim()}`, allowed: true });
          }
        }
      } else {
        // Unknown kind — extend this test before inventing one.
        expect({ site: key(w), kind: cc.kind, supported: false }).toEqual({ site: key(w), kind: cc.kind, supported: true });
      }
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
    // The anchor line ITSELF being a function header with a SAME-LINE body
    // — an arrow one-liner (`const mint = () => db('leads').insert(row)`)
    // or a one-line method (`mint() { return db('leads').insert(row); }`) —
    // means the function IS that line: the span must not expand to siblings.
    if (FUNCTION_HEADER_RE.test(lines[idx]) && !/\{\s*$/.test(lines[idx])) {
      return lines[idx];
    }
    if (/^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b)[\w$]+\s*\([^()]*\)\s*\{.*\}\s*[,;]?\s*$/.test(lines[idx])) {
      return lines[idx];
    }
    let threshold = indentOf(lines[idx]);
    let start = 0;
    for (let i = idx - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      const ind = indentOf(l);
      if (ind >= threshold) continue;
      threshold = ind;
      // A block-opening continuation line (`) {`, `}) {`) is a MULTILINE
      // signature's closer: start the span there, so a nested function with
      // a multiline header keeps its own scope instead of expanding to the
      // outer function. `} else {` / `} catch {` continue the SAME scope and
      // are not headers.
      const isSignatureCloser = /^[)\]}].*\{\s*$/.test(l.trim())
        && !/\b(?:else|catch|finally)\b/.test(l.trim());
      if (FUNCTION_HEADER_RE.test(l) || isSignatureCloser || ind === 0) { start = i; break; }
    }
    const startIndent = indentOf(lines[start]);
    let end = lines.length - 1;
    for (let j = idx + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t && indentOf(lines[j]) <= startIndent && /^[}\])]/.test(t)) { end = j; break; }
    }
    return lines.slice(start, end + 1).join('\n');
  }

  // Resolver evidence runs on blankCommentsAndStrings output — `// TODO: use
  // findReusableCallLead` or a log string is not evidence; only an
  // identifier in live code (template substitutions included) counts. The
  // evidence bar stays "identifier appears in code", not "call expression" —
  // two registered resolvers (dedupEmail, nameConflicts) are variables
  // driving inline lookups, not callables.
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
      // Only the part of the function UP TO AND INCLUDING the insert line
      // counts: identity resolution precedes the write it governs, so a
      // resolver first named after the insert (a diagnostic, an unreachable
      // mention) is not evidence for this site.
      const spanLines = enclosingFunctionSpan(lines, anchorIdx).split('\n');
      const anchorInSpan = spanLines.findIndex((l) => l.trim() === w.anchor);
      const span = blankCommentsAndStrings(spanLines.slice(0, anchorInSpan + 1).join('\n'));
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
