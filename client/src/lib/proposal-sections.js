// Structured commercial-proposal sections (slice 1A-i) — shared row/label
// logic for the on-page ProposalDetailCard and the EstimateProposalDocument
// PDF, so the two surfaces can never label a term differently. The SSR card
// in server/routes/estimate-public.js duplicates these labels verbatim (same
// pattern as the commercial inclusions bullets) — change them together.

// commercialTerms → ordered [label, value] rows, omitting absent fields.
export function commercialTermRows(commercialTerms) {
  if (!commercialTerms || typeof commercialTerms !== 'object') return [];
  return [
    ['Proposal valid', commercialTerms.validDays != null ? `${commercialTerms.validDays} days from issue` : null],
    ['Payment', commercialTerms.paymentTerms],
    ['Initial term', commercialTerms.initialTermMonths != null
      ? (commercialTerms.initialTermMonths > 0 ? `${commercialTerms.initialTermMonths} months` : 'None — month-to-month')
      : null],
    ['Renewal', commercialTerms.renewal],
    ['Price adjustment', commercialTerms.priceAdjustment],
    ['Cancellation', commercialTerms.cancellation],
    ['Property access', commercialTerms.accessRequirements],
  ].filter(([, value]) => value != null);
}

// Authored terms govern (codex #3281 r1): canned inclusions stacks must not
// sit beside operator-authored terms that could state the opposite. The
// structured commercialTerms block is authored terms in exactly that sense,
// so it suppresses the stacks the same way free-text `terms` always has.
export function proposalHasAuthoredTerms(proposal) {
  return Boolean(proposal?.terms) || commercialTermRows(proposal?.commercialTerms).length > 0;
}
