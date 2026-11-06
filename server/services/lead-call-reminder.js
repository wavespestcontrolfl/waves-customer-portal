/**
 * Lead call-back reminder banner (GATE_LEAD_CALL_REMINDER, owner 2026-11-05, "remind").
 *
 * A lead who replies CALL to our lead text rings the owner's cell with press 1 (lead-call-reply-ring.js). A ring
 * nobody answers raises ONE "Missed call request" bell (dedupeKey `lead-call-reply-missed:<callLogId>`), and a night
 * CALL whose call time needs a person raises a "call them back" bell (lead-call-text-followup.js raiseLeadBell,
 * dedupeKey `lead-call-text-followup:<requestId>`; the 8 AM "never sent a time" bell is one of these). Both stay in
 * the portal bell: no phone banner, and nothing prompts the owner again. In production (Oct 27 to Nov 5) the owner's
 * cell answered 0 of 3 daytime rings, and 2 of 5 CALL leads were never reached.
 *
 * With the gate on, an OPEN bell of those two kinds that is one business hour old and whose lead nobody has reached
 * since sends ONE phone banner: trigger lead_call_reminder, pushOnly, admin users only, with the row's own title and
 * body led by "Reminder: nobody has reached this lead yet." The row itself is not rewritten. It is stamped
 * metadata.leadCallReminderAt in one statement fenced on the row being open and unchanged since it was read, so a row
 * sends at most one banner, and a close or an emitter's refresh that lands first wins.
 *
 * - The clock is the follow-up SLA's (followup-sla-watcher.js followUpDueAt): 60 minutes counted only between 8 AM
 *   and 8 PM ET, from the bell's latest event (admin-alert-relevance.js bellEventAt). A 7:30 PM bell is due at
 *   8:30 AM the next day.
 * - Banners go out only between 8 AM and 8 PM ET, judged when the sweep runs; the stamp is written only then.
 * - Only bells of the last 24 hours, so turning the gate on cannot burst old bells.
 * - "Reached" is the shared contact witnesses (admin-alert-contact-witnesses.js) after the bell's latest event: a
 *   person's text, a call a person placed and spoke on, an inbound call a person answered, a person's Gmail send to
 *   the lead's customer's own address, or a visit booked for that customer; or an estimate handed off to that
 *   customer (call-commitments.js handedOffWithin). A deleted lead, or one a person closed (won, lost, and so on),
 *   sends nothing. Judged here whatever the close gates say. A witness read that fails is no verdict: nothing is sent.
 * - The banner is sent without waiting for it, so a slow push provider cannot hold the sweep. Stamp first, then send:
 *   a send that fails after the stamp is lost, never repeated.
 * - Sends nothing to a lead or a customer. Never throws into the sweep.
 *
 * Runs inside the alert-relevance sweep (every 10 minutes), after its closes. Read-only apart from the stamp.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');

const TRIGGER_KEY = 'lead_call_reminder';
const STAMP = 'leadCallReminderAt';
// The bells this reminds about, by their writers' dedupe keys. Plain text: no LIKE wildcard in either.
const KEY_PREFIXES = Object.freeze(['lead-call-reply-missed:', 'lead-call-text-followup:']);
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
// Pages read per sweep: 500 open call requests in a day is far past a busy day. The next sweep reads the rest.
const MAX_PAGES = 5;
const SEND_FROM_HOUR = 8;
const SEND_UNTIL_HOUR = 20;
// A lead a person settled: the closed set customer-address-fanout.js and estimate-clarify-asks.js use.
const CLOSED_LEAD_STATUSES = new Set(['won', 'lost', 'disqualified', 'duplicate', 'unresponsive', 'handled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const relevance = () => require('./admin-alert-relevance');
const safeError = (err) => require('./notification-service').safeErrorSummary(err);
const uuidOrNull = (value) => {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text.toLowerCase() : null;
};

// The gate, read at call time. A missing reader (a test that mocks feature-gates) or a throw reads as off.
function reminderLive() {
  try {
    return require('../config/feature-gates').leadCallReminderLive?.() === true;
  } catch {
    return false;
  }
}

// True from 8:00 AM up to 8:00 PM Eastern. The hour is read in America/New_York for the instant given (etParts),
// never from a fixed UTC offset, so the daylight-saving change moves nothing.
function inSendHours(date) {
  const { hour } = etParts(date);
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

// When a call request whose bell last became news at `askedAt` is due its reminder: one business hour, or null.
function dueAtFor(askedAt) {
  return require('./followup-sla-watcher').followUpDueAt(askedAt);
}

// Open, unreminded call-request bell rows whose latest event is in the last 24 hours, one keyset page after `cursor`
// ({ createdAt, id }; createdAt as the database's own text, so no microsecond is lost). A refreshed bell keeps its
// first created_at and carries its latest ring in metadata.rungAt, so either may be recent.
function candidateQuery(since, cursor, pageSize) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin', category: 'lead' }))
    .whereNull('done_at')
    .whereRaw("metadata->'retired' IS NULL")
    .whereRaw(`metadata->>'${STAMP}' IS NULL`)
    .where((q) => q.where('created_at', '>', since).orWhereRaw("metadata->>'rungAt' > ?", [since.toISOString()]))
    .where((q) => {
      for (const prefix of KEY_PREFIXES) q.orWhereRaw("metadata->>'dedupeKey' LIKE ?", [`${prefix}%`]);
    })
    .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]); })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'title', 'body', 'link', 'metadata', 'created_at', db.raw('created_at::text AS created_at_token'));
}

// The rows that are due now: { row, meta, askedAt, leadId, customerId }. A row that names neither a lead nor a
// customer cannot be judged, so it sends nothing.
function dueItems(rows, now) {
  const { bellEventAt, parseMeta } = relevance();
  const floor = now.getTime() - WINDOW_MS;
  const items = [];
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    const askedAt = bellEventAt(row);
    if (!askedAt || askedAt.getTime() <= floor) continue;
    const dueAt = dueAtFor(askedAt);
    if (!dueAt || dueAt.getTime() > now.getTime()) continue;
    const leadId = uuidOrNull(meta.leadId);
    const customerId = uuidOrNull(meta.customerId);
    if (!leadId && !customerId) continue;
    items.push({ row, meta, askedAt, leadId, customerId });
  }
  return items;
}

// A person reached the lead after the bell's latest event (the witnesses' anchor).
const reached = (bundle) => [bundle.textAt, bundle.backAt, bundle.inAt, bundle.replyAt, bundle.visitAt]
  .some((at) => at && new Date(at).getTime() > bundle.anchor.getTime());

// An estimate handed off to the lead's customer after the bell: the promise lane's own witness.
async function estimateHandedOff(customerId, anchor) {
  const { handedOffWithin, whereEstimateCustomerOwnership } = require('./call-commitments');
  return !!(await whereEstimateCustomerOwnership(handedOffWithin(db('estimates'), anchor), customerId).first('estimates.id'));
}

// The items whose lead is still open (not deleted, not in a closed status), each with the customer and phone the
// witnesses read: the lead row's, else the bell's own customer id (a missing lead row is unknown, never gone).
async function openLeadItems(items) {
  const leadIds = [...new Set(items.map((item) => item.leadId).filter(Boolean))];
  const leads = new Map((leadIds.length
    ? await db('leads').whereIn('id', leadIds).select('id', 'customer_id', 'phone', 'status', 'deleted_at')
    : []).map((lead) => [String(lead.id).toLowerCase(), lead]));
  const open = [];
  for (const item of items) {
    const lead = item.leadId ? leads.get(item.leadId) : null;
    if (lead && (lead.deleted_at || CLOSED_LEAD_STATUSES.has(String(lead.status || '')))) continue;
    const customerId = uuidOrNull(lead?.customer_id) || item.customerId;
    const phone = lead?.phone || null;
    if (customerId || phone) open.push({ ...item, customerId, phone });
  }
  return open;
}

// Which of these items still wait on a person. Throws when a read fails: no verdict.
async function stillWaiting(items) {
  if (!items.length) return [];
  const open = await openLeadItems(items);
  if (!open.length) return [];
  const { loadContactBundles } = require('./admin-alert-contact-witnesses');
  // Kind 'customer', not 'lead': both read the same texts, calls and visits for the customer and phone, and only
  // 'customer' also reads a person's Gmail send to the customer's own address (attachCustomerEmailSends).
  const bundles = await loadContactBundles(
    open.map(({ row, askedAt, customerId, phone }) => ({ id: row.id, kind: 'customer', bellAt: askedAt, refs: { customerId, phone } })),
    { conn: db, bookedVisits: (ids) => relevance().bookedVisitsByCustomer(db, ids) },
  );
  const waiting = [];
  for (const item of open) {
    const bundle = bundles.get(String(item.row.id));
    if (!bundle || reached(bundle)) continue;
    if (item.customerId && await estimateHandedOff(item.customerId, bundle.anchor)) continue;
    waiting.push(item);
  }
  return waiting;
}

// The one stamp: this row, still open and unchanged since it was read. Returns true when it landed.
async function stampReminder({ row, meta }, now) {
  const landed = await db('notifications')
    .where({ id: row.id, recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(meta)])
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [STAMP]: now.toISOString() })]) });
  return Number(landed) === 1;
}

// Still open just before the push goes. A lookup that fails reads as closed: no banner (the bell row stays).
async function rowStillOpen(id) {
  try {
    const stored = await db('notifications').where({ id, recipient_type: 'admin' }).first('done_at');
    return !!stored && !stored.done_at;
  } catch (err) {
    logger.warn(`[lead-call-reminder] open check failed for notification ${id}: ${safeError(err)}`);
    return false;
  }
}

// The banner, with the row's own words. alertRowId gives the banner its own push tag per bell row. Never throws.
async function sendReminder({ row, customerId }) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    return await triggerNotification(TRIGGER_KEY, {
      alertRowId: row.id, alertTitle: row.title, alertBody: row.body || null, alertLink: row.link || null,
      ...(customerId ? { customerId } : {}),
    }, {
      // bellAuthorized: the bell row's writer rang it (bell: true), so the banner keeps that answer.
      pushOnly: true, adminOnly: true, bellAuthorized: true,
      beforePush: () => rowStillOpen(row.id),
    });
  } catch (err) {
    logger.warn(`[lead-call-reminder] banner failed for notification ${row.id}: ${safeError(err)}`);
    return null;
  }
}

/**
 * One pass. Returns { skipped, reason } or { skipped: false, due, reminded, sends }; `sends` are the banner sends,
 * never awaited here (tests await them). Throws only when the first page cannot be read; the sweep catches it.
 */
async function runLeadCallReminder({ now = new Date(), pageSize = PAGE_SIZE } = {}) {
  if (!reminderLive()) return { skipped: true, reason: 'gate_off' };
  if (!inSendHours(now)) return { skipped: true, reason: 'quiet_hours' };
  const since = new Date(now.getTime() - WINDOW_MS);
  const total = { due: 0, reminded: 0 };
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
      waiting = await stillWaiting(due);
    } catch (err) {
      logger.warn(`[lead-call-reminder] contact witnesses failed to load, nothing sent on this page: ${safeError(err)}`);
    }
    for (const item of waiting) {
      try {
        if (!(await stampReminder(item, now))) continue;
        total.reminded += 1;
        sends.push(sendReminder(item));
      } catch (err) {
        logger.warn(`[lead-call-reminder] notification ${item.row.id} not stamped: ${safeError(err)}`);
      }
    }
    if (rows.length < pageSize) break;
    if (page === MAX_PAGES - 1) logger.warn(`[lead-call-reminder] stopped after ${MAX_PAGES} pages; the next sweep reads the rest`);
  }
  if (total.reminded) logger.info(`[lead-call-reminder] queued ${total.reminded} reminder banner(s): a lead's call request is still open after 1 business hour`);
  return { skipped: false, ...total, sends };
}

module.exports = {
  runLeadCallReminder,
  TRIGGER_KEY,
  KEY_PREFIXES,
  __private: { inSendHours, dueAtFor, dueItems, reached, openLeadItems, stillWaiting, stampReminder, rowStillOpen, sendReminder, candidateQuery, CLOSED_LEAD_STATUSES },
};
