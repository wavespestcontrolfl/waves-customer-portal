/**
 * Durable identities of the lines on an annual-prepay invoice (invoices.line_items), so the readers that slice the invoice across the
 * covered visits never guess from description text.
 *
 *  - ANNUAL_PREPAY_COVERAGE_LINE_KIND: the 12-month coverage line the converter mints. Its amount IS the per-visit coverage money.
 *  - Marked one-time charges (the misting installation, kind misting_installation) ride the same invoice but are not coverage.
 *  - Setup lines (WaveGuard / bait station / termite station) are recognized by the immutable setup_fee_claims ledger, else by text.
 *
 * LEGACY invoices (minted before the coverage kind) carry no kind. Their coverage line is recognized by the converter's own wording
 * ("... — 12 months prepaid", with an optional "(setup fee waived)" or "(N% prepay discount)" suffix), which must never be read as a
 * setup line even though a waived-setup coverage line contains the word "setup".
 */
const ANNUAL_PREPAY_COVERAGE_LINE_KIND = 'annual_prepay_coverage';
const LEGACY_COVERAGE_DESCRIPTION_RE = /12 months prepaid/i;

function isAnnualPrepayCoverageLine(line) {
  return !!line && typeof line === 'object' && line.kind === ANNUAL_PREPAY_COVERAGE_LINE_KIND;
}

// A line that looks like the converter's coverage line by wording (legacy invoices without the kind).
function looksLikeLegacyCoverageDescription(line) {
  return LEGACY_COVERAGE_DESCRIPTION_RE.test(String((line && line.description) || ''));
}

module.exports = {
  ANNUAL_PREPAY_COVERAGE_LINE_KIND,
  LEGACY_COVERAGE_DESCRIPTION_RE,
  isAnnualPrepayCoverageLine,
  looksLikeLegacyCoverageDescription,
};
