'use strict';

// Staff can book a held visit without clearing its original expiration.
// Only an unclaimed hold releases its time when the database clock reaches expiry.
// The clock is NOW() (the transaction's start), or clock_timestamp() (the
// statement's own time) for a read under a lock taken after a wait, so a hold
// that ran out during the wait no longer counts (zone-day-funnel.js zoneStopDays).
function bookedVisitOrHoldLiveAt(clock) {
  return (query) => {
    query.whereNull('scheduled_services.reservation_expires_at')
      .orWhereRaw(`scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > ${clock}`);
  };
}

const bookedVisitOrLiveHold = bookedVisitOrHoldLiveAt('NOW()');
const bookedVisitOrLiveHoldByRealClock = bookedVisitOrHoldLiveAt('clock_timestamp()');

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

module.exports = {
  bookedVisitOrLiveHold, bookedVisitOrLiveHoldByRealClock, restoredBookedVisit, reservationRoadContext,
};
