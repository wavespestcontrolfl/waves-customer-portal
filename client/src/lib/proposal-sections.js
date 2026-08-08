// Structured commercial-proposal sections (slice 1A-i) — shared row/label
// logic for the on-page ProposalDetailCard and the EstimateProposalDocument
// PDF, so the two surfaces can never label a term differently. The SSR card
// in server/routes/estimate-public.js duplicates these labels verbatim (same
// pattern as the commercial inclusions bullets) — change them together.

// commercialTerms → ordered [label, value] rows, omitting absent fields.
// validDays deliberately does NOT render: the send flow stamps the enforced
// expiry (estimates.expires_at, printed as "Valid through") from the fixed
// ESTIMATE_SEND_EXPIRY_DAYS, so an authored validity period would contradict
// the date acceptance actually enforces (codex 1A-i r1). The field stays in
// the normalizer, reserved for the adjustable-expiry lane that will wire
// enforcement and rendering together.
// Canonical payment-terms tokens → customer-facing labels. The tokens are
// the payer system's vocabulary (server payer.js PAYMENT_TERMS), normalized
// by the server; anything unrecognized renders nothing rather than raw data.
export const PAYMENT_TERM_LABELS = {
  due_on_receipt: 'Due on receipt',
  net15: 'Net-15',
  net30: 'Net-30',
};

export function commercialTermRows(commercialTerms) {
  if (!commercialTerms || typeof commercialTerms !== 'object') return [];
  return [
    ['Payment', PAYMENT_TERM_LABELS[commercialTerms.paymentTerms] || null],
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
