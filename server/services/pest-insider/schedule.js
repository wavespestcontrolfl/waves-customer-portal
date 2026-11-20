/**
 * Pest Insider schedule + shadow planner.
 *
 * Issues go out on the 1st and 3rd Thursday of each month at 7:00 AM ET. The day before
 * (Wednesday 7:00 AM ET, with a 1:00 PM catch-up) runShadowIssue plans and builds the
 * issue with the real builder and records the result in pest_insider_issues. It sends
 * nothing: no email, no newsletter_sends row, no admin notification. The send path comes
 * in the next PR and reads these rows.
 *
 * Calendar dates here are 'YYYY-MM-DD' strings. They are computed with UTC date math on
 * the year, month and day numbers alone, so the machine's time zone and daylight saving
 * can never move a date. Only todayET() looks at a clock, and it asks the ET helper.
 *
 * Issue Thursdays have a day of month of 1-7 (the 1st Thursday) or 15-21 (the 3rd), which
 * is the same rule the table's CHECK enforces.
 */
'use strict';

const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');

/** The last six issues' picks keep a fact or species from repeating (plan.js RECENT_WINDOW). */
const HISTORY_SIZE = 6;
/** Rows that count as "an issue was built or sent" when looking back. */
const USED_STATUSES = Object.freeze(['shadow', 'drafted', 'scheduled', 'sent']);
const THURSDAY = 4;

const pad = (n) => String(n).padStart(2, '0');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function partsOf(dateET) {
  if (typeof dateET !== 'string' || !DATE_ONLY.test(dateET)) throw new Error(`pest-insider: "${dateET}" is not a YYYY-MM-DD date`);
  const [year, month, day] = dateET.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`pest-insider: ${dateET} is not a real calendar date`);
  }
  return { year, month, day, weekday: d.getUTCDay() };
}

const format = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;

/** The two issue dates of a month: its 1st and 3rd Thursday. */
function issueDatesInMonth(year, month) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstThursday = 1 + ((THURSDAY - firstWeekday + 7) % 7);
  return [format(year, month, firstThursday), format(year, month, firstThursday + 14)];
}

function isIssueDate(dateET) {
  const { year, month, day, weekday } = partsOf(dateET);
  return weekday === THURSDAY && issueDatesInMonth(year, month).includes(format(year, month, day));
}

/** The first issue date on or after `fromDateET`. */
function nextIssueDate(fromDateET) {
  const { year, month } = partsOf(fromDateET);
  for (let offset = 0; offset < 3; offset += 1) {
    const monthIndex = month - 1 + offset;
    const dates = issueDatesInMonth(year + Math.floor(monthIndex / 12), (monthIndex % 12) + 1);
    const next = dates.find((d) => d >= fromDateET);
    if (next) return next;
  }
  throw new Error('pest-insider: no issue date found'); // unreachable: every month has two
}

/** The calendar date today in America/New_York. */
const todayET = (now = new Date()) => etDateString(now);

/** The calendar date after `dateET`. */
function nextDay(dateET) {
  const { year, month, day } = partsOf(dateET);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return format(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

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

// The row for one planned issue. Bodies are never stored here: the send path rebuilds the issue.
function rowFor(issueDate, built, now) {
  const { ok, reason, issue, diagnostics = {} } = built;
  return {
    issue_date: issueDate,
    status: ok ? 'shadow' : 'skipped',
    fact_id: diagnostics.factId || null,
    species_slug: diagnostics.speciesSlug || null,
    tool_id: diagnostics.toolId || null,
    subject: ok ? issue.subject : null,
    preview: ok ? issue.preview : null,
    reason: reason || null,
    diagnostics: JSON.stringify(diagnostics),
    built_at: now,
  };
}

/**
 * Plan and build tomorrow's issue (when tomorrow is an issue date) and record it. Safe to
 * call again the same day: a date that already has a row is left alone.
 * @returns {Promise<{ skipped: true, reason: string } | { skipped: false, issueDate: string, status: string, reason: string|null, inserted: boolean }>}
 */
async function runShadowIssue({ now = new Date(), fetchImpl, database } = {}) {
  const issueDate = nextDay(todayET(now));
  if (!isIssueDate(issueDate)) return { skipped: true, reason: 'not_build_day' };

  const db = database || require('../../models/db');
  if (await db('pest_insider_issues').where({ issue_date: issueDate }).first('id')) {
    return { skipped: true, reason: 'already_built' };
  }

  // Lazy: the builder pulls the fact bank, renderer and validator; the scheduler should not load them at boot.
  const { buildIssue } = require('./index');
  const { checkLivePosts } = require('./posts');
  const logger = require('../logger');

  const livePostFactIds = await checkLivePosts(fetchImpl ? { fetchImpl } : {});
  const recent = await recentHistory(issueDate, { database: db });
  const built = buildIssue({ sendDate: issueDate, recent, recheckedFactIds: [], livePostFactIds, liveToolUrls: [] });
  const row = rowFor(issueDate, built, now);

  const inserted = await db('pest_insider_issues').insert(row).onConflict('issue_date').ignore().returning('id');
  const wasInserted = Array.isArray(inserted) ? inserted.length > 0 : true;
  logger.info(`[pest-insider] shadow issue ${issueDate}: ${row.status}${row.reason ? ` (${row.reason})` : ''} fact=${row.fact_id || '-'} species=${row.species_slug || '-'}${wasInserted ? '' : ' (row already existed)'}`);
  return { skipped: false, issueDate, status: row.status, reason: row.reason, inserted: wasInserted };
}

module.exports = {
  issueDatesInMonth, isIssueDate, nextIssueDate, todayET, nextDay, recentHistory, runShadowIssue,
  USED_STATUSES, HISTORY_SIZE,
};
