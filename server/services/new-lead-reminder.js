/**
 * New-lead re-alert (owner 2026-11-19, "do phase 1 first"; plan: "15 min, no person contact: push again; 60 min:
 * phone call to the owner's cell; at most twice per lead; Mon-Sat 8-6").
 *
 * In production (12 weeks to 2026-11-19) 82 of 437 leads never got a call, text, email or estimate from a person, and
 * none of them booked. A form lead gets one bell and one push; 44 of 129 form bells in 30 days were never opened.
 *
 * An OPEN new-lead bell (category `new_lead`, naming a lead) that no person has reached gets ONE more phone push 15
 * minutes after the bell's latest event. No gate: the push goes to admin users only. (A second step, a ring to the
 * owner's cell at 60 minutes behind its own gate, is a separate change.)
 * At most one push per bell row: it is stamped first, in one statement fenced on the row being open and unchanged since
 * it was read (metadata.newLeadRealertAt). Stamp first, then send: a send that fails after its stamp is lost, never
 * repeated.
 *
 * - The clock counts only Monday to Saturday, 8:00 AM to 6:00 PM America/New_York (callback-cards staffedDeadline;
 *   holidays are not skipped). Nothing is sent outside those hours. A push more than 2 business hours past its due time
 *   is dropped, so a restart cannot burst old bells.
 * - Bells of the last 48 hours only (a 6 PM Saturday bell is due Monday morning).
 * - "Reached" (reachedLeads) is judged on the lead, whatever the close gates of admin-alert-relevance.js say, and NOT
 *   only after the bell: a "New call lead" bell is written minutes after a call a person already answered. Reached =
 *   the lead is deleted or in a settled status (won, lost, ... or an estimate sent); the call that made the lead was
 *   answered by a person; a person's text or call, or a Gmail send, or a visit booked, reached the lead's customer or
 *   phone since 5 minutes before the lead came in; or an estimate was sent to the lead (sent_at, as the new-lead class of
 *   admin-alert-relevance.js reads it) or handed off to the customer. A lead row that is
 *   missing, or a witness read that fails, is no verdict: nothing is sent.
 * - Sends nothing to a lead or a customer. Never throws into the sweep.
 *
 * Runs inside the alert-relevance sweep (every 10 minutes), after its closes. Read-only apart from its stamp.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');

const TRIGGER_KEY = 'lead_call_reminder';
const PUSH_STAMP = 'newLeadRealertAt';
const PUSH_AFTER_MINUTES = 15;
const PUSH_LATE_MINUTES = 120;
const WINDOW_MS = 48 * 60 * 60 * 1000;
const WITNESS_SLACK_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;
// Monday to Saturday: a closed day is a Sunday (staffedDeadline asks `.has(date)` for each ET date).
const OFFICE = Object.freeze({
  start: '08:00',
  end: '18:00',
  closed: { has: (date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0 },
});
const SETTLED_STATUSES = new Set(['won', 'lost', 'disqualified', 'duplicate', 'unresponsive', 'handled', 'estimate_sent', 'estimate_viewed']);

const relevance = () => require('./admin-alert-relevance');
const safeError = (err) => require('./notification-service').safeErrorSummary(err);

// Monday to Saturday, 8:00 AM up to 6:00 PM Eastern, read in America/New_York for the instant given.
function inBusinessHours(date) {
  const { hour, dayOfWeek } = etParts(date);
  return dayOfWeek !== 0 && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

// `minutes` of business time after `from`.
const businessDueAt = (from, minutes) => require('./callback-cards').staffedDeadline(from, OFFICE, minutes);

// Due now, and not so long ago that it is stale: `afterMinutes` of business time after the bell's event have passed, and
// no more than `lateMinutes` more.
function dueNow(askedAt, now, afterMinutes, lateMinutes) {
  const due = businessDueAt(askedAt, afterMinutes);
  return due.getTime() <= now.getTime() && businessDueAt(due, lateMinutes).getTime() >= now.getTime();
}

// Open, unpushed new-lead bell rows whose latest event is in the last 48 hours, one keyset page after
// `cursor` ({ createdAt, id }; createdAt as the database's own text, so no microsecond is lost).
function candidateQuery(since, cursor, pageSize) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin', category: 'new_lead' }))
    .whereNull('done_at')
    .whereRaw("metadata->'retired' IS NULL")
    .whereRaw(`metadata->>'${PUSH_STAMP}' IS NULL`)
    .where((q) => q.where('created_at', '>', since).orWhereRaw("metadata->>'rungAt' > ?", [since.toISOString()]))
    .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]); })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'title', 'body', 'link', 'metadata', 'created_at', db.raw('created_at::text AS created_at_token'));
}

// The rows with a push due now: { row, meta, askedAt, leadId }. A row that names no lead (a tracking-line
// text) cannot be judged, so it sends nothing.
function dueItems(rows, now) {
  const { bellEventAt, parseMeta, refsFromRow } = relevance();
  const floor = now.getTime() - WINDOW_MS;
  const items = [];
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    const askedAt = bellEventAt(row);
    const leadId = refsFromRow(row).leadId;
    if (!leadId || !askedAt || askedAt.getTime() <= floor) continue;
    if (!meta[PUSH_STAMP] && dueNow(askedAt, now, PUSH_AFTER_MINUTES, PUSH_LATE_MINUTES)) items.push({ row, meta, askedAt, leadId });
  }
  return items;
}

// The leads that still wait on a person, each item with `lead` and `customerId`. Throws when a read fails: no verdict.
async function reachedLeads(items) {
  const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);
  const leadIds = [...new Set(items.map((item) => item.leadId))];
  const leads = new Map((await db('leads').whereIn('id', leadIds)
    .select('id', 'customer_id', 'phone', 'first_name', 'last_name', 'status', 'deleted_at', 'created_at', 'twilio_call_sid', 'estimate_id', 'email'))
    .map((lead) => [String(lead.id).toLowerCase(), lead]));
  const open = items
    .map((item) => ({ ...item, lead: leads.get(item.leadId) }))
    .filter(({ lead }) => lead && !lead.deleted_at && !SETTLED_STATUSES.has(String(lead.status || '')) && (lead.customer_id || lastTen(lead.phone).length === 10));
  if (!open.length) return [];
  // The call that made the lead, when a person answered it: the bell is written after that call, so the witnesses below
  // (judged after the lead came in) cannot see it.
  const sids = open.map(({ lead }) => lead.twilio_call_sid).filter(Boolean);
  const answered = new Set((sids.length
    ? await db('call_log').whereIn('twilio_call_sid', sids).where({ direction: 'inbound', status: 'completed', answered_by: 'human' }).select('twilio_call_sid')
    : []).map((call) => call.twilio_call_sid));
  const waiting = open.filter(({ lead }) => !answered.has(lead.twilio_call_sid));
  if (!waiting.length) return [];
  const { loadContactBundles } = require('./admin-alert-contact-witnesses');
  const { reached, estimateHandedOff } = require('./lead-call-reminder').__private;
  const anchorOf = ({ askedAt, lead }) => new Date(Math.min(askedAt.getTime(), new Date(lead.created_at).getTime()) - WITNESS_SLACK_MS);
  // Kind 'customer', as lead-call-reminder does: it also reads a person's Gmail send to the customer's own address.
  const bundles = await loadContactBundles(
    waiting.map((item) => ({ id: item.row.id, kind: 'customer', bellAt: anchorOf(item), refs: { customerId: item.lead.customer_id || null, phone: item.lead.phone || null } })),
    { conn: db, bookedVisits: (ids) => relevance().bookedVisitsByCustomer(db, ids) },
  );
  const sent = await estimatesSent(waiting);
  const emailed = await personEmailed(waiting);
  const still = [];
  for (const item of waiting) {
    const bundle = bundles.get(String(item.row.id));
    const customerId = item.lead.customer_id || null;
    if (!bundle || reached(bundle) || sent(item, bundle.anchor) || emailed(item, bundle.anchor)) continue;
    if (customerId && await estimateHandedOff(customerId, bundle.anchor)) continue;
    still.push({ ...item, customerId });
  }
  return still;
}

// An email a person sent to the lead's own address since `anchor` (a Gmail SENT row): the witnesses read only a
// customer's address, and a lead that came in by email may have no customer yet. Returns the test for one item.
async function personEmailed(items) {
  const { personSentFilter, extractEmailAddresses } = require('./email/email-customer-link');
  const addressOf = (lead) => String(lead.email || '').trim().toLowerCase();
  const addresses = [...new Set(items.map(({ lead }) => addressOf(lead)).filter(Boolean))];
  const rows = addresses.length
    ? await db('emails as er').whereRaw(personSentFilter('er'))
      .where('er.received_at', '>', new Date(Date.now() - WINDOW_MS - 24 * 60 * 60 * 1000))
      .whereRaw("EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address)), a.addr) > 0)", [addresses])
      .select('er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at')
    : [];
  const sentTo = rows.map((r) => ({ at: new Date(r.received_at).getTime(), to: new Set(extractEmailAddresses([r.to_address, r.cc_address, r.bcc_address].filter(Boolean).join(','))) }));
  return ({ lead }, anchor) => !!addressOf(lead) && sentTo.some((m) => m.at > anchor.getTime() && m.to.has(addressOf(lead)));
}

// A quote sent to the lead since `anchor`: the lead's own estimate or any estimate to its customer with a sent_at, the way
// the new-lead class of admin-alert-relevance.js (newLeadMovedOn) reads it. Returns the test for one item.
async function estimatesSent(items) {
  const customerIds = [...new Set(items.map(({ lead }) => lead.customer_id).filter(Boolean).map(String))];
  const estimateIds = [...new Set(items.map(({ lead }) => lead.estimate_id).filter(Boolean).map(String))];
  const rows = customerIds.length || estimateIds.length
    ? await db('estimates').whereNotNull('sent_at').where((q) => {
      if (customerIds.length) q.whereIn('customer_id', customerIds);
      if (estimateIds.length) q.orWhereIn('id', estimateIds);
    }).select('id', 'customer_id', 'sent_at')
    : [];
  return ({ lead }, anchor) => rows.some((e) => new Date(e.sent_at).getTime() > anchor.getTime()
    && ((lead.customer_id && String(e.customer_id) === String(lead.customer_id)) || (lead.estimate_id && String(e.id) === String(lead.estimate_id))));
}

// The one stamp: this row, still open and unchanged since it was read. Returns true when it landed.
async function stampOnce(item, now) {
  const mark = { [PUSH_STAMP]: now.toISOString() };
  const landed = await db('notifications')
    .where({ id: item.row.id, recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(item.meta)])
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(mark)]) });
  return Number(landed) === 1;
}

// Still open just before the send. A lookup that fails reads as closed: nothing is sent (the bell row stays).
async function rowStillOpen(id) {
  try {
    const stored = await db('notifications').where({ id, recipient_type: 'admin' }).first('done_at');
    return !!stored && !stored.done_at;
  } catch (err) {
    logger.warn(`[new-lead-reminder] open check failed for notification ${id}: ${safeError(err)}`);
    return false;
  }
}

// The push, with the row's own words. alertRowId gives it its own push tag per bell row. Never throws.
async function sendPush({ row, customerId }) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    return await triggerNotification(TRIGGER_KEY, {
      alertRowId: row.id, alertTitle: row.title, alertBody: row.body || null, alertLink: row.link || null,
      ...(customerId ? { customerId } : {}),
    }, {
      // bellAuthorized: the bell row exists, so the push keeps that answer. pushOnly: the row is not rewritten.
      pushOnly: true, adminOnly: true, bellAuthorized: true,
      beforePush: () => rowStillOpen(row.id),
    });
  } catch (err) {
    logger.warn(`[new-lead-reminder] push failed for notification ${row.id}: ${safeError(err)}`);
    return null;
  }
}

/**
 * One pass. Returns { skipped, reason } or { skipped: false, due, pushed, sends }; `sends` are the push sends, never
 * awaited here (tests await them). Throws only when the first page cannot be read; the sweep catches it.
 */
async function runNewLeadReminder({ now = new Date(), pageSize = PAGE_SIZE } = {}) {
  if (!inBusinessHours(now)) return { skipped: true, reason: 'quiet_hours' };
  const since = new Date(now.getTime() - WINDOW_MS);
  const total = { due: 0, pushed: 0 };
  const sends = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(since, cursor, pageSize);
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at_token, id: last.id };
    const due = dueItems(rows, now);
    total.due += due.length;
    let waiting = [];
    try {
      waiting = await reachedLeads(due);
    } catch (err) {
      logger.warn(`[new-lead-reminder] contact witnesses failed to load, nothing sent on this page: ${safeError(err)}`);
    }
    for (const item of waiting) {
      try {
        if (!(await stampOnce(item, now))) continue;
        total.pushed += 1;
        sends.push(sendPush(item));
      } catch (err) {
        logger.warn(`[new-lead-reminder] notification ${item.row.id} not pushed: ${safeError(err)}`);
      }
    }
    if (rows.length < pageSize) break;
    if (page === MAX_PAGES - 1) logger.warn(`[new-lead-reminder] stopped after ${MAX_PAGES} pages; the next sweep reads the rest`);
  }
  if (total.pushed) logger.info(`[new-lead-reminder] queued ${total.pushed} push(es): a new lead nobody has reached`);
  return { skipped: false, ...total, sends };
}

module.exports = {
  runNewLeadReminder,
  PUSH_STAMP,
  __private: { inBusinessHours, businessDueAt, dueNow, dueItems, reachedLeads, stampOnce, sendPush, candidateQuery, SETTLED_STATUSES },
};
