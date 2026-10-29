// Structured commercial-proposal sections (slice 1A-i) — shared row/label
// logic for the on-page ProposalDetailCard and the EstimateProposalDocument
// PDF, so the two surfaces can never label a term differently. The SSR card
// in server/routes/estimate-public.js duplicates these labels verbatim (same
// pattern as the commercial inclusions bullets) — change them together.

// commercialTerms → ordered [label, value] rows, omitting absent fields.
// Bid validity is printed in proposal details and enforced by expires_at;
// it is not a second free-text commercial-term promise.
// Canonical payment-terms tokens → customer-facing labels. The tokens are
// the payer system's vocabulary (server payer.js PAYMENT_TERMS) plus the
// proposal-only Auto Pay term (GATE_COMMERCIAL_AUTOPAY), normalized by the
// server; anything unrecognized renders nothing rather than raw data.
export const PAYMENT_TERM_LABELS = {
  autopay: 'Auto Pay',
  due_on_receipt: 'Due on receipt',
  net15: 'Net-15',
  net30: 'Net-30',
};

// The four fixed agreement terms (initial term, renewal, price adjustment, cancellation) apply to a recurring
// program only (owner 2026-10-28): pass { recurring: false } for a one-time-only proposal and they are dropped.
// Without the second argument the rows are exactly as stored.
const FIXED_TERM_LABELS = new Set(['Initial term', 'Renewal', 'Price adjustment', 'Cancellation']);
export function commercialTermRows(commercialTerms, { recurring } = {}) {
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
  ].filter(([label, value]) => value != null && !(recurring === false && FIXED_TERM_LABELS.has(label)));
}

// Authored terms govern (codex #3281 r1): canned inclusions stacks must not
// sit beside operator-authored terms that could state the opposite. The
// structured commercialTerms block is authored terms in exactly that sense,
// so it suppresses the stacks the same way free-text `terms` always has.
export function proposalHasAuthoredTerms(proposal) {
  return Boolean(proposal?.terms) || commercialTermRows(proposal?.commercialTerms).length > 0;
}
