const db = require('../models/db');
const logger = require('./logger');
const { dateOnlyStamp } = require('./service-report/time-format');

// Both history columns are DATEs. Same-day service lines belong to the
// customer's first service day, even when their reports finalize separately.
// Never use record creation/id ordering: imports and late reports reorder it.
async function isFirstServiceVisit(customerId, serviceDate, conn = db) {
  const date = dateOnlyStamp(serviceDate);
  if (!customerId || !date) return false;
  try {
    const [report, visit] = await Promise.all([
      // A prior visit is a COMPLETED record (NULL is the column default's
      // legacy shape: completed): an incomplete one (the tech could not
      // finish) is not the customer's first service.
      conn('service_records')
        .where({ customer_id: customerId })
        .where(builder => builder.where('status', 'completed').orWhereNull('status'))
        .where('service_date', '<', date)
        .first('id')
        .timeout(1500, { cancel: true }),
      // A legacy appointment with no record at all still counts; one that has
      // records is decided by them above (its row reads 'completed' even when
      // the only record is incomplete).
      conn('scheduled_services')
        .where({ customer_id: customerId })
        .whereIn('status', ['completed', 'on_site'])
        .where('scheduled_date', '<', date)
        .whereNotExists(function anyRecord() {
          this.select(1).from('service_records')
            .whereRaw('service_records.scheduled_service_id = scheduled_services.id');
        })
        .first('id')
        .timeout(1500, { cancel: true }),
    ]);
    return !report && !visit;
  } catch (err) {
    // Education is optional; an unavailable history must never block delivery
    // or welcome an existing customer as new. Keep driver SQL/bindings out.
    logger.warn('[customer-visit-history] first-visit lookup unavailable', {
      customerId, errorName: err?.name || 'Error',
    });
    return false;
  }
}

module.exports = { isFirstServiceVisit };
