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
 *     retirement of unread rows whose subject has moved on. Unread rows never
 *     age out of it (a refreshed bell keeps its first created_at). Each
 *     retirement is judged on a fresh read right before it is written and
 *     once more after it; a change that landed in between puts the bell back.
 *     No row locks, ever: this sweep is advisory and must never block or fail
 *     a money path (invoice settlement takes the visit FOR UPDATE NOWAIT).
 *   - ringTimeCheck: the ringGate notifyAdmin's existing seam already runs
 *     inside the insert's transaction — a fresh row that has ALREADY moved on
 *     is written activity-only instead of ringing, or, for a re-arm class,
 *     not written at all (notification-service.js createPlainAdmin; the
 *     dedupe/refresh path is untouched).
 *
 * A retire is a PURE `read_at = now` plus `metadata.retired = {by, reason, at}`
 * — never dedupeVersion/autoCleared/invoiceId, so every emitter's own dedupe
 * and recovery logic still sees the row exactly as a human dismissal. The one
 * exception is a class marked `rearm` (first-application divergence, unpriced
 * series, estimate hot view, prepaid-coverage and accepted-plan reviews —
 * every class whose emitter re-raises a stable key): its emitter dedupes on a key
 * the subject's return need not change (forever, or a rolling day), so the
 * key moves into the stamp (`retired.dedupeKey`, `dedupeKey: null`) and a
 * condition that comes back (the price removed again, an estimate restored,
 * a customer reactivated) raises a fresh bell instead of finding this row.
 * An emitter that knows its whole current set can also clear on absence
 * (retireKeysNoLongerRaised, the schedule-integrity watchdog's prepay and
 * accepted-plan reviews), re-arming the same way.
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
  // The alert's own visit first, then every other visit it names: the
  // divergence set, and a series move's windowless conflicts and preserved
  // occurrences (each { id, date }).
  const visitIds = [first(meta.scheduledServiceId, meta.scheduled_service_id, meta.anchorId, params.get('appointment')),
    ...arr(meta.divergingSiblingIds), ...arr(meta.conflicts).map((c) => c?.id),
    ...arr(meta.preservedOccurrences).map((c) => c?.id)].map(uuidOrNull).filter(Boolean);
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
  // The LIVE record's customer wins over the id frozen in the alert: a merge
  // repoints the visit / invoice / estimate / lead to the surviving profile and
  // soft-deletes the old one, which must not read as "customer left".
  const customerId = first(visit?.customer_id, invoices.find(Boolean)?.customer_id,
    estimate?.customer_id, lead?.customer_id, refs.customerId) || null;
  const affectedVisits = refs.visitIds.map((id) => data.visits.get(id));
  return { refs, visit, affectedVisits, invoices, lead, estimate, customerId: customerId ? String(customerId) : null };
}

const emptyData = () => ({
  visits: new Map(), invoices: new Map(), leads: new Map(), estimates: new Map(), customers: new Map(), leadVisits: new Map(),
});
const byId = (rows) => new Map(rows.map((r) => [String(r.id), r]));

// The live records for a batch of notification rows: one query per table per
// batch (the estimate and customer ids are only known once visits, invoices
// and leads are loaded, so those two run second). Plain reads — never a lock.
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
        'ss.annual_prepay_term_id', 'ss.prepaid_at', 'ss.service_type', 'ss.scheduled_date', 'ss.completed_at',
        'ss.first_application_invoice_id', 'fa_invoice.status as first_application_invoice_status',
        'parent.estimated_price as parent_estimated_price', 'parent.primary_line_price as parent_primary_line_price'));
    // The watchdog's second, async coverage step: an annual-prepay stamp
    // suppresses the unpriced page only once annualPrepayCoversVisit validates
    // its term. Same validator, same fail-closed stance (an unverifiable stamp
    // is not coverage, so the alert stays).
    // Inside a transaction — the ring-time savepoint — every failure must
    // surface (the validator's strict mode): its default mode catches a
    // failed query and answers false, which would leave the savepoint's
    // transaction aborted and fail the bell's own insert. Thrown, the
    // savepoint rolls back and the gate rings (fail open). The sweep reads
    // outside a transaction and keeps the fail-closed default.
    const { annualPrepayCoversVisit, ANNUAL_PREPAY_PREPAID_METHOD } = require('./annual-prepay-renewals');
    for (const visit of data.visits.values()) {
      if (visit.prepaid_method !== ANNUAL_PREPAY_PREPAID_METHOD) continue;
      visit.annual_prepay_covered = conn.isTransaction
        ? await annualPrepayCoversVisit(visit, conn, { throwOnError: true })
        : await annualPrepayCoversVisit(visit, conn).catch(() => false);
    }
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
    data.customers = byId(await conn('customers').whereIn('id', customerIds).select('id', 'pipeline_stage', 'churned_at', 'deleted_at'));
  }
  if (leadCustomerIds.length) {
    // A booking someone made: never a child the system generated on its own
    // (the nightly series top-up, a booking's seeded follow-ups) — those land
    // on an existing customer's plan whether or not anyone worked the lead.
    const booked = await conn('scheduled_services').whereIn('customer_id', leadCustomerIds)
      .where((q) => q.whereNull('status').orWhereNotIn('status', [...CANCELLED_VISIT_STATUSES]))
      .whereNull('recurring_parent_id').whereNull('parent_service_id')
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
    // Paused customers are NOT left: only churned or soft-deleted ones. Churned
    // is the LIVE stage — churned_at is history a reactivated customer can
    // still carry (customer-stages.js; email-division eligibility reads the
    // stage the same way).
    customerLeft: !!customer && (customer.pipeline_stage === 'churned' || !!customer.deleted_at),
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
  // Same two steps the watchdog uses to raise the alert: the pure predicate
  // (price on the row or its parent, an out-of-band prepay stamp, a live
  // first-application invoice), then a validated annual-prepay term.
  const { isUnpricedSeriesVisit } = require('./schedule-integrity-watchdog');
  if (!isUnpricedSeriesVisit(s.visit)) return 'Visit now carries a price or is covered';
  return s.visit.annual_prepay_covered ? 'Visit is covered by a paid annual prepay' : null;
}

function seriesMoveMovedOn(s) {
  const dates = [...arr(s.meta.overlapDates), ...arr(s.meta.conflicts).map((c) => c?.date),
    ...arr(s.meta.preservedOccurrences).map((c) => c?.date)]
    .map((d) => String(d || '').slice(0, 10)).filter((d) => DATE_RE.test(d));
  if (dates.length && dates.every((d) => d < s.todayET)) return 'Every flagged date has passed';
  // Every visit the move named — the moved one, its windowless conflicts, its
  // preserved occurrences — must be settled: cancelling only the moved visit
  // leaves the others' dispatch work standing.
  if (s.affectedVisits.length && s.affectedVisits.every((v) => !v || CLOSED_VISIT_STATUSES.has(String(v.status)))) {
    return 'Every visit it named is closed';
  }
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
  { // first-application-sibling-split.js raiseDivergenceAlert; never the paid/processing refund + wait kinds.
    // Its sweep re-raises the same key with a fingerprint that holds neither the invoice status
    // nor the customer's stage, so a retire re-arms: an invoice later sent, or the customer back, rings
    key: 'first_application_divergence', categories: ['billing'], prefix: 'first_application_sibling_divergence:', rearm: true,
    rule: (s) => (s.customerLeft && s.meta.alertKind === 'diverged' && s.invoices.length
      && s.invoices.every((i) => i && NO_MONEY_INVOICE_STATUSES.has(String(i.status)))
      ? 'Customer left and the combined invoice is an unsent draft or void' : null),
  },
  { // schedule-integrity-watchdog.js class 1 — forever-deduped on a stable key, so a retire re-arms it
    key: 'unpriced_series', categories: ['alert'], prefix: 'unpriced-series:', rule: unpricedSeriesMovedOn, rearm: true,
  },
  { // emitter removed in #5223; unread rows remain
    key: 'stale_visit', categories: ['alert'], prefix: 'stale-visit:', rule: (s) => customerLeft(s) || visitClosed(s),
  },
  { // schedule-integrity-watchdog.js prepaid-coverage + manual-series-stamp reviews — a
    // forever dedupe on an evidence key a reactivation need not change, so a retire re-arms it
    key: 'prepay_coverage', categories: ['alert'], prefix: 'prepay-coverage:', rule: (s) => customerLeft(s) || visitClosed(s), rearm: true,
  },
  { // schedule-integrity-watchdog.js accepted-plan review — a stable key refreshed only when
    // its schedule evidence changes, so a reactivated customer's gap needs the key back
    key: 'accepted_schedule', categories: ['alert'], prefix: 'accepted-schedule:', rule: customerLeft, rearm: true,
  },
  { // admin-dispatch.js applySeriesMoveEffects
    key: 'series_move', categories: ['schedule_conflict'], match: (meta) => !!meta.seriesMoveId, rule: seriesMoveMovedOn,
  },
  { // estimate-hot-view-alert.js — a 24-hour rolling dedupe on a stable key, and an
    // archived or closed estimate can be restored, so a retire re-arms it too
    key: 'estimate_hot_view', categories: ['estimate_hot_view'], rearm: true,
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

// Unread admin rows this sweep could judge: bell-visible, of a class in the
// table, of any age (a refreshed bell keeps its first created_at, so an age
// cut-off would hide a re-rung one for good). Keyset-paged on id: retiring a
// row removes it from the set, so an offset would skip rows.
function candidateQuery(cursor) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin' }))
    .whereNull('read_at')
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

// The row as the batch read it, still: a refresh that rewrote it since is
// left for the next sweep to judge.
const sameRow = (a, b) => a.category === b.category && (a.link || null) === (b.link || null)
  && JSON.stringify(parseMeta(a.metadata)) === JSON.stringify(parseMeta(b.metadata));

// The same predicate as a write condition: the retire lands only on the
// version it judged (category, link and metadata — everything the rule reads),
// never on a bell an emitter refreshed in between.
const sameVersion = (q, row) => q.where('category', row.category)
  .whereRaw('link IS NOT DISTINCT FROM ?', [row.link ?? null])
  .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [row.metadata == null ? null : JSON.stringify(parseMeta(row.metadata))]);

// The bell as it read before this module's stamp: no `retired`, and a re-arm
// class's key back in place.
function unretired(metadata) {
  const { retired, ...meta } = parseMeta(metadata);
  return retired?.dedupeKey && meta.dedupeKey == null ? { ...meta, dedupeKey: retired.dedupeKey } : meta;
}

// Judges one row on a fresh read and retires it only if it is still moved on
// and still the version judged, then judges it once more AFTER the write, on
// the bell as it stands then (a quiet refresh rewrites content without
// touching read_at): a change that landed between the read and the write (a
// payment starting on a churned customer's draft, a lead reopened) puts the
// bell back — unless a person has read it since (their read_at wins), or a
// refresh rang it again (the emitter's). No row locks: see the module header.
// A change after the final judgement is a new event its emitter raises.
async function retireIfStillMovedOn(row, cls, todayET, now) {
  const current = await db('notifications').where({ id: row.id, recipient_type: 'admin' }).whereNull('read_at')
    .first('id', 'category', 'link', 'metadata');
  if (!current || !sameRow(current, row)) return null;
  const reason = cls.rule(subjectFor(current, await loadSubjects([current]), todayET));
  if (!reason) return null;
  const { dedupeKey } = parseMeta(current.metadata);
  const rearm = cls.rearm && dedupeKey ? { dedupeKey: null } : {};
  const stamp = { by: RETIRED_BY, reason, at: now.toISOString(), ...(rearm.dedupeKey === null ? { dedupeKey } : {}) };
  // An explicit millisecond instant, not NOW(): Postgres keeps microseconds,
  // which a JS Date read back would truncate, and the put-back below must
  // match the exact read_at this write stored.
  const readAt = new Date();
  const [retired] = await sameVersion(db('notifications').where({ id: row.id, recipient_type: 'admin' }).whereNull('read_at'), current)
    .update({ read_at: readAt, metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ retired: stamp, ...rearm })]) })
    .returning(['id']);
  if (!retired) return null;
  const stillOurs = (q) => q.where({ id: row.id, read_at: readAt }).whereRaw("metadata->'retired'->>'at' = ?", [stamp.at]);
  const latest = await stillOurs(db('notifications')).first('id', 'category', 'link', 'metadata');
  if (!latest) return null;
  const judged = { ...latest, metadata: unretired(latest.metadata) };
  if (cls.rule(subjectFor(judged, await loadSubjects([judged]), todayET))) return reason;
  await stillOurs(db('notifications'))
    .update({ read_at: null, metadata: db.raw("(metadata - 'retired') || ?::jsonb", [JSON.stringify(rearm.dedupeKey === null ? { dedupeKey } : {})]) });
  return null;
}

// An emitter's clear-on-absence (schedule-integrity-watchdog.js): after a
// COMPLETE scan, every unread bell under `prefix` whose key the scan no longer
// raised is retired with the sweep's own stamp — the gap was fixed, or its
// evidence changed and the scan raised a new key beside it. It re-arms, as a
// `rearm` class does: the key moves into the stamp, so the same gap raised
// again later (a customer reactivated, an estimate restored) is a new bell.
// A pure read_at + stamp like every other retire; no row locks; a person's
// read is untouched.
async function retireKeysNoLongerRaised({ category = 'alert', prefix, liveKeys, reason, now = new Date() }) {
  if (!adminAlertRelevanceLive()) return 0;
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  const stamp = { by: RETIRED_BY, reason, at: now.toISOString() };
  const retired = await excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin', category }))
    .whereNull('read_at')
    .whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?", [prefix.length, prefix])
    .whereRaw("NOT (metadata->>'dedupeKey' = ANY(?::text[]))", [liveKeys])
    .update({
      read_at: new Date(),
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('retired', ?::jsonb || jsonb_build_object('dedupeKey', metadata->'dedupeKey'), 'dedupeKey', NULL)", [JSON.stringify(stamp)]),
    })
    .returning(['id']);
  return retired.length;
}

// A backlog bigger than one run (MAX_PAGES pages) is walked across runs: a
// run that stops at the cap leaves where it stopped, and the next run
// resumes after it; a run that reaches the end leaves nothing, so the next
// one starts over. In-process: a restart simply starts over.
let resumeAfter = null;

async function runAdminAlertRelevanceSweep({ now = new Date() } = {}) {
  if (!adminAlertRelevanceLive()) return { skipped: true, reason: 'switch_off' };
  const todayET = etDateString(now);
  const byClass = {};
  let scanned = 0;
  let cursor = resumeAfter;
  resumeAfter = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(cursor);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;
    if (rows.length === PAGE_SIZE && page === MAX_PAGES - 1) resumeAfter = cursor;
    const data = await loadSubjects(rows);
    for (const row of rows) {
      try {
        const cls = classify(row);
        // The batch read is a first pass: only a row that looks moved on pays
        // for the fresh recheck that actually retires it.
        if (!cls || !cls.rule(subjectFor(row, data, todayET))) continue;
        if (await retireIfStillMovedOn(row, cls, todayET, now)) byClass[cls.key] = (byClass[cls.key] || 0) + 1;
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
// when it declines. A re-arm class declined there writes no row at all
// (`skip`): a quiet row would either keep its key — and swallow the bell when
// the subject comes back — or free it and add one row per emitter run while
// the subject stays gone. A failed read rings (fail open) — on a savepoint, so
// the caller's transaction is never left aborted.
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
          if (reason && cls.rearm) logger.info(`[alert-relevance] ${cls.key} not raised: ${reason}`);
          return !reason;
        } catch (err) {
          logger.warn(`[alert-relevance] ring-time check failed for ${cls.key}: ${err.message}`);
          return true;
        }
      },
      stamp: () => (retired ? { retired } : {}),
      skip: () => Boolean(retired) && Boolean(cls.rearm),
    };
  } catch (err) {
    // Relevance is advisory: it must never break writing the bell itself.
    logger.warn(`[alert-relevance] ring-time setup failed: ${err.message}`);
    return null;
  }
}

// A row the ring-time check wrote activity-only (its subject had already
// moved on): nothing rang. A sweep retirement never sets feed 'activity', and
// a later ringing refresh replaces the row's feed, so neither reads as
// quieted here.
function quietedAtRingTime(row) {
  const meta = parseMeta(row?.metadata);
  return meta.feed === 'activity' && meta.retired?.by === RETIRED_BY;
}

// Whether a trigger's push stays silent because the event's subject has
// already moved on: its bell row was written activity-only at ring time, or —
// when no bell row was written at all (every admin who gets the event has the
// bell off and push on) — the same verdict judged here directly, so the
// push-only path is as quiet as the bell would have been. Fails open (pushes).
async function pushIsMovedOn({ bellRow, bellWritten, pushTo, category, link, metadata }) {
  if (bellRow && quietedAtRingTime(bellRow)) return true;
  if (bellWritten || !pushTo?.length) return false;
  try {
    const row = { category, link, metadata };
    const cls = classify(row);
    if (!cls || !adminAlertRelevanceLive()) return false;
    return !!cls.rule(subjectFor(row, await loadSubjects([row]), etDateString(new Date())));
  } catch (err) {
    logger.warn(`[alert-relevance] push-only check failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  runAdminAlertRelevanceSweep,
  retireKeysNoLongerRaised,
  quietedAtRingTime,
  pushIsMovedOn,
  ringTimeCheck,
  classify,
  loadSubjects,
  subjectFor,
  refsFromRow,
  CLASSES,
  WORKED_LEAD_STATUSES,
};
