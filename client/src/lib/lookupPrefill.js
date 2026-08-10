// Prefill gates for lookup-derived estimator inputs.
//
// The trust rules live SERVER-side in services/lookup-confidence.js (one
// home — the customer-facing pricing assistant and the agent draft path
// apply the same predicates); the lookup stamps each verdict onto the
// enriched profile and these helpers only interpret the stamp.

/**
 * Palm-count prefill (owner ruling 2026-08-10: the AI counts the palms,
 * the operator modifies if need be — the lawn treatable-area pattern).
 *
 * Suppress the prefill ONLY when the server affirmatively distrusted the
 * count (`palmCountTrusted === false`: low field-level confidence, provider
 * divergence, a palm verify flag, or a wrong-premise lookup). A legacy
 * cached payload carries no verdict and keeps the pre-existing prefill —
 * the operator is present and the field stays editable either way. A
 * distrusted count leaves the field EMPTY so the operator counts, rather
 * than anchoring them on prefilled garbage that would ride the
 * service-line override into per-palm injection pricing.
 */
export function palmPrefillAllowed(enrichedProfile) {
  if (!enrichedProfile) return false;
  const count = Number(enrichedProfile.estimatedPalmCount);
  if (!Number.isFinite(count) || count <= 0) return false;
  return enrichedProfile.palmCountTrusted !== false;
}
