/**
 * Completion-time tier/callback snapshot — the ONE builder every path that
 * creates a service_records row uses (codex #3617 r4 P1: the pest-recap
 * path created rows without is_callback / service_tier /
 * service_tier_source, so recap-completed callbacks lost their identity and
 * membership provenance).
 *
 * The frozen fields are what permanent reports trust: `service_tier` is the
 * customer's WaveGuard tier at the visit, `service_tier_source` the
 * CANONICAL provenance DECISION at the visit — not the raw column: a paying
 * member whose waveguard_tier_source is still 'auto' is NOT a label
 * (isAutoDerivedTierLabelRow, the shared predicate the money/messaging
 * gates use), so the snapshot resolves the predicate over the customer's
 * completion-time tier/rate/lane and freezes 'auto' only for a true label
 * (codex #3617 GH-r2 P2). `is_callback` is the scheduled row's
 * authoritative callback flag. Column-guarded so pre-migration schemas keep
 * their legacy insert shape.
 */

const { isAutoDerivedTierLabelRow } = require('./self-booking-plan-sync');

function completionTierSnapshotFields({
  serviceRecordCols = {},
  waveguardTier = null,
  waveguardTierSource = null,
  monthlyRate = null,
  billingMode = null,
  isCallback = null,
} = {}) {
  const fields = {};
  if (serviceRecordCols.service_tier) fields.service_tier = waveguardTier || null;
  if (serviceRecordCols.service_tier_source) {
    if (!waveguardTier) {
      fields.service_tier_source = null;
    } else {
      const isLabel = isAutoDerivedTierLabelRow({
        waveguard_tier: waveguardTier,
        waveguard_tier_source: waveguardTierSource,
        monthly_rate: monthlyRate,
        billing_mode: billingMode,
      });
      // 'auto' in the FROZEN column means exactly "a label at the visit".
      // A non-label (real membership) never freezes 'auto', even when the
      // raw customer column still says so for a paying member — it keeps
      // its raw provenance otherwise, 'manual' as the pre-provenance value.
      fields.service_tier_source = isLabel
        ? 'auto'
        : (waveguardTierSource && waveguardTierSource !== 'auto' ? waveguardTierSource : 'manual');
    }
  }
  if (serviceRecordCols.is_callback && isCallback !== null) fields.is_callback = isCallback === true;
  return fields;
}

module.exports = { completionTierSnapshotFields };
