/**
 * Portal items past their one business hour (GATE_PORTAL_LATE_RERING, owner 2026-11-01).
 *
 * The portal tells a customer to expect a reply "usually within one business hour between 8 AM and
 * 8 PM". Nothing rang when that hour passed. An OPEN admin bell for a portal item whose ask is past its
 * due time, with no person's contact since the ask, is rung ONE more time on the same row: the body leads
 * with "Still waiting: no reply after 1 business hour", the row moves to the top of the bell and is unread
 * again, and it is stamped metadata.lateReRungAt so it can never ring a second time.
 *
 * The items: a portal chat hand-off (dedupeKey `portal-chat-escalation:<id>`, doneWhen
 * `customer_answered`), a portal request (doneWhen `request_answered`) and an add-service request
 * (trigger `bundle_quote_requested` with its request id on top). The classes are admin-alert-relevance.js's,
 * so one definition says what each bell is.
 *
 * - The clock is the follow-up SLA's (followup-sla-watcher.js followUpDueAt): 60 minutes counted only
 *   between 8 AM and 8 PM ET, no weekday carve-out. A 7:30 PM ask is due 8:30 AM next day.
 * - "Contact" is the shared customer witnesses (admin-alert-contact-witnesses.js: a person's text, a call a
 *   person placed or answered, a person's Gmail send), after the bell's latest event, plus an estimate
 *   handed to the customer for an add-service ask. Judged here whatever the close gates say: a bell that
 *   nobody closed because a close gate is off must still not ring "still waiting" over a reply.
 * - Only asks of the last 24 hours, so turning the gate on cannot burst old items.
 * - It sends nothing to a customer. It rewrites one admin row; the write is fenced on the row still being
 *   open and unchanged since it was read, so a reply that closed it, or an emitter's refresh, wins.
 *
 * Runs inside the alert-relevance sweep (every 10 minutes), after its closes. Read-only apart from that
 * one row write.
 */

const db = require('../models/db');
const logger = require('./logger');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const STILL_WAITING = 'Still waiting: no reply after 1 business hour';
const LATE_CLASSES = new Set(['portal_chat_add_service', 'portal_chat_answered', 'portal_request_answered', 'portal_add_service_request']);
// The classes whose answer is also an estimate handed to the customer.
const QUOTE_CLASSES = new Set(['portal_chat_add_service', 'portal_add_service_request']);

const relevance = () => require('./admin-alert-relevance');
const safeError = (err) => require('./notification-service').safeErrorSummary(err);

// When an ask made at `askedAt` is due: one business hour on the follow-up SLA's clock, or null.
function dueAtFor(askedAt) {
  return require('./followup-sla-watcher').followUpDueAt(askedAt);
}

// Open, unrung bell rows that could be a portal item asked in the last 24 hours. The class test (the
// relevance table) runs in code; this only narrows what is read. A refreshed chat bell keeps its first
// created_at and carries its latest ring in metadata.rungAt, so either may be recent.
function candidateQuery(since) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin' }))
    .whereNull('done_at')
    .whereRaw("metadata->'retired' IS NULL")
    .whereRaw("metadata->>'lateReRungAt' IS NULL")
    .where((q) => q.where('created_at', '>', since).orWhereRaw("metadata->>'rungAt' > ?", [since.toISOString()]))
    .where((q) => q
      .whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), 23) = 'portal-chat-escalation:'")
      .orWhereRaw("metadata->>'doneWhen' = 'request_answered'")
      .orWhereRaw("metadata->>'triggerKey' = 'bundle_quote_requested'"))
    .orderBy('created_at', 'asc')
    .limit(PAGE_SIZE)
    .select('id', 'category', 'title', 'body', 'detail', 'link', 'metadata', 'created_at');
}

// The portal item bells among the rows that are due now: { row, cls, meta, askedAt, customerId }.
function dueItems(rows, now) {
  const { classify, bellEventAt, parseMeta } = relevance();
  const floor = now.getTime() - WINDOW_MS;
  const items = [];
  for (const row of rows) {
    const cls = classify(row, { anyMode: true });
    if (!cls || !LATE_CLASSES.has(cls.key)) continue;
    const meta = parseMeta(row.metadata);
    const askedAt = bellEventAt(row);
    const customerId = typeof meta.customerId === 'string' ? meta.customerId.trim().toLowerCase() : null;
    if (!askedAt || !customerId || askedAt.getTime() <= floor) continue;
    const dueAt = dueAtFor(askedAt);
    if (!dueAt || dueAt.getTime() > now.getTime()) continue;
    items.push({ row, cls, meta, askedAt, customerId });
  }
  return items;
}

// A person reached the customer after the ask: the witnesses' text, call back, answered call or Gmail send.
const reached = (bundle) => [bundle.textAt, bundle.backAt, bundle.inAt, bundle.replyAt]
  .some((at) => at && new Date(at).getTime() > bundle.anchor.getTime());

// Which of these items still wait on a person. A witness read that fails is no verdict: nothing rings.
async function stillWaiting(items) {
  if (!items.length) return [];
  const { loadContactBundles } = require('./admin-alert-contact-witnesses');
  const bundles = await loadContactBundles(
    items.map(({ row, askedAt, customerId }) => ({ id: row.id, kind: 'customer', bellAt: askedAt, refs: { customerId } })),
    // A booked visit is not a reply to a portal ask: the witnesses' visit clause is not read here.
    { conn: db, bookedVisits: async () => new Map() },
  );
  const { handedOffWithin, whereEstimateCustomerOwnership } = require('./call-commitments');
  const waiting = [];
  for (const item of items) {
    const bundle = bundles.get(String(item.row.id));
    if (!bundle || reached(bundle)) continue;
    if (QUOTE_CLASSES.has(item.cls.key)
      && await whereEstimateCustomerOwnership(handedOffWithin(db('estimates'), item.askedAt), item.customerId).first('estimates.id')) continue;
    waiting.push(item);
  }
  return waiting;
}

// The one extra ring: this row, still open and unchanged since it was read, rewritten with the
// "Still waiting" line, unread, at the top, stamped. Returns 1 when it landed.
async function ringAgain({ row, meta }, now) {
  const notifications = require('./notification-service');
  const text = notifications.normalizeAdminText({
    category: row.category,
    title: row.title,
    body: `${STILL_WAITING}. ${row.body || ''}`.trim(),
    detail: row.detail || null,
  });
  const at = now.toISOString();
  const rewritten = await db('notifications')
    .where({ id: row.id, recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(meta)])
    .update({
      body: text.body,
      detail: text.detail,
      read_at: null,
      ...notifications._private.DONE_CLEARED,
      created_at: db.fn.now(),
      // `contact: true` declares a customer reaching us, which the bell policy rings (GATE_CUSTOMER_ALERTS_RING).
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ lateReRungAt: at, rungAt: at, contact: true })]),
    });
  return rewritten ? 1 : 0;
}

async function runPortalLateRering({ now = new Date() } = {}) {
  if (!require('../config/feature-gates').portalLateReringLive?.()) return { skipped: true, reason: 'gate_off' };
  const rows = await candidateQuery(new Date(now.getTime() - WINDOW_MS));
  const due = dueItems(rows, now);
  let waiting;
  try {
    waiting = await stillWaiting(due);
  } catch (err) {
    logger.warn(`[portal-late-rering] contact witnesses failed to load, nothing rung: ${safeError(err)}`);
    return { skipped: false, due: due.length, rung: 0 };
  }
  let rung = 0;
  for (const item of waiting) {
    try {
      rung += await ringAgain(item, now);
    } catch (err) {
      logger.warn(`[portal-late-rering] notification ${item.row.id} not rung: ${safeError(err)}`);
    }
  }
  if (rung) logger.info(`[portal-late-rering] rang ${rung} portal item(s) once more: no reply after 1 business hour`);
  return { skipped: false, due: due.length, rung };
}

module.exports = { runPortalLateRering, dueAtFor, STILL_WAITING };
