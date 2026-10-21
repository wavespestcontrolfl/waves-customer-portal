/**
 * Missed-call admin alert detail (GATE_MISSED_CALL_ALERT_DETAIL, owner
 * "ALL" 2026-10-20). Admin bell and push only: nothing here reaches a
 * customer.
 *
 * Today the customer_missed_call body reads "<phone> called and did not
 * leave a voicemail." With the gate on, the office also sees which line the
 * caller dialed, how long they stayed on, and (for a customer on file) the
 * date of their next visit, so the first glance at the push says whether to
 * call back now.
 *
 * Two halves, kept apart so the gate-off alert stays byte-identical:
 *   detailPayload(row)      producer side (missed-call-bell.js): the extra
 *                           payload fields, or {} with the gate off.
 *   formatMissedCallBody(p) copy side (the trigger's build()): the body from
 *                           the payload; it falls back to the original line
 *                           when the payload carries none of the new fields.
 */
const db = require('../models/db');
const logger = require('./logger');

const NOT_UPCOMING = ['cancelled', 'completed', 'rescheduled'];
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
      .whereNotIn('status', NOT_UPCOMING)
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
 * The extra payload fields for one call_log row. {} with the gate off, so the
 * stored payload (and the copy built from it) is today's, byte for byte.
 */
async function detailPayload(row, now = new Date()) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('missedCallAlertDetail')) return {};
  const out = {};
  const line = shortLineLabel(parseMeta(row?.metadata).location);
  if (line) out.line = line;
  const seconds = row?.duration_seconds == null ? NaN : Number(row.duration_seconds);
  if (Number.isFinite(seconds) && seconds >= 0) out.durationSeconds = Math.round(seconds);
  const next = await nextVisitDate(row?.customer_id, now);
  if (next) out.nextVisitDate = next;
  return out;
}

/** True when the payload carries any of the gate-on fields. */
function hasDetail(p) {
  return Boolean(p) && (p.line != null || p.durationSeconds != null || p.nextVisitDate != null);
}

/**
 * Body for the customer_missed_call trigger. Without detail fields it is the
 * original sentence, character for character.
 */
function formatMissedCallBody(p = {}) {
  const phone = p.phone || 'unknown number';
  if (!hasDetail(p)) return `${phone} called and did not leave a voicemail.`;
  const where = p.line ? ` ${p.line}` : '';
  const secs = Number.isFinite(Number(p.durationSeconds)) && p.durationSeconds != null
    ? `, ${Math.round(Number(p.durationSeconds))} sec` : '';
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
