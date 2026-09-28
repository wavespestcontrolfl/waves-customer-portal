/**
 * Report-facing wrapper around the static product-copy config
 * (server/config/report-product-copy.js), gated by GATE_REPORT_PRODUCT_COPY
 * (owner-approved 2026-09-28). See that config module for the wording,
 * matching rules, and fail-closed posture.
 */
const { reportProductCopyFor } = require('../../config/report-product-copy');
const { validateCustomerCopy } = require('./premium-experience');

// Strict `=== 'true'` — repo gate convention (matches reportPhotoContentLive
// / discountStackingLive in feature-gates.js). The `reportProductCopy`
// gates-map entry in feature-gates.js is for logGateStatus only; this is the
// one canonical CALL-TIME reader every caller must use.
function reportProductCopyGateOn() {
  return process.env.GATE_REPORT_PRODUCT_COPY === 'true';
}

// `product` is report-data.js's enriched service_products row (the one
// `attachApprovedReportProductFacts` returns) — carries `product_name` /
// `epa_reg_number` when a catalog join resolved, or a hand-entered
// `epa_reg` on legacy rows with no product_id. Returns null on no match
// (unapproved product, or nothing recorded to match on) — fail closed.
function reportProductCopyForApplicationProduct(product = {}) {
  const copy = reportProductCopyFor({
    epaReg: product?.epa_reg_number || product?.epa_reg || '',
    name: product?.product_name || product?.name || '',
  });
  if (!copy) return null;
  // Same banned-copy screen every other synthesized customer-facing line in
  // this directory runs through (pest-report-expectations.js's module
  // header) before it can render — belt-and-suspenders on reviewed static
  // text, and it keeps this module honest if the config is ever edited
  // without re-review.
  if (!validateCustomerCopy(copy.how_it_works)) return null;
  if (copy.also_labeled_for && !validateCustomerCopy(copy.also_labeled_for)) return null;
  if (!validateCustomerCopy(copy.pets_kids)) return null;
  return copy;
}

// PDF cache-key component — same append-not-switch pattern as
// photo-marks.js's photoMarksPdfSignature: this copy can render on ANY
// service line's "Products Applied" section (not pest-only, so it does not
// ride pest-report-v2.js's pest-line suffix), so '-rpc1' rides EVERY report
// PDF key while the gate is on. A flip re-renders each cached PDF exactly
// once in either direction; empty while off leaves pre-flip keys untouched.
function reportProductCopyPdfSignature() {
  return reportProductCopyGateOn() ? '-rpc1' : '';
}

module.exports = {
  reportProductCopyGateOn,
  reportProductCopyForApplicationProduct,
  reportProductCopyPdfSignature,
};
