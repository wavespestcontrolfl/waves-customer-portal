'use strict';
// The ONE formatter for the series-price-template part of a scoped cancel's
// approved pricing. The preview facts (admin-cancellation), the commit's
// approvedScopedPricing string (admin-cancellation) and the processor's
// scopedPricingFingerprint all build their template part from here, so the
// approved string and the boundary re-plan string cannot drift apart.
// Pure on purpose: no imports, safe to require lazily from any of them.

// Sorted `rootId:field:before:after` keys of a list of template rows.
function scopedTemplateKeys(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => `${r.rootId}:${r.field}:${r.before}:${r.after}`).sort();
}

// The `templates=` part appended to the scoped pricing fingerprint.
function scopedTemplatesPart(rows) {
  return `templates=${scopedTemplateKeys(rows).join(',')}`;
}

module.exports = { scopedTemplateKeys, scopedTemplatesPart };
