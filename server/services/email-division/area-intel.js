/**
 * Email division — monthly area intelligence: "what technicians found in
 * the customer's city this month", a CITY-LEVEL aggregate only (never a
 * customer id, address, or name). A city with fewer than 5 DISTINCT
 * customers that month never gets a row — one customer with several
 * visits (multiple service lines, callbacks) must never alone clear the
 * re-identification floor; `visits` (the raw visit count) is still the
 * stored/sentence denominator once the floor clears. The pest numerator
 * is structured application targets only (service_products.targets, the
 * canonical completion-picker / product-label chips, counted as recorded),
 * never technician_notes. This file is the authority on both rules; the
 * table's migration header (20260928070000, frozen once pushed) predates
 * them and still says "named in technician_notes" / "5-visit floor".
 */

const db = require('../../models/db');
const { etMonthStart, etMonthEnd } = require('../../utils/datetime-et');
const { treatmentTargets, treatmentTargetKey } = require('./visit-products');
const { applyCustomerVisibleServiceRecordFilter } = require('../pest-pressure/history-filter');
const { NON_PERFORMED_VISIT_OUTCOMES } = require('../pest-pressure/first-visit');
const {
  PEST_TARGET_SUGGESTIONS, LAWN_TARGET_SUGGESTIONS, ORNAMENTAL_TARGET_SUGGESTIONS, NUTRITION_TARGET_SUGGESTIONS,
} = require('../../config/treatment-target-vocabulary');

const MIN_CITY_CUSTOMERS = 5;
const TARGET_READ_CHUNK = 1000;

// The completion picker also accepts free text alongside its suggestion
// lists (SchedulePage.jsx ~23610-23615: a custom chip on the datalist
// input), so a hand-typed value ("technicians treated no pests -
// prevention") persists on service_products.targets exactly like a real
// species and would otherwise flow straight into a quoted customer
// sentence if it landed on enough visits. A target is sentence-eligible
// only when it is in the CANONICAL vocabulary — the union of the picker's
// own suggestion lists (this static half) and products_catalog.target_pests
// (the DB half, read fresh per run below) — never a keyword allowlist that
// could silently drop a real, uncatalogued species (codex round 9 P2 on
// #5164). A non-vocabulary target still counts toward `treatmentTargets`'
// internal evidence elsewhere; it is only excluded from what this file
// persists (the ONLY input to getAreaIntelSentence's quoted string).
const PICKER_VOCAB_KEYS = new Set(
  [...PEST_TARGET_SUGGESTIONS, ...LAWN_TARGET_SUGGESTIONS, ...ORNAMENTAL_TARGET_SUGGESTIONS, ...NUTRITION_TARGET_SUGGESTIONS]
    .map((target) => treatmentTargetKey(target))
    .filter(Boolean),
);

/** The full canonical target vocabulary for one compute run: the static
 * picker lists above, unioned with every products_catalog.target_pests
 * value read fresh from the DB (a catalog edit takes effect on the next
 * run, no redeploy) — same key normalisation `treatmentTargets` already
 * counts with, so the comparison is case-/space-insensitive. */
async function canonicalTargetVocabulary(conn) {
  const rows = await conn('products_catalog').select('target_pests');
  const catalogKeys = rows
    .flatMap((row) => (Array.isArray(row.target_pests) ? row.target_pests : []))
    .map((target) => treatmentTargetKey(target))
    .filter(Boolean);
  return new Set([...PICKER_VOCAB_KEYS, ...catalogKeys]);
}

/** Recomputes and upserts every city's row for one ET calendar month.
 * Replaces the WHOLE month's aggregate atomically (a city with no
 * qualifying rows this run, e.g. after a data correction, loses its old
 * row instead of it surviving stale). */
async function computeAreaIntel({ month = new Date(), conn = db } = {}) {
  const monthStart = etMonthStart(month);
  const monthEnd = etMonthEnd(month);
  // City = ONLY the booked visit's own frozen stamp
  // (scheduled_services.service_address_city, written once at booking and
  // never rewritten by anything later). NEVER customers.city — that mirror
  // is rewritten in place whenever the account's primary property flips
  // (property-role-proposals.js's primary-flip transaction), so falling
  // back to it can move an OLD, already-recomputed visit into a city it
  // never happened in on some later month's recompute, contaminating both
  // cities' counts and sentence (codex round 10 P2 on #5164). An unlinked
  // service record or a legacy row with no city stamp at all has no frozen
  // city to attribute — it is OMITTED from area intel below (the existing
  // `if (!city) continue`), never guessed from the mutable mirror. Only
  // PERFORMED, customer-visible visits
  // count — status = 'completed' is not enough on its own (a completed row
  // can still carry structured_notes.visitOutcome 'customer_declined' or
  // 'inspection_only'); this reuses the exact predicate
  // getActivityRatingAverages below does, straight from Pest Pressure's own
  // first-visit history (server/services/pest-pressure/first-visit.js +
  // history-filter.js), never re-derived. Every performed, visible visit
  // counts toward the denominator whether or not it recorded any target —
  // a visit with no targets still happened and must not silently shrink
  // `visits` (and so understate the true visit volume behind the
  // percentage in getAreaIntelSentence).
  //
  // The pest numerator counts STRUCTURED treatment evidence only — the
  // targets recorded on the visit's applied products (service_products.
  // targets, via treatmentTargets) — never technician_notes free text, where
  // a pest can be merely observed or negated ("saw a few fire ants", "no
  // fire ants found") and would turn into a false "technicians treated X".
  const query = conn('service_records as sr')
    // Existence filter only (excludes a visit whose customer_id no longer
    // resolves) — its `city` is never read; see the city stamp note above.
    .join('customers as c', 'c.id', 'sr.customer_id')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.status', 'completed')
    .where('sr.service_date', '>=', monthStart)
    .where('sr.service_date', '<=', monthEnd);
  applyCustomerVisibleServiceRecordFilter(query, { alias: 'sr' });
  query.whereRaw(
    `COALESCE(sr.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`,
    NON_PERFORMED_VISIT_OUTCOMES,
  );
  const rows = await query
    .select('sr.id', 'sr.customer_id', 'ss.service_address_city as city');

  const productsByVisit = new Map();
  const visitIds = rows.map((row) => row.id);
  for (let i = 0; i < visitIds.length; i += TARGET_READ_CHUNK) {
    const productRows = await conn('service_products as sp')
      .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
      .whereIn('sp.service_record_id', visitIds.slice(i, i + TARGET_READ_CHUNK))
      .select('sp.service_record_id', 'sp.targets', 'sp.product_name', 'sp.active_ingredient', 'sp.product_category',
        'pc.category as catalog_category', 'pc.product_type as catalog_product_type');
    for (const product of productRows) {
      if (!productsByVisit.has(product.service_record_id)) productsByVisit.set(product.service_record_id, []);
      productsByVisit.get(product.service_record_id).push(product);
    }
  }

  const vocabulary = await canonicalTargetVocabulary(conn);

  const byCity = new Map();
  for (const row of rows) {
    const city = String(row.city || '').trim().toLowerCase();
    if (!city) continue;
    if (!byCity.has(city)) byCity.set(city, { visits: 0, customers: new Set(), pestCounts: new Map() });
    const entry = byCity.get(city);
    entry.visits += 1;
    entry.customers.add(row.customer_id);
    for (const pest of treatmentTargets(productsByVisit.get(row.id) || [])) {
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
      // A non-vocabulary target (a hand-typed chip) is still evidence that a
      // treatment happened, but it can never become the sentence's quoted
      // string — dropped here rather than reaching email_area_intel_monthly
      // at all, which is the ONLY table getAreaIntelSentence reads.
      const toInsert = [...entry.pestCounts.entries()]
        .filter(([pestKey, count]) => count > 0 && vocabulary.has(pestKey))
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

// pest_key is a lower-cased target chip; restore the capital on the
// proper nouns the picker's catalog uses ("German cockroaches", "Norway
// rats", "Sri Lanka weevil", "Pythium root rot").
const PROPER_TARGET_WORDS = new Map(['german', 'american', 'australian', 'asian', 'oriental', 'florida', 'argentine',
  'pharaoh', 'norway', 'formosan', 'sri', 'lanka', 'pythium', 'cuban', 'caribbean'].map((w) => [w, w[0].toUpperCase() + w.slice(1)]));
function targetForSentence(key) {
  return String(key).split(' ').map((word) => PROPER_TARGET_WORDS.get(word) || word).join(' ');
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
  return `In ${monthName} our technicians treated ${targetForSentence(top.pest_key)} at ${pct}% of our ${top.visits} visits in ${String(city).trim()}.`;
}

module.exports = { computeAreaIntel, getAreaIntelSentence, targetForSentence, canonicalTargetVocabulary, MIN_CITY_CUSTOMERS };
