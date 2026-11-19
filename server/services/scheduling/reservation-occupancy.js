'use strict';

// Staff can book a visit before its original hold expires. Expiry only
// releases rows that still have no customer.
function bookedVisitOrLiveHold(query) {
  query.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

module.exports = { bookedVisitOrLiveHold };
