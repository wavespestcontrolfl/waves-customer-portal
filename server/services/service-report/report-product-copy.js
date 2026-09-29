/**
 * Report-facing wrapper around the static product-copy config
 * (server/config/report-product-copy.js), gated by GATE_REPORT_PRODUCT_COPY
 * (owner-approved 2026-09-28). See that config module for the wording,
 * matching rules, and fail-closed posture.
 */
const { reportProductCopyFor } = require('../../config/report-product-copy');
const { validateCustomerCopy } = require('./premium-experience');
const { stripFixedReentryTiming, complianceLanguageIssues, REENTRY_SAFE_COPY } = require('../social-media');

// Strict `=== 'true'` — repo gate convention (matches reportPhotoContentLive
// / discountStackingLive in feature-gates.js). The `reportProductCopy`
// gates-map entry in feature-gates.js is for logGateStatus only; this is the
// one canonical CALL-TIME reader every caller must use.
function reportProductCopyGateOn() {
  return process.env.GATE_REPORT_PRODUCT_COPY === 'true';
}

// Every line accompanies an applied product, so product context is implicit.
function passesReportCopyScreen(line) {
  return validateCustomerCopy(line)
    && complianceLanguageIssues(line, { impliedTreatmentContext: true }).length === 0;
}

// `product` is report-data.js's enriched service_products row (the one
// `attachApprovedReportProductFacts` returns) — carries `product_name` /
// `epa_reg_number` when a catalog join resolved, or a hand-entered
// `epa_reg` on legacy rows with no product_id. `city` is the visit's own
// city (report-data.js passes `service.city` — the visit's stamped service
// address city, falling back to the customer's own city; see that call
// site), used ONLY to compose the "Labeled for N+ City pests" sentence
// (owner ruling 2026-09-29) — a missing/unusable city falls back to the
// no-city wording, never blocks the rest of the copy. Returns null on no
// match (unapproved product, or nothing recorded to match on) — fail closed.
function reportProductCopyForApplicationProduct(product = {}, city) {
  const match = {
    epaReg: product?.epa_reg_number || product?.epa_reg || '',
    name: product?.product_name || product?.name || '',
  };
  const copy = reportProductCopyFor({ ...match, city });
  if (!copy) return null;
  // Belt-and-suspenders on reviewed static text, so a config edit that skips
  // re-review still fails closed: the report directory's banned-copy screen
  // plus the shared compliance-language screen ("pet-safe", "EPA-approved").
  if (!passesReportCopyScreen(copy.how_it_works)) return null;
  // The labeled-count line is screened WITHOUT the city (codex r1 on #5352):
  // a locality is data, not a claim, and "Safety Harbor" would otherwise trip
  // the safety-word check and drop all three approved lines.
  if (copy.also_labeled_for) {
    const cityless = reportProductCopyFor({ ...match, city: null })?.also_labeled_for;
    if (!cityless || !passesReportCopyScreen(cityless)) return null;
  }
  // pets_kids is a re-entry-adjacent claim, sanitized at the SOURCE — every
  // mode (live, PDF, static, sms_preview) reads applications through this
  // one function, so stripping here (rather than only in reports-public.js's
  // existing `mode !== 'live'` compliance sweep for precaution_summary /
  // reentry_summary) closes the live-report gap those pre-existing catalog
  // fields still have. AGENTS.md bans a fixed re-entry/drying MINUTE figure
  // on any customer surface; none of the 12 owner-approved lines carry one
  // today (pinned by report-product-copy-reentry-compliance.test.js), so
  // this is a no-op now and a guard against a future config edit.
  //
  // Order matters (codex P2 2026-09-28): stripFixedReentryTiming runs FIRST
  // and passesReportCopyScreen screens the SANITIZED text. A fixed-minute
  // claim ("Wait 30 minutes before re-entering treated areas.") itself trips
  // the compliance screen's own fixed-reentry-time check — screening the raw
  // text first would drop the whole copy block as unapproved, when the
  // sanitizer exists precisely to replace that clause with the safe idiom
  // and let the (now-compliant) line through.
  const pets = stripFixedReentryTiming(copy.pets_kids, REENTRY_SAFE_COPY);
  if (!passesReportCopyScreen(pets.text)) return null;
  return pets.changed ? { ...copy, pets_kids: pets.text } : copy;
}

module.exports = {
  reportProductCopyGateOn,
  reportProductCopyForApplicationProduct,
  passesReportCopyScreen,
};
