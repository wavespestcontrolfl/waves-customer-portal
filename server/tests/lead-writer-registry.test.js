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
const os = require('os');
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
// The chain AFTER a builder head (`db('leads').modify(qb => …).insert(row)`)
// is walked procedurally by walkChain — balanced parens at ANY depth, so no
// nesting cap. This bounded fragment remains only for the short SELECTOR
// chain between a knex root and its table selector (`db.withSchema('public')
// .transacting(trx).table('leads')`), whose arguments are identifiers and
// literals; three nesting levels there are ample.
const SEL_CHAIN = String.raw`(?:\s*\??\.\s*(?!insert\b)[\w$]+\s*\((?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\))*`;
const Q = '[\'"`]'; // quote class incl. backtick

// Walk a METHOD CHAIN on the blanked view from `pos` (just past a head):
// `.name(args)`, `?.name(args)`, `['name'](args)`, optional `?.(` calls and
// bare property hops (`queries.lead.insert`), skipping every call's
// arguments to their BALANCED close paren, until a call whose method name is
// in `stops`. Returns { name, open } (open = index of that call's `(`) or
// null when the chain ends first.
const INSERT_STOP = new Set(['insert']);
const TABLE_STOPS = new Set(['into', 'table', 'from']);
// A head walk stops at EITHER: reaching a table selector first means a later
// call re-targets the builder (`db.withSchema(schema).table(table).insert`)
// and that selector's own head is the site, not this one.
const HEAD_STOPS = new Set([...INSERT_STOP, ...TABLE_STOPS]);
function walkChain(bare, pos, stops) {
  let k = pos;
  const ws = () => { while (k < bare.length && /\s/.test(bare[k])) k += 1; };
  for (;;) {
    ws();
    if (bare.startsWith('?.', k)) k += 2;
    else if (bare[k] === '.') k += 1;
    else if (bare[k] !== '[') return null;
    ws();
    let name;
    if (bare[k] === '[') {
      const m = /^\[\s*['"\x60]([A-Za-z_$][\w$]*)['"\x60]\s*\]/.exec(bare.slice(k, k + 120));
      if (!m) return null;
      name = m[1]; k += m[0].length;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(bare.slice(k, k + 120));
      if (!m) return null;
      name = m[0]; k += m[0].length;
    }
    ws();
    if (bare.startsWith('?.', k)) { k += 2; ws(); }
    if (bare[k] !== '(') continue; // property hop
    if (stops.has(name)) return { name, open: k };
    k = afterBalanced(bare, k);
    if (k === -1) return null;
  }
}
// Index just past the `)` matching the `(` at `open`, or -1.
function afterBalanced(bare, open) {
  let depth = 0;
  for (let k = open; k < bare.length; k += 1) {
    if (bare[k] === '(') depth += 1;
    else if (bare[k] === ')') { depth -= 1; if (depth === 0) return k + 1; }
  }
  return -1;
}
// The bare-identifier RECEIVER at the root of a chain whose insert selector
// starts at `selIdx` (`builder.where(x).insert(` → builder; `db('leads')
// .insert(` → db), walking BACKWARD over balanced argument lists, selectors
// and property hops; null when the root is not a plain identifier.
function chainReceiver(bare, selIdx) {
  let k = selIdx - 1;
  let afterArgs = false; // the token before us is an argument list we skipped
  const wsb = () => { while (k >= 0 && /\s/.test(bare[k])) k -= 1; };
  for (;;) {
    wsb();
    if (k < 0) return null;
    if (bare[k] === ')') {
      let depth = 0;
      for (; k >= 0; k -= 1) {
        if (bare[k] === ')') depth += 1;
        else if (bare[k] === '(') { depth -= 1; if (depth === 0) { k -= 1; break; } }
      }
      wsb();
      if (k >= 1 && bare[k] === '.' && bare[k - 1] === '?') { k -= 2; wsb(); } // `?.(`
      afterArgs = true;
      continue;
    }
    if (bare[k] === ']') {
      const open = bare.lastIndexOf('[', k);
      if (open === -1) return null;
      k = open - 1; wsb();
      if (k >= 1 && bare[k] === '.' && bare[k - 1] === '?') k -= 2;
      continue;
    }
    const e = k;
    while (k >= 0 && /[\w$]/.test(bare[k])) k -= 1;
    if (e === k) return null;
    const ident = bare.slice(k + 1, e + 1);
    wsb();
    if (bare[k] === '.') { k -= 1; if (k >= 0 && bare[k] === '?') k -= 1; afterArgs = false; continue; } // a method/property name — keep walking
    // A root identifier that is itself CALLED (`db('leads').insert(…)`) is a
    // knex instance receiving a table, not a builder parameter.
    if (afterArgs) return null;
    return /^[A-Za-z_$]/.test(ident) ? ident : null;
  }
}
const chainHead = (re) => Object.assign(re, { chain: true });

// Split `text` on top-level commas (not inside (), [] or {}).
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, k)); start = k + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}
// Binding names in a parameter list — bare, defaulted, rest, and the
// bindings inside DESTRUCTURED patterns (`{ qb, x: y = 1 }`, `[a, b]`).
function paramNames(list) {
  const names = [];
  const walk = (text) => {
    for (const part of splitTopLevel(text)) {
      const q = part.trim().replace(/^\.\.\./, '');
      if (!q) continue;
      if (q[0] === '{' || q[0] === '[') {
        const close = q.lastIndexOf(q[0] === '{' ? '}' : ']');
        walk(q.slice(1, close === -1 ? undefined : close));
        continue;
      }
      const keyed = q.match(/^[A-Za-z_$][\w$]*\s*:\s*([\s\S]*)$/);
      if (keyed) { walk(keyed[1]); continue; }
      const id = q.split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.push(id);
    }
  };
  walk(list);
  return names;
}
// `.insert(` in either spelling — dot access or literal bracket access
// (`db('leads')['insert'](row)`).
const INSERT_CALL = String.raw`(?:\??\.\s*insert|(?:\?\.)?\[\s*['"\x60]insert['"\x60]\s*\])\s*(?:\?\.\s*)?\(`;
// `.table(` / `.from(` in either spelling too — `db['table']('leads')`.
const TABLE_SEL = String.raw`(?:\??\.\s*table|(?:\?\.)?\[\s*['"\x60]table['"\x60]\s*\])`;
const FROM_SEL = String.raw`(?:\??\.\s*from|\bfrom|(?:\?\.)?\[\s*['"\x60]from['"\x60]\s*\])`;
// Optional schema qualifier INSIDE the literal too — knex accepts
// `db('public.leads')` as a schema-qualified table name.
// Optional schema prefix (`public.leads`) and Knex table alias suffix
// (`leads as l`) around the exact table name.
// The schema and alias around the exact `leads` component may carry any
// punctuation PostgreSQL identifiers allow (`tenant-one.leads`, `leads as
// lead-row`).
const LITERAL_LEADS = String.raw`${Q}(?:[^'"\x60.\s]+\.)?leads(?:\s+[aA][sS]\s+[^'"\x60\s]+)?${Q}`;
const isLeadsTable = (value) => /^(?:[^.\s]+\.)?leads(?:\s+as\s+\S+)?$/i.test(value.trim());
// Knex's optional second TABLE-OPTIONS argument — `db('leads', { only:
// true })`, or a stored `opts` / `config.tableOpts` — after a table token.
// (The dynamic pass parses the argument list structurally: tableArg.)
const TABLE_OPTS = String.raw`\s*(?:,\s*(?:\{[^{}]*\}|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*)?`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The knex builder shapes, built for a given "table token": the quoted
// literal, or an identifier a constant-resolution pass found bound to the
// string 'leads' in the same file (the repo's `const TABLE = 'leads';
// await db(TABLE).insert(` pattern — cf. services/local-news-store.js).
function knexInsertPatterns(token) {
  return [
    // Optional factory call between the identifier and the table argument —
    // the `getDb()('leads')` callable-factory style (routes/knowledge.js).
    chainHead(new RegExp(String.raw`\b[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`, 'g')),
    // `.table(X)` with ANY prefix — `db.table(...)`, `db.withSchema('public').table(...)`.
    chainHead(new RegExp(String.raw`${TABLE_SEL}\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`, 'g')),
    // `.into` only AS PART OF an insert chain — `db.select('*').into(x)`
    // reads, it doesn't create. (Insert-FIRST forms, `insert(payload)
    // .into(x)`, are walked by insertFirstMatches below.)
    chainHead(new RegExp(String.raw`\.into(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`, 'g')),
    new RegExp(String.raw`\binsert\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`, 'g'),
    new RegExp(String.raw`\bbatchInsert\s*\(\s*${token}`, 'g'),
    chainHead(new RegExp(String.raw`${FROM_SEL}\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`, 'g')),
  ];
}

// Insert-FIRST forms — `db.insert(payload).into('leads')`, `.insert(payload)
// .table('leads')`: the payload is walked to its BALANCED close paren on
// the string-blanked view (any nesting depth), the chain after it walked
// to the table selector (into/table/from), and that selector's argument
// matched by the STICKY `argRe` (capture 1 = the table token), or parsed by
// tableArg when `argRe` is null (the dynamic pass).
// Reported spans start at the insert call, like the regex forms.
function insertFirstMatches(code, argRe) {
  const bare = blankCommentsAndStrings(code);
  const out = [];
  const headRe = new RegExp(INSERT_CALL, 'g');
  let h;
  while ((h = headRe.exec(bare))) {
    let depth = 1;
    let k = headRe.lastIndex;
    for (; k < bare.length && depth > 0; k += 1) {
      if (bare[k] === '(') depth += 1;
      else if (bare[k] === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    const sel = walkChain(bare, k, TABLE_STOPS);
    if (!sel) continue;
    if (argRe) {
      argRe.lastIndex = sel.open + 1;
      const t = argRe.exec(code);
      if (t) out.push({ index: h.index, length: (sel.open + 1 - h.index) + t[0].length, capture: t[1] });
    } else {
      const arg = tableArg(code, sel.open);
      if (arg) out.push({ index: h.index, length: arg.end - h.index, capture: arg.expr });
    }
  }
  return out;
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
// …and the JavaScript ESCAPES for whitespace (`'INSERT\\nINTO leads'` is
// whitespace at runtime).
const RAW_SEP = String.raw`(?:\s*${Q}\s*\+\s*${Q}\s*|\s*\/\*[\s\S]*?\*\/\s*|\s*--[^\n]*(?:\n|\\n)\s*|(?:\s|\\[ntr])+)`;
// Optional schema qualifier: a bare or quoted identifier — a DOUBLE-quoted
// one may hold any punctuation PostgreSQL allows ("tenant-one"."leads").
const SQL_SCHEMA = String.raw`(?:(?:"[^"\n]+"|${Q}?[\w$]+${Q}?)\s*\.\s*)?`;
const RAW_SQL_INSERT_RE = new RegExp(
  String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?${SQL_SCHEMA}${Q}?leads\b`,
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
  // Each pair carries the DECLARATION index (keyword start) when the
  // alias is declared, so scope-aware consumers can bind it lexically.
  const re = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;,)\n]/g;
  let m;
  while ((m = re.exec(src))) pairs.push([m[1], m[2], /^(?:const|let|var)\b/.test(m[0]) ? m.index : null]);
  assignPairsCache.set(src, pairs);
  return pairs;
}

// A raw-SQL match counts only in an EXECUTABLE raw-query context: a `raw(`
// opener shortly before the match, OR the SQL stored in a constant that is
// later PASSED to raw (`const SQL = 'INSERT …'; db.raw(SQL)`). A doc
// constant never handed to raw is ignored.
// The executable-SQL CALLEE exactly — knex `.raw(` / `?.raw(` / `['raw'](`
// / a bare destructured `raw(`, or a native pg `.query(` (`client.query`,
// `pool.query`) — never a substring (`draw(`, `withdraw(`).
const RAW_CALLEE = String.raw`(?:\??\.\s*(?:raw|query)|(?:\?\.)?\[\s*['"\x60](?:raw|query)['"\x60]\s*\]|(?<![.\w$])raw)\s*(?:\?\.\s*)?\(`;
// The FUNCTION that produces the SQL literal at `idx`: the innermost
// function whose body RETURNS it, or the expression-bodied arrow it is the
// value of (`const buildInsert = (t) => \`INSERT INTO …\``). Null when the
// literal is not a function's product.
function sqlProducer(code, bare, idx) {
  let j = idx;
  while (j > 0 && (bare[j - 1] === ' ' || bare[j - 1] === '\n' || code[j - 1] === '+')) j -= 1;
  const lead = code.slice(Math.max(0, j - 200), j);
  const arrow = lead.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*)?$/);
  if (arrow) return arrow[1];
  let depth = 0;
  let b = j - 1;
  for (; b >= 0; b -= 1) {
    const ch = bare[b];
    if (ch === ')' || ch === ']') depth += 1;
    else if (ch === '(' || ch === '[') depth -= 1;
    else if ((ch === ';' || ch === '{' || ch === '}') && depth <= 0) break;
  }
  if (!/^\s*return\b/.test(code.slice(b + 1, j))) return null;
  let best = null;
  for (const f of balancedFunctionBodies(code)) if (f.start <= idx && idx < f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
  return best ? best.name : null;
}

// The declaration that holds the SQL literal at `idx`: `{ name, member }`,
// where `member` is the regex tail required after the name at the callee
// (empty for a plain constant; the property access for SQL held in an
// object property, or optionally the whole object for pg's `text` key), or
// null when the literal is not stored in a declaration.
function sqlDeclaration(code, idx) {
  const bare = blankCommentsAndStrings(code);
  let j = idx;
  while (j > 0 && (bare[j - 1] === ' ' || bare[j - 1] === '\n' || code[j - 1] === '+')) j -= 1;
  const lead = code.slice(Math.max(0, j - 200), j);
  // An optional TEMPLATE TAG (`String.raw`, `sql`) may sit between `=` and
  // the literal.
  const decl = lead.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*)?$/);
  if (decl) return { name: decl[1], member: '' };
  // A COMPUTED initializer — `const SQL = ['INSERT INTO leads …', …].join(' ')`
  // — still declares the constant that holds the SQL: walk back to the
  // statement boundary (`;`, or a `{`/`}` not inside brackets) and read
  // the declaration heading that statement. Object-property SQL is handled
  // below, before this fallback would misattribute it.
  const key = lead.match(/([A-Za-z_$][\w$]*)\s*:\s*$/);
  if (!key) {
    let depth = 0;
    let b = j - 1;
    for (; b >= 0; b -= 1) {
      const ch = bare[b];
      if (ch === ')' || ch === ']') depth += 1;
      else if (ch === '(' || ch === '[') depth -= 1;
      else if ((ch === ';' || ch === '{' || ch === '}') && depth <= 0) break;
    }
    const stmt = code.slice(b + 1, j).match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (stmt) return { name: stmt[1], member: '' };
  }
  // SQL held in an OBJECT PROPERTY — `const SQL = { create: 'INSERT …' };
  // db.raw(SQL.create)`: the key's enclosing object literal is what must
  // be declared, and raw must receive `OBJ.key` / `OBJ['key']` — or, for
  // pg's QueryConfig convention (`{ text, values }`), the WHOLE object.
  const opener = key ? enclosingOpener(bare, j) : -1;
  if (opener === -1) return null;
  const objDecl = code.slice(Math.max(0, opener - 200), opener).match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  if (!objDecl) return null;
  const member = String.raw`\s*(?:\.\s*${escapeRe(key[1])}\b|(?:\?\.)?\[\s*['"\x60]${escapeRe(key[1])}['"\x60]\s*\]${key[1] === 'text' ? String.raw`|(?![\s.\[])` : ''})`;
  return { name: objDecl[1], member };
}

function inRawContext(code, idx) {
  // Nearest preceding raw callee whose call is still OPEN at the match:
  // walk paren depth on the fully blanked view (SQL-string parens are
  // blanked there), so a long CTE cannot outrun a fixed window.
  // EVERY preceding raw/query callee is tried, not just the nearest: in
  // `db.raw(db.raw('WITH …').toString() + ' INSERT INTO leads …')` the
  // inner call has closed but the outer one still executes the string.
  const bare = blankCommentsAndStrings(code);
  const rawRe = new RegExp(RAW_CALLEE, 'g');
  let r;
  while ((r = rawRe.exec(bare)) && r.index < idx) {
    const open = r.index + r[0].length - 1;
    let depth = 0;
    let inside = true;
    for (let k = open; k < idx; k += 1) {
      if (bare[k] === '(') depth += 1;
      else if (bare[k] === ')') { depth -= 1; if (depth === 0) { inside = false; break; } }
    }
    if (inside && depth >= 1) return true;
  }
  // SQL stored in a constant and PASSED to raw later — `const SQL = 'WITH …
  // INSERT INTO leads …'; db.raw(SQL)`. Walk back over the enclosing
  // string literal(s) — every string char is blank in the fully blanked
  // view, and `+` glue joins concatenated pieces — to the `=` of the
  // declaration, then require that identifier to reach a raw callee.
  // SQL RETURNED by a function (or produced by an expression-bodied arrow)
  // that is later handed to raw/query — `db.raw(buildInsert('leads'))`: the
  // literal's own statement is the evidence, the callee invocation the
  // execution.
  const producer = sqlProducer(code, bare, idx);
  if (producer && new RegExp(String.raw`${RAW_CALLEE}\s*${escapeRe(producer)}\s*(?:\?\.)?\(`).test(bare)) return true;
  const decl = sqlDeclaration(code, idx);
  if (!decl) return false;
  const { member } = decl;
  // The constant may reach raw through simple aliases (`const QUERY = SQL;
  // db.raw(QUERY)`), followed transitively to a fixpoint.
  const names = new Set([decl.name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [a, b] of simpleAssignPairs(bare)) {
      if (names.has(b) && !names.has(a)) { names.add(a); grew = true; }
    }
    // …and through a pg QueryConfig WRAPPER declared separately —
    // `const cfg = { text: SQL, values }` — which then travels as a whole.
    for (const n of [...names]) {
      const wrapRe = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^{}]*\btext\s*:\s*${escapeRe(n)}\b`, 'g');
      let wr;
      while ((wr = wrapRe.exec(bare))) if (!names.has(wr[1])) { names.add(wr[1]); grew = true; }
    }
  }
  // The constant reaches the callee directly (`raw(SQL)`, `query(cfg)`) or
  // as the `text` of an INLINE QueryConfig (`query({ text: SQL, values })`).
  return [...names].some((n) => new RegExp(String.raw`${RAW_CALLEE}\s*(?:${escapeRe(n)}\b${member}|\{[^{}]*\btext\s*:\s*${escapeRe(n)}\b)`).test(bare));
}

// Every call site where `name` is passed as a WHOLE argument (`f(name)`,
// `f(a, name)` — not `f(name.table)`): returns the callee text (bare
// identifier or member path) and the zero-based argument position. Walks
// the blanked view backward from each occurrence to the call's `(` at
// depth 0, counting top-level commas; a `;`, `{`, `}` or `=` first means it
// is not an argument. Control-keyword heads (`if (x)`) are not calls.
function wholeArgumentPasses(bare, name, scalarProps = new Set()) {
  const out = [];
  // The name itself or a MEMBER path off it (`retarget(TYPES.lawn)`) — a
  // governed entry escapes through the parameter just the same. A path
  // ending in a governed SCALAR property (`db(config.table)`) passes a
  // string, which no callee can mutate back into the config.
  const occRe = new RegExp(String.raw`(?<![.\w$])${escapeRe(name)}\b(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\]))*(?!\s*[.\[(])`, 'g');
  let o;
  while ((o = occRe.exec(bare))) {
    const leaf = o[0].match(/\.\s*([A-Za-z_$][\w$]*)\s*$/);
    if (leaf && scalarProps.has(leaf[1])) continue;
    const after = bare.slice(o.index + o[0].length).match(/^\s*([,)])/);
    if (!after) continue;
    let depth = 0;
    let position = 0;
    let k = o.index - 1;
    for (; k >= 0; k -= 1) {
      const ch = bare[k];
      if (ch === ')' || ch === ']' || ch === '}') depth += 1;
      else if (ch === '(' || ch === '[' || ch === '{') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && ch === ',') position += 1;
      else if (depth === 0 && (ch === ';' || ch === '=')) { k = -1; break; }
    }
    if (k < 0 || bare[k] !== '(') continue;
    const head = bare.slice(Math.max(0, k - 120), k).match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/);
    if (!head) continue;
    const callee = head[1].replace(/\s+/g, '');
    if (/^(?:if|while|for|switch|catch|return|typeof|await|function)$/.test(callee)) continue;
    out.push({ callee, position });
  }
  return out;
}

// Function-shaped factories with BALANCED bodies of any nesting depth: find
// every `function NAME(...) {` and block-bodied arrow head, walk the body to
// its matching brace, and report the name when the body RETURNS a builder
// matching bodyRe (whose first capture is returned for the caller).
const functionBodiesCache = new Map();
function balancedFunctionBodies(src) {
  if (functionBodiesCache.has(src)) return functionBodiesCache.get(src);
  const out = [];
  functionBodiesCache.set(src, out);
  // Braces are counted on the STRING-BLANKED view (same length, aligned),
  // so `const marker = '}'` inside a body cannot close it early; the body
  // text itself is sliced from `src` for return analysis.
  const bare = blankCommentsAndStrings(src);
  // Heads: `function NAME(…) {`, `NAME = (…) => {`, method `NAME(…) {`, and
  // a variable-assigned FUNCTION EXPRESSION `const NAME = function (…) {`.
  const headRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{|\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{|(?<![.\w$])(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{|\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b[^(]*\(([^()]*)\)\s*\{/g;
  let h;
  while ((h = headRe.exec(src))) {
    const name = h[1] || h[3] || h[6] || h[8];
    if (!name) continue;
    const params = paramNames(h[2] ?? h[4] ?? h[5] ?? h[7] ?? h[9] ?? '');
    let depth = 1;
    let j = headRe.lastIndex;
    for (; j < bare.length && depth > 0; j += 1) {
      if (bare[j] === '{') depth += 1;
      else if (bare[j] === '}') depth -= 1;
    }
    out.push({ name, params, body: src.slice(headRe.lastIndex, j), start: headRe.lastIndex, end: j });
  }
  return out;
}

// `localDeclRe` (capture 1 = name, capture 2 = table expression when the
// caller has one) finds builders STORED in the body — `function q() { const
// base = db('leads'); return base; }` is a factory through its local alias.
// The return statements are matched ONCE over the whole file and mapped to
// every function whose body encloses them (nested bodies overlap — scanning
// each body separately re-read the same text once per nesting level).
// A return statement belongs to the INNERMOST function enclosing it — an
// inner arrow's `return db('leads')` does not make the outer handler a
// factory.
function balancedBodyFactories(src, bodyRe, localDeclRes = [], captureAt = null) {
  const fns = balancedFunctionBodies(src);
  const innermost = (idx) => {
    let best = null;
    for (const f of fns) if (f.start <= idx && idx < f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
    return best;
  };
  const out = [];
  const seen = new Set();
  const push = (fn, capture) => { if (fn && !seen.has(fn)) { seen.add(fn); out.push({ name: fn.name, capture }); } };
  const globalRe = new RegExp(bodyRe.source, 'g');
  let bm;
  while ((bm = globalRe.exec(src))) {
    const cap = captureAt ? captureAt(bm) : bm[1];
    if (captureAt && cap === null) continue; // not a knex head after all
    push(innermost(bm.index), cap);
  }
  // `return IDENT;` — an alias factory when IDENT is a builder declared in
  // that same body (direct or conditional initializer). Locals are
  // collected once per function, and keyword returns are not aliases.
  const retRe = /\breturn\s+([A-Za-z_$][\w$]*)\s*;/g;
  const localsOf = new Map();
  let ret;
  while ((ret = retRe.exec(src))) {
    if (/^(?:null|undefined|true|false|this)$/.test(ret[1])) continue;
    const fn = innermost(ret.index);
    if (!fn || seen.has(fn)) continue;
    if (!localsOf.has(fn)) {
      const locals = new Map();
      for (const localDeclRe of localDeclRes) {
        localDeclRe.lastIndex = 0;
        let ld;
        while ((ld = localDeclRe.exec(fn.body))) {
          if (locals.has(ld[1])) continue;
          if (captureAt) {
            // Match offsets are relative to the body: shift for the file.
            const shifted = Object.assign([...ld], { index: ld.index + fn.start, input: src });
            const cap = captureAt(shifted);
            if (cap !== null) locals.set(ld[1], cap);
          } else locals.set(ld[1], ld[2] ?? ld[1]);
        }
      }
      localsOf.set(fn, locals);
    }
    if (localsOf.get(fn).has(ret[1])) push(fn, localsOf.get(fn).get(ret[1]));
  }
  return out;
}

// In-file INSERTION HELPERS: functions whose own parameter drives the
// insert (`function writeRow(builder, row) { return builder.insert(row); }`).
// A leads builder handed to one of these is created at the CALL site, which
// is therefore the registered writer. A helper that only reads its builder
// parameter (`whereBuilderWarrantyExpiring(qb)`) is not one.
// Insertion helpers IMPORTED from a sibling module — `const { writeRow } =
// require('./writers')` / `import { writeRow } from './writers'`: the
// module is read (relative specifiers only; a package cannot be a Waves
// lead writer) and its functions checked the same way, so the caller's
// `writeRow(db('leads'), row)` registers here. Renamed bindings
// (`{ writeRow: write }`, `writeRow as write`) map to the local name.
// Every RELATIVE require/import in `src`, resolved against `filePath`:
// `{ resolved, ns }` for a namespace/default binding, `{ resolved,
// bindings: [[orig, local]] }` for a destructured one. Package specifiers
// are not followed — a third-party package cannot be a Waves lead writer.
function relativeImports(src, filePath) {
  const out = [];
  if (!filePath) return out;
  const importRe = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bimport\s*\{([^{}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bimport\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^{}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(src))) {
    const target = path.resolve(path.dirname(filePath), m[2] || m[4] || m[6] || m[8] || m[11]);
    const resolved = [target, `${target}.js`, path.join(target, 'index.js')]
      .find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!resolved) continue;
    // Combined `import defaults, { a } from './x'`: a default binding AND
    // named bindings.
    if (m[9]) out.push({ resolved, ns: m[9] });
    const ns = m[5] || m[7];
    if (ns) { out.push({ resolved, ns }); continue; }
    const bindings = (m[1] || m[3] || m[10] || '').split(',')
      .map((part) => part.split(/\s*(?::|\bas\b)\s*/).map((x) => x && x.trim()))
      .filter(([orig]) => orig);
    out.push({ resolved, bindings });
  }
  return out;
}

// What a sibling module EXPORTS that matters here, read once per module:
// its parameter-inserting helper names, whether its default export inserts,
// and the names of its lead-SQL constants (`const CREATE_LEAD = 'INSERT
// INTO leads …'`).
const moduleFactsCache = new Map();
function computeModuleFacts(raw) {
  // Cheap prechecks: no insert call → no helper; no `leads` → no lead SQL,
  // no lead builder, no lead factory.
  const modSrc = /insert|leads/i.test(raw) ? blankComments(raw) : '';
  const hasInsert = /insert/i.test(modSrc);
  const hasLeads = /leads/i.test(modSrc);
  const lead = hasLeads ? leadBuilderExports(modSrc) : { factories: new Set(), builders: new Set(), defaultFactory: false };
  const facts = {
    helpers: hasInsert ? insertingHelperNames(modSrc) : new Set(),
    callableDefault: hasInsert && defaultExportInserts(modSrc),
    sqlConstants: hasLeads ? leadSqlConstantNames(modSrc) : new Set(),
    factories: lead.factories,
    builders: lead.builders,
    defaultFactory: lead.defaultFactory,
  };
  // EXPORT ALIASES — `module.exports = { save: writeRow }`, `exports.save =
  // writeRow`, `export { writeRow as save }` — expose a local fact under
  // the exported name too.
  for (const [exported, local] of exportAliases(modSrc)) {
    for (const k of ['helpers', 'sqlConstants', 'factories', 'builders']) if (facts[k].has(local)) facts[k].add(exported);
  }
  return facts;
}
function exportAliases(src) {
  const out = [];
  let m;
  const propRe = /(?:module\s*\.\s*)?exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = propRe.exec(src))) out.push([m[1], m[2]]);
  const objRe = /module\s*\.\s*exports\s*=\s*\{([^{}]*)\}/g;
  while ((m = objRe.exec(src))) {
    for (const part of splitTopLevel(m[1])) {
      const kv = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/);
      if (kv) out.push([kv[1], kv[2] || kv[1]]);
    }
  }
  const esmRe = /\bexport\s*\{([^{}]*)\}\s*(?!from\b)/g;
  while ((m = esmRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const [local, exported] = part.split(/\s+as\s+/).map((x) => x && x.trim());
      if (local && exported && /^[A-Za-z_$][\w$]*$/.test(local)) out.push([exported, local]);
    }
  }
  return out;
}
// Lead BUILDERS a module can hand to importers: functions returning a lead
// builder (`const leadQuery = () => db('leads')`, `function leadQuery() {…
// return db('leads'); }`, `exports.leadQuery = …`), stored builders (`const
// leads = db('leads')`), and a default export that is itself a factory
// (`module.exports = () => db('leads')`). Importers that call `.insert` on
// them are lead writers although neither file alone shows table + insert.
function leadBuilderExports(modSrc) {
  const factories = new Set();
  const builders = new Set();
  let defaultFactory = false;
  for (const { token } of leadsTableTokens(modSrc)) {
    const { declRe, condDeclRe, factoryRe, returnRe } = builderRegexes(token);
    let m;
    while ((m = declRe.exec(modSrc))) builders.add(m[1]);
    while ((m = condDeclRe.exec(modSrc))) builders.add(m[1]);
    while ((m = factoryRe.exec(modSrc))) factories.add(m[1]);
    for (const f of balancedBodyFactories(modSrc, returnRe, [declRe, condDeclRe])) factories.add(f.name);
    const defRe = new RegExp(String.raw`(?:module\s*\.\s*exports|exports\s*\.\s*default|\bexport\s+default)\s*=?\s*(?:async\s*)?(?:function\b[^(]*\([^()]*\)\s*\{(?:[^{}]|\{[^{}]*\})*?\breturn\s+|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{(?:[^{}]|\{[^{}]*\})*?\breturn\s+)?)[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`);
    if (defRe.test(modSrc)) defaultFactory = true;
    const defNamed = modSrc.match(/(?:module\s*\.\s*exports\s*=|\bexport\s+default)\s*([A-Za-z_$][\w$]*)\s*;/);
    if (defNamed && factories.has(defNamed[1])) defaultFactory = true;
  }
  return { factories, builders, defaultFactory };
}
// Imported lead builders/factories as this file's local callee spellings.
function importedLeadBuilders(src, filePath) {
  const factories = new Set();
  const builders = new Set();
  for (const imp of relativeImports(src, filePath)) {
    const f = moduleFacts(imp.resolved);
    if (imp.ns) {
      for (const n of f.factories) factories.add(`${imp.ns}.${n}`);
      for (const n of f.builders) builders.add(`${imp.ns}.${n}`);
      if (f.defaultFactory) factories.add(imp.ns);
      continue;
    }
    for (const [orig, local] of imp.bindings) {
      if (f.factories.has(orig)) factories.add(local || orig);
      if (f.builders.has(orig)) builders.add(local || orig);
    }
  }
  return { factories, builders };
}
// The repo pass fills this cache as a by-product of each file's own scan
// (its views are already lexed then); the single-file API reads on demand.
// A BARREL that re-exports another module (`module.exports = require(
// './writers')`, `...require('./x')`, `Object.assign(module.exports,
// require('./x'))`, `export * from './x'`, `export { a as b } from './x'`)
// carries that module's facts too, transitively — named re-exports under
// their exported names.
const mergedFactsCache = new Map();
function ownModuleFacts(resolved) {
  if (!moduleFactsCache.has(resolved)) moduleFactsCache.set(resolved, computeModuleFacts(fs.readFileSync(resolved, 'utf8')));
  return moduleFactsCache.get(resolved);
}
const RE_EXPORT_RE = /module\s*\.\s*exports\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\.\.\.\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|Object\s*\.\s*assign\s*\(\s*(?:module\s*\.\s*)?exports\s*,\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bexport\s+\*\s+from\s*['"](\.{1,2}\/[^'"]+)['"]|\bexport\s*\{([^{}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
function moduleFacts(resolved, seen = new Set()) {
  if (mergedFactsCache.has(resolved)) return mergedFactsCache.get(resolved);
  const own = ownModuleFacts(resolved);
  if (seen.has(resolved)) return own;
  seen.add(resolved);
  const merged = { ...own, helpers: new Set(own.helpers), sqlConstants: new Set(own.sqlConstants), factories: new Set(own.factories), builders: new Set(own.builders) };
  const src = fs.readFileSync(resolved, 'utf8');
  let m;
  RE_EXPORT_RE.lastIndex = 0;
  while ((m = RE_EXPORT_RE.exec(src))) {
    const target = path.resolve(path.dirname(resolved), m[1] || m[2] || m[3] || m[4] || m[6]);
    const hit = [target, `${target}.js`, path.join(target, 'index.js')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!hit) continue;
    const f = moduleFacts(hit, seen);
    if (m[5] !== undefined) {
      // NAMED re-export — `export { writeRow as save } from './x'` exposes
      // the fact under its EXPORTED name only.
      for (const part of m[5].split(',')) {
        const [orig, local] = part.split(/\s+as\s+/).map((x) => x && x.trim());
        if (!orig) continue;
        for (const k of ['helpers', 'sqlConstants', 'factories', 'builders']) if (f[k].has(orig)) merged[k].add(local || orig);
      }
      continue;
    }
    for (const k of ['helpers', 'sqlConstants', 'factories', 'builders']) for (const n of f[k]) merged[k].add(n);
    merged.callableDefault = merged.callableDefault || f.callableDefault;
    merged.defaultFactory = merged.defaultFactory || f.defaultFactory;
  }
  mergedFactsCache.set(resolved, merged);
  return merged;
}

function importedInsertingHelpers(src, filePath) {
  const names = new Set();
  for (const imp of relativeImports(src, filePath)) {
    const { helpers, callableDefault } = moduleFacts(imp.resolved);
    // NAMESPACE / default binding (`const writers = require('./writers')`,
    // `import * as writers from …`): every inserting function is reachable
    // as a MEMBER call, recorded as `writers.writeRow`; when the module's
    // default export IS an inserting function (`module.exports = function
    // writeRow(builder, row) {…}`), the bare local name is the callee too.
    if (imp.ns) {
      for (const fn of helpers) names.add(`${imp.ns}.${fn}`);
      if (callableDefault) names.add(imp.ns);
      continue;
    }
    for (const [orig, local] of imp.bindings) if (helpers.has(orig)) names.add(local || orig);
  }
  return names;
}

// Lead-SQL constants IMPORTED from a sibling module and handed to raw/query
// here (`const { CREATE_LEAD } = require('./queries'); client.query(
// CREATE_LEAD)`): the defining module has no executable context and this
// file has no SQL token, so the call site is the writer. Returns the local
// callee spellings (bare or `ns.NAME`).
function importedSqlConstants(src, filePath) {
  const names = new Set();
  if (!new RegExp(RAW_CALLEE).test(src)) return names; // nothing executes SQL here
  for (const imp of relativeImports(src, filePath)) {
    const { sqlConstants } = moduleFacts(imp.resolved);
    if (imp.ns) { for (const c of sqlConstants) names.add(`${imp.ns}.${c}`); continue; }
    for (const [orig, local] of imp.bindings) if (sqlConstants.has(orig)) names.add(local || orig);
  }
  return names;
}
// Names of constants in `code` (comment-blanked, strings kept) whose
// initializer holds a lead INSERT/MERGE — the module side of the above.
function leadSqlConstantNames(code) {
  const names = new Set();
  RAW_SQL_INSERT_RE.lastIndex = 0;
  let m;
  while ((m = RAW_SQL_INSERT_RE.exec(code))) {
    const decl = sqlDeclaration(code, m.index);
    if (decl && !decl.member) names.add(decl.name);
  }
  return names;
}

// Regex source for a helper callee: a bare name, or `ns.fn` / `ns['fn']`
// for a namespace-imported one.
function helperCallee(helper) {
  const [ns, fn] = helper.split('.');
  if (!fn) return String.raw`\b${escapeRe(ns)}`;
  return String.raw`\b${escapeRe(ns)}\s*(?:\.\s*${escapeRe(fn)}|(?:\?\.)?\[\s*['"\x60]${escapeRe(fn)}['"\x60]\s*\])`;
}

// Does the module's DEFAULT export insert through one of its own
// parameters? Covers `module.exports = function [name](builder, row) {…}`,
// `export default function …`, and `module.exports = writeRow` /
// `export default writeRow` naming an in-file inserting function.
function defaultExportInserts(src) {
  const bare = blankCommentsAndStrings(src);
  // `function` forms end in `{` (block body, walked balanced); ARROW forms
  // (`module.exports = (builder, row) => builder.insert(row)`) may have a
  // block or an expression body — the latter runs to the statement end.
  const fnRe = /(?:module\.exports|exports\.default|\bexport\s+default)\s*=?\s*(?:async\s+)?function\b[^(]*\(([^()]*)\)\s*\{|(?:module\.exports|exports\.default|\bexport\s+default)\s*=?\s*(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*(\{)?/g;
  let f;
  while ((f = fnRe.exec(src))) {
    let bodyEnd;
    if (f[1] !== undefined || f[4]) {
      let depth = 1;
      let j = fnRe.lastIndex;
      for (; j < bare.length && depth > 0; j += 1) {
        if (bare[j] === '{') depth += 1;
        else if (bare[j] === '}') depth -= 1;
      }
      bodyEnd = j;
    } else {
      bodyEnd = fnRe.lastIndex + src.slice(fnRe.lastIndex).match(/^[^;\n]*/)[0].length;
    }
    const params = paramNames(f[1] ?? f[2] ?? f[3] ?? '');
    if (paramInserts(params, bare.slice(fnRe.lastIndex, bodyEnd))) return true;
  }
  const named = src.match(/(?:module\.exports\s*=|\bexport\s+default)\s*([A-Za-z_$][\w$]*)\s*;/);
  return Boolean(named) && insertingHelperNames(src).has(named[1]);
}

// Does some insert call inside `bareBody` (a blanked-view slice) chain from
// one of `params`? Receivers are found by walking BACKWARD from each insert
// selector, so any chain depth qualifies.
const INSERT_CALL_RE = new RegExp(INSERT_CALL, 'g');
function paramInserts(params, bareBody) {
  INSERT_CALL_RE.lastIndex = 0;
  let m;
  while ((m = INSERT_CALL_RE.exec(bareBody))) if (params.includes(chainReceiver(bareBody, m.index))) return true;
  return false;
}
function insertingHelperNames(src) {
  const names = new Set();
  const bare = blankCommentsAndStrings(src);
  // Every insert call in the file, once; each is a helper when some
  // enclosing function declares its chain's receiver as a parameter (the
  // receiver may sit in a nested callback).
  const fns = balancedFunctionBodies(src);
  INSERT_CALL_RE.lastIndex = 0;
  let r;
  while ((r = INSERT_CALL_RE.exec(bare))) {
    const receiver = chainReceiver(bare, r.index);
    if (!receiver) continue;
    for (const f of fns) if (f.start <= r.index && r.index < f.end && f.params.includes(receiver)) names.add(f.name);
  }
  // EXPRESSION-bodied named arrows — `const writeRow = (builder, row) =>
  // builder.insert(row);` — have no brace block; the body runs to the
  // statement end.
  const exprArrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*(?!\{)([^;\n]*)/g;
  let a;
  while ((a = exprArrowRe.exec(src))) {
    const params = paramNames(a[2] ?? a[3] ?? '');
    const bodyStart = exprArrowRe.lastIndex - a[4].length;
    if (paramInserts(params, bare.slice(bodyStart, exprArrowRe.lastIndex))) names.add(a[1]);
  }
  // PROPERTY-assigned helpers — `exports.save = (builder, row) => …`,
  // `module.exports.save = function (qb, rows) {…}`, and object-literal
  // properties `{ save: (builder, row) => … }` — named by the property.
  const propFnRe = /(?:(?:module\s*\.\s*)?exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*:)\s*(?:async\s*)?(?:function\b[^(]*\(([^()]*)\)\s*\{|(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*(\{)?)/g;
  let pf;
  while ((pf = propFnRe.exec(src))) {
    const params = paramNames(pf[3] ?? pf[4] ?? pf[5] ?? '');
    let bodyEnd;
    if (pf[3] !== undefined || pf[6]) {
      let depth = 1;
      let j = propFnRe.lastIndex;
      for (; j < bare.length && depth > 0; j += 1) {
        if (bare[j] === '{') depth += 1;
        else if (bare[j] === '}') depth -= 1;
      }
      bodyEnd = j;
    } else {
      bodyEnd = propFnRe.lastIndex + src.slice(propFnRe.lastIndex).match(/^[^;\n]*/)[0].length;
    }
    if (paramInserts(params, bare.slice(propFnRe.lastIndex, bodyEnd))) names.add(pf[1] || pf[2]);
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
// A declaration is VISIBLE at the use site only if no brace block that
// encloses the declaration closes before the use — `function audit() {
// const TABLE = 'audit'; }` is out of scope for a later sibling function,
// which sees the module-level constant. Braces are counted on the
// string-blanked view. Among visible preceding declarations the nearest
// (innermost) wins.
// The `{` of the innermost block enclosing `idx` (-1 at module level).
function enclosingOpener(bare, idx) {
  let depth = 0;
  for (let k = idx - 1; k >= 0; k -= 1) {
    if (bare[k] === '}') depth += 1;
    else if (bare[k] === '{') { if (depth === 0) return k; depth -= 1; }
  }
  return -1;
}
// The variable an object literal is assigned to (`const queries = {`) for a
// position inside that literal, or null when it has no declared owner.
function objectOwner(code, bare, idx) {
  const opener = enclosingOpener(bare, idx);
  if (opener === -1) return null;
  const d = code.slice(Math.max(0, opener - 200), opener).match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  return d ? d[1] : null;
}

// Does the block opened at `openIdx` belong to a FUNCTION (declaration,
// expression, arrow, method) rather than a control block / bare block?
function isFunctionBodyOpener(bare, openIdx) {
  let k = openIdx - 1;
  while (k >= 0 && /\s/.test(bare[k])) k -= 1;
  if (bare[k] === '>' && bare[k - 1] === '=') return true; // arrow body
  if (bare[k] !== ')') return false; // `else {`, `try {`, `{`
  let depth = 0;
  for (; k >= 0; k -= 1) {
    if (bare[k] === ')') depth += 1;
    else if (bare[k] === '(') { depth -= 1; if (depth === 0) break; }
  }
  const kw = bare.slice(Math.max(0, k - 40), k).match(/([A-Za-z_$][\w$]*)\s*$/);
  return !kw || !/^(?:if|for|while|switch|catch|with)$/.test(kw[1]);
}
// `var` is FUNCTION-scoped: a block closing does not end its visibility
// unless that block is a function body.
function declVisibleAt(bare, declIdx, useIdx, isVar = false) {
  let depth = 0;
  let opener = declIdx;
  for (let k = declIdx; k < useIdx; k += 1) {
    if (bare[k] === '{') depth += 1;
    else if (bare[k] === '}') {
      depth -= 1;
      if (depth < 0) {
        if (!isVar) return false;
        opener = enclosingOpener(bare, opener);
        if (opener === -1 || isFunctionBodyOpener(bare, opener)) return false;
        depth = 0;
      }
    }
  }
  return true;
}
// Index of the nearest declaration of `name` VISIBLE at `idx` (-1 if none).
function nearestVisibleDecl(bare, name, idx) {
  const re = new RegExp(String.raw`\b(const|let|var)\s+${escapeRe(name)}\b`, 'g');
  let best = -1;
  let m;
  while ((m = re.exec(bare)) && m.index < idx) {
    if (declVisibleAt(bare, m.index, idx, m[1] === 'var')) best = m.index;
  }
  return best;
}
function nearestDeclBindsLeads(code, name, idx) {
  const bare = blankCommentsAndStrings(code);
  const declRe = new RegExp(String.raw`\b(const|let|var)\s+${escapeRe(name)}\s*=\s*(['"\x60])([^'"\x60]*)\2`, 'g');
  let value = null;
  let d;
  while ((d = declRe.exec(code)) && d.index < idx) {
    if (declVisibleAt(bare, d.index, idx, d[1] === 'var')) value = d[3];
  }
  return value === null || isLeadsTable(value);
}

// Aliased-builder form: a `leads` query builder stored in a variable first
// (`const leads = trx('leads'); ... leads.insert(...)`). The declaration must
// NOT be awaited — `const rows = await db('leads')...` is an executed query,
// not a stored builder. Covers `qb(X)` and `qb.table(X)` heads, including a
// schema-qualified head (`db.withSchema('public').table(X)`) via the same
// CHAIN of intermediate calls the direct patterns allow, for X = the literal
// or a resolved constant.
// The per-token regexes that recognize a STORED lead builder (`const q =
// db('leads')`, conditional initializers) and lead-builder FACTORIES (arrow
// or function bodies returning one) — shared by the in-file alias pass and
// the module-facts pass.
function builderRegexes(token) {
  const declRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?(?:${SEL_CHAIN}\s*(?:\.\s*(?:table|from)|(?:\?\.)?\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`,
    'g'
  );
  const condDeclRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![^;]{0,200}\bawait\b)[^;]{0,200}?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`,
    'g'
  );
  const factoryRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{(?:[^{}]|\{[^{}]*\})*?\breturn\s+)?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`,
    'g'
  );
  const returnRe = new RegExp(String.raw`\breturn\b[^;]{0,160}?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?(?:\s*(?:\??\.\s*(?:table|from)|(?:\?\.)?\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*(?:\?\.)?\(\s*(${token})${TABLE_OPTS}\)`);
  return { declRe, condDeclRe, factoryRe, returnRe };
}

function aliasInsertPatterns(src, token, filePath, imports = 'all') {
  // Declaration keyword OPTIONAL — a builder stored by a later assignment
  // (`let target; target = db('leads');`) is the same stored-builder form.
  // Optional factory call after the head identifier — `getDb()('leads')`.
  const { declRe, condDeclRe, factoryRe, returnRe } = builderRegexes(token);
  const patternsExtra = [];
  const builders = new Set();
  const factories = new Set();
  // Declaration indices per builder name (the keyword start) — a use of
  // the name is a lead write only if the nearest VISIBLE declaration before
  // it is one of these: `function read() { const q = db('leads'); … }
  // function audit() { const q = db('audit'); q.insert(row); }` must not
  // attribute audit's insert to read's builder.
  const leadDecls = new Map();
  const noteDecl = (name, m) => {
    if (!/^(?:const|let|var)\b/.test(m[0])) return;
    if (!leadDecls.has(name)) leadDecls.set(name, new Set());
    leadDecls.get(name).add(m.index);
  };
  let decl;
  while ((decl = declRe.exec(src))) { builders.add(decl[1]); noteDecl(decl[1], decl); }
  // Conditional/logical initializers — `const target = cond ? db('leads')
  // : db('audit');` — anything holding a leads builder anywhere in its
  // (non-awaited) initializer is a stored builder.
  let cnd;
  while ((cnd = condDeclRe.exec(src))) { builders.add(cnd[1]); noteDecl(cnd[1], cnd); }
  // Builders stored in OBJECT PROPERTIES — `const queries = { lead:
  // db('leads') }; queries.lead.insert(row)`. The use pattern keys on the
  // property name reached through any object.
  const propDeclRe = new RegExp(
    String.raw`([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`,
    'g'
  );
  // Each property remembers its OWNING object (`const queries = { lead:
  // db('leads') }` → queries, plus its simple aliases) so an unrelated
  // `audits.lead.insert(row)` is not attributed to it; a literal with no
  // declared owner (inline argument, returned) matches through any object.
  const props = new Map(); // prop -> Set(owner) | null
  const bareForProps = blankCommentsAndStrings(src);
  let pd;
  while ((pd = propDeclRe.exec(src))) {
    const owner = objectOwner(src, bareForProps, pd.index);
    if (!props.has(pd[1])) props.set(pd[1], owner ? new Set() : null);
    if (owner && props.get(pd[1])) props.get(pd[1]).add(owner);
  }
  for (const owners of props.values()) if (owners) for (const [a, b] of simpleAssignPairs(src)) if (owners.has(b)) owners.add(a);
  // A leads builder CONSTRUCTED AS AN ARGUMENT to an insertion helper —
  // in-file or imported from a sibling module (`writeRow(db('leads'),
  // row)`): the construction site is the registered writer.
  const helperNames = new Set([
    ...(imports === 'only' ? [] : insertingHelperNames(src)),
    ...(imports === 'skip' ? [] : importedInsertingHelpers(src, filePath)),
  ]);
  for (const helper of helperNames) {
    patternsExtra.push(new RegExp(
      String.raw`${helperCallee(helper)}\s*\((?:[^()]|\([^()]*\))*?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(\s*${token}${TABLE_OPTS}\)`,
      'g'
    ));
  }
  // Arrow FACTORY returning the builder — `const baseQuery = () =>
  // db('leads'); … baseQuery().insert(row)` (the v2-promotion-readiness
  // idiom). Parenthesized or bare parameter lists both count.
  let fac;
  while ((fac = factoryRe.exec(src))) factories.add(fac[1]);
  // Function/block-arrow factories with BALANCED bodies of any depth —
  // `function baseQuery() { try { … } finally { … } return db('leads'); }`.
  for (const f of balancedBodyFactories(src, returnRe, [declRe, condDeclRe])) factories.add(f.name);
  // TRANSITIVE aliases: `const target = base;` makes `target` the same
  // builder (or factory), to a fixpoint. One pass collects every simple
  // identifier-to-identifier assignment; the closure runs in memory.
  const pairs = simpleAssignPairs(src);
  for (const set of [builders, factories]) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b, declIdx] of pairs) {
        if (!set.has(b)) continue;
        if (!set.has(a)) { set.add(a); grew = true; }
        // A transitive builder alias is bound where IT was declared — every
        // such declaration is recorded (a name can be re-aliased in several
        // functions), so a sibling scope's same-named `const target =
        // db('audit')` does not inherit lead status.
        if (set === builders && declIdx !== null) {
          if (!leadDecls.has(a)) leadDecls.set(a, new Set());
          if (!leadDecls.get(a).has(declIdx)) { leadDecls.get(a).add(declIdx); grew = true; }
        }
      }
    }
  }
  if (imports === 'only') return patternsExtra;
  const patterns = [...patternsExtra];
  const bare = blankCommentsAndStrings(src);
  if (builders.size) {
    // ONE use regex over every stored-builder name; the captured name picks
    // its scope check.
    const re = chainHead(new RegExp(String.raw`\b(${[...builders].map(escapeRe).join('|')})\b`, 'g'));
    re.verify = (m) => {
      const n = m[1];
      if (!leadDecls.has(n)) return true;
      const d = nearestVisibleDecl(bare, n, m.index);
      return d === -1 || leadDecls.get(n).has(d);
    };
    patterns.push(re);
  }
  if (props.size) {
    const alt = [...props.keys()].map(escapeRe).join('|');
    const re = chainHead(new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*(?:\.\s*(${alt})|(?:\?\.)?\[\s*['"\x60](${alt})['"\x60]\s*\])`, 'g'));
    re.verify = (m) => { const owners = props.get(m[2] || m[3]); return !owners || owners.has(m[1]); };
    patterns.push(re);
  }
  for (const n of factories) {
    // Factory CALL: its arguments are skipped balanced, then the chain walked.
    patterns.push(Object.assign(new RegExp(String.raw`\b${escapeRe(n)}\s*(?=\()`, 'g'), { chain: true, callArgs: true }));
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
  // Output is assembled from SEGMENTS: plain code runs are copied as slices
  // and only the inside of strings, comments, template literals and regex
  // literals is walked character by character (the earlier per-character
  // concatenation was the single largest cost of the repository pass).
  const parts = [];
  let segStart = 0;
  // Last significant (non-whitespace) code character — a `/` after one of
  // these starts a REGEX LITERAL, not division. Its content (quotes
  // included) is data and blanks out, so `db(/'/.test(kind) ? t : f)` does
  // not derail the string lexer.
  let lastSig = '';
  const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
  const REGEX_KEYWORDS = ['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'];
  const blankRun = (t) => t.replace(/[^\n]/g, ' ');
  const flush = (i) => {
    if (i <= segStart) return;
    const run = code.slice(segStart, i);
    parts.push(run);
    const t = run.trimEnd();
    if (t) lastSig = t[t.length - 1];
  };
  // The most recent ≤24 output characters before `i` (plain run + earlier
  // segments) — for the regex-after-keyword and bracket-key rules.
  const tail = (i) => {
    let t = code.slice(segStart, i);
    for (let k = parts.length - 1; t.length < 24 && k >= 0; k -= 1) t = parts[k] + t;
    return t.slice(-24);
  };
  const closeBracket = /\s*\]/y;
  const special = /[/'"`]/g;
  let i = 0;
  while (i < n) {
    special.lastIndex = i;
    const sp = special.exec(code);
    if (!sp) break;
    i = sp.index;
    const c = code[i];
    const d = code[i + 1];
    const runT = code.slice(segStart, i).trimEnd();
    const sigHere = runT ? runT[runT.length - 1] : lastSig;
    if (c === '/' && d === '/') {
      flush(i);
      const e = code.indexOf('\n', i);
      const end = e === -1 ? n : e;
      parts.push(blankRun(code.slice(i, end)));
      i = end; segStart = i;
      continue;
    }
    if (c === '/' && d === '*') {
      flush(i);
      const e = code.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      parts.push(blankRun(code.slice(i, end)));
      i = end; segStart = i;
      continue;
    }
    if (c === '/') {
      const isRegex = sigHere === '' || REGEX_PRECEDERS.includes(sigHere) || (() => {
        // A regex can also follow an expression-start KEYWORD — `return
        // /'/…` — where the last significant char is the keyword's letter.
        const kw = tail(i).trimEnd().match(/([A-Za-z_$][\w$]*)$/);
        return Boolean(kw) && REGEX_KEYWORDS.includes(kw[1]);
      })();
      if (!isRegex) { i += 1; continue; } // division — stays in the plain run
      flush(i);
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== '\n') {
        const ch = code[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        j += 1;
        if (ch === '/' && !inClass) break;
      }
      j = Math.min(j, n);
      parts.push(blankRun(code.slice(i, j)));
      lastSig = '/';
      i = j; segStart = i;
      continue;
    }
    if (c === "'" || c === '"') {
      flush(i);
      // The whole string (through its closing quote, or the newline that
      // ends an unterminated one), then decide: in keepStrings mode a
      // string is preserved only when it PLAUSIBLY names a table (a short
      // word/dot token) or is SQL text (starts with a SQL keyword) — a
      // code-shaped doc string ("await db('leads').insert(row)") blanks
      // out so it can never read as a live writer.
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') { if (code[j] === '\\') j += 1; j += 1; }
      const end = Math.min(j + 1, n);
      const buf = code.slice(i, end);
      const content = buf.slice(1, buf[buf.length - 1] === c ? -1 : undefined);
      // Keep a string UNLESS it embeds quote characters — that's what makes
      // a doc string code-shaped ("await db('leads').insert(row)"): its
      // inner quotes would otherwise read as live table literals. Two
      // exceptions stay scannable: quote-free content (table names, plain
      // SQL fragments) and content that STARTS as a SQL statement —
      // `"INSERT INTO leads (status) VALUES ('new')"` is a real writer
      // even with quoted values inside.
      const sqlBody = content.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n?)*/, '');
      // …or contains a SQL statement at ANY statement boundary (a multi-
      // statement string `SET search_path = 'public'; INSERT INTO leads …`),
      // or is the direct argument of a raw/query call — it executes.
      const plausible = !/['"`]/.test(content)
        || /(?:^|;)\s*(?:insert|update|delete|select|with|merge)\b/i.test(sqlBody)
        || /(?:raw|query)\s*(?:\?\.\s*)?\(\s*$/.test(tail(i));
      // Method-name strings survive even FULL blanking, so bracket
      // selectors (db['table'](x)) stay visible to the dynamic scan.
      const methodName = /^(?:insert|table|from|raw|query)$/.test(content);
      // So do identifier-shaped BRACKET KEYS (`queries['lead']`), so a
      // stored builder reached by bracket access stays visible too.
      closeBracket.lastIndex = end;
      const bracketKey = /^[A-Za-z_$][\w$]*$/.test(content) && /\[\s*$/.test(tail(i)) && closeBracket.test(code);
      parts.push((keepStrings && plausible) || methodName || bracketKey ? buf : blankRun(buf));
      lastSig = c; // after a string, `/` is division
      i = end; segStart = i;
      continue;
    }
    // Template literal: text blanks (or is kept), `${ … }` substitutions
    // stay code in both views.
    flush(i);
    const tb = [];
    const emitStr = (ch) => { tb.push(keepStrings ? ch : (ch === '\n' ? '\n' : ' ')); };
    emitStr(c);
    let j = i + 1;
    let depth = 0;
    while (j < n) {
      if (depth === 0 && code[j] === '\\') { emitStr(code[j]); j += 1; if (j < n) { emitStr(code[j]); j += 1; } continue; }
      if (depth === 0 && code[j] === '`') { emitStr(code[j]); j += 1; break; }
      if (depth === 0 && code[j] === '$' && code[j + 1] === '{') { depth = 1; tb.push(keepStrings ? '${' : '  '); j += 2; continue; }
      if (depth > 0) {
        if (code[j] === '{') depth += 1;
        else if (code[j] === '}') {
          depth -= 1;
          if (depth === 0) { tb.push(keepStrings ? '}' : ' '); j += 1; continue; }
        }
        tb.push(code[j]); j += 1;
        continue;
      }
      emitStr(code[j]); j += 1;
    }
    parts.push(tb.join(''));
    lastSig = '`';
    i = j; segStart = i;
  }
  flush(n);
  return parts.join('');
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
// Parse a knex table-call ARGUMENT LIST from the `(` at `open`, balanced at
// any depth: the first top-level argument is the table expression; an
// optional second argument must be a table-options shape (object literal,
// or an identifier / member path such as a stored `opts`); a third
// argument, or a non-options second one, means this is not a knex builder
// head (`multi` relaxes that for batchInsert(table, rows, chunk)). Returns
// { expr, end } (end = index past the `)`) or null. A pure string-literal
// table blanks to whitespace here — the literal scan owns it.
function tableArg(code, open, { multi = false } = {}) {
  let depth = 0;
  let k = open;
  const commas = [];
  for (; k < code.length; k += 1) {
    const ch = code[k];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; if (depth === 0) break; }
    else if (ch === ',' && depth === 1) commas.push(k);
  }
  if (k >= code.length) return null;
  const parts = [];
  let prev = open + 1;
  for (const c of commas) { parts.push(code.slice(prev, c)); prev = c + 1; }
  parts.push(code.slice(prev, k));
  if (!multi) {
    if (parts.length > 2) return null;
    if (parts.length === 2 && !/^\s*(?:\{[\s\S]*\}|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/.test(parts[1])) return null;
  }
  return { expr: parts[0], end: k + 1 };
}
// Dynamic heads END AT THE OPENING PAREN of the table call; tableArg parses
// the arguments and the chain walk continues from its end.
const DYNAMIC_INSERT_PATTERNS = [
  chainHead(new RegExp(String.raw`\b[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(`, 'g')),
  chainHead(new RegExp(String.raw`(?:${TABLE_SEL}|${FROM_SEL})\s*(?:\?\.)?\(`, 'g')),
  Object.assign(new RegExp(String.raw`\bbatchInsert\s*\(`, 'g'), { multi: true }),
  chainHead(new RegExp(String.raw`\.into(?:\?\.)?\(`, 'g')),
];
// Table selected AFTER the insert (dynamic) — `insert(payload).into(table)`
// / `.table(table)` / `.from(table)`, payload walked balanced.

function scanSourceForDynamicTableInserts(src, filePath, imports = 'all') {
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
    // Checked on the COMMENT-BLANKED view (strings kept): a block-comment
    // example `const TARGET_TABLE = 'audit'` is not a declaration.
    if (!new RegExp(String.raw`^const\s+${escapeRe(root)}\s*=\s*${Q}[\w.]+${Q}\s*;?\s*$`, 'm').test(blankComments(src))) return false;
    // …and the name must not be REBOUND anywhere else in the file — an
    // indented declaration or a parameter shadowing the module const means
    // the insert may read a different binding, so it stays dynamic.
    // Any declaration of the name other than the single column-0 module
    // const — indented, or inline after a function head on the same line
    // (`function write(row) { const TABLE = requestedTable; …`) — is a
    // possible shadow.
    const declsOfRoot = [...code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(?:\{[^{}\n]*)?\b${escapeRe(root)}\b`, 'g'))];
    const indentedDecl = { test: () => declsOfRoot.length > 1 || declsOfRoot.some((d) => d.index !== 0 && code[d.index - 1] !== '\n') };
    // A parameter list may hold DEFAULT expressions with their own parens
    // (`TABLE = resolveTable(kind), row`) — two nesting levels allowed.
    const paramBinding = new RegExp(String.raw`[(,]\s*(?:\{[^{}]*)?\b${escapeRe(root)}\b(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*(?:=>|\{)`);
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
  // Every in-file dynamic form ends in an insert call; without one the
  // file can only reach a writer through an imported helper (below).
  const hasInsert = /insert/i.test(code) && imports !== 'only';
  // `record` for a chain head: walk from `from` (the head's end) to the
  // insert call.
  const recordChain = (m, expr, from) => {
    const hit = walkChain(code, from, HEAD_STOPS);
    if (hit && hit.name === 'insert') record(m.index, hit.open + 1 - m.index, expr);
  };
  // A regex that ENDS AT the table call's `(`: parse its arguments.
  const argOf = (m, opts) => tableArg(code, m.index + m[0].length - 1, opts);
  for (const pattern of hasInsert ? DYNAMIC_INSERT_PATTERNS : []) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(code))) {
      const arg = argOf(m, { multi: Boolean(pattern.multi) });
      if (!arg) continue;
      if (pattern.chain) recordChain(m, arg.expr, arg.end);
      else record(m.index, arg.end - m.index, arg.expr);
    }
  }
  if (hasInsert) for (const f of insertFirstMatches(code, null)) record(f.index, f.length, f.capture);
  // A dynamic-table builder handed to an insertion helper, in-file or
  // imported (`writeRow(db(table), row)`) — the dynamic mirror.
  const dynHelpers = new Set([
    ...(imports === 'only' ? [] : insertingHelperNames(code)),
    ...(imports === 'skip' ? [] : importedInsertingHelpers(src, filePath)),
  ]);
  for (const helper of dynHelpers) {
    const useRe = new RegExp(String.raw`${helperCallee(helper)}\s*\((?:[^()]|\([^()]*\))*?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(`, 'g');
    let use;
    while ((use = useRe.exec(code))) {
      const arg = argOf(use);
      if (arg) record(use.index, arg.end - use.index, arg.expr);
    }
  }
  // Stored builders over a dynamic table — `const target = db(table);
  // await target.insert(row);` — the dynamic mirror of the alias pass.
  const dynDeclRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?(?:${SEL_CHAIN}\s*(?:\.\s*(?:table|from)|(?:\?\.)?\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*(?:\?\.)?\(`,
    'g'
  );
  const dynBuilders = new Map(); // name -> table expr
  const dynDecls = new Map(); // name -> declaration indices (keyword start)
  const noteDynDecl = (name, m) => {
    if (!/^(?:const|let|var)\b/.test(m[0])) return;
    if (!dynDecls.has(name)) dynDecls.set(name, new Set());
    dynDecls.get(name).add(m.index);
  };
  let decl;
  while (hasInsert && (decl = dynDeclRe.exec(code))) {
    const arg = argOf(decl);
    if (!arg || !arg.expr.trim() || isResolved(arg.expr)) continue;
    dynBuilders.set(decl[1], arg.expr);
    noteDynDecl(decl[1], decl);
  }
  // Conditional OR logical initializers holding a dynamic builder anywhere
  // — `cond ? db(a) : db(b)`, `enabled && db(table)`, `cached || db(table)`.
  const dynCondDeclRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![^;]{0,200}\bawait\b)[^;?&|]{0,120}(?:\?|&&|\|\|)[^;]{0,160}?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(`,
    'g'
  );
  let cnd;
  while (hasInsert && (cnd = dynCondDeclRe.exec(code))) {
    const arg = argOf(cnd);
    if (!arg || !arg.expr.trim() || isResolved(arg.expr)) continue;
    if (!dynBuilders.has(cnd[1])) dynBuilders.set(cnd[1], arg.expr);
    noteDynDecl(cnd[1], cnd);
  }
  // Builders stored in OBJECT PROPERTIES over a dynamic table —
  // `const queries = { lead: db(table) }; queries.lead.insert(row)`.
  const dynPropDeclRe = new RegExp(
    String.raw`([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(`,
    'g'
  );
  const dynProps = new Map(); // prop -> { expr, owners: Set | null }
  let pdd;
  while (hasInsert && (pdd = dynPropDeclRe.exec(code))) {
    const arg = argOf(pdd);
    if (!arg || !arg.expr.trim() || isResolved(arg.expr)) continue;
    const owner = objectOwner(code, code, pdd.index);
    if (!dynProps.has(pdd[1])) dynProps.set(pdd[1], { expr: arg.expr, owners: owner ? new Set() : null });
    const entry = dynProps.get(pdd[1]);
    if (owner && entry.owners) entry.owners.add(owner);
    else if (!owner) entry.owners = null;
  }
  for (const { owners } of dynProps.values()) if (owners) for (const [a, b] of simpleAssignPairs(code)) if (owners.has(b)) owners.add(a);
  // ONE use regex over all discovered properties (dot or bracket access),
  // accepted only through the property's owning object (or any object when
  // the literal has no declared owner).
  if (dynProps.size) {
    const alt = [...dynProps.keys()].map(escapeRe).join('|');
    const useRe = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*(?:\.\s*(${alt})|(?:\?\.)?\[\s*['"\x60](${alt})['"\x60]\s*\])`, 'g');
    let use;
    while ((use = useRe.exec(code))) {
      const { expr, owners } = dynProps.get(use[2] || use[3]);
      if (owners && !owners.has(use[1])) continue;
      recordChain(use, expr, use.index + use[0].length);
    }
  }
  // Transitive aliases inherit the table expression (in-memory closure
  // over one assignment-pair pass).
  const dynPairs = hasInsert ? simpleAssignPairs(code) : [];
  let grewDyn = true;
  while (grewDyn) {
    grewDyn = false;
    for (const [a, b, declIdx] of dynPairs) {
      if (!dynBuilders.has(b)) continue;
      if (!dynBuilders.has(a)) { dynBuilders.set(a, dynBuilders.get(b)); grewDyn = true; }
      if (declIdx !== null) {
        if (!dynDecls.has(a)) dynDecls.set(a, new Set());
        if (!dynDecls.get(a).has(declIdx)) { dynDecls.get(a).add(declIdx); grewDyn = true; }
      }
    }
  }
  if (dynBuilders.size) {
    const useRe = new RegExp(String.raw`\b(${[...dynBuilders.keys()].map(escapeRe).join('|')})\b`, 'g');
    let use;
    while ((use = useRe.exec(code))) {
      const n = use[1];
      const hit = walkChain(code, use.index + use[0].length, HEAD_STOPS);
      if (!hit || hit.name !== 'insert') continue;
      // Same lexical rule as the literal pass: the nearest VISIBLE
      // declaration of the name must be one of the dynamic-builder ones.
      if (dynDecls.has(n)) {
        const d = nearestVisibleDecl(code, n, use.index);
        if (d !== -1 && !dynDecls.get(n).has(d)) continue;
      }
      record(use.index, hit.open + 1 - use.index, dynBuilders.get(n));
    }
  }
  // Arrow FACTORY over a dynamic table — `const q = (t) => db(t); …
  // q(x).insert(row)` — the dynamic mirror of the literal factory pass.
  const dynFactoryRe = new RegExp(
    String.raw`\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{(?:[^{}]|\{[^{}]*\})*?\breturn\s+)?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?\s*(?:\?\.)?\(`,
    'g'
  );
  let fac;
  while ((fac = dynFactoryRe.exec(code))) {
    const arg = argOf(fac);
    if (!arg || !arg.expr.trim() || isResolved(arg.expr)) continue;
    const useRe = new RegExp(String.raw`\b${escapeRe(fac[1])}\s*(?=\()`, 'g');
    let use;
    while ((use = useRe.exec(code))) {
      const from = afterBalanced(code, use.index + use[0].length);
      if (from !== -1) recordChain(use, arg.expr, from);
    }
  }
  // Function/block-arrow factories over a dynamic table, balanced bodies.
  const dynReturnRe = new RegExp(String.raw`\breturn\b[^;]{0,160}?[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\([^()]*\))?(?:\s*(?:\??\.\s*(?:table|from)|(?:\?\.)?\[\s*['"\x60](?:table|from)['"\x60]\s*\]))?\s*(?:\?\.)?\(`);
  const exprOf = (m) => { const a = argOf(m); return a && a.expr.trim() ? a.expr : null; };
  for (const f of hasInsert ? balancedBodyFactories(code, dynReturnRe, [dynDeclRe, dynCondDeclRe], exprOf) : []) {
    if (!f.capture || isResolved(f.capture)) continue;
    const useRe = new RegExp(String.raw`(?<!function )\b${escapeRe(f.name)}\s*(?=\()`, 'g');
    let use;
    while ((use = useRe.exec(code))) {
      const from = afterBalanced(code, use.index + use[0].length);
      if (from !== -1) recordChain(use, f.capture, from);
    }
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
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?${SQL_SCHEMA}["'\x60]?\$\{([^}]+)\}`, 'gi'),
    // Concatenated target — a bare identifier/member OR a parenthesized
    // expression (`'INSERT INTO ' + (kind ? 'leads' : 'audit')`).
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?(?:(?:"[^"\n]+"|[\w$]+)\.)?['"\x60]\s*\+\s*(\([^()]*\)|[\w$.[\]]+)`, 'gi'),
    // Knex identifier bindings at the table position — positional (??) or
    // named (:table:), with an optional literal schema qualifier
    // (`public.??`) — the bound value is runtime data, so it is dynamic by
    // definition (never resolvable).
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?${SQL_SCHEMA}(\?\?)`, 'gi'),
    new RegExp(String.raw`\b(?:insert|merge(?=[^;]*?\bwhen\s+not\s+matched\b[^;]*?\bthen\s+insert\b))${RAW_SEP}into${RAW_SEP}(?:only${RAW_SEP})?${SQL_SCHEMA}(:[\w$]+:)`, 'gi'),
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
function scanSourceForLeadInserts(src, filePath, imports = 'all') {
  const lines = src.split('\n');
  // Comment-normalized, string-preserving view: an inline comment inside a
  // builder call (`db(/* primary table */ 'leads')`) reads as whitespace,
  // and a comment merely SAYING "insert into leads" is not a site.
  const code = blankComments(src);
  const bare = blankCommentsAndStrings(code);
  const endsByLine = new Map();
  // Every in-file form — builder token, table constant, raw SQL — contains
  // the word `leads`; a file without it can only be a writer through an
  // IMPORTED SQL constant, so the pattern passes are skipped entirely.
  const patterns = /leads/i.test(code) && imports !== 'only' ? [RAW_SQL_INSERT_RE] : [];
  const constOf = new Map();
  const add = (index, len) => {
    const line = code.slice(0, index).split('\n').length;
    if (!endsByLine.has(line)) endsByLine.set(line, new Set());
    endsByLine.get(line).add(index + len);
  };
  for (const { token, name } of /leads/i.test(code) ? leadsTableTokens(code) : []) {
    const group = imports === 'only'
      ? aliasInsertPatterns(code, token, filePath, 'only')
      : [...knexInsertPatterns(token), ...aliasInsertPatterns(code, token, filePath, imports)];
    if (name) for (const p of group) constOf.set(p, name);
    patterns.push(...group);
    if (imports === 'only') continue;
    const tail = new RegExp(String.raw`\s*(${token})${TABLE_OPTS}\)`, 'y');
    for (const f of insertFirstMatches(code, tail)) {
      if (name && !nearestDeclBindsLeads(code, name, f.index)) continue;
      add(f.index, f.length);
    }
  }
  // Lead builders and builder FACTORIES imported from a sibling module —
  // `leadQuery().insert(row)`, `leads.where(x).insert(row)` — need no table
  // token in this file: the module's facts say what they return.
  if (imports !== 'skip') {
    const { factories, builders } = importedLeadBuilders(code, filePath);
    for (const f of factories) patterns.push(Object.assign(new RegExp(String.raw`${helperCallee(f)}\s*(?=\()`, 'g'), { chain: true, callArgs: true }));
    for (const b of builders) patterns.push(chainHead(new RegExp(String.raw`${helperCallee(b)}\b(?!\s*\()`, 'g')));
  }
  // Lead SQL imported as a constant and executed here — directly or as the
  // `text` of an inline pg QueryConfig.
  for (const local of imports === 'skip' ? [] : importedSqlConstants(code, filePath)) {
    const callee = helperCallee(local);
    const re = new RegExp(String.raw`${RAW_CALLEE}\s*(?:${callee}\b(?![.\[])|\{[^{}]*\btext\s*:\s*${callee}\b)`, 'g');
    let m;
    while ((m = re.exec(code))) add(m.index, m[0].length);
  }
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(code))) {
      // The chain walk first — it is cheap and rejects most head matches —
      // then the scope checks, which scan the file.
      let len = m[0].length;
      if (pattern.chain) {
        let from = m.index + m[0].length;
        if (pattern.callArgs) { from = afterBalanced(bare, from); if (from === -1) continue; }
        const hit = walkChain(bare, from, HEAD_STOPS);
        if (!hit || hit.name !== 'insert') continue;
        len = hit.open + 1 - m.index;
      }
      if (pattern === RAW_SQL_INSERT_RE && !inRawContext(code, m.index)) continue;
      if (constOf.has(pattern) && !nearestDeclBindsLeads(code, constOf.get(pattern), m.index)) continue;
      if (pattern.verify && !pattern.verify(m)) continue;
      add(m.index, len);
    }
  }
  return [...endsByLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, ends]) => ({ line, anchor: lines[line - 1].trim(), siteCount: ends.size }));
}

// ONE bounded pass over the server tree, memoized: each file is read once,
// both scans run on it, and its lexer views are released afterwards (the
// blanked views are the memory multiplier — retaining them across ~4k
// files is what made the earlier two-walk version approach a gigabyte).
// A file that never mentions insert/merge cannot hold a site in either
// scan (every builder shape needs an insert call; raw SQL needs INSERT or
// MERGE), so it is skipped before any regex runs. `files` keeps the raw
// sources for the caller-contract test, which needs every source anyway.
let repoScanMemo = null;
function repoScan() {
  if (repoScanMemo) return repoScanMemo;
  const sites = [];
  const dynamic = [];
  const files = [];
  for (const abs of walk(SERVER_ROOT).sort()) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    const src = fs.readFileSync(abs, 'utf8');
    files.push({ rel, src });
    if (SKIP_FILES.has(rel)) continue;
    // What THIS module exports to importers — for every file (a lead-builder
    // factory module has no insert of its own), prechecked inside.
    moduleFactsCache.set(abs, computeModuleFacts(src));
    if (!/insert|merge/i.test(src)) { lexCache.delete(src); functionBodiesCache.delete(src); continue; }
    for (const site of scanSourceForLeadInserts(src, abs, 'skip')) sites.push({ file: rel, ...site });
    for (const site of scanSourceForDynamicTableInserts(src, abs, 'skip')) dynamic.push({ file: rel, ...site });
    for (const cache of [lexCache, functionBodiesCache]) {
      cache.delete(src);
      for (const view of cache.keys()) if (view.length === src.length) cache.delete(view);
    }
  }
  // Phase 2 — CROSS-MODULE writers: a file whose relative imports resolve
  // to an inserting helper, a lead-SQL constant, or a lead builder/factory
  // gets the imported-only patterns run (few files; everything else was
  // settled in phase 1).
  for (const { rel, src } of files) {
    if (SKIP_FILES.has(rel)) continue;
    const abs = path.join(SERVER_ROOT, rel);
    const imports = relativeImports(src, abs);
    if (!imports.some((imp) => { const f = moduleFacts(imp.resolved); return f.helpers.size || f.callableDefault || f.sqlConstants.size || f.factories.size || f.builders.size || f.defaultFactory; })) continue;
    for (const site of scanSourceForLeadInserts(src, abs, 'only')) sites.push({ file: rel, ...site });
    for (const site of scanSourceForDynamicTableInserts(src, abs, 'only')) dynamic.push({ file: rel, ...site });
    for (const cache of [lexCache, functionBodiesCache]) for (const view of cache.keys()) if (view.length === src.length) cache.delete(view);
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  dynamic.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  repoScanMemo = { sites, dynamic, files };
  return repoScanMemo;
}

const key = (site) => `${site.file} :: ${site.anchor}`;

describe('lead insert scanner — supported knex chain shapes (synthetic fixtures)', () => {
  const found = (src, filePath) => scanSourceForLeadInserts(src, filePath).map((s) => s.anchor);

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
    ['deeply nested insert payload before .into', "await db.insert(rows.map(row => normalize(row, opts.get('k')))).into('leads');"],
    ['insert payload before .table', "await db.insert(rows.map(row => normalize(row))).table('leads');"],
    ['escaped newline inside raw SQL', "await db.raw('INSERT\\nINTO leads(name) VALUES (?)', [name]);"],
    ['optional factory invocation before the table', "await getDb?.()('leads').insert(row);"],
    ['punctuated schema in a knex literal', "await db('tenant-one.leads').insert(row);"],
    ['punctuated alias in a knex literal', "await db('leads as lead-row').insert(row);"],
    ['destructured helper parameter', "function writeRow({ qb }, row) { return qb.insert(row); }\nawait writeRow({ qb: db('leads') }, row);"],
    ['SQL returned by a function passed to raw', "function buildInsert() {\n  return 'INSERT INTO leads (a) VALUES (?)';\n}\nawait db.raw(buildInsert(), [a]);"],
    ['SQL built by an arrow passed to query', "const buildInsert = (cols) => 'INSERT INTO leads (' + cols + ') VALUES ($1)';\nawait client.query(buildInsert('a'), [a]);"],
    ['quoted schema with punctuation', "await db.raw('INSERT INTO \"tenant-one\".\"leads\" (a) VALUES (?)', [a]);"],
    ['multi-statement raw SQL', "await db.raw(\"SET search_path = 'public'; INSERT INTO leads(name) VALUES ('x')\");"],
    ['stored table-options object', "const opts = { only: true };\nawait db('leads', opts).insert(row);"],
    ['four-level nested chain arguments', "await db('leads').modify(q => q.whereIn('id', ids.map(x => fn(g(x))))).insert(row);"],
    ['factory call with nested arguments', "function q(opts) { return db('leads'); }\nawait q(build(cfg(a, b), [c])).insert(row);"],
    ['computed SQL constant passed to query', "const SQL = ['INSERT INTO leads (a)', 'VALUES ($1)'].join(' ');\nawait client.query(SQL, [a]);"],
    ['multiline computed SQL constant passed to raw', "const SQL = [\n  'INSERT INTO leads (a)',\n  'VALUES (?)',\n].join(' ');\nawait db.raw(SQL, [a]);"],
    ['optional invocation of the builder callee', "await db?.('leads').insert(row);"],
    ['tagged-template SQL constant passed to raw', "const SQL = String.raw`INSERT INTO leads (a) VALUES (?)`;\nawait db.raw(SQL, [a]);"],
    ['variable-assigned function-expression helper', "const writeRow = function (builder, row) { return builder.insert(row); };\nawait writeRow(db('leads'), row);"],
    ['optional raw invocation', "await client.query?.('INSERT INTO leads (a) VALUES ($1)', [a]);"],
    ['optional raw invocation of a stored constant', "const SQL = 'INSERT INTO leads (a) VALUES ($1)';\nawait db.raw?.(SQL, [a]);"],
    ['optional insert invocation', "await db('leads').insert?.(row);"],
    ['table alias literal', "await db('leads as l').insert(row);"],
    ['table alias in insert-first into', "await db.insert(row).into('leads as l');"],
    ['aliased table constant', "const TABLE = 'leads as l';\nawait db(TABLE).insert(row);"],
    ['schema-qualified table constant', "const TABLE = 'public.leads';\nawait db(TABLE).insert(row);"],
    ['expression-bodied named arrow helper', "const writeRow = (builder, row) => builder.insert(row);\nawait writeRow(db('leads'), row);"],
    ['SQL constant as the text of an inline pg query config', "const SQL = 'INSERT INTO leads (a) VALUES ($1)';\nawait client.query({ text: SQL, values: [a] });"],
    ['SQL constant wrapped into a declared pg query config', "const SQL = 'INSERT INTO leads (a) VALUES ($1)';\nconst cfg = { text: SQL, values: [a] };\nawait client.query(cfg);"],
    ['optional computed insert call', "await db('leads')?.['insert'](row);"],
    ['composed raw: inner call closed, outer still executing', "await db.raw(db.raw('WITH src AS (SELECT 1)').toString() + ' INSERT INTO leads (a) SELECT 1 FROM src');"],
    ['table-options argument', "await db('leads', { only: true }).insert(row);"],
    ['stored builder with table options', "const q = trx('leads', { only: true });\nawait q.insert(row);"],
    ['pg query-config object passed whole', "const cfg = { text: 'INSERT INTO leads (a) VALUES ($1)', values: [a] };\nawait client.query(cfg);"],
    ['native pg query insert', "await client.query('INSERT INTO leads (a) VALUES ($1)', [a]);"],
    ['factory returning a conditionally initialized local alias', "function q() { const base = enabled ? db('leads') : db('audit'); return base; }\nawait q().insert(row);"],
    ['SQL held in an object property passed to raw', "const SQL = { create: 'INSERT INTO leads (a) VALUES (?)' };\nawait db.raw(SQL.create, [a]);"],
    ['SQL constant reaching raw through an alias', "const SQL = 'INSERT INTO leads (a) VALUES (?)';\nconst QUERY = SQL;\nawait db.raw(QUERY, [a]);"],
    ['bracket raw callee', "await db['raw']('INSERT INTO leads (a) VALUES (?)', [a]);"],
    ['stored CTE constant passed to raw', "const SQL = 'WITH src AS (SELECT 1 AS a) INSERT INTO leads (a) SELECT a FROM src';\nawait db.raw(SQL);"],
    ['factory body containing a brace inside a string', "function q() { const marker = '}'; return db('leads'); }\nawait q().insert(row);"],
    ['factory returning a local builder alias', "function q() { const base = db('leads'); return base; }\nawait q().insert(row);"],
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
    ['other property of an SQL object executed, not the leads one', "const SQL = { create: 'INSERT INTO leads (a) VALUES (?)', other: 'SELECT 1' };\nawait db.raw(SQL.other);"],
    ['SQL object property never executed is not a writer', "const SQL = { create: 'INSERT INTO leads (a) VALUES (?)' };\nmodule.exports = { SQL };"],
    ['SQL returned by a function never executed is not a writer', "function buildInsert() {\n  return 'INSERT INTO leads (a) VALUES (?)';\n}\nmodule.exports = { buildInsert };"],
    ['computed SQL constant never executed is not a writer', "const SQL = ['INSERT INTO leads (a)', 'VALUES ($1)'].join(' ');\nmodule.exports = { SQL };"],
    ['same property name on an unrelated object', "const queries = { target: db('leads') };\nconst audits = { target: db('audit') };\nawait audits.target.insert(row);\nawait queries.target.select();"],
    ['alias of another table is not leads', "await db('leads_archive as l').insert(row);"],
    ['raw substring callee is not knex raw', "await draw('INSERT INTO leads (a) VALUES (?)', [a]);"],
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

  test('a sibling-scope declaration does not override the module constant a later use sees', () => {
    const src = "const TABLE = 'leads';\nfunction audit() {\n  const TABLE = 'audit';\n  return TABLE;\n}\nfunction create() {\n  return db(TABLE).insert(row);\n}";
    expect(found(src)).toEqual(['return db(TABLE).insert(row);']);
    const inner = "const TABLE = 'audit';\nfunction create() {\n  const TABLE = 'leads';\n  if (x) {\n    return db(TABLE).insert(row);\n  }\n  return null;\n}";
    expect(found(inner)).toEqual(['return db(TABLE).insert(row);']);
  });

  test('a stored-builder name reused in a sibling scope binds per nearest visible declaration', () => {
    const src = "function read() {\n  const q = db('leads');\n  return q.select();\n}\nfunction audit(row) {\n  const q = db('audit');\n  return q.insert(row);\n}\nfunction create(row) {\n  const q = db('leads');\n  return q.insert(row);\n}";
    expect(found(src)).toEqual(['return q.insert(row);']);
    expect(scanSourceForLeadInserts(src).map((s) => s.line)).toEqual([11]);
    const dyn = scanSourceForDynamicTableInserts("function a() {\n  const q = db(table);\n  return q.insert(x);\n}\nfunction b() {\n  const q = db('audit');\n  return q.insert(y);\n}");
    expect(dyn.map((d) => d.line)).toEqual([3]);
    // Transitive aliases bind where THEY were declared.
    const transitive = "function read() {\n  const base = db('leads');\n  const target = base;\n  return target.select();\n}\nfunction audit(row) {\n  const target = db('audit');\n  return target.insert(row);\n}\nfunction create(row) {\n  const base = db('leads');\n  const target = base;\n  return target.insert(row);\n}";
    expect(scanSourceForLeadInserts(transitive).map((s) => s.line)).toEqual([13]);
    const dynTransitive = scanSourceForDynamicTableInserts("function a() {\n  const base = db(table);\n  const target = base;\n  return target.insert(x);\n}\nfunction b() {\n  const target = db('audit');\n  return target.insert(y);\n}");
    expect(dynTransitive.map((d) => d.line)).toEqual([4]);
  });

  test('insertion helpers imported from a sibling module register at the call site', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-writer-helpers-'));
    fs.writeFileSync(path.join(dir, 'writers.js'), "function writeRow(builder, row) { return builder.insert(row); }\nfunction scoped(qb) { return qb.where('active', true); }\nmodule.exports = { writeRow, scoped };\n");
    const route = path.join(dir, 'route.js');
    expect(found("const { writeRow: write } = require('./writers');\nawait write(db('leads'), row);", route))
      .toEqual(["await write(db('leads'), row);"]);
    expect(found("const { scoped } = require('./writers');\nawait scoped(db('leads'));", route)).toEqual([]);
    const dyn = scanSourceForDynamicTableInserts("import { writeRow } from './writers';\nawait writeRow(db(table), row);", route);
    expect(dyn).toHaveLength(1);
    expect(dyn[0].expr).toBe('table');
    expect(found("const writers = require('./writers');\nawait writers.writeRow(db('leads'), row);", route))
      .toEqual(["await writers.writeRow(db('leads'), row);"]);
    expect(found("import * as writers from './writers';\nawait writers['writeRow'](db('leads'), row);", route))
      .toEqual(["await writers['writeRow'](db('leads'), row);"]);
    expect(found("const writers = require('./writers');\nawait writers.scoped(db('leads'));", route)).toEqual([]);
    const dynNs = scanSourceForDynamicTableInserts("const writers = require('./writers');\nawait writers.writeRow(db(table, { only: true }), row);", route);
    expect(dynNs).toHaveLength(1);
    // Callable DEFAULT exports — the bare local name is the callee.
    fs.writeFileSync(path.join(dir, 'write-row.js'), "module.exports = function writeRow(builder, row) {\n  return builder.insert(row);\n};\n");
    fs.writeFileSync(path.join(dir, 'write-anon.mjs'), "export default async function (builder, row) {\n  return builder.insert(row);\n}\n");
    fs.writeFileSync(path.join(dir, 'read-only.js'), "module.exports = function scoped(qb) {\n  return qb.where('active', true);\n};\n");
    expect(found("const writeRow = require('./write-row');\nawait writeRow(db('leads'), row);", route))
      .toEqual(["await writeRow(db('leads'), row);"]);
    expect(found("const scoped = require('./read-only');\nawait scoped(db('leads'));", route)).toEqual([]);
    const dynDefault = scanSourceForDynamicTableInserts("import write from './write-anon.mjs';\nawait write(db(table), row);", route);
    expect(dynDefault).toHaveLength(1);
    const optionalDyn = scanSourceForDynamicTableInserts("await db(table)?.['insert'](row);");
    expect(optionalDyn).toHaveLength(1);
    // Lead-SQL constants imported from a sibling module.
    fs.writeFileSync(path.join(dir, 'queries.js'), "const CREATE_LEAD = 'INSERT INTO leads (a) VALUES ($1)';\nconst COUNT_LEADS = 'SELECT count(*) FROM leads';\nmodule.exports = { CREATE_LEAD, COUNT_LEADS };\n");
    expect(found("const { CREATE_LEAD } = require('./queries');\nawait client.query(CREATE_LEAD, [a]);", route)).toEqual(['await client.query(CREATE_LEAD, [a]);']);
    expect(found("const q = require('./queries');\nawait db.raw(q.CREATE_LEAD, [a]);", route)).toEqual(['await db.raw(q.CREATE_LEAD, [a]);']);
    expect(found("const { CREATE_LEAD: sql } = require('./queries');\nawait client.query({ text: sql, values: [a] });", route)).toEqual(['await client.query({ text: sql, values: [a] });']);
    expect(found("const { COUNT_LEADS } = require('./queries');\nawait db.raw(COUNT_LEADS);", route)).toEqual([]);
    expect(found("const { CREATE_LEAD } = require('./queries');\nmodule.exports = { CREATE_LEAD };", route)).toEqual([]);
    // Arrow-valued default exports, expression and block bodies.
    fs.writeFileSync(path.join(dir, 'write-arrow.js'), "module.exports = (builder, row) => builder.insert(row);\n");
    fs.writeFileSync(path.join(dir, 'write-arrow-block.mjs'), "export default async (builder, row) => {\n  audit();\n  return builder.insert(row);\n};\n");
    expect(found("const write = require('./write-arrow');\nawait write(db('leads'), row);", route)).toEqual(["await write(db('leads'), row);"]);
    const dynArrow = scanSourceForDynamicTableInserts("import write from './write-arrow-block.mjs';\nawait write(db(table), row);", route);
    expect(dynArrow).toHaveLength(1);
    const dynExprArrow = scanSourceForDynamicTableInserts("const writeRow = (builder, row) => builder.insert(row);\nawait writeRow(db(table), row);");
    expect(dynExprArrow).toHaveLength(1);
    // BARRELS re-exporting a helper module carry its facts.
    fs.writeFileSync(path.join(dir, 'barrel.js'), "module.exports = require('./writers');\n");
    fs.writeFileSync(path.join(dir, 'barrel-spread.js'), "module.exports = { ...require('./writers'), extra: 1 };\n");
    fs.writeFileSync(path.join(dir, 'barrel.mjs'), "export * from './writers';\n");
    expect(found("const { writeRow } = require('./barrel');\nawait writeRow(db('leads'), row);", route)).toEqual(["await writeRow(db('leads'), row);"]);
    expect(found("const { writeRow } = require('./barrel-spread');\nawait writeRow(db('leads'), row);", route)).toEqual(["await writeRow(db('leads'), row);"]);
    expect(found("import { writeRow } from './barrel.mjs';\nawait writeRow(db('leads'), row);", route)).toEqual(["await writeRow(db('leads'), row);"]);
    // Local export ALIASES — the fact travels under the exported name.
    fs.writeFileSync(path.join(dir, 'alias-exports.js'), "function writeRow(qb, row) {\n  return qb.insert(row);\n}\nconst leadQuery = () => db('leads');\nexports.persist = writeRow;\nmodule.exports = { save: writeRow, leadQ: leadQuery, leadQuery };\n");
    expect(found("const { save } = require('./alias-exports');\nawait save(db('leads'), row);", route)).toEqual(["await save(db('leads'), row);"]);
    expect(found("const { persist } = require('./alias-exports');\nawait persist(db('leads'), row);", route)).toEqual(["await persist(db('leads'), row);"]);
    expect(found("const { leadQ } = require('./alias-exports');\nawait leadQ().insert(row);", route)).toEqual(['await leadQ().insert(row);']);
    fs.writeFileSync(path.join(dir, 'queries.mjs'), "export const CREATE_LEAD = 'INSERT INTO leads (a) VALUES ($1)';\nexport default { CREATE_LEAD };\n");
    expect(found("import defaults, { CREATE_LEAD } from './queries.mjs';\nawait client.query(CREATE_LEAD, [a]);", route)).toEqual(['await client.query(CREATE_LEAD, [a]);']);
    fs.writeFileSync(path.join(dir, 'barrel-renamed.mjs'), "export { writeRow as save, scoped } from './writers';\n");
    expect(found("import { save } from './barrel-renamed.mjs';\nawait save(db('leads'), row);", route)).toEqual(["await save(db('leads'), row);"]);
    expect(found("import { writeRow } from './barrel-renamed.mjs';\nawait writeRow(db('leads'), row);", route)).toEqual([]);
    // Lead-builder FACTORIES and stored lead builders exported by a sibling
    // module — neither file alone shows table + insert.
    fs.writeFileSync(path.join(dir, 'lead-query.js'), "const leadQuery = () => db('leads');\nfunction leadsIn(trx) {\n  return trx('leads');\n}\nconst leads = db('leads');\nconst auditQuery = () => db('audit');\nmodule.exports = { leadQuery, leadsIn, leads, auditQuery };\n");
    fs.writeFileSync(path.join(dir, 'lead-default.js'), "module.exports = () => db('leads');\n");
    expect(found("const { leadQuery } = require('./lead-query');\nawait leadQuery().insert(row);", route)).toEqual(['await leadQuery().insert(row);']);
    expect(found("const { leadsIn } = require('./lead-query');\nawait leadsIn(trx).where('id', 1).insert(row);", route)).toEqual(["await leadsIn(trx).where('id', 1).insert(row);"]);
    expect(found("const { leads } = require('./lead-query');\nawait leads.where({ id }).insert(row);", route)).toEqual(['await leads.where({ id }).insert(row);']);
    expect(found("const q = require('./lead-query');\nawait q.leadQuery().insert(row);", route)).toEqual(['await q.leadQuery().insert(row);']);
    expect(found("const leadQuery = require('./lead-default');\nawait leadQuery().insert(row);", route)).toEqual(['await leadQuery().insert(row);']);
    expect(found("const { leadQuery, auditQuery } = require('./lead-query');\nawait leadQuery().select();\nawait auditQuery().insert(row);", route)).toEqual([]);
    // Property-assigned CommonJS helpers and object-literal helper properties.
    fs.writeFileSync(path.join(dir, 'exports-helpers.js'), "exports.save = (builder, row) => builder.insert(row);\nmodule.exports.saveMany = function (qb, rows) {\n  return qb.insert(rows);\n};\nexports.scopedOnly = (qb) => qb.where('active', true);\n");
    fs.writeFileSync(path.join(dir, 'object-helpers.js'), "module.exports = {\n  save: async (builder, row) => {\n    return builder.insert(row);\n  },\n};\n");
    expect(found("const { save } = require('./exports-helpers');\nawait save(db('leads'), row);", route)).toEqual(["await save(db('leads'), row);"]);
    expect(found("const { scopedOnly } = require('./exports-helpers');\nawait scopedOnly(db('leads'));", route)).toEqual([]);
    expect(found("const { save } = require('./object-helpers');\nawait save(db('leads'), row);", route)).toEqual(["await save(db('leads'), row);"]);
    const dynSaveMany = scanSourceForDynamicTableInserts("const writers = require('./exports-helpers');\nawait writers.saveMany(db(table), rows);", route);
    expect(dynSaveMany).toHaveLength(1);
  });

  test('var is function-scoped: a block-nested var shadows through its block, not past its function', () => {
    const hoisted = "const TABLE = 'audit';\nfunction create() {\n  {\n    var TABLE = 'leads';\n  }\n  return db(TABLE).insert(row);\n}";
    expect(found(hoisted)).toEqual(['return db(TABLE).insert(row);']);
    const sibling = "const TABLE = 'leads';\nfunction audit() {\n  var TABLE = 'audit';\n  return TABLE;\n}\nfunction create() {\n  return db(TABLE).insert(row);\n}";
    expect(found(sibling)).toEqual(['return db(TABLE).insert(row);']);
    const control = "const TABLE = 'leads';\nfunction create() {\n  if (x) {\n    var TABLE = 'audit';\n  }\n  return db(TABLE).insert(entry);\n}";
    expect(found(control)).toEqual([]);
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
    const bracketProp = scanSourceForDynamicTableInserts("const queries = { lead: db(table) };\nawait queries['lead'].insert(row);");
    expect(bracketProp).toHaveLength(1);
    expect(bracketProp[0].expr).toBe('table');
    const bracketFrom = scanSourceForDynamicTableInserts("await db['from'](table).insert(row);");
    expect(bracketFrom).toHaveLength(1);
    const localAlias = scanSourceForDynamicTableInserts('function q() { const base = db(table); return base; }\nawait q().insert(row);');
    expect(localAlias).toHaveLength(1);
    expect(localAlias[0].expr).toBe('table');
    const logical = scanSourceForDynamicTableInserts('const target = enabled && db(table);\nif (target) await target.insert(row);');
    expect(logical).toHaveLength(1);
    expect(logical[0].expr).toBe('table');
    const deepPayload = scanSourceForDynamicTableInserts('await db.insert(rows.map(row => normalize(row, opts.get(k)))).into(table);');
    expect(deepPayload).toHaveLength(1);
    expect(deepPayload[0].expr).toBe('table');
    const defaultParam = scanSourceForDynamicTableInserts("const TABLE = 'audit';\nfunction write(TABLE = resolveTable(kind), row) {\n  return db(TABLE).insert(row);\n}");
    expect(defaultParam).toHaveLength(1);
    const optionalFactory = scanSourceForDynamicTableInserts('await getDb?.()(table).insert(row);');
    expect(optionalFactory).toHaveLength(1);
    const destructuredHelper = scanSourceForDynamicTableInserts('function writeRow({ qb }, row) { return qb.insert(row); }\nawait writeRow({ qb: db(table) }, row);');
    expect(destructuredHelper).toHaveLength(1);
    const chainedSelector = scanSourceForDynamicTableInserts('await db.withSchema(schema).table(table).insert(row);');
    expect(chainedSelector).toHaveLength(1);
    expect(chainedSelector[0].expr).toBe('table');
    const sqlFn = scanSourceForDynamicTableInserts('function buildInsert(table) {\n  return `INSERT INTO ${table} (a) VALUES (?)`;\n}\nawait db.raw(buildInsert(kind), [a]);');
    expect(sqlFn).toHaveLength(1);
    const deepArg = scanSourceForDynamicTableInserts("await db(resolveTable(normalize(config.get('kind')))).insert(row);");
    expect(deepArg).toHaveLength(1);
    const storedOpts = scanSourceForDynamicTableInserts('const opts = { only: true };\nawait db(table, opts).insert(row);');
    expect(storedOpts).toHaveLength(1);
    expect(storedOpts[0].expr).toBe('table');
    const threeArgs = scanSourceForDynamicTableInserts('await helper(table, rows, chunk).insert(row);');
    expect(threeArgs).toHaveLength(0);
    const deepChain = scanSourceForDynamicTableInserts('await db(table).modify(q => q.whereIn(\'id\', ids.map(x => fn(g(h(x)))))).insert(row);');
    expect(deepChain).toHaveLength(1);
    const optionalCallee = scanSourceForDynamicTableInserts('await db?.(table).insert(row);');
    expect(optionalCallee).toHaveLength(1);
    const ownedProp = scanSourceForDynamicTableInserts("const queries = { target: db(table) };\nconst audits = { target: db('audit') };\nawait audits.target.insert(row);\nawait queries.target.insert(row);");
    expect(ownedProp.map((d) => d.line)).toEqual([4]);
    const fnExprHelper = scanSourceForDynamicTableInserts('const writeRow = function (builder, row) { return builder.insert(row); };\nawait writeRow(db(table), row);');
    expect(fnExprHelper).toHaveLength(1);
    const inlineShadow = scanSourceForDynamicTableInserts("const TABLE = 'audit';\nfunction write(row) { const TABLE = requestedTable; return db(TABLE).insert(row); }");
    expect(inlineShadow).toHaveLength(1);
    const commentedConst = scanSourceForDynamicTableInserts("/* e.g. const TARGET_TABLE = 'audit'; */\nconst TARGET_TABLE = getConfiguredTable();\nawait db(TARGET_TABLE).insert(row);");
    expect(commentedConst).toHaveLength(1);
    expect(commentedConst[0].expr).toBe('TARGET_TABLE');
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
  let scanned;
  beforeAll(() => { scanned = repoScan().sites; });

  test('scanner finds the known writer population (sanity — not a cap)', () => {
    // Guards against the scan silently returning nothing (regex drift, wrong
    // root). The exact set is asserted below; this only proves the scan ran.
    expect(scanned.length).toBeGreaterThanOrEqual(10);
    expect(scanned.some((s) => s.file === 'services/call-recording-processor.js')).toBe(true);
  });

  test('every dynamic-table insert is allowlisted with a never-leads reason (and the allowlist is live)', () => {
    const { dynamic } = repoScan();
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
    const { files } = repoScan();
    const leadsShaped = (t) => /^(?:[^.\s]+\.)?leads$/i.test(t);
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
        // …and the binding must be UNIQUE: a second same-named const (an
        // inner `const TYPES = { … }` nearer the writer) or a parameter
        // named after the object would shadow the literals inspected here.
        const bindings = bare.match(new RegExp(String.raw`\b(?:const|let|var)\s+(?:\{[^{}]*\b)?${escapeRe(cc.object)}\b`, 'g')) || [];
        expect({ file: w.file, object: cc.object, bindings: bindings.length }).toEqual({ file: w.file, object: cc.object, bindings: 1 });
        const shadowParam = bare.match(new RegExp(String.raw`[(,]\s*(?:\{[^{}]*)?\b${escapeRe(cc.object)}\b(?:[^()]|\([^()]*\))*\)\s*(?:=>|\{)|\b${escapeRe(cc.object)}\s*=>`));
        expect({ file: w.file, object: cc.object, shadowParam: shadowParam && shadowParam[0].trim() })
          .toEqual({ file: w.file, object: cc.object, shadowParam: null });
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
          // Plain `=` and every COMPOUND assignment (`&&=`, `||=`, `??=`,
          // `+=`, …) — `config.table &&= 'leads'` retargets the writer too —
          // and Object.* / Reflect.* reflective writes.
          String.raw`\b${escapeRe(name)}\b\s*(?:\.[\w$]+|\[[^\]]*\])+\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*\/%&|^])?=(?!=)|(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\s*\.\s*(?:set|defineProperty|deleteProperty|setPrototypeOf))\s*\([^)]*\b${escapeRe(name)}\b`
        );
        const mutation = bare.match(mutationReFor(cc.object));
        expect({ file: w.file, mutation: mutation && mutation[0].trim() })
          .toEqual({ file: w.file, mutation: null });
        // Mutations THROUGH aliases too — followed TRANSITIVELY to a
        // fixpoint: `const cfg = TYPES.lawn; const alias = cfg;
        // alias.table = x` is caught because `alias` inherits governed
        // status from `cfg`, which inherits it from the object.
        const governed = new Set([cc.object]);
        const inFileFunctions = new Map(balancedFunctionBodies(bare).map((f) => [f.name, f]));
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
            // PASSED AS A WHOLE ARGUMENT — `loadRow(config, id)` binds the
            // callee's parameter at that position, which is then governed
            // (its own property writes are checked). A callee this file
            // cannot inspect (imported, or a member call) is an unverified
            // escape and fails outright.
            for (const { callee, position } of wholeArgumentPasses(bare, name, new Set(cc.props))) {
              const fn = inFileFunctions.get(callee);
              expect({ file: w.file, governed: name, passedTo: callee, inspectable: Boolean(fn) })
                .toEqual({ file: w.file, governed: name, passedTo: callee, inspectable: true });
              const param = fn.params[position];
              if (param && !governed.has(param)) { governed.add(param); grew = true; }
            }
          }
        }
        // A CLONE of a governed value (`{ ...TYPES[type], table: 'leads' }`)
        // can override the table inside the literal, where no property
        // write exists to catch — so a governed value may not be spread
        // anywhere in the file.
        for (const name of governed) {
          const spread = bare.match(new RegExp(String.raw`\.\.\.\s*${escapeRe(name)}\b(?:\s*(?:\.[\w$]+|\[[^\]]*\]))*`));
          expect({ file: w.file, governed: name, spread: spread && spread[0].trim() })
            .toEqual({ file: w.file, governed: name, spread: null });
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
        const bracketRef = blankComments(fileSrc).match(new RegExp(String.raw`(?:\?\.)?\[\s*['"\x60]${escapeRe(cc.helper)}['"\x60]\s*\]`));
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
          const bracket = blankComments(src).match(new RegExp(String.raw`(?:\?\.)?\[\s*['"\x60]${escapeRe(cc.helper)}['"\x60]\s*\]`));
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
      const id = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // The bare occurrence is not enough (a payload field named like the
      // resolver proves nothing): the resolver must be CALLED, or take part
      // in a branch / lookup condition — an if/while/ternary/logical guard
      // or a where-family / first lookup — on a line before the insert.
      // A DEFINITION of the identifier is not a call: `function createLead(`
      // (the enclosing header) and method-shorthand headers are blanked
      // before the call check.
      const noDefs = span
        .replace(new RegExp(String.raw`\bfunction\s+${id}\s*\(`, 'g'), 'function (')
        .replace(new RegExp(String.raw`^(\s*)(?:async\s+)?${id}\s*\([^()]*\)\s*\{`, 'gm'), '$1{');
      const called = new RegExp(String.raw`\b${id}\s*(?:\?\.)?\(`).test(noDefs);
      const guarding = span.split('\n').some((line) => new RegExp(String.raw`\b${id}\b`).test(line)
        && /\b(?:if|while)\s*\(|\?[^.?]|&&|\|\||\?\?|\.\s*(?:where\w*|orWhere\w*|andWhere\w*|first|findOne|whereIn|whereNotIn)\s*\(/.test(line));
      const referenced = called || guarding;
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

