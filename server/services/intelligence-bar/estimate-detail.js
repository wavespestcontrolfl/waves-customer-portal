// get_estimate_detail — what an estimate offered, read the way the customer
// page reads it.
//
// Before this reader the bar could see that estimate links went out
// (find_similar_estimates, the conversation thread) but not the amounts
// inside them: "what did we quote him per application?" ended with the
// operator being sent to the Estimates tab. The priced contents live in
// estimates.estimate_data (JSONB, engine-shaped) and are NOT re-read here:
// every amount comes from the public route's own composer, in the public
// route's own order —
//   membership      → estimate-public reconcileFrozenMembershipSnapshot first
//                     (a lapsed member's frozen discount is repriced or the
//                     row is marked requote, exactly as /:token/data does);
//                     when the live lookup fails the reconciler reports it
//                     and offered pricing is WITHHELD — never priced from the
//                     unverified snapshot
//   authored proposal → estimate-proposal normalizeProposal +
//                     computeProposalTotals when estimate_data.proposal is
//                     enabled and itemized: the formal commercial proposal is
//                     the billed quote, the engine rows a promoted estimate
//                     still carries are not (the public page and the PDF
//                     price from the same projection)
//   offered pricing → estimate-public buildPricingBundle otherwise: plan
//                     cadences, per-service ladders, cadence combos with
//                     their allocated per-service amounts and manual-
//                     discount state, section-level price selectors (termite
//                     bond terms, station rental, commercial interior toggle),
//                     the one-time breakdown, first-visit / setup fees, the
//                     rodent bait setup fee
//   totals          → the stored estimate columns the send path wrote
//   links           → estimate-public isEstimateCustomerViewable /
//                     adminDraftPreviewEligible + the durable call-side
//                     block (estimate-claim-sql), the same 404 checks the
//                     public page runs
// A hand-itemized reading of estimate_data (recurring rows, one-time rows,
// review markers, mirrors, twins) was deliberately removed from this tool
// after four review rounds kept finding pricing rules the public composer
// applies and a re-implementation would have to mirror — the bundle IS
// what the customer sees, so the bar answers from it or says it cannot.
// Record scope: estimate_id resolves to its customer through the
// task-context RECORDS map, customer_id is the customer selector itself.
const db = require('../../models/db');

const MAX_PER_CUSTOMER = 10;
const DEFAULT_PER_CUSTOMER = 3;
const PUBLIC_ESTIMATE_BASE = 'https://portal.wavespestcontrol.com/estimate/';

function money(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseStoredJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The public route pulls in the full estimate pipeline; the registry must
// not load it with the tool list.
const lazy = {
  publicRoute: () => require('../../routes/estimate-public'),
  claimSql: () => require('../../utils/estimate-claim-sql'),
  proposal: () => require('../estimate-proposal'),
  proposalBilling: () => require('../estimate-proposal-billing'),
};

const list = (v) => (Array.isArray(v) ? v : []);

// ── Offered pricing (the public bundle, verbatim in shape) ───────────
// The per-application figure the customer page shows — a server mirror of
// PriceCard.jsx perApplicationNetForFrequency (the client module cannot be
// imported into the server; keep the two in step): the single priced
// treatment row's net displayPrice when there is exactly one, else the
// cadence's own perTreatment with PriceCard's visit derivation — and only
// on a cadence the composer marks billed per application. A legacy monthly-billed member's bundle has that flag
// stripped by the composer; such a cadence is a monthly charge, and no
// per-application amount is invented for it.
const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };
function perApplicationFor(f) {
  if (f.billedPerApplication !== true) return null;
  const rows = list(f.perServiceTreatments)
    .map((row) => ({ displayPrice: Number(row.displayPrice ?? row.perTreatment), monthlyPrice: Number(row.monthly), visitsPerYear: Number(row.visitsPerYear) }))
    .filter((row) => (Number.isFinite(row.displayPrice) && row.displayPrice > 0) || (Number.isFinite(row.monthlyPrice) && row.monthlyPrice > 0));
  if (rows.length === 1) return rows[0].displayPrice > 0 && rows[0].visitsPerYear > 0 ? money(rows[0].displayPrice) : null;
  if (rows.length > 1) return null;
  // No priced treatment row: the cadence's own perTreatment, with the visit
  // count from the cadence, a single visit-bearing row, or the cadence key
  // (legacy / snapshotted rows omit visitsPerYear) — PriceCard's order.
  const visitRows = list(f.perServiceTreatments).filter((row) => Number(row?.visitsPerYear) > 0);
  const visits = Number(f.visitsPerYear) > 0
    ? Number(f.visitsPerYear)
    : (visitRows.length === 1 ? Number(visitRows[0].visitsPerYear) : (visitRows.length === 0 ? (CADENCE_VISITS[f.key] || null) : null));
  const pt = Number(f.perTreatment);
  return pt > 0 && Number.isFinite(visits) && visits > 0 ? money(pt) : null;
}

// A LOW-confidence commercial cadence carries a range, not a price: the
// composer stamps lowConfidenceRangePct + lowConfidenceFraction and the
// customer page shows price ± price × fraction × pct (PriceCard).
function lowConfidenceRange(f) {
  const pct = f.quoteRequired === true ? 0 : Number(f.lowConfidenceRangePct);
  if (!(pct > 0) || !(Number(f.monthly) > 0)) return null;
  const rawFraction = Number(f.lowConfidenceFraction);
  const fraction = Number.isFinite(rawFraction) && rawFraction > 0 ? Math.min(rawFraction, 1) : 1;
  const band = (price) => (price == null ? null : [money(price - price * fraction * pct), money(price + price * fraction * pct)]);
  return { pct, fraction, monthly: band(money(f.monthly)), annual: band(money(f.annual)) };
}

function treatmentRow(r) {
  return {
    service: r.service || null,
    label: r.label || null,
    per_treatment: money(r.perTreatment),
    display_price: money(r.displayPrice),
    visits_per_year: Number(r.visitsPerYear) > 0 ? Number(r.visitsPerYear) : null,
    ...(r.monthly != null ? { monthly: money(r.monthly) } : {}),
    ...(r.monthlyBase != null ? { monthly_base: money(r.monthlyBase) } : {}),
    ...(r.waveGuardDiscountEligible != null ? { waveguard_discount_eligible: r.waveGuardDiscountEligible === true } : {}),
  };
}

function frequencyEntry(f) {
  const rows = list(f.perServiceTreatments);
  const range = lowConfidenceRange(f);
  const entry = {
    key: f.key || null,
    label: f.label || null,
    monthly: money(f.monthly),
    annual: money(f.annual),
    visits_per_year: Number(f.visitsPerYear) > 0 ? Number(f.visitsPerYear) : null,
    billing_unit: f.billedPerApplication === true ? 'per_application' : 'monthly',
    // PriceCard's perAppNet rule: a ranged (or quote-required) cadence shows
    // the RANGE and no exact per-application headline — the customer never
    // sees the midpoint, so the bar must not quote it either.
    per_application: range || f.quoteRequired === true ? null : perApplicationFor(f),
    per_service_treatments: rows.map(treatmentRow),
    // Row-level discount state: a program minimum can cap or suppress the
    // manual discount on SOME cadences only — the global manual_discount
    // never speaks for an individual cadence.
    manual_discount: f.manualDiscount || null,
  };
  if (f.manualDiscountSuppressed === true) entry.manual_discount_suppressed = true;
  if (range) entry.low_confidence_range = range;
  if (f.oneTimeTotal != null) entry.one_time_total = money(f.oneTimeTotal);
  if (f.quoteRequired === true) entry.quote_required = true;
  if (f.annualPrepayEligible != null) entry.annual_prepay_eligible = f.annualPrepayEligible === true;
  return entry;
}

function feeEntry(f) {
  const entry = { service: f.service || null, label: f.label || null, amount: money(f.amount), waived_with_prepay: f.waivedWithPrepay === true };
  if (Number(f.treatments) > 0) entry.treatments = Number(f.treatments);
  return entry;
}

// Each combo carries the AUTHORITATIVE allocated per-service amounts
// (perServiceTreatments) and its own manual-discount state; the section
// ladders (services[].frequencies) are the pre-manual-discount prices the
// customer picks between — both are reported, each labelled as what it is.
function comboEntry(c) {
  const entry = {
    key: c.key || null,
    selection: c.selection && typeof c.selection === 'object' ? c.selection : null,
    monthly: money(c.monthly),
    annual: money(c.annual),
    per_service_treatments: c.perServiceTreatments && typeof c.perServiceTreatments === 'object' ? c.perServiceTreatments : null,
    manual_discount: c.manualDiscount || null,
  };
  if (c.manualDiscountSuppressed === true) entry.manual_discount_suppressed = true;
  return entry;
}

// Section-level price selectors the composer attaches to a service section
// (attachTermiteBondSelector / attachTermiteStationRental /
// attachCommercialInteriorSelector): selectable additions the customer page
// renders beside the base cadence. Reported only when the composer set them,
// with the same amounts, so the base ladder is never passed off as the
// complete offer.
const addAmounts = (o) => ({ per_application_add: money(o.perApplicationAdd), monthly_add: money(o.monthlyAdd), annual_add: money(o.annualAdd) });
function sectionSelectors(s) {
  const out = {};
  if (Array.isArray(s.bondOptions)) {
    out.bond_options = s.bondOptions.map((o) => ({ key: o.key || null, label: o.label || null, years: Number(o.years) > 0 ? Number(o.years) : null, ...addAmounts(o) }));
    out.selected_bond_term = s.selectedBondTerm || null;
  }
  if (s.stationRental && typeof s.stationRental === 'object') {
    out.station_rental = { label: s.stationRental.label || null, detail: s.stationRental.detail || null, ...addAmounts(s.stationRental), price_itemized: s.stationRental.priceItemized === true };
  }
  if (s.interiorOption && typeof s.interiorOption === 'object') {
    out.interior_option = { selected: s.interiorOption.selected !== false, label: s.interiorOption.label || null, ...addAmounts(s.interiorOption), detail: s.interiorOption.detail || null };
  }
  if (s.interiorScopeExcluded === true) out.interior_scope_excluded = true;
  return out;
}

// ONE canonical upfront-fee list. The composer also ships compatibility
// aliases of the same charges (setupFee = the matching firstVisitFees
// entry; the rodent bait setup and initial-roach fees can recur inside
// oneTimeBreakdown) — the customer page renders the fee cards from
// firstVisitFees and EXCLUDES those services from the breakdown card, so
// the tool reports the same partition and never the same dollar twice.
function upfrontFees(bundle) {
  const fees = list(bundle.firstVisitFees).map(feeEntry);
  const rodent = bundle.rodentBaitSetupFee && typeof bundle.rodentBaitSetupFee === 'object' ? feeEntry(bundle.rodentBaitSetupFee) : null;
  if (rodent && !fees.some((f) => f.service === rodent.service)) fees.push(rodent);
  return fees;
}

function breakdownEntry(b, excludedServices) {
  if (!b || typeof b !== 'object') return null;
  const excluded = new Set(excludedServices);
  const items = list(b.items)
    .filter((i) => !excluded.has(i.service))
    .map((i) => ({
      service: i.service || null,
      label: i.label || null,
      amount: money(i.amount),
      detail: i.detail || null,
      ...(i.quoteRequired === true ? { quote_required: true } : {}),
    }));
  // The page's rule (OneTimeBreakdownCard): the composer's total stands
  // only when nothing was excluded; with exclusions the total is the sum of
  // the remaining items, so a fee reported in upfront_fees never rides in
  // this subtotal too.
  const total = excluded.size === 0 && Number.isFinite(Number(b.total))
    ? money(b.total)
    : money(items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0));
  return { items, excluded_upfront_fee_services: [...excluded], total, quote_required: b.quoteRequired === true };
}

// ── Authored proposal (the billed quote when one exists) ─────────────
// The public page and the PDF generator both price an enabled, itemized
// proposal from normalizeProposal + computeProposalTotals in the live billing
// lane (resolveProposalBillingContext); the engine rows such an estimate
// still carries are explicitly not the billed price (estimate-public
// attachCommercialInteriorSelector). Projected field-by-field like the public
// view — the stored block is admin-authored. Returns null when the stored
// proposal is not itemized (normalizeProposal falls back to the synthesized
// view, enabled:false) — the page then prices from the bundle, and so does
// this tool.
async function authoredProposalPricing(row, data) {
  if (data?.proposal?.enabled !== true) return null;
  const { normalizeProposal, computeProposalTotals } = lazy.proposal();
  const billing = await lazy.proposalBilling().resolveProposalBillingContext(row);
  const proposal = normalizeProposal(row, {
    recurringMode: billing?.billsPerApplication === true ? 'per_application' : 'legacy',
    livePricing: billing?.livePricing || null,
  });
  if (proposal.enabled !== true) return null;
  const totals = computeProposalTotals(proposal);
  return {
    pricing_authority: 'authored_proposal',
    bills_per_application: billing?.billsPerApplication === true,
    proposal: {
      title: proposal.title,
      prepared_for: proposal.preparedFor,
      property_address: proposal.propertyAddress,
      tax_rate: totals.taxRate,
      tax_label: proposal.taxLabel,
      terms: proposal.terms,
      buildings: list(proposal.buildings).map((b) => ({
        name: b.name,
        note: b.note ?? null,
        line_items: list(b.lineItems).map((i) => ({
          description: i.description, quantity: i.quantity, unit_price: money(i.unitPrice), amount: money(i.amount),
          frequency: i.frequency, frequency_label: i.frequencyLabel || null, visits_per_year: i.visitsPerYear > 0 ? i.visitsPerYear : null, taxable: i.taxable === true,
        })),
      })),
      programs: proposal.programs ? proposal.programs.map((p) => ({
        service: p.service, label: p.label, frequency_per_year: p.frequencyPerYear, price_per_application: money(p.pricePerApplication), annual: money(p.annual),
        taxable: p.taxable === true, note: p.note ?? null, inclusions: p.inclusions ?? null, exclusions: p.exclusions ?? null,
        buildings: list(p.buildings).map((b) => ({ name: b.name, note: b.note ?? null })),
      })) : null,
      corrective_work: proposal.correctiveWork ? proposal.correctiveWork.map((w) => ({ label: w.label, amount: money(w.amount), taxable: w.taxable === true, includes: w.includes ?? null })) : null,
      commercial_terms: proposal.commercialTerms ? {
        payment_terms: proposal.commercialTerms.paymentTerms ?? null, initial_term_months: proposal.commercialTerms.initialTermMonths ?? null, renewal: proposal.commercialTerms.renewal ?? null,
        price_adjustment: proposal.commercialTerms.priceAdjustment ?? null, cancellation: proposal.commercialTerms.cancellation ?? null, access_requirements: proposal.commercialTerms.accessRequirements ?? null,
      } : null,
    },
    totals: {
      annual_recurring: money(totals.annualRecurring), monthly_equivalent: money(totals.monthlyEquivalent), one_time: money(totals.oneTime),
      recurring_tax: money(totals.recurringTax), one_time_tax: money(totals.oneTimeTax), total_tax: money(totals.totalTax), first_year_total: money(totals.firstYearTotal),
    },
    source: 'authored_proposal',
  };
}

async function offeredPricing(row, data) {
  try {
    const proposal = await authoredProposalPricing(row, data);
    if (proposal) return { offered_pricing: proposal };
  } catch (err) {
    // An enabled proposal whose projection failed must not fall through to
    // engine cadences — they are not the billed quote.
    return { offered_pricing: null, offered_pricing_unavailable: `authored proposal failed: ${err.message}` };
  }
  let bundle;
  try {
    bundle = await lazy.publicRoute().buildPricingBundle(row);
  } catch (err) {
    return { offered_pricing: null, offered_pricing_unavailable: `pricing bundle failed: ${err.message}` };
  }
  if (!bundle || typeof bundle !== 'object') return { offered_pricing: null, offered_pricing_unavailable: 'no pricing bundle for this estimate' };
  const fees = upfrontFees(bundle);
  return {
    offered_pricing: {
      default_service_mode: bundle.defaultServiceMode || null,
      waveguard_tier: bundle.waveGuardTier || null,
      plan_frequencies: list(bundle.frequencies).map(frequencyEntry),
      services: list(bundle.services).map((s) => ({
        key: s.key || null,
        label: s.label || null,
        default_frequency_key: s.defaultFrequencyKey || null,
        frequencies: list(s.frequencies).map(frequencyEntry),
        ...sectionSelectors(s),
      })),
      combos: list(bundle.serviceCadenceCombos).map(comboEntry),
      // The one-time total the customer page shows (the composer's
      // corrected figure for legacy rows whose stored total still carries a
      // setup fee that no longer applies, or lacks one now owed).
      one_time_total: money(bundle.anchorOneTimePrice),
      upfront_fees: fees,
      setup_fee_service: bundle.setupFee?.service || null,
      one_time_breakdown: breakdownEntry(bundle.oneTimeBreakdown, fees.map((f) => f.service)),
      manual_discount: bundle.manualDiscount || null,
      // The composer's own quote-required verdict (resolveEstimateQuoteRequirement:
      // lapsed-member reprice impossible, unverified setup waiver, retired
      // lawn pricing, commercial review, quote-required items…) — the state
      // the public page fails closed on instead of self-serve accepting.
      quote_required: bundle.quoteRequired === true,
      quote_required_reason: bundle.quoteRequiredReason || null,
      quote_required_items: list(bundle.quoteRequiredItems),
      source: bundle.source || null,
    },
  };
}

// ── Links ────────────────────────────────────────────────────────────
// Only where the public route would serve them: the durable call-side
// block and the customer-surface check first (both 404 on the public
// page), then the customer link when isEstimateCustomerViewable says so,
// the staff draft preview for an unpublished, unarchived row, nothing
// otherwise.
async function estimateLinks(row, data) {
  if (!row.token) return { customer_link: null, staff_preview_link: null, link_state: 'no_token' };
  let blocked = false;
  try {
    blocked = !!(await lazy.claimSql().callSideBlockForEstimateData(db, data));
  } catch {
    blocked = true; // fail closed: an unverifiable block is not a link
  }
  if (blocked) return { customer_link: null, staff_preview_link: null, link_state: 'blocked' };
  const publicRoute = lazy.publicRoute();
  if (publicRoute.isEstimateCustomerViewable(row)) {
    return { customer_link: `${PUBLIC_ESTIMATE_BASE}${row.token}`, staff_preview_link: null, link_state: 'customer_viewable' };
  }
  if (publicRoute.adminDraftPreviewEligible(row, '1')) {
    return { customer_link: null, staff_preview_link: `${PUBLIC_ESTIMATE_BASE}${row.token}?adminPreview=1`, link_state: 'staff_preview_only' };
  }
  return { customer_link: null, staff_preview_link: null, link_state: 'not_openable' };
}

// Same order as the public renderers: reconcile the frozen membership
// snapshot FIRST (mutates the row's pricing data in memory for a lapsed
// member), then read totals, links, and the bundle from the reconciled row.
// The reconciler never throws by contract — it catches the live lookup /
// reprice failure internally and REPORTS it as { ok: false, error }; a
// rejection is handled too. Either way the row is still the unverified
// snapshot, so the caller withholds pricing.
async function reconcileMembership(row) {
  try {
    const result = await lazy.publicRoute().reconcileFrozenMembershipSnapshot(row);
    if (result && result.ok === false) return `membership reconciliation failed: ${result.error || 'unknown error'}`;
    return null;
  } catch (err) {
    return `membership reconciliation failed: ${err.message}`;
  }
}

function resolveInvoiceMode(row, data) {
  try {
    return lazy.publicRoute().resolveEstimateInvoiceMode(row, data) === true;
  } catch {
    return row.bill_by_invoice === true;
  }
}

// Authored proposal: its computed totals ARE the quote. Otherwise monthly /
// annual are the stored totals the send path wrote (after reconciliation) and
// one-time is the composer's corrected figure when the bundle built (it is
// what the page shows), the stored column otherwise. Withheld entirely when
// membership could not be verified.
function totalsFor(row, pricing, reconciliation_error) {
  if (reconciliation_error) return { monthly: null, annual: null, one_time: null, withheld: true };
  const offered = pricing.offered_pricing;
  if (offered?.pricing_authority === 'authored_proposal') {
    const t = offered.totals;
    return { monthly: t.monthly_equivalent, annual: t.annual_recurring, one_time: t.one_time, total_tax: t.total_tax, first_year_total: t.first_year_total, source: 'authored_proposal' };
  }
  return { monthly: money(row.monthly_total), annual: money(row.annual_total), one_time: offered?.one_time_total ?? money(row.onetime_total) };
}

// Deposits: amount is the FACE value requested; card_surcharge is the extra
// cash collected on top of it and refunded_surcharge how much of that fee went
// back (null = no explicit record). A 'pending' row is an abandoned Stripe
// intent (estimate_deposits keeps it for the deposit follow-up stage) —
// nothing was collected, so collected is false and total_paid null; every
// other status (received / credited / refunding / refunded) records cash that
// was taken.
function depositEntry(d) {
  const collected = d.status !== 'pending';
  return {
    amount: money(d.amount), card_surcharge: money(d.card_surcharge), collected,
    total_paid: collected ? money(Number(d.amount || 0) + Number(d.card_surcharge || 0)) : null,
    credited: money(d.credited_amount), refunded: money(d.refunded_amount), refunded_surcharge: money(d.refunded_surcharge),
    status: d.status, received_at: d.received_at,
  };
}

async function shapeEstimate(row, deposits = []) {
  const reconciliation_error = await reconcileMembership(row);
  const data = parseStoredJson(row.estimate_data);
  // Pricing is WITHHELD when the live membership state could not be verified:
  // the row is then the stale frozen-member snapshot, and an answer built
  // from it would quote a discount the page may no longer give.
  const pricing = reconciliation_error
    ? { offered_pricing: null, offered_pricing_unavailable: `withheld: ${reconciliation_error}` }
    : await offeredPricing(row, data);
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer: row.customer_name,
    address: row.address,
    status: row.status,
    disposition: row.disposition || null,
    disposition_note: row.disposition_note || null,
    decline_reason: row.decline_reason || null,
    category: row.category,
    service_interest: row.service_interest,
    tier: row.waveguard_tier,
    pricing_version: row.pricing_version || null,
    // Effective invoice mode, the public acceptance/payment surfaces' own
    // resolver (a rodent-guarantee-only renewal bills by invoice even when
    // the column says false).
    bill_by_invoice: resolveInvoiceMode(row, data),
    // Derived from the bundle's verdict, never from a stored flag: null when
    // the bundle could not be built (unknown, not "no").
    requote_required: pricing.offered_pricing ? (pricing.offered_pricing.quote_required ?? null) : null,
    requote_reason: pricing.offered_pricing?.quote_required_reason ?? null,
    totals: totalsFor(row, pricing, reconciliation_error),
    ...pricing,
    ...(reconciliation_error ? { reconciliation_error } : {}),
    accepted: row.accepted_at ? { at: row.accepted_at, service_mode: row.accepted_service_mode || null, frequency: row.accepted_frequency_key || null } : null,
    deposits: deposits.map(depositEntry),
    customer_notes: row.notes || null,
    ...(await estimateLinks(row, data)),
    sent_at: row.sent_at,
    viewed_at: row.viewed_at,
    view_count: row.view_count || 0,
    declined_at: row.declined_at,
    expires_at: row.expires_at,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getEstimateDetail({ estimate_id, customer_id, limit } = {}) {
  if (!estimate_id && !customer_id) return { error: 'Provide estimate_id or customer_id' };
  // The whole row: the public route's reconciler and bundle composer read
  // the estimate the way the public handlers load it (select *), so a
  // column subset here could starve them of a field they consult.
  let query = db('estimates').select('*').orderBy('created_at', 'desc');
  if (estimate_id) {
    query = query.where('id', estimate_id).limit(1);
  } else {
    const count = Math.max(1, Math.min(Math.trunc(Number(limit)) || DEFAULT_PER_CUSTOMER, MAX_PER_CUSTOMER));
    query = query.where('customer_id', customer_id).whereNull('archived_at').limit(count);
  }
  const rows = await query;
  if (!rows.length) {
    return {
      count: 0,
      estimates: [],
      error: estimate_id ? 'No estimate matches that id' : 'No estimates on file for that customer',
    };
  }
  const deposits = await db('estimate_deposits')
    .whereIn('estimate_id', rows.map((r) => r.id))
    .select('estimate_id', 'amount', 'card_surcharge', 'credited_amount', 'refunded_amount', 'refunded_surcharge', 'status', 'received_at')
    .orderBy('created_at', 'desc');
  const byEstimate = new Map();
  for (const d of deposits) {
    if (!byEstimate.has(d.estimate_id)) byEstimate.set(d.estimate_id, []);
    byEstimate.get(d.estimate_id).push(d);
  }
  const estimates = [];
  for (const row of rows) estimates.push(await shapeEstimate(row, byEstimate.get(row.id) || []));
  return { count: rows.length, estimates };
}

const GET_ESTIMATE_DETAIL_TOOL = {
  name: 'get_estimate_detail',
  description: `Read what an estimate offered, exactly as the customer's estimate page prices it: the plan cadences with their monthly / annual prices and, on cadences billed per application, the per-application price the page shows (a monthly-billed plan reports billing_unit monthly and no per-application figure; a LOW-confidence commercial price reports its range), each service's cadence ladder (pest quarterly / bi-monthly / monthly, lawn standard / enhanced / premium) with any selectable additions the page offers beside it (termite bond terms, station rental, commercial interior service), the priced cadence combinations on a mixed estimate with their allocated per-service amounts and any manual discount, one canonical upfront-fee list plus the remaining one-time breakdown (never the same fee twice), the page's one-time total, totals, deposits (face amount + card surcharge; a pending intent collected nothing), status, view/sent/accepted timestamps, and which link (customer or staff preview) can actually be opened. A formal commercial proposal (pricing_authority authored_proposal) is reported from its authored line items, programs, corrective work and computed totals instead — that is the billed quote. A lapsed membership is reconciled first, so the amounts match the live page (requote_required + requote_reason carry the page's own quote-required verdict, e.g. a lapsed member whose price could not be repriced); when the live membership state cannot be verified, pricing and totals are withheld (offered_pricing_unavailable says so) rather than quoted from the stale snapshot. Pass estimate_id for one estimate or customer_id for that customer's latest estimates (newest first).
Use for: "what did we quote him for quarterly pest", "what is the per-application price on her estimate", "what would monthly have cost", "what did the 9/5 estimate say" — anything about the amounts inside a sent estimate. Prefer this over guessing from monthly_rate or from the SMS thread. It does not itemize the internal engine rows behind those prices; offered_pricing_unavailable says when the pricing bundle could not be built.`,
  input_schema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'string', format: 'uuid', description: 'Estimate UUID — returns exactly that estimate' },
      customer_id: { type: 'string', format: 'uuid', description: 'Customer UUID — returns that customer\'s latest estimates when no estimate_id is given' },
      limit: { type: 'number', description: 'With customer_id: how many recent estimates to return (default 3, max 10)' },
    },
  },
};

module.exports = { GET_ESTIMATE_DETAIL_TOOL, getEstimateDetail, shapeEstimate };
