'use strict';

// A staff-booked visit can retain its original reservation expiry. Only an
// unclaimed hold releases its time when the database clock reaches that expiry.
function liveServiceOrHold(q) {
  q.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

module.exports = { liveServiceOrHold };
