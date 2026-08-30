'use strict';

/**
 * Facts loader — everything the resolver may read about a customer, all of
 * it already stored in the portal. Hard facts only (tenure, paid visits,
 * balance, findings, callbacks, prior offers); never a churn/risk score
 * (owner ruling 2026-08-29: that signal is broken and nothing keys on it).
 *
 * Every leg is wrapped, and failures resolve in the SAFE direction: a
 * card-slot fact miss drops the card (never an invented number), while a
 * money-critical fact miss BLOCKS the offer (fail closed — see the
 * moneyFactsDegraded mapping below). A facts miss can never block a cancel.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('../invoice-helpers');

const COMPLAINT_CATEGORIES = ['pest_issue', 'lawn_concern', 'billing'];
// Nonterminal = anything not in admin-requests' TERMINAL_STATUSES —
// 'acknowledged'/'scheduled' complaints are still open complaints.
const TERMINAL_REQUEST_STATUSES = ['resolved', 'closed', 'cancelled'];
const DAY_MS = 86400000;

function daysAgo(n, now) {
  return new Date(now.getTime() - n * DAY_MS);
}

function dateOnly(value) {
  if (!value) return null;
  // DATE columns arrive as 'YYYY-MM-DD' strings — pass through untouched.
  if (typeof value === 'string') return value.slice(0, 10);
  // Timestamps convert on the ET calendar (AGENTS.md America/New_York rule):
  // toISOString() is UTC and misdates anything after 8 PM ET by a day.
  try {
    return etDateString(value);
  } catch {
    return null;
  }
}

function laneForServiceLine(line) {
  const s = String(line || '').toLowerCase();
  if (s.startsWith('lawn')) return 'lawn';
  if (s.startsWith('pest')) return 'pest';
  return null;
}

async function leg(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[cancellation-resolution] facts.${name} failed: ${err.message}`);
    return fallback;
  }
}

function num(row, key) {
  return Number((row && row[key]) || 0) || 0;
}

// Cancellation-specific row predicate. Deliberately NOT
// serviceRowCountsTowardWaveGuard: that helper is for TIER COVERAGE and
// rejects terminal statuses including 'rescheduled' and 'completed' — but
// for cancel-scope evidence a date-exempt rescheduled row or a completed
// row still carrying recurring_ongoing=true IS the plan being cancelled
// (mirrors cancellation-eligibility's reach). Callbacks and one-time
// bookings are still never plan evidence.
function rowIsCancellationFamilyEvidence(row, { isOneTimeBookingSource }) {
  if (isOneTimeBookingSource(row.source)) return false;
  if (row.is_callback === true || row.is_callback === 1 || row.is_callback === '1' || row.is_callback === 'true') return false;
  // A CANCELLED row still carries family evidence when it is the parent of
  // a live series (this_only cancellation keeps recurring_ongoing=true by
  // design and hasCancellableWork treats it as an active plan); a cancelled
  // one-off carries none.
  if (String(row.status || '').toLowerCase() === 'cancelled' && row.recurring_ongoing !== true) return false;
  const recurring = row.is_recurring === true || row.is_recurring === 1 || row.is_recurring === '1' || row.is_recurring === 'true'
    || row.recurring_ongoing === true;
  return recurring;
}

async function loadFamilies(customerId, today, dbh = db) {
  const {
    detectWaveGuardPlanKeys, isOneTimeBookingSource, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  // Mirrors hasCancellableWork's reach (cancellation-eligibility): an
  // ongoing recurring series indicates its family regardless of the row's
  // date, and 'rescheduled' rows are date-exempt rebook intents — an
  // account that CAN cancel must never resolve with families=[] (that would
  // suppress away/health/retention cards for exactly the plans being
  // cancelled).
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where(function familyEvidence() {
      this.where('s.recurring_ongoing', true)
        .orWhere(function upcoming() {
          this.whereNotIn('s.status', ['cancelled', 'completed'])
            .where(function dateOrRescheduled() {
              this.where('s.scheduled_date', '>=', today).orWhere('s.status', 'rescheduled');
            });
        });
    })
    .select('s.*', 'sv.service_key', 'sv.service_name');
  const keys = [];
  for (const row of rows) {
    if (!rowIsCancellationFamilyEvidence(row, { isOneTimeBookingSource })) continue;
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!keys.includes(key)) keys.push(key);
  }
  // A LIVE annual-prepay term is a plan to cancel even with zero schedule
  // rows (coverage visits carry recurring_ongoing=false and the last visit
  // can precede term_end by months — the same reach hasCancellableWork
  // has). Derive its family from the term's anchor visit, falling back to
  // the plan label text.
  try {
    const { coveredTermsAsOf } = require('../annual-prepay-renewals');
    const terms = await coveredTermsAsOf(dbh, today)
      .where('t.customer_id', customerId)
      .select('t.plan_label', 't.last_scheduled_service_id');
    for (const term of terms || []) {
      let anchorKeys = [];
      if (term.last_scheduled_service_id) {
        const anchor = await dbh('scheduled_services as s')
          .leftJoin('services as sv', 's.service_id', 'sv.id')
          .where('s.id', term.last_scheduled_service_id)
          .first('s.*', 'sv.service_key', 'sv.service_name');
        if (anchor && !isCommercialServiceRow(anchor) && !isRodentLedServiceRow(anchor)) {
          anchorKeys = detectWaveGuardPlanKeys(anchor);
        }
      }
      if (!anchorKeys.length && term.plan_label) {
        anchorKeys = detectWaveGuardPlanKeys({ service_type: term.plan_label });
      }
      for (const key of anchorKeys) if (!keys.includes(key)) keys.push(key);
    }
  } catch (err) {
    logger.warn(`[cancellation-resolution] prepay family evidence failed for ${customerId}: ${err.message}`);
  }
  return uniqueServiceFamilies(keys);
}

async function loadCancellationFacts(customerId, { now = new Date(), dbh = db } = {}) {
  if (!customerId) throw new Error('loadCancellationFacts requires customerId');
  const today = etDateString();
  const since12mo = daysAgo(365, now);

  const customer = await dbh('customers')
    .where({ id: customerId })
    .first('id', 'member_since', 'created_at', 'waveguard_tier', 'monthly_rate', 'billing_mode', 'termite_stations_rented', 'autopay_enabled');
  if (!customer) return null;

  const memberSince = customer.member_since || customer.created_at;
  // Tenure in ET calendar days (AGENTS.md America/New_York rule): the
  // 365-day money threshold must not shift around ET midnight or DST, so
  // both endpoints become ET dates before the day arithmetic.
  let tenureDays = 0;
  if (memberSince) {
    const startEt = dateOnly(memberSince);
    const endEt = etDateString(now);
    if (startEt && endEt) {
      const toUtcMs = (str) => {
        const [y, m, d] = str.split('-').map(Number);
        return Date.UTC(y, m - 1, d);
      };
      tenureDays = Math.max(0, Math.round((toUtcMs(endEt) - toUtcMs(startEt)) / DAY_MS));
    }
  }

  const [
    visitCounts, paidVisitCounts, visits12mo, callbacks12mo, callbackRows12mo, reschedules12mo, savings12mo, pastDue, failedPayment,
    findings, earliestFinding, complaintRequest, priorOffer, manualOverride, shownCases, termite, properties, prefs, callbackLanes, families, paidInvoiceCount, paidPaymentsCount, livePrepayTerm,
  ] = await Promise.all([
    leg('visitCounts', () => dbh('scheduled_services')
      .where({ customer_id: customerId, status: 'completed' })
      .whereRaw('COALESCE(is_callback, false) = false')
      .count({ n: '*' }).first(), null),
    // Paid visits for the money gate: completed non-callback visits with a
    // PAID/PREPAID invoice on the row. Monthly-membership customers pay dues,
    // not per-visit invoices — for that lane completed visits + the separate
    // account-current gate are the honest equivalent (see below).
    leg('paidVisitCounts', () => dbh('scheduled_services as s')
      .join('invoices as i', 'i.scheduled_service_id', 's.id')
      .where('s.customer_id', customerId)
      .where('s.status', 'completed')
      .whereRaw('COALESCE(s.is_callback, false) = false')
      .where(function paidSignal() {
        // paid_at is the authoritative paid signal; status can lag it.
        this.whereNotNull('i.paid_at').orWhereIn('i.status', ['paid', 'prepaid']);
      })
      .countDistinct({ n: 's.id' }).first(), null),
    leg('visits12mo', () => dbh('scheduled_services')
      .where({ customer_id: customerId, status: 'completed' })
      .whereRaw('COALESCE(is_callback, false) = false')
      .where('scheduled_date', '>=', dateOnly(since12mo))
      .count({ n: '*' }).first(), null),
    leg('callbacks12mo', () => dbh('scheduled_services')
      .where({ customer_id: customerId, status: 'completed', is_callback: true })
      .where('scheduled_date', '>=', dateOnly(since12mo))
      .count({ n: '*' }).first(), null),
    // Lane-scoped callback counts (pest vs lawn) — the "N callbacks for the
    // same problem" card must never count the OTHER lane's callbacks.
    leg('callbackRows12mo', () => dbh('scheduled_services as s')
      .leftJoin('services as sv', 's.service_id', 'sv.id')
      .where({ 's.customer_id': customerId, 's.status': 'completed', 's.is_callback': true })
      .where('s.scheduled_date', '>=', dateOnly(since12mo))
      .select('sv.service_key', 's.service_type'), []),
    leg('reschedules12mo', () => dbh('job_status_history as h')
      .join('scheduled_services as s', 's.id', 'h.job_id')
      .where('s.customer_id', customerId)
      .where('h.to_status', 'rescheduled')
      .where('h.transitioned_at', '>=', since12mo)
      .count({ n: '*' }).first(), null),
    leg('savings12mo', () => dbh('invoices')
      .where({ customer_id: customerId })
      .where(function paidSignal() {
        this.whereNotNull('paid_at').orWhereIn('status', ['paid', 'prepaid']);
      })
      .where('created_at', '>=', since12mo)
      .where('discount_label', 'ilike', '%WaveGuard%')
      .sum({ n: 'discount_amount' }).first(), null),
    // Past-due via the payer-aware open-balance AUTHORITY (open-balance.js):
    // payer-billed rows — including a payer assigned AFTER minting, which
    // lives on the visit/customer while the invoice stays payer-null — are
    // the third party's debt and never block the homeowner's offer. Rows
    // whose payer resolve fails are DROPPED by the authority (fail closed).
    leg('pastDue', async () => {
      const { openBalanceInvoices } = require('../open-balance');
      // The authority DROPS rows whose payer resolve fails and TRUNCATES
      // past its bound — either makes the classification incomplete, and an
      // incomplete balance must fail CLOSED for money, not read as current.
      let incomplete = false;
      const rows = await openBalanceInvoices(customerId, {
        database: dbh,
        onResolveFailure: () => { incomplete = true; },
        onTruncation: () => { incomplete = true; },
      });
      if (incomplete) return 'error';
      return rows.find((r) => !r.paid_at && r.due_date && String(dateOnly(r.due_date)) < today) || null;
    }, 'error'),
    leg('failedPayment', () => dbh('payments')
      .where({ customer_id: customerId, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .first('id'), 'error'),
    // COMPLETED records only, and rows carry structured_notes so the
    // customer-visibility filter below can exclude internal-only typed
    // reports (typedReportDelivery != 'auto_send') — same egress rule as
    // service-report/report-copy-context.js. Fetch extra rows so filtering
    // still yields candidates.
    leg('findings', () => dbh('service_findings as f')
      .join('service_records as r', 'r.id', 'f.service_record_id')
      .where('r.customer_id', customerId)
      .where('r.status', 'completed')
      .orderBy([{ column: 'r.service_date', order: 'desc' }, { column: 'f.created_at', order: 'desc' }])
      .limit(20)
      .select('f.title', 'f.detail', 'f.category', 'f.severity', 'r.service_date', 'r.service_line', 'r.structured_notes'), []),
    // The OLDEST finding queried separately — the "your first visit found"
    // card must never quote a merely-less-recent finding as the first one.
    leg('earliestFinding', () => dbh('service_findings as f')
      .join('service_records as r', 'r.id', 'f.service_record_id')
      .where('r.customer_id', customerId)
      .where('r.status', 'completed')
      .orderBy([{ column: 'r.service_date', order: 'asc' }, { column: 'f.created_at', order: 'asc' }])
      .limit(5)
      .select('f.title', 'f.detail', 'r.service_date', 'r.service_line', 'r.structured_notes'), []),
    leg('complaintRequest', () => dbh('service_requests')
      .where({ customer_id: customerId })
      .whereIn('category', COMPLAINT_CATEGORIES)
      .whereNotIn('status', TERMINAL_REQUEST_STATUSES)
      .where('created_at', '>=', daysAgo(60, now))
      .orderBy('created_at', 'desc')
      .first('id', 'description', 'subject', 'created_at'), 'error'),
    leg('priorOffer', () => dbh('retention_offers')
      .where({ customer_id: customerId })
      .orderBy('granted_at', 'desc')
      .first('granted_at'), 'error'),
    // Latest manual/admin rate write, from the PERMANENT audit_log trail
    // (customer_plan_rates is mutable current state — later syncs delete or
    // replace its rows, which would erase the cooldown evidence). Events are
    // written by plan-rate-ledger for the human-driven sources only
    // (admin_edit, ib_update, ib_bulk_update — admin_create is initial
    // pricing, not an override); system
    // provenance never trips the cooldown.
    leg('manualOverride', async () => {
      const { MANUAL_RATE_AUDIT_ACTION, MANUAL_RATE_SOURCES } = require('../plan-rate-ledger');
      // Primary: the permanent audit trail (written prospectively from this
      // ship forward). Secondary, transitional: any SURVIVING
      // customer_plan_rates row with a human source — pre-deployment manual
      // reprices never got an audit event, and a still-standing ledger row
      // is the best remaining evidence (mutable, so absence proves nothing;
      // presence still blocks).
      const [auditRow, ledgerRow] = await Promise.all([
        dbh('audit_log')
          .where({ action: MANUAL_RATE_AUDIT_ACTION, resource_type: 'customer', resource_id: customerId })
          .orderBy('created_at', 'desc')
          .first('created_at'),
        dbh('customer_plan_rates')
          .where({ customer_id: customerId })
          .whereIn('source', Array.from(MANUAL_RATE_SOURCES))
          .orderBy('updated_at', 'desc')
          .first('updated_at')
          .catch(() => null),
      ]);
      const stamps = [auditRow && auditRow.created_at, ledgerRow && ledgerRow.updated_at]
        .filter(Boolean)
        .map((t) => new Date(t).getTime())
        .filter((t) => !Number.isNaN(t));
      return stamps.length ? { updated_at: new Date(Math.max(...stamps)) } : null;
    }, 'error'),
    // Only cases whose card was actually SHOWN (or acted on) suppress a
    // repeat — a server-resolved-but-never-displayed card (outcome 'none')
    // must not burn the customer's once-per-12-months slot. The window is
    // 12 ET CALENDAR months (leap-year/DST safe), like the money cooldown.
    leg('shownCases', () => {
      const { etMonthsAgoFloor } = require('./retention-offer');
      return dbh('cancellation_cases')
        .where({ customer_id: customerId })
        .whereNotNull('resolution_template_id')
        .whereIn('resolution_outcome', ['shown', 'accepted', 'declined'])
        .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date > ?", [etMonthsAgoFloor(now, 12)])
        .select('resolution_template_id');
    }, []),
    leg('termite', () => dbh('termite_stations')
      .where({ customer_id: customerId, program: 'termite', owned_by: 'waves' })
      .whereRaw('COALESCE(is_active, true) = true')
      .first('id'), null),
    leg('properties', () => dbh('customer_properties')
      .where({ customer_id: customerId, active: true })
      .count({ n: '*' }).first(), null),
    leg('prefs', () => dbh('property_preferences')
      .where({ customer_id: customerId })
      .first('preferred_day', 'preferred_time', 'property_gate_code', 'neighborhood_gate_code'), null),
    leg('callbackLanes', async () => {
      const { openReserviceCallbacks } = require('../reservice-scheduler');
      return Object.keys(await openReserviceCallbacks(customerId, dbh));
    }, 'error'),
    leg('families', () => loadFamilies(customerId, today, dbh), []),
    // Live annual-prepay term from the canonical term authority — the
    // customers.billing_mode scalar can be stale/legacy while a paid term
    // is live, and prepay CATEGORICALLY excludes the money offer. Money-
    // critical → a lookup failure fails closed (treated as prepay).
    // Durable paid-DUES signals for the monthly lane — restricted to
    // membership dues on BOTH rails (an unrelated one-time charge or
    // deposit must not count as a paid cycle): payments rows carry
    // chargeMonthly's load-bearing "WaveGuard Monthly" description marker /
    // metadata.type=monthly_autopay (the same %LIKE% billing-cron keys on),
    // and dues invoices carry the marker in their title. Fail closed to 0.
    leg('paidInvoiceCount', () => dbh('invoices')
      .where({ customer_id: customerId })
      .where(function paidSignal() {
        this.whereNotNull('paid_at').orWhereIn('status', ['paid', 'prepaid']);
      })
      .where('title', 'ilike', '%WaveGuard Monthly%')
      .count({ n: '*' }).first(), null),
    leg('paidPaymentsCount', () => dbh('payments')
      .where({ customer_id: customerId, status: 'paid' })
      .where(function duesMarker() {
        this.where('description', 'ilike', '%WaveGuard Monthly%')
          .orWhereRaw("metadata->>'type' = 'monthly_autopay'");
      })
      .count({ n: '*' }).first(), null),
    leg('livePrepayTerm', async () => {
      const { coveredTermsAsOf } = require('../annual-prepay-renewals');
      return coveredTermsAsOf(dbh, today).where('t.customer_id', customerId).first('t.id');
    }, 'error'),
  ]);

  // Customer-visibility filter (mirrors report-copy-context.js): a typed
  // report suppressed from customer surfaces must not feed retention copy.
  const customerVisible = (row) => {
    let sn = row.structured_notes;
    if (typeof sn === 'string') { try { sn = JSON.parse(sn); } catch { sn = null; } }
    const mode = sn && typeof sn === 'object' ? sn.typedReportDelivery : null;
    return !(mode && mode !== 'auto_send');
  };
  const findingRows = (Array.isArray(findings) ? findings : []).filter(customerVisible);
  const earliestRows = (Array.isArray(earliestFinding) ? earliestFinding : []).filter(customerVisible);
  const toFinding = (row) => (row ? {
    text: [row.title, row.detail].filter(Boolean).join(' — ').slice(0, 160),
    lane: laneForServiceLine(row.service_line),
    date: dateOnly(row.service_date),
  } : null);
  const lastFinding = toFinding(findingRows[0]);
  const firstFinding = toFinding(earliestRows[0] || null);


  // Prepay verdict from BOTH the scalar and the live term authority; an
  // errored term lookup fails closed (blocks the offer).
  const prepay = customer.billing_mode === 'annual_prepay' || livePrepayTerm === 'error' || !!livePrepayTerm;

  // FAIL CLOSED on money-critical facts: a query failure must never widen
  // eligibility. An errored leg resolves to the value that BLOCKS the offer
  // (not current / complaint open / callback open / offer just granted);
  // moneyFactsDegraded records that it happened.
  const moneyFactsDegraded = [pastDue, failedPayment, complaintRequest, priorOffer, manualOverride, callbackLanes, livePrepayTerm].includes('error');
  const accountCurrent = (pastDue === 'error' || failedPayment === 'error') ? false : (!pastDue && !failedPayment);
  const openComplaint = complaintRequest === 'error' ? true : !!complaintRequest;
  const openLanes = callbackLanes === 'error' ? ['unknown'] : (Array.isArray(callbackLanes) ? callbackLanes : []);
  const priorOfferAt = priorOffer === 'error'
    ? now.toISOString()
    : (priorOffer && priorOffer.granted_at ? new Date(priorOffer.granted_at).toISOString() : null);
  const manualOverrideAt = manualOverride === 'error'
    ? now.toISOString()
    : (manualOverride && manualOverride.updated_at ? new Date(manualOverride.updated_at).toISOString() : null);
  const completedVisits = num(visitCounts, 'n');
  // Monthly membership: dues cover visits, so visits rarely link to paid
  // invoices — but completed visits alone prove nothing was PAID. The lane's
  // paid-visit proxy is capped by the count of actually settled invoices
  // (≥4 paid dues cycles AND ≥4 completed visits to clear the money gate).
  // Every other lane requires visits directly tied to paid invoices.
  // Dues can settle through either rail; the two counts can double-count a
  // single payment (invoice + payments row), so take the LARGER rail, never
  // the sum.
  const settledCycles = Math.max(num(paidInvoiceCount, 'n'), num(paidPaymentsCount, 'n'));
  const completedPaidVisits = customer.billing_mode === 'monthly_membership'
    ? Math.min(completedVisits, settledCycles)
    : num(paidVisitCounts, 'n');

  return {
    customerId,
    memberSince: dateOnly(memberSince),
    tenureDays,
    completedVisits,
    completedPaidVisits,
    visits12mo: num(visits12mo, 'n'),
    callbacks12mo: num(callbacks12mo, 'n'),
    callbacksByLane: (() => {
      const { laneForCallbackRow } = require('../reservice-scheduler');
      const byLane = { pest: 0, lawn: 0 };
      for (const row of (Array.isArray(callbackRows12mo) ? callbackRows12mo : [])) {
        try {
          const lane = laneForCallbackRow({ serviceKey: row.service_key, serviceType: row.service_type });
          if (byLane[lane] !== undefined) byLane[lane] += 1;
        } catch { /* unknown lane rows count toward neither */ }
      }
      return byLane;
    })(),
    reschedules12mo: num(reschedules12mo, 'n'),
    savings12mo: Math.round(num(savings12mo, 'n') * 100) / 100,
    accountCurrent,
    openComplaint,
    openCallbackLanes: openLanes,
    moneyFactsDegraded,
    lastFinding,
    firstFinding,
    // Only STRUCTURED complaint evidence is ever quoted back — a filed
    // service request in the customer's own words, never a keyword-matched
    // SMS ("Gate code is 1234" must not become an apology card).
    lastComplaint: complaintRequest && complaintRequest !== 'error' && (complaintRequest.description || complaintRequest.subject)
      ? { date: dateOnly(complaintRequest.created_at), quote: String(complaintRequest.description || complaintRequest.subject).trim().slice(0, 140) }
      : null,
    priorRetentionOfferAt: priorOfferAt,
    manualPriceOverrideAt: manualOverrideAt,
    cardsShown12mo: (Array.isArray(shownCases) ? shownCases : []).map((r) => r.resolution_template_id).filter(Boolean),
    tier: customer.waveguard_tier || null,
    monthlyRate: Number(customer.monthly_rate) || 0,
    billingMode: customer.billing_mode || null,
    prepay,
    autopay: customer.autopay_enabled === true,
    termiteRental: !!termite || customer.termite_stations_rented === true,
    multiProperty: num(properties, 'n') > 1,
    hasPreferredWindow: !!(prefs && prefs.preferred_day && prefs.preferred_day !== 'no_preference'),
    families: Array.isArray(families) ? families : [],
  };
}

module.exports = { loadCancellationFacts, laneForServiceLine };
