'use strict';

// Weekly owner check on the post-call booking-link text lane
// (call-booking-link-text.js, GATE_CALL_BOOKING_LINK_TEXT). Owner 2026-09-29:
// "add a check to it every 7 days with an admin notification, make it
// concise". Unlike the exception-only digests, this one posts EVERY week the
// lane is on, so the owner sees it working (or not) without asking.
//
// Bell = two short lines (owner ruling 2026-09-28, admin-alerts brevity):
//   healthy  "Booking-link texts: 2 sent this week"
//            "31 calls checked · top skips: existing customer 14, no lead 5"
//   problem  "Booking-link texts need a look"
//            "3 stuck · 1 error · last run 3h ago"
// The fuller breakdown rides in `detail` (and the email fallback).
//
// Cron: Monday 8:13am ET in scheduler.js, inside runExclusive.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { deliverOpsDigest } = require('./ops-digest');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { etWeekStart, addETDaysAtWallClock, parseETDateTime } = require('../utils/datetime-et');
const { isEnabled } = require('../config/feature-gates');
const { GATE, METADATA_KEY, activationBoundary } = require('./call-booking-link-text');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const JOB_NAME = 'call-booking-link-text';
const OPS_KEY = 'call-booking-link-weekly';
const WINDOW_DAYS = 7;
const STUCK_MS = 24 * 60 * 60 * 1000;
// The sweep runs every 5 minutes; an hour without a success means it stopped.
const SWEEP_STALE_MS = 60 * 60 * 1000;
const SUMMARY_MAX = 110;
const LINK = '/admin/agents?tab=activity';

const digestEmail = () => process.env.CALL_BOOKING_LINK_WEEKLY_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

// Worker outcomes that mean the lane misbehaved, not that a call was
// (correctly) ineligible. A failed delivery is also marked `failed` by the
// sweep, whatever the provider code (see recordSendOutcome).
const ERROR_REASONS = new Set(['worker_error', 'call_not_ready_timeout', 'never_send_recheck_failed', 'send_retry_timeout']);
// A valid call the sweep has not stamped this long after it went quiet was
// never checked: stage() threw on it (it catches per call, so the job still
// reads as healthy) or it fell out of the staging lookback.
const UNCHECKED_AFTER_MS = 60 * 60 * 1000;

// Plain words for the skip reasons the owner will actually see. Anything
// else falls back to the reason with underscores as spaces.
const REASON_LABELS = {
  existing_customer: 'existing customer',
  no_lead_linkage: 'no lead',
  not_new_lead_call: 'not a new lead',
  not_residential: 'not a home',
  quote_promised: 'quote promised',
  third_party_caller: 'third party',
  service_intent_not_onsite: 'no visit wanted',
  priced_on_call: 'priced on call',
  already_booked_on_call: 'booked on call',
  booked_since_call: 'booked after call',
  estimate_linked: 'has estimate',
  sms_declined: 'said no texts',
  sms_declined_earlier_call: 'said no texts before',
  sms_refusal_unrecorded: 'older call',
  prefers_phone_contact: 'wants a call',
  not_in_service_area: 'out of area',
  call_too_short: 'short call',
  voicemail_or_spam: 'voicemail or spam',
  link_sent_recently: 'link already sent',
  stale_at_staging: 'too late to send',
};

function reasonLabel(reason) {
  const r = String(reason || 'unknown');
  if (REASON_LABELS[r]) return REASON_LABELS[r];
  if (r.startsWith('triage_flag_')) return r.slice('triage_flag_'.length).replace(/_/g, ' ');
  return r.replace(/_/g, ' ');
}

// The report covers one FIXED week: from the scheduled Monday 8:13 ET tick
// seven calendar days back up to the most recent one at or before `now`.
// Every time test (call, send, final decision) uses these same two bounds,
// so consecutive reports meet exactly however long a run waited for its
// lock or whenever a DST change falls (codex #5358 r3 + r4).
const TICK_HOUR = 8;
const TICK_MINUTE = 13;

function reportWindow(now) {
  let end = parseETDateTime(`${etWeekStart(now)}T0${TICK_HOUR}:${TICK_MINUTE}:00`);
  if (end.getTime() > now.getTime()) end = addETDaysAtWallClock(end, -WINDOW_DAYS);
  return { start: addETDaysAtWallClock(end, -WINDOW_DAYS), end };
}

// Rows the week needs, each by its own time: calls made in the window, sends
// and final decisions reached in it whatever the call's age (codex #5358 r4
// P2), and every unresolved send whatever its age, so a stuck row keeps
// being reported until it resolves (pre-push P1).
const OUTCOME_IN_WINDOW = "(metadata->?->>?)::timestamptz >= ? AND (metadata->?->>?)::timestamptz < ?";

async function loadWeek(now = new Date()) {
  const { start, end } = reportWindow(now);
  const rows = await db('call_log')
    .modify((q) => whereNotSandboxCall(q)) // the sweep never texts a sandbox call either
    .whereRaw('metadata->? IS NOT NULL', [METADATA_KEY])
    .where((q) => q
      .where((w) => w.where('created_at', '>=', start).where('created_at', '<', end))
      .orWhereRaw(OUTCOME_IN_WINDOW, [METADATA_KEY, 'sent_at', start, METADATA_KEY, 'sent_at', end])
      .orWhereRaw(OUTCOME_IN_WINDOW, [METADATA_KEY, 'decided_at', start, METADATA_KEY, 'decided_at', end])
      .orWhereRaw(OUTCOME_IN_WINDOW, [METADATA_KEY, 'staged_at', start, METADATA_KEY, 'staged_at', end])
      .orWhereRaw('metadata->?->>? IN (?, ?)', [METADATA_KEY, 'status', 'pending', 'claimed']))
    .select(
      'created_at',
      db.raw('metadata->?->>? AS status', [METADATA_KEY, 'status']),
      db.raw('metadata->?->>? AS reason', [METADATA_KEY, 'reason']),
      db.raw('metadata->?->>? AS send_at', [METADATA_KEY, 'send_at']),
      db.raw('metadata->?->>? AS sent_at', [METADATA_KEY, 'sent_at']),
      db.raw('metadata->?->>? AS decided_at', [METADATA_KEY, 'decided_at']),
      db.raw('metadata->?->>? AS staged_at', [METADATA_KEY, 'staged_at']),
      db.raw('metadata->?->>? AS failed', [METADATA_KEY, 'failed']),
    );
  const job = await db('job_health').where({ job_name: JOB_NAME }).first('last_success_at', 'consecutive_failures');
  // "Not checked" is a standing state, like a stuck send, not a weekly
  // count: every valid call since the gate went live that the sweep never
  // stamped stays in every report until it is stamped, however many week
  // boundaries it crosses (codex #5358 r6 P2).
  const boundary = await activationBoundary(db);
  const unstamped = await db('call_log')
    .modify((q) => whereNotSandboxCall(q)) // stage() never sees a sandbox call
    .where('v2_extraction_status', 'valid')
    .where('created_at', '>=', boundary)
    .whereNull('processing_token')
    .where('updated_at', '<=', new Date(now.getTime() - UNCHECKED_AFTER_MS))
    .whereRaw('metadata->? IS NULL', [METADATA_KEY])
    .count('* as n')
    .first();
  return { rows, job, unchecked: Number(unstamped?.n || 0) };
}

function hoursAgo(then, now) {
  const h = Math.round((now.getTime() - new Date(then).getTime()) / 3600000);
  return h >= 48 ? `${Math.round(h / 24)}d ago` : `${h}h ago`;
}

function clampSummary(s) {
  const text = String(s);
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
}

const isWaiting = (r) => r.status === 'pending' || r.status === 'claimed';
const isFailed = (r) => r.failed === true || r.failed === 'true';
const isError = (r) => r.status === 'ambiguous'
  || (r.status === 'skipped' && (isFailed(r) || ERROR_REASONS.has(r.reason)));
// When the lane looked at the call: staged_at, which can land after the
// report that the call's own time falls in (extraction + grace period), so a
// call is checked, and a stage-time skip counted, in the week it was stamped
// (codex #5358 r5 P2). created_at only for rows passed without one.
const checkedAt = (r) => r.staged_at || r.created_at;
// When the call reached its outcome: decided_at, the moment the final
// decision was written (a send's sent_at is the sweep's start time, which
// can fall before a report the write lands after; codex #5358 r6 P2);
// sent_at for rows written before decided_at existed; staged_at for a
// stage-time skip.
const outcomeAt = (r) => r.decided_at || r.sent_at || checkedAt(r);

// `checked` = calls the lane looked at this week; `outcomes` = decisions reached this week,
// whatever week the call was in; `waiting` = everything still open, so a
// stuck row is reported until it resolves.
function tally({ outcomes, waiting }, now) {
  const stuck = waiting.filter((r) => r.send_at && now.getTime() - new Date(r.send_at).getTime() > STUCK_MS).length;
  const skipCounts = new Map();
  for (const r of outcomes) {
    if (r.status !== 'skipped' || isError(r)) continue;
    const label = reasonLabel(r.reason);
    skipCounts.set(label, (skipCounts.get(label) || 0) + 1);
  }
  return {
    sent: outcomes.filter((r) => r.status === 'sent').length,
    errors: outcomes.filter(isError).length,
    stuck,
    waiting: waiting.length - stuck,
    topSkips: [...skipCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function sweepState(job, now) {
  const lastSuccess = job?.last_success_at ? new Date(job.last_success_at) : null;
  return {
    lastSuccess,
    stale: !lastSuccess || now.getTime() - lastSuccess.getTime() > SWEEP_STALE_MS,
    failing: Number(job?.consecutive_failures || 0) > 0,
  };
}

function problemsFor(t, sweep, now) {
  const problems = [];
  if (t.stuck) problems.push(`${t.stuck} stuck`);
  if (t.errors) problems.push(`${t.errors} error${t.errors === 1 ? '' : 's'}`);
  if (t.unchecked) problems.push(`${t.unchecked} not checked`);
  if (sweep.stale) problems.push(sweep.lastSuccess ? `last run ${hoursAgo(sweep.lastSuccess, now)}` : 'never ran');
  else if (sweep.failing) problems.push('last run failed');
  return problems;
}

function healthySummary(checkedCount, topSkips) {
  if (!checkedCount) return 'No new-lead calls to check';
  const checked = `${checkedCount} call${checkedCount === 1 ? '' : 's'} checked`;
  const skips = topSkips.slice(0, 2).map(([label, n]) => `${label} ${n}`).join(', ');
  return skips ? `${checked} · top skips: ${skips}` : checked;
}

// Pure: the week's numbers → bell headline/summary + detail text.
function composeWeeklyCheck({ rows = [], job = null, unchecked = 0 }, now = new Date()) {
  const { start, end } = reportWindow(now);
  // Rows without a time (callers passing their own rows) count as this week.
  const inWindow = (at) => !at || (new Date(at).getTime() >= start.getTime() && new Date(at).getTime() < end.getTime());
  // A call that predates the gate going live is not this week's news.
  const notPre = rows.filter((r) => r.reason !== 'pre_activation');
  const live = notPre.filter((r) => inWindow(checkedAt(r)));
  const waiting = notPre.filter(isWaiting);
  // An outcome counts in the week it happened, so a text sent, or a send
  // that failed, after the previous check for an earlier call is never missed.
  const outcomes = notPre.filter((r) => !isWaiting(r) && inWindow(outcomeAt(r)));
  const t = tally({ outcomes, waiting }, now);
  t.unchecked = Number(unchecked) || 0;
  const sweep = sweepState(job, now);
  const problems = problemsFor(t, sweep, now);

  const headline = problems.length
    ? 'Booking-link texts need a look'
    : (t.sent ? `Booking-link texts: ${t.sent} sent this week` : 'Booking-link texts: none sent this week');
  const summary = clampSummary(problems.length ? problems.join(' · ') : healthySummary(live.length, t.topSkips));

  const detail = [
    `Last ${WINDOW_DAYS} days: ${live.length} calls checked, ${t.sent} sent, ${t.waiting} waiting to send.`,
    `Problems: ${t.stuck} stuck, ${t.errors} errors, ${t.unchecked} not checked; sweep last succeeded ${sweep.lastSuccess ? hoursAgo(sweep.lastSuccess, now) : 'never'}${sweep.failing ? ', last run failed' : ''}.`,
    'Skipped:',
    ...(t.topSkips.length ? t.topSkips.map(([label, n]) => `  ${label}: ${n}`) : ['  none']),
  ].join('\n');

  return { headline, summary, detail, problem: problems.length > 0, sentCount: t.sent, checked: live.length };
}

// Keyed by the week the report covers (its end tick), not the run time.
function reportWeekKey(now = new Date()) {
  return etWeekStart(reportWindow(now).end);
}

function dedupeKeyFor(now = new Date()) {
  return `${OPS_KEY}:${reportWeekKey(now)}`;
}

// Durable weekly-send guard, like agent-gap-digest's: runExclusive only
// serializes CONCURRENT ticks, and the email fallback skips the bell's
// dedupeKey, so a deploy-overlap instance entering after the first released
// the lock would email again. Stamped only after a delivery succeeded; a
// read failure sends anyway (a rare double beats a silently skipped week).
// Compared against the report week, not a rolling age: a report can only be
// sent at or after its week's end tick, so a stamp at or after that tick
// means THIS week's report went out, and a late retry of last week's report
// never holds back the next one (codex #5358 r5 P2).
async function sentRecently(now = new Date()) {
  try {
    const row = await db('ops_email_send_state').where({ email_key: OPS_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && new Date(row.last_sent_at).getTime() >= reportWindow(now).end.getTime());
  } catch (err) {
    logger.warn(`[call-booking-link-weekly] send-marker read failed (${err.code || err.name || 'error'}) — proceeding without the guard`);
    return false;
  }
}

async function stampSendMarker() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: OPS_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[call-booking-link-weekly] send-marker write failed (${err.code || err.name || 'error'}) — next tick may re-send`);
  }
}

async function runCallBookingLinkWeeklyCheck(opts = {}) {
  const now = opts.now || new Date();
  if (!(opts.gateEnabled ?? isEnabled(GATE))) return { skipped: 'disabled' };
  if (await (opts.sentRecently || sentRecently)(now)) return { skipped: 'recent_send' };
  let data;
  try {
    data = await (opts.loadWeek || loadWeek)(now);
  } catch (err) {
    logger.error(`[call-booking-link-weekly] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }
  const composed = composeWeeklyCheck(data, now);

  const mailer = opts.sendgrid || sendgrid;
  const to = digestEmail();
  // The email is only the bell's fallback, so its checks live inside it: an
  // unconfigured mailer or a bad recipient must not cost the week's in-app
  // bell (codex #5358 r6 P2). FAIL CLOSED: owner/internal inboxes only.
  const sendEmail = () => {
    if (!isInternalEmailRecipient(to)) {
      logger.warn('[call-booking-link-weekly] recipient is not an internal address — email skipped; set a valid CALL_BOOKING_LINK_WEEKLY_EMAIL');
      return { ok: false, error: 'recipient' };
    }
    if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
      logger.warn('[call-booking-link-weekly] mailer not configured — email skipped');
      return { ok: false, error: 'unconfigured' };
    }
    return mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.headline,
      text: `${composed.summary}\n\n${composed.detail}`,
      categories: ['ops', OPS_KEY],
      suppressErrorLog: true,
    });
  };

  let delivered;
  try {
    delivered = await (opts.deliver || deliverOpsDigest)({
      key: OPS_KEY,
      subject: `${composed.problem ? 'ACT' : 'FYI'}: ${composed.headline}`,
      headline: composed.headline,
      summary: composed.summary,
      text: composed.detail,
      link: LINK,
      // Owner asked for this every week: owner audience, and the week itself
      // is part of the item identity so each new week rings even when the
      // numbers match last week's. A same-week rerun hits the dedupeKey.
      audience: 'owner',
      dedupeKey: dedupeKeyFor(now),
      count: composed.checked,
      itemKeys: [reportWeekKey(now)],
      ringOnFirstIdentity: true,
      sendEmail,
    });
  } catch (err) {
    logger.error(`[call-booking-link-weekly] delivery failed (${err.code || err.name || 'error'})`);
    return { sent: false, error: true, ...composed };
  }
  if (delivered?.ok === false) {
    logger.error('[call-booking-link-weekly] delivery reported not ok');
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  logger.info(`[call-booking-link-weekly] posted via ${delivered?.channel || 'unknown'}: ${composed.headline}`);
  return { sent: true, ...composed };
}

module.exports = {
  runCallBookingLinkWeeklyCheck,
  _private: { composeWeeklyCheck, reportWindow, sentRecently, dedupeKeyFor, reasonLabel, clampSummary, loadWeek, OPS_KEY, SUMMARY_MAX },
};
