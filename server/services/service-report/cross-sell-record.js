/**
 * The service report's add-a-service card for ONE service record, for a
 * caller outside the report route: the service-report email names that card
 * in its closing line (GATE_DOC_CROSS_SELL_EMAIL, owner 2026-11-21).
 *
 * loadCrossSellService is the row the report's own tap recomputes its offer
 * from (routes/reports-public.js, POST /:token/events). One query for the
 * tap and the email line, so the line names the card the tap confirms.
 */
const logger = require('../logger');
const { stampedLine2Sql } = require('../stamped-address');
const { reserviceReportCopyGateOn } = require('./reservice-report');

// The service-record shape buildReportCrossSell prices from.
function loadCrossSellService(db, serviceRecordId) {
  return db('service_records as sr')
    .leftJoin('customers as c', 'sr.customer_id', 'c.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    .where('sr.id', serviceRecordId)
    .select(
      // scheduled_service_id rides along so the click-path recompute
      // classifies the report by its catalog identity exactly like
      // the read path (codex #3367 PR r4) — omitting it made every
      // valid click 409 whenever the catalog reclassified stale text.
      'sr.id', 'sr.customer_id', 'sr.service_type', 'sr.scheduled_service_id', 'sr.is_callback',
      // service_date/created_at feed the historical-report recency
      // gate (PR r9) — the click path must classify identically.
      'sr.service_date', 'sr.created_at',
      db.raw('COALESCE(ss.service_address_line1, c.address_line1) as address_line1'),
      db.raw(`${stampedLine2Sql('ss', 'c')} as address_line2`),
      db.raw('COALESCE(ss.service_address_city, c.city) as city'),
      db.raw('COALESCE(ss.service_address_zip, c.zip) as zip'),
      'c.first_name', 'c.last_name',
    )
    .first();
}

// The card the report page shows for this record, with the report's
// complaint-visit rule (owner 2026-08-30: no upsell after a callback).
// Best-effort like the report: null on any failure.
async function buildCrossSellForServiceRecord(db, serviceRecordId) {
  try {
    const service = await loadCrossSellService(db, serviceRecordId);
    if (!service?.customer_id) return null;
    if (reserviceReportCopyGateOn() && service.is_callback === true) return null;
    return await require('./cross-sell').buildReportCrossSell(service, db);
  } catch (err) {
    logger.warn(`[cross-sell-record] card suppressed (code=${err?.code || 'none'})`);
    return null;
  }
}

module.exports = { loadCrossSellService, buildCrossSellForServiceRecord };
