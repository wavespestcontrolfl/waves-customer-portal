'use strict';
/**
 * SMS scheduling funnel: how many scheduling texts came in, how many were
 * followed by a real schedule change, and how many offers the ledger
 * recorded (sms_offers, GATE_SMS_OFFER_LEDGER).
 *
 * Read-only and counts-only: no message text, name, phone or address leaves
 * this module. It measures completed requests, not replies: a scheduling text
 * counts as completed when that customer's schedule changed within 48 hours
 * (a visit moved, was cancelled or skipped, or a new visit was created). That is
 * "followed by", not "caused by"; the offer ledger is what later ties a change
 * to the text that asked for it.
 *
 * Moves are what reschedule_log records: the rebooker, the reschedule link,
 * the reminder reply, dispatch and the call pipeline. A date changed in the
 * admin Edit appointment form writes no move row, so those moves are NOT
 * counted here and the report says so. The AI moves this lane adds go through
 * the rebooker and are logged, so the after-number is not short.
 */

const { hasSchedulingIntent, hasRescheduleOrAwayIntent, isSmsReaction } = require('./sms-intent');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');

const FOLLOW_WINDOW_MS = 48 * 3600000;
// No reply-time metric on purpose: whether an outbound answered a given
// inbound needs the inbox's own linkage (sms-response-policy outboundIsAnswer,
// click follow-ups, parallel threads). The before-number for reply time is
// the 2026-10-02 owner baseline; the after-number this lane needs (accept to
// committed row) comes from sms_offers once offers are executed.

function isSchedulingText(body) {
  // A tapback ("Liked “Your appointment is tomorrow…”") quotes our own
  // scheduling words; it is not a request (the webhook drops it the same way).
  return Boolean(body) && !isSmsReaction(body) && (hasSchedulingIntent(body) || hasRescheduleOrAwayIntent(body));
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

// The ledger's rows by kind and state. An offer still marked open past its
// expiry is reported as expired.
function summarizeOffers(offers, { moveTimes, bookingTimes, now, observedAt }) {
  const nowMs = new Date(now).getTime();
  const observedMs = new Date(observedAt).getTime();
  const out = { sent: offers.length, by_kind: {}, open: 0, expired: 0, superseded: 0, other: 0, with_unresolved_slot: 0, matured: 0, followed_by_change_48h: 0 };
  // State as of the report's end: a supersede that happened after it (a
  // later offer) must not rewrite a past report.
  const stateOf = (o) => {
    if (o.status === 'superseded' && (!o.closed_at || new Date(o.closed_at).getTime() <= nowMs)) return 'superseded';
    if (o.status === 'superseded') return new Date(o.expires_at).getTime() <= nowMs ? 'expired' : 'open';
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
    if (until > observedMs) continue;
    out.matured += 1;
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
 *   offers        [{ customer_id, kind, status, sent_at, expires_at, closed_at, slots }] or null (no table)
 *   now           the report end (offer state is as of then)
 *   observedAt    the moment the follow-up rows were read (default: now).
 *                 Only texts whose 48h window closed by then are "matured";
 *                 the change rate is over matured texts, so a text from the
 *                 last two days never counts as not followed before it could be.
 */
function summarizeFunnel({ inbound = [], moves = [], cancels = [], bookings = [], offers = null, now = new Date(), observedAt = now } = {}) {
  const observedMs = new Date(observedAt).getTime();
  const flagged = inbound.filter((r) => r.customer_id && isSchedulingText(r.body));
  const moveTimes = byCustomer(moves, 'created_at');
  const cancelTimes = byCustomer(cancels, 'transitioned_at');
  const bookingTimes = byCustomer(bookings, 'created_at');

  const perWeek = {};
  const followed = { any: 0, moves: 0, cancels_or_skips: 0, new_bookings: 0 };
  let matured = 0;
  for (const r of flagged) {
    const t0 = new Date(r.created_at).getTime();
    const week = weekOf(t0);
    perWeek[week] = (perWeek[week] || 0) + 1;
    const until = t0 + FOLLOW_WINDOW_MS;
    if (until > observedMs) continue;
    matured += 1;
    const moved = firstWithin(moveTimes.get(r.customer_id), t0, until) !== null;
    const cancelled = firstWithin(cancelTimes.get(r.customer_id), t0, until) !== null;
    const booked = firstWithin(bookingTimes.get(r.customer_id), t0, until) !== null;
    if (moved) followed.moves += 1;
    if (cancelled) followed.cancels_or_skips += 1;
    if (booked) followed.new_bookings += 1;
    if (moved || cancelled || booked) followed.any += 1;
  }

  const offerSummary = offers ? summarizeOffers(offers, { moveTimes, bookingTimes, now, observedAt }) : null;

  return {
    inbound_total: inbound.length,
    scheduling_flagged: flagged.length,
    scheduling_matured: matured,
    per_week: perWeek,
    followed_within_48h: followed,
    offers: offerSummary,
  };
}

/** A report boundary as its Eastern calendar date (the report's own day). */
function formatReportDate(instant) {
  return etDateString(new Date(instant));
}

/**
 * A report boundary from the command line: "14d" (that many days before now),
 * a bare YYYY-MM-DD (Eastern midnight, matching the Eastern weeks), or any
 * other instant Date can read. `fallback` when the flag is absent.
 */
function parseReportInstant(value, fallback, now = new Date()) {
  if (value === undefined || value === true) return fallback;
  const days = /^(\d{1,3})d$/.exec(String(value));
  if (days) return new Date(new Date(now).getTime() - Number(days[1]) * 86400000);
  const text = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00` : String(value);
  const parsed = parseETDateTime(text);
  // Date rolls an impossible day over (2026-02-30 → March 2); refuse it.
  const bareDate = text !== String(value);
  if (Number.isNaN(parsed.getTime()) || (bareDate && etDateString(parsed) !== String(value))) throw new Error(`cannot read the date "${value}" (use 14d or YYYY-MM-DD)`);
  return parsed;
}

/** Read the rows for [since, until) and summarise them. `dbh` is a knex handle. */
async function loadFunnel({ since, until = new Date(), dbh = require('../models/db') } = {}) {
  const from = new Date(since);
  const to = new Date(until);
  const followTo = new Date(to.getTime() + FOLLOW_WINDOW_MS);
  // Follow-up rows exist only up to the moment they are read.
  const observedAt = new Date(Math.min(Date.now(), followTo.getTime()));
  const inbound = await dbh('sms_log')
    .where({ direction: 'inbound' }).whereNotNull('customer_id')
    .where('created_at', '>=', from).where('created_at', '<', to)
    .select('customer_id', 'message_body as body', 'created_at');
  const hasOffers = await dbh.schema.hasTable('sms_offers');
  const offers = hasOffers
    ? await dbh('sms_offers').where('sent_at', '>=', from).where('sent_at', '<', to)
      .select('customer_id', 'kind', 'status', 'sent_at', 'expires_at', 'closed_at', 'slots')
    : null;
  const customerIds = [...new Set([
    ...inbound.filter((r) => isSchedulingText(r.body)).map((r) => r.customer_id),
    ...(offers || []).map((o) => o.customer_id).filter(Boolean),
  ])];
  if (!customerIds.length) return summarizeFunnel({ inbound, offers, now: to, observedAt });
  const [moves, cancels, bookings] = await Promise.all([
    dbh('reschedule_log').whereIn('customer_id', customerIds).whereNot('initiated_by', 'system')
      .where('created_at', '>=', from).where('created_at', '<=', followTo).select('customer_id', 'created_at'),
    dbh('job_status_history as h').join('scheduled_services as s', 's.id', 'h.job_id')
      .whereIn('s.customer_id', customerIds).whereIn('h.to_status', ['cancelled', 'skipped'])
      .where('h.transitioned_at', '>=', from).where('h.transitioned_at', '<=', followTo)
      .select('s.customer_id', 'h.transitioned_at'),
    dbh('scheduled_services').whereIn('customer_id', customerIds)
      .where('created_at', '>=', from).where('created_at', '<=', followTo).select('customer_id', 'created_at'),
  ]);
  return summarizeFunnel({ inbound, moves, cancels, bookings, offers, now: to, observedAt });
}

module.exports = { loadFunnel, summarizeFunnel, parseReportInstant, formatReportDate, isSchedulingText, weekOf, FOLLOW_WINDOW_MS };
