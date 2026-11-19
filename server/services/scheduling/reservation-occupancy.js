'use strict';

// A linked appointment stays booked even if the old estimate hold still has
// an expiry stamp. Only unlinked, stamped holds expire. Use the database
// clock so an offer and its locked booking check agree at the boundary.
function liveServiceOrHold(q) {
  q.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

module.exports = { liveServiceOrHold };
