'use strict';
/**
 * SMS scheduling funnel: how many scheduling texts came in, how many were
 * answered by a person, how many were followed by a real schedule change, and
 * how many offers the ledger recorded (sms_offers, GATE_SMS_OFFER_LEDGER).
 *
 * Read-only and counts-only: no message text, name, phone or address leaves
 * this module. It measures completed requests, not replies: a scheduling text
 * counts as completed when that customer's schedule changed within 48 hours
 * (a visit moved, was cancelled or skipped, or a new visit was created). That is
 * "followed by", not "caused by"; the offer ledger is what later ties a change
 * to the text that asked for it.
 */

const { hasSchedulingIntent, hasRescheduleOrAwayIntent } = require('./sms-intent');

const FOLLOW_WINDOW_MS = 48 * 3600000;
// A reply a person typed or approved (never a reminder or another automated text).
const PERSON_REPLY_TYPES = ['manual', 'ai_approved', 'ai_revised'];

function isSchedulingText(body) {
  return Boolean(body) && (hasSchedulingIntent(body) || hasRescheduleOrAwayIntent(body));
}

// The Monday (Eastern) of the week an instant falls in, as YYYY-MM-DD.
function weekOf(instant) {
  const [y, m, d] = new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12));
  const back = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - back);
  return day.toISOString().slice(0, 10);
}

function byCustomer(rows, timeKey) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r.customer_id) continue;
    const t = new Date(r[timeKey]).getTime();
    if (Number.isNaN(t)) continue;
    if (!map.has(r.customer_id)) map.set(r.customer_id, []);
    map.get(r.customer_id).push(t);
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

// The first instant in `times` inside [from, to], or null.
function firstWithin(times, from, to) {
  if (!times) return null;
  for (const t of times) {
    if (t > to) return null;
    if (t >= from) return t;
  }
  return null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// The ledger's rows by kind and state. An offer still marked open past its
// expiry is reported as expired.
function summarizeOffers(offers, { moveTimes, bookingTimes, now }) {
  const nowMs = new Date(now).getTime();
  const out = { sent: offers.length, by_kind: {}, open: 0, expired: 0, superseded: 0, other: 0, with_unresolved_slot: 0, followed_by_change_48h: 0 };
  const stateOf = (o) => {
    if (o.status === 'superseded') return 'superseded';
    if (o.status !== 'open') return 'other';
    return new Date(o.expires_at).getTime() <= nowMs ? 'expired' : 'open';
  };
  for (const o of offers) {
    out.by_kind[o.kind] = (out.by_kind[o.kind] || 0) + 1;
    out[stateOf(o)] += 1;
    const slots = typeof o.slots === 'string' ? JSON.parse(o.slots) : (o.slots || []);
    if (slots.some((s) => !s || !s.date || !s.start)) out.with_unresolved_slot += 1;
    const t0 = new Date(o.sent_at).getTime();
    const until = t0 + FOLLOW_WINDOW_MS;
    const changed = firstWithin(moveTimes.get(o.customer_id), t0, until) !== null
      || firstWithin(bookingTimes.get(o.customer_id), t0, until) !== null;
    if (changed) out.followed_by_change_48h += 1;
  }
  return out;
}

/**
 * Pure. Every argument is a list of rows already limited to the report window
 * (follow-up rows may run 48h past its end).
 *   inbound       [{ customer_id, body, created_at }]
 *   moves         [{ customer_id, created_at }]            reschedule_log, not system
 *   cancels       [{ customer_id, transitioned_at }]       cancelled / skipped
 *   bookings      [{ customer_id, created_at }]            new scheduled_services
 *   personReplies [{ customer_id, created_at }]            outbound, PERSON_REPLY_TYPES
 *   offers        [{ customer_id, kind, status, sent_at, expires_at, slots }] or null (no table)
 */
function summarizeFunnel({ inbound = [], moves = [], cancels = [], bookings = [], personReplies = [], offers = null, now = new Date() } = {}) {
  const flagged = inbound.filter((r) => r.customer_id && isSchedulingText(r.body));
  const moveTimes = byCustomer(moves, 'created_at');
  const cancelTimes = byCustomer(cancels, 'transitioned_at');
  const bookingTimes = byCustomer(bookings, 'created_at');
  const replyTimes = byCustomer(personReplies, 'created_at');

  const perWeek = {};
  const followed = { any: 0, moves: 0, cancels_or_skips: 0, new_bookings: 0 };
  const replyMinutes = [];
  for (const r of flagged) {
    const t0 = new Date(r.created_at).getTime();
    const week = weekOf(t0);
    perWeek[week] = (perWeek[week] || 0) + 1;
    const until = t0 + FOLLOW_WINDOW_MS;
    const moved = firstWithin(moveTimes.get(r.customer_id), t0, until) !== null;
    const cancelled = firstWithin(cancelTimes.get(r.customer_id), t0, until) !== null;
    const booked = firstWithin(bookingTimes.get(r.customer_id), t0, until) !== null;
    if (moved) followed.moves += 1;
    if (cancelled) followed.cancels_or_skips += 1;
    if (booked) followed.new_bookings += 1;
    if (moved || cancelled || booked) followed.any += 1;
    // Strictly after the text: a reply stamped in the same millisecond is not an answer to it.
    const reply = firstWithin(replyTimes.get(r.customer_id), t0 + 1, Number.MAX_SAFE_INTEGER);
    if (reply !== null) replyMinutes.push((reply - t0) / 60000);
  }

  const offerSummary = offers ? summarizeOffers(offers, { moveTimes, bookingTimes, now }) : null;

  const med = median(replyMinutes);
  return {
    inbound_total: inbound.length,
    scheduling_flagged: flagged.length,
    per_week: perWeek,
    followed_within_48h: followed,
    person_replied: replyMinutes.length,
    person_reply_median_minutes: med === null ? null : Math.round(med),
    offers: offerSummary,
  };
}

/** Read the rows for [since, until) and summarise them. `dbh` is a knex handle. */
async function loadFunnel({ since, until = new Date(), dbh = require('../models/db') } = {}) {
  const from = new Date(since);
  const to = new Date(until);
  const followTo = new Date(to.getTime() + FOLLOW_WINDOW_MS);
  const inbound = await dbh('sms_log')
    .where({ direction: 'inbound' }).whereNotNull('customer_id')
    .where('created_at', '>=', from).where('created_at', '<', to)
    .select('customer_id', 'message_body as body', 'created_at');
  const hasOffers = await dbh.schema.hasTable('sms_offers');
  const offers = hasOffers
    ? await dbh('sms_offers').where('sent_at', '>=', from).where('sent_at', '<', to)
      .select('customer_id', 'kind', 'status', 'sent_at', 'expires_at', 'slots')
    : null;
  const customerIds = [...new Set([
    ...inbound.filter((r) => isSchedulingText(r.body)).map((r) => r.customer_id),
    ...(offers || []).map((o) => o.customer_id).filter(Boolean),
  ])];
  if (!customerIds.length) return summarizeFunnel({ inbound, offers, now: to });
  const [moves, cancels, bookings, personReplies] = await Promise.all([
    dbh('reschedule_log').whereIn('customer_id', customerIds).whereNot('initiated_by', 'system')
      .where('created_at', '>=', from).where('created_at', '<=', followTo).select('customer_id', 'created_at'),
    dbh('job_status_history as h').join('scheduled_services as s', 's.id', 'h.job_id')
      .whereIn('s.customer_id', customerIds).whereIn('h.to_status', ['cancelled', 'skipped'])
      .where('h.transitioned_at', '>=', from).where('h.transitioned_at', '<=', followTo)
      .select('s.customer_id', 'h.transitioned_at'),
    dbh('scheduled_services').whereIn('customer_id', customerIds)
      .where('created_at', '>=', from).where('created_at', '<=', followTo).select('customer_id', 'created_at'),
    dbh('sms_log').where({ direction: 'outbound' }).whereIn('customer_id', customerIds).whereIn('message_type', PERSON_REPLY_TYPES)
      .where('created_at', '>=', from).select('customer_id', 'created_at'),
  ]);
  return summarizeFunnel({ inbound, moves, cancels, bookings, personReplies, offers, now: to });
}

module.exports = { loadFunnel, summarizeFunnel, isSchedulingText, weekOf, PERSON_REPLY_TYPES, FOLLOW_WINDOW_MS };
