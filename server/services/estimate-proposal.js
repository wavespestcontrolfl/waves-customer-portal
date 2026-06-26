// ============================================================
// estimate-proposal.js — Commercial proposal model + totals
//
// A "proposal" is the structured, multi-building line-item view of an
// estimate used to render a formal commercial bid PDF (two towers + N
// lake houses, each its own service profile). It lives in
// `estimates.estimate_data.proposal` (JSONB — no schema migration) and is
// authored by the operator in the Commercial Proposal panel.
//
// This module is the single place that:
//   1. normalizes whatever is stored into a stable shape (normalizeProposal)
//   2. computes recurring / one-time / tax totals (computeProposalTotals)
//
// Tax is intentionally NOT a business-rule engine here. Taxability is a
// CPA-signed judgement that the tax module owns; this module only sums the
// per-line `taxable` flags the operator set and applies the proposal's
// `taxRate`. With no rate set (the default for a residential HOA, where
// common-area pest is non-taxable and lawn is never taxable in FL) tax is
// $0 and every line renders as non-taxable.
// ============================================================

const FREQUENCIES = ['monthly', 'quarterly', 'bimonthly', 'annual', 'one_time'];

// FL nonresidential pest control is taxable (6% state + ~1% county surtax).
// Mirrors the tax-calculator default for commercial when a county can't be
// inferred. Used only to pre-fill the synthesized fallback proposal so a priced
// commercial line shows tax without the operator hand-typing a rate; the
// operator can still override the rate when authoring the proposal.
const DEFAULT_COMMERCIAL_TAX_RATE = 0.07;

// Occurrences per year for each recurring cadence. one_time is handled
// separately (it never contributes to the recurring/annualized totals).
const OCCURRENCES_PER_YEAR = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  annual: 1,
};

const FREQUENCY_LABELS = {
  monthly: 'Monthly',
  bimonthly: 'Every 2 months',
  quarterly: 'Quarterly',
  annual: 'Annual',
  one_time: 'One-time',
};

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFrequency(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (FREQUENCIES.includes(v)) return v;
  if (v === 'bi_monthly' || v === 'every_other_month') return 'bimonthly';
  if (v === 'yearly') return 'annual';
  if (v === 'onetime' || v === 'one_off' || v === 'once') return 'one_time';
  return 'monthly';
}

function normalizeLineItem(raw = {}) {
  const quantity = Math.max(1, Math.round(num(raw.quantity, 1)));
  // Proposal lines are commercial quote amounts — never negative. Clamp at the
  // authoritative normalizer (the PDF and computeProposalTotals both read this)
  // so a bad/hostile client can't drive the persisted estimate totals negative,
  // regardless of entry path. The PUT route additionally rejects negatives so an
  // operator authoring in the modal gets feedback instead of a silent zero.
  const unitPrice = Math.max(0, roundMoney(num(raw.unitPrice ?? raw.unit_price ?? raw.price, 0)));
  const frequency = normalizeFrequency(raw.frequency);
  // amount is the price per occurrence (qty × unit price). Annualization is
  // derived from the frequency in computeProposalTotals.
  const amount = roundMoney(quantity * unitPrice);
  return {
    description: String(raw.description || raw.name || '').slice(0, 300),
    quantity,
    unitPrice,
    frequency,
    frequencyLabel: FREQUENCY_LABELS[frequency],
    taxable: raw.taxable === true,
    amount,
  };
}

function normalizeBuilding(raw = {}, index = 0) {
  const lineItems = Array.isArray(raw.lineItems || raw.line_items)
    ? (raw.lineItems || raw.line_items).map(normalizeLineItem)
    : [];
  return {
    name: String(raw.name || raw.label || `Building ${index + 1}`).slice(0, 120),
    note: String(raw.note || '').slice(0, 300) || null,
    lineItems,
  };
}

function parseEstimateData(estimateData) {
  if (!estimateData) return {};
  if (typeof estimateData === 'string') {
    try { return JSON.parse(estimateData) || {}; } catch { return {}; }
  }
  return typeof estimateData === 'object' ? estimateData : {};
}

// Build a single-building fallback proposal from the engine line items /
// estimate fields so ANY estimate can still produce a PDF even before the
// operator has authored an explicit multi-building proposal.
function synthesizeFallbackProposal(estimate = {}, estimateData = {}) {
  const lineItems = [];
  const engineLines = Array.isArray(estimateData?.sendSnapshot?.pricingBundle?.lineItems)
    ? [...estimateData.sendSnapshot.pricingBundle.lineItems]
    : Array.isArray(estimateData?.lineItems)
    ? [...estimateData.lineItems]
    : [];

  // An admin-saved estimate persists the legacy `mapV1ToLegacyShape` output, not
  // a top-level `lineItems` array, so the small-commercial pilot line lives in
  // `result.(oneTime.)specItems`. Pull the commercial pilot line(s) from there
  // (by service key, deduped) so a saved pilot estimate still synthesizes a
  // proposal with the suggested price + tax instead of an empty $0 PDF.
  const specSources = [
    ...(Array.isArray(estimateData?.result?.oneTime?.specItems) ? estimateData.result.oneTime.specItems : []),
    ...(Array.isArray(estimateData?.result?.specItems) ? estimateData.result.specItems : []),
    ...(Array.isArray(estimateData?.engineResult?.oneTime?.specItems) ? estimateData.engineResult.oneTime.specItems : []),
    ...(Array.isArray(estimateData?.engineResult?.specItems) ? estimateData.engineResult.specItems : []),
  ];
  for (const s of specSources) {
    const svc = String(s?.service || '');
    const hasSuggested = num(s?.suggestedMonthly) > 0 || num(s?.suggestedAnnual) > 0;
    if (svc.startsWith('commercial_') && hasSuggested && !engineLines.some((l) => l.service === svc)) {
      engineLines.push(s);
    }
  }

  // A taxable commercial line (e.g. the small-commercial pest pilot) pre-fills a
  // default FL commercial tax rate so the synthesized PDF shows tax. Residential
  // lines stay non-taxable and the rate stays 0.
  let hasTaxableCommercialLine = false;

  for (const line of engineLines) {
    const taxable = line.taxable === true;
    const description = line.displayName || line.name || line.label || line.service;

    // Small-commercial pilot rows carry a per-visit suggestion at a real cadence
    // (`suggestedPerApp` at `frequency`). Emit the row AT THAT CADENCE — not
    // flattened to monthly — so the annualized total is unchanged but
    // proposal-win invoices the correct first service period (a quarterly
    // pilot's first invoice is one quarterly visit, not one month).
    const pilotPerVisit = num(line.suggestedPerApp);
    if (pilotPerVisit > 0) {
      if (taxable) hasTaxableCommercialLine = true;
      lineItems.push(normalizeLineItem({
        description: description || 'Recurring service',
        unitPrice: pilotPerVisit,
        frequency: line.frequency || 'quarterly',
        taxable,
      }));
      continue;
    }

    // Engine recurring lines carry `.monthly`/`.annual`; persisted bundles may
    // use `monthlyPrice`/`monthly_price`. Accept all so a priced/suggested
    // commercial line is not silently dropped.
    const monthly = num(
      line.monthlyPrice ?? line.monthly_price ?? line.monthly
      ?? line.suggestedMonthly
      ?? (num(line.annual) > 0 ? num(line.annual) / 12 : 0)
      ?? (num(line.suggestedAnnual) > 0 ? num(line.suggestedAnnual) / 12 : 0),
    );
    const oneTime = num(line.oneTimePrice ?? line.onetime_price ?? line.oneTime);
    if (taxable && (monthly > 0 || oneTime > 0)) hasTaxableCommercialLine = true;
    if (monthly > 0) {
      lineItems.push(normalizeLineItem({
        description: description || 'Recurring service',
        unitPrice: monthly,
        frequency: 'monthly',
        taxable,
      }));
    } else if (oneTime > 0) {
      lineItems.push(normalizeLineItem({
        description: description || 'One-time service',
        unitPrice: oneTime,
        frequency: 'one_time',
        taxable,
      }));
    }
  }

  // Last-ditch: no engine lines available — fall back to the stored totals so
  // the PDF still shows a number rather than an empty table.
  if (lineItems.length === 0) {
    const monthly = num(estimate.monthly_total);
    const oneTime = num(estimate.onetime_total);
    if (monthly > 0) {
      lineItems.push(normalizeLineItem({ description: 'Recurring service plan', unitPrice: monthly, frequency: 'monthly' }));
    }
    if (oneTime > 0) {
      lineItems.push(normalizeLineItem({ description: 'One-time service', unitPrice: oneTime, frequency: 'one_time' }));
    }
  }

  return {
    enabled: false,
    synthesized: true,
    ...(hasTaxableCommercialLine
      ? { taxRate: DEFAULT_COMMERCIAL_TAX_RATE, taxLabel: 'FL sales tax (commercial)' }
      : {}),
    buildings: [{ name: estimate.address || 'Service location', note: null, lineItems }],
  };
}

/**
 * Normalize whatever is stored in estimate_data.proposal into a stable shape.
 * Falls back to a synthesized single-building proposal when none is authored.
 *
 * @returns {{ enabled, synthesized, title, preparedFor, propertyAddress,
 *   taxRate, taxLabel, terms, buildings: Array }}
 */
function normalizeProposal(estimate = {}) {
  const estimateData = parseEstimateData(estimate.estimate_data ?? estimate.estimateData);
  const stored = estimateData.proposal;

  const base = stored && Array.isArray(stored.buildings) && stored.buildings.length
    ? stored
    : synthesizeFallbackProposal(estimate, estimateData);

  const buildings = (Array.isArray(base.buildings) ? base.buildings : []).map(normalizeBuilding);

  return {
    enabled: base.enabled === true,
    synthesized: base.synthesized === true,
    title: String(base.title || 'Commercial Service Proposal').slice(0, 160),
    preparedFor: String(base.preparedFor || estimate.customer_name || '').slice(0, 160),
    propertyAddress: String(base.propertyAddress || estimate.address || '').slice(0, 200),
    taxRate: Math.min(1, Math.max(0, num(base.taxRate, 0))),
    taxLabel: String(base.taxLabel || 'Sales tax').slice(0, 60),
    terms: base.terms ? String(base.terms).slice(0, 2000) : null,
    buildings,
  };
}

function annualizedAmount(item) {
  if (item.frequency === 'one_time') return 0;
  const occ = OCCURRENCES_PER_YEAR[item.frequency] || 0;
  return roundMoney(item.amount * occ);
}

/**
 * Compute recurring / one-time / tax totals for a normalized proposal.
 * Tax is applied only to lines flagged `taxable`, at the proposal taxRate.
 */
function computeProposalTotals(proposal) {
  const taxRate = num(proposal?.taxRate, 0);
  let annualRecurring = 0;
  let oneTime = 0;
  let taxableAnnualRecurring = 0;
  let taxableOneTime = 0;

  for (const building of proposal.buildings || []) {
    for (const item of building.lineItems || []) {
      if (item.frequency === 'one_time') {
        oneTime += item.amount;
        if (item.taxable) taxableOneTime += item.amount;
      } else {
        const annual = annualizedAmount(item);
        annualRecurring += annual;
        if (item.taxable) taxableAnnualRecurring += annual;
      }
    }
  }

  annualRecurring = roundMoney(annualRecurring);
  oneTime = roundMoney(oneTime);
  const monthlyEquivalent = roundMoney(annualRecurring / 12);
  const recurringTax = roundMoney(taxableAnnualRecurring * taxRate);
  const oneTimeTax = roundMoney(taxableOneTime * taxRate);
  const totalTax = roundMoney(recurringTax + oneTimeTax);

  return {
    annualRecurring,
    monthlyEquivalent,
    oneTime,
    taxRate,
    taxableAnnualRecurring: roundMoney(taxableAnnualRecurring),
    taxableOneTime: roundMoney(taxableOneTime),
    recurringTax,
    oneTimeTax,
    totalTax,
    // Grand total = full first-year cost (annual recurring + one-time) + tax.
    firstYearTotal: roundMoney(annualRecurring + oneTime + totalTax),
    hasTax: totalTax > 0,
    isMultiBuilding: (proposal.buildings || []).length > 1,
  };
}

module.exports = {
  FREQUENCIES,
  FREQUENCY_LABELS,
  OCCURRENCES_PER_YEAR,
  normalizeFrequency,
  normalizeLineItem,
  normalizeBuilding,
  normalizeProposal,
  annualizedAmount,
  computeProposalTotals,
};
