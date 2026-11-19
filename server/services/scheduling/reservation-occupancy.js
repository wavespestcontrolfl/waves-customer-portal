'use strict';

// A staff-booked visit can retain its original reservation expiry. Only an
// unclaimed hold releases its time when the database clock reaches that expiry.
const bookedOrLiveHold = 'scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()';
const LIVE_SERVICE_OR_HOLD_SQL = `(scheduled_services.reservation_expires_at IS NULL OR ${bookedOrLiveHold})`;
function liveServiceOrHold(q) {
  q.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw(bookedOrLiveHold);
}

module.exports = { liveServiceOrHold, LIVE_SERVICE_OR_HOLD_SQL };
