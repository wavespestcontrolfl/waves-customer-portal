/**
 * Tax ledger rules + inbox decisions (GATE_TAX_LEDGER, nested under
 * GATE_BANK_IMPORT).
 *
 * applyRules(): for every staged bank row still 'unmatched' that no rule
 * has looked at, the first enabled rule whose pattern matches the
 * description writes the suggestion (same jsonb the Bank Import tab and
 * create-expense already read: categoryId/categoryName for an expense,
 * ignore+reason for personal/transfer, income for a processor payout,
 * review+note when the owner must decide). Status never changes here.
 *
 * decide(): the Inbox's one-tap outcome for a row. personal / transfer
 * park the row as 'ignored' with the reason recorded; later moves it to the
 * Later shelf; income moves it to the Income shelf, still an open row,
 * because nothing counts it as revenue yet (a customer receipt outside the
 * processor is recorded as a sale by hand, or by the return engine later);
 * expense answers createExpense:true and the client calls the existing
 * /bank-import/:id/create-expense (one tested path for making an expense).
 * always:true also writes an owner rule from the payee and pre-fills every
 * other open row with the same payee.
 *
 * Nothing here moves money or leaves the admin.
 */
const db = require('../models/db');
const logger = require('./logger');
const bankImport = require('./bank-import');
const { gateEnvValue } = require('../config/feature-gates');
const { SEED_RULES, CATEGORY_LINES } = require('./tax-ledger-seed-rules');

const KINDS = ['expense', 'personal', 'transfer', 'income', 'review'];
const DECISIONS = ['expense', 'personal', 'transfer', 'income', 'later'];
const MAX_PATTERN = 240;
const OWNER_PRIORITY = 10;
const PAGE = 500;
const MAX_EXAMINE = 20000;

// The suggestion keys a classification owns. A new classification removes
// them before it merges, so a row never carries two answers at once; the
// reconciliation keys (candidates, plaid*, verifyPending, ...) and the
// evaluation stamp are left alone.
const CLASSIFICATION_KEYS = ['categoryId', 'categoryName', 'irsLine', 'categorySource', 'ignore', 'personal', 'income', 'reason', 'review', 'note', 'rule', 'decision', 'decidedAt'];

// Inbox views. open = everything still to decide; later and income are the
// two shelves. An income row is a customer receipt outside the processor:
// it is NOT in the P&L or any report, and it stays listed until it is
// recorded as a sale (or, later, counted by the return engine).
// A row the matcher is still asking about (a possible link to an existing
// expense, payout or refund: suggestion.candidates / payoutCandidates /
// refundCandidates) belongs to Bank Import, where the link workflow lives;
// the Inbox never shows it and decide() refuses it, so "Business" can never
// create a second expense for a charge that is already booked.
const CANDIDATE_KEYS = ['candidates', 'payoutCandidates', 'refundCandidates'];
const NO_LIVE_CANDIDATES_SQL = CANDIDATE_KEYS
  .map((k) => `(case when jsonb_typeof(suggestion->'${k}') = 'array' then jsonb_array_length(suggestion->'${k}') else 0 end) = 0`)
  .join(' and ');
function hasLiveCandidates(row) {
  const sug = (row && row.suggestion) || {};
  return CANDIDATE_KEYS.some((k) => Array.isArray(sug[k]) && sug[k].length > 0);
}
// Only a row the deterministic matcher has examined can reach the Inbox or
// a decision: until then an existing expense or payout for it may still be
// found. The marker is the matcher's own pool definition (bank-import.js
// runDeterministicMatching: noMatch, ignore, or a parked candidate list).
// An ignore flag counts only when the MATCHER wrote it (no rule key): a
// transfer rule also writes ignore, and a rule must never be able to
// manufacture "examined". Rules are applied to examined rows only, so the
// two never meet; this keeps it true even if that changes.
// (Function forms: knex.raw would read the ? and ?| operators as bindings.)
// 'examined' is written by decide() only, when a decision must drop the
// matcher's ignore flag (the only marker a transfer-shaped row carries), so
// the evidence survives the classification change. No rule ever writes it.
const MATCHER_KEYS = ['noMatch', 'candidates', 'payoutCandidates', 'refundCandidates', 'examined'];
const SUG = "coalesce(suggestion, '{}'::jsonb)";
const MATCHER_EXAMINED_SQL = `(jsonb_exists_any(${SUG}, array[${MATCHER_KEYS.map((k) => `'${k}'`).join(',')}]) or (jsonb_exists(${SUG}, 'ignore') and not jsonb_exists(${SUG}, 'rule')))`;
function matcherExamined(row) {
  const sug = (row && row.suggestion) || {};
  const has = (k) => sug[k] !== undefined && sug[k] !== null;
  return MATCHER_KEYS.some(has) || (has('ignore') && !has('rule'));
}
// Why a row cannot be decided from the Inbox (null = it can).
function inboxBlock(row) {
  if (!matcherExamined(row)) return 'the matcher has not examined this row yet (it runs on the next sync): an expense or payout already booked may still explain it';
  if (hasLiveCandidates(row)) return 'this row may match an expense or payout that is already booked: decide it in Bank Import';
  return null;
}
const ELIGIBLE_SQL = `${MATCHER_EXAMINED_SQL} and ${NO_LIVE_CANDIDATES_SQL}`;
// what every decision UPDATE requires, so a matcher that parks candidates
// (or a bank change) while the owner is deciding wins the race
const DECIDABLE_SQL = `${bankImport.BANK_CHANGE_UNRESOLVED_SQL_NOT} and ${ELIGIBLE_SQL}`;
const VIEW_SQL = {
  open: `coalesce(suggestion->>'later','') <> 'true' and coalesce(suggestion->>'income','') <> 'true' and ${ELIGIBLE_SQL}`,
  later: `coalesce(suggestion->>'later','') = 'true' and ${ELIGIBLE_SQL}`,
  income: `coalesce(suggestion->>'income','') = 'true' and ${ELIGIBLE_SQL}`,
  bankImport: `not (${NO_LIVE_CANDIDATES_SQL})`,
  unexamined: `not ${MATCHER_EXAMINED_SQL}`,
};
const INCOME_REASON = 'customer receipt outside the processor: not in the P&L or any report until it is recorded as a sale';

function isOn() {
  return !!(gateEnvValue('GATE_BANK_IMPORT') && gateEnvValue('GATE_TAX_LEDGER'));
}

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

// Patterns run synchronously on every staged row during imports and the
// hourly sync, so every rule (seed or owner) must fit a grammar that cannot
// backtrack catastrophically: words and spaces, | alternation, (…) groups
// that may only be optional, \b, the escapes \W \s \d \w with * or ?, a
// dot with * or ?, an escaped literal, a [class] (no repeat), and ? on a
// single character. No + or * on a word, class or group, no {n,m}, no
// backreference, no lookaround, no anchors. Every seed and every pattern
// the Inbox writes fits.
const GRAMMAR_TOKEN = /\\[bB]|\\[WwsSdD][*?]?|\\[.*+?()[\]{}|\\\/$^-]\??|\.[*?]?|[A-Za-z0-9 _&',\/#:;@%!=-]\??|\(|\)\??|\||\[\^?(?:\\.|[^\]\\])+\]\??/y;
const GRAMMAR_HELP = 'allowed: words and spaces, |, (…) or (…)?, \\b, \\W* \\s* \\d*, . .* .?, an escaped literal such as \\., a [class], ? after one character, at most 2 wildcards, 3 optional parts and 2 groups per alternative; not allowed: + * {} on a word, class or group, backreferences, lookarounds, anchors';
// Per top-level alternative the ambiguous parts are capped too: at most
// MAX_STARS wildcards (.* \W* \s* \d* \w*), MAX_OPTIONAL optional parts
// (x? .? (…)? [..]?) and MAX_GROUPS groups, so the worst case on one
// description is a small polynomial, never 2^n ('a?'.repeat(35) and
// '(a|aa)'.repeat(30) are refused). Descriptions are also cut at
// MAX_DESCRIPTION before a test.
const MAX_STARS = 2;
const MAX_OPTIONAL = 3;
const MAX_GROUPS = 2; // (a|aa)(a|aa)… without any quantifier is exponential too
const MAX_DESCRIPTION = 300;
function fitsGrammar(p) {
  let depth = 0;
  let i = 0;
  let stars = 0;
  let optional = 0;
  let groups = 0;
  while (i < p.length) {
    GRAMMAR_TOKEN.lastIndex = i;
    const m = GRAMMAR_TOKEN.exec(p);
    if (!m) return false;
    const t = m[0];
    if (t === '(') { depth += 1; groups += 1; }
    else if (t[0] === ')') { depth -= 1; if (depth < 0) return false; }
    if (t === '|' && depth === 0) { stars = 0; optional = 0; groups = 0; }
    if (t.endsWith('*')) stars += 1;
    else if (t.endsWith('?') && t !== '\\?') optional += 1;
    if (stars > MAX_STARS || optional > MAX_OPTIONAL || groups > MAX_GROUPS) return false;
    i += t.length;
  }
  return depth === 0;
}
// maxLength caps what the owner types; a stored rule (seeds are long
// alternations of literals) is checked for safety only.
function compilePattern(pattern, { maxLength = MAX_PATTERN } = {}) {
  const p = String(pattern || '').trim();
  if (!p) throw httpError(400, 'pattern is required');
  if (p.length > maxLength) throw httpError(400, `pattern is longer than ${maxLength} characters`);
  if (!fitsGrammar(p)) throw httpError(400, `pattern uses a form that is not allowed (${GRAMMAR_HELP})`);
  try { return new RegExp(p, 'i'); } catch (e) { throw httpError(400, `pattern is not a valid regular expression: ${e.message}`); }
}

function compileRules(rules) {
  const out = [];
  for (const r of rules || []) {
    if (r.enabled === false) continue;
    try { out.push({ ...r, re: compilePattern(r.pattern, { maxLength: Infinity }) }); } catch (e) {
      logger.warn(`[tax-ledger] rule ${r.id} skipped, invalid pattern: ${e.message}`);
    }
  }
  const t = (v) => { const n = new Date(v || 0).getTime(); return Number.isFinite(n) ? n : 0; };
  out.sort((a, b) => (Number(a.priority) - Number(b.priority))
    || (t(a.created_at) - t(b.created_at))
    || String(a.pattern).localeCompare(String(b.pattern)));
  return out;
}

// An income rule (a customer receipt) only fits money in and an expense
// rule only fits money out (a credit from a business merchant is a refund
// to review, never an expense); the next rule that fits wins.
function matchRule(description, compiled, direction = null) {
  const d = String(description || '').slice(0, MAX_DESCRIPTION);
  for (const r of compiled) {
    if (direction && r.kind === 'income' && direction !== 'credit') continue;
    if (direction && r.kind === 'expense' && direction !== 'debit') continue;
    if (r.re.test(d)) return r;
  }
  return null;
}

function suggestionFor(rule) {
  const base = { rule: { id: rule.id, kind: rule.kind, note: rule.note || null, source: rule.source || 'seed', pattern: rule.pattern } };
  if (rule.kind === 'expense') {
    return { ...base, categoryId: rule.category_id || null, categoryName: rule.category_name || null, irsLine: rule.irs_line || null, categorySource: 'rule' };
  }
  // ignore is the Bank Import tab's existing "internal transfer?" flag (the
  // matcher writes it too), so only a transfer rule sets it.
  if (rule.kind === 'transfer') return { ...base, ignore: true, reason: `transfer per ledger rule${rule.note ? `: ${rule.note}` : ''}` };
  if (rule.kind === 'personal') return { ...base, personal: true, reason: `personal per ledger rule${rule.note ? `: ${rule.note}` : ''}` };
  if (rule.kind === 'income') return { ...base, income: true, reason: rule.note || INCOME_REASON };
  // the pre-filled category of a review rule is rule-owned too (the kill switch removes it)
  return { ...base, review: true, note: rule.note || null, categoryId: rule.category_id || null, categoryName: rule.category_name || null, irsLine: rule.irs_line || null, categorySource: rule.category_id ? 'rule' : undefined };
}

// Payee pattern from a bank description for an owner rule: drop the bank's
// framing words, then keep the payee's leading run of real words (up to
// three, adjacent in the description, no number or noise word between
// them), word-bounded. 'WAWA 5519 BRADENTON FL' → \bwawa\b, because the
// number ends the name; 'SITEONE LANDSCAPE SUPPLY 1234 BRADENTON' →
// \bsiteone\W*landscape\W*supply\b. The result always matches the
// description it came from.
const PREFIX_RE = /^(debit card purchase - |digital card purchase - |recurring payment - |pos purchase - |withdrawal from |deposit from |zelle money sent to |zelle money received from |payment to |purchase authorized on \d{2}\/\d{2} )/i;
const STOP = new Set(['the', 'and', 'inc', 'llc', 'com', 'www', 'card', 'purchase', 'payment', 'pmt', 'online', 'store']);
const TOKEN_RE = /[a-z][a-z&'.\-]*/g;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function patternFromDescription(description) {
  const s = String(description || '').toLowerCase().replace(PREFIX_RE, '');
  const kept = [];
  let lastEnd = -1;
  for (const m of s.matchAll(TOKEN_RE)) {
    const tok = m[0].replace(/^[.'&-]+|[.'&-]+$/g, '');
    const ok = tok.length >= 3 && !STOP.has(tok);
    if (!kept.length) {
      if (ok) { kept.push(tok); lastEnd = m.index + m[0].length; }
      continue;
    }
    if (!ok || /\d/.test(s.slice(lastEnd, m.index))) break;
    kept.push(tok);
    lastEnd = m.index + m[0].length;
    if (kept.length === 3) break;
  }
  if (!kept.length) return null;
  return `\\b${kept.map(escapeRe).join('\\W*')}\\b`;
}

// The seed rows live in code (tax-ledger-seed-rules.js) and are written
// here, once per process, idempotent by pattern: a pattern that exists is
// left alone, so an owner's edit to a seeded row (disable, re-point) and a
// new seed added in a later PR both survive without a migration.
let seedPromise = null;
async function ensureSeedRules(conn = db) {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const cats = await conn('expense_categories').select('id', 'name');
    const idByName = new Map(cats.map((c) => [c.name, c.id]));
    const rows = SEED_RULES.map((r) => ({
      pattern: r.pattern, kind: r.kind,
      category_id: r.category ? (idByName.get(r.category) || null) : null,
      irs_line: r.category ? (CATEGORY_LINES[r.category] || null) : null,
      note: r.note || null, priority: r.priority || 100, enabled: true, source: 'seed',
    }));
    // A pristine seed row (source seed, never edited: updated_at = created_at)
    // follows the code when the seed changes; a row the owner edited keeps
    // the owner's values; a seed the code no longer lists is disabled (not
    // deleted: its hits and a possible owner re-enable stay).
    const PRISTINE = "tax_ledger_rules.source = 'seed' and tax_ledger_rules.updated_at = tax_ledger_rules.created_at";
    if (rows.length) {
      await conn('tax_ledger_rules').insert(rows).onConflict('pattern')
        .merge(['kind', 'category_id', 'irs_line', 'note', 'priority', 'enabled'])
        .whereRaw(PRISTINE);
    }
    await conn('tax_ledger_rules').whereRaw(PRISTINE).where({ enabled: true })
      .whereNotIn('pattern', rows.map((r) => r.pattern))
      .update({ enabled: false, note: 'retired seed (no longer in the seed list)', updated_at: new Date() });
    return rows.length;
  })().catch((err) => { seedPromise = null; throw err; });
  return seedPromise;
}

async function loadRules(conn = db) {
  await ensureSeedRules(conn);
  return conn('tax_ledger_rules as r')
    .leftJoin('expense_categories as c', 'c.id', 'r.category_id')
    .where('r.enabled', true)
    .orderBy('r.priority', 'asc')
    .orderBy('r.created_at', 'asc')
    .select('r.*', 'c.name as category_name');
}

// Suggestion-only pass over open rows, in pages, oldest first.
// - Only rows the matcher has examined: a rule never pre-empts the search
//   for an expense or payout that already explains the row.
// - A row the owner decided (suggestion.decision: a row on the Income or
//   the Later shelf) is never read, and the UPDATE predicate repeats the
//   check so a decision made during the pass wins.
// - Every row a full pass examines gets a rulesAt stamp, matched or not, so
//   a pass never re-reads the same unmatched rows and newer rows always get
//   their turn. force re-examines stamped rows too (after a rule changed);
//   then a classification an earlier rule wrote (suggestion.rule) that no
//   rule matches any more is cleared.
// - pattern limits the pass to one rule's matches (an Always decision):
//   unrelated rows are neither written nor stamped.
// - A row the matcher already flagged as an internal transfer (ignore
//   without a rule) is left as it is by a seed; an owner rule outranks the
//   heuristic and writes its classification alongside the flag (the flag
//   stays: the matcher's rescan would only put it back).
// - after = {txn_date, id} continues a pass past its row budget: the result
//   carries more:true and the cursor to send back.
const NOT_DECIDED_SQL = "(suggestion -> 'decision') is null";
function ymd(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v || '').slice(0, 10);
}
function cursorOf(row) { return row ? { txn_date: ymd(row.txn_date), id: String(row.id) } : null; }
async function applyRules({ limit = PAGE, force = false, pattern = null, after: start = null } = {}) {
  const counts = { examined: 0, suggested: 0, cleared: 0, byKind: {}, more: false, cursor: null };
  const compiled = compileRules(await loadRules());
  // nothing to suggest: only a full forced pass still runs, to clear what
  // rules that are gone now had written
  if (!compiled.length && !(force && !pattern)) return counts;
  const maxRows = Math.min(Math.max(1, Number(limit) || PAGE), MAX_EXAMINE);
  const stamp = new Date().toISOString();
  const hits = new Map();
  let after = start && start.id && start.txn_date ? { txn_date: ymd(start.txn_date), id: String(start.id) } : null;
  let lastPageFull = false;
  while (counts.examined < maxRows) {
    const pageSize = Math.min(PAGE, maxRows - counts.examined);
    let q = db('bank_transactions')
      .where({ status: 'unmatched' })
      .whereRaw(bankImport.BANK_CHANGE_UNRESOLVED_SQL_NOT)
      .whereRaw(NOT_DECIDED_SQL)
      .whereRaw(MATCHER_EXAMINED_SQL)
      .orderBy('txn_date', 'asc').orderBy('id', 'asc')
      .limit(pageSize)
      .select('id', 'txn_date', 'description', 'direction', 'suggestion');
    if (!force) q = q.whereRaw("(suggestion -> 'rulesAt') is null");
    if (after) q = q.whereRaw('(txn_date, id) > (?::date, ?::uuid)', [after.txn_date, after.id]);
    const rows = await q;
    for (const row of rows) {
      counts.examined += 1;
      const sug = row.suggestion || {};
      if (sug.decision || !matcherExamined(row)) continue;
      const rule = matchRule(row.description, compiled, row.direction);
      // the matcher's own "internal transfer?" flag (ignore without a rule)
      // holds against a seed; a rule the owner wrote outranks the heuristic
      // (a vendor whose descriptor says AUTOPAY is the usual case)
      const matcherFlag = !!(sug.ignore && !sug.rule);
      const matcherTransfer = matcherFlag && !(rule && rule.source === 'owner');
      const writes = !!rule && !matcherTransfer && (!pattern || rule.pattern === pattern);
      if (pattern && !writes) continue;
      const stale = !writes && !pattern && force && !!sug.rule && !matcherTransfer;
      const patch = writes ? { ...suggestionFor(rule), rulesAt: stamp } : { rulesAt: stamp };
      // an owner rule writing over the matcher's flag keeps that flag (it is
      // the matcher's; its rescan would only put it back) and records the
      // examination evidence explicitly, because an ignore flag that now
      // sits next to a rule key no longer counts as the matcher's
      const removeKeys = (writes || stale) ? CLASSIFICATION_KEYS.filter((k) => !(writes && matcherFlag && (k === 'ignore' || k === 'reason'))) : [];
      if (writes && matcherFlag) patch.examined = true;
      await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).whereRaw(NOT_DECIDED_SQL).whereRaw(MATCHER_EXAMINED_SQL)
        .update({ suggestion: bankImport.suggestionMerge(patch, removeKeys), updated_at: new Date() });
      if (stale) counts.cleared += 1;
      if (!writes) continue;
      counts.suggested += 1;
      counts.byKind[rule.kind] = (counts.byKind[rule.kind] || 0) + 1;
      hits.set(rule.id, (hits.get(rule.id) || 0) + 1);
    }
    lastPageFull = rows.length >= pageSize;
    if (!lastPageFull) break;
    after = cursorOf(rows[rows.length - 1]);
  }
  for (const [id, n] of hits) {
    // hits are not an edit: updated_at stays, so a seed row stays pristine
    await db('tax_ledger_rules').where({ id }).update({ hits: db.raw('hits + ?', [n]), last_hit_at: new Date() });
  }
  if (lastPageFull && counts.examined >= maxRows) { counts.more = true; counts.cursor = after; }
  return counts;
}

// The payee pass after an Always decision: force, one pattern, and it
// follows its own cursor to the end of the open rows (bounded by rounds so
// a runaway backlog cannot pin a request). complete:false means the pass
// stopped short and the caller reports propagated:false.
async function applyRulesForPattern(pattern, { budget = MAX_EXAMINE, maxRounds = 10 } = {}) {
  let after = null;
  let rounds = 0;
  const totals = { examined: 0, suggested: 0 };
  do {
    const out = await applyRules({ limit: budget, force: true, pattern, after });
    totals.examined += out.examined;
    totals.suggested += out.suggested;
    after = out.more ? out.cursor : null;
    rounds += 1;
  } while (after && rounds < maxRounds);
  return { ...totals, complete: !after };
}

// The kill switch: with GATE_TAX_LEDGER off, nothing a RULE wrote drives
// Bank Import. Owner decisions (suggestion.decision) are the owner's and
// stay; the matcher's own keys stay. Used by the Bank Import transactions
// list and by create-expense's suggested-category read.
const RULE_OWNED_KEYS = ['rule', 'rulesAt', 'personal', 'income', 'review', 'note'];
function visibleSuggestion(suggestion) {
  if (!suggestion || typeof suggestion !== 'object' || !suggestion.rule || isOn()) return suggestion;
  const out = { ...suggestion };
  const decided = !!out.decision;
  for (const k of RULE_OWNED_KEYS) if (!(decided && (k === 'income' || k === 'personal'))) delete out[k];
  if (out.categorySource === 'rule') for (const k of ['categoryId', 'categoryName', 'irsLine', 'categorySource']) delete out[k];
  if (suggestion.rule.kind === 'transfer' && !decided) { delete out.ignore; delete out.reason; }
  else if (!decided) delete out.reason;
  return out;
}

// Hook for the CSV upload and the Plaid sync: a rule pass right after the
// matching pass, only when the gate is on, and never a reason the import fails.
async function applyAfterImport(where) {
  if (!isOn()) return null;
  try { return await applyRules({ limit: PAGE }); } catch (err) {
    logger.warn(`[tax-ledger] rule pass after ${where} failed: ${err.message}`);
    return null;
  }
}

async function listRules() {
  await ensureSeedRules();
  return db('tax_ledger_rules as r')
    .leftJoin('expense_categories as c', 'c.id', 'r.category_id')
    .orderBy('r.priority', 'asc').orderBy('r.hits', 'desc').orderBy('r.pattern', 'asc')
    .select('r.id', 'r.pattern', 'r.kind', 'r.category_id', 'c.name as category_name', 'r.irs_line', 'r.note', 'r.priority', 'r.enabled', 'r.source', 'r.hits', 'r.last_hit_at', 'r.created_at', 'r.updated_at');
}

async function resolveCategory(categoryId, conn = db) {
  if (!categoryId) return null;
  const cat = await conn('expense_categories').where({ id: categoryId }).first('id', 'name', 'irs_line');
  if (!cat) throw httpError(400, 'unknown categoryId');
  return cat;
}

async function createRule({ pattern, kind, categoryId = null, note = null, priority = OWNER_PRIORITY, source = 'owner', conn = db }) {
  compilePattern(pattern);
  if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')}`);
  const cat = await resolveCategory(categoryId, conn);
  if (kind === 'expense' && !cat) throw httpError(400, 'an expense rule needs a categoryId');
  const row = {
    pattern: String(pattern).trim(), kind, category_id: cat ? cat.id : null, irs_line: cat ? cat.irs_line : null,
    note: note ? String(note).slice(0, 500) : null, priority: Number.isFinite(Number(priority)) ? Number(priority) : OWNER_PRIORITY,
    enabled: true, source, updated_at: new Date(),
  };
  const [saved] = await conn('tax_ledger_rules').insert(row).onConflict('pattern')
    .merge({ kind: row.kind, category_id: row.category_id, irs_line: row.irs_line, note: row.note, priority: row.priority, enabled: true, source: row.source, updated_at: row.updated_at })
    .returning('*');
  return saved;
}

async function updateRule(id, patch = {}) {
  const row = {};
  if (patch.pattern !== undefined) { compilePattern(patch.pattern); row.pattern = String(patch.pattern).trim(); }
  if (patch.kind !== undefined) { if (!KINDS.includes(patch.kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')}`); row.kind = patch.kind; }
  if (patch.categoryId !== undefined) { const cat = await resolveCategory(patch.categoryId); row.category_id = cat ? cat.id : null; row.irs_line = cat ? cat.irs_line : null; }
  if (patch.note !== undefined) row.note = patch.note ? String(patch.note).slice(0, 500) : null;
  if (patch.priority !== undefined) { const p = Number(patch.priority); if (!Number.isFinite(p)) throw httpError(400, 'priority must be a number'); row.priority = p; }
  if (patch.enabled !== undefined) row.enabled = !!patch.enabled;
  if (!Object.keys(row).length) throw httpError(400, 'nothing to update');
  row.updated_at = new Date();
  const [saved] = await db('tax_ledger_rules').where({ id }).update(row).returning('*');
  if (!saved) throw httpError(404, 'rule not found');
  return saved;
}

// The Always rule for an expense is written by create-expense (fromLedger +
// always) once its claim succeeds, so a refused creation leaves no rule.
function ownerRuleFor(row, decision, categoryId) {
  const pattern = patternFromDescription(row.description);
  if (!pattern) return null;
  return { pattern, kind: decision, categoryId: decision === 'expense' ? categoryId : null, note: 'from the inbox', priority: OWNER_PRIORITY, source: 'owner' };
}

async function decide({ id, decision, categoryId = null, always = false }) {
  if (!DECISIONS.includes(decision)) throw httpError(400, `decision must be one of ${DECISIONS.join(', ')}`);
  const row = await db('bank_transactions').where({ id }).first('id', 'status', 'description', 'direction', 'suggestion');
  if (!row) throw httpError(404, 'row not found');
  if (row.status !== 'unmatched') throw httpError(409, 'only an open (unmatched) row can be decided');
  if (bankImport.hasUnresolvedBankChange(row)) throw httpError(409, 'the bank changed this transaction after it was reviewed — apply or dismiss the bank change first');
  const block = inboxBlock(row);
  if (block) throw httpError(409, block);
  if (decision === 'expense' && !categoryId) throw httpError(400, 'an expense needs a categoryId');
  if (decision === 'income' && row.direction !== 'credit') throw httpError(400, 'only money in can be income; this row is a payment out');
  if (decision === 'expense') return { success: true, action: 'create-expense', createExpense: true, ruleCreated: false };

  const now = new Date();
  let write;
  let action;
  if (decision === 'later') {
    // a shelf is a decision: the rule passes skip decided rows, so a later
    // income rule cannot put the row on both shelves
    action = 'later';
    write = { suggestion: bankImport.suggestionMerge({ later: true, decision, decidedAt: now.toISOString() }, ['income']), updated_at: now };
  } else if (decision === 'income') {
    // Stays an open row, on the Income shelf: nothing counts it as revenue
    // yet, and hiding it would understate sales. Dropping the matcher's
    // ignore flag must not drop the row's examination evidence with it.
    action = 'income';
    const sug = row.suggestion || {};
    const patch = { income: true, reason: INCOME_REASON, decision, decidedAt: now.toISOString() };
    if (sug.ignore && !MATCHER_KEYS.some((k) => sug[k] !== undefined && sug[k] !== null)) patch.examined = true;
    write = { suggestion: bankImport.suggestionMerge(patch, ['ignore', 'personal', 'review', 'note', 'later']), updated_at: now };
  } else {
    action = 'ignored';
    const patch = { reason: `${decision} per the owner`, decision, decidedAt: now.toISOString() };
    if (decision === 'transfer') patch.ignore = true; else patch.personal = true;
    write = { status: 'ignored', suggestion: bankImport.suggestionMerge(patch, ['categoryId', 'categoryName', 'irsLine', 'categorySource', 'ignore', 'personal', 'income', 'review', 'note', 'later']), updated_at: now };
  }
  const rule = always && decision !== 'later' ? ownerRuleFor(row, decision, categoryId) : null;
  // the decision and its rule commit together: a row that stopped being the
  // Inbox's to decide (candidates parked, bank change) refuses both
  await db.transaction(async (trx) => {
    const changed = await trx('bank_transactions').where({ id, status: 'unmatched' }).whereRaw(DECIDABLE_SQL).update(write);
    if (!changed) throw httpError(409, 'the row changed while you were deciding (a possible match or a bank change appeared); reload');
    if (rule) await createRule({ ...rule, conn: trx });
  });
  // the decision and the rule are committed: a failed payee pass is logged,
  // never reported as a failed decision (a retry would meet a 409)
  let propagated = true;
  if (rule) {
    try { propagated = (await applyRulesForPattern(rule.pattern)).complete; } catch (err) {
      propagated = false;
      logger.warn(`[tax-ledger] payee pass after a decision failed: ${err.message}`);
    }
  }
  return { success: true, action, ruleCreated: !!rule, propagated };
}

module.exports = {
  KINDS, DECISIONS, OWNER_PRIORITY, VIEW_SQL, CLASSIFICATION_KEYS, INCOME_REASON,
  NO_LIVE_CANDIDATES_SQL, MATCHER_EXAMINED_SQL, DECIDABLE_SQL, MAX_EXAMINE, hasLiveCandidates, matcherExamined, inboxBlock, ownerRuleFor, visibleSuggestion,
  isOn, compilePattern, compileRules, matchRule, suggestionFor, patternFromDescription,
  ensureSeedRules, applyRules, applyRulesForPattern, applyAfterImport, listRules, createRule, updateRule, decide,
};
