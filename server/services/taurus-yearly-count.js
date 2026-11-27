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
 *   - application_date in the ET calendar year of today (the completion writers
 *     disagree on the day they record), the home being pah.property_id (frozen at completion),
 *     else the visit's property_id, else no property; a visit with no property_id
 *     counts the whole customer, a visit with one also counts the customer's
 *     applications with no recorded property (over-counting only leaves Taurus
 *     off the mix);
 *   - leaving out the rows of the visit being completed;
 *   - one application = one distinct service record (a record with several
 *     Taurus rows is one application, at its highest concentration).
 *
 * Concentrations (shared/taurus-concentration.cjs): before TAURUS_LOW_RATE_SINCE
 * the owner mixed 3.2 fl oz in a 4-gal tank (0.06%), so those rows count as 0.06%
 * ("high") unless a recorded dilution or a tank concentration says 0.03%. Later rows
 * count as 0.03% ("low") unless the row says otherwise (a dilution of 0.06% or more,
 * a per-gallon rate over 0.4 fl oz/gal, or more product than the 1.6 fl oz house mix).
 *
 * A visit scheduled in a different ET year than today (a December visit closed in
 * January) is checked against BOTH years and counts as eligible only when both say
 * so: no per-writer date rules, the conservative answer.
 *
 * Read only, one query per year (one in the usual case), no row locks.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, dateOnlyString } = require('../utils/datetime-et');

// The concentration rule (the date of the 0.03% ruling, the house mix, units) lives in the shared module, so the
// close-out warning (client lib/taurus-yearly-limit.js) reads an application as this count does.
const { TAURUS_LOW_RATE_SINCE, taurusConcentration } = require('../../shared/taurus-concentration.cjs');

// The close-out picker's own identity rule (client lib/taurus-yearly-limit.js: /^taurus\s*sc\b/i on the trimmed name).
const TAURUS_NAME_PATTERN = '^\\s*taurus\\s*sc\\M';

// The rows that count at all (not retracted, this year, a Taurus SC product): shared by the one-visit and the
// batched reads so the two cannot disagree on what a Taurus application is.
const COUNTED_ROWS_SQL = `
  pah.retracted_at IS NULL
    AND pah.application_date >= CAST(:yearStart AS date)
    AND pah.application_date < CAST(:nextYearStart AS date)
    AND (
      pah.product_id IN (SELECT pc.id FROM products_catalog pc WHERE pc.name ~* :namePattern)
      OR EXISTS (
        SELECT 1 FROM service_products sp
        WHERE sp.id = pah.service_product_id AND sp.product_name ~* :namePattern
      )
    )`;

const LEDGER_SQL = `
  SELECT pah.id,
         pah.service_record_id,
         to_char(pah.application_date, 'YYYY-MM-DD') AS application_date,
         pah.application_rate,
         pah.rate_unit,
         pah.quantity_applied,
         pah.quantity_unit,
         pah.dilution_rate
  FROM property_application_history pah
  LEFT JOIN service_records sr ON sr.id = pah.service_record_id
  LEFT JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
  WHERE ${COUNTED_ROWS_SQL}
    AND NOT EXISTS (
      SELECT 1 FROM service_records cur
      WHERE cur.id = pah.service_record_id AND cur.scheduled_service_id = CAST(:visitId AS uuid)
    )
    -- The label limit is per structure: with a known home, every account's applications at that property
    -- count (a home that changed hands); this customer's rows with no property recorded count too.
    AND (
      (CAST(:propertyId AS uuid) IS NOT NULL AND COALESCE(pah.property_id, ss.property_id) = CAST(:propertyId AS uuid))
      OR (pah.customer_id = :customerId
          AND (CAST(:propertyId AS uuid) IS NULL OR COALESCE(pah.property_id, ss.property_id) IS NULL))
    )
`;

// The same count for many (customer, home) pairs at once: pairs is a JSON list of { customer_id, property_id }.
// No visit is left out (the visits asked about are not completed yet). Each row says which pair it counts for.
const BATCH_LEDGER_SQL = `
  SELECT q.customer_id AS q_customer_id,
         q.property_id AS q_property_id,
         pah.id,
         pah.service_record_id,
         to_char(pah.application_date, 'YYYY-MM-DD') AS application_date,
         pah.application_rate,
         pah.rate_unit,
         pah.quantity_applied,
         pah.quantity_unit,
         pah.dilution_rate
  FROM property_application_history pah
  LEFT JOIN service_records sr ON sr.id = pah.service_record_id
  LEFT JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
  JOIN jsonb_to_recordset(CAST(:pairs AS jsonb)) AS q(customer_id uuid, property_id uuid) ON (
    (q.property_id IS NOT NULL AND COALESCE(pah.property_id, ss.property_id) = q.property_id)
    OR (pah.customer_id = q.customer_id
        AND (q.property_id IS NULL OR COALESCE(pah.property_id, ss.property_id) IS NULL))
  )
  WHERE ${COUNTED_ROWS_SQL}
`;

/** The first day of a calendar year and of the next, as YYYY-MM-DD. */
const yearBoundsOf = (year) => ({ year, yearStart: `${year}-01-01`, nextYearStart: `${year + 1}-01-01` });

/** The ET calendar year of `now`, with its bounds. */
function etYearBounds(now = new Date()) {
  return yearBoundsOf(Number(etDateString(now).slice(0, 4)));
}

/** 'high' (a 0.06% application) or 'low' (0.03%) for one ledger row (shared/taurus-concentration.cjs). */
function applicationConcentration(row) {
  return taurusConcentration({
    dilution: row.dilution_rate,
    rate: row.application_rate,
    rateUnit: row.rate_unit,
    amount: row.quantity_applied,
    amountUnit: row.quantity_unit,
    // A row with no date is read as the older (0.06%) mix.
    beforeRuling: (dateOnlyString(row.application_date) || '') < TAURUS_LOW_RATE_SINCE,
  });
}

/**
 * Label scenarios for the perimeter rate in a calendar year, as the applications
 * already made: another 0.03% application fits when
 *   - no 0.06% application was made and fewer than 4 at 0.03% (4 x 0.03%), or
 *   - one 0.06% application was made and fewer than 2 at 0.03%.
 * Two or more at 0.06% use the year up. With { rate: 'high' }, whether another 0.06%
 * application fits instead: no 0.03% and fewer than 2 at 0.06%, or no 0.06% and at most
 * 2 at 0.03%.
 */
function taurusEligible({ high, low }, { rate = 'low' } = {}) {
  // Another 0.06% application: none yet and up to 2 at 0.03%, or one already and no 0.03%.
  if (rate === 'high') return (low === 0 && high < 2) || (high === 0 && low <= 2);
  if (high >= 2) return false;
  if (high === 1) return low < 2;
  return low < 4;
}

/** The ledger answer for one calendar year. Rejects when the read fails. */
async function yearAnswer(knex, visit, bounds) {
  const result = await knex.raw(LEDGER_SQL, {
    customerId: visit.customer_id,
    propertyId: visit.property_id || null,
    visitId: visit.id || null,
    yearStart: bounds.yearStart,
    nextYearStart: bounds.nextYearStart,
    namePattern: TAURUS_NAME_PATTERN,
  });
  const rows = result?.rows;
  if (!Array.isArray(rows)) throw new Error('no rows');
  const { high, low } = tallyApplications(rows);
  return {
    high, low, count: high + low, year: bounds.year,
    eligible: taurusEligible({ high, low }), eligibleHigh: taurusEligible({ high, low }, { rate: 'high' }),
  };
}

// One application per service record (a row with no record is its own application), at its highest concentration.
function tallyApplications(rows) {
  const byApplication = new Map();
  for (const row of rows) {
    const key = row.service_record_id ? `record:${row.service_record_id}` : `row:${row.id}`;
    const concentration = applicationConcentration(row);
    if (byApplication.get(key) !== 'high') byApplication.set(key, concentration);
  }
  const kinds = [...byApplication.values()];
  const high = kinds.filter((kind) => kind === 'high').length;
  return { high, low: kinds.length - high };
}

/**
 * @param {{ id?: string|null, customer_id?: string|null, property_id?: string|null, scheduled_date?: string|Date|null }} visit
 *   the scheduled_services row being completed
 * @returns {Promise<{ high: number, low: number, count: number, eligible: boolean, eligibleHigh: boolean, year: number, beforeRuling: boolean } | null>}
 *   `eligible`: another 0.03% application fits; `eligibleHigh`: another 0.06% one fits; `beforeRuling`: this visit's
 *   application may be dated before TAURUS_LOW_RATE_SINCE (the close-out warning then reads it as the count will,
 *   shared/taurus-concentration.cjs). null when the history is
 *   unknown (no customer, or the read failed): the close-outs then leave Taurus off the house mix and say so; none blocks.
 */
async function taurusYearlyCount(visit, { knex = db, now = new Date() } = {}) {
  const customerId = visit?.customer_id || null;
  if (!customerId) return null;
  const nowBounds = etYearBounds(now);
  const day = dateOnlyString(visit.scheduled_date);
  const visitYear = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? Number(day.slice(0, 4)) : nowBounds.year;
  const years = visitYear === nowBounds.year ? [nowBounds] : [yearBoundsOf(visitYear), nowBounds];
  try {
    const answers = await Promise.all(years.map((bounds) => yearAnswer(knex, visit, bounds)));
    const shown = answers.find((a) => !a.eligible) || answers.find((a) => !a.eligibleHigh) || answers[0];
    return {
      ...shown,
      eligible: answers.every((a) => a.eligible),
      eligibleHigh: answers.every((a) => a.eligibleHigh),
      // The completion writers date the ledger row the visit day or today: either one before the ruling (the
      // conservative answer).
      beforeRuling: [day, etDateString(now)].some((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d < TAURUS_LOW_RATE_SINCE),
    };
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[taurus-yearly] count unavailable: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

const pairKey = (visit) => `${visit.customer_id}|${visit.property_id || ''}`;

// Whether a projected application (at the home `app`) is one the ledger would count for `visit`'s home: the
// SAME matching as LEDGER_SQL. An application is recorded at its own property (null when it has none). The
// visit counts it when it has a property and the application is at that property (whoever the account is), or
// when it is the same account and either side has no property.
const countsFor = (visit, app) => Boolean(visit.property_id && app.property_id === visit.property_id)
  || (app.customer_id === visit.customer_id && (!visit.property_id || !app.property_id));

/**
 * Whether the house mix will still carry Taurus SC on each of these booked visits, projected: the ledger's count
 * for the home (the same rule as taurusYearlyCount, read once per year for every home), then each visit in date
 * order takes one 0.03% application when one fits, and that application counts for EVERY home the ledger would
 * count it for (two accounts at one property share it; a visit with no property charges the whole account).
 * Each visit is judged in the ET calendar year of its own date only, so a December run covering a January 1 visit
 * reads the new year (the one-visit count, which also asks about today's year, is the close-out's, not this).
 * An unknown history (no customer, or the read failed) leaves Taurus off, as the close-outs do.
 * @param {{ id: string, customer_id?: string|null, property_id?: string|null, scheduled_date?: string|Date|null }[]} visits
 * @returns {Promise<{ fits: Map<string, boolean>, failed: boolean }>}
 */
async function projectTaurusEligibility(visits, { knex = db, now = new Date() } = {}) {
  const thisYear = etYearBounds(now).year;
  const plan = visits.map((visit) => {
    const day = String(dateOnlyString(visit.scheduled_date));
    return { visit, day, bounds: yearBoundsOf(Number(day.slice(0, 4)) || thisYear) };
  });
  const homes = plan.filter(({ visit }) => visit.customer_id);
  const fits = new Map(plan.map(({ visit }) => [visit.id, false]));
  const pairs = [...new Map(homes.map(({ visit }) => [pairKey(visit), { customer_id: visit.customer_id, property_id: visit.property_id || null }])).values()];
  const years = new Map(homes.map(({ bounds }) => [bounds.year, bounds]));
  const counts = new Map();
  try {
    for (const bounds of years.values()) {
      const result = await knex.raw(BATCH_LEDGER_SQL, {
        pairs: JSON.stringify(pairs), yearStart: bounds.yearStart, nextYearStart: bounds.nextYearStart, namePattern: TAURUS_NAME_PATTERN,
      });
      const byHome = new Map();
      for (const row of result.rows) {
        const key = `${row.q_customer_id}|${row.q_property_id || ''}`;
        byHome.set(key, [...(byHome.get(key) || []), row]);
      }
      for (const { customer_id: customer, property_id: property } of pairs) {
        const key = `${customer}|${property || ''}`;
        counts.set(`${bounds.year}|${key}`, tallyApplications(byHome.get(key) || []));
      }
    }
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[taurus-yearly] projected counts unavailable: ${err?.code || err?.name || 'Error'}`);
    return { fits, failed: true };
  }
  const used = [];
  for (const { visit, bounds } of homes.sort((a, b) => a.day.localeCompare(b.day) || String(a.visit.id).localeCompare(String(b.visit.id)))) {
    const ledger = counts.get(`${bounds.year}|${pairKey(visit)}`);
    const projected = used.filter((app) => app.year === bounds.year && countsFor(visit, app)).length;
    const fit = taurusEligible({ high: ledger.high, low: ledger.low + projected });
    fits.set(visit.id, fit);
    if (fit) used.push({ customer_id: visit.customer_id, property_id: visit.property_id || null, year: bounds.year });
  }
  return { fits, failed: false };
}

module.exports = {
  taurusYearlyCount, projectTaurusEligibility, taurusEligible, applicationConcentration, etYearBounds,
  TAURUS_LOW_RATE_SINCE, TAURUS_NAME_PATTERN,
};
