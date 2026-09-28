/**
 * Email division — monthly area intelligence: "what technicians found in
 * the customer's city this month", a CITY-LEVEL aggregate only (never a
 * customer id, address, or name). A city with fewer than 5 DISTINCT
 * customers that month never gets a row — one customer with several
 * visits (multiple service lines, callbacks) must never alone clear the
 * re-identification floor; `visits` (the raw visit count) is still the
 * stored/sentence denominator once the floor clears.
 */

const db = require('../../models/db');
const { etMonthStart, etMonthEnd } = require('../../utils/datetime-et');
const { parsePestsNamed } = require('./visit-products');

const MIN_CITY_CUSTOMERS = 5;

/** Recomputes and upserts every city's row for one ET calendar month.
 * Replaces the WHOLE month's aggregate atomically (a city with no
 * qualifying rows this run, e.g. after a data correction, loses its old
 * row instead of it surviving stale). */
async function computeAreaIntel({ month = new Date(), conn = db } = {}) {
  const monthStart = etMonthStart(month);
  const monthEnd = etMonthEnd(month);
  // City = the booked visit address (scheduled_services.service_address_city,
  // the immutable booking-time stamp), falling back to the customer's own
  // city on an unstamped/unlinked row — the same COALESCE legacy fallback
  // every other reader of this stamp uses. Never the account's CURRENT city:
  // a rental or second property must not have its visits credited to the
  // customer's primary address. Only performed visits count (status =
  // 'completed'; 'incomplete' is an office-handoff closeout for a visit
  // that did NOT happen). Every completed visit counts toward the
  // denominator whether or not it has technician_notes — a completed visit
  // with blank notes still happened and must not silently shrink `visits`
  // (and so understate the true visit volume behind the percentage in
  // getAreaIntelSentence); parsePestsNamed itself returns
  // [] for blank notes, so no separate notes filter is needed for the
  // pest-mention numerator either.
  const rows = await conn('service_records as sr')
    .join('customers as c', 'c.id', 'sr.customer_id')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.status', 'completed')
    .where('sr.service_date', '>=', monthStart)
    .where('sr.service_date', '<=', monthEnd)
    .select('sr.customer_id', 'sr.technician_notes', conn.raw('COALESCE(ss.service_address_city, c.city) as city'));

  const byCity = new Map();
  for (const row of rows) {
    const city = String(row.city || '').trim().toLowerCase();
    if (!city) continue;
    if (!byCity.has(city)) byCity.set(city, { visits: 0, customers: new Set(), pestCounts: new Map() });
    const entry = byCity.get(city);
    entry.visits += 1;
    entry.customers.add(row.customer_id);
    for (const pest of new Set(parsePestsNamed(row.technician_notes))) {
      entry.pestCounts.set(pest, (entry.pestCounts.get(pest) || 0) + 1);
    }
  }

  const summary = [];
  await conn.transaction(async (trx) => {
    await trx('email_area_intel_monthly').where({ month: monthStart }).del();
    for (const [city, entry] of byCity) {
      // The privacy floor is distinct CUSTOMERS, not raw visit records — one
      // customer with 5+ completed visits in a city-month (multiple
      // service lines, callbacks) must never alone clear the
      // re-identification floor. `visits` (the raw record count) still
      // becomes the stored/sentence denominator once the floor clears.
      if (entry.customers.size < MIN_CITY_CUSTOMERS) continue;
      const toInsert = [...entry.pestCounts.entries()]
        .filter(([, count]) => count > 0)
        .map(([pestKey, count]) => ({
          month: monthStart, city, visits: entry.visits,
          pest_key: pestKey, visits_with_pest: count, computed_at: new Date(),
        }));
      if (toInsert.length) await trx('email_area_intel_monthly').insert(toInsert);
      summary.push({ city, visits: entry.visits, pestsRecorded: toInsert.length });
    }
  });

  return { month: monthStart, citiesProcessed: summary.length, summary };
}

/** A single sentence for the top pest in a city that month, or null when the
 * city didn't clear `minVisits` visits or no pest reached 10% of them. */
async function getAreaIntelSentence({ city, month = new Date(), minVisits = 20, conn = db } = {}) {
  const monthStart = etMonthStart(month);
  const cityKey = String(city || '').trim().toLowerCase();
  if (!cityKey) return null;

  const rows = await conn('email_area_intel_monthly')
    .where({ month: monthStart, city: cityKey })
    .orderBy([{ column: 'visits_with_pest', order: 'desc' }, { column: 'pest_key', order: 'asc' }]);
  if (!rows.length || rows[0].visits < minVisits) return null;
  const [top] = rows;
  // Compare the unrounded ratio to the 10% floor first — 2/21 = 9.52%
  // rounds to "10%" but must still fail the floor, not pass it.
  const ratio = top.visits_with_pest / top.visits;
  if (ratio < 0.10) return null;
  const pct = Math.round(ratio * 100);
  const monthName = new Date(`${monthStart}T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `In ${monthName} our technicians treated ${top.pest_key} at ${pct}% of our ${top.visits} visits in ${String(city).trim()}.`;
}

module.exports = { computeAreaIntel, getAreaIntelSentence, MIN_CITY_CUSTOMERS };
