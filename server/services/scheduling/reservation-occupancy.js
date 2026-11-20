'use strict';

// Staff can book a held visit without clearing its original expiration.
// Only an unclaimed hold releases its time when the database clock reaches expiry.
function bookedVisitOrLiveHold(query) {
  query.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

module.exports = { bookedVisitOrLiveHold };
