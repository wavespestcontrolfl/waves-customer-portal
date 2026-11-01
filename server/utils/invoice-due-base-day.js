'use strict';

/**
 * The day a visit invoice's due date counts from. Shared by the single-visit completion mint
 * (services/complete-scheduled-service.js) and the combined-visit packet mint
 * (services/visit-completion-invoice.js) so a late closeout dates both bills the same way.
 */
const { etDateString } = require('./datetime-et');

function serviceDateOnly(value) {
  return value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : etDateString();
}

// The day a completion's invoice is due from: the record's service day, never
// before today. A backdated record (a backfill, or a late form dated to the
// tech's arrival day) would otherwise mint its invoice instantly overdue and
// light up the dunning and overdue surfaces.
function invoiceDueBaseDay(recordServiceDate, today = etDateString()) {
  const day = serviceDateOnly(recordServiceDate);
  return day < today ? today : day;
}

module.exports = { serviceDateOnly, invoiceDueBaseDay };
