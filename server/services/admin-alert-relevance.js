/**
 * Admin alert relevance — an unread admin bell clears itself when the customer,
 * visit, invoice, estimate or lead it is about has moved on (owner ruling
 * 2026-09-28: "we don't want garbage"; live with the ADMIN_ALERT_RELEVANCE
 * kill switch, rule 14: auto-applied, audit-trailed, no bell).
 *
 * Why this is a sweep and not another hook (AGENTS.md "extend the existing
 * mechanism"): the retire helpers that exist today — supersedeMissedCallAdmin,
 * markInboundSmsReadAdmin, first-application-sibling-split's clearStandingAlerts
 * — are per-class event hooks: each fires from the one code path its author
 * knew moves that subject on. Subjects move on through paths no hook sees (a
 * customer churned or a visit closed by a direct database edit, a lead quoted
 * from another surface), and every new alert class would need its own hook.
 * This module judges the LIVE record instead. It does not replace those hooks
 * (their classes are untouched); it only adds the classes below, and the two
 * entry points share ONE rule table:
 *   - runAdminAlertRelevanceSweep: periodic (scheduler.js, every 10 minutes)
 *     retirement of unread rows whose subject has moved on.
 *   - ringTimeCheck: the ringGate notifyAdmin's existing seam already runs
 *     inside the insert's transaction — a fresh row that has ALREADY moved on
 *     is written activity-only instead of ringing (notification-service.js
 *     createPlainAdmin; the dedupe/refresh path is untouched).
 *
 * A retire is a PURE `read_at = now` plus `metadata.retired = {by, reason, at}`
 * — never dedupeKey/dedupeVersion/autoCleared/invoiceId, so every emitter's own
 * dedupe and recovery logic still sees the row exactly as a human dismissal.
 * A genuine state change can still re-bell a refreshOnDedupe row once; the
 * next sweep retires it again if its subject is still gone. Read-only apart
 * from notification rows.
 *
 * Never applies to customer-initiated contact bells (inbound_sms, inbound_email,
 * missed_call, voicemail_callback, review) or money-owed/failed/refund alerts:
 * a class is only in the table if its category (plus dedupeKey prefix) is
 * listed below.
 */

const db = require('../models/db');
const logger = require('./logger');
const { adminAlertRelevanceLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');
const { TERMINAL_ESTIMATE_STATUSES } = require('../utils/estimate-claim-sql');

const RETIRED_BY = 'alert-relevance';
const LOOKBACK_DAYS = 30;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A visit that has finished or will never run: no longer worth a bell that
// asks someone to complete, price or review it. 'rescheduled' stays open (a
// pending reschedule request parks the same row).
const CLOSED_VISIT_STATUSES = new Set([...VISIT_NEVER_RAN_STATUSES, 'completed']);
const CANCELLED_VISIT_STATUSES = new Set(['cancelled', 'canceled']);
// An unsent draft (a restored voided invoice is 'draft' too) or void: no money
// is owed, collected or in flight, so nothing on it can need a refund.
const NO_MONEY_INVOICE_STATUSES = new Set(['draft', 'void']);
// leads.status values that mean staff worked the lead (admin-leads.js
// LEAD_STATUSES + the non-engaged set in lead-statuses.js). 'new' and
// 'contacted' are NOT worked — an automatic first reply sets 'contacted'.
const WORKED_LEAD_STATUSES = new Set([
  'estimate_sent', 'estimate_viewed', 'won', 'lost', 'unresponsive', 'disqualified', 'duplicate', 'spam', 'cancelled',
]);

const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const first = (...vals) => vals.find((v) => v != null && v !== '');

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const m = JSON.parse(metadata); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

function linkParams(link) {
  try { return new URL(String(link || ''), 'http://relevance.local').searchParams; } catch { return new URLSearchParams(); }
}

// Every record an alert points at, from its metadata and deep link. Bad ids
// parse to null/dropped — never a throw.
function refsFromRow(row) {
  const meta = parseMeta(row.metadata);
  const payload = parseMeta(meta.payload);
  const params = linkParams(row.link);
  const visitIds = [first(meta.scheduledServiceId, meta.scheduled_service_id, meta.anchorId, params.get('appointment')),
    ...arr(meta.divergingSiblingIds)].map(uuidOrNull).filter(Boolean);
  const invoiceIds = [first(meta.invoiceId, meta.invoice_id, params.get('invoice')), meta.stampedInvoiceId]
    .map(uuidOrNull).filter(Boolean);
  return {
    meta,
    customerId: uuidOrNull(first(meta.customerId, meta.customer_id, payload.customerId, payload.customer_id, params.get('customerId'))),
    visitId: visitIds[0] || null,
    visitIds: [...new Set(visitIds)],
    invoiceIds: [...new Set(invoiceIds)],
    estimateId: uuidOrNull(first(meta.estimateId, meta.estimate_id, payload.estimateId, params.get('estimateId'))),
    leadId: uuidOrNull(first(payload.leadId, meta.leadId, params.get('lead'))),
  };
}

// Which live records this row is about, resolved against loaded maps (an id
// the maps do not hold resolves to undefined = the record is gone).
function resolveRefs(row, data) {
  const refs = refsFromRow(row);
  const visit = refs.visitId ? data.visits.get(refs.visitId) : undefined;
  const invoices = refs.invoiceIds.map((id) => data.invoices.get(id));
  const lead = refs.leadId ? data.leads.get(refs.leadId) : undefined;
  const estimateId = refs.estimateId || (lead?.estimate_id ? String(lead.estimate_id) : null);
  const estimate = estimateId ? data.estimates.get(estimateId) : undefined;
  const customerId = refs.customerId || first(visit?.customer_id, invoices.find(Boolean)?.customer_id,
    estimate?.customer_id, lead?.customer_id) || null;
  return { refs, visit, invoices, lead, estimate, customerId: customerId ? String(customerId) : null };
}

const emptyData = () => ({
  visits: new Map(), invoices: new Map(), leads: new Map(), estimates: new Map(), customers: new Map(), leadVisits: new Map(),
});
const byId = (rows) => new Map(rows.map((r) => [String(r.id), r]));

// The live records for a batch of notification rows: one query per table per
// batch (the estimate and customer ids are only known once visits, invoices
// and leads are loaded, so those two run second).
async function loadSubjects(rows, conn = db) {
  const data = emptyData();
  const all = rows.map(refsFromRow);
  const ids = (pick) => [...new Set(all.flatMap(pick))];
  const visitIds = ids((r) => r.visitIds);
  const invoiceIds = ids((r) => r.invoiceIds);
  const leadIds = ids((r) => (r.leadId ? [r.leadId] : []));
  if (visitIds.length) {
    data.visits = byId(await conn('scheduled_services as ss')
      .leftJoin('scheduled_services as parent', 'parent.id', 'ss.recurring_parent_id')
      .leftJoin('invoices as fa_invoice', 'fa_invoice.id', 'ss.first_application_invoice_id')
      .whereIn('ss.id', visitIds)
      .select('ss.id', 'ss.customer_id', 'ss.status', 'ss.is_recurring', 'ss.recurring_parent_id',
        'ss.estimated_price', 'ss.primary_line_price', 'ss.prepaid_amount', 'ss.prepaid_method',
        'ss.first_application_invoice_id', 'fa_invoice.status as first_application_invoice_status',
        'parent.estimated_price as parent_estimated_price', 'parent.primary_line_price as parent_primary_line_price'));
  }
  if (invoiceIds.length) {
    data.invoices = byId(await conn('invoices').whereIn('id', invoiceIds).select('id', 'status', 'customer_id'));
  }
  if (leadIds.length) {
    data.leads = byId(await conn('leads').whereIn('id', leadIds)
      .select('id', 'status', 'converted_at', 'deleted_at', 'created_at', 'customer_id', 'estimate_id'));
  }
  const resolved = rows.map((row) => resolveRefs(row, data));
  const estimateIds = [...new Set(resolved.flatMap((r) => [r.refs.estimateId, r.lead?.estimate_id && String(r.lead.estimate_id)]).filter(Boolean))];
  const customerIds = [...new Set(resolved.map((r) => r.customerId).filter(Boolean))];
  const leadCustomerIds = [...new Set([...data.leads.values()].map((l) => l.customer_id && String(l.customer_id)).filter(Boolean))];
  if (estimateIds.length) {
    data.estimates = byId(await conn('estimates').whereIn('id', estimateIds)
      .select('id', 'status', 'archived_at', 'sent_at', 'customer_id'));
  }
  if (customerIds.length) {
    data.customers = byId(await conn('customers').whereIn('id', customerIds).select('id', 'churned_at', 'deleted_at'));
  }
  if (leadCustomerIds.length) {
    const booked = await conn('scheduled_services').whereIn('customer_id', leadCustomerIds)
      .where((q) => q.whereNull('status').orWhereNotIn('status', [...CANCELLED_VISIT_STATUSES]))
      .groupBy('customer_id').select('customer_id').max('created_at as latest_created_at');
    data.leadVisits = new Map(booked.map((r) => [String(r.customer_id), r.latest_created_at]));
  }
  return data;
}

function subjectFor(row, data, todayET) {
  const resolved = resolveRefs(row, data);
  const customer = resolved.customerId ? data.customers.get(resolved.customerId) : undefined;
  return {
    ...resolved,
    meta: resolved.refs.meta,
    todayET,
    customer,
    // Paused customers are NOT left: only churned or soft-deleted ones.
    customerLeft: !!customer && !!(customer.churned_at || customer.deleted_at),
    leadBookedAt: resolved.lead?.customer_id ? data.leadVisits.get(String(resolved.lead.customer_id)) : null,
  };
}

const CUSTOMER_LEFT = 'Customer left';
const customerLeft = (s) => (s.customerLeft ? CUSTOMER_LEFT : null);
// The referenced visit is finished, never-ran, or gone.
const visitClosed = (s) => (s.refs.visitId && (!s.visit || CLOSED_VISIT_STATUSES.has(String(s.visit.status)))
  ? 'Visit is no longer open' : null);

function unpricedSeriesMovedOn(s) {
  const left = customerLeft(s) || visitClosed(s);
  if (left || !s.visit || s.visit.status == null) return left;
  // Same predicate the watchdog uses to raise the alert (price on the row or
  // its parent, an out-of-band prepay stamp, a live first-application invoice).
  const { isUnpricedSeriesVisit } = require('./schedule-integrity-watchdog');
  return isUnpricedSeriesVisit(s.visit) ? null : 'Visit now carries a price or is covered';
}

function seriesMoveMovedOn(s) {
  const dates = [...arr(s.meta.overlapDates), ...arr(s.meta.conflicts).map((c) => c?.date),
    ...arr(s.meta.preservedOccurrences).map((c) => c?.date)]
    .map((d) => String(d || '').slice(0, 10)).filter((d) => DATE_RE.test(d));
  if (dates.length && dates.every((d) => d < s.todayET)) return 'Every flagged date has passed';
  if (s.visit && CANCELLED_VISIT_STATUSES.has(String(s.visit.status))) return 'The moved visit was cancelled';
  return customerLeft(s);
}

function newLeadMovedOn(s) {
  const lead = s.lead;
  // A missing lead row is "unknown", never "gone": the emitter falls back to a
  // customer id when lead creation failed.
  if (!lead) return null;
  if (lead.deleted_at) return 'Lead was deleted';
  if (lead.converted_at) return 'Lead was converted';
  if (WORKED_LEAD_STATUSES.has(String(lead.status))) return `Lead is ${lead.status}`;
  if (s.estimate?.sent_at) return 'Estimate was sent';
  if (s.leadBookedAt && lead.created_at && new Date(s.leadBookedAt) > new Date(lead.created_at)) return 'A visit was booked';
  return null;
}

// Alert classes: category (+ dedupeKey prefix, looked up in each emitter) → a
// rule returning null while the alert is still relevant, else a short reason.
const CLASSES = [
  { // first-application-sibling-split.js raiseDivergenceAlert; never the paid/processing refund + wait kinds
    key: 'first_application_divergence', categories: ['billing'], prefix: 'first_application_sibling_divergence:',
    rule: (s) => (s.customerLeft && s.meta.alertKind === 'diverged' && s.invoices.length
      && s.invoices.every((i) => i && NO_MONEY_INVOICE_STATUSES.has(String(i.status)))
      ? 'Customer left and the combined invoice is an unsent draft or void' : null),
  },
  { // schedule-integrity-watchdog.js class 1
    key: 'unpriced_series', categories: ['alert'], prefix: 'unpriced-series:', rule: unpricedSeriesMovedOn,
  },
  { // emitter removed in #5223; unread rows remain
    key: 'stale_visit', categories: ['alert'], prefix: 'stale-visit:', rule: (s) => customerLeft(s) || visitClosed(s),
  },
  { // schedule-integrity-watchdog.js prepaid-coverage + manual-series-stamp reviews
    key: 'prepay_coverage', categories: ['alert'], prefix: 'prepay-coverage:', rule: (s) => customerLeft(s) || visitClosed(s),
  },
  { // schedule-integrity-watchdog.js accepted-plan review
    key: 'accepted_schedule', categories: ['alert'], prefix: 'accepted-schedule:', rule: customerLeft,
  },
  { // admin-dispatch.js applySeriesMoveEffects
    key: 'series_move', categories: ['schedule_conflict'], match: (meta) => !!meta.seriesMoveId, rule: seriesMoveMovedOn,
  },
  { // estimate-hot-view-alert.js
    key: 'estimate_hot_view', categories: ['estimate_hot_view'],
    rule: (s) => {
      if (!s.estimate) return null;
      if (TERMINAL_ESTIMATE_STATUSES.includes(String(s.estimate.status).toLowerCase())) return `Estimate is ${s.estimate.status}`;
      return s.estimate.archived_at ? 'Estimate is archived' : null;
    },
  },
  { // notification-triggers.js new_lead
    key: 'new_lead', categories: ['new_lead'], match: (meta, row) => !!refsFromRow(row).leadId, rule: newLeadMovedOn,
  },
];

// The class a row belongs to, or null. Category first, then the emitter's
// dedupeKey prefix / extra metadata test.
function classify(row) {
  const meta = parseMeta(row.metadata);
  const dedupeKey = String(meta.dedupeKey || '');
  return CLASSES.find((c) => c.categories.includes(row.category)
    && (!c.prefix || dedupeKey.startsWith(c.prefix))
    && (!c.match || c.match(meta, row))) || null;
}

// Unread admin rows this sweep could judge: recent, bell-visible, of a class
// in the table. Keyset-paged on id: retiring a row removes it from the set,
// so an offset would skip rows.
function candidateQuery(since, cursor) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin' }))
    .whereNull('read_at')
    .where('created_at', '>', since)
    .where((q) => {
      for (const c of CLASSES) {
        q.orWhere((cq) => {
          cq.whereIn('category', c.categories);
          if (c.prefix) cq.whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?", [c.prefix.length, c.prefix]);
        });
      }
    })
    .modify((q) => { if (cursor) q.where('id', '>', cursor); })
    .orderBy('id', 'asc')
    .limit(PAGE_SIZE)
    .select('id', 'category', 'link', 'metadata');
}

// Only while the row is still unread: never races a staff action.
async function retireRow(id, reason, now) {
  return db('notifications')
    .where({ id, recipient_type: 'admin' })
    .whereNull('read_at')
    .update({
      read_at: db.fn.now(),
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
        [JSON.stringify({ retired: { by: RETIRED_BY, reason, at: now.toISOString() } })]),
    });
}

async function runAdminAlertRelevanceSweep({ now = new Date() } = {}) {
  if (!adminAlertRelevanceLive()) return { skipped: true, reason: 'switch_off' };
  const todayET = etDateString(now);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const byClass = {};
  let scanned = 0;
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(since, cursor);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;
    const data = await loadSubjects(rows);
    for (const row of rows) {
      try {
        const cls = classify(row);
        const reason = cls && cls.rule(subjectFor(row, data, todayET));
        if (reason && await retireRow(row.id, reason, now)) byClass[cls.key] = (byClass[cls.key] || 0) + 1;
      } catch (err) {
        logger.warn(`[alert-relevance] notification ${row.id} skipped: ${err.message}`);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  const retired = Object.values(byClass).reduce((a, b) => a + b, 0);
  if (retired) logger.info(`[alert-relevance] retired ${retired} of ${scanned} unread alert(s): ${JSON.stringify(byClass)}`);
  return { skipped: false, scanned, retired, byClass };
}

// Ring-time seam for notification-service.js createPlainAdmin: null when the
// row is not in the table (or the switch is off), else the `ringGate` notifyAdmin
// already runs inside the insert's transaction plus the retired stamp to write
// when it declines. A failed read rings (fail open) — on a savepoint, so the
// caller's transaction is never left aborted.
function ringTimeCheck({ category, link, metadata }) {
  try {
    const row = { category, link, metadata };
    // Classify first: the pure match is cheap and most admin rows are not in the
    // table, so the switch is only read for rows it could apply to.
    const cls = classify(row);
    if (!cls || !adminAlertRelevanceLive()) return null;
    let retired = null;
    return {
      async gate(conn) {
        try {
          const run = (c) => loadSubjects([row], c);
          const data = await (typeof conn.transaction === 'function' ? conn.transaction(run) : run(conn));
          const reason = cls.rule(subjectFor(row, data, etDateString(new Date())));
          if (reason) retired = { by: RETIRED_BY, reason, at: new Date().toISOString() };
          return !reason;
        } catch (err) {
          logger.warn(`[alert-relevance] ring-time check failed for ${cls.key}: ${err.message}`);
          return true;
        }
      },
      stamp: () => (retired ? { retired } : {}),
    };
  } catch (err) {
    // Relevance is advisory: it must never break writing the bell itself.
    logger.warn(`[alert-relevance] ring-time setup failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  runAdminAlertRelevanceSweep,
  ringTimeCheck,
  classify,
  loadSubjects,
  subjectFor,
  refsFromRow,
  CLASSES,
  WORKED_LEAD_STATUSES,
};
