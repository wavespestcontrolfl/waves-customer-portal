'use strict';
/**
 * SMS offer ledger (GATE_SMS_OFFER_LEDGER, dark): a durable record of the
 * appointment times a Waves text actually offered.
 *
 * The drafter already persists what a DRAFT quoted (agent_decisions.
 * input_snapshot.open_times_snapshot) and every send seam rechecks it. What was
 * missing is the record of what was SENT: which (date, window) pairs survived
 * into the text the customer received, for which job, and until when the offer
 * stands. A later slice matches the customer's reply against this row; this
 * slice only writes it and counts it (scripts/sms-scheduling-funnel.js).
 *
 * recordOfferForSend runs after the provider accepted the text. It never
 * throws and never sends: the message is already out, and a ledger miss must
 * not turn an accepted send into a failure.
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');

const OFFER_TTL_HOURS = 48;
// How far ahead a day label is searched for its calendar date. The pickers
// offer weeks, not months; the label carries no year, so the search must stay
// well under a year to remain unambiguous.
const LABEL_SEARCH_DAYS = 180;

// snapshot.lookup.source (sms-shadow-drafter *_OFFER_SOURCE) → what accepting
// the offer would do. A snapshot with no source predates the scheduler-backed
// offers: it is counted, and never actionable.
const KIND_BY_SOURCE = Object.freeze({ scheduler: 'move_visit', estimate: 'book_estimate', book: 'book_new' });

/** GATE_SMS_OFFER_LEDGER, read at call time: a flip needs no redeploy. */
function offerLedgerLive() {
  return gateEnvValue('GATE_SMS_OFFER_LEDGER');
}

// The canonical identity of a US number (its ten digits). An international
// number is not recorded: its last ten digits could collide with a US
// number, and the decide step would then mix two conversations.
function phoneLast10(value) {
  const key = require('../utils/phone').phoneIdentityKey(String(value || ''));
  return key && !key.startsWith('+') ? key : null;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function etDateOf(instant) {
  // en-CA renders YYYY-MM-DD.
  return new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The calendar date a day label ("Tuesday, September 29") names: the first day
 * on or after the send date (Eastern) that the drafter's own label function
 * renders to exactly that text. Rendering forward and comparing keeps this an
 * exact inverse of the label, with no date parsing. null when nothing matches.
 */
function isoDateForLabel(label, sentAt, dayLabel) {
  const want = String(label || '').trim();
  if (!want) return null;
  const [y, m, d] = etDateOf(sentAt).split('-').map(Number);
  for (let i = 0; i <= LABEL_SEARCH_DAYS; i += 1) {
    const iso = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0)).toISOString().slice(0, 10);
    if (dayLabel({ date: iso }) === want) return iso;
  }
  return null;
}

/**
 * The arrival window a window label ("9:00 AM - 11:00 AM") names, as
 * { start, end } in HH:MM. Same forward-render rule: every quarter-hour start
 * is rendered through the helpers the offer itself was rendered with.
 */
function windowForLabel(label) {
  const want = String(label || '').trim();
  if (!want) return null;
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    const start = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const range = arrivalWindowRange(start);
    if (range && formatSmsTimeRange(range) === want) return { start, end: range.split('-')[1] };
  }
  return null;
}

/**
 * Pure: the ledger row for one accepted send, or { skip: reason }.
 *   decision       { id, customer_id, suggested_message, input_snapshot }
 *   outgoingBody   the body the send checks approved (before link rewriting)
 * Which pairs count is decided by the SAME planOpenTimesRecheck verdict the
 * send-time check used on this body: an unedited reply keeps the pairs whose
 * window text is still present, an edited one keeps only pairs whose drafted
 * offer span survived verbatim.
 */
function buildOfferRow({ decision, outgoingBody, providerMessageId = null, to, sentAt = new Date(), ignoreLinks = false, drafter = require('./sms-shadow-drafter') }) {
  const snapshot = parseJson(decision?.input_snapshot)?.open_times_snapshot || null;
  if (!snapshot?.quotedWindows?.length) return { skip: 'no_offer_snapshot' };
  const phone = phoneLast10(to);
  if (!phone) return { skip: 'no_phone' };
  // The backfill reads the LOGGED body, whose portal links the send step may
  // have rewritten to short links; offered times never sit inside a link, so
  // both sides are compared with links removed.
  const plan = drafter.planOpenTimesRecheck({
    snapshot,
    outgoingBody: ignoreLinks ? withoutLinks(outgoingBody) : outgoingBody,
    originalBody: ignoreLinks ? withoutLinks(decision.suggested_message) : decision.suggested_message,
  });
  if (plan.action === 'refuse') return { skip: 'offer_text_unverifiable' };
  if (plan.action !== 'recheck' || !plan.quotedWindows?.length) return { skip: 'no_offer_in_sent_text' };
  const sent = new Date(sentAt);
  return {
    row: {
      agent_decision_id: decision.id,
      provider_message_id: providerMessageId || null,
      phone_last10: phone,
      ...offerIdentity(snapshot.lookup || {}, decision),
      slots: JSON.stringify(plan.quotedWindows.map((w) => resolveSlot(w, sent, drafter.schedulerDayLabel))),
      sent_at: sent,
      expires_at: new Date(sent.getTime() + OFFER_TTL_HOURS * 3600000),
      status: 'open',
    },
  };
}

// A body with every link token (with or without a scheme, including /l/
// short links) removed and spacing collapsed.
const LINK_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi;
function withoutLinks(body) {
  return String(body || '').replace(LINK_RE, '').replace(/[ \t]+/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}

// Which job the offer is for. Only the id its own kind commits through is
// kept: a visit offer its visit, a new-visit offer its /book service key.
function offerIdentity(lookup, decision) {
  const source = lookup.source || (lookup.scheduledServiceId ? 'scheduler' : null);
  const kind = KIND_BY_SOURCE[source] || 'unknown';
  return {
    customer_id: lookup.customerId || decision.customer_id || null,
    kind,
    scheduled_service_id: kind === 'move_visit' ? (lookup.scheduledServiceId || null) : null,
    estimate_id: lookup.estimateId || null,
    service_key: kind === 'book_new' ? (lookup.serviceKey || null) : null,
  };
}

// One quoted (date, window) pair as a slot: the labels as sent, plus the
// calendar date and times they name (null when a label cannot be read back).
function resolveSlot(pair, sentAt, dayLabel) {
  const window = windowForLabel(pair.window);
  return {
    date_label: pair.date,
    window_label: pair.window,
    date: isoDateForLabel(pair.date, sentAt, dayLabel),
    start: window ? window.start : null,
    end: window ? window.end : null,
  };
}

/**
 * Rebuild one phone+kind+line chain of standing offers (open or superseded; any
 * later status, such as accepted, is final and left alone) in send order.
 * Demotes before promoting so the one-open index never sees two open rows.
 * Returns how many previously open rows were demoted and the open row's id.
 */
async function relinkOfferChain(trx, phone, kind, line = null) {
  const chain = await trx('sms_offers')
    .where({ phone_last10: phone, kind })
    // Per Waves line: a same-kind offer from another line is its own chain
    // (sms_offers_one_open_per_phone_kind_line).
    .whereRaw("COALESCE(waves_line, '') = ?", [line || ''])
    .whereIn('status', ['open', 'superseded'])
    .orderBy([{ column: 'sent_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('id', 'status', 'sent_at', 'superseded_by', 'closed_at');
  let demoted = 0;
  for (let i = 0; i < chain.length - 1; i += 1) {
    const cur = chain[i];
    const next = chain[i + 1];
    const closedAt = new Date(next.sent_at);
    const same = cur.status === 'superseded' && cur.superseded_by === next.id
      && cur.closed_at && new Date(cur.closed_at).getTime() === closedAt.getTime();
    if (same) continue;
    if (cur.status === 'open') demoted += 1;
    await trx('sms_offers').where({ id: cur.id })
      .update({ status: 'superseded', superseded_by: next.id, closed_at: closedAt, updated_at: trx.fn.now() });
  }
  const last = chain[chain.length - 1];
  if (last && last.status !== 'open') {
    await trx('sms_offers').where({ id: last.id })
      .update({ status: 'open', superseded_by: null, closed_at: null, updated_at: trx.fn.now() });
  }
  return { demoted, openId: last ? last.id : null };
}

function hhmmOf(value) {
  const m = value == null ? null : String(value).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : null;
}

function lineIdentity(value) {
  return value ? require('../utils/phone').phoneIdentityKey(String(value)) : null;
}

/**
 * Read by the send step just BEFORE the provider handoff, for a decision send
 * whose offer is a visit move: the visit as the offer describes it. Gate off,
 * or anything else, null. Never throws (a miss only means the decide step will
 * refuse that offer's accepts).
 */
async function captureOfferVisitSnapshot({ agentDecisionId, dbh = db } = {}) {
  if (!agentDecisionId || !offerLedgerLive()) return null;
  try {
    const decision = await dbh('agent_decisions').where({ id: agentDecisionId }).first('input_snapshot');
    const lookup = parseJson(decision?.input_snapshot)?.open_times_snapshot?.lookup || {};
    const source = lookup.source || (lookup.scheduledServiceId ? 'scheduler' : null);
    if (source !== 'scheduler' || !lookup.scheduledServiceId) return null;
    return { ...(await visitSnapshot(dbh, lookup.scheduledServiceId)), scheduled_service_id: lookup.scheduledServiceId, pre_send: true };
  } catch (err) {
    logger.warn(`[sms-offers] pre-send visit snapshot skipped: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return null;
  }
}

/** The visit's date, window and status now; null fields when it is gone. */
async function visitSnapshot(dbh, scheduledServiceId) {
  const v = await dbh('scheduled_services').where({ id: scheduledServiceId })
    .first('scheduled_date', 'window_start', 'window_end', 'status', 'updated_at');
  const date = v?.scheduled_date instanceof Date ? v.scheduled_date.toISOString().slice(0, 10) : (v?.scheduled_date ? String(v.scheduled_date).slice(0, 10) : null);
  // updated_at lets the decide step refuse a snapshot that may hold an edit
  // made around the send (after the text went out, before this read).
  return {
    date, start: hhmmOf(v?.window_start), end: hhmmOf(v?.window_end), status: v?.status || null,
    updated_at: v?.updated_at ? new Date(v.updated_at).toISOString() : null, taken_at: new Date().toISOString(),
  };
}

/**
 * Record the offer an accepted send carried. Idempotent per decision; a newer
 * offer to the same phone for the same kind supersedes the open one. Returns
 * { recorded: true, id } or { recorded: false, reason } and never throws.
 */
async function recordOfferForSend({ agentDecisionId, outgoingBody, providerMessageId = null, to, from = null, sentAt = new Date(), ignoreLinks = false, preSendVisitSnapshot = null, dbh = db } = {}) {
  if (!offerLedgerLive()) return { recorded: false, reason: 'gate_off' };
  if (!agentDecisionId) return { recorded: false, reason: 'no_decision' };
  try {
    const decision = await dbh('agent_decisions').where({ id: agentDecisionId })
      .first('id', 'customer_id', 'suggested_message', 'input_snapshot');
    if (!decision) return { recorded: false, reason: 'decision_not_found' };
    const built = buildOfferRow({ decision, outgoingBody, providerMessageId, to, sentAt, ignoreLinks });
    if (built.skip) return { recorded: false, reason: built.skip };
    const { row } = built;
    // A visit-move offer keeps the visit as it stood just BEFORE the send
    // (read by the send step, captureOfferVisitSnapshot), so the decide step
    // can tell whether it changed after the offer went out. With none (a
    // backfilled offer), the visit is read now and marked post-send: the
    // decide step never treats that as the offered state.
    if (row.kind === 'move_visit' && row.scheduled_service_id) {
      const snap = preSendVisitSnapshot?.scheduled_service_id === row.scheduled_service_id
        ? preSendVisitSnapshot
        : { ...(await visitSnapshot(dbh, row.scheduled_service_id)), post_send: true };
      row.visit_snapshot = JSON.stringify(snap);
    }
    // The Waves line the text went out on: the caller's, else the send's own
    // log row (written by the provider step during the send).
    row.waves_line = lineIdentity(from)
      || lineIdentity((providerMessageId ? await dbh('sms_log').where({ twilio_sid: providerMessageId }).first('from_phone') : null)?.from_phone);
    return await dbh.transaction(async (trx) => {
      // Offers to one phone are serialised so "one open offer per phone and
      // kind" holds without a failed insert.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['sms_offers', row.phone_last10]);
      const existing = await trx('sms_offers').where({ agent_decision_id: row.agent_decision_id }).first('id');
      if (existing) return { recorded: false, reason: 'already_recorded', id: existing.id };
      // The lock orders the writes, not the sends: a record can land after
      // newer texts' (a recovered write). So the new row goes in closed, and
      // the chain for this phone and kind is rebuilt in SEND order: each offer
      // is superseded by the next one sent, closed at that text's send time,
      // and only the latest sent offer stays open. Same result whatever order
      // the writes arrive in.
      const [inserted] = await trx('sms_offers').insert({ ...row, status: 'superseded' }).returning('id');
      const id = inserted?.id || inserted;
      const { demoted, openId } = await relinkOfferChain(trx, row.phone_last10, row.kind, row.waves_line);
      return { recorded: true, id, superseded: demoted, late: openId !== id };
    });
  } catch (err) {
    // Code only, never the message: a Knex error embeds the bound phone.
    logger.warn(`[sms-offers] offer not recorded for decision ${agentDecisionId}: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return { recorded: false, reason: 'error' };
  }
}

// How far back the backfill looks: an offer older than its own expiry has
// nothing left to match a reply against.
const BACKFILL_LOOKBACK_HOURS = OFFER_TTL_HOURS;
const BACKFILL_BATCH = 200;
// 10 pages = 2,000 decision sends in 48h, far above today's volume (~5 a day).
const BACKFILL_MAX_PAGES = 10;

/**
 * Re-record offers whose post-send write was lost (a transient database
 * error after the carrier already accepted the text). sms_log keeps the
 * durable link: every decision send is stamped metadata.agent_decision_id.
 * Picks accepted Twilio sends from the last 48h whose decision quoted OPEN
 * TIMES and has no ledger row, and hands each to recordOfferForSend with the
 * sent row's body, sid, destination and time; the writer's own checks, its
 * idempotency per decision and its send-order supersede rule all still apply.
 * The logged body may carry rewritten short links, so links are ignored on
 * both sides of the edit check (see buildOfferRow).
 * Never throws; a failed write is counted in `errors` so the cron fails health.
 */
async function backfillMissedOffers({ now = new Date(), dbh = db, batchSize = BACKFILL_BATCH, maxPages = BACKFILL_MAX_PAGES } = {}) {
  if (!offerLedgerLive()) return { scanned: 0, recorded: 0, skipped: 0, reason: 'gate_off' };
  const since = new Date(new Date(now).getTime() - BACKFILL_LOOKBACK_HOURS * 3600000);
  let recorded = 0;
  let errors = 0;
  const seen = new Set();
  // Keyset pages over (created_at, id): a send the writer skips for good (a
  // reviewer edit that dropped every offered time) stays eligible, so each
  // tick walks past it instead of re-reading the same oldest batch.
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    let rows;
    try {
      const query = dbh('sms_log as sl')
        .join('agent_decisions as ad', dbh.raw("ad.id::text = sl.metadata->>'agent_decision_id'"))
        .where('sl.direction', 'outbound')
        .whereIn('sl.status', ['queued', 'sent', 'delivered'])
        .whereRaw("sl.twilio_sid ~* '^(SM|MM)[a-f0-9]{32}$'")
        .where('sl.created_at', '>=', since)
        .whereRaw("ad.input_snapshot->'open_times_snapshot' IS NOT NULL")
        .whereNotExists(function missing() {
          this.select(dbh.raw('1')).from('sms_offers as o').whereRaw('o.agent_decision_id = ad.id');
        });
      if (cursor) query.whereRaw('(sl.created_at, sl.id) > (?, ?)', [cursor.created_at, cursor.id]);
      rows = await query
        .orderBy([{ column: 'sl.created_at', order: 'asc' }, { column: 'sl.id', order: 'asc' }])
        .limit(batchSize)
        .select('sl.id', 'ad.id as agent_decision_id', 'sl.message_body', 'sl.twilio_sid', 'sl.to_phone', 'sl.from_phone', 'sl.created_at');
    } catch (err) {
      logger.warn(`[sms-offers] backfill scan failed: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
      return { scanned: seen.size, recorded, errors: errors + 1, skipped: seen.size - recorded - errors, reason: 'error' };
    }
    for (const r of rows) {
      // A decision sent as several rows is one offer: its first accepted row.
      if (seen.has(r.agent_decision_id)) continue;
      seen.add(r.agent_decision_id);
      const result = await recordOfferForSend({
        agentDecisionId: r.agent_decision_id,
        outgoingBody: r.message_body,
        providerMessageId: r.twilio_sid,
        to: r.to_phone,
        from: r.from_phone,
        sentAt: new Date(r.created_at),
        ignoreLinks: true,
        dbh,
      });
      if (result.recorded) recorded += 1;
      else if (result.reason === 'error') errors += 1;
    }
    if (rows.length < batchSize) break;
    cursor = rows[rows.length - 1];
  }
  return { scanned: seen.size, recorded, errors, skipped: seen.size - recorded - errors };
}

module.exports = {
  offerLedgerLive,
  recordOfferForSend,
  backfillMissedOffers,
  buildOfferRow,
  isoDateForLabel,
  windowForLabel,
  phoneLast10,
  withoutLinks,
  visitSnapshot,
  captureOfferVisitSnapshot,
  OFFER_TTL_HOURS,
  KIND_BY_SOURCE,
};
