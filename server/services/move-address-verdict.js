'use strict';

/**
 * One rule for what a Google address check means for a customer who is moving.
 * Shared by the portal cancellation flow (routes/requests.js) and the moving
 * link flow (services/customer-moves.js) so the two can never disagree.
 *
 *   true  = a fully accepted address that is inside the service area
 *   false = an accepted address that is OUTSIDE the service area
 *   null  = anything partial (ambiguous, missing component, confirm-needed,
 *           API unavailable): no verdict
 */
function cancelMoveAddressVerdict(verdict, STATUSES) {
  if (!verdict) return null;
  if (verdict.status === STATUSES.OUT_OF_SERVICE_AREA) return false;
  const accepted = verdict.status === STATUSES.VALIDATED_ACCEPT || verdict.status === STATUSES.CORRECTED;
  if (!accepted || verdict.inServiceArea !== true) return null;
  return true;
}

// The moving page's stored label for the same verdict.
function moveVerdictLabel(verdict, STATUSES) {
  const inArea = cancelMoveAddressVerdict(verdict, STATUSES);
  if (inArea === true) return 'in_area';
  if (inArea === false) return 'out_of_area';
  return 'unverified';
}

module.exports = { cancelMoveAddressVerdict, moveVerdictLabel };
