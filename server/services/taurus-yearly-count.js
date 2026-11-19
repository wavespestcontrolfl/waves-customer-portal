/**
 * taurus-yearly-count
 *
 * Taurus SC (EPA 53883-279): the perimeter pest label allows the 0.03% rate on
 * up to 4 applications per home per calendar year, or fewer when a 0.06%
 * application was used (label scenarios below). Owner ruling 2026-11-19, "A":
 * the house mix is 1.6 fl oz per 4-gal tank = 0.03%. The close-out surfaces
 * leave Taurus out of the house mix when another 0.03% application does not fit;
 * this answers that for ONE visit.
 *
 * The source is the compliance LEDGER (property_application_history), the
 * record of what was applied where and on what day:
 *   - rows that are not retracted (retracted_at IS NULL), whose product is a
 *     catalog row named Taurus SC (the close-out picker's name rule: case and
 *     spacing are ignored; a retired catalog row still counts as history);
 *   - application_date in the ET calendar year of today (the day the completion
 *     writer records), the home being pah.property_id (frozen at completion),
 *     else the visit's property_id, else no property; a visit with no property_id
 *     counts the whole customer, a visit with one also counts the customer's
 *     applications with no recorded property (over-counting only leaves Taurus
 *     off the mix);
 *   - leaving out the rows of the visit being completed;
 *   - one application = one distinct service record (a record with several
 *     Taurus rows is one application, at its highest concentration).
 *
 * Concentrations: before TAURUS_LOW_RATE_SINCE the owner mixed 3.2 fl oz in a
 * 4-gal tank (0.06%), so those rows count as 0.06% ("high"). Later rows count as
 * 0.03% ("low") unless the row says otherwise (a fl_oz/gal rate over 0.4, or a
 * dilution_rate of 0.06% or more).
 *
 * Read only, one query, no row locks.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// The owner's 2026 mix (3.2 fl oz per 4 gal, 0.06%) ran until ruling "A" (2026-11-19) set 1.6 fl oz; the first
// application date counted at 0.03% unless the row says otherwise.
const TAURUS_LOW_RATE_SINCE = '2026-11-20';

// 1.6 fl oz per 4 gal = 0.4 fl oz/gal = 0.03%; a fl_oz/gal rate above that is the 0.06% mix.
const LOW_RATE_MAX_FL_OZ_PER_GAL = 0.4;
const HIGH_DILUTION_PERCENT = 0.06;

// The close-out picker's own identity rule (client lib/taurus-yearly-limit.js: /^taurus\s*sc\b/i on the trimmed name).
const TAURUS_NAME_PATTERN = '^\\s*taurus\\s*sc\\M';

const LEDGER_SQL = `
  SELECT pah.id,
         pah.service_record_id,
         to_char(pah.application_date, 'YYYY-MM-DD') AS application_date,
         pah.application_rate,
         pah.rate_unit,
         pah.dilution_rate
  FROM property_application_history pah
  LEFT JOIN service_records sr ON sr.id = pah.service_record_id
  LEFT JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
  WHERE pah.customer_id = :customerId
    AND pah.retracted_at IS NULL
    AND pah.application_date >= CAST(:yearStart AS date)
    AND pah.application_date < CAST(:nextYearStart AS date)
    AND pah.product_id IN (SELECT pc.id FROM products_catalog pc WHERE pc.name ~* :namePattern)
    AND NOT EXISTS (
      SELECT 1 FROM service_records cur
      WHERE cur.id = pah.service_record_id AND cur.scheduled_service_id = CAST(:visitId AS uuid)
    )
    AND (
      CAST(:propertyId AS uuid) IS NULL
      OR COALESCE(pah.property_id, ss.property_id) = CAST(:propertyId AS uuid)
      OR COALESCE(pah.property_id, ss.property_id) IS NULL
    )
`;

/** [first day of the ET calendar year, first day of the next], as YYYY-MM-DD. */
function etYearBounds(now = new Date()) {
  const year = Number(etDateString(now).slice(0, 4));
  return { year, yearStart: `${year}-01-01`, nextYearStart: `${year + 1}-01-01` };
}

/** 'high' (a 0.06% application) or 'low' (0.03%) for one ledger row. */
function applicationConcentration(row) {
  if (String(row.application_date || '').slice(0, 10) < TAURUS_LOW_RATE_SINCE) return 'high';
  const unit = String(row.rate_unit || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (unit === 'fl_oz/gal' && Number(row.application_rate) > LOW_RATE_MAX_FL_OZ_PER_GAL) return 'high';
  const dilution = parseFloat(String(row.dilution_rate ?? '').replace('%', ''));
  if (Number.isFinite(dilution) && dilution >= HIGH_DILUTION_PERCENT) return 'high';
  return 'low';
}

/**
 * Label scenarios for the perimeter rate in a calendar year, as the applications
 * already made: another 0.03% application fits when
 *   - no 0.06% application was made and fewer than 4 at 0.03% (4 x 0.03%), or
 *   - one 0.06% application was made and fewer than 2 at 0.03%.
 * Two or more at 0.06% use the year up.
 */
function taurusEligible({ high, low }) {
  if (high >= 2) return false;
  if (high === 1) return low < 2;
  return low < 4;
}

/**
 * @param {{ id?: string|null, customer_id?: string|null, property_id?: string|null }} visit
 *   the scheduled_services row being completed
 * @returns {Promise<{ high: number, low: number, count: number, eligible: boolean, year: number } | null>}
 *   null when the history is unknown (no customer, or the read failed): the
 *   close-outs then leave Taurus off the house mix and say so; none blocks.
 */
async function taurusYearlyCount(visit, { knex = db, now = new Date() } = {}) {
  const customerId = visit?.customer_id || null;
  if (!customerId) return null;
  const { year, yearStart, nextYearStart } = etYearBounds(now);
  try {
    const result = await knex.raw(LEDGER_SQL, {
      customerId,
      propertyId: visit.property_id || null,
      visitId: visit.id || null,
      yearStart,
      nextYearStart,
      namePattern: TAURUS_NAME_PATTERN,
    });
    const rows = result?.rows;
    if (!Array.isArray(rows)) return null;
    // One application per service record (a row with no record is its own application), at its highest concentration.
    const byApplication = new Map();
    for (const row of rows) {
      const key = row.service_record_id ? `record:${row.service_record_id}` : `row:${row.id}`;
      const concentration = applicationConcentration(row);
      if (byApplication.get(key) !== 'high') byApplication.set(key, concentration);
    }
    const kinds = [...byApplication.values()];
    const high = kinds.filter((kind) => kind === 'high').length;
    const low = kinds.length - high;
    return { high, low, count: kinds.length, eligible: taurusEligible({ high, low }), year };
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[taurus-yearly] count unavailable: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

module.exports = {
  taurusYearlyCount, taurusEligible, applicationConcentration, etYearBounds,
  TAURUS_LOW_RATE_SINCE, TAURUS_NAME_PATTERN,
};
