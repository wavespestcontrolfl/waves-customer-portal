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
const DECISIONS = ['expense', 'personal', 'transfer', 'income', 'later', 'recorded'];
const MAX_PATTERN = 240;
const OWNER_PRIORITY = 10;
const PAGE = 500;
const MAX_EXAMINE = 20000;
// Bounds on the rules × rows work one request can do: every enabled rule is
// tested against every row a pass reads, so both sides are capped. A pass
// stops at its time budget and hands back its cursor (the callers already
// resume: Apply rules now, the import hook, the Always propagation).
const MAX_ENABLED_RULES = 250;
const PASS_TIME_BUDGET_MS = 500;    // one applyRules call: one request's worth
const LOOP_TIME_BUDGET_MS = 2000;   // applyAfterImport / applyRulesForPattern, all rounds together
// One pass at a time in this process, PASS_QUEUE more wait their turn, the
// rest are refused: every pass selects the same rows and runs the same
// regexes, so a burst of Apply rules now requests would otherwise queue
// minutes of event-loop work for one landed write. A refused pass is a
// 429 to the Inbox; the import hooks and the Always propagation log it
// and leave the rows for the next pass.
const PASS_CONCURRENCY = 1;
const PASS_QUEUE = 4;
const passGate = { running: 0, waiting: [] };
function acquirePass() {
  if (passGate.running < PASS_CONCURRENCY) { passGate.running += 1; return Promise.resolve(); }
  if (passGate.waiting.length >= PASS_QUEUE) return Promise.reject(httpError(429, 'a rule pass is already running; try again in a moment'));
  return new Promise((resolve) => passGate.waiting.push(resolve));
}
function releasePass() {
  const next = passGate.waiting.shift();
  if (next) next(); // the slot passes to the next waiter: running stays the same
  else passGate.running -= 1;
}

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
// the Income shelf: an income rule's pre-fill or an Income decision
const ON_INCOME_SHELF_SQL = "coalesce(suggestion->>'income','') = 'true'";
function onIncomeShelf(sug) { return !!sug && String(sug.income) === 'true'; }
// An open row the owner shelved: Later and Income keep status 'unmatched'
// (nothing is booked yet), but the row has been reviewed. The Plaid sync
// treats it like a linked row: a bank correction or withdrawal parks on it
// for the owner (Bank Import's bank-change card) instead of replacing or
// deleting the row, and the decision with it.
const OPEN_DECISIONS = ['later', 'income'];
function hasOpenDecision(sug) { return !!sug && OPEN_DECISIONS.includes(sug.decision); }
const VIEW_SQL = {
  open: `coalesce(suggestion->>'later','') <> 'true' and not ${ON_INCOME_SHELF_SQL} and ${ELIGIBLE_SQL}`,
  later: `coalesce(suggestion->>'later','') = 'true' and ${ELIGIBLE_SQL}`,
  income: `${ON_INCOME_SHELF_SQL} and ${ELIGIBLE_SQL}`,
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
const GRAMMAR_HELP = 'allowed: words and spaces, |, (…) or (…)?, \\b, \\W* \\s* \\d*, . .* .?, an escaped literal such as \\., a [class], ? after one character, at most 2 wildcards, 3 optional parts and 2 groups per alternative, every alternative needs some text that must match, and two wildcards need such text between them; not allowed: + * {} on a word, class or group, backreferences, lookarounds, anchors';
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
// A token that must consume at least one character: not |, not a paren,
// not \b, not a part made optional or repeatable with ? or *. Every
// alternative, at every depth, needs one — "wawa|", "(wawa|)", ".*" or "x?"
// alone would match every description, and an owner rule outranks the seeds.
function consumes(t) {
  if (t === '|' || t === '(' || t[0] === ')' || /^\\[bB]$/.test(t)) return false;
  if (t === '\\?') return true;
  return !/[*?]$/.test(t);
}
// Two wildcards with nothing that must match between them (".*.*x",
// "\\W*\\s*x", "(.*a)?.*b") make every position try every split: cubic on a
// 300-character description. Each alternative, at each depth, needs
// consuming text between one wildcard and the next; a group that ends in a
// wildcard (or an optional group holding one) hands that state to its parent.
// The scan keeps, per depth: consuming tokens in the current alternative
// (solid), whether a wildcard is still "open" (nothing consuming since it),
// and whether the group holds a wildcard at all (starred).
class GrammarScan {
  constructor() {
    this.solid = [0]; this.open = [false]; this.starred = [false];
    this.stars = 0; this.optional = 0; this.groups = 0;
  }
  get d() { return this.solid.length - 1; }
  enter() { this.groups += 1; this.solid.push(0); this.open.push(false); this.starred.push(false); return true; }
  leave(optionalGroup) {
    const d = this.d;
    if (d < 1 || this.solid[d] === 0) return false;
    const endsOpen = this.open.pop();
    const held = this.starred.pop();
    this.solid.pop();
    if (!optionalGroup) { this.solid[d - 1] += 1; if (!endsOpen) this.open[d - 1] = false; }
    if (endsOpen || (optionalGroup && held)) { if (this.open[d - 1]) return false; this.open[d - 1] = true; }
    if (held) this.starred[d - 1] = true;
    return true;
  }
  alternative() {
    const d = this.d;
    if (this.solid[d] === 0) return false;
    this.solid[d] = 0; this.open[d] = false;
    if (d === 0) { this.stars = 0; this.optional = 0; this.groups = 0; }
    return true;
  }
  wildcard() {
    const d = this.d;
    if (this.open[d]) return false;
    this.open[d] = true; this.starred[d] = true; this.stars += 1;
    return true;
  }
  consume(t) {
    if (consumes(t)) { this.solid[this.d] += 1; this.open[this.d] = false; }
    if (t.endsWith('?') && t !== '\\?') this.optional += 1;
    return true;
  }
  token(t) {
    if (t === '(') return this.enter();
    if (t[0] === ')') return this.leave(t === ')?');
    if (t === '|') return this.alternative();
    if (t.endsWith('*')) return this.wildcard();
    return this.consume(t);
  }
  withinCaps() { return this.stars <= MAX_STARS && this.optional <= MAX_OPTIONAL && this.groups <= MAX_GROUPS; }
  complete() { return this.solid.length === 1 && this.solid[0] > 0; }
}
function fitsGrammar(p) {
  const scan = new GrammarScan();
  let i = 0;
  while (i < p.length) {
    GRAMMAR_TOKEN.lastIndex = i;
    const m = GRAMMAR_TOKEN.exec(p);
    if (!m) return false;
    if (!scan.token(m[0]) || !scan.withinCaps()) return false;
    i += m[0].length;
  }
  return scan.complete();
}
// maxLength caps what the owner types; a stored rule (seeds are long
// alternations of literals) is checked for safety only.
// Patterns match case-insensitively, so the stored text is case-folded
// (letters lowercased, escape letters such as \W and \b kept): "WAWA" and
// "wawa" are one rule under the unique constraint.
function canonicalPattern(pattern) {
  return String(pattern || '').trim().replace(/\\.|[A-Z]/g, (m) => (m.length === 2 ? m : m.toLowerCase()));
}
// A pattern the owner types is also PROVED fast before it is saved: a worker
// thread runs it against long adversarial descriptions (every character
// class the grammar admits, repeated to MAX_DESCRIPTION, with and without a
// late match) under a hard budget, and is terminated when it overruns. The
// grammar bounds the shape; this bounds the time, whatever the shape.
// The budget is regex time as the worker measures it (startup, scheduling
// and message delivery excluded: on a busy server they alone can pass 150
// ms). The hard cap is wall clock: a backtracking pattern that never
// reports is terminated there.
const PROBE_BUDGET_MS = 150;
const PROBE_HARD_CAP_MS = 2000;
function probeStrings(pattern) {
  const n = MAX_DESCRIPTION;
  const fills = [' ', 'a', '1', '-', 'a ', 'a1', ' -', '\t'];
  const literal = (pattern.match(/[a-z]{2,}/i) || ['x'])[0];
  const out = [];
  for (const f of fills) {
    const base = f.repeat(Math.ceil(n / f.length)).slice(0, n);
    out.push(base, base.slice(0, n - literal.length) + literal, literal + base.slice(literal.length));
  }
  return out;
}
// Each probe is a Worker (a few MiB of RSS): at most PROBE_CONCURRENCY run
// at once and PROBE_QUEUE more wait their turn, so a burst of rule writes
// cannot exhaust the shared process; the rest get a 429 and retry. The
// probe is the last check before a write: kind, category and the current
// rule are validated first, so a request that fails for another reason
// never takes a slot.
const PROBE_CONCURRENCY = 2;
const PROBE_QUEUE = 8;
const probeGate = { running: 0, waiting: [] };
function acquireProbe() {
  if (probeGate.running < PROBE_CONCURRENCY) { probeGate.running += 1; return Promise.resolve(); }
  if (probeGate.waiting.length >= PROBE_QUEUE) return Promise.reject(httpError(429, 'too many pattern checks at once; try again in a moment'));
  return new Promise((resolve) => probeGate.waiting.push(resolve));
}
function releaseProbe() {
  const next = probeGate.waiting.shift();
  if (next) next(); // the slot passes to the next waiter: running stays the same
  else probeGate.running -= 1;
}
async function probePattern(pattern, budgetMs, hardCapMs) {
  const { Worker } = require('worker_threads');
  const worker = new Worker(require.resolve('./tax-ledger-pattern-probe-worker'), { workerData: { pattern: String(pattern), strings: probeStrings(String(pattern)) } });
  const verdict = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ slow: true }), Math.max(hardCapMs, budgetMs));
    worker.once('message', (msg) => { clearTimeout(timer); resolve(msg); });
    worker.once('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
    worker.once('exit', () => { clearTimeout(timer); resolve({ exited: true }); });
  });
  await worker.terminate().catch(() => {});
  return verdict;
}
async function assertPatternFast(pattern, { budgetMs = PROBE_BUDGET_MS, hardCapMs = PROBE_HARD_CAP_MS } = {}) {
  await acquireProbe();
  let verdict;
  try { verdict = await probePattern(pattern, budgetMs, hardCapMs); } finally { releaseProbe(); }
  if (verdict.slow || (Number.isFinite(verdict.ms) && verdict.ms > budgetMs)) throw httpError(400, `pattern is too slow on a long description (it must finish within ${budgetMs} ms); simplify it`);
  if (verdict.error) throw httpError(400, `pattern is not a valid regular expression: ${verdict.error}`);
  return true;
}
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
  // Lowest priority first; at the same priority the LATEST DECISION wins:
  // every Always decision is an owner rule at the same priority, and the
  // latest one is the owner's current reading of an overlapping payee (an
  // older "acme → personal" must not defeat a new Always Business on "ACME
  // HARDWARE"; repeating Always on "acme" later must win again). The
  // decision time is updated_at (the upsert sets it; hits never do), with
  // created_at for a row that has none. Postgres returns both as Dates:
  // compared in time.
  const t = (v) => { const n = new Date(v || 0).getTime(); return Number.isFinite(n) ? n : 0; };
  const decidedAt = (r) => t(r.updated_at || r.created_at);
  out.sort((a, b) => (Number(a.priority) - Number(b.priority))
    || (decidedAt(b) - decidedAt(a))
    || String(a.pattern).localeCompare(String(b.pattern)));
  return out;
}

// An income rule (a customer receipt) only fits money in and an expense
// rule only fits money out (a credit from a business merchant is a refund
// to review, never an expense); the next rule that fits wins.
// Money in from a business merchant (an expense rule hit on a credit) is a
// refund to apply in Bank Import, or income: never an expense, and never a
// later, broader personal rule's. The business evidence wins, as a review
// item with the expense rule's identity (its hit is counted).
function creditOfMerchant(rule) {
  return { ...rule, kind: 'review', category_id: null, category_name: null, irs_line: null, note: `money in from a business merchant (${rule.note || rule.pattern}): a refund to apply in Bank Import, or income` };
}
// matched: the worker's answer for this description (indexes into
// compiled, see matchPage); without it the regexes run here (unit checks).
function matchRule(description, compiled, direction = null, matched = null) {
  const d = String(description || '').slice(0, MAX_DESCRIPTION);
  for (let i = 0; i < compiled.length; i += 1) {
    const r = compiled[i];
    if (direction && r.kind === 'income' && direction !== 'credit') continue;
    if (matched ? !matched.includes(i) : !r.re.test(d)) continue;
    if (direction === 'credit' && r.kind === 'expense') return creditOfMerchant(r);
    return r;
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
// Words that never name a payee: bank framing, processors' framing, legal
// suffixes. An owner rule anchors on the first word that is not one of
// these; with none left there is no rule (the caller says so).
const STOP = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'corp', 'com', 'www', 'net', 'org', 'card', 'checkcard', 'check', 'chk', 'purchase', 'payment', 'pmt', 'pymt',
  'online', 'store', 'ach', 'debit', 'credit', 'web', 'pos', 'visa', 'mastercard', 'authorized', 'recurring', 'autopay', 'mobile', 'digital', 'transfer', 'xfer',
  'withdrawal', 'deposit', 'zelle', 'money', 'sent', 'received', 'from', 'ppd', 'des', 'ref', 'trace', 'bill', 'pay', 'epay', 'electronic', 'eft', 'intl', 'fee', 'des',
  'tst', 'sq', 'paypal', 'pp', 'apl', 'amzn',
  // more statement framing ("DBT CRD 1234 WAWA", "CHKCARD", "PURCH AUTH"): never a payee
  'dbt', 'crd', 'crdt', 'dbit', 'chkcard', 'chkcrd', 'purch', 'auth', 'pin', 'sig', 'tran', 'trn', 'txn', 'pending', 'temp', 'hold', 'recur',
  // more statement framing ("VISA DDA PURCHASE", "POS PUR", "ATM WDL", "MISC SVC CHG"): never a payee
  'dda', 'pur', 'purc', 'atm', 'wdl', 'dep', 'tfr', 'trnsfr', 'chg', 'misc', 'svc']);
const TOKEN_RE = /[a-z][a-z&'.\-]*/g;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function patternFromDescription(description) {
  // built from, and checked against, the same prefix matching reads
  // (matchRule cuts every description at MAX_DESCRIPTION): a payee that
  // starts past it would make a rule that never matches its own row
  const source = String(description || '').slice(0, MAX_DESCRIPTION);
  const s = source.toLowerCase().replace(PREFIX_RE, '');
  const kept = [];
  let firstStart = -1;
  let lastEnd = -1;
  for (const m of s.matchAll(TOKEN_RE)) {
    const tok = m[0].replace(/^[.'&-]+|[.'&-]+$/g, '');
    const ok = tok.length >= 3 && !STOP.has(tok);
    if (!kept.length) {
      if (ok) { kept.push(tok); firstStart = m.index; lastEnd = m.index + m[0].length; }
      continue;
    }
    if (!ok || /\d/.test(s.slice(lastEnd, m.index))) break;
    kept.push(tok);
    lastEnd = m.index + m[0].length;
    if (kept.length === 3) break;
  }
  if (!kept.length) return null;
  // A digit glued to the payee ("GOOGLE *ADS1234567", "1PASSWORD") sits
  // inside the word boundary, so the rule tolerates a digit run on that
  // side (\d*: the digits vary per transaction). The pattern must fit the
  // grammar and match the description it came from; a 3-word payee that
  // would need a third wildcard drops to 2 words rather than fail later.
  const digitBefore = /\d$/.test(s.slice(0, firstStart));
  const digitAfter = /^\d/.test(s.slice(lastEnd));
  for (let n = kept.length; n >= 1; n -= 1) {
    const words = kept.slice(0, n).map(escapeRe).join('\\W*');
    const trailing = n === kept.length && digitAfter ? '\\d*' : '';
    const pattern = `\\b${digitBefore ? '\\d*' : ''}${words}${trailing}\\b`;
    if (fitsGrammar(pattern) && new RegExp(pattern, 'i').test(source)) return pattern;
  }
  return null;
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
    // retiring is the code's doing, not the owner's: updated_at stays equal
    // to created_at, so a seed the code lists again later is re-enabled by
    // the merge above instead of staying off as an "owner edit"
    await conn('tax_ledger_rules').whereRaw(PRISTINE).where({ enabled: true })
      .whereNotIn('pattern', rows.map((r) => r.pattern))
      .update({ enabled: false, note: 'retired seed (no longer in the seed list)' });
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
//   heuristic: it replaces the flag and keeps the examination evidence under
//   'examined', which the matcher's rescan honors (it never puts the flag
//   back on an examined row).
// - after = {txn_date, id} continues a pass past its row budget: the result
//   carries more:true and the cursor to send back.
const NOT_DECIDED_SQL = "(suggestion -> 'decision') is null";
// What the Inbox's Business claim requires: no decision, or Later (the
// shelf Business is offered from: the claim replaces that decision)
const NOT_DECIDED_OR_LATER_SQL = "coalesce(suggestion ->> 'decision', '') in ('', 'later')";
// the keys a Later decision writes (what a claim that replaces it drops)
const LATER_KEYS = ['later', 'decision', 'decidedAt'];
// "the matcher has not flagged this row as a transfer since it was read":
// a seed-rule write is conditional on it, so a flag the matcher adds between
// the SELECT and the UPDATE still wins over the seed.
const NO_MATCHER_FLAG_SQL = `not (jsonb_exists(${SUG}, 'ignore') and not jsonb_exists(${SUG}, 'rule'))`;
// "the row's classification is still the one this pass read": every rule
// write stamps rulesAt with its pass's start time, so a newer pass (an
// Always decision's propagation, even one that re-pointed the SAME rule id
// through the upsert) that landed between the SELECT and this UPDATE wins
// over the older pass's result.
const RULE_SNAPSHOT_SQL = `coalesce(${SUG} ->> 'rulesAt', '') = ?`;
function ymd(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v || '').slice(0, 10);
}
function cursorOf(row) { return row ? { txn_date: ymd(row.txn_date), id: String(row.id) } : null; }

// The cap on enabled rules: a table that keeps growing makes every pass
// slower for every row. The pattern being written does not count against
// itself (an upsert or a re-enable of that slot).
async function assertRuleRoom(pattern, conn = db) {
  const canonical = canonicalPattern(pattern);
  const [{ n }] = await conn('tax_ledger_rules').where({ enabled: true }).whereNot({ pattern: canonical }).count({ n: '*' });
  if (Number(n) >= MAX_ENABLED_RULES) throw httpError(400, `the rule table holds ${MAX_ENABLED_RULES} enabled rules: disable or delete rules before adding one`);
}
// The cap's count and the write it guards run under one advisory lock, so
// two concurrent writes (two Always actions on different rows) cannot both
// read 249 and commit 251. A caller already in a transaction locks that
// transaction; otherwise one is opened for the count and the write.
const RULE_TABLE_LOCK = 72310231;
async function withRuleTableLock(conn, fn) {
  if (conn.isTransaction) {
    await conn.raw('select pg_advisory_xact_lock(?)', [RULE_TABLE_LOCK]);
    return fn(conn);
  }
  return conn.transaction(async (trx) => {
    await trx.raw('select pg_advisory_xact_lock(?)', [RULE_TABLE_LOCK]);
    return fn(trx);
  });
}
const hasKey = (sug, k) => sug[k] !== undefined && sug[k] !== null;

// Rule matching runs off the event loop. The grammar bounds a pattern's
// shape and the probe bounds its time on adversarial strings, but neither
// is proof for every real description (two overlapping alternations and a
// wildcard can still take seconds on one long line). So a pass sends each
// page of descriptions to a worker thread holding the compiled patterns and
// waits at most MATCH_HARD_CAP_MS for the answer. Over the cap the worker is
// terminated and the page is matched again in halves of the rule set, down
// to the one rule that overruns on its own: that rule matches nothing, is
// disabled with a note (an edit, so the seed refresh leaves it off) and the
// pass goes on without it. The request loop never runs an owner's regex.
const MATCH_HARD_CAP_MS = 2000;
function askMatchWorker(patterns, subjects, capMs) {
  const { Worker } = require('worker_threads');
  const worker = new Worker(require.resolve('./tax-ledger-match-worker'), { workerData: { patterns } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ slow: true }), capMs);
    worker.once('message', (msg) => { clearTimeout(timer); resolve(msg); });
    worker.once('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
    worker.once('exit', () => { clearTimeout(timer); resolve({ error: 'the matching worker exited without an answer' }); });
    worker.postMessage({ subjects });
  }).finally(() => worker.terminate().catch(() => {}));
}
// hits[i] = indexes into `rules` that match subjects[i]. One absolute
// deadline covers the whole page, the halving included: N slow rules would
// otherwise cost 2N-1 capped workers in a row (minutes) long after the pass
// budget. A rule that overruns a FULL cap on its own goes to `slow` and
// matches nothing; rules the deadline left unjudged (a shortened budget says
// nothing about them) go to `skipped`.
async function matchSplit(rules, subjects, capMs, deadline, slow, skipped) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) { skipped.push(...rules); return subjects.map(() => []); }
  const budget = Math.min(capMs, remaining);
  const out = await askMatchWorker(rules.map((r) => r.pattern), subjects, budget);
  if (out.hits) return out.hits;
  if (out.error) throw new Error(`rule matching failed: ${out.error}`);
  if (rules.length === 1) { (budget >= capMs ? slow : skipped).push(rules[0]); return subjects.map(() => []); }
  const half = Math.ceil(rules.length / 2);
  const left = await matchSplit(rules.slice(0, half), subjects, capMs, deadline, slow, skipped);
  const right = await matchSplit(rules.slice(half), subjects, capMs, deadline, slow, skipped);
  return left.map((l, i) => [...l, ...right[i].map((j) => j + half)]);
}
async function disableSlowRule(rule) {
  // the id only: an owner pattern is payee text from a bank description (a name, possibly)
  logger.warn(`[tax-ledger] rule ${rule.id} disabled: over ${MATCH_HARD_CAP_MS} ms on a page of descriptions`);
  await db('tax_ledger_rules').where({ id: rule.id, enabled: true }).update({
    enabled: false, note: `disabled: too slow on real descriptions${rule.note ? ` (${rule.note})` : ''}`, updated_at: new Date(),
  });
}
// The page deadline: the first attempt plus one capped attempt per halving
// level, enough to isolate one slow rule (about 20 s at the checked-in caps
// for 250 rules), never the 2N-1 attempts N slow rules would take. When it
// is spent the page is not judged (null): nothing is stamped on a partial
// answer, the pass stops with the page's own cursor, and the next pass
// retries it with the slow rules found so far disabled.
function pageDeadline(capMs, n) {
  return Date.now() + capMs * (2 + Math.ceil(Math.log2(Math.max(2, n))));
}
async function matchPage(compiled, subjects, { capMs = MATCH_HARD_CAP_MS, deadline = pageDeadline(capMs, compiled.length) } = {}) {
  if (!compiled.length || !subjects.length) return subjects.map(() => []);
  const slow = [];
  const skipped = [];
  const hits = await matchSplit(compiled, subjects.map((s) => String(s || '').slice(0, MAX_DESCRIPTION)), capMs, deadline, slow, skipped);
  for (const r of slow) await disableSlowRule(r);
  if (skipped.length) {
    logger.warn(`[tax-ledger] rule matching ran out of time on a page: ${skipped.length} rule(s) not judged (${slow.length} disabled); the page is retried on the next pass`);
    return null;
  }
  return hits;
}
const RETRY_PAGE = Symbol('retry-page');

// One page of open, matcher-examined, undecided rows, oldest first.
function rulePassPage({ pageSize, force, after }) {
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
  return q;
}

// What one row gets from the pass: nothing (skip), a stamp, a stamp that
// also clears what an earlier rule wrote (stale), or a rule's suggestion
// (writes). The matcher's own transfer flag (ignore without a rule) holds
// against a seed; an owner rule outranks it, replaces it, and records the
// examination evidence itself (examined) because the flag was that evidence.
function ruleVerdict(sug, rule, pattern, force) {
  const matcherFlag = hasKey(sug, 'ignore') && !hasKey(sug, 'rule');
  const ownerRule = !!rule && rule.source === 'owner';
  const fits = !!rule && (!matcherFlag || ownerRule) && (!pattern || rule.pattern === pattern);
  // An owner rule that overrode the matcher's transfer flag left 'examined'
  // as the row's only examination evidence. When that rule is gone and a
  // SEED would take the row, the seed does not write: the row is cleared
  // back to the matcher's reading (no rule, no marker; its next rescan
  // flags it again, and a matcher flag holds against seeds). Writing the
  // seed would leave a rule with no evidence under it, and a row the Inbox
  // never shows again.
  const ownerHeld = hasKey(sug, 'rule') && sug.rule.source === 'owner';
  const fellToSeed = fits && ownerHeld && !ownerRule && !!sug.examined;
  const writes = fits && !fellToSeed;
  const stale = fellToSeed || (!writes && !pattern && !!force && hasKey(sug, 'rule') && !matcherFlag);
  return { matcherFlag, writes, stale };
}
function classifyRow(row, compiled, { pattern, force, stamp, matched = null }) {
  const sug = row.suggestion || {};
  if (sug.decision || !matcherExamined(row)) return { skip: true };
  const rule = matchRule(row.description, compiled, row.direction, matched);
  // A payee pass also re-evaluates, in full, a row that carries the rule
  // being propagated: an Always decision can replace that rule's kind or
  // category under the same pattern (expense to income, say), so a sibling
  // the new rule no longer fits gets the next rule that does, or its stale
  // classification cleared, now, not on the next forced pass.
  const carries = !!pattern && hasKey(sug, 'rule') && sug.rule.pattern === pattern;
  const { matcherFlag, writes, stale } = ruleVerdict(sug, rule, carries ? null : pattern, carries || force);
  if (pattern && !writes && !stale) return { skip: true };
  const patch = writes ? { ...suggestionFor(rule), rulesAt: stamp } : { rulesAt: stamp };
  if (writes && matcherFlag) patch.examined = true;
  // a stale clear drops the override marker with the classification
  const removeKeys = stale ? [...CLASSIFICATION_KEYS, 'examined'] : (writes ? CLASSIFICATION_KEYS : []);
  const versionRead = sug.rulesAt ? String(sug.rulesAt) : '';
  return { skip: false, writes, stale, rule, patch, removeKeys, guardMatcherFlag: !matcherFlag, versionRead };
}

// Writes one row's outcome and books it in the counts and the hit map —
// only when the guarded UPDATE landed: a row that changed after the page was
// read (a decision, a matcher flag, a link) updates nothing and counts
// nothing, so the pass result and the rule hits report what is stored.
async function applyClassification(row, c, counts, hits) {
  let w = db('bank_transactions').where({ id: row.id, status: 'unmatched' }).whereRaw(NOT_DECIDED_SQL).whereRaw(MATCHER_EXAMINED_SQL)
    .whereRaw(RULE_SNAPSHOT_SQL, [c.versionRead]);
  if (c.guardMatcherFlag) w = w.whereRaw(NO_MATCHER_FLAG_SQL);
  const landed = await w.update({ suggestion: bankImport.suggestionMerge(c.patch, c.removeKeys), updated_at: new Date() });
  if (!landed) return;
  if (c.stale) counts.cleared += 1;
  if (!c.writes) return;
  counts.suggested += 1;
  counts.byKind[c.rule.kind] = (counts.byKind[c.rule.kind] || 0) + 1;
  hits.set(c.rule.id, (hits.get(c.rule.id) || 0) + 1);
}

async function recordHits(hits) {
  for (const [id, n] of hits) {
    // hits are not an edit: updated_at stays, so a seed row stays pristine
    await db('tax_ledger_rules').where({ id }).update({ hits: db.raw('hits + ?', [n]), last_hit_at: new Date() });
  }
}

// Suggestion-only pass over open rows, in pages, oldest first. Every row a
// full pass examines gets a rulesAt stamp, matched or not, so a pass never
// re-reads the same unmatched rows and newer rows always get their turn.
// force re-examines stamped rows too (after a rule changed); pattern limits
// the pass to one rule's matches (an Always decision); after = {txn_date,
// id} continues past a row budget (the result carries more + cursor).
// nothing to suggest: only a full forced pass still runs, to clear what
// rules that are gone now had written
function passHasWork(compiled, force, pattern) {
  return compiled.length > 0 || (force && !pattern);
}
function rowBudget(limit) {
  return Math.min(Math.max(1, Number(limit) || PAGE), MAX_EXAMINE);
}
function startCursor(start) {
  return start && start.id && start.txn_date ? { txn_date: ymd(start.txn_date), id: String(start.id) } : null;
}
async function applyRules(options = {}) {
  await acquirePass();
  try { return await runPass(options); } finally { releasePass(); }
}
async function runPass({ limit = PAGE, force = false, pattern = null, after: start = null, now = Date.now, deadline = null, matchCapMs = MATCH_HARD_CAP_MS } = {}) {
  const stopAt = deadline || now() + PASS_TIME_BUDGET_MS;
  const counts = { examined: 0, suggested: 0, cleared: 0, byKind: {}, more: false, cursor: null };
  let compiled = compileRules(await loadRules());
  if (!passHasWork(compiled, force, pattern)) return counts;
  const maxRows = rowBudget(limit);
  const stamp = new Date().toISOString();
  const hits = new Map();
  let after = startCursor(start);
  let lastPageFull = false;
  let outOfTime = false;
  while (counts.examined < maxRows && !outOfTime) {
    const pageSize = Math.min(PAGE, maxRows - counts.examined);
    const rows = await rulePassPage({ pageSize, force, after });
    // the active rule set is read AFTER the page's rows: an Always
    // propagation that finished before this read is in both (its rule and
    // its rulesAt stamps), one that finishes after it changes rulesAt and
    // the versioned UPDATE below refuses the older result
    compiled = compileRules(await loadRules());
    lastPageFull = rows.length >= pageSize;
    const stoppedAt = await examinePage(rows, { compiled, pattern, force, stamp, counts, hits, now, stopAt, lastPageFull, matchCapMs });
    // the page's matching ran out of time: stop here and report THIS page's start as the cursor
    if (stoppedAt === RETRY_PAGE) { outOfTime = true; break; }
    if (stoppedAt) { outOfTime = true; after = stoppedAt; break; }
    if (!lastPageFull) break;
    after = cursorOf(rows[rows.length - 1]);
  }
  await recordHits(hits);
  if (outOfTime || (lastPageFull && counts.examined >= maxRows)) { counts.more = true; counts.cursor = after; }
  return counts;
}

// One page of a pass: classify each row and write what lands. Out of time
// with rows still to read, it stops and returns the cursor of the row it
// stopped on (null = the page was finished).
async function examinePage(rows, { compiled, pattern, force, stamp, counts, hits, now, stopAt, lastPageFull, matchCapMs }) {
  const matched = await matchPage(compiled, rows.map((r) => r.description), { capMs: Math.min(matchCapMs || MATCH_HARD_CAP_MS, MATCH_HARD_CAP_MS) });
  if (!matched) return RETRY_PAGE;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    counts.examined += 1;
    const c = classifyRow(row, compiled, { pattern, force, stamp, matched: matched[i] });
    if (!c.skip) await applyClassification(row, c, counts, hits);
    if (now() >= stopAt && (i < rows.length - 1 || lastPageFull)) return cursorOf(row);
  }
  return null;
}

// The payee pass after an Always decision: force, one pattern, and it
// follows its own cursor to the end of the open rows (bounded by rounds so
// a runaway backlog cannot pin a request). complete:false means the pass
// stopped short and the caller reports propagated:false.
async function applyRulesForPattern(pattern, { budget = MAX_EXAMINE, maxRounds = 10, now = Date.now } = {}) {
  const deadline = now() + LOOP_TIME_BUDGET_MS;
  let after = null;
  let rounds = 0;
  const totals = { examined: 0, suggested: 0 };
  let more = false;
  do {
    const out = await applyRules({ limit: budget, force: true, pattern, after, now, deadline });
    totals.examined += out.examined;
    totals.suggested += out.suggested;
    // more with no cursor = the page at the start is retried (its matching ran out of time)
    more = !!out.more;
    after = out.cursor || null;
    rounds += 1;
  } while (more && rounds < maxRounds && now() < deadline);
  return { ...totals, complete: !more };
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
  // a transfer rule's flag and reason are the rule's: hidden unless the
  // owner's own decision is Transfer. A Later decision defers the row and
  // affirms nothing (the flag would otherwise read as the matcher's own,
  // and a rescan never touches a decided row)
  if (suggestion.rule.kind === 'transfer' && (!decided || out.decision === 'later')) { delete out.ignore; delete out.reason; }
  else if (!decided) delete out.reason;
  return out;
}

// Hook for the CSV upload and the Plaid sync: a rule pass right after the
// matching pass, only when the gate is on, and never a reason the import fails.
// The pass after a matching run follows its own cursor, so every row that
// run examined gets its rule pre-fill now, not at the next sync: unstamped
// rows only, oldest first, up to budget rows (the caller's matching budget;
// a manual pass examines up to 2,000 rows, the page is 500).
async function applyAfterImport(where, { budget = 2000, now = Date.now } = {}) {
  if (!isOn()) return null;
  try {
    // bounded in rows AND time: what is left gets its pre-fill on the next
    // pass (the next sync, or Apply rules now), never a request that runs on
    const deadline = now() + LOOP_TIME_BUDGET_MS;
    const totals = { examined: 0, suggested: 0, cleared: 0 };
    let after = null;
    let more = false;
    do {
      const out = await applyRules({ limit: Math.min(PAGE, budget - totals.examined), after, now, deadline });
      totals.examined += out.examined;
      totals.suggested += out.suggested;
      totals.cleared += out.cleared;
      more = !!out.more;
      after = out.cursor || null; // no cursor with more: the same page again (its matching ran out of time)
    } while (more && totals.examined < budget && now() < deadline);
    return totals;
  } catch (err) {
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
  await assertRuleRoom(pattern, conn); // the cheap refusal first (repeated under the lock below)
  await assertPatternFast(pattern); // the probe takes a worker slot: after the cheap checks, never under the lock
  const row = {
    pattern: canonicalPattern(pattern), kind, category_id: cat ? cat.id : null, irs_line: cat ? cat.irs_line : null,
    note: note ? String(note).slice(0, 500) : null, priority: Number.isFinite(Number(priority)) ? Number(priority) : OWNER_PRIORITY,
    enabled: true, source, updated_at: new Date(),
  };
  return withRuleTableLock(conn, async (trx) => {
    await assertRuleRoom(pattern, trx);
    const [saved] = await trx('tax_ledger_rules').insert(row).onConflict('pattern')
      .merge({ kind: row.kind, category_id: row.category_id, irs_line: row.irs_line, note: row.note, priority: row.priority, enabled: true, source: row.source, updated_at: row.updated_at })
      .returning('*');
    return saved;
  });
}

async function ruleUpdatePatch(patch) {
  const row = {};
  if (patch.pattern !== undefined) { compilePattern(patch.pattern); row.pattern = canonicalPattern(patch.pattern); }
  if (patch.kind !== undefined) { if (!KINDS.includes(patch.kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')}`); row.kind = patch.kind; }
  if (patch.categoryId !== undefined) { const cat = await resolveCategory(patch.categoryId); row.category_id = cat ? cat.id : null; row.irs_line = cat ? cat.irs_line : null; }
  if (patch.note !== undefined) row.note = patch.note ? String(patch.note).slice(0, 500) : null;
  if (patch.priority !== undefined) { const p = Number(patch.priority); if (!Number.isFinite(p)) throw httpError(400, 'priority must be a number'); row.priority = p; }
  if (patch.enabled !== undefined) row.enabled = !!patch.enabled;
  return row;
}

async function updateRule(id, patch = {}) {
  const row = await ruleUpdatePatch(patch);
  if (!Object.keys(row).length) throw httpError(400, 'nothing to update');
  // the rule as it would be after the change keeps createRule's invariant
  const needsCurrent = row.kind !== undefined || row.category_id !== undefined || row.enabled === true;
  const current = needsCurrent ? await db('tax_ledger_rules').where({ id }).first('id', 'kind', 'category_id', 'enabled', 'pattern') : null;
  if (needsCurrent && !current) throw httpError(404, 'rule not found');
  if (row.kind !== undefined || row.category_id !== undefined) {
    const next = { kind: row.kind !== undefined ? row.kind : current.kind, category_id: row.category_id !== undefined ? row.category_id : current.category_id };
    if (next.kind === 'expense' && !next.category_id) throw httpError(400, 'an expense rule needs a categoryId');
  }
  if (patch.pattern !== undefined) await assertPatternFast(patch.pattern); // the probe takes a worker slot: after the cheap checks, never under the lock
  row.updated_at = new Date();
  const write = async (trx) => {
    const [saved] = await trx('tax_ledger_rules').where({ id }).update(row).returning('*');
    if (!saved) throw httpError(404, 'rule not found');
    return saved;
  };
  // re-enabling takes a slot under the cap: counted and written under the
  // lock; disabling never does
  if (row.enabled === true && !current.enabled) return withRuleTableLock(db, async (trx) => { await assertRuleRoom(current.pattern, trx); return write(trx); });
  return write(db);
}

// The Always rule for an expense is written by create-expense (fromLedger +
// always) once its claim succeeds, so a refused creation leaves no rule.
function ownerRuleFor(row, decision, categoryId) {
  const pattern = patternFromDescription(row.description);
  if (!pattern) return null;
  return { pattern, kind: decision, categoryId: decision === 'expense' ? categoryId : null, note: 'from the inbox', priority: OWNER_PRIORITY, source: 'owner' };
}

// The write for a decision that is not an expense: later and income shelve
// the row (still open); personal and transfer park it as ignored.
function decisionWrite(decision, row, now) {
  if (decision === 'later') {
    return { action: 'later', write: { suggestion: bankImport.suggestionMerge({ later: true, decision, decidedAt: now.toISOString() }, ['income']), updated_at: now } };
  }
  if (decision === 'income') {
    // Stays an open row, on the Income shelf: nothing counts it as revenue
    // yet, and hiding it would understate sales. Dropping the matcher's
    // ignore flag must not drop the row's examination evidence with it.
    const sug = row.suggestion || {};
    const patch = { income: true, reason: INCOME_REASON, decision, decidedAt: now.toISOString() };
    // 'examined' is also the marker the matcher honors: a rescan never puts
    // its transfer flag back on a row whose flag a decision replaced
    if (sug.ignore) patch.examined = true;
    return { action: 'income', write: { suggestion: bankImport.suggestionMerge(patch, ['ignore', 'personal', 'review', 'note', 'later']), updated_at: now } };
  }
  if (decision === 'recorded') {
    // the receipt has been recorded as a sale (invoice + payment): the row
    // leaves the Income shelf as settled; Undo in Bank Import reopens it.
    // The UPDATE repeats the shelf check: a rule change that took the row
    // off the shelf since the read refuses it
    const patch = { income: true, reason: 'income recorded as a sale per the owner', decision, decidedAt: now.toISOString() };
    return { action: 'ignored', guard: ON_INCOME_SHELF_SQL, write: { status: 'ignored', suggestion: bankImport.suggestionMerge(patch, ['ignore', 'personal', 'review', 'note', 'later']), updated_at: now } };
  }
  const patch = { reason: `${decision} per the owner`, decision, decidedAt: now.toISOString() };
  if (decision === 'transfer') patch.ignore = true; else patch.personal = true;
  return { action: 'ignored', write: { status: 'ignored', suggestion: bankImport.suggestionMerge(patch, ['categoryId', 'categoryName', 'irsLine', 'categorySource', 'ignore', 'personal', 'income', 'review', 'note', 'later']), updated_at: now } };
}

async function loadDecidableRow(id) {
  const row = await db('bank_transactions').where({ id }).first('id', 'status', 'description', 'direction', 'suggestion');
  if (!row) throw httpError(404, 'row not found');
  if (row.status !== 'unmatched') throw httpError(409, 'only an open (unmatched) row can be decided');
  if (bankImport.hasUnresolvedBankChange(row)) throw httpError(409, 'the bank changed this transaction after it was reviewed — apply or dismiss the bank change first');
  const block = inboxBlock(row);
  if (block) throw httpError(409, block);
  return row;
}

const NO_RULE_MESSAGE = 'no payee word in this description to make a rule from; decide it without Always';

async function decide({ id, decision, categoryId = null, always = false }) {
  if (!DECISIONS.includes(decision)) throw httpError(400, `decision must be one of ${DECISIONS.join(', ')}`);
  const row = await loadDecidableRow(id);
  if (decision === 'expense' && !categoryId) throw httpError(400, 'an expense needs a categoryId');
  if (decision === 'income' && row.direction !== 'credit') throw httpError(400, 'only money in can be income; this row is a payment out');
  // the Income shelf holds rows an income rule pre-filled (income without
  // a decision) as well as decided ones: both offer Recorded
  if (decision === 'recorded' && !onIncomeShelf(row.suggestion)) throw httpError(400, 'only a row on the Income shelf can be marked recorded');
  // an Always the pattern builder cannot honour is refused up front: the
  // owner must not believe the payee is handled from now on
  // later and recorded are about this row only: Always writes no rule for them
  const rulable = decision !== 'later' && decision !== 'recorded';
  const rule = always && rulable ? ownerRuleFor(row, decision, categoryId) : null;
  if (always && rulable && !rule) throw httpError(400, NO_RULE_MESSAGE);
  if (decision === 'expense') return { success: true, action: 'create-expense', createExpense: true, ruleCreated: false };

  const now = new Date();
  const { action, write, guard } = decisionWrite(decision, row, now);
  // the decision and its rule commit together: a row that stopped being the
  // Inbox's to decide (candidates parked, bank change) refuses both
  await db.transaction(async (trx) => {
    let q = trx('bank_transactions').where({ id, status: 'unmatched' }).whereRaw(DECIDABLE_SQL);
    if (guard) q = q.whereRaw(guard);
    const changed = await q.update(write);
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
  KINDS, DECISIONS, OWNER_PRIORITY, VIEW_SQL, CLASSIFICATION_KEYS, INCOME_REASON, MAX_ENABLED_RULES, PASS_TIME_BUDGET_MS, LOOP_TIME_BUDGET_MS, PASS_CONCURRENCY, PASS_QUEUE, MATCH_HARD_CAP_MS, matchPage,
  NO_LIVE_CANDIDATES_SQL, MATCHER_EXAMINED_SQL, DECIDABLE_SQL, NO_MATCHER_FLAG_SQL, RULE_SNAPSHOT_SQL, NOT_DECIDED_SQL, NOT_DECIDED_OR_LATER_SQL, LATER_KEYS, ON_INCOME_SHELF_SQL, hasOpenDecision, assertPatternFast, probeStrings, PROBE_CONCURRENCY, PROBE_QUEUE, NO_RULE_MESSAGE, MAX_EXAMINE, hasLiveCandidates, matcherExamined, inboxBlock, ownerRuleFor, canonicalPattern, visibleSuggestion,
  isOn, compilePattern, compileRules, matchRule, suggestionFor, patternFromDescription,
  ensureSeedRules, applyRules, applyRulesForPattern, applyAfterImport, listRules, createRule, updateRule, decide,
};
