'use strict';

const LIVE_SERVICE_OR_HOLD_SQL = '(scheduled_services.customer_id IS NOT NULL'
  + ' OR scheduled_services.reservation_expires_at IS NULL'
  + ' OR scheduled_services.reservation_expires_at > NOW())';

// A linked appointment stays booked even if the old estimate hold still has
// an expiry stamp. Only unlinked, stamped holds expire. Use the database
// clock so an offer and its locked booking check agree at the boundary.
function liveServiceOrHold(q) {
  q.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

function serviceOrHoldIsLive(row, now = Date.now()) {
  return row?.customer_id != null
    || row?.reservation_expires_at == null
    || new Date(row.reservation_expires_at).getTime() > now;
}

module.exports = { LIVE_SERVICE_OR_HOLD_SQL, liveServiceOrHold, serviceOrHoldIsLive };
