/**
 * Waves Pest Insider schedule + issue planner.
 *
 * Issues go out on the 1st and 3rd Thursday of each month at 7:00 AM ET. The day before
 * (Wednesday 7:00 AM ET, with a 1:00 PM catch-up) runIssuePlanner plans and builds the
 * issue with the real builder and records the result in pest_insider_issues.
 *
 * GATE_PEST_INSIDER_AUTO_SEND off (the default): that row is all it does ('shadow', or
 * 'skipped' with the reason). Nothing is sent and no newsletter_sends row is made.
 *
 * On: a built issue becomes a newsletter_sends draft for its readers (audience.js: warm
 * readers minus the fixed holdout), linked from its row ('drafted'), and goes to the proof
 * step (newsletter-proof.js). That step emails the owner an FYI copy and queues the issue
 * for 7:00 AM ET on its Thursday (row 'scheduled'); the sender sends it in the 7:00-10:00 AM
 * ET window (row 'sent'). A HOLD reply or Cancel schedule holds it (row 'held'); a send-time
 * stop fails it (row 'failed'). The 1:00 PM run is the last try: when the issue still cannot
 * go out and nobody was told why, it raises one admin notification.
 *
 * Calendar dates here are 'YYYY-MM-DD' strings. The date math is the shared ET helpers in
 * utils/datetime-et.js (validCalendarDate, etNthWeekdayOfMonth, addETDays, etDateString);
 * this module keeps only the 1st-and-3rd-Thursday rule, which the table's CHECK also enforces.
 */
'use strict';

const crypto = require('crypto');
const { etDateString, addETDays, etNthWeekdayOfMonth, validCalendarDate, parseETDateTime } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { pestInsiderAutoSendLive } = require('../../config/feature-gates');
const { PEST_INSIDER_TYPE } = require('../../config/newsletter-types');

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

/** An issue sends at 7:00 AM ET on its issue date. */
const SEND_TIME_ET = '07:00:00';
/** A queued issue goes out only in the three hours after its send time; later it is stale and stays unsent. */
const SEND_WINDOW_MS = 3 * 60 * 60 * 1000;

/** When the issue for `issueDate` sends: 7:00 AM ET that day. */
const issueSendAt = (issueDate) => parseETDateTime(`${calendarDate(issueDate)}T${SEND_TIME_ET}`);

/** True from 7:00 AM ET on the issue date until 10:00 AM ET. */
function inSendWindow(issueDate, now = new Date()) {
  const start = issueSendAt(issueDate).getTime();
  return now.getTime() >= start && now.getTime() < start + SEND_WINDOW_MS;
}

/**
 * The planned issue behind a send (pest_insider_issues.send_id), with its send time, or null when
 * the send has none: a Pest Insider draft made by hand in the composer keeps the old approval path.
 * `valid` = a real issue date whose 7:00 AM ET send time is still ahead of `now`.
 */
async function issueContextForSend(send, { database, now = new Date() } = {}) {
  if (!send || !send.id) return null;
  const db = database || require('../../models/db');
  const issue = await db('pest_insider_issues').where({ send_id: send.id }).first();
  if (!issue) return null;
  const issueDate = dateOnlyString(issue.issue_date);
  const scheduledFor = issueSendAt(issueDate);
  return { issue, issueDate, scheduledFor, valid: isIssueDate(issueDate) && scheduledFor.getTime() > now.getTime() };
}

/**
 * Moves the planned issue linked to a send from one of the `from` statuses to `to`, with the reason.
 * Returns whether a row moved. The send row stays the record of what was mailed; this one is the
 * planner's, so callers log a failure here and carry on.
 */
async function moveIssueForSend(sendId, from, to, { reason, database } = {}) {
  const db = database || require('../../models/db');
  const moved = await db('pest_insider_issues')
    .where({ send_id: sendId })
    .whereIn('status', from)
    .update({ status: to, ...(reason ? { reason } : {}), updated_at: new Date() });
  return Number(moved) > 0;
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

// The row for one planned issue. Bodies are never stored here: a drafted issue's bodies live on
// its newsletter_sends row (send_id).
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

// Writes this tick's row. A first build inserts (a racing tick's row wins). A rebuild replaces the
// earlier row only while its status is still one of `replaceable`, so a row the send path has
// moved on is never touched.
async function writeRow(db, existing, row, now, replaceable) {
  if (existing) {
    const updated = await db('pest_insider_issues').where({ id: existing.id }).whereIn('status', replaceable).update({ ...row, updated_at: now });
    return Number(updated) > 0;
  }
  const inserted = await db('pest_insider_issues').insert(row).onConflict('issue_date').ignore().returning('id');
  return Array.isArray(inserted) ? inserted.length > 0 : true;
}

// A row in one of these statuses is built again by a later tick: a skipped issue always, and with
// the auto-send switch on, an issue built in shadow while it was off.
const rebuildable = (autoSend) => (autoSend ? ['skipped', 'shadow'] : ['skipped']);

// Where a Waves Pest Insider issue mails from: the newsletter subdomain (SendGrid domain
// authentication on news.wavespestcontrol.com, owner 2026-10-31). Replies go to contact@.
const SEND_FROM = Object.freeze({
  from_name: 'Waves Pest Control',
  from_email: 'newsletter@news.wavespestcontrol.com',
  reply_to: 'contact@wavespestcontrol.com',
});

// A built issue as a newsletter_sends draft for its readers: the shared body only (the tool
// block is added per reader in PR 4b, or never). Never shared to social media: the plan posts
// an issue nowhere but the inbox and its archive page.
function draftSendRow(issueDate, issue, segmentFilter) {
  return {
    subject: issue.subject,
    subject_b: null,
    html_body: issue.html_body,
    text_body: issue.text_body,
    preview_text: issue.preview,
    ...SEND_FROM,
    status: 'draft',
    segment_filter: segmentFilter,
    newsletter_type: PEST_INSIDER_TYPE,
    slug: `waves-pest-insider-${issueDate}-${crypto.randomUUID().slice(0, 6)}`,
    created_by: null,
    auto_share_social: false,
    event_ids: JSON.stringify([]),
  };
}

// The row with its readers' counts in the diagnostics. No reader: the issue is skipped.
function withAudience(row, audience) {
  const diagnostics = JSON.stringify({ ...JSON.parse(row.diagnostics), audience: audience.counts });
  if (audience.subscriberIds.length) return { ...row, diagnostics };
  return { ...row, status: 'skipped', reason: 'empty_audience', subject: null, preview: null, diagnostics };
}

// The draft and its 'drafted' row in one transaction: when another tick wrote the row first,
// the draft is rolled back too. Returns the new send id, or null when the other tick won.
async function draftIssue(db, { existing, row, issue, segmentFilter, issueDate, now, replaceable }) {
  const RACE_LOST = 'PEST_INSIDER_ROW_TAKEN';
  try {
    return await db.transaction(async (trx) => {
      const [inserted] = await trx('newsletter_sends').insert(draftSendRow(issueDate, issue, segmentFilter)).returning('id');
      const sendId = inserted && typeof inserted === 'object' ? inserted.id : inserted;
      const written = await writeRow(trx, existing, { ...row, status: 'drafted', send_id: sendId }, now, replaceable);
      if (!written) throw Object.assign(new Error('pest-insider: another tick wrote this issue first'), { code: RACE_LOST });
      return sendId;
    });
  } catch (err) {
    if (err.code === RACE_LOST) return null;
    throw err;
  }
}

// The proof step's answer in a few words, for the log and the return value.
function proofOutcome(proof) {
  if (!proof) return null;
  if (proof.sent) return proof.queued ? 'queued' : 'fyi_sent_not_queued';
  return proof.reason || 'skipped';
}

// The proof step already told the owner, or another worker is on it, or its FYI copy went out
// earlier: no second notice from the planner.
const proofInformed = (proof) => Boolean(proof && (proof.sent || proof.notified
  || proof.reason === 'proof_already_sent' || proof.reason === 'proof_claimed_elsewhere'));

// Why an issue will not send, in plain words for the admin notification.
const REASON_COPY = [
  [/^no_live_post_for_month|^no_fact_for_month/, 'no fact for this month has a live post on the Waves blog'],
  [/^no_live_post/, "its lead fact's post on the Waves blog did not answer"],
  [/^no_species/, "no species is left for \"What's this?\""],
  [/^recheck_needed/, 'its lead fact needs a person to re-read the source first'],
  [/^copy_check_failed|^send_validator_blocked/, 'the copy check refused it'],
  [/^empty_audience$/, 'no reader opened a Waves email in the last 90 days'],
  [/^gate_off$/, 'GATE_NEWSLETTER_PROOF_APPROVAL is off, so the FYI copy did not go out'],
  [/^no_approvers_configured$/, 'NEWSLETTER_PROOF_APPROVERS is empty, so the FYI copy did not go out'],
  [/^sendgrid_not_configured$/, 'SendGrid is not set up, so the FYI copy did not go out'],
  [/^proof_send_failed$/, 'SendGrid did not accept the FYI copy'],
  [/^draft_missing$/, 'its draft was deleted'],
];
function reasonCopy(reason) {
  const hit = REASON_COPY.find(([pattern]) => pattern.test(String(reason || '')));
  return hit ? `${hit[1]} (${reason})` : String(reason || 'unknown reason');
}

// "Thursday, December 3": an issue date for people.
const issueDayLabel = (issueDate) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
}).format(issueSendAt(issueDate));

/**
 * The last tick's check: with the auto-send switch on, an issue that is not queued, sent or held
 * by now will not go out. Unless the proof step already told the owner why, raise one admin
 * notification (the same one the proof step raises for a refused check).
 */
async function noticeIfIssueWillNotSend(db, issueDate, proof) {
  const row = await db('pest_insider_issues').where({ issue_date: issueDate }).first('status', 'reason');
  if (row && ['scheduled', 'sent', 'held'].includes(row.status)) return false;
  if (row && row.status === 'drafted' && proofInformed(proof)) return false;
  const reason = !row ? 'no issue was recorded' : reasonCopy(row.status === 'drafted' ? (proof && proof.reason) || 'draft_missing' : row.reason);
  const { triggerNotification } = require('../notification-triggers');
  await triggerNotification('newsletter_proof_blocked', {
    sendId: null,
    subject: `Waves Pest Insider for ${issueDayLabel(issueDate)}`,
    errors: [`It will not send this time: ${reason}`],
  });
  return true;
}

/**
 * Plan and build tomorrow's issue (when tomorrow is an issue date) and record it; with
 * GATE_PEST_INSIDER_AUTO_SEND on, also draft it for its readers and run the proof step. Safe to
 * call again the same day: a built row is left alone, a skipped one is built again (the 1:00 PM
 * catch-up retries an issue the 7:00 AM tick refused, for example during a website outage), and
 * a drafted one whose FYI copy did not go out gets the proof step again.
 * @param {{ now?: Date, fetchImpl?: Function, database?: Function, finalTick?: boolean, sendProof?: Function }} [options]
 *   finalTick: the 1:00 PM run, the last chance to queue the issue (see noticeIfIssueWillNotSend).
 */
async function runIssuePlanner({ now = new Date(), fetchImpl, database, finalTick = false, sendProof } = {}) {
  const issueDate = nextDay(todayET(now));
  if (!isIssueDate(issueDate)) return { skipped: true, reason: 'not_build_day' };

  const db = database || require('../../models/db');
  const autoSend = pestInsiderAutoSendLive();
  const proofStep = sendProof || ((sendId) => require('../newsletter-proof').sendNewsletterProof(sendId));
  const existing = await db('pest_insider_issues').where({ issue_date: issueDate }).first('id', 'status', 'send_id');

  let result;
  if (existing && existing.status === 'drafted' && autoSend) {
    const proof = existing.send_id ? await proofStep(existing.send_id) : { skipped: true, reason: 'draft_missing' };
    result = { skipped: false, issueDate, status: 'drafted', reason: null, written: false, retried: true, sendId: existing.send_id, proof: proofOutcome(proof) };
    result.noticeRaised = finalTick && await noticeIfIssueWillNotSend(db, issueDate, proof);
    require('../logger').info(`[pest-insider] issue ${issueDate}: proof step again for its draft: ${result.proof}`);
    return result;
  }
  if (existing && !rebuildable(autoSend).includes(existing.status)) return { skipped: true, reason: 'already_built' };

  const { proof, ...built } = await buildAndRecord(db, { issueDate, existing, autoSend, now, fetchImpl, proofStep });
  result = { ...built, proof: proofOutcome(proof) };
  if (finalTick && autoSend) result.noticeRaised = await noticeIfIssueWillNotSend(db, issueDate, proof);
  return result;
}

// One build: post check, history, builder, then the row (and, with the switch on, the draft and
// the proof step). Returns the run's result plus the proof step's raw answer.
async function buildAndRecord(db, { issueDate, existing, autoSend, now, fetchImpl, proofStep }) {
  // Lazy: the builder pulls the fact bank, renderer and validator; the scheduler should not load them at boot.
  const { buildIssue } = require('./index');
  const { checkLivePosts } = require('./posts');
  const logger = require('../logger');
  const replaceable = rebuildable(autoSend);

  const { probe, failures } = recordingFetch(fetchImpl);
  const livePostFactIds = await checkLivePosts({ fetchImpl: probe });
  const recent = await recentHistory(issueDate, { database: db });
  const built = buildIssue({ sendDate: issueDate, recent, recheckedFactIds: [], livePostFactIds, liveToolUrls: [] });
  let row = rowFor(issueDate, built, now, failures);

  let written;
  let sendId = null;
  if (autoSend && row.status === 'shadow') {
    // Lazy for the same reason: the audience query loads the whole newsletter send path.
    const { selectIssueAudience, audienceSegmentFilter } = require('./audience');
    const audience = await selectIssueAudience({ asOf: now });
    row = withAudience(row, audience);
    if (row.status === 'shadow') {
      sendId = await draftIssue(db, { existing, row, issue: built.issue, segmentFilter: audienceSegmentFilter(audience), issueDate, now, replaceable });
      written = sendId != null;
      if (written) row = { ...row, status: 'drafted', send_id: sendId };
    }
  }
  if (written === undefined) written = await writeRow(db, existing, row, now, replaceable);
  const proof = sendId ? await proofStep(sendId) : null;

  const notes = [
    row.reason ? `(${row.reason})` : null,
    `fact=${row.fact_id || '-'} species=${row.species_slug || '-'}`,
    failures.length ? `post probes failed=${failures.length}` : null,
    existing ? `rebuild of a ${existing.status} row` : null,
    written ? null : '(row not written: another tick got there first)',
    proof ? `proof=${proofOutcome(proof)}` : null,
  ].filter(Boolean).join(' ');
  logger.info(`[pest-insider] issue ${issueDate}: ${row.status} ${notes}`);
  return { skipped: false, issueDate, status: row.status, reason: row.reason, written, retried: Boolean(existing), sendId, proof };
}

module.exports = {
  issueDatesInMonth, isIssueDate, nextIssueDate, todayET, nextDay, recentHistory, runIssuePlanner,
  issueSendAt, inSendWindow, issueContextForSend, moveIssueForSend,
  USED_STATUSES, HISTORY_SIZE, SEND_WINDOW_MS,
};
