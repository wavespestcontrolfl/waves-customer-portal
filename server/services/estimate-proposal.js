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

// per_application is internal to the synthesized fallback (residential
// recurring plans bill per completed application, never a flat monthly) —
// the Commercial Proposal editor keeps its own hardcoded option list and
// never offers it. A per_application line annualizes by its own
// visitsPerYear, not a fixed occurrence count.
const FREQUENCIES = ['monthly', 'quarterly', 'bimonthly', 'annual', 'one_time', 'per_application'];

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
  per_application: 'Per application',
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
  // per_application lines carry their own occurrence count; without one the
  // line annualizes to $0 (same as any unknown cadence would).
  const visitsPerYear = frequency === 'per_application'
    ? Math.max(0, Math.round(num(raw.visitsPerYear ?? raw.visits_per_year, 0)))
    : 0;
  return {
    description: String(raw.description || raw.name || '').slice(0, 300),
    quantity,
    unitPrice,
    frequency,
    frequencyLabel: FREQUENCY_LABELS[frequency],
    taxable: raw.taxable === true,
    amount,
    ...(visitsPerYear > 0 ? { visitsPerYear } : {}),
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

// Recurring lines quoted the way residential plans actually bill — per
// completed application (owner rule 2026-07-23 / 2026-07-31: billing is
// per application or annual prepay, never a flat monthly). Sources the
// send snapshot's pricing bundle (the same payload the estimate page
// renders): the accepted cadence when one is stamped, else the cadence
// whose totals match the stored estimate totals. Returns null when no
// cadence can be matched, a row can't be priced per-application (and isn't
// a genuine flat-monthly row like termite bait monitoring), or the lines
// don't annualize back to the stored annual total — callers then fall back
// to the legacy monthly-line synthesis rather than risk a document whose
// dollars don't reconcile.
function perApplicationRecurringLines(estimate = {}, estimateData = {}) {
  const frequencies = estimateData?.sendSnapshot?.pricingBundle?.frequencies;
  if (!Array.isArray(frequencies) || frequencies.length === 0) return null;
  const candidates = frequencies.filter((f) => f && f.quoteRequired !== true);
  const acceptedKey = String(estimate.accepted_frequency_key || '').trim();
  const annualTotal = num(estimate.annual_total);
  const monthlyTotal = num(estimate.monthly_total);
  const pick = (acceptedKey
    && candidates.find((f) => f.key === acceptedKey || f.billingFrequencyKey === acceptedKey))
    || (annualTotal > 0 && candidates.find((f) => Math.abs(num(f.annual) - annualTotal) < 0.01))
    || (monthlyTotal > 0 && candidates.find((f) => Math.abs(num(f.monthly) - monthlyTotal) < 0.01))
    || null;
  if (!pick) return null;

  // Split entries carry per-service treatment rows; rowless single-service
  // entries carry perTreatment/visitsPerYear on the frequency itself — but
  // their label is the CADENCE name ("Bi-monthly"), so the service name
  // comes from the estimate instead.
  const hasRows = Array.isArray(pick.perServiceTreatments) && pick.perServiceTreatments.length > 0;
  const rows = hasRows ? pick.perServiceTreatments : [pick];
  const rowlessName = String(estimate.service_interest || '').trim() || 'Recurring service plan';
  const lines = [];
  for (const row of rows) {
    const visits = Math.round(num(row.visitsPerYear ?? pick.visitsPerYear));
    const perApplication = num(row.displayPrice ?? row.perTreatment);
    const monthly = num(row.monthly);
    const name = hasRows ? (row.label || row.service || 'Recurring service') : rowlessName;
    if (perApplication > 0 && visits > 0) {
      lines.push(normalizeLineItem({
        description: `${name} — ${visits} applications/yr`,
        unitPrice: perApplication,
        frequency: 'per_application',
        visitsPerYear: visits,
        taxable: false,
      }));
    } else if (monthly > 0) {
      // Flat-monthly rows (termite bait monitoring) genuinely charge a
      // monthly amount on accept — keep the honest label.
      lines.push(normalizeLineItem({
        description: name,
        unitPrice: monthly,
        frequency: 'monthly',
        taxable: false,
      }));
    }
    // Rows with neither a per-application nor a monthly price are
    // display-only (the estimate page filters them the same way) — skipping
    // one that actually carried dollars fails the annual reconcile below.
  }
  if (lines.length === 0) return null;
  if (annualTotal > 0) {
    const sum = roundMoney(lines.reduce((acc, line) => acc + annualizedAmount(line), 0));
    if (Math.abs(sum - annualTotal) > 0.05) return null;
  }
  return lines;
}

// Build a single-building fallback proposal from the engine line items /
// estimate fields so ANY estimate can still produce a PDF even before the
// operator has authored an explicit multi-building proposal.
function synthesizeFallbackProposal(estimate = {}, estimateData = {}) {
  const lineItems = [...(perApplicationRecurringLines(estimate, estimateData) || [])];
  const havePerApplicationRecurring = lineItems.length > 0;
  const engineLines = Array.isArray(estimateData?.sendSnapshot?.pricingBundle?.lineItems)
    ? estimateData.sendSnapshot.pricingBundle.lineItems
    : Array.isArray(estimateData?.lineItems)
    ? estimateData.lineItems
    : [];

  for (const line of engineLines) {
    const monthly = num(line.monthlyPrice ?? line.monthly_price);
    const oneTime = num(line.oneTimePrice ?? line.onetime_price ?? line.oneTime);
    if (monthly > 0) {
      // The per-application lines already cover the recurring side.
      if (havePerApplicationRecurring) continue;
      lineItems.push(normalizeLineItem({
        description: line.displayName || line.name || line.service || 'Recurring service',
        unitPrice: monthly,
        frequency: 'monthly',
        taxable: false,
      }));
    } else if (oneTime > 0) {
      lineItems.push(normalizeLineItem({
        description: line.displayName || line.name || line.service || 'One-time service',
        unitPrice: oneTime,
        frequency: 'one_time',
        taxable: false,
      }));
    }
  }

  // Last-ditch: fill whichever side is still missing from the stored totals
  // so the PDF still shows a number rather than an empty table.
  if (!lineItems.some((item) => item.frequency !== 'one_time')) {
    const monthly = num(estimate.monthly_total);
    if (monthly > 0) {
      lineItems.push(normalizeLineItem({ description: 'Recurring service plan', unitPrice: monthly, frequency: 'monthly' }));
    }
  }
  if (!lineItems.some((item) => item.frequency === 'one_time')) {
    const oneTime = num(estimate.onetime_total);
    if (oneTime > 0) {
      lineItems.push(normalizeLineItem({ description: 'One-time service', unitPrice: oneTime, frequency: 'one_time' }));
    }
  }

  return {
    enabled: false,
    synthesized: true,
    // Synthesized fallbacks serve ANY estimate (incl. the customer-facing
    // /api/estimates/:token/pdf download) — a residential quote must not be
    // headed "Commercial Service Proposal". Authored proposals keep their
    // stored title (the commercial modal's default).
    title: 'Service Proposal',
    buildings: [{ name: estimate.address || 'Service location', note: null, lineItems }],
  };
}

/**
 * A row belongs to the Commercial Proposal editor when a proposal is
 * authored (enabled) OR machine-scaffolded by the estimator engine's
 * commercial lane (scaffold, enabled:false). A disabled scaffold must not
 * enter the normal edit flow: the list would offer "Edit estimate" and
 * edit-source would report it editable, but the revise write rejects
 * COMMERCIAL rows — the operator would lose their edits at save time.
 */
function isCommercialProposalData(estimateData) {
  const proposal = parseEstimateData(estimateData)?.proposal;
  return proposal?.enabled === true || proposal?.scaffold === true;
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
  const occ = item.frequency === 'per_application'
    ? (Number(item.visitsPerYear) || 0)
    : (OCCURRENCES_PER_YEAR[item.frequency] || 0);
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
  perApplicationRecurringLines,
  annualizedAmount,
  computeProposalTotals,
  isCommercialProposalData,
};
