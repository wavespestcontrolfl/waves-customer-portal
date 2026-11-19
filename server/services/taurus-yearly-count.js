/**
 * taurus-yearly-count
 *
 * Taurus SC (EPA 53883-279) allows the 0.03% perimeter pest rate on up to 4
 * applications per home per calendar year (owner ruling 2026-11-19, "A").
 * The close-out surfaces leave Taurus out of the house mix once a home is at
 * the limit; this answers "how many times this year" for ONE visit.
 *
 * A home is scheduled_services.property_id. A visit with no property_id falls
 * back to the customer (every record of that customer). A visit WITH a
 * property_id counts that property's records plus the customer's records whose
 * visit carries no property_id (older rows): an unattributed record may be this
 * home's, and over-counting only leaves Taurus off the mix, never over the
 * label.
 *
 * Count = distinct service dates of non-cancelled service_records in the
 * current ET calendar year that carry a Taurus SC product row (the active
 * catalog row named exactly "Taurus SC" by product_id, or an older row by
 * product_name), leaving out the record of the visit being completed. Read
 * only, one query, no row locks.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, dateOnlyString } = require('../utils/datetime-et');

const TAURUS_YEARLY_LIMIT = 4;
const TAURUS_PRODUCT_NAME = 'Taurus SC';

const COUNT_SQL = `
  SELECT COUNT(DISTINCT sr.service_date)::int AS count
  FROM service_records sr
  LEFT JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
  WHERE sr.customer_id = :customerId
    AND sr.service_date >= CAST(:yearStart AS date)
    AND sr.service_date < CAST(:nextYearStart AS date)
    AND sr.status IS DISTINCT FROM 'cancelled'
    AND sr.scheduled_service_id IS DISTINCT FROM CAST(:visitId AS uuid)
    AND (
      CAST(:propertyId AS uuid) IS NULL
      OR ss.property_id = CAST(:propertyId AS uuid)
      OR ss.property_id IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM service_products sp
      WHERE sp.service_record_id = sr.id
        AND (
          sp.product_name = :productName
          OR sp.product_id IN (
            SELECT pc.id FROM products_catalog pc
            WHERE pc.name = :productName AND pc.active = true
          )
        )
    )
`;

/**
 * [first day of the calendar year, first day of the next], as YYYY-MM-DD. The year is the visit's own
 * scheduled date when it has one (a December visit closed out in January counts toward December's year),
 * else today in ET.
 */
function etYearBounds(now = new Date(), scheduledDate = null) {
  const day = scheduledDate ? dateOnlyString(scheduledDate) : null;
  const year = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? Number(day.slice(0, 4)) : Number(etDateString(now).slice(0, 4));
  return { year, yearStart: `${year}-01-01`, nextYearStart: `${year + 1}-01-01` };
}

/**
 * @param {{ id?: string|null, customer_id?: string|null, property_id?: string|null, scheduled_date?: string|Date|null }} visit
 *   the scheduled_services row being completed
 * @returns {Promise<{ count: number, limit: number, year: number } | null>}
 *   null when the count is unknown (no customer, or the read failed): callers
 *   keep today's behavior and never block a close-out.
 */
async function taurusYearlyCount(visit, { knex = db, now = new Date() } = {}) {
  const customerId = visit?.customer_id || null;
  if (!customerId) return null;
  const { year, yearStart, nextYearStart } = etYearBounds(now, visit.scheduled_date || null);
  try {
    const result = await knex.raw(COUNT_SQL, {
      customerId,
      propertyId: visit.property_id || null,
      visitId: visit.id || null,
      yearStart,
      nextYearStart,
      productName: TAURUS_PRODUCT_NAME,
    });
    const count = Number(result?.rows?.[0]?.count);
    return Number.isFinite(count) ? { count, limit: TAURUS_YEARLY_LIMIT, year } : null;
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[taurus-yearly] count unavailable: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

module.exports = { taurusYearlyCount, etYearBounds, TAURUS_YEARLY_LIMIT, TAURUS_PRODUCT_NAME };
