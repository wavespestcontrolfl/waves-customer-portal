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
 * drift, then the executor re-plans once more and runs the handler. Always a
 * card: it starts billing and may email the customer, so it is irreversible
 * and never owner-direct. Dark behind GATE_IB_ACCEPT_ESTIMATE.
 *
 * The card is rendered from the accept's own effect list. The preview runs
 * the real accept in a DRY RUN (markEstimateManuallyAccepted({ dryRun: true })):
 * every step runs inside the accept's transaction, records what it writes and
 * what it will send after the commit, and the transaction rolls back
 * (estimate-accept-effects.js). The list's fingerprint is pinned with the
 * card; the confirmed accept builds its own list under the same locks and
 * refuses as preview_changed when it differs. This file only refuses (what the
 * card cannot show) and words the list; it computes no effect of its own.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { ibAcceptEstimateLive } = require('../../config/feature-gates');
const PlanRateLedger = require('../plan-rate-ledger');
const AcceptEffects = require('../estimate-accept-effects');
const { ledgerPin, lineLabel, money } = require('./rate-change');

const ESTIMATE_ACCEPT_TOOLS = [
  {
    name: 'accept_estimate',
    description: `Mark ONE sent or viewed estimate accepted from the bar — exactly what the estimate page's "Mark accepted" does for a verbal yes. Use it when the operator says a customer accepted a quote ("he accepted", "she said yes to the estimate", "set him up recurring from the estimate"); it is also how a customer's FIRST program starts. Never fake an acceptance with update_customer or create_appointment.
The first call is a PREVIEW and changes nothing. The confirmation card shows the estimate (customer, tier, totals), each service the plan starts with its visits a year and monthly price, the monthly bill before and after line by line, the billing lane and tier change, each one-time service the quote sells (the accept does not schedule or invoice it), which visits it books (none — book them on the calendar after), every office bell it rings and every message the customer gets. Confirm marks the estimate accepted, locks its price, makes the customer an active customer, starts the plan's billing, marks a linked lead won and may email the customer a "membership started" email. No text and no invoice. It cannot be undone from the bar.
Refused before any card: an estimate that is already accepted, declined, expired, archived, a draft, or not linked to the named customer, every estimate the page itself refuses (it says why), and what the card cannot show yet: any termite program or commercial recurring work (accepted on the estimate page), an estimate that is part of a group (accept it from the estimate page), an estimate with visits already booked from it, a quote that also re-prices the customer's existing services, a per-visit charge the converter cannot resolve, and (with customer properties on) an estimate not linked to an existing property. Commercial proposals are won from the proposal page. Annual prepay is not offered here. Admin only. Relay a refusal as it is.
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

const LANE_LABELS = {
  monthly_membership: 'monthly membership dues',
  per_application: 'billed per application (each visit)',
  per_visit: 'billed per visit',
  annual_prepay: 'annual prepay',
};
const laneLabel = (mode) => LANE_LABELS[mode] || String(mode || 'none').replace(/_/g, ' ');

// The services the plan starts, grouped by the family the bill splits on.
function startedServices(estimateData, slices) {
  const { acceptedRecurringBillingLines } = PlanRateLedger;
  const { serviceFamilyKeyForAdoption } = require('../../routes/estimate-public');
  const { visitsPerYearForRecurringService, acceptedPestSelectionVisits } = require('../estimate-converter');
  // The accepted pest cadence outranks a stale line count (the converter's
  // acceptedPestSelectionVisits doctrine); other services keep their own.
  const acceptedPlanFrequency = estimateData.customerSelection?.frequency || null;
  const byFamily = new Map();
  for (const line of acceptedRecurringBillingLines(estimateData)) {
    const family = PlanRateLedger.boundedFamilyKey(serviceFamilyKeyForAdoption(line) || PlanRateLedger.UNATTRIBUTED);
    const name = line.name || line.serviceName || line.service_name || line.displayName || line.label || String(line.service || '').replace(/_/g, ' ') || 'Service';
    const visits = acceptedPestSelectionVisits(line, acceptedPlanFrequency) ?? visitsPerYearForRecurringService(line || {});
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

// Every accept of a termite program runs the agreement prep after the commit
// (maybeCreateTermiteProgramAgreement, which can draft, email, or cancel an
// open request). The bar does not take that on: same eligibility as the
// agreement code (collectTermiteFacts().hasProgram; a manual accept is never a
// one-time-mode accept).
function termiteProgramRefusal(estimateData) {
  if (!require('../termite-program-agreement').collectTermiteFacts(estimateData)?.hasProgram) return null;
  return refuse('Accept termite programs on the estimate page, where the agreement is handled.', 'termite_program');
}

// A grouped estimate (estimate_group_id with another sent or viewed sibling):
// accepting it hands the group's follow-up messages to a sibling
// (transferGroupFollowupOwnership) and bypasses the per-service bill split.
// The bar does not take that on; the estimate page shows the group.
async function groupRefusal(estimate) {
  if (!estimate.estimate_group_id) return null;
  const sibling = await db('estimates')
    .where({ estimate_group_id: estimate.estimate_group_id })
    .whereNot({ id: estimate.id })
    .whereIn('status', ['sent', 'viewed'])
    .whereNull('archived_at')
    .first('id');
  return sibling ? refuse('This estimate is part of a group. Accept it from the estimate page, where the group is shown.', 'grouped_estimate') : null;
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

// A frozen WaveGuard extension plan for the activated tier (the plan rows
// applyFrozenExistingServiceExtension acts on).
function frozenExtensionPlan(estimateData, activatedTier) {
  const snapshot = estimateData.membershipSnapshot;
  const plan = (Array.isArray(snapshot?.existingServices) ? snapshot.existingServices : [])
    .some((svc) => Number(svc?.currentPerVisit) > 0 && Number(svc?.newPerVisit) > 0 && Number(svc?.perVisitSavings) > 0
      && Array.isArray(svc?.keys) && svc.keys.length > 0);
  return plan && String(snapshot?.tierLabel || '').trim().toLowerCase() === String(activatedTier || '').trim().toLowerCase();
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
  if (frozenExtensionPlan(estimateData, activatedTier) && require('../../config/feature-gates').isEnabled('waveguardExtendExisting')) {
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
    || termiteProgramRefusal(estimateData)
    || await groupRefusal(estimate)
    || await pageRefusal(estimate, estimateData);
  return refusal || { estimate, estimateData, label, customerId };
}

// The facts the refusals need: whether the quote carries commercial recurring
// work, and the tier the converter would activate (the folded,
// legacy-rodent-filtered rows; the quote's frozen prior-services snapshot,
// else the customer's live qualifying services; determineTier on the combined
// count). The frozen-extension refusal reads the tier.
async function activation(estimateData, customerId) {
  const Converter = require('../estimate-converter');
  const { legacyRodentRowPredicateFor } = require('../billing-cadence');
  const isLegacyRodentRow = legacyRodentRowPredicateFor(estimateData);
  const services = Converter.foldTermiteRentalIntoBait(Converter.recurringServicesFromEstimateData(estimateData))
    .filter((svc) => !isLegacyRodentRow(svc));
  const keys = Converter.tierQualifyingRecurringServiceKeys(services);
  let prior = [];
  if (keys.length) {
    prior = Converter.priorQualifyingKeysFromSnapshot(estimateData)
      || await require('../waveguard-existing-services').loadExistingQualifyingServiceKeys(db, customerId).catch(() => []);
  }
  const { tier } = Converter.determineTier(Converter.combinedTierQualifyingCount(keys, prior), services.length > 0);
  return { commercialRecurring: Converter.hasCommercialRecurringLine(services), tier: tier === 'none' ? null : tier };
}

// The refusals that need the activation facts: commercial recurring work
// (the converter's office-scheduled path and its admin bell), what the
// conversion would do that the card cannot show, linked visits, and a
// property the accept would add or match.
async function laterRefusal({ converts, estimate, estimateData, act, customerId }) {
  if (act.commercialRecurring) return refuse('Accept commercial work on the estimate page.', 'commercial_recurring');
  const blocked = converts && (conversionRefusal(estimate, estimateData, act.tier) || await bookedRefusal(estimate.id));
  return blocked || await propertyLinkRefusal(estimate, customerId);
}

// Under GATE_CUSTOMER_PROPERTIES the accept links the estimate to a property
// (linkAcceptedEstimateProperty): with no linked property of this customer it
// would match or create one, and with no primary it backfills one. The bar
// accepts only an estimate already linked to an existing property.
async function propertyLinkRefusal(estimate, customerId) {
  const Linkage = require('../estimate-property-linkage');
  if (!Linkage.customerPropertiesGateOn()) return null;
  const linked = await Linkage.linkedAcceptPropertyId(db, estimate, customerId);
  const primary = linked && await db('customer_properties').where({ customer_id: customerId, is_primary: true }).first('id');
  return primary ? null : refuse('Add or link the service address on the customer page first.', 'property_not_linked');
}

async function loadCustomer(customerId) {
  const customer = await db('customers').where({ id: customerId }).first();
  return customer ? { customer } : refuse('No customer with that id.', 'customer_not_found');
}

// Visits already booked from this estimate (its booking link) send the
// converter down its reservation path, which can add visits for the other
// services and rewrite the booked ones — more than this card can show yet.
// Same predicate as the converter's reservation lookup (any status).
async function bookedRefusal(estimateId) {
  const { estimateLinkedVisitsQuery } = require('../estimate-manual-acceptance');
  const rows = await estimateLinkedVisitsQuery(db, estimateId).orderBy('scheduled_date', 'asc').select('id', 'scheduled_date');
  if (!rows.length) return null;
  return refuse(`${rows.length} visit(s) are already linked to this estimate (first ${dateOnly(rows[0].scheduled_date)}). Accepting it can add and change visits that this card cannot show yet; use Mark accepted on the estimate page.`, 'booked_from_estimate');
}

// ── The dry run, worded for the card ──
//
// The accept's own effect list (estimate-accept-effects.js) is the only source
// of what the card says the accept writes and sends. Everything below reads
// that list; none of it works out an effect itself.

const effectOf = (effects, kind) => effects.find((e) => e.kind === kind) || null;
const effectsOfKind = (effects, kind) => effects.filter((e) => e.kind === kind);

// The billing lane a customer's stored fields resolve to (null: no plan yet).
function laneOf(fields) {
  const { resolveBillingLane } = require('../billing-lane');
  return Number(fields?.monthly_rate) > 0 || fields?.billing_mode ? resolveBillingLane(fields).mode : null;
}

// The bill by service, before and after, from the ledger effect.
function billFromEffects(effects) {
  const ledger = effectOf(effects, 'plan_rate_ledger');
  if (!ledger) return null;
  const cls = effectOf(effects, 'add_on_classification');
  const families = [...new Set([...Object.keys(ledger.before), ...Object.keys(ledger.after)])];
  return {
    lines: families.map((family) => ({ label: lineLabel(family), before: ledger.before[family] || 0, after: ledger.after[family] || 0 })),
    total_before: ledger.total_before,
    total_after: ledger.total_after,
    add_on: Number(cls?.add_on_base) > 0,
    split_by_service: cls ? cls.split_by_service !== false : true,
  };
}

// Every lawn field the accept rewrites: the grass type and the lawn size in
// all three places lawn-size-sync keeps it (turf profile, primary property,
// customer record). A mirror-only rewrite shows too.
const LAWN_FIELDS = [
  ['grass_type', 'grass type'],
  ['turf_lawn_sqft', 'lawn size'],
  ['primary_property_sqft', 'primary property size'],
  ['customer_property_sqft', 'customer record size'],
];
function lawnLine(effects) {
  const lawn = effectOf(effects, 'lawn_profile');
  if (!lawn) return null;
  const show = (key, v) => (v == null ? 'none' : (key === 'grass_type' ? String(v) : `${Number(v).toLocaleString('en-US')} sq ft`));
  const parts = LAWN_FIELDS
    .filter(([key]) => String(lawn.before[key] ?? '') !== String(lawn.after[key] ?? ''))
    .map(([key, name]) => `${name} ${show(key, lawn.before[key])} → ${show(key, lawn.after[key])}`);
  return parts.length ? `Lawn profile: ${parts.join('; ')}` : null;
}

// The per-application charge the converter stamped, from its conversion
// effect and the customer's fee after the accept.
function perApplicationLine({ conv, cust, monthlyRate, laneAfter }) {
  if (!conv?.recurring || laneAfter !== 'per_application') return null;
  const fee = cust?.after?.per_application_fee == null ? null : round2(cust.after.per_application_fee);
  if (conv.per_application_amount == null) {
    return fee == null
      ? 'Bills each service per application at its own visit price (no single account fee)'
      : `Bills each service per application at its own visit price; the account fee stays ${money(fee)} for any visit with no price`;
  }
  const kept = fee != null && fee !== conv.per_application_amount ? ` (the account fee stays ${money(fee)})` : '';
  return `Bills ${money(conv.per_application_amount)} per application (about ${money(monthlyRate)} a month)${kept}`;
}

const EMAIL_SKIP_TEXT = {
  one_time_lane: 'No "membership started" email: the plan bills one time',
  no_address: 'No "membership started" email: no email address on file',
  invalid_address: 'No "membership started" email: no email (the address on file is not a valid email)',
  email_off: 'No "membership started" email: this customer turned email messages off',
};

// The customer messages, from the post-commit plan's membership email step.
function messagesFromPlan({ plan, converts }) {
  const messages = [];
  const email = plan.find((s) => s.step === 'membership_email');
  if (!converts) {
    messages.push({ kind: 'none', will_send: false, text: 'No email or text: a one-time estimate only changes status here' });
  } else if (!email) {
    messages.push({ kind: 'none', will_send: false, text: 'No "membership started" email for this plan' });
  } else if (email.will_send === true) {
    messages.push({
      kind: 'email', will_send: true, template: 'membership.started',
      text: `Email "membership started" to ${email.to} right after Confirm: plan, tier, rate and services (sent once per estimate)`,
    });
  } else {
    messages.push({ kind: 'none', will_send: false, text: EMAIL_SKIP_TEXT[email.reason] || 'No "membership started" email' });
  }
  messages.push({ kind: 'none', will_send: false, text: 'No welcome text now (Mark accepted skips it). Booking the first visit later on the calendar may send it' });
  return messages;
}

// What the dry run found that the card cannot carry: the recipient facts could
// not be read, a commercial recurring line the converter schedules by hand,
// or a per-application charge the converter left unresolved (it parks a
// fee bell for the office).
function effectRefusal(effects) {
  const plan = effectOf(effects, 'post_commit')?.plan || [];
  const email = plan.find((s) => s.step === 'membership_email');
  if (email && (email.reason === 'prefs_unreadable' || email.reason === 'unknown')) {
    return refuse("Could not verify the customer's email settings — try again.", 'prefs_unavailable');
  }
  if (effectOf(effects, 'conversion')?.manual_recurring_scheduling) return refuse('Accept commercial work on the estimate page.', 'commercial_recurring');
  if (plan.some((s) => s.step === 'admin_bell' && s.bell === 'per_application_fee')) {
    return refuse('Accept this on the estimate page; the per-visit charge needs a manual review.', 'per_application_unresolved');
  }
  return null;
}

// Run the real accept as a dry run, through the route's own handler: the
// call-linkage preflight, then markEstimateManuallyAccepted with every step
// and a rollback at the end. Returns the effect list, or the refusal text the
// page itself would give.
async function dryRunAccept(estimate, actionContext) {
  const { markEstimateAcceptedAsStaff } = require('../../routes/admin-estimates');
  const reply = await markEstimateAcceptedAsStaff({
    estimateId: String(estimate.id),
    body: { source: 'verbal_yes' },
    actor: { technicianId: actionContext.technicianId || null },
    dryRun: true,
  });
  if (reply.status !== 200 || reply.json?.success !== true) {
    return refuse(reply.json?.error || 'The estimate could not be checked.', reply.json?.code || 'page_refuses');
  }
  if (reply.json.alreadyAccepted) return refuse('That estimate was already accepted.', 'already_accepted');
  const effects = Array.isArray(reply.json.effects) ? reply.json.effects : [];
  return effectRefusal(effects) || { effects };
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
  if (preview.per_application) lines.push({ kind: 'billing', label: preview.per_application });
  return lines;
}

// Each priced one-time line the estimate sells and what the accept does
// about it. A manual accept books and invoices none of them.
function oneTimeLines(preview) {
  return preview.one_time_lines.map((l) => ({
    kind: 'operational',
    label: `One-time ${l.name} (${money(l.amount)}): this accept does not schedule or invoice it — schedule it and invoice it by hand`,
  }));
}

function beforeAfterLine(topic, { before, after }, changedNote) {
  const same = before === after ? ' (unchanged)' : changedNote;
  return { kind: 'billing', label: `${topic}: ${before || 'none'} → ${after || 'none'}${same}`, before: before || null, after: after || null };
}

function cardLines(preview) {
  const e = preview.estimate;
  const oneTime = e.one_time_total > 0 ? `, ${money(e.one_time_total)} one-time` : '';
  return [
    { kind: 'customer', label: `Accepts ${e.label} for ${preview.customer_name || preview.customer_id}: ${money(e.monthly_total)} a month${oneTime}` },
    ...serviceAndBillLines(preview),
    ...(preview.lawn_profile ? [{ kind: 'customer', label: preview.lawn_profile }] : []),
    ...oneTimeLines(preview),
    beforeAfterLine('Billing lane', preview.billing_lane, ''),
    beforeAfterLine('Tier', preview.tier, ''),
    ...(preview.property_type.before === preview.property_type.after ? [] : [{
      kind: 'billing',
      label: `Property type: ${preview.property_type.before || 'not set'} → ${preview.property_type.after || 'not set'} (later invoices charge sales tax on taxable commercial services)`,
      before: preview.property_type.before, after: preview.property_type.after,
    }]),
    { kind: 'billing', label: 'No setup invoice, no charge and no receipt now' },
    { kind: 'operational', label: 'Visits: books none — book the first visit on the calendar after' },
    {
      kind: 'operational',
      label: preview.converts
        ? 'Marks the estimate accepted and locks its price; the customer becomes an active customer; a linked lead is marked won'
        : "Marks the estimate accepted and locks its price; a linked lead is marked won; the customer's status and plan stay as they are",
    },
    ...preview.admin_bells.map((title) => ({ kind: 'operational', label: `Admin bell: ${title}` })),
    ...preview.customer_messages.map((m) => ({ kind: 'comms', label: `Message: ${m.text}` })),
  ];
}

// What approval binds beside the effect list: any change before Confirm
// refuses the card. The bill pins (ledger, lawn profile, add-on evidence, no
// linked visit) exist only when the accept converts (a recurring monthly
// total).
async function cardPins({ estimate, customer, converts }) {
  const Manual = require('../estimate-manual-acceptance');
  const Converter = require('../estimate-converter');
  const bill = converts ? {
    ledger: ledgerPin(await PlanRateLedger.loadComponents(db, customer.id), round2(customer.monthly_rate)),
    lawn_profile: await Manual.lawnProfilePin(db, customer.id),
    plan_rows: await Converter.otherPlanRowsPin(db, { customerId: customer.id, estimateId: estimate.id }),
  } : null;
  return {
    estimate_version: iso(estimate.updated_at),
    estimate_status: estimate.status,
    customer_version: iso(customer.updated_at),
    customer_billing: Manual.customerBillingPin(customer),
    ledger: bill?.ledger ?? null,
    lawn_profile: bill?.lawn_profile ?? null,
    plan_rows: bill?.plan_rows ?? null,
    no_linked_visits: !!bill,
  };
}

function buildPreview({ estimate, estimateData, label, customer, customerId, monthlyRate, effects, pins }) {
  const conv = effectOf(effects, 'conversion');
  const converts = conv?.recurring === true;
  const cust = effectOf(effects, 'customer');
  const plan = effectOf(effects, 'post_commit')?.plan || [];
  const messages = messagesFromPlan({ plan, converts });
  // The customer's fields on each side of the accept (the row itself when the
  // accept recorded no customer effect).
  const before = cust?.before || customer;
  const after = cust?.after || customer;
  const laneBefore = laneOf(before);
  const laneAfter = laneOf(after);
  return {
    preview: true,
    estimate_id: String(estimate.id),
    customer_id: customerId,
    customer_name: customerName(customer),
    estimate: { label, status: estimate.status, tier: estimate.waveguard_tier || null, monthly_total: monthlyRate, one_time_total: round2(estimate.onetime_total) },
    converts,
    services: converts ? startedServices(estimateData, PlanRateLedger.estimateFamilySlices({ estimateData, monthlyRate })) : [],
    bill: converts ? billFromEffects(effects) : null,
    lawn_profile: lawnLine(effects),
    one_time_lines: effectsOfKind(effects, 'one_time_line').map((l) => ({ name: l.name, amount: l.amount })),
    billing_lane: { before: laneBefore && laneLabel(laneBefore), after: laneAfter && laneLabel(laneAfter) },
    tier: { before: before.waveguard_tier ?? null, after: after.waveguard_tier ?? null },
    property_type: { before: before.property_type ?? null, after: after.property_type ?? null },
    visits: { books_new: false },
    per_application: perApplicationLine({ conv, cust, monthlyRate, laneAfter }),
    admin_bells: plan.filter((s) => s.step === 'admin_bell').map((s) => s.title),
    customer_messages: messages,
    notifies_customer: messages.some((m) => m.will_send),
    // The approved email decision rides through delivery.
    membership_email: messages.some((m) => m.will_send) ? 'send' : 'skip',
    // Approval binds the whole effect list (its fingerprint) and the pins.
    effects_key: AcceptEffects.effectsFingerprint(effects),
    pins,
    note_to_operator: 'PREVIEW ONLY — nothing was changed. Confirm runs the estimate page\'s Mark accepted.',
  };
}

// The full card for one call, or { error, code } the model relays. Reads only
// (the dry run rolls back).
async function planAccept(input, actionContext = {}) {
  if (!ibAcceptEstimateLive()) {
    return refuse('Accepting an estimate from the bar is not switched on yet (GATE_IB_ACCEPT_ESTIMATE). Tell the operator to use Mark accepted on the estimate page.', 'accept_estimate_not_enabled');
  }
  const target = await loadTarget(input);
  if (target.error) return target;
  const { estimate, estimateData, label, customerId } = target;
  const who = await loadCustomer(customerId);
  if (who.error) return who;
  const { customer } = who;

  const monthlyRate = round2(estimate.monthly_total);
  // Mark accepted runs the converter only for a recurring monthly total
  // (estimate-manual-acceptance.js); a one-time estimate only changes status.
  const converts = monthlyRate > 0;
  const act = await activation(estimateData, customerId);
  const blocked = await laterRefusal({ converts, estimate, estimateData, act, customerId });
  if (blocked) return blocked;
  const dry = await dryRunAccept(estimate, actionContext);
  if (dry.error) return dry;
  const pins = await cardPins({ estimate, customer, converts });
  const preview = buildPreview({ estimate, estimateData, label, customer, customerId, monthlyRate, effects: dry.effects, pins });
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
    customerBilling: approved.pins.customer_billing,
    ledgerPin: approved.pins.ledger,
    lawnProfile: approved.pins.lawn_profile,
    planRows: approved.pins.plan_rows,
    noLinkedVisits: approved.pins.no_linked_visits === true,
    // The approved effect list and the approved email decision: the accept
    // refuses when its own list differs, and never sends an email the card
    // said it would not.
    effectsKey: approved.effects_key,
    membershipEmail: approved.membership_email,
  };
}

function acceptedResult(preview, json, tierNow) {
  return {
    success: true,
    estimate_id: preview.estimate_id,
    customer_id: preview.customer_id,
    already_accepted: json.alreadyAccepted === true,
    monthly_rate_now: json.conversion?.monthlyRate ?? null,
    tier_now: tierNow,
    warnings: Array.isArray(json.warnings) ? json.warnings : [],
    message: `${preview.customer_name || 'The customer'}'s ${preview.estimate.label} is accepted. No visits were booked — book the first visit on the calendar.`,
  };
}

async function acceptEstimate(input, actionContext = {}) {
  const preview = await planAccept(input, actionContext);
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
  // The card's pins and effect list ride along and are re-checked under the
  // accept's own estimate and customer locks (estimate-manual-acceptance.js).
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
  // The tier as stored (the converter's result can say 'none' where it stores
  // a different value), read after the commit.
  const stored = await db('customers').where({ id: preview.customer_id }).first('waveguard_tier').catch(() => null);
  return acceptedResult(preview, reply.json, stored ? (stored.waveguard_tier || null) : null);
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

module.exports = { ESTIMATE_ACCEPT_TOOLS, executeEstimateAcceptTool, _private: { planAccept } };
