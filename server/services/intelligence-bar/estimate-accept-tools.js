/**
 * Intelligence Bar — accept an estimate from the bar (owner ruling 2026-10-07,
 * Q5: "accept an estimate from the bar — carded, reuses Mark accepted, shows
 * what it books and bills"). This is also how a customer's FIRST program
 * starts from the bar.
 *
 *   accept_estimate   the estimate page's "Mark accepted" (a verbal yes):
 *                     POST /api/admin/estimates/:id/mark-accepted with
 *                     { source: 'verbal_yes' }, run through the route's own
 *                     handler (routes/admin-estimates.js
 *                     markEstimateAcceptedAsStaff) — the call-linkage
 *                     preflight, markEstimateManuallyAccepted and the
 *                     estimate converter. Nothing here re-implements a
 *                     conversion step.
 *
 * A two-step write (write-gates.js WRITE_TWO_STEP): the unconfirmed call is a
 * PREVIEW that changes nothing; /confirm-action re-runs it and refuses on any
 * drift (the estimate, the customer row and the bill are pinned), then the
 * executor re-plans once more and runs the handler. Always a card: it starts
 * billing and may email the customer, so it is irreversible and never
 * owner-direct. Dark behind GATE_IB_ACCEPT_ESTIMATE.
 *
 * The card is built from the same helpers the conversion uses: the page's own
 * refusals (estimate-manual-acceptance.js), the accepted recurring lines and
 * family slices (plan-rate-ledger.js), the add-on classification and billing
 * lane (estimate-converter.js), and the ledger accept itself run against an
 * in-memory copy of this customer's bill (display only — the real accept runs
 * it again under its locks).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { ibAcceptEstimateLive } = require('../../config/feature-gates');
const PlanRateLedger = require('../plan-rate-ledger');
const { ledgerPin, lineLabel, money } = require('./rate-change');

const ESTIMATE_ACCEPT_TOOLS = [
  {
    name: 'accept_estimate',
    description: `Mark ONE sent or viewed estimate accepted from the bar — exactly what the estimate page's "Mark accepted" does for a verbal yes. Use it when the operator says a customer accepted a quote ("he accepted", "she said yes to the estimate", "set him up recurring from the estimate"); it is also how a customer's FIRST program starts. Never fake an acceptance with update_customer or create_appointment.
The first call is a PREVIEW and changes nothing. The confirmation card shows the estimate (customer, tier, totals), each service the plan starts with its visits a year and monthly price, the monthly bill before and after line by line, the billing lane and tier change, which visits it books (Mark accepted books none; visits already booked from the estimate keep their follow-ups), and every message the customer gets. Confirm marks the estimate accepted, locks its price, makes the customer an active customer, starts the plan's billing, marks a linked lead won and may email the customer a "membership started" email. No text and no invoice. It cannot be undone from the bar.
Refused before any card: an estimate that is already accepted, declined, expired, archived, a draft, or not linked to the named customer, and every estimate the page itself refuses (it says why). Commercial proposals are won from the proposal page. Annual prepay is not offered here. Admin only.
Use for: "Pat accepted the lawn quote", "mark her estimate accepted", "he said yes, set him up from the estimate".`,
    input_schema: {
      type: 'object',
      properties: {
        estimate_id: { type: 'string', format: 'uuid', description: 'estimates.id of the estimate the customer accepted' },
        customer_id: { type: 'string', format: 'uuid', description: 'customers.id of the customer the operator named — the estimate must belong to this customer' },
      },
      required: ['estimate_id', 'customer_id'],
    },
  },
];

const uuid = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const dateOnly = (v) => (v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));

function parseData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

function customerName(c) {
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || c?.company_name || null;
}

function maskEmail(address) {
  const [local, domain] = String(address || '').trim().split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : null;
}

const LANE_LABELS = {
  monthly_membership: 'monthly membership dues',
  per_application: 'billed per application (each visit)',
  per_visit: 'billed per visit',
  annual_prepay: 'annual prepay',
};
const laneLabel = (mode) => LANE_LABELS[mode] || String(mode || 'none').replace(/_/g, ' ');

// The ledger accept (plan-rate-ledger applyAcceptToLedger) run against an
// in-memory copy of this customer's rows — the SAME function the converter
// runs, so the card's "after" bill follows the accept's own rules (replace a
// re-quoted service, keep the others, park an unsplit legacy rate). Supports
// exactly the calls that function makes; nothing reaches the database.
function ledgerSandbox(rows) {
  const store = new Map(rows.map((r) => [r.family_key, { family_key: r.family_key, monthly_rate: Number(r.monthly_rate) }]));
  const table = () => {
    let filter = {};
    const matches = (r) => (filter.family_key === undefined || r.family_key === filter.family_key);
    const q = {
      where(f) { filter = { ...filter, ...f }; return q; },
      async select() { return [...store.values()].filter(matches).map((r) => ({ ...r })); },
      async del() { for (const r of [...store.values()]) if (matches(r)) store.delete(r.family_key); },
      insert(row) {
        return {
          onConflict() {
            return {
              async merge(m) { store.set(row.family_key, { family_key: row.family_key, monthly_rate: Number((m || row).monthly_rate) }); },
            };
          },
        };
      },
    };
    return q;
  };
  const sandbox = () => table();
  sandbox.schema = { hasTable: async () => true };
  return sandbox;
}

// Same three-way rule as the converter (estimate-converter.js, the
// groupedEstimateAccept decision): a grouped estimate, a proven same-family
// plan at another property, or a cross-property accept whose classification is
// unknown bypasses the per-service split and leaves one unsplit line.
function bypassesLedgerSplit(estimate, customer, addOnContext) {
  if (estimate.estimate_group_id || addOnContext.sameFamilyAtOtherProperty === true) return true;
  if (!estimate.address) return false;
  const { makeEstimateScopeKeys, sameScopeKey } = require('../estimate-property-linkage');
  const keys = makeEstimateScopeKeys(estimate.address);
  const estimateStreet = keys ? keys.estimateKey : '';
  const primaryStreet = keys ? keys.primaryKey(customer.address_line1, customer.address_line2, customer.city, customer.zip) : '';
  const crossProperty = !!(estimateStreet && primaryStreet && !sameScopeKey(estimateStreet, primaryStreet));
  return crossProperty && addOnContext.sameFamilyAtOtherProperty !== false;
}

async function billPlan({ estimate, estimateData, customer, monthlyRate }) {
  const Converter = require('../estimate-converter');
  const previousScalar = round2(customer.monthly_rate);
  const components = await PlanRateLedger.loadComponents(db, customer.id);
  const before = PlanRateLedger.billLines(components, previousScalar);
  const slices = PlanRateLedger.estimateFamilySlices({ estimateData, monthlyRate });
  const addOnContext = await Converter.classifyAddOnAcceptContext({ database: db, estimateId: estimate.id, estimate, estimateData, customer });
  const legacyTotal = addOnContext.addOnBase > 0 ? round2(addOnContext.addOnBase + monthlyRate) : round2(monthlyRate);
  let after = new Map(legacyTotal > 0 ? [[PlanRateLedger.UNATTRIBUTED, legacyTotal]] : []);
  let totalAfter = legacyTotal;
  let reviewNeeded = false;
  const split = !bypassesLedgerSplit(estimate, customer, addOnContext);
  if (split && PlanRateLedger.planRateLedgerEnabled()) {
    const outcome = await PlanRateLedger.applyAcceptToLedger(ledgerSandbox(components), {
      customerId: customer.id,
      estimateId: estimate.id,
      slices,
      previousScalar,
      addOnBase: addOnContext.addOnBase,
      hadOtherLiveFamilies: addOnContext.hadOtherLiveFamilies,
      customerIsLive: ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage),
    });
    if (outcome?.components && outcome.scalar != null) {
      after = new Map(Object.entries(outcome.components).filter(([, v]) => round2(v) !== 0).map(([k, v]) => [k, round2(v)]));
      totalAfter = round2(outcome.scalar);
      reviewNeeded = outcome.reviewNeeded === true;
    }
  }
  const families = [...new Set([...before.keys(), ...after.keys()])];
  return {
    pin: ledgerPin(components, previousScalar),
    slices,
    lines: families.map((family) => ({ label: lineLabel(family), before: before.get(family) || 0, after: after.get(family) || 0 })),
    total_before: previousScalar,
    total_after: totalAfter,
    add_on: addOnContext.addOnBase > 0,
    split_by_service: split,
    review_alert: reviewNeeded,
  };
}

// The services the plan starts, grouped by the family the bill splits on.
function startedServices(estimateData, slices) {
  const { acceptedRecurringBillingLines } = PlanRateLedger;
  const { serviceFamilyKeyForAdoption } = require('../../routes/estimate-public');
  const { visitsPerYearForRecurringService } = require('../estimate-converter');
  const byFamily = new Map();
  for (const line of acceptedRecurringBillingLines(estimateData)) {
    const family = PlanRateLedger.boundedFamilyKey(serviceFamilyKeyForAdoption(line) || PlanRateLedger.UNATTRIBUTED);
    const name = line.name || line.serviceName || line.service_name || line.displayName || line.label || String(line.service || '').replace(/_/g, ' ') || 'Service';
    const visits = visitsPerYearForRecurringService(line || {});
    const entry = byFamily.get(family) || { family, service: lineLabel(family), names: [], visits_per_year: null };
    if (!entry.names.includes(name)) entry.names.push(name);
    if (visits != null && visits > 0) entry.visits_per_year = (entry.visits_per_year || 0) + visits;
    byFamily.set(family, entry);
  }
  return [...byFamily.values()].map((e) => ({
    ...e,
    monthly: slices[e.family] != null ? round2(slices[e.family]) : null,
  }));
}

function customerMessages({ customer, prefs, converts, commercialOnly, lane, termiteProgram }) {
  const messages = [];
  const email = String(customer.email || '').trim();
  const emailOn = !(prefs && prefs.email_enabled === false);
  if (!converts) {
    messages.push({ kind: 'none', will_send: false, text: 'No email or text: a one-time estimate only changes status here' });
  } else if (commercialOnly) {
    messages.push({ kind: 'none', will_send: false, text: 'No "membership started" email: a commercial-only plan is not a WaveGuard membership' });
  } else if (lane === 'one_time') {
    messages.push({ kind: 'none', will_send: false, text: 'No "membership started" email: the plan bills one time' });
  } else if (!/@/.test(email)) {
    messages.push({ kind: 'none', will_send: false, text: 'No "membership started" email: no email address on file' });
  } else if (!emailOn) {
    messages.push({ kind: 'none', will_send: false, text: 'No "membership started" email: this customer turned email messages off' });
  } else {
    messages.push({
      kind: 'email', will_send: true, template: 'membership.started',
      text: `Email "membership started" to ${maskEmail(email)} right after Confirm: plan, tier, rate and services (sent once per estimate)`,
    });
  }
  messages.push({ kind: 'none', will_send: false, text: 'No welcome text now (Mark accepted skips it). Booking the first visit later on the calendar may send it' });
  if (termiteProgram.has_program) {
    messages.push(termiteProgram.autosend
      ? { kind: 'email', will_send: true, text: 'Termite program agreement emailed to the customer to sign, after Confirm (agreement autosend is on)' }
      : { kind: 'none', will_send: false, text: 'Termite program agreement drafted for the office to send; the customer is not sent it' });
  }
  return messages;
}

const refuse = (error, code) => ({ error: `${error} Nothing was changed.`, ...(code ? { code } : {}) });

// The estimate must belong to the customer the operator named.
async function ownerRefusal(estimate, customerId, label) {
  if (estimate.customer_id && uuid(estimate.customer_id) === customerId) return null;
  if (!estimate.customer_id) {
    return refuse(`That ${label} is not linked to a customer yet, so it cannot be accepted here. Link it to the customer first.`, 'estimate_customer_mismatch');
  }
  const owner = customerName(await db('customers').where({ id: estimate.customer_id }).first('first_name', 'last_name', 'company_name'));
  return refuse(`That ${label} belongs to ${owner || 'another customer'}, not the customer you named. Check which customer accepted.`, 'estimate_customer_mismatch');
}

function statusRefusal(estimate, label) {
  const { isCommercialProposalEstimate } = require('../estimate-manual-acceptance');
  if (isCommercialProposalEstimate(estimate)) {
    return refuse('This is a commercial proposal. Mark it won from the proposal page; the bar does not accept proposals.', 'commercial_proposal');
  }
  if (estimate.status === 'accepted') {
    const on = estimate.accepted_at ? ` on ${dateOnly(estimate.accepted_at)}` : '';
    return refuse(`That ${label} was already accepted${on}.`, 'already_accepted');
  }
  if (estimate.status === 'declined') {
    const why = estimate.decline_reason ? ` (${estimate.decline_reason})` : '';
    return refuse(`That ${label} was declined${why}. Re-send or re-quote it before accepting.`, 'estimate_declined');
  }
  if (estimate.archived_at) {
    return refuse(`That ${label} is archived. Unarchive it first if the customer really accepted it.`, 'estimate_archived');
  }
  return null;
}

// Everything the estimate page itself refuses, with its own words.
async function pageRefusal(estimate, estimateData) {
  const ManualAcceptance = require('../estimate-manual-acceptance');
  const refusal = ManualAcceptance.oneTapPurchaseRefusal(estimate)
    || ManualAcceptance.manualAcceptRowRefusal(estimate)
    || ManualAcceptance.manualAcceptLockedRowRefusal(estimate);
  if (refusal) return refuse(refusal.message, 'page_refuses');
  const eng = estimateData.estimatorEngine;
  if (require('../estimate-clarify-asks').repricePendingActive(eng)) {
    return refuse('This estimate is held for a re-price (a customer clarify reply). Revise it with the answered unit before accepting.', 'page_refuses');
  }
  const { callSideBlockForEstimateData } = require('../../utils/estimate-claim-sql');
  const invalidated = !!(eng?.callLogId && (eng.linkage_invalidated_at || eng.invalidation_pending_at));
  if (invalidated || await callSideBlockForEstimateData(db, estimateData, { estimateStatus: estimate.status })) {
    return refuse('This estimate is quarantined by a call-linkage correction and cannot be accepted. Rebuild it from the corrected call.', 'page_refuses');
  }
  return null;
}

// What the conversion would refuse, or change, that this card cannot show:
// the termite annual plan is accepted with annual prepay only (the
// converter's TERMITE_ANNUAL_PLAN_REQUIRES_PREPAY guard), and a frozen
// WaveGuard extension re-prices the customer's existing visits and may issue
// prepaid-difference credits (applyFrozenExistingServiceExtension).
function conversionRefusal(estimate, estimateData, activatedTier) {
  const { selectedTermiteAnnualPlanRows } = require('../estimate-termite-program-rows');
  const parked = ['awaiting_signature', 'activated', 'signature_expired'].includes(estimate.annual_plan_activation_status);
  if (!parked && selectedTermiteAnnualPlanRows(estimateData).length > 0) {
    return refuse('The Subterranean Termite Protection annual plan can only be accepted with annual prepay ("Pay the year upfront"). The bar does not offer annual prepay; use the estimate page\'s annual prepay accept.', 'termite_annual_requires_prepay');
  }
  const snapshot = estimateData.membershipSnapshot;
  const extension = (Array.isArray(snapshot?.existingServices) ? snapshot.existingServices : [])
    .some((svc) => Number(svc?.currentPerVisit) > 0 && Number(svc?.newPerVisit) > 0 && Number(svc?.perVisitSavings) > 0
      && Array.isArray(svc?.keys) && svc.keys.length > 0);
  const tierMatches = String(snapshot?.tierLabel || '').trim().toLowerCase() === String(activatedTier || '').trim().toLowerCase();
  if (extension && tierMatches && require('../../config/feature-gates').isEnabled('waveguardExtendExisting')) {
    return refuse("This quote also lowers the price of the customer's existing services (WaveGuard tier extension), which re-prices booked visits and may credit prepaid ones. The bar cannot show that on a card yet; use Mark accepted on the estimate page.", 'existing_service_extension');
  }
  return null;
}

// The estimate, checked; or a refusal.
async function loadTarget(input) {
  const estimateId = uuid(input?.estimate_id);
  const customerId = uuid(input?.customer_id);
  if (!estimateId || !customerId) return { error: 'estimate_id and customer_id are both required.' };
  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) return refuse('No estimate with that id.', 'estimate_not_found');
  const estimateData = parseData(estimate.estimate_data);
  const label = `estimate ${String(estimate.token || estimate.id).slice(0, 8)}`;
  const refusal = await ownerRefusal(estimate, customerId, label)
    || statusRefusal(estimate, label)
    || await pageRefusal(estimate, estimateData);
  return refusal || { estimate, estimateData, label, customerId };
}

// The recurring services the converter activates and the tier it gives them
// (estimate-converter.js convertEstimate: the folded, legacy-rodent-filtered
// rows; the quote's frozen prior-services snapshot, else the customer's live
// qualifying services; determineTier on the combined count).
async function activation(estimateData, customerId) {
  const Converter = require('../estimate-converter');
  const { legacyRodentRowPredicateFor } = require('../billing-cadence');
  const isLegacyRodentRow = legacyRodentRowPredicateFor(estimateData);
  const recurring = Converter.recurringServicesFromEstimateData(estimateData);
  // A pinned pre-realignment rodent-only plan is the legacy monthly-dues
  // product: the converter stamps it monthly_membership, not per_application.
  const pinnedLegacyRodentOnlyPlan = Converter.isPinnedLegacyRodentOnlyPlan(recurring, isLegacyRodentRow);
  const services = Converter.foldTermiteRentalIntoBait(recurring).filter((svc) => !isLegacyRodentRow(svc));
  const keys = Converter.tierQualifyingRecurringServiceKeys(services);
  const commercialOnly = keys.length === 0
    && services.some((svc) => String(Converter.recurringServiceKey(svc) || '').startsWith('commercial_'));
  if (commercialOnly) return { commercialOnly, pinnedLegacyRodentOnlyPlan, tier: 'Commercial' };
  let prior = [];
  if (keys.length) {
    prior = Converter.priorQualifyingKeysFromSnapshot(estimateData)
      || await require('../waveguard-existing-services').loadExistingQualifyingServiceKeys(db, customerId).catch(() => []);
  }
  const { tier } = Converter.determineTier(Converter.combinedTierQualifyingCount(keys, prior), services.length > 0);
  return { commercialOnly, pinnedLegacyRodentOnlyPlan, tier: tier === 'none' ? null : tier };
}

// Billing lane and tier after the accept: the billing_mode the converter
// stamps (keep a current monthly member's lane; a pinned legacy rodent-only
// plan goes on monthly dues; everyone else per application), read through
// resolveBillingLane with the activated tier and the new monthly total.
function laneAndTier({ customer, converts, tierAfter, totalAfter, pinnedLegacyRodentOnlyPlan }) {
  const { customerPreservesMonthlyMembership } = require('../billing-cadence');
  const { resolveBillingLane } = require('../billing-lane');
  const laneBefore = Number(customer.monthly_rate) > 0 || customer.billing_mode ? resolveBillingLane(customer).mode : null;
  const tierBefore = customer.waveguard_tier || null;
  if (!converts) return { laneBefore, laneAfter: laneBefore, tierBefore, tierAfter: tierBefore };
  let stamped = pinnedLegacyRodentOnlyPlan ? 'monthly_membership' : 'per_application';
  if (customerPreservesMonthlyMembership(customer)) stamped = customer.billing_mode || null;
  const laneAfter = resolveBillingLane({ billing_mode: stamped, waveguard_tier: tierAfter, monthly_rate: totalAfter }).mode;
  return { laneBefore, laneAfter, tierBefore, tierAfter };
}

// Visits already booked from this estimate (its booking link): the accept
// keeps them and seeds their follow-ups. Otherwise Mark accepted books none.
async function bookedFromEstimate(estimateId) {
  const rows = await db('scheduled_services').where({ source_estimate_id: estimateId }).whereNotNull('customer_id')
    .whereNull('reservation_expires_at').whereNotIn('status', ['cancelled', 'canceled', 'rescheduled'])
    .orderBy('scheduled_date', 'asc').select('id', 'scheduled_date', 'service_type');
  return rows.map((r) => ({ id: String(r.id), date: dateOnly(r.scheduled_date), service: r.service_type || null }));
}

// ── Card lines (authorization-contract.js pushes them as they are) ──
function serviceAndBillLines(preview) {
  const lines = [];
  if (!preview.converts) {
    lines.push({ kind: 'billing', label: 'Bill: unchanged — a one-time estimate only changes status here. Schedule and invoice the work by hand' });
  }
  for (const s of preview.services) {
    const visits = s.visits_per_year ? `${s.visits_per_year} visits a year` : 'visits a year not stated';
    const price = s.monthly != null ? `, ${money(s.monthly)} a month` : '';
    lines.push({ kind: 'billing', label: `Starts ${s.service} (${s.names.join(', ')}): ${visits}${price}` });
  }
  const bill = preview.bill;
  if (!bill) return lines;
  for (const l of bill.lines) {
    const drops = l.after === 0 && l.before > 0 ? ' (drops off the bill)' : '';
    lines.push({ kind: 'billing', label: `Bill line ${l.label}: ${money(l.before)} → ${money(l.after)} a month${drops}`, before: money(l.before), after: money(l.after) });
  }
  const addOn = bill.add_on ? ' (added to the existing plan)' : '';
  lines.push({ kind: 'billing', label: `Bill total: ${money(bill.total_before)} → ${money(bill.total_after)} a month${addOn}`, before: money(bill.total_before), after: money(bill.total_after) });
  if (!bill.split_by_service) lines.push({ kind: 'billing', label: 'Bill note: this accept is not split by service (grouped or other-property estimate)' });
  if (bill.review_alert) lines.push({ kind: 'operational', label: 'Admin bell: plan-rate review — check the new monthly total after the accept' });
  return lines;
}

function beforeAfterLine(topic, { before, after }, changedNote) {
  const same = before === after ? ' (unchanged)' : changedNote;
  return { kind: 'billing', label: `${topic}: ${before || 'none'} → ${after || 'none'}${same}`, before: before || null, after: after || null };
}

function cardLines(preview) {
  const e = preview.estimate;
  const oneTime = e.one_time_total > 0 ? `, ${money(e.one_time_total)} one-time` : '';
  const booked = preview.visits.booked_from_estimate;
  return [
    { kind: 'customer', label: `Accepts ${e.label} for ${preview.customer_name || preview.customer_id}: ${money(e.monthly_total)} a month${oneTime}` },
    ...serviceAndBillLines(preview),
    beforeAfterLine('Billing lane', preview.billing_lane, ''),
    beforeAfterLine('Tier', preview.tier, ''),
    { kind: 'billing', label: 'No setup invoice, no charge and no receipt now' },
    {
      kind: 'operational',
      label: booked.length
        ? `Visits: keeps ${booked.length} visit(s) already booked from this estimate (first ${booked[0].date}) and seeds their follow-ups`
        : 'Visits: books none — book the first visit on the calendar after',
    },
    {
      kind: 'operational',
      label: preview.converts
        ? 'Marks the estimate accepted and locks its price; the customer becomes an active customer; a linked lead is marked won'
        : "Marks the estimate accepted and locks its price; a linked lead is marked won; the customer's status and plan stay as they are",
    },
    ...preview.customer_messages.map((m) => ({ kind: 'comms', label: `Message: ${m.text}` })),
  ];
}

// The full card for one call, or { error, code } the model relays. Reads only.
async function planAccept(input) {
  if (!ibAcceptEstimateLive()) {
    return refuse('Accepting an estimate from the bar is not switched on yet (GATE_IB_ACCEPT_ESTIMATE). Tell the operator to use Mark accepted on the estimate page.', 'accept_estimate_not_enabled');
  }
  const target = await loadTarget(input);
  if (target.error) return target;
  const { estimate, estimateData, label, customerId } = target;
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return refuse('No customer with that id.', 'customer_not_found');
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first().catch(() => null);

  const monthlyRate = round2(estimate.monthly_total);
  // Mark accepted runs the converter only for a recurring monthly total
  // (estimate-manual-acceptance.js); a one-time estimate only changes status.
  const converts = monthlyRate > 0;
  const { commercialOnly, tier, pinnedLegacyRodentOnlyPlan } = await activation(estimateData, customerId);
  const blocked = converts ? conversionRefusal(estimate, estimateData, tier) : null;
  if (blocked) return blocked;
  const bill = converts ? await billPlan({ estimate, estimateData, customer, monthlyRate }) : null;
  const lt = laneAndTier({ customer, converts, tierAfter: tier, totalAfter: bill?.total_after, pinnedLegacyRodentOnlyPlan });
  const booked = converts ? await bookedFromEstimate(estimate.id) : [];
  const { collectTermiteFacts, autosendGateOn } = require('../termite-program-agreement');
  const termiteProgram = { has_program: !!collectTermiteFacts(estimateData)?.hasProgram, autosend: autosendGateOn() };
  const messages = customerMessages({ customer, prefs, converts, commercialOnly, lane: lt.laneAfter, termiteProgram });

  const preview = {
    preview: true,
    estimate_id: String(estimate.id),
    customer_id: customerId,
    customer_name: customerName(customer),
    estimate: { label, status: estimate.status, tier: estimate.waveguard_tier || null, monthly_total: monthlyRate, one_time_total: round2(estimate.onetime_total) },
    converts,
    services: converts ? startedServices(estimateData, bill.slices) : [],
    bill: bill && {
      lines: bill.lines, total_before: bill.total_before, total_after: bill.total_after,
      add_on: bill.add_on, split_by_service: bill.split_by_service, review_alert: bill.review_alert,
    },
    billing_lane: { before: lt.laneBefore && laneLabel(lt.laneBefore), after: lt.laneAfter && laneLabel(lt.laneAfter) },
    tier: { before: lt.tierBefore, after: lt.tierAfter },
    visits: { booked_from_estimate: booked, books_new: false },
    customer_messages: messages,
    notifies_customer: messages.some((m) => m.will_send),
    // Approval binds these: any change before Confirm refuses the card.
    pins: {
      estimate_version: iso(estimate.updated_at),
      estimate_status: estimate.status,
      customer_version: iso(customer.updated_at),
      ledger: bill ? bill.pin : null,
    },
    note_to_operator: 'PREVIEW ONLY — nothing was changed. Confirm runs the estimate page\'s Mark accepted.',
  };
  preview.card_lines = cardLines(preview);
  return preview;
}

// What the approval binds: the target, the pins, and every shown effect.
function planKey(preview) {
  const AuthorizationContract = require('./authorization-contract');
  return AuthorizationContract.previewFingerprint(preview);
}

function expectedFrom(approved) {
  return {
    estimateVersion: approved.pins.estimate_version,
    estimateStatus: approved.pins.estimate_status,
    customerId: approved.customer_id,
    customerVersion: approved.pins.customer_version,
    ledgerPin: approved.pins.ledger,
  };
}

function acceptedResult(preview, json) {
  return {
    success: true,
    estimate_id: preview.estimate_id,
    customer_id: preview.customer_id,
    already_accepted: json.alreadyAccepted === true,
    monthly_rate_now: json.conversion?.monthlyRate ?? null,
    tier_now: json.conversion?.tier ?? null,
    warnings: Array.isArray(json.warnings) ? json.warnings : [],
    message: `${preview.customer_name || 'The customer'}'s ${preview.estimate.label} is accepted.${preview.visits.booked_from_estimate.length ? '' : ' No visits were booked — book the first visit on the calendar.'}`,
  };
}

async function acceptEstimate(input, actionContext = {}) {
  const preview = await planAccept(input);
  if (preview.error) return preview;
  // Only /confirm-action sets actionContext.confirmed (route-derived, never a
  // model param) — every other call is the card.
  if (actionContext.confirmed !== true) return preview;

  const approved = actionContext.executionPins?._verified_accept_plan;
  if (!approved?.estimate_id) {
    return { error: 'This acceptance has no verified card attached. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  if (planKey(approved) !== planKey(preview)) {
    return { error: 'The estimate, the customer or the bill changed after the card was shown. Nothing was changed. Ask again for a fresh confirmation card.', preview_changed: true };
  }

  // The estimate page's Mark accepted, through the route's own handler.
  const { markEstimateAcceptedAsStaff } = require('../../routes/admin-estimates');
  // The card's pins ride along and are re-checked under the accept's own
  // estimate and customer locks (estimate-manual-acceptance.js).
  const reply = await markEstimateAcceptedAsStaff({
    estimateId: preview.estimate_id,
    body: { source: 'verbal_yes', expected: expectedFrom(approved) },
    actor: { technicianId: actionContext.technicianId || null },
  });
  if (reply.json?.code === 'preview_changed') {
    return { error: reply.json.error, preview_changed: true };
  }
  if (reply.status !== 200 || reply.json?.success !== true) {
    return { ...refuse(reply.json?.error || 'The estimate was not accepted.', reply.json?.code), status: reply.status };
  }
  logger.info(`[intelligence-bar:estimate-accept] estimate ${preview.estimate_id} accepted for customer ${preview.customer_id}`);
  return acceptedResult(preview, reply.json);
}

async function executeEstimateAcceptTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'accept_estimate': return await acceptEstimate(input || {}, actionContext);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:estimate-accept] Tool ${toolName} failed: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { ESTIMATE_ACCEPT_TOOLS, executeEstimateAcceptTool, _private: { planAccept, ledgerSandbox } };
