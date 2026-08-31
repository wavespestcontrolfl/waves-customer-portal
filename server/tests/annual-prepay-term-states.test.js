/**
 * Guard test for the annual-prepay term state machine documented in
 * docs/annual-prepay-term-states.md.
 *
 * Three things must stay in lockstep — the DB CHECK (which names exist), the
 * code (which names are actually written, and the transition functions'
 * guards), and the doc (which moves are allowed). This test fails when any
 * one drifts without the others: a new status write to annual_prepay_terms
 * anywhere under server/ or ops/, a CHECK edit, a transition guard loosened,
 * or a doc that stops listing a stage.
 *
 * It deliberately does NOT restructure annual-prepay-renewals.js — the guard
 * reads the module as-is.
 *
 * SCOPE: the writer scan covers production files that NAME the table — every
 * literal-table Knex shape is classified (or fails closed), raw SQL and
 * table-name indirection defined in such a file fail closed, and dynamic-
 * table mutations are allowlisted per audited file with a site-count
 * ratchet. A hypothetical generic cross-file helper (`updateTable(name,
 * payload)` living in a file that never names this table) is outside
 * textual reach BY CONSTRUCTION; none exists in the codebase (verified
 * 2026-08-31), and introducing one is exactly the "new mechanism" that
 * CLAUDE.md rule 15 and PR review police. This suite is defense-in-depth
 * for drift, not a parser-grade proof.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
  WAVEGUARD_EXTENSION_RESTORE_BY: 'system:waveguard_tier_extension_restore',
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));

const db = require('../models/db');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MIGRATION = 'server/models/migrations/20260614000001_annual_prepay_terms_checks.js';
const DOC = 'docs/annual-prepay-term-states.md';
const TABLE = 'annual_prepay_terms';

// The state machine as documented. Changing these lists means changing the
// doc (and, for WRITTEN, the code) in the same PR.
const WRITTEN_STATUSES = ['payment_pending', 'active', 'renewal_pending', 'cancelled', 'renewed', 'switch_plan'];
const LEGACY_ONLY_STATUSES = ['canceled', 'refunded']; // in the CHECK, never written
const ACTIVE_STATUSES = ['active', 'renewal_pending'];

// Non-literal `status:` expressions the scanner accepts, each one a pass-
// through of a value that is itself CHECK-valid: a constant pinned below, the
// output of invoiceTermStatus / statusAfterDecision, or the row's own status
// being carried/restored. Anything else is an undocumented write.
const KNOWN_STATUS_EXPRESSIONS = {
  PAYMENT_PENDING_STATUS: ['payment_pending'],
  // invoiceTermStatus(...) result — its full range is behaviorally pinned in
  // the invoiceTermStatus test below; widening it there must widen this too.
  nextStatus: ['payment_pending', 'active', 'cancelled'],
  // Behaviorally pinned by the recordDecision test.each over all 4 actions.
  'statusAfterDecision(action)': ['renewal_pending', 'renewed', 'cancelled', 'switch_plan'],
  // Row-status pass-throughs: the value was read from the column, so it is
  // whatever the CHECK already allowed — carried, not chosen.
  previousStatus: WRITTEN_STATUSES,           // sendCustomerTermNotice release
  'term.status': WRITTEN_STATUSES,            // carried through (ternary else)
  'existing.status': WRITTEN_STATUSES,        // createTerm keeps decided status
};

function migrationCheckStatuses() {
  const src = read(MIGRATION);
  const m = src.match(/const TERM_STATUSES = \[([\s\S]*?)\];/);
  if (!m) throw new Error('TERM_STATUSES not found in the checks migration');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

// Every production .js file under server/ and ops/ that names the table.
// Tests and migrations are excluded (migrations are the CHECK side, tests
// are not writers).
function writerCandidateFiles() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'tests' || ent.name === 'migrations' || ent.name === '__tests__') continue;
        walk(full);
      } else if (ent.name.endsWith('.js') && !ent.name.endsWith('.test.js')) {
        // Case-insensitive: raw SQL may name the table in uppercase.
        if (fs.readFileSync(full, 'utf8').toLowerCase().includes(TABLE)) out.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  walk(path.join(ROOT, 'ops'));
  return out.sort();
}

// For one source file: every `status:` expression written through an
// `.update(...)` / `.insert(...)` on a builder chain that started with
// `('annual_prepay_terms')`. `.update(identifier)` resolves the identifier
// to a `const identifier = { ... }` object in the same file.
// The builder chain runs from `('annual_prepay_terms')` to the first `;` at
// paren/brace depth zero — a `;` inside a `.where(function () { …; })`
// callback does not end it.
// Walk text skipping string literals ('…', "…", `…` incl. escapes) and
// comments, calling cb(ch, i) for each syntactic character. Keeps the
// delimiter walkers from counting brackets inside strings/comments.
function walkSyntax(text, start, cb) {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1;
        else if (text[i] === ch) break;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i === -1) return; continue; }
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i); if (i === -1) return; i += 1; continue; }
    if (cb(ch, i) === false) return;
  }
}

function chainAfter(src, start) {
  let depth = 0;
  let end = src.length;
  walkSyntax(src, start, (ch, i) => {
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ';' && depth <= 0) { end = i; return false; }
    return true;
  });
  return src.slice(start, end);
}

// The WHERE guards attached to the same builder chain as a status write,
// normalized to compact strings so each documented move's guard can be
// pinned exactly.
function chainGuards(chain) {
  const upTo = chain.search(/\.(?:update|insert)\(/);
  const head = upTo === -1 ? chain : chain.slice(0, upTo);
  // orWhere* included: appending an OR branch loosens a guard and must
  // change the pinned array.
  return [...head.matchAll(/\.((?:orW|w)here(?:In|NotIn|Null|NotNull|Not)?)\(([^)]*)/g)]
    .map((g) => `${g[1]}(${g[2].replace(/\s+/g, ' ').trim()})`);
}

function statusWriteExpressions(src) {
  return statusWriteSites(src).map((s) => s.expr);
}

function statusWriteSites(src) {
  const out = [];
  // Matches aliased builders too: ('annual_prepay_terms as t').
  const chainRe = new RegExp(`\\(['"\`]${TABLE}(?:\\s+as\\s+\\w+)?['"\`]\\)`, 'g');
  // Value runs to the next `, key:` or the end of the object body — a ternary
  // (`a ? 'x' : b`) has no comma, so it survives whole.
  const objectStatuses = (body, guards) => {
    // Fail closed on write-object shapes the scanner cannot classify:
    // shorthand `{ status }`, computed `['status']:`, and spreads (which can
    // smuggle a status from anywhere).
    if (/\.\.\./.test(body)) out.push({ expr: '<spread in write object>', guards });
    if (/\[\s*['"]status['"]\s*\]\s*:/.test(body)) out.push({ expr: '<computed status key>', guards });
    // Identifier-computed keys (`[column]: …`) could be 'status' at runtime.
    // The only sanctioned identifiers are the *Col notice/reminder column
    // helpers, whose outputs are behaviorally pinned non-status below.
    for (const k of body.matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:/g)) {
      if (!/Col$/.test(k[1])) out.push({ expr: `<computed identifier key ${k[1]}>`, guards });
    }
    if (/(?:^|,|\{)\s*status\s*(?:,|$)/.test(body.trim())) out.push({ expr: '<shorthand status key>', guards });
    for (const s of body.matchAll(/(?:\b|['"])status['"]?\s*:\s*((?:[^,\n]|,(?!\s*['"[\]\w]+\s*:))+)/g)) {
      out.push({ expr: s[1].replace(/,\s*$/, '').trim(), guards });
    }
  };
  // Balanced-paren argument text of a call starting at `(` — string/comment
  // aware, so a ')' inside a note string cannot truncate the span.
  const argSpan = (text, openIdx) => {
    let depth = 0;
    let end = -1;
    walkSyntax(text, openIdx, (ch, i) => {
      if ('({['.includes(ch)) depth += 1;
      else if (')}]'.includes(ch)) { depth -= 1; if (depth === 0) { end = i; return false; } }
      return true;
    });
    return end === -1 ? text.slice(openIdx + 1) : text.slice(openIdx + 1, end);
  };
  // Classify one update/insert argument list. Every Knex mutation shape is
  // either understood or pushed as an unclassifiable marker — never skipped.
  const classifyWriteArgs = (args, guards, declIndex) => {
    const a = args.trim();
    if (a.startsWith('{')) {
      // Object (optionally followed by a returning-columns arg, which cannot
      // carry a status write).
      objectStatuses(argSpan(a, 0), guards);
      return;
    }
    if (a.startsWith('[')) {
      // Array-of-rows insert.
      const inner = argSpan(a, 0);
      let found = false;
      for (const o of inner.matchAll(/\{([\s\S]*?)\}/g)) { objectStatuses(o[1], guards); found = true; }
      if (!found) out.push({ expr: `<unclassifiable write args: ${a.slice(0, 40)}>`, guards });
      return;
    }
    const colForm = a.match(/^['"]([\w]+)['"]\s*,\s*([\s\S]+)$/);
    if (colForm) {
      // Two-arg column form: .update('status', value).
      if (colForm[1] === 'status') out.push({ expr: colForm[2].trim(), guards });
      return;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(a)) {
      // Identifier: nearest `const <id> = {` BEFORE this chain (the same name
      // is declared more than once in the module, e.g. recordDecision's two
      // `update`s).
      const declStart = src.slice(0, declIndex).lastIndexOf(`const ${a} = {`);
      const body = declStart === -1 ? null : src.slice(declStart).match(/\{([\s\S]*?)\};/);
      if (!body) { out.push({ expr: `<unresolved object ${a}>`, guards }); return; }
      objectStatuses(body[1], guards);
      // Post-init mutations of the payload (`x.status = …`, `x[expr] = …`)
      // would not appear in the initializer — capture or fail closed.
      for (const asn of src.matchAll(new RegExp(`\\b${a}\\.status\\s*=\\s*([^;\\n]+)`, 'g'))) {
        out.push({ expr: asn[1].trim(), guards });
      }
      if (new RegExp(`\\b${a}\\[`).test(src)) {
        out.push({ expr: `<computed assignment to write object ${a}>`, guards });
      }
      return;
    }
    out.push({ expr: `<unclassifiable write args: ${a.slice(0, 40)}>`, guards });
  };
  const scanChain = (chain, declIndex, guards = chainGuards(chain)) => {
    for (const w of chain.matchAll(/\.(?:update|insert|merge)\s*\(/g)) {
      const args = argSpan(chain, w.index + w[0].length - 1);
      // `.onConflict().merge()` with no args re-uses the insert values, which
      // the insert scan already classified.
      if (!args.trim()) continue;
      classifyWriteArgs(args, guards, declIndex);
    }
  };
  for (const m of src.matchAll(chainRe)) {
    scanChain(chainAfter(src, m.index + m[0].length), m.index);
  }
  // Split builders: `const q = db('annual_prepay_terms'); … q.update({...});`
  const splitRe = new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:await\\s+)?[\\w$.]+\\(['"\`]${TABLE}(?:\\s+as\\s+\\w+)?['"\`]\\)`, 'g');
  for (const m of src.matchAll(splitRe)) {
    const rest = src.slice(m.index + m[0].length);
    for (const w of rest.matchAll(new RegExp(`\\b${m[1]}\\s*\\.\\s*(?:[\\w$]+\\([^()]*\\)\\s*\\.\\s*)*(?:update|insert|merge)\\s*\\(`, 'g'))) {
      const args = argSpan(rest, w.index + w[0].length - 1);
      if (!args.trim()) continue; // bare merge() reuses already-scanned insert values
      classifyWriteArgs(args, ['<split-builder>'], m.index);
    }
  }
  return out;
}

// Resolve one written expression to the set of statuses it can produce, or
// null when it is not something this guard understands.
function resolveStatusExpression(expr) {
  // A ternary produces only its two branches; the condition is a comparison,
  // not a written value. Nested ternaries are not used in this codebase.
  const q = expr.indexOf('?');
  const branches = q === -1 ? [expr] : expr.slice(q + 1).split(':');
  const set = new Set();
  for (let branch of branches) {
    branch = branch.trim();
    if (/^['"][a-z_]+['"]$/.test(branch)) { set.add(branch.slice(1, -1)); continue; }
    if (KNOWN_STATUS_EXPRESSIONS[branch]) { KNOWN_STATUS_EXPRESSIONS[branch].forEach((s) => set.add(s)); continue; }
    return null; // a value source this guard does not know — document it and add it above
  }
  return set.size ? [...set] : null;
}

describe('the write scanner itself (negative fixtures — alternate write forms cannot escape)', () => {
  test('catches a plain literal write', () => {
    expect(statusWriteExpressions("await db('annual_prepay_terms').where({ id }).update({ status: 'canceled', updated_at: now });"))
      .toEqual(["'canceled'"]);
  });

  test('catches .from(…) and template-literal table names (the chain match keys on the call, not the method)', () => {
    expect(statusWriteExpressions("await db.from('annual_prepay_terms').update({ status: 'refunded' });"))
      .toEqual(["'refunded'"]);
    expect(statusWriteExpressions('await db(`annual_prepay_terms`).update({ status: \'canceled\' });'))
      .toEqual(["'canceled'"]);
  });

  test('catches an ALIASED builder write', () => {
    expect(statusWriteExpressions("await trx('annual_prepay_terms as apt').where({ id }).update({ status: 'refunded' });"))
      .toEqual(["'refunded'"]);
  });

  test('catches an object-variable write and a multi-line chain with an inner callback semicolon', () => {
    const src = [
      "const payload = { status: 'refunded', updated_at: now };",
      "await conn('annual_prepay_terms')",
      '  .where(function avail() { this.whereNull(col).orWhere(col, "<", cutoff); })',
      '  .update(payload)',
      "  .returning('*');",
    ].join('\n');
    expect(statusWriteExpressions(src)).toEqual(["'refunded'"]);
  });

  test('catches a SPLIT builder (chain assigned to a variable, written later)', () => {
    const src = "const q = db('annual_prepay_terms');\nawait q.update({ status: 'canceled' });";
    expect(statusWriteExpressions(src)).toEqual(["'canceled'"]);
    const aliased = "let apt = trx('annual_prepay_terms as t');\napt.update({ status: 'refunded', updated_at: now });";
    expect(statusWriteExpressions(aliased)).toEqual(["'refunded'"]);
    const splitMerge = "const q = db('annual_prepay_terms').insert({ id });\nawait q.onConflict('id').merge({ status: 'refunded' });";
    expect(statusWriteExpressions(splitMerge)).toEqual(["'refunded'"]);
  });

  test('an unknown value source resolves to null (fails the lockstep test) instead of passing silently', () => {
    expect(resolveStatusExpression('computeSomething(row)')).toBeNull();
    expect(resolveStatusExpression("cond ? 'active' : mysteryVar")).toBeNull();
    expect(statusWriteExpressions("await db('annual_prepay_terms').update(mystery);"))
      .toEqual(['<unresolved object mystery>']);
  });

  test('other Knex mutation shapes are classified, never skipped', () => {
    expect(statusWriteExpressions("await db('annual_prepay_terms').update('status', 'refunded');"))
      .toEqual(["'refunded'"]);
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ status: 'refunded' }, ['id']);"))
      .toEqual(["'refunded'"]);
    expect(statusWriteExpressions("await db('annual_prepay_terms').insert([{ status: 'refunded' }, { status: 'canceled' }]);"))
      .toEqual(["'refunded'", "'canceled'"]);
    expect(statusWriteExpressions("await db('annual_prepay_terms').update('notes', 'x');"))
      .toEqual([]); // two-arg form on a non-status column is not a status write
    expect(statusWriteExpressions("await db('annual_prepay_terms').update(buildPayload(term));"))
      .toEqual(['<unclassifiable write args: buildPayload(term)>']);
    // Quoted property keys.
    expect(statusWriteExpressions('await db(\'annual_prepay_terms\').update({ "status": "refunded" });'))
      .toEqual(['"refunded"']);
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ 'status': 'canceled' });"))
      .toEqual(["'canceled'"]);
    // Upsert merge carrying a status.
    expect(statusWriteExpressions("await db('annual_prepay_terms').insert({ id }).onConflict('id').merge({ status: 'refunded' });"))
      .toEqual(["'refunded'"]);
  });

  test('shorthand, computed-key, and spread write objects fail closed instead of slipping through', () => {
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ status });"))
      .toEqual(['<shorthand status key>']);
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ ['status']: 'refunded' });"))
      .toEqual(['<computed status key>']);
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ ...payload, updated_at: now });"))
      .toEqual(['<spread in write object>']);
    // But a plain object with other keys and no status stays silent.
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ updated_at: now });"))
      .toEqual([]);
    // Identifier-computed key that could be 'status' at runtime.
    expect(statusWriteExpressions("const column = 'status';\nawait db('annual_prepay_terms').update({ [column]: 'refunded' });"))
      .toEqual(['<computed identifier key column>']);
    // Sanctioned *Col identifiers (notice/reminder columns, pinned non-status) pass.
    expect(statusWriteExpressions("await db('annual_prepay_terms').update({ [claimCol]: now });"))
      .toEqual([]);
    // Post-init payload mutation.
    expect(statusWriteExpressions("const payload = { updated_at: now };\npayload.status = 'refunded';\nawait db('annual_prepay_terms').update(payload);"))
      .toEqual(["'refunded'"]);
    expect(statusWriteExpressions("const payload = { updated_at: now };\npayload[column] = value;\nawait db('annual_prepay_terms').update(payload);"))
      .toEqual(['<computed assignment to write object payload>']);
  });
});

describe('annual-prepay term states — CHECK ↔ code ↔ doc', () => {
  test('the DB CHECK is exactly the written stages plus the two legacy names', () => {
    const inCheck = migrationCheckStatuses().sort();
    expect(inCheck).toEqual([...WRITTEN_STATUSES, ...LEGACY_ONLY_STATUSES].sort());
  });

  test('the pinned migration is still the ONLY one defining the status CHECK (a later re-definition must update this suite + doc)', () => {
    const dir = path.join(ROOT, 'server', 'models', 'migrations');
    const definers = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('annual_prepay_terms_status_check'));
    expect(definers).toEqual(['20260614000001_annual_prepay_terms_checks.js']);
  });

  test('every status written to annual_prepay_terms anywhere in server/ or ops/ resolves to a documented written stage', () => {
    const files = writerCandidateFiles();
    // Sanity: discovery actually found the known writers.
    expect(files).toEqual(expect.arrayContaining([
      'server/services/annual-prepay-renewals.js',
      'server/routes/admin-invoices.js',
    ]));

    // Files allowed to mutate tables through a DYNAMIC table expression
    // (db(x)/trx(probe.table)/…). Each entry must be audited: customer-dedupe
    // is the merge/undo machinery re-pointing customer_id/bookkeeping columns
    // across many tables — audited 2026-08-31, it writes no status column on
    // this table. A new dynamic writer fails here until audited + listed.
    // name → exact count of dynamic-mutation sites at audit time. The count
    // is a ratchet: ANY new dynamic mutation in the file (which could carry
    // `payload.status` or `column === 'status'` invisibly to a textual scan)
    // fails until the file is re-audited and the count updated.
    const AUDITED_DYNAMIC_WRITERS = { 'server/services/customer-dedupe.js': 9 };

    const writes = [];
    const unscannable = [];
    for (const rel of files) {
      const src = read(rel);
      for (const expr of statusWriteExpressions(src)) writes.push({ file: rel, expr });
      // Fail closed on mutation forms the scanner cannot read: raw SQL that
      // updates/inserts this table's status, or indirect builder forms. Any
      // hit means the scanner (and the doc) must be extended first.
      if (new RegExp(`(?:UPDATE|INSERT\\s+INTO)\\s+(?:["'\`]?\\w+["'\`]?\\.)?["'\`]?${TABLE}["'\`]?[\\s\\S]{0,400}?["'\`]?\\bstatus\\b`, 'i').test(src)) {
        unscannable.push(`${rel}: raw SQL UPDATE/INSERT touching ${TABLE} status`);
      }
      if (new RegExp(`\\.table\\(\\s*['"]${TABLE}`).test(src)) {
        unscannable.push(`${rel}: .table('${TABLE}') builder form`);
      }
      if (new RegExp(`(?:const|let|var)\\s+[\\w$]+\\s*=\\s*['"\`]${TABLE}(?:\\s+as\\s+\\w+)?['"\`]`).test(src)) {
        // db(SOME_CONST) indirection would make every chain invisible.
        unscannable.push(`${rel}: table name behind a constant`);
      }
      // A mutation through a DYNAMIC table expression (db(fn()), trx(cfg.x))
      // could write this table's status invisibly — fail closed unless the
      // file is on the audited allowlist above.
      let dynamicSites = 0;
      for (const m of src.matchAll(/(?<![.\w])(?:db|trx|conn|knex|t)\(\s*([A-Za-z_$][\w$.[\]()]*)\s*\)/g)) {
        const chain = chainAfter(src, m.index + m[0].length);
        const mut = chain.match(/\.(?:update|insert|merge)\s*\(/);
        if (!mut) continue;
        dynamicSites += 1;
        if (!(rel in AUDITED_DYNAMIC_WRITERS)) {
          unscannable.push(`${rel}: dynamic-table mutation via ${m[1]} — audit it and extend AUDITED_DYNAMIC_WRITERS`);
          continue;
        }
        // Even audited dynamic writers must never name a status key in a
        // dynamically-tabled payload — that is how a future status write
        // would sneak past the literal-table scan.
        const args = chain.slice(mut.index);
        if (/(?:\b|['"])status['"]?\s*:/.test(args) || /\[\s*['"]status['"]\s*\]/.test(args)) {
          unscannable.push(`${rel}: dynamic-table mutation via ${m[1]} carries a status key`);
        }
      }
      if (rel in AUDITED_DYNAMIC_WRITERS && dynamicSites !== AUDITED_DYNAMIC_WRITERS[rel]) {
        // A payload.status / column === 'status' inside a NEW dynamic site is
        // invisible to a textual scan — the count ratchet forces a re-audit.
        unscannable.push(`${rel}: ${dynamicSites} dynamic-mutation sites (audited: ${AUDITED_DYNAMIC_WRITERS[rel]}) — re-audit and update the count`);
      }
    }
    expect(unscannable).toEqual([]);
    // Sanity: the scanner found the known write shapes (a regex that silently
    // matched nothing would make this test vacuous).
    const exprs = writes.map((w) => w.expr);
    expect(exprs).toEqual(expect.arrayContaining([
      "'active'",
      "'cancelled'",
      "'payment_pending'",
      'PAYMENT_PENDING_STATUS',                                   // dispute demotion object
      "term.status === 'active' ? 'renewal_pending' : term.status", // notice claim
      'previousStatus',                                           // notice release
      'statusAfterDecision(action)',                              // recordDecision
      'existing.renewal_decision ? existing.status : nextStatus', // createTerm re-run
    ]));

    const unresolved = [];
    const produced = new Set();
    for (const w of writes) {
      const resolved = resolveStatusExpression(w.expr);
      if (!resolved) { unresolved.push(`${w.file}: status: ${w.expr}`); continue; }
      resolved.forEach((s) => produced.add(s));
    }
    expect(unresolved).toEqual([]); // a new write shape must be added to KNOWN_STATUS_EXPRESSIONS + the doc
    for (const s of produced) {
      expect(WRITTEN_STATUSES).toContain(s);
      expect(LEGACY_ONLY_STATUSES).not.toContain(s);
    }
    // Only two files write the status today. A third writer is a new move
    // and belongs in the doc's "Where" column.
    const writerFiles = [...new Set(writes.map((w) => w.file))].sort();
    expect(writerFiles).toEqual([
      'server/routes/admin-invoices.js',
      'server/services/annual-prepay-renewals.js',
    ]);
  });

  test('every write site keeps its documented WHERE guard (moves 1–13) — loosening a guard fails here', () => {
    // Exact source-level pin of each write's guard chain, in scan order.
    // (`orWhere` branches are pinned behaviorally in the notice-claim test
    // below; this list covers the where/whereIn/whereNull/whereNotIn guards.)
    expect(statusWriteSites(read('server/services/annual-prepay-renewals.js'))).toEqual([
      // Move 2: payment_pending → active on invoice paid.
      { expr: "'active'", guards: ['where({ id: term.id, status: PAYMENT_PENDING_STATUS })'] },
      // Move 11: lost-dispute revival — undecided cancelled only.
      { expr: "'active'", guards: ["where({ id: term.id, status: 'cancelled' })", "whereNull('renewal_decision')"] },
      // Move 9: void/refund cancels — undecided only (decided lapse keeps coverage).
      { expr: "'cancelled'", guards: ['where({ id: term.id })', "whereNull('renewal_decision')"] },
      // Move 10: dispute demotion — active statuses only.
      { expr: 'PAYMENT_PENDING_STATUS', guards: ['where({ prepay_invoice_id: invoiceId })', "whereIn('status', ACTIVE_STATUSES)"] },
      // Move 1 (existing row): decided terms keep their status via the ternary itself.
      { expr: 'existing.renewal_decision ? existing.status : nextStatus', guards: ['where({ id: existing.id })'] },
      // Move 1 (birth insert): no guard — new row.
      { expr: 'nextStatus', guards: [] },
      // Move 4: notice claim — active, undecided, unsent, availability predicate.
      {
        expr: "term.status === 'active' ? 'renewal_pending' : term.status",
        guards: ['where({ id: term.id })', "whereIn('status', ACTIVE_STATUSES)", "whereNull('renewal_decision')",
          'whereNull(noticeCol)', 'where(function noticeClaimAvailable()', 'whereNull(claimCol)',
          "orWhere(claimCol, '<', staleClaimCutoff)"],
      },
      // Move 5: claim release — undecided + still unsent.
      { expr: 'previousStatus', guards: ['where({ id: claimedTerm.id })', "whereNull('renewal_decision')", 'whereNull(noticeCol)'] },
      // Move 3: contacted.
      { expr: "'renewal_pending'", guards: ['where({ id: termId })', "whereIn('status', ACTIVE_STATUSES)", "whereNull('renewal_decision')"] },
      // Moves 6–8: decisions.
      { expr: 'statusAfterDecision(action)', guards: ['where({ id: termId })', "whereIn('status', ACTIVE_STATUSES)", "whereNull('renewal_decision')"] },
    ]);
    // Move 11's third predicate lives on the upstream revival SELECT, not the
    // conditional UPDATE — pin it there: only dispute-marked, undecided
    // cancelled terms are even considered for revival.
    expect(read('server/services/annual-prepay-renewals.js')).toMatch(
      /\.where\(\{ prepay_invoice_id: invoice\.id, status: 'cancelled' \}\)\s*\.whereNull\('renewal_decision'\)\s*\.whereNotNull\('dispute_suspended_at'\)/,
    );

    expect(statusWriteSites(read('server/routes/admin-invoices.js'))).toEqual([
      // Move 13: DELETE /:id/annual-prepay — deliberately unguarded (documented residue).
      { expr: "'cancelled'", guards: ['where({ id: termId })'] },
      // Move 12: reverse-prepaid un-pay — undecided, non-cancelled only.
      { expr: "'payment_pending'", guards: ['where({ id: locked.annual_prepay_term_id })', "whereNull('renewal_decision')", "whereNotIn('status', ['cancelled', 'canceled'])"] },
    ]);
  });

  test('the doc names every stage in the CHECK, every write site, and the read-side grouping constants', () => {
    const doc = read(DOC);
    for (const s of migrationCheckStatuses()) {
      expect(doc).toMatch(new RegExp(`\\| \`${s}\` \\|`)); // a row in the Stages table
    }
    for (const fn of ['createTermForAnnualPrepay', 'syncTermForInvoicePayment', 'activatePaidPendingTerms',
      'recordDecision', 'sendCustomerTermNotice', 'suspendActiveTermsForDisputedInvoice',
      'DELETE /:id/annual-prepay', 'POST /:id/reverse-prepaid']) {
      expect(doc).toContain(fn);
    }
    expect(doc).toContain("ACTIVE_STATUSES = ['active', 'renewal_pending']");
    expect(doc).toContain("DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan']");
    // The two legacy names must be flagged as never written, not documented as live.
    expect(doc).toMatch(/`canceled`[^\n]*never written/);
    expect(doc).toMatch(/`refunded`[^\n]*never written/);
  });

  test('invoiceTermStatus (birth + invoice-driven moves) only yields payment_pending / active / cancelled', () => {
    const f = _private.invoiceTermStatus;
    expect(f(null)).toBe('payment_pending');
    expect(f({ status: 'draft' })).toBe('payment_pending');
    expect(f({ status: 'sent' })).toBe('payment_pending');
    expect(f({ status: 'paid' })).toBe('active');
    expect(f({ status: 'viewed', paid_at: new Date() })).toBe('active');
    // Both spellings and refunded on the INVOICE all land on term 'cancelled' —
    // never on the legacy term names.
    for (const invStatus of ['void', 'cancelled', 'canceled', 'refunded']) {
      expect(f({ status: invStatus })).toBe('cancelled');
    }
  });

  test('sanctioned computed-key identifiers (*Col) can never be status: the column helpers return only notice_/payment_reminder_ names', () => {
    for (const days of [30, 15, 7, 3, 1, 0, 99, null]) {
      for (const fn of [_private.noticeColumnForDaysOut, _private.noticeClaimColumnForDaysOut,
        _private.paymentReminderColumnForDaysOut, _private.paymentReminderClaimColumnForDaysOut]) {
        const col = fn(days);
        if (col !== null) expect(col).toMatch(/^(notice|payment_reminder)_/);
        expect(col).not.toBe('status');
      }
    }
  });

  test('dynamic status producers stay bound: every nextStatus assignment in the module comes from the two pinned producers', () => {
    const src = read('server/services/annual-prepay-renewals.js');
    const assignments = [...src.matchAll(/(?:const\s+)?nextStatus\s*=\s*([^;\n]+)/g)]
      .map((m) => m[1].trim())
      .filter((rhs) => !rhs.startsWith('==')); // comparisons, not assignments
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    for (const rhs of assignments) {
      expect(rhs).toMatch(/^(await statusForPrepayInvoice\(|invoiceTermStatus\()/);
    }
  });

  test('read-side grouping constants are pinned in the PRODUCTION module, not only in the doc', () => {
    const src = read('server/services/annual-prepay-renewals.js');
    expect(src).toContain("const ACTIVE_STATUSES = ['active', 'renewal_pending'];");
    expect(src).toContain("const DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan'];");
    expect(src).toContain("const PAYMENT_PENDING_STATUS = 'payment_pending';");
  });

  test('the doc moves table has 13 rows with CHECK-valid targets and each row names its documented guard', () => {
    const doc = read(DOC);
    const rows = [...doc.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \| .+ \| (.+?) \|$/gm)]
      .map((m) => ({ n: Number(m[1]), to: m[3], guard: m[4] }));
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const valid = new Set([...WRITTEN_STATUSES, ...LEGACY_ONLY_STATUSES]);
    for (const r of rows) {
      for (const s of r.to.matchAll(/`([a-z_]+)`/g)) expect(valid.has(s[1])).toBe(true);
    }
    const guardFrag = {
      1: 'renewal_decision',
      2: "'payment_pending'",
      3: 'ACTIVE_STATUSES AND renewal_decision IS NULL',
      4: 'notice_N_claimed_at IS NULL OR stale',
      5: 'notice_N_sent_at IS NULL',
      6: 'same as 3',
      7: 'same as 3',
      8: 'same as 3',
      9: 'renewal_decision IS NULL',
      10: 'ACTIVE_STATUSES',
      11: 'dispute_suspended_at IS NOT NULL',
      12: "NOT IN ('cancelled','canceled')",
      13: 'none',
    };
    for (const r of rows) expect(r.guard).toContain(guardFrag[r.n]);
  });

  test('statusForPrepayInvoice (the birth wrapper createTerm actually calls) keeps its three documented branches', () => {
    // Not exported — pinned at source: no linked invoice → born 'active'
    // (manual term, treated as already-covered); invoice found → the
    // invoiceTermStatus mapping above; lookup error → payment_pending
    // (degrade, never guess active).
    const src = read('server/services/annual-prepay-renewals.js');
    const fn = src.match(/async function statusForPrepayInvoice\(invoiceId[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toContain("if (!invoiceId) return 'active';");
    expect(fn[0]).toContain('return invoiceTermStatus(invoice);');
    expect(fn[0]).toContain('return PAYMENT_PENDING_STATUS;');
  });

  describe('recordDecision — the operator moves out of active / renewal_pending', () => {
    let chain;
    beforeEach(() => {
      jest.clearAllMocks();
      db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
      chain = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 'term-1' }]),
      };
      db.mockReturnValue(chain);
    });

    test.each([
      ['contacted', 'renewal_pending', null],
      ['renew', 'renewed', 'renew'],
      ['switch_plan', 'switch_plan', 'switch_plan'],
      ['cancel', 'cancelled', 'cancel'],
    ])('%s → status %s (renewal_decision %s), guarded on ACTIVE_STATUSES + undecided', async (action, status, decision) => {
      await AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action, adminUserId: 'admin-1' });
      expect(chain.where).toHaveBeenCalledWith({ id: 'term-1' });
      expect(chain.whereIn).toHaveBeenCalledWith('status', ACTIVE_STATUSES);
      expect(chain.whereNull).toHaveBeenCalledWith('renewal_decision');
      const payload = chain.update.mock.calls[0][0];
      expect(payload.status).toBe(status);
      if (decision) expect(payload.renewal_decision).toBe(decision);
      else expect(payload).not.toHaveProperty('renewal_decision');
    });

    test('rejects any action that is not a documented move', async () => {
      await expect(AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action: 'refund' }))
        .rejects.toThrow('invalid annual prepay action');
      await expect(AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action: 'canceled' }))
        .rejects.toThrow('invalid annual prepay action');
      expect(chain.update).not.toHaveBeenCalled();
    });

    test('a decided term (guard miss) returns null instead of moving', async () => {
      chain.returning.mockResolvedValue([]);
      await expect(AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action: 'renew' })).resolves.toBeNull();
    });
  });

  describe('sendCustomerTermNotice — automated active → renewal_pending claim, rolled back on failed delivery', () => {
    // Minimal knex-builder stand-in: chainable, resolves `first` / `returning`.
    function query({ first, returning, rows = [] } = {}) {
      const q = {};
      ['whereIn', 'whereNull', 'whereNotNull', 'whereNot', 'whereBetween', 'whereNotIn', 'orderBy',
        'select', 'forUpdate', 'leftJoin', 'whereRaw', 'orWhere', 'orWhereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; });
      q.update = jest.fn(() => q);
      q.first = jest.fn(async () => first);
      q.returning = jest.fn(async () => returning || []);
      q.columnInfo = jest.fn(async () => ({}));
      q.catch = jest.fn(() => Promise.resolve());
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }

    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      notice_30_sent_at: null,
      notice_30_claimed_at: null,
      renewal_decision: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
      db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
      db.raw = jest.fn().mockResolvedValue({ rows: [{ locked: true }] });
      db.transaction = jest.fn(async (cb) => cb(db));
      _private.resetCachesForTests();
    });

    test('claim flips active → renewal_pending under the ACTIVE_STATUSES + undecided + unsent + unclaimed guard, and a missing customer releases it back to the previous status', async () => {
      const refreshQuery = query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] });
      const claimQuery = query({ returning: [{ ...term, status: 'renewal_pending', notice_30_claimed_at: new Date() }] });
      const releaseQuery = query();
      const queues = {
        scheduled_services: [query({ first: null }), query()],
        annual_prepay_terms: [refreshQuery, claimQuery, releaseQuery],
        customers: [query({ first: null })], // → customer_not_found → releaseClaim
      };
      db.mockImplementation((table) => {
        const q = queues[table];
        if (!q || !q.length) throw new Error(`Unexpected db table ${table}`);
        return q.shift();
      });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 30))
        .resolves.toMatchObject({ sent: false, reason: 'customer_not_found' });

      // Move 4: the claim.
      expect(claimQuery.where).toHaveBeenCalledWith({ id: 'term-1' });
      expect(claimQuery.whereIn).toHaveBeenCalledWith('status', ACTIVE_STATUSES);
      expect(claimQuery.whereNull).toHaveBeenCalledWith('renewal_decision');
      expect(claimQuery.whereNull).toHaveBeenCalledWith('notice_30_sent_at');
      // Claim-availability predicate: unclaimed OR the claim is stale (15-min
      // TTL). Without both branches, two workers could claim concurrently and
      // send duplicate renewal notices.
      expect(claimQuery.whereNull).toHaveBeenCalledWith('notice_30_claimed_at');
      expect(claimQuery.orWhere).toHaveBeenCalledWith('notice_30_claimed_at', '<', expect.any(Date));
      const cutoff = claimQuery.orWhere.mock.calls.find((c) => c[0] === 'notice_30_claimed_at')[2];
      const ttlMs = Date.now() - cutoff.getTime();
      expect(ttlMs).toBeGreaterThanOrEqual(15 * 60 * 1000 - 5000);
      expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 60000);
      expect(claimQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'renewal_pending',
        notice_30_claimed_at: expect.any(Date),
      }));

      // Move 5: the rollback restores the pre-claim status, still guarded on undecided + unsent.
      expect(releaseQuery.where).toHaveBeenCalledWith({ id: 'term-1' });
      expect(releaseQuery.whereNull).toHaveBeenCalledWith('renewal_decision');
      expect(releaseQuery.whereNull).toHaveBeenCalledWith('notice_30_sent_at');
      expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'active',
        notice_30_claimed_at: null,
      }));
    });

    test('a term already in renewal_pending keeps that status through the claim (no move)', async () => {
      const pendingTerm = { ...term, status: 'renewal_pending' };
      const refreshQuery = query({ returning: [{ ...pendingTerm, last_scheduled_service_id: null, last_scheduled_service_date: null }] });
      const claimQuery = query({ returning: [] }); // guard miss → already_claimed; we only care about the payload
      const queues = {
        scheduled_services: [query({ first: null }), query()],
        annual_prepay_terms: [refreshQuery, claimQuery],
      };
      db.mockImplementation((table) => {
        const q = queues[table];
        if (!q || !q.length) throw new Error(`Unexpected db table ${table}`);
        return q.shift();
      });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(pendingTerm, 30))
        .resolves.toMatchObject({ sent: false, reason: 'already_claimed' });
      expect(claimQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'renewal_pending' }));
    });
  });
});
