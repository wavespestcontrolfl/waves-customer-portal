'use strict';

/**
 * Bad inbound calls, counted once per lead source (owner 2026-11-26, "ok build"),
 * ready before Google Local Services Ads start sending calls.
 *
 * Four small pieces share this file:
 *   inboundCallSource(toPhone)       the lead source of the number the caller dialed, for
 *                                    call_log.source on a new inbound row. It reuses
 *                                    TWILIO_NUMBERS.getLeadSourceFromNumber (the one number
 *                                    registry mapping); an unmapped number gives null, so the
 *                                    column stays empty rather than saying "unknown".
 *   stampAnswerSeconds(...)          call_log.answer_seconds when a person accepts the forwarded
 *                                    call. Fail soft: it never throws.
 *   weeklyBadCallSummary({ now })    the previous Monday-to-Sunday week, per source: inbound
 *                                    calls, answered by a person, voicemail, each invalid_reason
 *                                    count and the median answer_seconds. Rows older than the
 *                                    columns work too: a null source is derived from the dialed
 *                                    number, a null invalid_reason from the row's own signals.
 *   runWeeklyBadCallAlert()          the Monday 7:58 AM ET admin notification, one short line per
 *                                    source in its detail. No customer name or phone number.
 *
 * It sends nothing to a customer and calls no paid API. No gate: undo is a revert.
 */

const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { toE164 } = require('../utils/phone');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { INVALID_REASONS, resolveInvalidReasonFromRow } = require('./call-invalid-reason');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { shortDateET } = require('./admin-alert-names');
const { etWeekStart, etDateString, parseETDateTime, addETDaysAtWallClock } = require('../utils/datetime-et');

const WINDOW_DAYS = 7;
const DEDUPE_PREFIX = 'bad-call-count-weekly';
const SUBJECT_ID = 'bad-call-count-weekly';

const SOURCE_LABELS = {
  google_ads: 'Google Ads',
  google_lsa: 'Local Services Ads',
  facebook: 'Facebook Ads',
  google_business: 'Google Business Profile',
  waves_website: 'Waves website',
  domain_website: 'Spoke sites',
  van_wrap: 'Van wrap',
  unknown: 'Unmapped number',
};
const sourceLabel = (key) => SOURCE_LABELS[key] || String(key || 'unknown').replace(/[_-]+/g, ' ');

const REASON_LABELS = {
  spam: 'spam',
  wrong_number: 'wrong number',
  solicitor: 'solicitor',
  out_of_area: 'out of area',
  service_not_offered: 'service not offered',
  silent: 'silent',
};

/** The lead source of the dialed number, or null when the registry does not know it. */
function inboundCallSource(toPhone) {
  const e164 = toE164(toPhone);
  if (!e164) return null;
  const { source } = TWILIO_NUMBERS.getLeadSourceFromNumber(e164);
  return source && source !== 'unknown' ? source : null;
}

/**
 * Seconds from the inbound call's start (its call_log row's creation, written when the
 * call arrives) to a person accepting it. Set once: a repeat accept keeps the first stamp.
 * Never throws: a failed stamp must not break the call.
 */
async function stampAnswerSeconds({ parentCallSid, acceptedAt = new Date(), database = db }) {
  try {
    if (!parentCallSid) return 0;
    return await database('call_log')
      .where('twilio_call_sid', parentCallSid)
      .whereNull('answer_seconds')
      .update({
        answer_seconds: database.raw('GREATEST(0, ROUND(EXTRACT(EPOCH FROM (?::timestamptz - created_at))))::int', [acceptedAt.toISOString()]),
      });
  } catch (err) {
    logger.warn(`[answer-seconds] stamp failed (${err.code || err.name || 'error'})`);
    return 0;
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// One fixed week: the 7 Eastern days ending at the most recent Monday 12:00 AM ET at or before `now`.
function reportWindow(now) {
  const end = parseETDateTime(`${etWeekStart(now)}T00:00:00`);
  return { start: addETDaysAtWallClock(end, -WINDOW_DAYS), end };
}

const isVoicemail = (row) => row.answered_by === 'voicemail' || row.call_outcome === 'voicemail';
const isAnsweredByPerson = (row) => row.answered_by === 'human' || row.answer_seconds != null;

/** Pure: call rows -> one summary object per source, biggest first. */
function summarizeRows(rows) {
  const bySource = new Map();
  for (const row of rows) {
    const key = row.source || inboundCallSource(row.to_phone) || 'unknown';
    const s = bySource.get(key) || {
      source: key, calls: 0, answeredByPerson: 0, voicemail: 0, invalid: 0,
      reasons: Object.fromEntries(INVALID_REASONS.map((r) => [r, 0])), answerTimes: [],
    };
    s.calls += 1;
    if (isAnsweredByPerson(row)) s.answeredByPerson += 1;
    if (isVoicemail(row)) s.voicemail += 1;
    const reason = resolveInvalidReasonFromRow(row);
    if (reason && s.reasons[reason] !== undefined) {
      s.reasons[reason] += 1;
      s.invalid += 1;
    }
    if (row.answer_seconds != null) s.answerTimes.push(Number(row.answer_seconds));
    bySource.set(key, s);
  }
  return [...bySource.values()]
    .map(({ answerTimes, ...s }) => ({ ...s, medianAnswerSeconds: median(answerTimes) }))
    .sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source));
}

async function loadWeekRows({ start, end, database = db }) {
  return whereNotSandboxCall(database('call_log as cl'), 'cl.source')
    .where('cl.direction', 'inbound')
    .where('cl.created_at', '>=', start)
    .where('cl.created_at', '<', end)
    .select(
      'cl.source', 'cl.to_phone', 'cl.answered_by', 'cl.call_outcome', 'cl.answer_seconds', 'cl.invalid_reason',
      'cl.disposition', 'cl.processing_status', 'cl.lead_quality', 'cl.enrichment_status', 'cl.ai_extraction',
    );
}

/**
 * -> { start, end, totals, sources: [{ source, calls, answeredByPerson, voicemail, invalid,
 *      reasons: { spam, wrong_number, ... }, medianAnswerSeconds }] }
 */
async function weeklyBadCallSummary({ now = new Date(), database = db, loadRows = loadWeekRows } = {}) {
  const { start, end } = reportWindow(now);
  const rows = await loadRows({ start, end, database });
  const sources = summarizeRows(rows);
  const totals = {
    calls: sources.reduce((n, s) => n + s.calls, 0),
    invalid: sources.reduce((n, s) => n + s.invalid, 0),
  };
  return { start, end, totals, sources };
}

const plural = (n, one, many) => (n === 1 ? one : many);

function sourceLine(s) {
  const reasons = INVALID_REASONS.filter((r) => s.reasons[r] > 0).map((r) => `${s.reasons[r]} ${REASON_LABELS[r]}`);
  const answer = s.medianAnswerSeconds == null ? 'no answer time' : `median answer ${s.medianAnswerSeconds} s`;
  return `${sourceLabel(s.source)}: ${s.calls} ${plural(s.calls, 'call', 'calls')}, ${s.answeredByPerson} answered by a person, ${s.voicemail} voicemail, ${s.invalid} bad${reasons.length ? ` (${reasons.join(', ')})` : ''}, ${answer}.`;
}

/** Pure: the summary -> the alert spec and detail, or null when the week had no inbound calls. */
function composeBadCallAlert(summary) {
  if (!summary.totals.calls) return null;
  const { calls, invalid } = summary.totals;
  const detail = [
    `Inbound calls ${shortDateET(summary.start)} to ${shortDateET(new Date(summary.end.getTime() - 1))}, by lead source.`,
    ...summary.sources.map(sourceLine),
  ].join('\n').slice(0, 2000);
  return {
    spec: {
      area: 'Leads',
      action: "review last week's bad calls by lead source",
      why: `${invalid} of ${calls} inbound ${plural(calls, 'call', 'calls')} ${plural(invalid, 'was', 'were')} not a real prospect, across ${summary.sources.length} ${plural(summary.sources.length, 'source', 'sources')}.`,
      severity: 'needs-you',
      link: '/admin/leads',
      subject: { type: 'check', id: SUBJECT_ID },
      doneWhen: 'report_read',
      who: 'person',
    },
    detail,
  };
}

/** Weekly cron entry point. -> { raised, calls, invalid } | { skipped }. A read failure throws, so runExclusive records it. */
async function runWeeklyBadCallAlert({ now = new Date(), summarize = weeklyBadCallSummary, raise = raiseAdminAlert } = {}) {
  const summary = await summarize({ now });
  const composed = composeBadCallAlert(summary);
  if (!composed) return { skipped: 'no_calls', calls: 0, invalid: 0 };
  const result = await raise('system', composed.spec, {
    dedupeKey: `${DEDUPE_PREFIX}:${etDateString(summary.end)}`,
    // GATE_ADMIN_BELL_POLICY drops an admin row that does not ask to ring.
    bell: true,
    detail: composed.detail,
  });
  if (!result) throw new Error('bad-call-count alert was not written');
  const outcome = result.suppressed ? 'suppressed' : (result.deduped ? 'unchanged' : 'raised');
  logger.info(`[bad-call-count] ${summary.totals.calls} call(s), ${summary.totals.invalid} bad (${outcome})`);
  return { raised: outcome === 'raised', outcome, calls: summary.totals.calls, invalid: summary.totals.invalid };
}

module.exports = {
  inboundCallSource,
  stampAnswerSeconds,
  weeklyBadCallSummary,
  runWeeklyBadCallAlert,
  _private: { summarizeRows, composeBadCallAlert, reportWindow, median, sourceLine },
};
