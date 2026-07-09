/**
 * Single source of truth for "is this recommendation card surfaceable to the
 * customer?". The lawn_snapshot_v1 pipeline that generated these cards is
 * retired; this remains only for the legacy report path's historical reads
 * (service-report/report-data.js). Mirrors the DB CHECK constraint
 * property_recommendation_cards_visible_requires_approval_check.
 *
 * A card surfaces when EITHER:
 *   1. it was admin-approved and made visible (approved_at + customer_visible +
 *      an approved/visible/accepted status), OR
 *   2. it's a low-risk customer_education card flagged requires_human_approval
 *      = false — these auto-publish without an approval/visibility toggle, as
 *      long as they haven't been explicitly taken down (dismissed/expired).
 *
 * Education cards are intentionally still BORN hidden (customer_visible:false,
 * status:'draft') so snapshot supersede can collapse regenerated duplicates;
 * they become visible here, at read time, via branch 2 — not by flipping their
 * stored row.
 */

// Statuses the customer surfaces treat as "approved & showable".
const CUSTOMER_VISIBLE_STATUSES = ['approved', 'customer_visible', 'accepted'];
// Statuses that mean a card was explicitly taken out of customer view.
const CARD_TAKEN_DOWN_STATUSES = ['dismissed', 'expired'];

// Single predicate, applied in-memory by every customer read path. Cards per
// (snapshot, customer) are few, so each path fetches the snapshot's cards and
// filters here — guaranteeing the lawn-health portal and the service report
// agree on exactly what a customer sees.
function isCardCustomerSurfaceable(card = {}) {
  if (!card) return false;
  const approvedAndVisible = card.customer_visible === true
    && CUSTOMER_VISIBLE_STATUSES.includes(card.status)
    && card.approved_at != null;
  const autoPublishEducation = card.type === 'customer_education'
    && card.requires_human_approval === false
    && !CARD_TAKEN_DOWN_STATUSES.includes(card.status);
  return approvedAndVisible || autoPublishEducation;
}

module.exports = {
  CUSTOMER_VISIBLE_STATUSES,
  CARD_TAKEN_DOWN_STATUSES,
  isCardCustomerSurfaceable,
};
