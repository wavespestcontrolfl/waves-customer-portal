/**
 * Completion-time tier/callback snapshot — the ONE builder every path that
 * creates a service_records row uses (codex #3617 r4 P1: the pest-recap
 * path created rows without is_callback / service_tier /
 * service_tier_source, so recap-completed callbacks lost their identity and
 * membership provenance).
 *
 * The frozen fields are what permanent reports trust: `service_tier` is the
 * customer's WaveGuard tier at the visit, `service_tier_source` its
 * provenance at the visit ('manual' for pre-provenance member rows, 'auto'
 * for derived labels, NULL when there is no tier), and `is_callback` the
 * scheduled row's authoritative callback flag. Column-guarded so
 * pre-migration schemas keep their legacy insert shape.
 */

function completionTierSnapshotFields({
  serviceRecordCols = {},
  waveguardTier = null,
  waveguardTierSource = null,
  isCallback = null,
} = {}) {
  const fields = {};
  if (serviceRecordCols.service_tier) fields.service_tier = waveguardTier || null;
  if (serviceRecordCols.service_tier_source) {
    fields.service_tier_source = waveguardTier ? (waveguardTierSource || 'manual') : null;
  }
  if (serviceRecordCols.is_callback && isCallback !== null) fields.is_callback = isCallback === true;
  return fields;
}

module.exports = { completionTierSnapshotFields };
