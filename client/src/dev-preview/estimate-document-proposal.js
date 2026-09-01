// DEV HARNESS ONLY — the headless document pass (?mode=pdf) for fixtures
// that carry no authored proposal.
//
// Production's GET /:token/data pdf pass ships a synthesized single-building
// proposal for EVERY estimate (server/services/estimate-proposal.js
// synthesizeFallbackProposal → normalizeLineItem → computeProposalTotals),
// and EstimateProposalDocument prices exclusively from proposal.buildings /
// programs / correctiveWork. The harness has no server, so the same
// projection is rebuilt here from the fixture's pricing contract; without it
// a pest/lawn/WDO print artifact is an official-looking document with no
// pricing table and the audit cannot see a PDF pricing regression.
//
// Mirrored rules: residential recurring plans bill per completed application
// (per_application lines annualize by their own visit count), flat-monthly
// rows keep the monthly label, one-time rows print as charged or as
// "(Included)" at $0 only when the charged rows reconcile to the breakdown
// total, and the document is affirmed only when at least one priced line
// exists (a quote-required estimate falls through to the normal page).
const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const FREQUENCY_LABELS = { monthly: 'Monthly', one_time: 'One-time', per_application: 'Per application' };
const OCCURRENCES_PER_YEAR = { monthly: 12 };
// Cadence keys the engine's frequency ladder uses when a fixture row omits
// visitsPerYear (the real payload always carries it).
const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };

function lineItem({ description, unitPrice, frequency, visitsPerYear = 0 }) {
  const price = Math.max(0, round(unitPrice));
  return {
    description: String(description || '').slice(0, 300),
    quantity: 1,
    unitPrice: price,
    amount: price,
    frequency,
    frequencyLabel: FREQUENCY_LABELS[frequency],
    taxable: false,
    ...(frequency === 'per_application' && visitsPerYear > 0 ? { visitsPerYear } : {}),
  };
}

// Returns the per-cadence recurring lines, or null when a cadence's rows do
// not reconcile to its authoritative annual — production's synthesizer
// rejects a candidate whose per-service rows do not add up to the stored
// annual (perApplicationLinesForCandidate), so the harness must not print a
// number the estimate page never showed. Fixture rows may carry a
// pre-discount `perVisit` anchor beside a discounted `annual`; the discounted
// per-application price is derived from the annual in that case.
function recurringLines(pricing = {}) {
  const lines = [];
  for (const service of pricing.services || []) {
    const frequencies = Array.isArray(service.frequencies) ? service.frequencies : [];
    const cadence = frequencies.find((entry) => entry.key === service.defaultFrequencyKey) || frequencies[0];
    if (!cadence || cadence.quoteRequired === true) continue;
    const rows = Array.isArray(cadence.perServiceTreatments) && cadence.perServiceTreatments.length
      ? cadence.perServiceTreatments
      : [cadence];
    const cadenceAnnual = round(cadence.annual);
    const drafts = [];
    for (const row of rows) {
      const visits = Math.round(Number(row.visitsPerYear ?? cadence.visitsPerYear ?? CADENCE_VISITS[cadence.key]) || 0);
      const monthly = Number(row.monthly) || 0;
      const name = row === cadence ? service.label : (row.label || row.service || 'Recurring service');
      let perApplication = Number(row.displayPrice ?? row.perTreatment) || 0;
      if (!perApplication && visits > 0) {
        const anchor = Number(row.perVisit) || 0;
        const anchorReconciles = anchor > 0 && (!(cadenceAnnual > 0) || Math.abs(round(anchor * visits) - cadenceAnnual) <= 0.05);
        perApplication = anchorReconciles ? anchor : (cadenceAnnual > 0 ? round(cadenceAnnual / visits) : 0);
      }
      if (perApplication > 0 && visits > 0) {
        drafts.push({ line: lineItem({ description: `${name} — ${visits} applications/yr`, unitPrice: perApplication, frequency: 'per_application', visitsPerYear: visits }), annual: round(perApplication * visits) });
      } else if (monthly > 0) {
        drafts.push({ line: lineItem({ description: name, unitPrice: monthly, frequency: 'monthly' }), annual: round(monthly * 12) });
      }
    }
    if (!drafts.length) continue;
    const gross = round(drafts.reduce((sum, draft) => sum + draft.annual, 0));
    if (cadenceAnnual > 0 && Math.abs(gross - cadenceAnnual) > 0.05) return null;
    lines.push(...drafts.map((draft) => draft.line));
  }
  return lines;
}

function oneTimeLines(pricing = {}) {
  const rows = Array.isArray(pricing.oneTimeBreakdown?.items) ? pricing.oneTimeBreakdown.items : [];
  const charged = rows.filter((row) => row && row.kind === 'charge' && Number(row.amount) > 0);
  const included = rows.filter((row) => row && row.kind === 'included');
  const total = round(pricing.oneTimeBreakdown?.total ?? pricing.anchorOneTimePrice);
  const chargedTotal = round(charged.reduce((sum, row) => sum + Number(row.amount), 0));
  if ((charged.length || included.length) && Math.abs(chargedTotal - total) < 0.005) {
    return rows
      .filter((row) => charged.includes(row) || included.includes(row))
      .map((row) => (charged.includes(row)
        ? lineItem({ description: row.label || row.service || 'One-time service', unitPrice: row.amount, frequency: 'one_time' })
        : lineItem({ description: `${row.label || row.service || 'One-time service'} (Included)`, unitPrice: 0, frequency: 'one_time' })));
  }
  return total > 0 ? [lineItem({ description: 'One-time service', unitPrice: total, frequency: 'one_time' })] : [];
}

function computeTotals(buildings) {
  let annualRecurring = 0;
  let oneTime = 0;
  for (const building of buildings) {
    for (const item of building.lineItems) {
      if (item.frequency === 'one_time') {
        oneTime += item.amount;
      } else {
        const occurrences = item.frequency === 'per_application'
          ? (Number(item.visitsPerYear) || 0)
          : (OCCURRENCES_PER_YEAR[item.frequency] || 0);
        annualRecurring += round(item.amount * occurrences);
      }
    }
  }
  annualRecurring = round(annualRecurring);
  oneTime = round(oneTime);
  return {
    annualRecurring,
    monthlyEquivalent: round(annualRecurring / 12),
    oneTime,
    taxRate: 0,
    taxableAnnualRecurring: 0,
    taxableOneTime: 0,
    recurringTax: 0,
    oneTimeTax: 0,
    totalTax: 0,
    firstYearTotal: round(annualRecurring + oneTime),
    hasTax: false,
    isMultiBuilding: buildings.length > 1,
  };
}

export function synthesizeDocumentProposal(payload = {}) {
  const estimate = payload.estimate || {};
  const recurring = recurringLines(payload.pricing);
  const buildings = [{
    name: estimate.address || 'Service location',
    note: null,
    // An unreconciled recurring cadence rejects the whole synthesis (empty
    // table → documentRender withheld → the audit fails the scenario loudly)
    // rather than printing a partial or contradicting pricing table.
    lineItems: recurring ? [...recurring, ...oneTimeLines(payload.pricing)] : [],
  }];
  return {
    enabled: false,
    synthesized: true,
    pestRecurringOnly: false,
    title: 'Service Proposal',
    preparedFor: estimate.customerName || '',
    propertyAddress: estimate.address || '',
    taxRate: 0,
    taxLabel: 'Sales tax',
    terms: null,
    buildings,
    totals: computeTotals(buildings),
  };
}

// The server affirms documentRender only when the proposal view built with at
// least one priced line; otherwise ?mode=pdf falls through to the normal page.
export function documentRenderAffirmed(proposal) {
  if (!proposal) return false;
  return (Array.isArray(proposal.buildings) && proposal.buildings.some((building) => (building.lineItems || []).length > 0))
    || (Array.isArray(proposal.programs) && proposal.programs.length > 0)
    || (Array.isArray(proposal.correctiveWork) && proposal.correctiveWork.length > 0);
}
