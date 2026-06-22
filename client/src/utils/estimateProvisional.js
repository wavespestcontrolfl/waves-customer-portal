// Provisional-estimate state derived from the property-lookup data quality.
//
// A lookup is "provisional" when its data is too thin to trust the auto-priced
// quote as firm: overall data quality scored 'low', OR a critical pricing field
// (square footage / lot / stories / property type) has no source at all. This
// drives a Send banner + a pre-send confirm so a 0/100 lookup (new construction
// absent from every record source) can't be quietly sent to a customer as a
// firm quote. Pure + UI-agnostic so it can be unit-tested without the page.

export function computeProvisionalState(dataQuality) {
  if (!dataQuality) return { provisional: false, verified: 0, total: 4, missing: 0 };
  const verified = Number.isFinite(Number(dataQuality.verifiedCriticalFields))
    ? Number(dataQuality.verifiedCriticalFields)
    : 0;
  const total = Number(dataQuality.totalCriticalFields) > 0
    ? Number(dataQuality.totalCriticalFields)
    : 4;
  // Prefer the precise per-field array; if a payload omits it (a legacy/partial
  // data-quality shape), fall back to total−verified so an unconfirmed critical
  // fact still counts as needing verification rather than silently passing.
  const missing = Array.isArray(dataQuality.missingCriticalFields)
    ? dataQuality.missingCriticalFields.length
    : Math.max(0, total - verified);
  const provisional = dataQuality.level === 'low' || missing > 0;
  return { provisional, verified, total, missing };
}

// Operator-facing one-liner shared by the banner and the confirm dialog.
export function provisionalSummary(state) {
  if (!state?.provisional) return '';
  const missingNote = state.missing > 0 ? `, ${state.missing} missing` : '';
  return `${state.verified}/${state.total} key property facts confirmed${missingNote}`;
}
