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
 * - The ask time stays the boundary after the re-ring: the row is stamped metadata.askedAt (the ask's time)
 *   before its created_at is bumped, and every close and contact check reads askedAt when present
 *   (admin-alert-relevance.js askedAtOf), so a reply that landed between the ask and the re-ring still answers it.
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
// Pages read per sweep: 2000 open portal bells asked in the last day is far past a busy day. A run that
// stops here says so in the log, and the rest are read by the next sweep (rows rung drop out of the query).
const MAX_PAGES = 10;
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

// Open, unrung bell rows that could be a portal item asked in the last 24 hours, one keyset page after
// `cursor` ({ createdAt, id }; createdAt as the database's own text, so no microsecond is lost). The class test
// (the relevance table) runs in code; this only narrows what is read. A refreshed chat bell keeps its first
// created_at and carries its latest ring in metadata.rungAt, so either may be recent.
function candidateQuery(since, cursor, pageSize) {
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
    .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]); })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'category', 'title', 'body', 'detail', 'link', 'metadata', 'created_at', db.raw('created_at::text AS created_at_token'));
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
  const waiting = [];
  for (const item of items) {
    const bundle = bundles.get(String(item.row.id));
    if (!bundle || reached(bundle)) continue;
    // The close rule's own estimate test: a request bell is answered only by an estimate pricing its service.
    if (QUOTE_CLASSES.has(item.cls.key)
      && await relevance().quoteAnswered(db, { meta: item.meta, customerId: item.customerId, bellAt: item.askedAt })) continue;
    waiting.push(item);
  }
  return waiting;
}

// The one extra ring: this row, still open and unchanged since it was read, rewritten with the
// "Still waiting" line, unread, at the top, stamped. Returns 1 when it landed.
async function ringAgain({ row, meta, askedAt }, now) {
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
      // askedAt first: created_at is bumped above, and the close and contact checks must keep the ask as their boundary.
      // `contact: true` declares a customer reaching us, which the bell policy rings (GATE_CUSTOMER_ALERTS_RING).
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ askedAt: askedAt.toISOString(), lateReRungAt: at, contact: true })]),
    });
  return rewritten ? 1 : 0;
}

// One page: the items due, those still waiting, and the one ring each. Returns the rows read and rung.
async function runPage(rows, now) {
  const due = dueItems(rows, now);
  const waiting = await stillWaiting(due);
  let rung = 0;
  for (const item of waiting) {
    try {
      const landed = await ringAgain(item, now);
      rung += landed;
      // Only a row this run really rewrote (the fenced update landed) pages the phones, once: the row is stamped
      // lateReRungAt in the same statement, so no later sweep reads it again. This waits for the customer's name
      // read only; the page goes out from portal-ask-push.js's queue, never awaited, so it cannot hold the sweep.
      if (landed) await pushStillWaiting(item);
    } catch (err) {
      logger.warn(`[portal-late-rering] notification ${item.row.id} not rung: ${safeError(err)}`);
    }
  }
  return { due: due.length, rung };
}

// GATE_PORTAL_ASK_PUSH: the "Still waiting" ring also pages the admin phones. The bell was a row nobody had
// looked at for an hour; this is the one nudge that reaches a pocket. Never throws.
async function pushStillWaiting({ row, meta }) {
  try {
    const { pushPortalAsk, customerShortName } = require('./portal-ask-push');
    if (!require('../config/feature-gates').portalAskPushLive?.()) return;
    const name = await customerShortName(meta.customerId);
    void pushPortalAsk({
      itemKey: `late:${row.id}`,
      title: 'Still waiting on a reply to a customer',
      body: `${name} has waited over 1 business hour for an answer`,
      link: row.link || null,
      customerId: meta.customerId,
    });
  } catch (err) {
    logger.warn(`[portal-late-rering] push for notification ${row.id} failed: ${safeError(err)}`);
  }
}

async function runPortalLateRering({ now = new Date(), pageSize = PAGE_SIZE } = {}) {
  if (!require('../config/feature-gates').portalLateReringLive?.()) return { skipped: true, reason: 'gate_off' };
  const since = new Date(now.getTime() - WINDOW_MS);
  let cursor = null;
  const total = { due: 0, rung: 0 };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(since, cursor, pageSize);
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at_token, id: last.id };
    try {
      const done = await runPage(rows, now);
      total.due += done.due;
      total.rung += done.rung;
    } catch (err) {
      // A witness read that fails is no verdict: nothing in this page rings. The next page is still read.
      logger.warn(`[portal-late-rering] contact witnesses failed to load, nothing rung on this page: ${safeError(err)}`);
    }
    if (rows.length < pageSize) break;
    if (page === MAX_PAGES - 1) logger.warn(`[portal-late-rering] stopped after ${MAX_PAGES} pages; the next sweep reads the rest`);
  }
  if (total.rung) logger.info(`[portal-late-rering] rang ${total.rung} portal item(s) once more: no reply after 1 business hour`);
  return { skipped: false, ...total };
}


// ---------------------------------------------------------------------------------------------------------
// The owed-estimate re-ring (GATE_PORTAL_ESTIMATE_RERING, owner 2026-11-02, "remind").
//
// The first-reply re-ring above asks "has a person reached the customer?" and goes quiet at the first
// "we're working on it". An add-service request is owed an ESTIMATE, which a text does not deliver. An OPEN
// add-service request bell (class portal_add_service_request: trigger bundle_quote_requested with its
// request id and customer on top) that is 2 business days past its ask and still has no estimate for the
// requested service (admin-alert-relevance.js quoteAnswered, the close rule's own test) is rung ONE more
// time on the same row, whatever a person has said to the customer since: person contact does not matter here.
//
// - Two business days is 24 hours of the follow-up SLA's clock (8 AM to 8 PM ET, no weekday carve-out):
//   followUpDueAt(askedAt, OPEN_CALENDAR, 1440). The ask time is the relevance bellEventAt, as the
//   first-reply pass reads it, never a created_at an earlier re-ring bumped.
// - Only asks of the last 14 days (the Portal tab's window), so turning the gate on cannot burst the backlog.
// - The ring rewrites the row like ringAgain: unread, DONE_CLEARED, created_at bumped, metadata.askedAt
//   stamped first, metadata.estimateReRungAt, contact: true. estimateReRungAt makes it one per bell, ever. A bell
//   the first-reply pass already rang (lateReRungAt) still gets this one; its "Still waiting" line is replaced.
// - After this ring the first-reply pass never rings the row (it skips lateReRungAt rows, and an ask 2 days old
//   is past its 24-hour window).
// - Sends nothing to a customer. One admin row write, fenced on the row still being open and unchanged.
// ---------------------------------------------------------------------------------------------------------
const ESTIMATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ESTIMATE_BUSINESS_MINUTES = 24 * 60; // 24 open hours: two full 12-hour days of the SLA clock
const ESTIMATE_STILL_OWED = 'Estimate still owed: no estimate for this service after 2 business days.';
const ESTIMATE_CLASS = 'portal_add_service_request';

// When an add-service ask made at `askedAt` is two business days old, or null.
function estimateDueAtFor(askedAt) {
  const { followUpDueAt, OPEN_CALENDAR } = require('./followup-sla-watcher');
  return followUpDueAt(askedAt, OPEN_CALENDAR, ESTIMATE_BUSINESS_MINUTES);
}

// Like candidateQuery, for add-service request bells only. A bell the first-reply pass rang (lateReRungAt) is
// still read; one already estimate-rung is not. Any of created_at, rungAt or askedAt may be recent.
function estimateCandidateQuery(since, cursor, pageSize) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin' }))
    .whereNull('done_at')
    .whereRaw("metadata->'retired' IS NULL")
    .whereRaw("metadata->>'triggerKey' = 'bundle_quote_requested'")
    .whereRaw("metadata->>'estimateReRungAt' IS NULL")
    .where((q) => q.where('created_at', '>', since)
      .orWhereRaw("metadata->>'rungAt' > ?", [since.toISOString()])
      .orWhereRaw("metadata->>'askedAt' > ?", [since.toISOString()]))
    .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]); })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'category', 'title', 'body', 'detail', 'link', 'metadata', 'created_at', db.raw('created_at::text AS created_at_token'));
}

// The add-service request bells among the rows that are two business days old: { row, meta, askedAt, customerId }.
function estimateDueItems(rows, now) {
  const { classify, bellEventAt, parseMeta } = relevance();
  const floor = now.getTime() - ESTIMATE_WINDOW_MS;
  const items = [];
  for (const row of rows) {
    if (classify(row, { anyMode: true })?.key !== ESTIMATE_CLASS) continue;
    const meta = parseMeta(row.metadata);
    const askedAt = bellEventAt(row);
    const customerId = typeof meta.customerId === 'string' ? meta.customerId.trim().toLowerCase() : null;
    if (!askedAt || !customerId || askedAt.getTime() <= floor) continue;
    const dueAt = estimateDueAtFor(askedAt);
    if (!dueAt || dueAt.getTime() > now.getTime()) continue;
    items.push({ row, meta, askedAt, customerId });
  }
  return items;
}

// The items whose estimate is still owed. A person's contact is no answer: only the close rule's estimate test
// counts. A read that fails for one item is no verdict: that item is not rung.
async function stillOwed(items) {
  const owed = [];
  for (const item of items) {
    try {
      if (!await relevance().quoteAnswered(db, { meta: item.meta, customerId: item.customerId, bellAt: item.askedAt })) owed.push(item);
    } catch (err) {
      logger.warn(`[portal-late-rering] estimate check failed for notification ${item.row.id}, not rung: ${safeError(err)}`);
    }
  }
  return owed;
}

// The one estimate ring: this row, still open and unchanged since it was read, rewritten with the "Estimate
// still owed" line (replacing the first-reply line when it leads the body), unread, at the top, stamped.
async function ringEstimateAgain({ row, meta, askedAt }, now) {
  const notifications = require('./notification-service');
  const lead = `${STILL_WAITING}. `;
  const rest = String(row.body || '').startsWith(lead) ? String(row.body).slice(lead.length) : (row.body || '');
  const text = notifications.normalizeAdminText({
    category: row.category,
    title: row.title,
    body: `${ESTIMATE_STILL_OWED} ${rest}`.trim(),
    detail: row.detail || null,
  });
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
      // askedAt first: created_at is bumped above, and the close and contact checks must keep the ask as their boundary.
      // `contact: true` declares a customer reaching us, which the bell policy rings (GATE_CUSTOMER_ALERTS_RING).
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ askedAt: askedAt.toISOString(), estimateReRungAt: now.toISOString(), contact: true })]),
    });
  return rewritten ? 1 : 0;
}

async function runEstimatePage(rows, now) {
  const due = estimateDueItems(rows, now);
  const owed = await stillOwed(due);
  let rung = 0;
  for (const item of owed) {
    try {
      rung += await ringEstimateAgain(item, now);
    } catch (err) {
      logger.warn(`[portal-late-rering] notification ${item.row.id} not rung for its estimate: ${safeError(err)}`);
    }
  }
  return { due: due.length, rung };
}

async function runPortalEstimateRering({ now = new Date(), pageSize = PAGE_SIZE } = {}) {
  if (!require('../config/feature-gates').portalEstimateReringLive?.()) return { skipped: true, reason: 'gate_off' };
  const since = new Date(now.getTime() - ESTIMATE_WINDOW_MS);
  let cursor = null;
  const total = { due: 0, rung: 0 };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await estimateCandidateQuery(since, cursor, pageSize);
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at_token, id: last.id };
    const done = await runEstimatePage(rows, now);
    total.due += done.due;
    total.rung += done.rung;
    if (rows.length < pageSize) break;
    if (page === MAX_PAGES - 1) logger.warn(`[portal-late-rering] estimate pass stopped after ${MAX_PAGES} pages; the next sweep reads the rest`);
  }
  if (total.rung) logger.info(`[portal-late-rering] rang ${total.rung} add-service request(s) once more: no estimate after 2 business days`);
  return { skipped: false, ...total };
}

module.exports = { runPortalLateRering, dueAtFor, STILL_WAITING, runPortalEstimateRering, estimateDueAtFor, ESTIMATE_STILL_OWED };
