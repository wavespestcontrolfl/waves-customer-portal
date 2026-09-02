/**
 * Booking insert-site contract — mechanical enforcement of "no new bare
 * scheduled_services inserts" (Tier 2 booking-consolidation track).
 *
 * Every production INSERT into scheduled_services must either go through
 * the booking contract (services/booking/create-scheduled-service.js —
 * the createScheduledService wrapper, or a bespoke insert whose payload
 * came out of completeScheduledServiceInsert) or be one of the frozen
 * legacy sites below. The inventory freezes each site's FINGERPRINT — the
 * nearest enclosing named scope (function / arrow binding / router
 * handler path, plus the nearest `case` label inside it — call-site
 * identity that survives line churn), the statement prefix
 * (assignment/return context on the ref's line) and the normalized
 * `('scheduled_services')…insert(<arg head>` expression — as a per-file
 * multiset, not a bare count: with
 * counts alone, converting one legacy insert while adding a different
 * bare insert in the same file would net to zero and slip a new parallel
 * booking writer past the guard (GH Codex #3702 P2). Entries may only be
 * REMOVED as writers adopt the contract; a diff that adds or edits a
 * fingerprint is a policy violation, not a fix for this test — an
 * intentional rework of a legacy insert adopts the contract instead. A
 * stale entry (site no longer present) also fails, so the map always
 * mirrors reality.
 *
 * SCOPE — a ratchet, not a sandbox. This scan is textual. It recognizes
 * every insert form in the repository today plus the ordinary Knex
 * spellings a new writer would reach for (fluent chains, aliases,
 * constants, string/object table aliases, .into/.table, batchInsert,
 * bracket links, raw SQL), and it treats a helper-completed payload as
 * compliant only under conservative fail-closed rules. It is NOT a proof
 * against a writer deliberately hiding an insert (dynamic table names,
 * computed property access, wrapping knex under another name, eval).
 * Adversarial evasion is a code-review concern, not this test's; the
 * ratchet exists so an honest new bare insert is caught mechanically.
 * Further evasion shapes are accepted when they are plausible ordinary
 * code, and rebutted otherwise.
 *
 * Matcher shape: each `('scheduled_services')` table ref (the string may
 * sit on its own line inside the call) is followed through its COMPLETE
 * chained expression — balanced parentheses, string-safe, comments
 * skipped — so a chain of any length or line count that ends in
 * `.insert(` is caught; a bounded line window was evadable by padding the
 * chain (GH Codex #3702 r3 P1).
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(SERVER_ROOT, '..');

// Directories that never hold production insert sites. Migrations and
// seeds write historical/demo data by design; tests exercise mocks.
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'seeds', 'coverage', 'dist', 'fixtures']);

// The contract module itself — the ONLY file allowed to hold a bare
// insert. Exempting the whole services/booking directory would let a new
// sibling module become a parallel booking mechanism (GH Codex P2), and
// exempting the whole FILE would let the module most likely to gain
// booking code grow an insert that skips its own helper (GH Codex r13
// P2): the module is scanned like any other, and exactly these sites —
// the createScheduledService wrapper's two inserts of the
// completeScheduledServiceInsert output — are certified.
const CONTRACT_MODULE = 'server/services/booking/create-scheduled-service.js';
const CONTRACT_MODULE_CERTIFIED_SITES = [
  "createScheduledService :: const [row] = await trx( scheduled_services').insert(data",
  "createScheduledService :: const [row] = await trx( scheduled_services').insert(data",
];
// …and the `data` those sites insert must still be the helper's output:
// the certification pins the wrapper's completion statement, so swapping
// it for raw input is a visible break, not a silent one (GH Codex r14 P2).
const CONTRACT_MODULE_CERTIFIED_COMPLETION = 'const data = await completeScheduledServiceInsert(insertData, { trx, cols, source, allowNullCustomer });';
// …and between that completion and the certified inserts, the wrapper may
// touch `data` in exactly these ways — the idempotency stamp — and must
// not hand it to anything else. A new intervening mutation or escape in
// the wrapper is a visible break (GH Codex r15 P2).
const CONTRACT_MODULE_CERTIFIED_WRITES = ['data.idempotency_key = idempotencyKey;'];

// Frozen 2026-09-01 inventory (re-frozen at the origin/main merge base of
// this PR — main reworked admin-dispatch's schedule-followup insert while
// the PR was in review): 26 sites, 14 files, keyed by fingerprint
// multiset. Shrink-only.
const FROZEN_LEGACY_INSERT_SITES_2026_09 = {
  'server/routes/admin-schedule.js': [
    "post / :: [svc] = await trx( scheduled_services').insert(insertData",
    "post / :: const [childRow] = await trx( scheduled_services').insert(childData",
    "post / :: const [boosterRow] = await trx( scheduled_services').insert(boosterData",
    "put /:id/update-details :: const [childRow] = await trx( scheduled_services').insert(childData",
    "reconcileRecurringSeriesVisitCount :: const [row] = await trx( scheduled_services').insert(data",
    "runRecurringSeriesMaintenanceLocked :: const [autoExtRow] = await conn( scheduled_services').insert(nextData",
    "runLocked / action === 'extend' :: const [row] = await trx( scheduled_services').insert(data",
    "runLocked / action === 'convert_ongoing' :: const [row] = await trx( scheduled_services').insert(data",
  ],
  'server/routes/booking.js': [
    "createSelfBooking :: const [scheduledRow] = await trx( scheduled_services').insert({",
  ],
  'server/routes/admin-dispatch.js': [
    "post /:serviceId/schedule-followup :: const inserted = await trx( scheduled_services').insert(insertData",
  ],
  'server/routes/admin-leads.js': [
    "post /:id/schedule-appointment :: const [appt] = await trx( scheduled_services').insert(insertData",
  ],
  'server/services/slot-reservation.js': [
    "reserveSlot :: const [row] = await trx( scheduled_services').insert({",
  ],
  'server/services/health-alerts.js': [
    "executeAction :: return trx( scheduled_services').insert({",
  ],
  'server/services/availability.js': [
    "runBookingWork :: const [scheduledRow] = await trx( scheduled_services').insert({",
  ],
  'server/services/recurring-appointment-seeder.js': [
    "seedFollowUpsForParent :: ? await (async () => { await lockCustomerComms(conn, parent.customer_id); return conn( scheduled_services').insert(rows",
    "seedFollowUpsForParent :: : await withCustomerCommsLock(conn, parent.customer_id, (trx) => trx( scheduled_services').insert(rows",
  ],
  'server/services/annual-prepay-renewals.js': [
    "seedTimedFirstVisit :: const [row] = await trx( scheduled_services').insert(buildInsert(scheduledDate, windowStart)",
    "ensureCoverageRowsForTerm :: [created] = await conn( scheduled_services').insert(buildInsert(scheduledDate, null)",
    "ensureCoverageRowsForTerm :: return trx( scheduled_services').insert(buildInsert(scheduledDate, null)",
  ],
  'server/services/intelligence-bar/tools.js': [
    "createAppointment :: const [created] = await trx( scheduled_services').insert({",
  ],
  'server/services/estimate-converter.js': [
    "convertEstimate :: const inserted = await trx( scheduled_services').insert(standaloneRow",
    "convertEstimate :: const inserted = await trx( scheduled_services').insert(row",
  ],
  'server/services/voice-agent/relay-booking.js': [
    "commitVoiceBooking :: const [created] = await trx( scheduled_services').insert(insertRow",
  ],
  'server/services/call-recording-processor.js': [
    "ensureCallFollowUpVisit :: const [fuRow] = await sp( scheduled_services').insert({",
    "processRecording :: const [created] = await trx( scheduled_services').insert(insertData",
  ],
  'scripts/import-ical-appointments.js': [
    "importToDatabase :: const [inserted] = await db( scheduled_services').insert(row",
  ],
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(?:js|mjs|cjs|sh|sql)$/.test(entry.name)) {
      // Shell and SQL tools are production write surfaces too (ops/agents
      // holds a .sh tool today) — their raw `INSERT INTO scheduled_services`
      // is scanned like a knex.raw (GH Codex r16 P2).
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Fingerprint = the normalized expression from the table ref through the
// insert argument's head token — stable under comment/whitespace churn
// around the site, distinct enough that a swapped-in different insert
// reads as a NEW fingerprint.
function fingerprintOf(scope) {
  const m = scope.match(/^[\s\S]*?\.insert\s*\(\s*(\{|[A-Za-z0-9_.$]+(\([^)]*\))?)?/);
  return (m ? m[0] : scope).replace(/\s+/g, ' ').trim();
}

// Whether position `index` lies inside a comment (`//`, `/* */`, a
// `--` SQL comment, or a `#` line comment for shell tools), walking the
// source from the top with strings skipped so a `//` inside a string
// literal doesn't open a phantom comment.
function insideComment(source, index, sql = false) {
  let i = 0;
  while (i < index) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) { if (source[i] === '\\') i += 1; i += 1; }
      i += 1;
      continue;
    }
    // `--` and `#` open comments only in SQL/shell inputs — in JavaScript
    // `count--` is a decrement, not a comment (GH Codex r20 P2).
    if (source.startsWith('//', i) || (sql && (source.startsWith('--', i) || (ch === '#' && (i === 0 || source[i - 1] === '\n' || /\s/.test(source[i - 1])))))) {
      const nl = source.indexOf('\n', i);
      if (nl === -1 || nl > index) return true;
      i = nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1 || end + 2 > index) return true;
      i = end + 2;
      continue;
    }
    i += 1;
  }
  return false;
}

// The same text with every comment blanked to spaces (length preserved,
// strings kept), so payload-flow analysis never mistakes prose for code —
// a comment reading "absent (the column is …" is not a call whose paren
// walk swallows the statements after it (GH Codex r21 follow-up).
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) { if (source[j] === '\\') j += 1; j += 1; }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? source.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Advance past whitespace and // and /* */ comments.
function skipTrivia(source, i) {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    return i;
  }
}

// Consume one balanced {...} span starting at an opening brace (strings
// and comments skipped); returns the index just past the closing brace.
function balancedBraces(source, i) {
  let depth = 0;
  while (i < source.length) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) { i = skipTrivia(source, i); continue; }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) { if (source[i] === '\\') i += 1; i += 1; }
    } else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return i;
}

// Consume one balanced (...) span starting at an opening paren, skipping
// string literals (a ')' inside a string can't end it early) AND comments
// (an apostrophe inside a comment — "the customer's rental" — must not
// open a phantom string that swallows the rest of the file).
function balancedParens(source, i) {
  let depth = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i += 1;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
    }
    i += 1;
  }
  return i;
}

// Index just past the statement that starts at `i`: the first `;` at
// bracket depth 0 (or the end of the enclosing block), strings and
// comments skipped.
function statementEnd(source, i) {
  let depth = 0;
  while (i < source.length) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) { i = skipTrivia(source, i); continue; }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) { if (source[i] === '\\') i += 1; i += 1; }
    } else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) { depth -= 1; if (depth < 0) return i; }
    else if (ch === ';' && depth === 0) return i;
    i += 1;
  }
  return i;
}

// Start of the statement that contains position `i`: walk BACKWARD over
// balanced brackets to the previous `;`, an unclosed opener (`{`/`(` of
// the enclosing block or call), or the file start. The chained expression
// may span any number of lines.
function statementStart(source, i) {
  let depth = 0;
  while (i > 0) {
    const ch = source[i - 1];
    if (')]}'.includes(ch)) depth += 1;
    else if ('([{'.includes(ch)) { if (depth === 0) return i; depth -= 1; }
    else if (ch === ';' && depth === 0) return i;
    i -= 1;
  }
  return 0;
}

// Split an argument list on top-level commas (strings and nesting skipped).
function topLevelArgs(args) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < args.length && args[i] !== ch) { if (args[i] === '\\') i += 1; i += 1; }
    } else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(args.slice(start, i).trim()); start = i + 1; }
  }
  out.push(args.slice(start).trim());
  return out;
}

// The text inside the `.insert(…)` argument list of a chain/statement.
function insertArgument(text) {
  const at = text.search(/\.insert\s*\(/);
  if (at === -1) return null;
  const open = text.indexOf('(', at);
  // Only the FIRST argument is the payload — Knex's returning overload
  // (`.insert(data, '*')`, `.insert(data, ['id'])`) must not turn a
  // completed identifier into "data, '*'" (GH Codex r18 P2).
  return topLevelArgs(text.slice(open + 1, balancedParens(text, open) - 1))[0] ?? '';
}

// Whether an insert ARGUMENT already passed through the contract's
// completion helper. A legacy writer whose transaction shape doesn't fit
// createScheduledService (bulk rows, savepoints) adopts
// completeScheduledServiceInsert and keeps its own insert; that insert is
// compliant, not bare, and must be able to leave the frozen inventory
// (GH Codex r5 P2). Recognized: `.insert(await completeScheduledServiceInsert(…))`
// inline, or an identifier whose EVERY write in the file — assignment or
// `.push(` (an empty-array accumulator initializer is neutral) — has a
// value ROOTED in the helper: the whole value is one helper call, or one
// `Promise.all(list.map(… => helper(…)))`. A statement that merely
// contains the call somewhere (`cond ? await helper(…) : buildRaw()`) is
// not rooted, so one bypassing branch keeps the site bare (pre-push Codex
// r6 P1). An identifier with any helper-free write stays bare: importing
// the helper elsewhere in the file launders nothing, and the identifier
// must be ONE binding file-wide — exactly one declaration and never a
// function parameter — since this scan is textual, not lexical: a
// compliant `data` in one function must not vouch for an unrelated `data`
// parameter in another (pre-push Codex r6 P1). A payload MUTATED
// after completion (`data.x = …`, `data[k] = …`, `Object.assign(data, …)`,
// `delete data.x`) is bare too — the final payload never passed validation
// (pre-push Codex r6 P1); an adopter shapes the payload BEFORE the helper.
// `text` is exactly one `<name>(…)` call: returns its argument text, or
// null when it is not, or when anything follows the closing paren.
function wholeCall(text, name) {
  const m = new RegExp(`^${name}\\s*\\(`).exec(text);
  if (!m) return null;
  const open = m[0].length - 1;
  const end = balancedParens(text, open);
  return end === text.length ? text.slice(open + 1, end - 1) : null;
}

function rootedInHelper(value) {
  const v = String(value || '').trim().replace(/;\s*$/, '').replace(/^await\s+/, '').trim();
  if (wholeCall(v, 'completeScheduledServiceInsert') !== null) return true;
  const all = wholeCall(v, 'Promise\\s*\\.\\s*all');
  if (all === null || !/^[\w$.]+\s*\.\s*map\s*\(/.test(all.trim())) return false;
  const arrow = /=>\s*([\s\S]*)\)\s*$/.exec(all);
  return !!arrow && wholeCall(arrow[1].trim().replace(/^await\s+/, ''), 'completeScheduledServiceInsert') !== null;
}

// Whether the identifier at `i` sits in a function PARAMETER position:
// `id => …`, `(…, id, …) => …`, `function f(…id…) {`, or a method
// `m(…id…) {` (control-flow keywords before the paren are not functions).
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'await', 'typeof']);
function isParameterAt(source, i, id) {
  if (source.startsWith('=>', skipTrivia(source, i + id.length))) return true;
  let depth = 0;
  let j = i;
  while (j > 0) {
    const ch = source[j - 1];
    if (ch === ')') depth += 1;
    else if (ch === '(') { if (depth === 0) break; depth -= 1; }
    else if ((ch === ';' || ch === '{' || ch === '}') && depth === 0) return false;
    j -= 1;
  }
  if (j === 0) return false;
  const open = j - 1;
  const next = skipTrivia(source, balancedParens(source, open));
  if (source.startsWith('=>', next)) return true;
  if (source[next] !== '{') return false;
  const word = /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(Math.max(0, open - 80), open));
  return !!word && !NOT_A_FUNCTION.has(word[1]);
}

function isSingleBinding(source, id) {
  // A plain declaration, or a destructuring one (`const { id } = …`).
  const decl = new RegExp(`\\b(?:const|let|var)\\s+(?:[{\\[][^=;\\n]*?[{\\[,\\s])?${id}\\b`, 'g');
  if ((source.match(decl) || []).length !== 1) return false;
  const occ = new RegExp(`(?<![.\\w$])${id}\\b`, 'g');
  let m;
  while ((m = occ.exec(source)) !== null) {
    if (isParameterAt(source, m.index, id)) return false;
  }
  return true;
}

function isContractCompleted(rawSource, arg) {
  if (!importsCanonicalHelper(rawSource)) return false;
  const source = stripComments(rawSource);
  const text = String(arg || '').trim();
  if (rootedInHelper(text)) return true;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return false;
  if (!isSingleBinding(source, text)) return false;
  const writes = new RegExp(`(?:\\b(?:const|let|var)\\s+)?\\b${text}\\b\\s*(?:=(?![=>])|\\.\\s*push\\s*\\()`, 'g');
  let completed = 0;
  let w;
  while ((w = writes.exec(source)) !== null) {
    const stmt = source.slice(w.index, statementEnd(source, w.index));
    const value = w[0].endsWith('(')
      ? stmt.slice(w[0].length, balancedParens(stmt, w[0].length - 1) - 1)
      : stmt.slice(w[0].length);
    if (rootedInHelper(value)) completed += 1;
    else if (!/^\s*\[\s*\]\s*;?\s*$/.test(value)) return false;
  }
  if (!completed) return false;
  // Any depth of property/index segments: `rows[0].source_action = …` is
  // a mutation of the tracked value too (GH Codex r10 P2).
  if (mutatesIdentifier(source, text)) return false;
  // A completed value that ESCAPES into another binding (`const alias =
  // data;`) could be mutated under that name, which the check above can't
  // see — fail closed (GH Codex r9 P2). Reads of a property, spreads and
  // call arguments are not escapes.
  if (escapesToBinding(source, text)) return false;
  // Passing the tracked object to a CALL is an escape too — a helper can
  // mutate it (`stripAttribution(data)`) — unless the callee is on the
  // known non-mutating list (GH Codex r11 P2).
  if (escapesThroughCall(source, text)) return false;
  // Iterating the tracked array with for…of binds each element to a
  // name the checks above can't see (`for (const row of rows) row.x = …`):
  // a plain element binding is inspected for mutation/escape through
  // that name; a destructured one fails closed (GH Codex r17 P2).
  const forOf = new RegExp(`\\bfor\\s*(?:await\\s*)?\\(\\s*(?:const|let|var)\\s+([^)]*?)\\s+of\\s+${text}\\b[^)]*\\)`, 'g');
  let fo;
  while ((fo = forOf.exec(source)) !== null) {
    const binding = fo[1].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(binding)) return false;
    let at = skipTrivia(source, fo.index + fo[0].length);
    const body = source[at] === '{'
      ? source.slice(at, balancedBraces(source, at))
      : source.slice(at, statementEnd(source, at));
    if (mutatesIdentifier(body, binding) || escapesThroughCall(body, binding) || escapesToBinding(body, binding)) return false;
  }
  // A method called ON the tracked value is a mutation unless it is a
  // known read-only one — `rows.unshift(raw)` / `splice` / `fill` would
  // smuggle an unvalidated row into a completed accumulator (GH Codex r12
  // P2). `.push(` is judged as a write above.
  const methodRe = new RegExp(`\\b${text}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  let mm;
  while ((mm = methodRe.exec(source)) !== null) {
    if (mm[1] === 'push') continue;
    if (!READ_ONLY_METHODS.has(mm[1])) return false;
    // A read-only method's CALLBACK can still mutate the element it is
    // handed (`rows.forEach((row) => { row.source_action = null; })`) —
    // inspect the callback body for writes through its element parameter
    // (GH Codex r13 P2). reduce hands the element second.
    const open = mm.index + mm[0].length - 1;
    const cb = topLevelArgs(source.slice(open + 1, balancedParens(source, open) - 1))[0] || '';
    const params = /^\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(cb) || /^\s*(?:async\s*)?function\s*[\w$]*\s*\(([^)]*)\)/.exec(cb);
    if (!params) continue;
    const list = (params[1] ?? params[2] ?? '').split(',').map((x) => x.trim().replace(/=.*$/, '').trim()).filter(Boolean);
    // A callback that also binds the ARRAY parameter (`(row, i, array) =>
    // { array[i] = raw; }`) can replace completed rows through it — fail
    // closed on that extra binding (GH Codex r18 P2). The index alone
    // cannot mutate.
    if (list.length > (mm[1] === 'reduce' ? 3 : 2)) return false;
    const el = mm[1] === 'reduce' ? list[1] : list[0];
    if (el && /^[A-Za-z_$][\w$]*$/.test(el) && (mutatesIdentifier(cb, el) || escapesThroughCall(cb, el) || escapesToBinding(cb, el))) return false;
  }
  return true;
}

// A bare reference to `id`: not a property of something else, not
// followed by a property access (a read), not a spread copy.
function bareRef(id) {
  return new RegExp(`(?<![.\\w$])(?<!\\.\\.\\.)${id}\\b(?!\\s*[.\\[])`);
}

// Whether `id` escapes into another binding — a mutation under that name
// can't be tracked, so the completed value is no longer certified
// (GH Codex r9 P2; callback and for…of elements too — r20 P2). Any
// declaration or assignment whose right-hand side carries a bare
// reference counts: `const alias = id`, `const [alias] = [id]`,
// `const box = { inner: id }` (r21 P2). Property reads and spread
// copies do not.
function escapesToBinding(text, id) {
  const decl = new RegExp(`(?:\\b(?:const|let|var)\\s+[^=;]*?|\\b(?!${id}\\b)[A-Za-z_$][\\w$]*\\s*)=(?![=>])`, 'g');
  let m;
  while ((m = decl.exec(text)) !== null) {
    const rhs = text.slice(m.index + m[0].length, statementEnd(text, m.index + m[0].length));
    if (/\bcompleteScheduledServiceInsert\s*\(/.test(rhs)) continue; // the completion itself
    // References inside CALL arguments are judged by escapesThroughCall
    // (allowlisted callees such as insert/batchInsert are fine there);
    // here only the bare structure of the value counts.
    if (bareRef(id).test(stripCallArgs(rhs))) return true;
  }
  return false;
}

// Blank the argument lists of every call in `text` (balanced), keeping
// everything else — so a binding check sees `const [row] = await q.insert()`
// rather than the payload inside the call.
function stripCallArgs(text) {
  let out = '';
  let i = 0;
  const callRe = /[A-Za-z_$\]][\w$]*\s*\(/g;
  let m;
  while ((m = callRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    if (open < i) continue;
    const end = balancedParens(text, open);
    out += text.slice(i, open + 1);
    i = end - 1;
    callRe.lastIndex = end;
  }
  return out + text.slice(i);
}

// Whether `id` is passed as a direct argument to a call that is not on
// the non-mutating list (GH Codex r11 P2). Arguments are split on
// top-level commas after a balanced walk, so a nested call earlier in the
// list (`mutate(makeOptions(), data)`) can't hide it (r12 P2); the same
// check runs on a callback's element parameter (`rows.forEach((row) =>
// stripAttribution(row))` — r14 P2).
function escapesThroughCall(text, id) {
  const callRe = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  let cm;
  while ((cm = callRe.exec(text)) !== null) {
    const open = cm.index + cm[0].length - 1;
    const args = topLevelArgs(text.slice(open + 1, balancedParens(text, open) - 1));
    // Any BARE reference to the tracked object inside an argument counts
    // (`mutate({ payload: data })`, `mutate([data])`) — a property read
    // (`data.id`) or a spread copy (`{ ...data }`) does not (GH Codex r21 P2).
    if (!args.some((a) => bareRef(id).test(a))) continue;
    const callee = cm[1].replace(/\s+/g, '');
    const last = callee.split('.').pop();
    if (NOT_A_FUNCTION.has(callee)) continue; // `if (data)` is not a call
    if (NON_MUTATING_CALLEES.has(callee) || NON_MUTATING_LAST.has(last) || /^(?:console|logger|log)\./.test(callee)) continue;
    return true;
  }
  return false;
}

// Property/index assignment (any depth, compound operators included),
// Object.assign onto it, or delete of a property — on `id`.
function mutatesIdentifier(text, id) {
  const prop = `\\b${id}\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])+`;
  return new RegExp(
    `${prop}\\s*(?:[-+*/%|&^]|\\*\\*|\\?\\?|\\|\\||&&)?=(?![=>])`
    // postfix / prefix increment and decrement (GH Codex r19 P2)
    + `|${prop}\\s*(?:\\+\\+|--)`
    + `|(?:\\+\\+|--)\\s*${prop}`
    + `|\\bdelete\\s+${id}\\b`
    + `|\\bObject\\s*\\.\\s*assign\\s*\\(\\s*${id}\\b`,
  ).test(text);
}
const READ_ONLY_METHODS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'slice', 'includes', 'indexOf', 'join', 'concat', 'reduce', 'flat', 'flatMap', 'entries', 'keys', 'values', 'at', 'toString', 'hasOwnProperty', 'toJSON']);
const NON_MUTATING_CALLEES = new Set(['completeScheduledServiceInsert', 'JSON.stringify', 'structuredClone', 'Object.keys', 'Object.values', 'Object.entries', 'Object.freeze', 'Array.isArray', 'String']);
const NON_MUTATING_LAST = new Set(['insert', 'batchInsert']);

// Whether the file binds completeScheduledServiceInsert to the CANONICAL
// contract module — a same-named local function or an import from
// anywhere else is a parallel stamping mechanism, and its output launders
// nothing (GH Codex r6 P2).
const CANONICAL_IMPORT = /\{[^}]*\bcompleteScheduledServiceInsert\b[^}]*\}\s*=\s*require\(\s*['"][^'"]*\/booking\/create-scheduled-service(?:\.js)?['"]\s*\)|\bimport\s*\{[^}]*\bcompleteScheduledServiceInsert\b[^}]*\}\s*from\s*['"][^'"]*\/booking\/create-scheduled-service(?:\.js)?['"]/;
const LOCAL_HELPER = /\b(?:function\s+completeScheduledServiceInsert\b|(?:const|let|var)\s+completeScheduledServiceInsert\s*=|completeScheduledServiceInsert\s*:\s*(?:async\s*)?(?:function\b|\())/;
function importsCanonicalHelper(source) {
  return CANONICAL_IMPORT.test(source) && !LOCAL_HELPER.test(source);
}

// Enclosing named scope of the site at `index` — a function declaration,
// an arrow/function bound to a const, a router handler's path — plus the
// nearest enclosing branch label (`case X:` / `if (x === 'lit')`) inside
// it. Lexical approximation by indentation: a candidate counts only when
// it sits at a SHALLOWER indent than the site and no closer (`}`/`)`) at
// its own indent or less appears before the site. Call-site identity that
// survives line churn, so two byte-identical statements in different
// functions (or different branches of one function) freeze as distinct
// entries and a migrated site can't cancel against a twin added elsewhere
// in the file (GH Codex r6 P2).
const SCOPE_RE = /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)|(?:^|\n)[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{|\bcase\s+((?:['"`][^'"`]*['"`])|[\w$.]+)\s*:|\bif\s*\(\s*([\w$.]+)\s*===\s*((?:['"`][^'"`]*['"`])|[\w$.]+)\s*\)/g;
const NOT_A_SCOPE = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return']);
const scopeCache = new Map();
function scopeCandidates(source) {
  if (scopeCache.has(source)) return scopeCache.get(source);
  const lines = [];
  let at = 0;
  for (const text of source.split('\n')) {
    lines.push({ start: at, indent: text.search(/\S|$/), text });
    at += text.length + 1;
  }
  const lineOf = (i) => {
    let lo = 0; let hi = lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid].start <= i) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const cands = [];
  SCOPE_RE.lastIndex = 0;
  let m;
  while ((m = SCOPE_RE.exec(source)) !== null) {
    let label;
    let name;
    if (m[6] !== undefined) label = `case ${m[6]}`;
    else if (m[7] !== undefined) label = `${m[7]} === ${m[8]}`;
    else {
      name = m[1] !== undefined ? (m[1] || 'function')
        : m[2] !== undefined ? m[2]
          : m[3] !== undefined ? `${m[3]} ${m[4]}`
            : m[5];
      if (name === undefined || NOT_A_SCOPE.has(name)) {
        // A keyword caught by the method-shorthand form (`\n  if (…) {`)
        // is not a scope — but the same text may be a branch label, so
        // resume the scan just past the newline instead of past the match.
        SCOPE_RE.lastIndex = m.index + 1;
        continue;
      }
    }
    cands.push({ index: m.index, line: lineOf(m.index), name, label });
  }
  const out = { lines, lineOf, cands };
  scopeCache.set(source, out);
  return out;
}

function enclosingScope(source, index) {
  const { lines, lineOf, cands } = scopeCandidates(source);
  let siteLine = lineOf(index);
  // A table string alone on its line: the statement (and its indent) is
  // the previous non-blank line.
  if (/^\s*['"`]/.test(lines[siteLine].text) && siteLine > 0) siteLine -= 1;
  const siteIndent = lines[siteLine].indent;
  const encloses = (c) => {
    const k = lines[c.line].indent;
    if (k >= siteIndent) return false;
    for (let l = c.line + 1; l < siteLine; l += 1) {
      const ln = lines[l];
      if (ln.indent > k) continue;
      const t = ln.text.trim();
      if (!/^[})\]]/.test(t)) continue;
      // `}) {` closes a multi-line parameter list and OPENS the function
      // body — not a closer for a function candidate. For a branch label
      // `} else if (…) {` at its indent does end the branch.
      if (c.name !== undefined && /\{\s*$/.test(t)) continue;
      return false;
    }
    return true;
  };
  let fn = null;
  let label = null;
  for (let i = cands.length - 1; i >= 0; i -= 1) {
    const c = cands[i];
    if (c.index >= index) continue;
    if (!encloses(c)) continue;
    if (c.name !== undefined) { fn = c; break; }
    if (!label) label = c;
  }
  return [fn && fn.name, label && label.label].filter(Boolean).join(' / ');
}

function withScope(source, index, rest) {
  const scope = enclosingScope(source, index);
  return scope ? `${scope} :: ${rest.trim()}` : rest.trim();
}

// The statement text on the ref's line BEFORE the match — call-site
// identity, so two byte-identical insert expressions in one file still
// carry distinct fingerprints (the assignment/return context differs) and
// a migrated site can't cancel against a newly added twin
// (GH Codex #3702 r4 P2). For a table string on its own line, the
// previous non-blank line carries the identity.
function statementPrefix(source, refIndex) {
  let lineStart = source.lastIndexOf('\n', refIndex - 1) + 1;
  let prefix = source.slice(lineStart, refIndex).trim();
  if (!prefix && lineStart > 0) {
    const prevEnd = lineStart - 1;
    const prevStart = source.lastIndexOf('\n', prevEnd - 1) + 1;
    prefix = source.slice(prevStart, prevEnd).trim();
  }
  return prefix.replace(/\s+/g, ' ');
}

// A builder captured in a variable (`const visits = trx('scheduled_services')`
// or `trx.table('scheduled_services')` / `.into(…)`) with the insert in a
// LATER statement: every subsequent `<alias>.insert(` in the file is a
// site (GH Codex #3702 r4 P2; table-last aliases r7 P2).
function chaseAlias(source, refIndex, site, statementText = statementPrefix(source, refIndex)) {
  // The binding is the statement's LHS: a declaration OR a plain
  // assignment to a bare identifier (`visits = trx(…)` — pre-push Codex
  // r8 P1). Property targets (`this.visits = …`) can't be chased by name.
  const assign = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])/.exec(statementText);
  if (!assign) return;
  chaseAliasName(source, assign[1], site, new Set());
}

function chaseAliasName(source, alias, site, seen) {
  if (seen.has(alias)) return;
  seen.add(alias);
  // Every later use of the alias is followed through its COMPLETE method
  // chain — `visits.clone().insert(data)`, `visits.where(…).insert(…)` —
  // not just a first-link `.insert(` (GH Codex r15 P2). A chain that ends
  // WITHOUT an insert but is bound to another name (`const refined =
  // visits.clone()`) propagates the table identity to that name
  // (GH Codex r17 P2).
  const aliasRe = new RegExp(`(?<![.\\w$])${alias}\\b`, 'g');
  let am;
  while ((am = aliasRe.exec(source)) !== null) {
    const chain = walkLinks(source, am.index + alias.length, alias);
    if (/\.insert\s*\(/.test(chain)) {
      site(am.index, `${statementPrefix(source, am.index)} alias:${fingerprintOf(chain)}`, insertArgument(chain));
      continue;
    }
    const bound = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:await\s+)?$/.exec(statementPrefix(source, am.index));
    if (bound && bound[1] !== alias) chaseAliasName(source, bound[1], site, seen);
  }
}

// The fluent chain following a table ref: from just past the ref string,
// the closing `)` of the call it is an argument of, then `.method(<balanced
// args>)` links repeated, trivia between links skipped (and excluded from
// the fingerprint). null when the ref is not a call argument.
function forwardChain(source, afterRef) {
  const i = skipTrivia(source, afterRef);
  if (source[i] !== ')') return null;
  return walkLinks(source, i + 1, "scheduled_services')");
}

// `.name(…)` / `['name'](…)` links from position `i`, appended to `seed`.
function walkLinks(source, i, seed) {
  let chain = seed;
  for (;;) {
    const j = skipTrivia(source, i);
    // `.name(` or the equivalent static bracket form `['name'](`
    // (GH Codex r11 P2) — both normalize to `.name` in the chain.
    let nm;
    let afterName;
    if (source[j] === '.') {
      nm = /^[A-Za-z0-9_$]+/.exec(source.slice(j + 1));
      if (!nm) break;
      nm = nm[0];
      afterName = j + 1 + nm.length;
    } else if (source[j] === '[') {
      const br = /^\[\s*(['"])([A-Za-z0-9_$]+)\1\s*\]/.exec(source.slice(j));
      if (!br) break;
      nm = br[2];
      afterName = j + br[0].length;
    } else break;
    const parenStart = skipTrivia(source, afterName);
    if (source[parenStart] !== '(') break;
    const end = balancedParens(source, parenStart);
    chain += `.${nm}${source.slice(parenStart, end)}`;
    i = end;
  }
  return chain;
}

// Collect scheduled_services insert-site fingerprints in one file by
// walking each table ref's ENTIRE chained expression. A builder stored in
// a variable first (`const visits = trx('scheduled_services'); await
// visits.insert(...)`) is followed through the alias: every later
// `<alias>.insert(` in the file counts as a site (GH Codex #3702 r4 P2).
function collectInsertSites(source, { sql = false } = {}) {
  const out = [];
  // A site whose payload came out of the completion helper is compliant —
  // it is what a bespoke adopter looks like — and is not reported.
  const site = (index, fingerprint, arg) => {
    if (!isContractCompleted(source, arg)) out.push(withScope(source, index, fingerprint));
  };
  // Raw SQL inserts are sites too — a knex.raw('INSERT INTO
  // scheduled_services …') must not slip past a builder-only scan
  // (GH Codex r5 P1) — including a schema-qualified table
  // (`INSERT INTO public.scheduled_services`, quoted or not; r5 P2).
  // …and PostgreSQL COPY / psql \copy INTO the table, which write rows
  // without an INSERT (GH Codex r17 P2).
  const rawRe = /(?:INSERT\s+INTO(?:\s+ONLY)?|MERGE\s+INTO(?:\s+ONLY)?|\bCOPY|\\copy)\s+(?:["'`]?\w+["'`]?\s*\.\s*)?["'`]?scheduled_services\b/gi;
  let rawM;
  while ((rawM = rawRe.exec(source)) !== null) {
    // Comment mentions are not sites (the iCal script documents its own
    // insert in prose) — judged at the MATCH position by a tokenizer walk,
    // not by the line's prefix, so `/* import */ await db.raw('INSERT …')`
    // is still a site (GH Codex r16 P2). `#` covers shell/SQL tools.
    if (insideComment(source, rawM.index, sql)) continue;
    const verb = /^insert/i.test(rawM[0]) ? 'INSERT INTO' : /^merge/i.test(rawM[0]) ? 'MERGE INTO' : 'COPY';
    // COPY direction comes from the keyword right after the target (and
    // its optional column list): FROM imports, TO exports — a "to" inside
    // a path or comment further along doesn't decide it (GH Codex r21 P2).
    if (verb === 'COPY') {
      const dir = /^[^\n]*?scheduled_services["'`]?\s*(?:\([^)]*\))?\s*(FROM|TO)\b/i.exec(source.slice(rawM.index, rawM.index + 400));
      if (dir && dir[1].toUpperCase() === 'TO') continue;
    }
    site(rawM.index, `${statementPrefix(source, rawM.index)} raw:${verb} scheduled_services`, null);
  }
  // Builder refs, schema-qualified or not (`trx('public.scheduled_services')`),
  // plus any CONSTANT bound to the table name in this file
  // (`const TABLE = 'scheduled_services'; trx(TABLE)…` — GH Codex r9 P2).
  // The literal may carry Knex's string alias (`'scheduled_services as s'`
  // — GH Codex r12 P2).
  const constNames = [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](?:\w+\.)?scheduled_services(?:\s+as\s+\w+)?['"`]/g)].map((c) => c[1]);
  const re = new RegExp(`['"\`](?:\\w+\\.)?scheduled_services(?:\\s+as\\s+\\w+)?['"\`]${constNames.length ? `|\\b(?:${constNames.join('|')})\\b` : ''}`, 'g');
  let m;
  while ((m = re.exec(source)) !== null) {
    // knex.batchInsert('scheduled_services', rows[, chunk]) — the table is
    // the FIRST argument, followed by a comma; the rows argument is the
    // payload (GH Codex r9 P2).
    if (/batchInsert\s*\($/.test(source.slice(Math.max(0, m.index - 24), m.index).replace(/\s+$/, ''))
      || /batchInsert\s*\(\s*$/.test(source.slice(Math.max(0, m.index - 24), m.index))) {
      const callOpen = source.lastIndexOf('(', m.index);
      const args = source.slice(callOpen + 1, balancedParens(source, callOpen) - 1);
      const rows = topLevelArgs(args)[1] || '';
      const head = (/^\s*(\{|\[|[A-Za-z0-9_.$]+)/.exec(rows) || [, ''])[1];
      site(m.index, `${statementPrefix(source, m.index)} batchInsert:scheduled_services, ${head}`, rows);
      continue;
    }
    // .into('scheduled_services') / .table('scheduled_services') refs. The
    // insert may sit BEFORE the ref (table-last:
    // trx.insert(data).into('scheduled_services') — GH Codex r5 P1): the
    // WHOLE statement up to the ref, walked backward from the link across
    // any number of lines (pre-push Codex r6 P1), carries the .insert( in
    // that shape. Or AFTER it (table-first:
    // trx.table('scheduled_services').insert(data) — GH Codex r8 P2): the
    // forward chain does. Neither → an alias may have been captured.
    const before = source.slice(Math.max(0, m.index - 12), m.index);
    // .from() is a table link too (pre-push Codex r20 P1).
    const link = /\.(into|table|from)\s*\($/.exec(before);
    if (link) {
      const linkAt = m.index - link[0].length;
      const stmt = source.slice(statementStart(source, linkAt), m.index).replace(/\s+/g, ' ').trim();
      const chain = forwardChain(source, m.index + m[0].length);
      if (/\.insert\s*\(/.test(stmt)) {
        site(m.index, `${stmt} table-last:scheduled_services`, insertArgument(stmt));
      } else if (chain && /\.insert\s*\(/.test(chain)) {
        site(m.index, `${stmt} ${fingerprintOf(chain)}`, insertArgument(chain));
      } else {
        chaseAlias(source, m.index, site, stmt);
      }
      continue;
    }
    // The ref must be the argument of a call: the next non-trivia char
    // closes it (this also catches a table string on its own line) — or,
    // in Knex's object-alias form `trx({ ss: 'scheduled_services' })`, the
    // value of a single-entry object that is the call's argument
    // (GH Codex r10 P2).
    let afterRef = m.index + m[0].length;
    const closeBrace = skipTrivia(source, afterRef);
    if (source[closeBrace] === '}' && source[skipTrivia(source, closeBrace + 1)] === ')') afterRef = closeBrace + 1;
    const chain = forwardChain(source, afterRef);
    if (chain === null) continue;
    const prefix = statementPrefix(source, m.index);
    if (/\.insert\s*\(/.test(chain)) {
      site(m.index, `${prefix} ${fingerprintOf(chain)}`, insertArgument(chain));
      continue;
    }
    // No insert on the fluent chain — if the builder was captured in a
    // variable, chase later .insert( calls through that alias.
    chaseAlias(source, m.index, site);
  }
  return out;
}

// The contract module's wrapper is certified only while (a) it completes
// its payload with the pinned statement, (b) every write to `data` between
// completion and insert is a certified one — increments included
// (GH Codex r20 P2) — and (c) `data` escapes to nothing but the inserts.
function certifiedWrapperViolations(moduleSource) {
  const out = [];
  if (moduleSource.split(CONTRACT_MODULE_CERTIFIED_COMPLETION).length !== 2) {
    out.push(`the certified wrapper no longer completes its payload with exactly \`${CONTRACT_MODULE_CERTIFIED_COMPLETION}\` — the certified insert sites would insert something else.`);
  }
  const wrapperAt = moduleSource.indexOf('async function createScheduledService');
  const wrapper = wrapperAt === -1 ? '' : stripComments(moduleSource.slice(wrapperAt, moduleSource.indexOf('\nmodule.exports', wrapperAt)));
  const prop = '\\bdata\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])+';
  const writeRe = new RegExp(
    `${prop}\\s*(?:[-+*/%|&^]|\\*\\*|\\?\\?|\\|\\||&&)?=(?![=>])[^;\\n]*;?`
    + `|${prop}\\s*(?:\\+\\+|--)[^;\\n]*;?`
    + `|(?:\\+\\+|--)\\s*${prop}[^;\\n]*;?`
    + '|\\bdelete\\s+data\\b[^;\\n]*;?'
    + '|\\bObject\\s*\\.\\s*assign\\s*\\(\\s*data\\b[^;\\n]*;?',
    'g',
  );
  for (const w of wrapper.match(writeRe) || []) {
    if (!CONTRACT_MODULE_CERTIFIED_WRITES.includes(w.trim())) out.push(`the certified wrapper writes to its completed payload in an uncertified way (\`${w.trim()}\`) — the certified insert sites would insert something other than the helper's output.`);
  }
  if (wrapper && (escapesThroughCall(wrapper, 'data') || escapesToBinding(wrapper, 'data'))) {
    out.push('the certified wrapper hands its completed payload to something other than the certified inserts.');
  }
  return out;
}

function relRepo(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

// Multiset diff: entries in `a` not matched one-for-one in `b`.
function multisetMissing(a, b) {
  const pool = [...b];
  const missing = [];
  for (const item of a) {
    const idx = pool.indexOf(item);
    if (idx === -1) missing.push(item);
    else pool.splice(idx, 1);
  }
  return missing;
}

describe('booking insert-site contract', () => {
  // ops/agents is an established production-write surface (mutating
  // tools, dry-run by default) — a scheduled_services insert there is a
  // booking writer like any other (GH Codex r9 P2).
  const files = [...walk(SERVER_ROOT), ...walk(path.join(REPO_ROOT, 'scripts')), ...walk(path.join(REPO_ROOT, 'ops'))];
  const found = new Map(); // repo-relative path -> fingerprint multiset
  for (const file of files) {
    const rel = relRepo(file);
    const sites = collectInsertSites(fs.readFileSync(file, 'utf8'), { sql: /\.(?:sql|sh)$/.test(file) });
    if (sites.length > 0) found.set(rel, sites);
  }

  test('the matcher recognizes every insert shape it claims to (self-check)', () => {
    const IMPORT = "const { completeScheduledServiceInsert } = require('../services/booking/create-scheduled-service');\n";
    expect(collectInsertSites("await trx('scheduled_services').insert(insertData).returning('*');")).toEqual(["await trx( scheduled_services').insert(insertData"]);
    expect(collectInsertSites("const [r] = await sp('scheduled_services')\n  .insert({\n    customer_id: id,\n  })")).toEqual(["const [r] = await sp( scheduled_services').insert({"]);
    expect(collectInsertSites("await trx('scheduled_services')\n  .insert(insertData)\n  .onConflict('idempotency_key')\n  .ignore()")).toEqual(["await trx( scheduled_services').insert(insertData"]);
    // A LONG chain (any number of links/lines before .insert) is caught —
    // the bounded 3-line window this replaces was evadable by padding.
    expect(collectInsertSites("await trx('scheduled_services')\n  .where({ a: 1 })\n  // pad\n  .whereIn('c', [1, 2])\n  .orderBy('d')\n  .limit(1)\n  .insert(sneaky)")[0]).toContain('.insert(sneaky');
    // A table argument split across lines is still a ref.
    expect(collectInsertSites("await db(\n  'scheduled_services'\n).insert(x)")).toEqual(["await db( scheduled_services').insert(x"]);
    // A builder captured in a variable is followed through the alias
    // (GH Codex r4 P2 — the fluent-chain-only scan missed it).
    expect(collectInsertSites("const visits = trx('scheduled_services');\nawait doStuff();\nawait visits.insert(data);")).toEqual(["await alias:visits.insert(data"]);
    // Knex's string alias form is the same table (GH Codex r12 P2)…
    expect(collectInsertSites("await trx('scheduled_services as s').insert(data);")).toEqual(["await trx( scheduled_services').insert(data"]);
    expect(collectInsertSites("const T = 'scheduled_services as ss';\nawait trx(T).insert(data);")).toEqual(["await trx( scheduled_services').insert(data"]);
    expect(collectInsertSites("await trx('scheduled_services as s').where({ 's.id': id }).first();")).toEqual([]);
    // Static bracket-notation calls are chain links too (GH Codex r11 P2)…
    expect(collectInsertSites("await trx('scheduled_services')['insert'](data);")).toEqual(["await trx( scheduled_services').insert(data"]);
    expect(collectInsertSites("const visits = trx('scheduled_services');\nawait visits['insert'](data);")).toEqual(["await alias:visits.insert(data"]);
    expect(collectInsertSites("await trx('scheduled_services')['where']({ id })['first']();")).toEqual([]);
    // Knex's object-alias table form is a ref (GH Codex r10 P2)…
    expect(collectInsertSites("await trx({ ss: 'scheduled_services' }).insert(data);")).toEqual(["await trx({ ss: scheduled_services').insert(data"]);
    expect(collectInsertSites("const ss = trx({ ss: 'scheduled_services' });\nawait ss.insert(data);")).toEqual(["await alias:ss.insert(data"]);
    expect(collectInsertSites("await trx({ ss: 'scheduled_services' }).where({ 'ss.id': id }).first();")).toEqual([]);
    // A constant bound to the table name is followed (GH Codex r9 P2)…
    expect(collectInsertSites("const TABLE = 'scheduled_services';\nawait trx(TABLE).insert(data);")).toEqual(["await trx( scheduled_services').insert(data"]);
    expect(collectInsertSites("const TABLE = 'scheduled_services';\nconst visits = trx(TABLE);\nawait visits.insert(data);")).toEqual(["await alias:visits.insert(data"]);
    expect(collectInsertSites("const TABLE = 'scheduled_services';\nawait trx.insert(data).into(TABLE);")).toHaveLength(1);
    expect(collectInsertSites("const TABLE = 'scheduled_services';\nawait trx(TABLE).where({ id }).first();")).toEqual([]);
    // …and so is knex.batchInsert, literal or constant table (r9 P2); rows
    // that all came out of the helper are compliant.
    expect(collectInsertSites("await trx.batchInsert('scheduled_services', rows, 50);")).toEqual(["await trx.batchInsert( batchInsert:scheduled_services, rows"]);
    expect(collectInsertSites("const TABLE = 'scheduled_services';\nawait knex.batchInsert(TABLE, [row]);")).toEqual(["await knex.batchInsert( batchInsert:scheduled_services, ["]);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nawait trx.batchInsert('scheduled_services', rows);`)).toEqual([]);
    // …a for…of loop that mutates or escapes its element is a mutation (r17 P2), a read-only one is fine, a destructured binding fails closed…
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nfor (const row of rows) row.source_action = null;\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nfor (const row of rows) {\n  stripAttribution(row);\n}\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nfor (const [i, row] of rows.entries()) log(i);\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nfor (const row of rows) {\n  if (row.status === 'x') logger.info('row', row);\n}\nawait trx.batchInsert('scheduled_services', rows);`)).toEqual([]);
    // …a mutating array method smuggles a row past the helper (r12 P2), while a read-only one is fine…
    for (const smuggle of ['rows.unshift(raw);', 'rows.splice(0, 0, raw);', 'rows.fill(raw);']) {
      expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\n${smuggle}\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    }
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nconst ids = rows.map((r) => r.customer_id);\nif (rows.some((r) => !r.customer_id)) throw new Error('x');\nawait trx.batchInsert('scheduled_services', rows);`)).toEqual([]);
    // …and a callback that mutates the element it is handed is a mutation too (r13 P2)…
    for (const cb of ['rows.forEach((row) => { row.source_action = null; });', 'rows.map(function (row) { delete row.source_action; return row; });', 'rows.reduce((acc, row) => { row.status = "x"; return acc; }, []);', 'rows.forEach(row => Object.assign(row, raw));']) {
      expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\n${cb}\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    }
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows.forEach((row) => { if (row.status === 'x') count += 1; });\nawait trx.batchInsert('scheduled_services', rows);`)).toEqual([]);
    // …a for await…of loop is inspected like for…of (r21 P2)…
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nfor await (const row of rows) row.source_action = null;\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    // …a destructuring or boxed binding built from the payload is an escape, a property read or spread copy is not (r21 P2)…
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst [alias] = [data];\nalias.source_action = null;\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst box = { inner: data };\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    // …and a nested reference inside a non-allowlisted call's argument is an escape (r21 P2).
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nmutate({ payload: data });\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nlogger.info({ payload: data });\nconst n = count(data.items);\nawait trx('scheduled_services').insert(data);`)).toEqual([]);
    // (prose in a comment is never a call or a binding)
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\n// counts as absent (the column is\n// nullable) and mutate(data) is documented here\nawait trx('scheduled_services').insert(data);`)).toEqual([]);
    // …an alias of the callback element (or a for…of element) is an escape (r20 P2)…
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows.forEach(row => { const alias = row; alias.source_action = null; });\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nfor (const row of rows) {\n  const alias = row;\n  alias.status = 'x';\n}\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    // …a callback binding the ARRAY parameter can replace rows through it → fail closed; the index alone is fine (r18 P2).
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows.forEach((row, i, array) => { array[i] = raw; });\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows.forEach((row, i) => logger.info(i, row));\nawait trx.batchInsert('scheduled_services', rows);`)).toEqual([]);
    // …and handing the element to a helper from the callback is an escape (r14 P2), a logger is not.
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows.forEach(row => stripAttribution(row));\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows.forEach((row) => logger.info('row', row));\nawait trx.batchInsert('scheduled_services', rows);`)).toEqual([]);
    // …unless a completed row is mutated in place afterwards (r10 P2).
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, opts));\nrows[0].source_action = null;\nawait trx.batchInsert('scheduled_services', rows);`)).toHaveLength(1);
    // .from() is a table link like .table()/.into() (pre-push r20 P1)…
    expect(collectInsertSites("await trx.from('scheduled_services').insert(data);")).toEqual(["await trx.from( scheduled_services').insert(data"]);
    expect(collectInsertSites("const v = trx.from('scheduled_services');\nawait v.insert(data);")).toEqual(["await alias:v.insert(data"]);
    expect(collectInsertSites("await trx.insert(data).from('scheduled_services');")).toHaveLength(1);
    expect(collectInsertSites("await trx.from('scheduled_services').where({ id }).first();")).toEqual([]);
    // Table-FIRST fluent forms are sites (GH Codex r8 P2)…
    expect(collectInsertSites("await trx.table('scheduled_services').insert(data);")).toEqual(["await trx.table( scheduled_services').insert(data"]);
    expect(collectInsertSites("const [row] = await trx\n  .into('scheduled_services')\n  .insert(data)\n  .returning('*');")).toEqual(["const [row] = await trx .into( scheduled_services').insert(data"]);
    // …while a table-first READ is not.
    expect(collectInsertSites("await trx.table('scheduled_services').where({ id }).first();")).toEqual([]);
    // …a plain assignment binds the alias too (pre-push r8 P1)…
    expect(collectInsertSites("let visits;\nvisits = trx('scheduled_services');\nawait visits.insert(data);")).toEqual(["await alias:visits.insert(data"]);
    // …and the alias's COMPLETE chain is followed (r15 P2): a refined builder
    // that ends in insert is a site, one that ends in a read is not.
    expect(collectInsertSites("const visits = trx('scheduled_services');\nawait visits.clone().insert(data);")).toEqual(["await alias:visits.clone().insert(data"]);
    expect(collectInsertSites("const visits = trx('scheduled_services');\nconst [row] = await visits\n  .where({ id })\n  .insert(data)\n  .returning('*');")).toEqual(["const [row] = await alias:visits.where({ id }).insert(data"]);
    expect(collectInsertSites("const visits = trx('scheduled_services');\nconst n = await visits.clone().count();")).toEqual([]);
    // …and a builder DERIVED from the alias carries the table identity (r17 P2).
    expect(collectInsertSites("const visits = trx('scheduled_services');\nconst refined = visits.clone();\nawait refined.insert(data);")).toEqual(["await alias:refined.insert(data"]);
    expect(collectInsertSites("const visits = trx('scheduled_services');\nconst refined = visits.where({ a: 1 });\nconst again = refined.clone();\nawait again.insert(data);")).toEqual(["await alias:again.insert(data"]);
    // …including an alias captured through the table-last forms (r7 P2).
    expect(collectInsertSites("const visits = trx.table('scheduled_services');\nawait doStuff();\nawait visits.insert(data);")).toEqual(["await alias:visits.insert(data"]);
    expect(collectInsertSites("const visits = trx\n  .into('scheduled_services');\nawait visits.insert(data);")).toEqual(["await alias:visits.insert(data"]);
    // Two byte-identical insert EXPRESSIONS in different statements carry
    // distinct call-site identities (GH Codex r4 P2 — a migrated site must
    // not cancel against a newly added twin).
    const twins = collectInsertSites("const [a] = await trx('scheduled_services').insert(insertData);\nreturn trx('scheduled_services').insert(insertData);");
    expect(new Set(twins).size).toBe(2);
    // …and so do byte-identical STATEMENTS in different enclosing scopes:
    // functions, router handlers, or branches of one function (GH Codex
    // r6 P2). A closed sibling scope does not leak onto a later site.
    expect(collectInsertSites("async function a(trx) {\n  const [row] = await trx('scheduled_services').insert(data);\n}\nasync function b(trx) {\n  const [row] = await trx('scheduled_services').insert(data);\n}")).toEqual([
      "a :: const [row] = await trx( scheduled_services').insert(data",
      "b :: const [row] = await trx( scheduled_services').insert(data",
    ]);
    expect(collectInsertSites("router.post('/x', async (req, res) => {\n  await trx('scheduled_services').insert(data);\n});\nrouter.put('/y', async (req, res) => {\n  await trx('scheduled_services').insert(data);\n});")).toEqual([
      "post /x :: await trx( scheduled_services').insert(data",
      "put /y :: await trx( scheduled_services').insert(data",
    ]);
    expect(collectInsertSites("async function run(trx, {\n  action,\n}) {\n  const helper = () => {\n    return 1;\n  };\n  if (action === 'extend') {\n    const [row] = await trx('scheduled_services').insert(data);\n  } else if (action === 'convert') {\n    const [row] = await trx('scheduled_services').insert(data);\n  }\n  switch (action) {\n    case 'a':\n      await trx('scheduled_services').insert(data);\n      break;\n    case 'b':\n      await trx('scheduled_services').insert(data);\n      break;\n  }\n}")).toEqual([
      "run / action === 'extend' :: const [row] = await trx( scheduled_services').insert(data",
      "run / action === 'convert' :: const [row] = await trx( scheduled_services').insert(data",
      "run / case 'a' :: await trx( scheduled_services').insert(data",
      "run / case 'b' :: await trx( scheduled_services').insert(data",
    ]);
    // Table-last forms and raw SQL are caught (GH Codex r5 P1).
    expect(collectInsertSites("await trx.insert(data).into('scheduled_services');")).toEqual(["await trx.insert(data).into( table-last:scheduled_services"]);
    expect(collectInsertSites("await trx.insert(data).table('scheduled_services');")).toEqual(["await trx.insert(data).table( table-last:scheduled_services"]);
    // …across any number of lines, inside a block (pre-push Codex r6 P1).
    expect(collectInsertSites("async function save(trx, data) {\n  await audit();\n  return trx\n    .insert(data)\n    .into('scheduled_services');\n}")).toEqual(["save :: return trx .insert(data) .into( table-last:scheduled_services"]);
    expect(collectInsertSites("const [row] = await trx\n  .insert(data)\n  .returning('*')\n  .table('scheduled_services');")).toEqual(["const [row] = await trx .insert(data) .returning('*') .table( table-last:scheduled_services"]);
    expect(collectInsertSites("await db.raw(`INSERT INTO scheduled_services (a) VALUES (?)`, [1]);")).toEqual(["await db.raw(` raw:INSERT INTO scheduled_services"]);
    // A closed block comment BEFORE the statement doesn't hide it; a real
    // comment (line, block, SQL --, shell #) does (r16 P2).
    expect(collectInsertSites("/* booking import */ await db.raw('INSERT INTO scheduled_services (a) VALUES (1)');")).toHaveLength(1);
    expect(collectInsertSites("// await db.raw('INSERT INTO scheduled_services (a) VALUES (1)');")).toEqual([]);
    expect(collectInsertSites("/* documents: INSERT INTO scheduled_services happens below */\nconst x = 1;")).toEqual([]);
    expect(collectInsertSites("const s = 'not // a comment'; await db.raw('INSERT INTO scheduled_services (a) VALUES (1)');")).toHaveLength(1);
    // MERGE INTO the table is a writer too, standalone or in db.raw (r18 P2).
    expect(collectInsertSites("MERGE INTO scheduled_services s USING staged t ON s.id = t.id WHEN NOT MATCHED THEN INSERT VALUES (t.id);")).toEqual(["raw:MERGE INTO scheduled_services"]);
    expect(collectInsertSites("await db.raw(`MERGE INTO scheduled_services s USING staged t ON s.id = t.id WHEN NOT MATCHED THEN INSERT VALUES (t.id)`);")).toHaveLength(1);
    // COPY / \\copy INTO the table are writers; COPY … TO is an export (r17 P2).
    expect(collectInsertSites("COPY scheduled_services (customer_id) FROM STDIN;")).toEqual(["raw:COPY scheduled_services"]);
    expect(collectInsertSites("psql \"$DATABASE_URL\" -c \"\\\\copy scheduled_services from 'rows.csv'\"")).toHaveLength(1);
    expect(collectInsertSites("COPY scheduled_services TO '/tmp/out.csv';")).toEqual([]);
    // …direction comes from the keyword after the target, not a later "to" in a path (r21 P2)…
    expect(collectInsertSites("COPY scheduled_services (customer_id) FROM '/tmp/to/rows.csv';")).toHaveLength(1);
    expect(collectInsertSites("COPY scheduled_services (customer_id) TO '/tmp/from/out.csv';")).toEqual([]);
    // …and INSERT INTO ONLY is a writer (r21 P2).
    expect(collectInsertSites("INSERT INTO ONLY scheduled_services (customer_id) VALUES (1);")).toEqual(["raw:INSERT INTO scheduled_services"]);
    // Shell / SQL tools: a psql insert is a site, a # comment is not.
    expect(collectInsertSites('psql "$DATABASE_URL" -c "INSERT INTO scheduled_services (customer_id) VALUES (1)"', { sql: true })).toHaveLength(1);
    expect(collectInsertSites('# never: INSERT INTO scheduled_services\npsql "$DATABASE_URL" -c "SELECT 1"', { sql: true })).toEqual([]);
    expect(collectInsertSites('-- INSERT INTO scheduled_services is documented here\nSELECT 1;', { sql: true })).toEqual([]);
    // …while in JavaScript `--` is a decrement, never a comment (r20 P2).
    expect(collectInsertSites("count--; await db.raw('INSERT INTO scheduled_services (a) VALUES (1)');")).toHaveLength(1);
    expect(collectInsertSites("--count; await db.raw('INSERT INTO scheduled_services (a) VALUES (1)');")).toHaveLength(1);
    // Schema-qualified forms, raw or builder, are the same table (r5 P2).
    expect(collectInsertSites("await db.raw(`INSERT INTO public.scheduled_services (a) VALUES (?)`, [1]);")).toEqual(["await db.raw(` raw:INSERT INTO scheduled_services"]);
    expect(collectInsertSites('await db.raw(\'INSERT INTO "public"."scheduled_services" (a) VALUES (?)\', [1]);')).toHaveLength(1);
    expect(collectInsertSites("await trx('public.scheduled_services').insert(x);")).toEqual(["await trx( scheduled_services').insert(x"]);
    // A bespoke insert whose payload came out of the CANONICAL completion
    // helper is COMPLIANT — it may leave the frozen inventory (GH Codex r5 P2)…
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, { trx, cols, source });\nconst [row] = await trx('scheduled_services').insert(data).returning('*');`)).toEqual([]);
    expect(collectInsertSites(`${IMPORT}await trx('scheduled_services').insert(await completeScheduledServiceInsert(raw, { trx, cols, source }));`)).toEqual([]);
    expect(collectInsertSites(`${IMPORT}const rows = [];\nfor (const r of raws) rows.push(await completeScheduledServiceInsert(r, { trx, cols, source }));\nawait trx('scheduled_services').insert(rows);`)).toEqual([]);
    expect(collectInsertSites(`${IMPORT}const rows = await Promise.all(raws.map((r) => completeScheduledServiceInsert(r, { trx, cols, source })));\nconst visits = trx('scheduled_services');\nawait visits.insert(rows);`)).toEqual([]);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nawait trx.insert(data).into('scheduled_services');`)).toEqual([]);
    // …an ESM import of the canonical helper counts too (r17 P2)…
    expect(collectInsertSites("import { completeScheduledServiceInsert } from '../services/booking/create-scheduled-service.js';\nconst data = await completeScheduledServiceInsert(raw, opts);\nawait trx('scheduled_services').insert(data);")).toEqual([]);
    // …Knex's returning overload keeps the payload as the FIRST argument (r18 P2)…
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst [row] = await trx('scheduled_services').insert(data, '*');`)).toEqual([]);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst [id] = await trx('scheduled_services').insert(data, ['id']);`)).toEqual([]);
    expect(collectInsertSites("await trx('scheduled_services').insert(raw, '*');")).toHaveLength(1);
    // …but a same-named helper that is NOT the canonical module's — no
    // import, a local definition, or an import from elsewhere — launders
    // nothing (GH Codex r6 P2)…
    expect(collectInsertSites("const data = await completeScheduledServiceInsert(raw, opts);\nawait trx('scheduled_services').insert(data);")).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}function completeScheduledServiceInsert(x) { return x; }\nconst data = await completeScheduledServiceInsert(raw, opts);\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites("const { completeScheduledServiceInsert } = require('./my-booking-helpers');\nconst data = await completeScheduledServiceInsert(raw, opts);\nawait trx('scheduled_services').insert(data);")).toHaveLength(1);
    // …and importing the canonical helper elsewhere in the file launders nothing either…
    expect(collectInsertSites(`${IMPORT}const ok = await completeScheduledServiceInsert(raw, opts);\nawait trx('scheduled_services').insert(other);`)).toEqual(["await trx( scheduled_services').insert(other"]);
    // …a value only PARTLY rooted in the helper stays bare (pre-push r6 P1)…
    expect(collectInsertSites(`${IMPORT}const data = useContract ? await completeScheduledServiceInsert(raw, opts) : buildRaw();\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = { ...(await completeScheduledServiceInsert(raw, opts)), extra: 1 };\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}await trx('scheduled_services').insert((await completeScheduledServiceInsert(raw, opts)) || raw);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const rows = await Promise.all(raws.map((r) => r.ok ? completeScheduledServiceInsert(r, opts) : r));\nawait trx('scheduled_services').insert(rows);`)).toHaveLength(1);
    // …an identifier that is not ONE binding file-wide stays bare: a
    // parameter of the same name elsewhere, or a shadowing declaration
    // (pre-push r6 P1 — the scan is textual, not lexical)…
    expect(collectInsertSites(`${IMPORT}async function a(raw) {\n  const data = await completeScheduledServiceInsert(raw, opts);\n  return data;\n}\nasync function b(trx, data) {\n  await trx('scheduled_services').insert(data);\n}`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nlist.forEach((data) => trx('scheduled_services').insert(data));`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst save = data => trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\n{\n  const data = raw;\n  await trx('scheduled_services').insert(data);\n}`)).toHaveLength(1);
    // (control-flow parens and call arguments are not parameter positions)
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nif (data) {\n  logger.info(data);\n  await trx('scheduled_services').insert(data);\n}`)).toEqual([]);
    // …a completed payload that ESCAPES into another binding stays bare —
    // it could be mutated under that name (GH Codex r9 P2)…
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst alias = data;\nalias.source_action = null;\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nlet alias;\nalias = data\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    // …and so does passing it to a helper that could mutate it (r11 P2)…
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nstripAttribution(data);\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nawait audit.record('x', data);\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    // (a nested call earlier in the argument list can't hide it — r12 P2)
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nmutate(makeOptions({ a: 1 }), data);\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nlogger.info(makeCtx(), data);\nawait trx('scheduled_services').insert(data);`)).toEqual([]);
    // (a property read, a spread, or a known non-mutating callee is not an escape)
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nconst id = data.customer_id;\nconst copy = { ...data };\nlogger.info('booking', data);\nconst json = JSON.stringify(data);\nawait trx('scheduled_services').insert(data);`)).toEqual([]);
    // …a payload MUTATED after completion stays bare (pre-push r6 P1)…
    for (const mutation of ['data.customer_id = null;', "data['status'] = 'x';", 'data.count += 1;', 'Object.assign(data, raw);', 'delete data.source_action;', 'data.meta.note = null;', "data[0]['source_action'] = null;", 'data.count++;', '++data.meta.count;', 'data.count--;']) {
      expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\n${mutation}\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    }
    // (a READ of a property, or a comparison, is not a mutation)
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nif (data.status === 'x' || data.n >= 2) log(data.customer_id);\nawait trx('scheduled_services').insert(data);`)).toEqual([]);
    // …a payload REASSIGNED without the helper stays bare…
    expect(collectInsertSites(`${IMPORT}let data = await completeScheduledServiceInsert(raw, opts);\ndata = buildRaw();\nawait trx('scheduled_services').insert(data);`)).toHaveLength(1);
    // …and raw SQL never passes through the helper.
    expect(collectInsertSites(`${IMPORT}const data = await completeScheduledServiceInsert(raw, opts);\nawait db.raw(\`INSERT INTO scheduled_services (a) VALUES (?)\`, [data.a]);`)).toHaveLength(1);
    // …but a table-last READ does not.
    expect(collectInsertSites("await trx.select('*').from('x').table('scheduled_services');")).toEqual([]);
    // A read chained near the ref must NOT count…
    expect(collectInsertSites("await trx('scheduled_services').where({ id }).first();")).toEqual([]);
    // …nor an insert into a DIFFERENT table on the next line.
    expect(collectInsertSites("await trx('scheduled_services').where({ id }).update({ a: 1 });\nawait trx('lead_activities').insert({ b: 2 });")).toEqual([]);
  });

  test('the certified-wrapper check sees every write shape, increments included (self-check)', () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, CONTRACT_MODULE), 'utf8');
    expect(certifiedWrapperViolations(real)).toEqual([]);
    for (const write of ['data.retry_count++;', '++data.retry_count;', 'data.retry_count--;', 'data.source_action = null;', 'delete data.source_action;', 'Object.assign(data, extra);']) {
      const tampered = real.replace(CONTRACT_MODULE_CERTIFIED_COMPLETION, `${CONTRACT_MODULE_CERTIFIED_COMPLETION}\n  ${write}`);
      expect(certifiedWrapperViolations(tampered).length).toBeGreaterThan(0);
    }
    const escaped = real.replace(CONTRACT_MODULE_CERTIFIED_COMPLETION, `${CONTRACT_MODULE_CERTIFIED_COMPLETION}\n  const alias = data;`);
    expect(certifiedWrapperViolations(escaped).length).toBeGreaterThan(0);
    const swapped = real.replace(CONTRACT_MODULE_CERTIFIED_COMPLETION, 'const data = insertData;');
    expect(certifiedWrapperViolations(swapped).length).toBeGreaterThan(0);
  });

  test('no NEW or MODIFIED scheduled_services insert sites outside the booking contract', () => {
    const violations = [];
    for (const [rel, sites] of found) {
      if (rel === CONTRACT_MODULE) {
        const extra = multisetMissing(sites, CONTRACT_MODULE_CERTIFIED_SITES);
        if (extra.length) violations.push(`${rel}: insert site(s) [${extra.join(' | ')}] beyond the certified wrapper — every insert in the contract module must be of completeScheduledServiceInsert's output, inside createScheduledService.`);
        for (const v of certifiedWrapperViolations(fs.readFileSync(path.join(REPO_ROOT, CONTRACT_MODULE), 'utf8'))) violations.push(`${rel}: ${v}`);
        continue;
      }
      const frozen = FROZEN_LEGACY_INSERT_SITES_2026_09[rel];
      if (frozen === undefined) {
        violations.push(`${rel}: ${sites.length} site(s) — new file. Route the insert through ${CONTRACT_MODULE}.`);
        continue;
      }
      const extra = multisetMissing(sites, frozen);
      if (extra.length) {
        violations.push(`${rel}: unrecognized insert site(s) [${extra.join(' | ')}] — new or reworked. Adopt the contract; never add or edit a frozen fingerprint.`);
      }
    }
    if (violations.length) {
      throw new Error(
        'Bare scheduled_services insert(s) found outside the booking contract:\n'
        + `  ${violations.join('\n  ')}\n`
        + 'Use createScheduledService / completeScheduledServiceInsert from '
        + `${CONTRACT_MODULE}.`,
      );
    }
  });

  test('the frozen inventory mirrors reality (stale entries must be removed)', () => {
    const stale = [];
    const wrapperGone = multisetMissing(CONTRACT_MODULE_CERTIFIED_SITES, found.get(CONTRACT_MODULE) || []);
    if (wrapperGone.length) stale.push(`${CONTRACT_MODULE}: certified wrapper site(s) no longer present [${wrapperGone.join(' | ')}] — update CONTRACT_MODULE_CERTIFIED_SITES with the wrapper.`);
    for (const [rel, frozen] of Object.entries(FROZEN_LEGACY_INSERT_SITES_2026_09)) {
      const gone = multisetMissing(frozen, found.get(rel) || []);
      if (gone.length) {
        stale.push(`${rel}: frozen site(s) no longer present [${gone.join(' | ')}] — remove them from the map in the same PR.`);
      }
    }
    if (stale.length) throw new Error(`Frozen insert inventory is stale:\n  ${stale.join('\n  ')}`);
  });
});
