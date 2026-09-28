/**
 * Email division — monthly area intelligence: "what technicians found in
 * the customer's city this month", a CITY-LEVEL aggregate only (never a
 * customer id, address, or name). A city with fewer than 5 visits that
 * month never gets a row — too few visits to risk re-identifying one.
 */

const db = require('../../models/db');
const { etMonthStart, etMonthEnd } = require('../../utils/datetime-et');
const { parsePestsNamed } = require('./visit-products');

const MIN_CITY_VISITS = 5;

/** Recomputes and upserts every city's row for one ET calendar month.
 * Replaces the WHOLE month's aggregate atomically (a city with no
 * qualifying rows this run, e.g. after a data correction, loses its old
 * row instead of it surviving stale). */
async function computeAreaIntel({ month = new Date(), conn = db } = {}) {
  const monthStart = etMonthStart(month);
  const monthEnd = etMonthEnd(month);
  const rows = await conn('service_records as sr')
    .join('customers as c', 'c.id', 'sr.customer_id')
    .whereNotNull('sr.technician_notes')
    .whereRaw("btrim(sr.technician_notes) <> ''")
    .where('sr.service_date', '>=', monthStart)
    .where('sr.service_date', '<=', monthEnd)
    .select('sr.technician_notes', 'c.city');

  const byCity = new Map();
  for (const row of rows) {
    const city = String(row.city || '').trim().toLowerCase();
    if (!city) continue;
    if (!byCity.has(city)) byCity.set(city, { visits: 0, pestCounts: new Map() });
    const entry = byCity.get(city);
    entry.visits += 1;
    for (const pest of new Set(parsePestsNamed(row.technician_notes))) {
      entry.pestCounts.set(pest, (entry.pestCounts.get(pest) || 0) + 1);
    }
  }

  const summary = [];
  await conn.transaction(async (trx) => {
    await trx('email_area_intel_monthly').where({ month: monthStart }).del();
    for (const [city, entry] of byCity) {
      if (entry.visits < MIN_CITY_VISITS) continue;
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
  const pct = Math.round((top.visits_with_pest / top.visits) * 100);
  if (pct < 10) return null;
  const monthName = new Date(`${monthStart}T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `In ${monthName} our technicians treated ${top.pest_key} at ${pct}% of our ${top.visits} visits in ${String(city).trim()}.`;
}

module.exports = { computeAreaIntel, getAreaIntelSentence, MIN_CITY_VISITS };
