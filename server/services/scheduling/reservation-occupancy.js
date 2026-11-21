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

module.exports = { bookedVisitOrLiveHold, bookedVisitOrLiveHoldByRealClock };
