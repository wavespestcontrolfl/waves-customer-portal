/**
 * Pest Insider schedule + shadow planner.
 *
 * Issues go out on the 1st and 3rd Thursday of each month at 7:00 AM ET. The day before
 * (Wednesday 7:00 AM ET, with a 1:00 PM catch-up) runShadowIssue plans and builds the
 * issue with the real builder and records the result in pest_insider_issues. It sends
 * nothing: no email, no newsletter_sends row, no admin notification. The send path comes
 * in the next PR and reads these rows.
 *
 * Calendar dates here are 'YYYY-MM-DD' strings. The date math is the shared ET helpers in
 * utils/datetime-et.js (validCalendarDate, etNthWeekdayOfMonth, addETDays, etDateString);
 * this module keeps only the 1st-and-3rd-Thursday rule, which the table's CHECK also enforces.
 */
'use strict';

const { etDateString, addETDays, etNthWeekdayOfMonth, validCalendarDate } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');

/** The last six issues' picks keep a fact or species from repeating (plan.js RECENT_WINDOW). */
const HISTORY_SIZE = 6;
/** Rows that count as "an issue was built or sent" when looking back. */
const USED_STATUSES = Object.freeze(['shadow', 'drafted', 'scheduled', 'sent']);
/** etParts().dayOfWeek numbering: Sunday = 0. */
const THURSDAY = 4;
/** At most this many failed post probes are kept in a row's diagnostics. */
const MAX_PROBE_FAILURES = 10;

// Noon UTC on a calendar date is that same date in ET, clear of DST seams (the datetime-et convention).
const atNoonUTC = (dateET) => new Date(`${dateET}T12:00:00Z`);

function calendarDate(value) {
  const date = validCalendarDate(value);
  if (!date) throw new Error(`pest-insider: "${value}" is not a real calendar date (YYYY-MM-DD)`);
  return date;
}

/** The two issue dates of a month (1-based; 13 is next January): its 1st and 3rd Thursday. */
function issueDatesInMonth(year, month) {
  return [1, 3].map((nth) => etDateString(etNthWeekdayOfMonth(year, month, nth, THURSDAY)));
}

function isIssueDate(dateET) {
  const date = calendarDate(dateET);
  const [year, month] = date.split('-').map(Number);
  return issueDatesInMonth(year, month).includes(date);
}

/** The first issue date on or after `fromDateET`: this month's, or next month's 1st Thursday. */
function nextIssueDate(fromDateET) {
  const from = calendarDate(fromDateET);
  const [year, month] = from.split('-').map(Number);
  return [...issueDatesInMonth(year, month), ...issueDatesInMonth(year, month + 1)].find((d) => d >= from);
}

/** The calendar date today in America/New_York. */
const todayET = (now = new Date()) => etDateString(now);

/** The calendar date after `dateET`. */
const nextDay = (dateET) => etDateString(addETDays(atNoonUTC(calendarDate(dateET)), 1));

/**
 * What the last six issues before `issueDate` used, oldest first, as the planner expects.
 * An issue with no tool keeps a null in toolIds (the planner counts issues, not tools).
 */
async function recentHistory(issueDate, { database } = {}) {
  const db = database || require('../../models/db');
  const rows = await db('pest_insider_issues')
    .whereIn('status', USED_STATUSES)
    .where('issue_date', '<', issueDate)
    .orderBy('issue_date', 'desc')
    .limit(HISTORY_SIZE)
    .select('issue_date', 'fact_id', 'species_slug', 'tool_id');
  const oldestFirst = rows
    .map((r) => ({ ...r, date: dateOnlyString(r.issue_date) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    factIds: oldestFirst.map((r) => r.fact_id).filter(Boolean),
    speciesSlugs: oldestFirst.map((r) => r.species_slug).filter(Boolean),
    toolIds: oldestFirst.map((r) => r.tool_id || null),
  };
}

/**
 * The fetch the post check uses, wrapped to note each probe the website did not answer (a network
 * error, a timeout, a 5xx or a 429). The post check reads all of those as "not live"; the note lets
 * a skipped row tell "the website did not answer" apart from "the post is gone".
 */
function recordingFetch(fetchImpl = globalThis.fetch) {
  const failures = [];
  const probe = async (url, options) => {
    try {
      const res = await fetchImpl(url, options);
      if (res.status >= 500 || res.status === 429) failures.push(`${url} ${res.status}`);
      return res;
    } catch (err) {
      failures.push(`${url} ${(err && err.name) || 'Error'}`);
      throw err;
    }
  };
  return { probe, failures };
}

// The row for one planned issue. Bodies are never stored here: the send path rebuilds the issue.
function rowFor(issueDate, built, now, probeFailures) {
  const { ok, reason, issue, diagnostics = {} } = built;
  const recorded = probeFailures.length
    ? { ...diagnostics, postCheckFailures: probeFailures.slice(0, MAX_PROBE_FAILURES), postCheckFailureCount: probeFailures.length }
    : diagnostics;
  return {
    issue_date: issueDate,
    status: ok ? 'shadow' : 'skipped',
    fact_id: diagnostics.factId || null,
    species_slug: diagnostics.speciesSlug || null,
    tool_id: diagnostics.toolId || null,
    subject: ok ? issue.subject : null,
    preview: ok ? issue.preview : null,
    reason: reason || null,
    diagnostics: JSON.stringify(recorded),
    built_at: now,
  };
}

// Writes this tick's row. A first build inserts (a racing tick's row wins). A retry replaces the
// earlier row only while it is still 'skipped', so a row the send path has moved on is never touched.
async function writeRow(db, existing, row, now) {
  if (existing) {
    const updated = await db('pest_insider_issues').where({ id: existing.id, status: 'skipped' }).update({ ...row, updated_at: now });
    return Number(updated) > 0;
  }
  const inserted = await db('pest_insider_issues').insert(row).onConflict('issue_date').ignore().returning('id');
  return Array.isArray(inserted) ? inserted.length > 0 : true;
}

/**
 * Plan and build tomorrow's issue (when tomorrow is an issue date) and record it. Safe to call
 * again the same day: a built row is left alone, and a skipped one is built again (the 1:00 PM
 * catch-up retries an issue the 7:00 AM tick refused, for example during a website outage).
 * @returns {Promise<{ skipped: true, reason: string } | { skipped: false, issueDate: string, status: string, reason: string|null, written: boolean, retried: boolean }>}
 */
async function runShadowIssue({ now = new Date(), fetchImpl, database } = {}) {
  const issueDate = nextDay(todayET(now));
  if (!isIssueDate(issueDate)) return { skipped: true, reason: 'not_build_day' };

  const db = database || require('../../models/db');
  const existing = await db('pest_insider_issues').where({ issue_date: issueDate }).first('id', 'status');
  if (existing && existing.status !== 'skipped') return { skipped: true, reason: 'already_built' };

  // Lazy: the builder pulls the fact bank, renderer and validator; the scheduler should not load them at boot.
  const { buildIssue } = require('./index');
  const { checkLivePosts } = require('./posts');
  const logger = require('../logger');

  const { probe, failures } = recordingFetch(fetchImpl);
  const livePostFactIds = await checkLivePosts({ fetchImpl: probe });
  const recent = await recentHistory(issueDate, { database: db });
  const built = buildIssue({ sendDate: issueDate, recent, recheckedFactIds: [], livePostFactIds, liveToolUrls: [] });
  const row = rowFor(issueDate, built, now, failures);
  const written = await writeRow(db, existing, row, now);

  const notes = [
    row.reason ? `(${row.reason})` : null,
    `fact=${row.fact_id || '-'} species=${row.species_slug || '-'}`,
    failures.length ? `post probes failed=${failures.length}` : null,
    existing ? 'retry of a skipped row' : null,
    written ? null : '(row not written: another tick got there first)',
  ].filter(Boolean).join(' ');
  logger.info(`[pest-insider] shadow issue ${issueDate}: ${row.status} ${notes}`);
  return { skipped: false, issueDate, status: row.status, reason: row.reason, written, retried: Boolean(existing) };
}

module.exports = {
  issueDatesInMonth, isIssueDate, nextIssueDate, todayET, nextDay, recentHistory, runShadowIssue,
  USED_STATUSES, HISTORY_SIZE,
};
