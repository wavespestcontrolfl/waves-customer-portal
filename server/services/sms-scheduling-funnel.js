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
 * The shadow decide step's rows (sms_offer_decisions) and how its would-move
 * calls compare with what actually happened. A would-move is scored only once
 * its 48h window has closed (by `observedAt`), and only against a logged move
 * of that visit INTO the named time inside that window (`movesByVisit`:
 * visit id → reschedule_log rows { created_at, new_date, new_window }), so a
 * past report never changes as the calendar moves on. A move made in the
 * admin Edit form logs nothing and counts as unmatched (the report says so).
 */
// reschedule_log.initiated_by values for moves no person asked for.
// 'sms_offer_ai' is the move executor acting on a decision
// (sms-scheduling-act.js): its own move is not a person confirming it.
const AUTOMATIC_MOVE_INITIATORS = Object.freeze(['system', 'machine', 'auto_dispatch', 'weather_auto', 'admin_bulk', 'sms_offer_ai']);

// A logged move of `visitId` into date + start, inside [t0, t0 + 48h].
function movedInto(movesByVisit, visitId, t0, date, start) {
  return (movesByVisit.get(String(visitId || '')) || []).some((m) => {
    const t = new Date(m.created_at).getTime();
    const mStart = String(m.new_window || '').split('-')[0].slice(0, 5).padStart(5, '0');
    const mDate = m.new_date instanceof Date ? m.new_date.toISOString().slice(0, 10) : String(m.new_date || '').slice(0, 10);
    return t >= t0 && t <= t0 + FOLLOW_WINDOW_MS && mDate === date && mStart === start;
  });
}

/**
 * Recall, the exit bar's other half: of the visit-move offers whose 48h has
 * closed and whose visit was then moved INTO one of the offered times inside
 * that window (a real accept, whoever acted on it), how many got a would-move
 * decision for that same time. Precision (summarizeDecisions) alone would let
 * a step that sends almost every real accept to staff look perfect.
 */
function summarizeRecall(offers, decisions, movesByVisit = new Map(), observedAt = new Date()) {
  const observedMs = new Date(observedAt).getTime();
  const byOffer = new Map();
  for (const d of decisions) {
    if (!d.sms_offer_id) continue;
    if (!byOffer.has(String(d.sms_offer_id))) byOffer.set(String(d.sms_offer_id), []);
    byOffer.get(String(d.sms_offer_id)).push(d);
  }
  // One real accept per actual move into an offered time (an offer replaced
  // by one carrying the same time is still one accept). It counts as caught
  // when ANY offer that carried that time before the move got a would-move
  // for it, decided before the move happened.
  const accepts = new Map();
  for (const o of offers) {
    if (o.kind !== 'move_visit' || !o.scheduled_service_id) continue;
    const t0 = new Date(o.sent_at).getTime();
    if (t0 + FOLLOW_WINDOW_MS > observedMs) continue;
    const slots = typeof o.slots === 'string' ? JSON.parse(o.slots) : (o.slots || []);
    for (const m of movesByVisit.get(String(o.scheduled_service_id)) || []) {
      const t = new Date(m.created_at).getTime();
      const slot = slots.find((sl) => sl?.date && sl?.start && movedInto(new Map([[String(o.scheduled_service_id), [m]]]), o.scheduled_service_id, t0, sl.date, sl.start));
      if (!slot) continue;
      const key = `${o.scheduled_service_id}|${t}`;
      if (!accepts.has(key)) accepts.set(key, { at: t, slot, offers: [] });
      accepts.get(key).offers.push(o);
    }
  }
  const out = { real_accepts: accepts.size, caught: 0 };
  for (const { at, slot, offers: carriers } of accepts.values()) {
    const hit = carriers.some((offer) => (byOffer.get(String(offer.id)) || []).some((d) => {
      if (d.outcome !== 'would_move') return false;
      // The reply (not the classifier's row) must precede the move.
      const repliedAt = d.replied_at || d.created_at;
      if (repliedAt && new Date(repliedAt).getTime() > at) return false;
      const would = typeof d.would_have === 'string' ? JSON.parse(d.would_have) : (d.would_have || {});
      return would.date === slot.date && would.start === slot.start;
    }));
    if (hit) out.caught += 1;
  }
  return out;
}

function summarizeDecisions(decisions, movesByVisit = new Map(), observedAt = new Date()) {
  const observedMs = new Date(observedAt).getTime();
  const out = { total: decisions.length, move_offers_decided: 0, by_outcome: {}, by_action: {}, refusals: {}, would_move_matured: 0, would_move_matched: 0, would_move_unmatched: 0, executed: {} };
  // The exit bar's sample: distinct visit-move offers with a real decision
  // (several texts on one offer, booking offers and errors do not add to it).
  out.move_offers_decided = new Set(decisions
    .filter((d) => d.offer_kind === 'move_visit' && d.outcome !== 'error' && d.sms_offer_id)
    .map((d) => String(d.sms_offer_id))).size;
  for (const d of decisions) {
    out.by_outcome[d.outcome] = (out.by_outcome[d.outcome] || 0) + 1;
    if (d.action) out.by_action[d.action] = (out.by_action[d.action] || 0) + 1;
    const refusals = typeof d.refusals === 'string' ? JSON.parse(d.refusals) : (d.refusals || []);
    for (const r of refusals) out.refusals[r] = (out.refusals[r] || 0) + 1;
    if (d.outcome !== 'would_move') continue;
    // A decision the executor took (moved, refused, failed, or still claimed)
    // is counted on its own: staff had no call to make or confirm, so it is
    // not scored against what staff did.
    if (d.execution_status) {
      out.executed[d.execution_status] = (out.executed[d.execution_status] || 0) + 1;
      if (d.execution_status === 'moved') continue;
    }
    // From the reply's arrival: staff can act before the classifier's row lands.
    const t0 = new Date(d.replied_at || d.created_at).getTime();
    if (t0 + FOLLOW_WINDOW_MS > observedMs) continue;
    out.would_move_matured += 1;
    const would = typeof d.would_have === 'string' ? JSON.parse(d.would_have) : (d.would_have || {});
    if (movedInto(movesByVisit, would.scheduled_service_id, t0, would.date, would.start)) out.would_move_matched += 1;
    else out.would_move_unmatched += 1;
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
function summarizeFunnel({ inbound = [], moves = [], cancels = [], bookings = [], offers = null, decisions = null, offerDecisions = null, movesByVisit = new Map(), now = new Date(), observedAt = now } = {}) {
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
    decisions: decisions ? { ...summarizeDecisions(decisions, movesByVisit, observedAt), recall: summarizeRecall(offers || [], offerDecisions || decisions, movesByVisit, observedAt) } : null,
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

// A decision with the moment its text ARRIVED (replied_at: scoring starts
// there, not when the detached classifier finished) and its offer's kind.
function decisionRows(dbh) {
  return dbh('sms_offer_decisions as d')
    .leftJoin('sms_log as sl', 'sl.id', 'd.inbound_sms_log_id')
    .leftJoin('sms_offers as o', 'o.id', 'd.sms_offer_id')
    .select('d.sms_offer_id', 'd.action', 'd.outcome', 'd.refusals', 'd.would_have', 'd.created_at', 'd.execution_status',
      'sl.created_at as replied_at', 'o.kind as offer_kind');
}

// The logged moves of every visit a would-move named or a visit-move offer
// was for, from the earliest of those on.
async function loadMovesForScoring(dbh, decisions, offers) {
  const ids = new Set();
  let first = Infinity;
  for (const d of decisions) {
    if (d.outcome !== 'would_move') continue;
    const would = typeof d.would_have === 'string' ? JSON.parse(d.would_have) : (d.would_have || {});
    if (would.scheduled_service_id) ids.add(String(would.scheduled_service_id));
    first = Math.min(first, new Date(d.replied_at || d.created_at).getTime());
  }
  for (const o of offers) {
    if (o.kind !== 'move_visit' || !o.scheduled_service_id) continue;
    ids.add(String(o.scheduled_service_id));
    first = Math.min(first, new Date(o.sent_at).getTime());
  }
  if (!ids.size) return new Map();
  // Only moves that can be someone's answer to an offer: the system's own
  // placements (weather, auto-dispatch, bulk and machine moves) are not.
  const rows = await dbh('reschedule_log').whereIn('scheduled_service_id', [...ids])
    .where('created_at', '>=', new Date(first))
    .where((q) => q.whereNull('initiated_by').orWhereNotIn('initiated_by', AUTOMATIC_MOVE_INITIATORS))
    .select('scheduled_service_id', 'created_at', 'new_date', 'new_window');
  const map = new Map();
  for (const r of rows) {
    const key = String(r.scheduled_service_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
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
  const hasDecisions = await dbh.schema.hasTable('sms_offer_decisions');
  const decisions = hasDecisions
    // By the reply's arrival, the moment scoring starts from: a reply near a
    // period's end belongs to that period even when its row landed in the next.
    ? await decisionRows(dbh).whereRaw('COALESCE(sl.created_at, d.created_at) >= ?', [from]).whereRaw('COALESCE(sl.created_at, d.created_at) < ?', [to])
    : null;
  const hasOffers = await dbh.schema.hasTable('sms_offers');
  const offers = hasOffers
    ? await dbh('sms_offers').where('sent_at', '>=', from).where('sent_at', '<', to)
      .select('id', 'customer_id', 'kind', 'scheduled_service_id', 'status', 'sent_at', 'expires_at', 'closed_at', 'slots')
    : null;
  // Recall follows each offer in the window to its decisions, wherever they
  // fall in time (a reply can land after the report's end).
  const offerDecisions = (hasDecisions && offers?.length)
    ? await decisionRows(dbh).whereIn('d.sms_offer_id', offers.map((o) => o.id))
    : [];
  const movesByVisit = await loadMovesForScoring(dbh, decisions || [], offers || []);
  const customerIds = [...new Set([
    ...inbound.filter((r) => isSchedulingText(r.body)).map((r) => r.customer_id),
    ...(offers || []).map((o) => o.customer_id).filter(Boolean),
  ])];
  if (!customerIds.length) return summarizeFunnel({ inbound, offers, decisions, offerDecisions, movesByVisit, now: to, observedAt });
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
  return summarizeFunnel({ inbound, moves, cancels, bookings, offers, decisions, offerDecisions, movesByVisit, now: to, observedAt });
}

module.exports = { loadFunnel, summarizeFunnel, summarizeDecisions, summarizeRecall, AUTOMATIC_MOVE_INITIATORS, parseReportInstant, formatReportDate, isSchedulingText, weekOf, FOLLOW_WINDOW_MS };
