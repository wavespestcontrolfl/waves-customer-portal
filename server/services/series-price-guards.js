'use strict';

// Series price guards (GATE_SERIES_PRICE_GUARDS, dark by default).
//
// Two leaks let a wrong visit price reach a customer with nobody told:
//   1. A series extension (the completion auto-extend and the nightly
//      top-up, both extendSeriesOnceLocked in routes/admin-schedule.js)
//      templates every new child from the series ROOT row, whatever its
//      status. A root imported with a prepay total, then cancelled, keeps
//      pricing every child at that total.
//   2. A performed visit with no billable amount completes with only a
//      logger.warn, and only on two billing lanes.
// The extension guard compares the child's computed price with what the
// series actually COLLECTED: the paid invoice of its most recent completed
// visit. Over by more than 25% → the child is still inserted (scheduling is
// never blocked) and the office is told. A CANCELLED root is held to the
// same comparison but fails closed: no paid visit to corroborate the price,
// or a price over it, and the extension is skipped and the office told.
// Templating from the newest live member instead was rejected: a child can
// carry a this-visit-only price edit, so "newest live member" is not the
// series price.
//
// Every alert goes through raiseAdminAlert (docs/admin-notifications.md).
// The extension alerts are raised only after the extension's transaction
// COMMITS (customer-credit.js afterCommit): the top-up's dry run rolls back,
// and a rolled-back skip or insert must not ring.

const db = require('../models/db');
const logger = require('./logger');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');

// Child price may exceed the last paid amount by at most this ratio.
const OVER_LAST_PAID_RATIO = 1.25;
// done_by of the cancelled-root alert this module closes itself.
const CLOSED_BY = 'series-price-guard';

function seriesPriceGuardsLive() {
  return require('../config/feature-gates').isEnabled('seriesPriceGuards');
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const positiveAmount = (value) => {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

// The amount a paid invoice proves for ONE visit, or null when it cannot:
// every positive line must be that visit's own charge (client_id
// `scheduled_<visit>_primary` / `scheduled_<visit>_addon_…`, the tags
// InvoiceService.createFromService writes). A combined first-application
// invoice (setup fee beside the application) or one covering several
// services carries other charges and is not comparable. Pre-tax, with an
// applied estimate deposit (a prior payment InvoiceService.create nets out
// of total, not a discount) added back.
function comparableVisitAmount(invoice) {
  let lines = invoice?.line_items;
  try { lines = typeof lines === 'string' ? JSON.parse(lines) : lines; } catch { return null; }
  const charges = (Array.isArray(lines) ? lines : [])
    .filter((li) => li && Number(li.amount) > 0 && li.category !== 'deposit_credit');
  const own = `scheduled_${invoice.visit_id}_`;
  if (!charges.length || !charges.every((li) => String(li.client_id || '').startsWith(own))) return null;
  const { invoiceDepositCreditCents } = require('./invoice-helpers');
  const cents = Math.round(Number(invoice.total) * 100) + invoiceDepositCreditCents(invoice)
    - Math.round((Number(invoice.tax_amount) || 0) * 100);
  return positiveAmount(cents / 100);
}

// What the series last collected: the newest PAID invoice, comparable for
// its visit (comparableVisitAmount), on a completed BASE visit — is_recurring,
// not a callback (boosters share recurring_parent_id with is_recurring false,
// as latestLiveSeriesVisit in admin-schedule.js excludes them; a free
// re-service is no price evidence). Newest PAID, not newest completed: the
// visit whose completion triggered the extension usually has an open or
// processing invoice yet. The invoice is tied to the visit by
// scheduled_service_id or through its service record. null when none of the
// newest few qualifies — the comparison is then skipped.
const BASELINE_CANDIDATES = 10;
async function lastPaidSeriesVisitAmount(conn, rootId) {
  const invoices = await conn('invoices as i')
    .leftJoin('service_records as sr', 'sr.id', 'i.service_record_id')
    .join('scheduled_services as ss', (j) => j.on(conn.raw('ss.id = COALESCE(i.scheduled_service_id, sr.scheduled_service_id)')))
    .where((q) => q.where('ss.id', rootId).orWhere('ss.recurring_parent_id', rootId))
    .where('ss.is_recurring', true)
    .where((q) => q.whereNull('ss.is_callback').orWhere('ss.is_callback', false))
    .where('ss.status', 'completed')
    .where('i.status', 'paid')
    .orderBy('ss.scheduled_date', 'desc')
    .orderBy('i.created_at', 'desc')
    .limit(BASELINE_CANDIDATES)
    .select('ss.id as visit_id', 'i.total', 'i.tax_amount', 'i.line_items');
  for (const invoice of invoices || []) {
    const amount = comparableVisitAmount(invoice);
    if (amount != null) return amount;
  }
  return null;
}

// Any annual-prepay term link on any visit of the series. The link can sit
// on a child only (prepay activated mid-series never links the older root —
// seriesTermIds in admin-schedule.js), so the root alone is not enough.
// Discovery only: such a series is left to applyExtensionPrepayCoverage and
// never held or alerted here.
async function seriesCarriesPrepayTerm(conn, parentId, parent) {
  if (parent?.annual_prepay_term_id) return true;
  const linked = await conn('scheduled_services')
    .where((q) => q.where('id', parentId).orWhere('recurring_parent_id', parentId))
    .whereNotNull('annual_prepay_term_id')
    .first('id');
  return !!linked;
}

// What the guard compares for one extension child: its price, what the series
// last collected and whether the price is over that by more than the ratio.
// null when the child is exempt (callback / always-free, unpriced, annual-prepay
// series: see below), which reads nothing further. Shared by the verdict and by
// the alert closer, so both judge the same facts.
async function extensionPriceFacts(conn, { parent, parentId, child }) {
  const price = positiveAmount(child?.estimated_price);
  if (!price || child?.is_callback || isAlwaysFreeServiceType(child?.service_type)) return null;
  if (await seriesCarriesPrepayTerm(conn, parentId, parent)) return null;
  const lastPaid = await lastPaidSeriesVisitAmount(conn, parentId);
  const over = lastPaid != null && Math.round(price * 100) > Math.round(lastPaid * OVER_LAST_PAID_RATIO * 100);
  return { price, lastPaid, over };
}

// The verdict for one extension child about to be inserted. null = insert
// as before, no alert. Callers check seriesPriceGuardsLive() first, so the
// gate-off path makes no reads at all.
//   { skip: true, kind: 'cancelled_root', price, lastPaid }  → do not insert
//   { skip: false, kind: 'over_last_paid', price, lastPaid } → insert, alert
// Exempt: callback / always-free children (never priced), unpriced children
// (the billable-amount gate owns those), and an annual-prepay series (its
// visits are settled by the term, not billed per visit).
async function extensionPriceVerdict(conn, { parent, parentId, child }) {
  const facts = await extensionPriceFacts(conn, { parent, parentId, child });
  if (!facts) return null;
  const { price, lastPaid, over } = facts;
  if (parent?.status === 'cancelled' && (lastPaid == null || over)) {
    return { skip: true, kind: 'cancelled_root', price, lastPaid };
  }
  return over ? { skip: false, kind: 'over_last_paid', price, lastPaid } : null;
}

// A prepaid stamp on the inserted row (applyExtensionPrepayCoverage runs
// after the insert) means nobody is billed this price — no alert.
async function insertedRowIsPrepaid(conn, rowId) {
  const row = await conn('scheduled_services').where({ id: rowId })
    .first('prepaid_method', 'prepaid_amount', 'annual_prepay_term_id');
  return !!(row && (row.annual_prepay_term_id || row.prepaid_method || positiveAmount(row.prepaid_amount)));
}

function visitLink(visitId, dateStr) {
  return `/admin/dispatch?tab=schedule&date=${encodeURIComponent(dateStr)}&appointment=${encodeURIComponent(visitId)}`;
}

async function raiseExtensionPriceAlert(verdict, { parent, parentId, childId, childDate, serviceLabel }, trx = null) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const names = require('./admin-alert-names');
  const name = await names.lookupCustomerName(db, parent.customer_id) || 'a customer';
  const day = names.shortDateET(new Date(`${childDate}T12:00:00Z`));
  const service = serviceLabel || 'service';
  const lastPaidWords = verdict.lastPaid != null ? `the last paid visit was ${money(verdict.lastPaid)}` : 'no paid visit to compare';
  const cancelled = verdict.kind === 'cancelled_root';
  const spec = cancelled
    ? {
      area: 'Schedule',
      action: names.fitAction('Schedule', name, [(n) => `check ${n}'s plan price`]),
      why: `Not added: the ${day} visit would bill ${money(verdict.price)} from a cancelled first visit, ${lastPaidWords}.`,
      link: `/admin/customers?customerId=${encodeURIComponent(parent.customer_id)}`,
      subject: { type: 'visit', id: String(parentId) },
      doneWhen: 'plan_price_checked',
    }
    : {
      area: 'Billing',
      action: names.fitAction('Billing', name, [(n) => `check ${n}'s ${day} visit price`, (n) => `check ${n}'s visit price`]),
      why: `The ${day} visit was added at ${money(verdict.price)}; ${lastPaidWords}.`,
      link: visitLink(childId, childDate),
      subject: { type: 'visit', id: String(childId) },
      doneWhen: 'visit_price_checked',
    };
  const detail = cancelled
    ? `A ${service} plan did not add its ${day} visit. Its price is copied from the plan's first visit, which is cancelled, and ${money(verdict.price)} is not backed by what the plan has collected (${lastPaidWords}). Check the plan price and rebook the plan at the right price.`
    : `A ${service} plan added its ${day} visit at ${money(verdict.price)}, more than 25% over the plan's last paid visit (${money(verdict.lastPaid)}). Check the price before the visit is billed.`;
  // One open row per series and kind: a top-up run can add many children at
  // the same price, and the nightly run re-meets a cancelled root every night.
  const dedupeKey = cancelled ? cancelledRootDedupeKey(parentId) : `series-price-guard:over-last-paid:${parentId}`;
  // The cancelled-root bell names the occurrence the top-up refused NOW
  // (metadata.refusedDate). The nightly run meets the same cancelled root every
  // night, so the standing open row is refreshed through notifyAdmin's own
  // refresh-on-dedupe (under its dedupe lock): body, detail and refusedDate
  // change together, quietly (no ring, no bump). The refused date is the
  // dedupeVersion, so a row raised before the date existed picks it up even when
  // its text is the same. A closed row is never touched (dedupeOpenOnly).
  const refresh = cancelled
    ? { refreshOnDedupe: true, dedupeVersion: childDate, ringOnRefresh: () => false }
    : {};
  return raiseAdminAlert('billing', { ...spec, severity: 'needs-you', who: 'person' }, {
    bell: true,
    dedupeKey,
    dedupeOpenOnly: true,
    ...refresh,
    ...(trx ? { trx } : {}),
    detail,
    metadata: {
      dedupeKey, kind: verdict.kind, seriesRootId: parentId, scheduledServiceId: childId || null,
      customerId: parent.customer_id, price: verdict.price, lastPaid: verdict.lastPaid,
      ...(cancelled ? { refusedDate: childDate } : {}),
    },
  });
}

const cancelledRootDedupeKey = (rootId) => `series-price-guard:cancelled-root:${rootId}`;

// The conditional close, on the savepoint `sp` of the extension's transaction.
async function closeStandingRefusedAlert(sp, { parent, parentId, child, childDate, childId }) {
  const standing = () => sp('notifications')
    .where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw("metadata->>'dedupeKey' = ?", [cancelledRootDedupeKey(parentId)])
    .whereRaw("metadata->>'refusedDate' = ?", [childDate]);
  if (!(await standing().first('id'))) return false;
  if (await insertedRowIsPrepaid(sp, childId)) return false;
  const facts = await extensionPriceFacts(sp, { parent, parentId, child });
  if (!facts || facts.lastPaid == null || facts.over) return false;
  const { doneColumns } = require('./notification-service')._private;
  const closed = await standing().update(doneColumns({
    by: CLOSED_BY, resolution: 'The plan added the visit it had held, at a price its last paid visit backs', conn: sp,
  })).returning('id');
  return closed.length > 0;
}

// The bell closes itself only on this proof: the guard's own extension later
// ADDED the very occurrence it had refused (same series root, same scheduled
// date, metadata.refusedDate), the child priced afresh from today's template and
// due add-ons, and a paid visit of the series backs that price (not over 125% of
// it). No stored price is re-read, and a cheaper occurrence on another date
// proves nothing. Called inside the extension's transaction right after the
// insert, only when the guard is live and returned no verdict. The close is a
// conditional update in that same transaction, so a rolled-back dry run undoes
// the insert and the close together; it runs in a savepoint, so a failed close
// is logged and can never abort the visit insert.
async function closeRefusedPriceAlertAfterInsert(conn, args) {
  if (!seriesPriceGuardsLive() || !args.childDate || !args.childId) return false;
  try {
    return await conn.transaction((sp) => closeStandingRefusedAlert(sp, args));
  } catch (err) {
    logger.warn(`[series-price-guard] could not close the plan price alert for series ${args.parentId}: ${err.message}`);
    return false;
  }
}

// The cancelled-root refusal bell, written INSIDE the refusal's own transaction
// (notifyAdmin's `trx`: its dedupe lock, probe and insert run on `conn`, and its
// phone banner waits for the outermost commit). The refusal and its bell commit
// or roll back together (a dry run leaves no bell), and the series lock the
// extension holds also covers the bell: a corrected retry can only run after
// this commit, so it finds the bell and closes it, and a bell for a visit that
// was already added can never appear late. Savepoint: a failed write is logged and
// never aborts the extension's transaction.
async function raiseExtensionPriceAlertInTransaction(conn, verdict, context) {
  try {
    const created = await conn.transaction((sp) => raiseExtensionPriceAlert(verdict, context, sp));
    if (!created) logger.error(`[series-price-guard] ${verdict.kind} alert NOT recorded for series ${context.parentId}`);
  } catch (err) {
    logger.error(`[series-price-guard] ${verdict.kind} alert failed for series ${context.parentId}: ${err.message}`);
  }
}

// Raise the alert once `conn`'s transaction commits (never on rollback). Only
// the over-last-paid alert: its visit is already inserted, so a late row is harmless.
function raiseExtensionPriceAlertAfterCommit(conn, verdict, context) {
  require('./customer-credit').afterCommit(conn, async () => {
    try {
      const created = await raiseExtensionPriceAlert(verdict, context);
      if (!created) logger.error(`[series-price-guard] ${verdict.kind} alert NOT recorded for series ${context.parentId}`);
    } catch (err) {
      logger.error(`[series-price-guard] ${verdict.kind} alert failed for series ${context.parentId}: ${err.message}`);
    }
  });
}

// A performed visit that completed with no billable amount and nothing
// billed or covering it. Pure — the completion flow passes its own hoisted
// derivations. A reviewed price (set at completion, $0 included) is the
// tech's explicit decision and is not flagged; so is an authoritative $0 on
// the visit (billing-lane.js hasAuthoritativeZeroPrice: discounted to $0, or
// any stamped $0 under GATE_STAMPED_ZERO_FREE — "$0 means charge nothing").
function unbilledCompletionAlertDue({
  visitPerformed, isCallback, serviceType, reviewedVisitPrice, authoritativeZeroPrice, invoiceAmount,
  prepaidCovered, autopayCoversVisit, alreadyPaid, invoice, invoiceCreated,
}) {
  return !!visitPerformed && !isCallback && !isAlwaysFreeServiceType(serviceType)
    && !reviewedVisitPrice && !authoritativeZeroPrice && !(Number(invoiceAmount) > 0)
    && !prepaidCovered && !autopayCoversVisit
    && !alreadyPaid && !invoice && !invoiceCreated;
}

async function raiseUnbilledCompletionAlert(svc) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const names = require('./admin-alert-names');
  const { truncateAtWord } = require('./ops-digest');
  const name = names.fullName(svc) || await names.lookupCustomerName(db, svc.customer_id) || 'a customer';
  const dateStr = String(svc.scheduled_date instanceof Date ? svc.scheduled_date.toISOString() : svc.scheduled_date || '').slice(0, 10);
  const day = dateStr ? names.shortDateET(new Date(`${dateStr}T12:00:00Z`)) : '';
  const service = svc.service_type || 'Visit';
  const priceWords = svc.estimated_price == null || svc.estimated_price === '' ? 'no price on file' : `price on file ${money(svc.estimated_price)}`;
  const dedupeKey = `unbilled-completion:${svc.id}`;
  return raiseAdminAlert('billing', {
    area: 'Billing',
    action: names.fitAction('Billing', name, day
      ? [(n) => `bill ${n}'s ${day} visit`, (n) => `bill ${n}'s visit`]
      : [(n) => `bill ${n}'s visit`]),
    why: `${truncateAtWord(service, 40)} completed with no invoice, ${priceWords}.`,
    severity: 'needs-you',
    who: 'person',
    link: dateStr ? visitLink(svc.id, dateStr) : `/admin/customers?customerId=${encodeURIComponent(svc.customer_id)}`,
    subject: { type: 'visit', id: String(svc.id) },
    doneWhen: 'visit_billed',
  }, {
    bell: true,
    dedupeKey,
    detail: `${service}${day ? ` on ${day}` : ''} was completed with no billable amount (${priceWords}), and no invoice, prepay, or dues covers it. Bill it by hand or confirm it was meant to be free.`,
    metadata: { dedupeKey, scheduledServiceId: svc.id, customerId: svc.customer_id, billingMode: svc.cust_billing_mode || null },
  });
}

module.exports = {
  OVER_LAST_PAID_RATIO,
  seriesPriceGuardsLive,
  comparableVisitAmount,
  lastPaidSeriesVisitAmount,
  extensionPriceVerdict,
  insertedRowIsPrepaid,
  closeRefusedPriceAlertAfterInsert,
  raiseExtensionPriceAlert,
  raiseExtensionPriceAlertInTransaction,
  raiseExtensionPriceAlertAfterCommit,
  unbilledCompletionAlertDue,
  raiseUnbilledCompletionAlert,
};
