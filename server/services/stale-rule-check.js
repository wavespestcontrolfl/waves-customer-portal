'use strict';

// Weekly stale-rule check (owner request 2026-11-24): a safety rule in code can go out of date when the owner later
// rules the other way. Example: since 08-24 visit completion makes no invoice when the first-visit setup fee was never
// billed, and posts the bell "Completed first visit needs manual billing — setup fee was never invoiced". The owner's
// 09-30 ruling says bill it. That bell rang 5 times in 60 days and staff billed by hand each time. No sweep noticed.
//
// What it reads (read only): admin bell rows (notifications, recipient_type 'admin') from the last 60 days.
//   1. A HOLD bell is one that says the system held or skipped an action for a person to do. HOLD_MATCHERS is the one
//      list that decides it; extend that list, nothing else.
//   2. Left out: the digest feed (category ops_digest), system rows (category system: job and reminder failures, the
//      Monday review), payment-failed and job-failure titles (EXCLUDED_TITLES), an Activity-only row, and this check's
//      own bells (key prefix rule-check:).
//   3. Rows are grouped by a normalized title (normalizeTitle): text after a colon, digits, money and names are removed,
//      so "Completed first visit needs manual billing" for two customers is one group.
//   4. A group is flagged at 3 or more bells in the window with at least half HANDLED. A bell is handled when done_at is
//      set and `done_by` is not one of NON_RESOLUTION_CLOSERS, the generic fall-off closers that clear a bell without
//      anyone doing the work (quiet-72h, retention, episodes, supersede, promise-age-out). 'relevance' counts as handled: it
//      closes a bell once its subject moved on (an estimate reached the caller, an invoice now exists) and takes over a
//      person's close, so it is evidence the held work was done, not a fall-off. So a person, 'claude'
//      acting for one, or a subject closer (for example 'setup-fee-alert', which clears the first-visit billing bell once
//      staff bill by hand) counts: on a hold bell the system itself held the work, so a close that is not a fall-off means
//      a person did it. An open row and a row with done_by NULL do not count; a bare read_at cannot name who read it.
//
// What it writes: ONE admin bell per ISO week, only when a group is flagged (dedupeKey rule-check:<ISO week>); nothing
// when the week is clean. Sends nothing to a customer, calls no paid API, locks no visit or invoice row. No GATE_*
// (waves-ship section 6: an admin bell only).

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { cutAtWord, raiseAdminAlert } = require('./admin-alert-compose');
const { shortDateET } = require('./admin-alert-names');

const KEY_PREFIX = 'rule-check:';
const CATEGORY = 'system';
const SUBJECT_ID = 'stale-rule-check';
const AREA = 'System';
const WINDOW_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_GROUP = 3;
const ROW_LIMIT = 20000;
const GROUPS_SHOWN = 10;
const TITLE_CHARS = 80;

// The one list that says what a hold bell looks like. Matched against the bell's title and body.
const HOLD_MATCHERS = Object.freeze([
  /needs? manual/i,
  /manual (?:billing|quote|invoice|review|follow-?up|booking|charge)/i,
  /\bby hand\b/i,
  /\bheld\b/i,
  /\bskipped\b/i,
  /needs? (?:a )?review/i,
  /could not\b[^.]{0,80}\bso\b/i,
]);

// Bells that match the list but are not a held action: payment failures and job or reminder failures.
const EXCLUDED_TITLES = Object.freeze([
  /payment (?:failed|declined)/i,
  /card (?:declined|failed)/i,
  /\b(?:job|sweep|cron|reminder)s?\b[^.]{0,40}\bfail/i,
  // The nightly auto-dispatch summary: its "held" is a visit it chose not to move, not work held for a person.
  /^auto-dispatch: \d+ moves?\b/i,
]);
const EXCLUDED_CATEGORIES = Object.freeze(['ops_digest', 'system']);

// The generic closers that clear a bell with nobody doing the work. Any other done_by (a person id, 'claude', or a
// subject closer such as 'setup-fee-alert') means the held work was done.
// 'relevance' is not here: it closes a bell when its subject moved on and takes over a person's close.
const NON_RESOLUTION_CLOSERS = Object.freeze(['quiet-72h', 'retention', 'episodes', 'supersede', 'promise-age-out']);

const plural = (n, one, many) => (n === 1 ? one : many);

// The held work was done: closed, by someone other than a generic fall-off closer.
function isHandled(row) {
  return Boolean(row.done_at) && Boolean(row.done_by) && !NON_RESOLUTION_CLOSERS.includes(row.done_by);
}

// The words that make two bells "the same bell": lower case, text after a colon, money, digits and names removed.
// Only the first word may start with a capital; later capitalized words are names, except an all-capital word (SMS).
function normalizeTitle(title) {
  const tokens = String(title || '').split(':')[0].trim().split(/\s+/).filter(Boolean);
  const kept = [];
  tokens.forEach((token, i) => {
    const isName = i > 0 && /^\p{Lu}/u.test(token) && !/^\p{Lu}{2,}\W*$/u.test(token);
    if (!isName) kept.push(token);
    else if (kept[kept.length - 1] !== '*') kept.push('*');
  });
  return kept.join(' ').toLowerCase().replace(/\$?\d[\d,.]*/g, '#').replace(/\s+/g, ' ').trim();
}

function isHoldBell(row) {
  if (EXCLUDED_CATEGORIES.includes(row.category)) return false;
  if (String(row.dedupe_key || '').startsWith(KEY_PREFIX)) return false;
  const title = String(row.title || '');
  if (EXCLUDED_TITLES.some((re) => re.test(title))) return false;
  // The brevity guard moves a long body's full text into `detail`; match it too.
  const text = `${title} ${row.body || ''} ${row.detail || ''}`;
  return HOLD_MATCHERS.some((re) => re.test(text));
}

/**
 * Pure: bell rows -> flagged groups, most overridden first.
 * Group { key, title, count, handled, firstAt, lastAt }; `title` is the newest bell's own title.
 */
function flagGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!isHoldBell(row)) continue;
    const key = normalizeTitle(row.title);
    if (!key) continue;
    const at = new Date(row.created_at);
    if (Number.isNaN(at.getTime())) continue;
    const g = groups.get(key) || { key, title: row.title, count: 0, handled: 0, firstAt: at, lastAt: at };
    g.count += 1;
    if (isHandled(row)) g.handled += 1;
    if (at < g.firstAt) g.firstAt = at;
    if (at >= g.lastAt) { g.lastAt = at; g.title = row.title; }
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.count >= MIN_GROUP && g.handled * 2 >= g.count)
    .sort((a, b) => b.handled - a.handled || b.count - a.count || a.key.localeCompare(b.key));
}

// The last WINDOW_DAYS of admin bells, read only.
async function loadBells({ now = new Date(), database = db, limit = ROW_LIMIT } = {}) {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const rows = await database('notifications')
    .where({ recipient_type: 'admin' })
    .where('created_at', '>=', since)
    .whereNotIn('category', EXCLUDED_CATEGORIES)
    .whereRaw("COALESCE(metadata->>'feed', '') <> 'activity'")
    .orderBy('created_at', 'desc').limit(limit)
    .select('id', 'category', 'title', 'body', 'detail', 'created_at', 'done_at', 'done_by', database.raw("metadata->>'dedupeKey' AS dedupe_key"));
  if (rows.length >= limit) logger.warn(`[stale-rule-check] scan stopped at ${limit} rows; older bells in the window were not read`);
  return rows;
}

// ISO 8601 week of an Eastern calendar date: "2026-W48".
function isoWeekKey(now) {
  const [y, m, d] = etDateString(now).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// The composeAdminAlert spec and detail text for the flagged groups.
function composeRuleCheck(groups) {
  const n = groups.length;
  const handled = groups.reduce((sum, g) => sum + g.handled, 0);
  const shown = groups.slice(0, GROUPS_SHOWN);
  const lines = shown.map((g, i) => `${i + 1}. "${cutAtWord(g.title, TITLE_CHARS)}": ${g.count} ${plural(g.count, 'bell', 'bells')}, ${g.handled} handled, first ${shortDateET(g.firstAt)}, last ${shortDateET(g.lastAt)}.`);
  const more = n > shown.length ? [`${n - shown.length} more not listed.`] : [];
  const detail = [
    `${n} held ${plural(n, 'action', 'actions')} in the last ${WINDOW_DAYS} days that were done by hand again and again. The system held each one for a person.`,
    ...lines, ...more,
    "Check this rule against the owner's later rulings.",
  ].join('\n');
  return {
    spec: {
      area: AREA,
      action: `check the rule behind ${n} held ${plural(n, 'action', 'actions')}`,
      why: `${handled === 1 ? 'One held action was' : `${handled} held actions were`} done by hand in ${WINDOW_DAYS} days; the rule may be out of date.`,
      severity: 'needs-you',
      link: '/admin/dashboard',
      subject: { type: 'check', id: SUBJECT_ID },
      doneWhen: 'rule_checked',
      who: 'person',
    },
    detail,
  };
}

/**
 * Weekly cron entry point. -> { flagged, outcome }: raised | unchanged | suppressed | clean.
 * A read failure throws, so runExclusive records it in job_health. `loadRows` replaces the DB read (tests).
 */
async function runStaleRuleCheck({ now = new Date(), database = db, loadRows = loadBells } = {}) {
  const rows = await loadRows({ now, database });
  const groups = flagGroups(rows);
  if (!groups.length) return { flagged: 0, outcome: 'clean' };
  const { spec, detail } = composeRuleCheck(groups);
  const week = isoWeekKey(now);
  const result = await raiseAdminAlert(CATEGORY, spec, {
    dedupeKey: `${KEY_PREFIX}${week}`,
    // GATE_ADMIN_BELL_POLICY drops an admin row that does not ask to ring.
    bell: true,
    detail,
    metadata: { ruleCheck: true, week, groups: groups.slice(0, GROUPS_SHOWN).map((g) => ({ title: g.title, count: g.count, handled: g.handled })) },
  });
  if (!result) throw new Error('stale rule check bell was not written');
  let outcome = 'raised';
  if (result.suppressed) outcome = 'suppressed';
  else if (result.deduped) outcome = 'unchanged';
  logger.info(`[stale-rule-check] ${groups.length} group(s) flagged (${outcome})`);
  return { flagged: groups.length, outcome };
}

module.exports = {
  runStaleRuleCheck,
  HOLD_MATCHERS,
  NON_RESOLUTION_CLOSERS,
  EXCLUDED_TITLES,
  EXCLUDED_CATEGORIES,
  KEY_PREFIX,
  MIN_GROUP,
  WINDOW_DAYS,
  _private: { normalizeTitle, isHoldBell, flagGroups, loadBells, isoWeekKey, composeRuleCheck, isHandled },
};
