/**
 * Missed-call admin alert detail (owner "ALL" 2026-10-20). Admin bell and
 * push only: nothing here reaches a customer.
 *
 * The customer_missed_call body names which line the caller dialed, how long
 * they stayed on, and (for a customer on file) the date of their next visit,
 * so the first glance at the push says whether to call back now. A call with
 * none of those fields keeps the original sentence ("<phone> called and did
 * not leave a voicemail.").
 *
 * Two halves:
 *   detailPayload(row)      producer side (missed-call-bell.js): the extra
 *                           payload fields.
 *   formatMissedCallBody(p) copy side (the trigger's build()): the body from
 *                           the payload; it falls back to the original line
 *                           when the payload carries none of the detail fields.
 */
const db = require('../models/db');
const logger = require('./logger');
const { callDurationSeconds } = require('../utils/call-timeline');

// Live visits only (the repo's LIVE_VISIT_STATUSES): a skipped or other
// terminal row must never show as the next visit (pre-push audit).
const UPCOMING = ['pending', 'confirmed'];
const MAX_LINE_CHARS = 26;

function parseMeta(meta) {
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return meta && typeof meta === 'object' ? meta : {};
}

// "Lakewood Ranch GBP — Bradenton office (Pest)" -> "Bradenton office (Pest)";
// cut at a word so the push body keeps to about two lines. 'unknown' is the
// webhook's placeholder for a number it does not recognize: not a line name.
function shortLineLabel(raw) {
  const text = String(raw || '').replace(/^.*\bGBP\s*[—-]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!text || /^unknown$/i.test(text)) return null;
  if (text.length <= MAX_LINE_CHARS) return text;
  const cut = text.slice(0, MAX_LINE_CHARS + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 8 ? cut.slice(0, space) : text.slice(0, MAX_LINE_CHARS)).trim();
}

// 'YYYY-MM-DD' -> "Thu Oct 22" (a date a person would say, no ISO text).
function visitDayLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '');
}

/**
 * Earliest upcoming (today or later, ET) visit for a customer that is not
 * cancelled, completed or rescheduled, as 'YYYY-MM-DD'. Null when none or on
 * any read failure: the alert never waits on this.
 */
async function nextVisitDate(customerId, now = new Date()) {
  if (!customerId) return null;
  try {
    const { etDateString, dateOnlyString } = require('../utils/datetime-et');
    const row = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', UPCOMING)
      .where('scheduled_date', '>=', etDateString(now))
      .orderBy('scheduled_date', 'asc')
      .first('scheduled_date');
    return row ? (dateOnlyString(row.scheduled_date) || null) : null;
  } catch (err) {
    logger.warn(`[missed-call-alert-detail] next visit lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * The extra payload fields for one call_log row: the line, the call length and
 * the next visit date, each only when known.
 */
async function detailPayload(row, now = new Date()) {
  const out = {};
  const line = shortLineLabel(parseMeta(row?.metadata).location);
  if (line) out.line = line;
  // Only positive seconds: a stored 0 means "not reported yet", not a 0-second call.
  const seconds = callDurationSeconds(row);
  if (seconds > 0) out.durationSeconds = Math.round(seconds);
  const next = await nextVisitDate(row?.customer_id, now);
  if (next) out.nextVisitDate = next;
  return out;
}

/** True when the payload carries any detail field. */
function hasDetail(p) {
  return Boolean(p) && (p.line != null || Number(p.durationSeconds) > 0 || p.nextVisitDate != null);
}

/**
 * Body for the customer_missed_call trigger. Without detail fields it is the
 * original sentence, character for character.
 */
function formatMissedCallBody(p = {}) {
  const phone = p.phone || 'unknown number';
  if (!hasDetail(p)) return `${phone} called and did not leave a voicemail.`;
  const where = p.line ? ` ${p.line}` : '';
  const secs = Number(p.durationSeconds) > 0 ? `, ${Math.round(Number(p.durationSeconds))} sec` : '';
  const day = visitDayLabel(p.nextVisitDate);
  return `${phone} called${where}${secs}, no voicemail.${day ? ` Next visit ${day}.` : ''}`;
}

module.exports = {
  detailPayload,
  formatMissedCallBody,
  nextVisitDate,
  shortLineLabel,
  visitDayLabel,
  hasDetail,
};
