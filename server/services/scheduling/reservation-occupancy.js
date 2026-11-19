'use strict';

// Staff can book a visit before its original hold expires. Expiry only
// releases rows that still have no customer.
function bookedVisitOrLiveHold(query) {
  query.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

// A booked visit restored solely by bookedVisitOrLiveHold: its old hold
// timestamp is already past, but staff attached a customer so it remains an
// authoritative stop. Readers select reservation_lapsed with the DB clock.
function restoredBookedVisit(row) {
  return row?.customer_id != null && row?.reservation_lapsed === true;
}

// Only request roads for stops that were already eligible for provider calls.
// The actual capacity calculation uses the full set of booked visits.
function reservationRoadContext(context, excludeEstimateId) {
  let restoredOnRoute = false;
  const rows = context.rows.filter(row => {
    if (!row.reservation_lapsed
      && !(excludeEstimateId && row.source_estimate_id === excludeEstimateId && row.reservation_expires_at)) return true;
    if (row.technician_id == null || row.technician_id === context.target.technician_id) restoredOnRoute = true;
    return false;
  });
  return { ...context, rows, restoredOnRoute };
}

module.exports = { bookedVisitOrLiveHold, restoredBookedVisit, reservationRoadContext };
