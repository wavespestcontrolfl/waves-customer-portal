'use strict';

/**
 * Auto property-lookup for call-pipeline property rows.
 *
 * Why: the call pipeline records customer_properties rows with the address
 * ONLY (source 'call_pipeline' — every enrichment column NULL), and the
 * full property lookup (county record + AI web search + satellite vision,
 * incl. pool/cage detection) only ever ran through the quote-wizard and
 * estimator flows. So a property added by a phone call had no coordinates,
 * no type, no pool signal, and a cold lookup cache until someone happened
 * to run an estimate. (Origin case 2026-08-13: a customer's new-build
 * property row landed all-NULL, so its draft estimate priced off defaults.)
 *
 * What it does, per NEWLY CREATED call-pipeline property row:
 *   1. Runs performPropertyLookup (which persists into the lookup cache,
 *      so estimator/quote surfaces get an instant warm hit later).
 *   2. Fill-only patch of the property row — latitude / longitude /
 *      property_type via COALESCE, so it can NEVER overwrite a value a
 *      human (or any other writer) has set, even racing one.
 *
 * Deliberately NOT written: any sqft field. property_sqft carries
 * treated-lawn-area semantics and imputed sqft is banned — the enriched
 * dimensions stay in the lookup cache where the estimator applies its own
 * review gates.
 *
 * Cost note: each run is a full lookup fan-out (county scrape + LLM trio +
 * vision) — real per-call spend, so the whole lane is inert unless
 * GATE_CALL_PROPERTY_LOOKUP is set (checked inside runCallPropertyLookup —
 * single source of truth; registered as callPropertyLookup). Kill switch:
 * unset the gate. Fire-and-forget: the call pipeline never waits on it and
 * a lookup failure never touches call processing.
 *
 * Logs are prefixed `[call-property-lookup]`; addresses never appear in
 * logs (AGENTS.md PII rule) — property ids + elapsed only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');

/** One-line lookup address from a customer_properties row (empty → ''). */
function propertyRowAddress(row) {
  return [row.address_line1, row.address_line2, row.city, row.state || 'FL', row.zip]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * 'Single Family' → 'single_family' (the column's live vocabulary).
 * 'Unknown' is a lookup placeholder, not a fact — never persisted.
 */
function snakePropertyType(displayType) {
  const s = String(displayType || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return s && s !== 'unknown' && s.length <= 30 ? s : null;
}

/** Sanitized error id for logs — raw messages can echo lookup addresses. */
const errId = (err) => err?.code || err?.name || 'error';

/**
 * One property row → lookup + fill-only patch. Exported for the cron-less
 * direct path and tests; production entry is enqueueCallPropertyLookup.
 */
async function runCallPropertyLookup({ propertyId } = {}) {
  if (!gateEnvValue('GATE_CALL_PROPERTY_LOOKUP')) return { skipped: 'gated' };
  return enrichPropertyById(propertyId);
}

/**
 * Gate-free core shared by the call-time path (runCallPropertyLookup) and
 * the backfill sweep — each entry point owns its OWN gate, so flipping one
 * lane never flips the other.
 */
async function enrichPropertyById(propertyId) {
  if (!propertyId) return { skipped: 'no_property' };
  const t0 = Date.now();
  const row = await db('customer_properties').where({ id: propertyId }).first();
  if (!row || !row.active) return { skipped: 'missing' };
  // A paid lookup only pays for itself when something is missing AND this
  // writer could actually repair it: coordinates fill only as an atomic
  // pair (both currently null), so a row with exactly ONE coordinate and a
  // type present is unrepairable here — running a lookup for it would burn
  // spend (and a nightly batch slot) forever. Those rows are a human-repair
  // case, surfaced by their lone coordinate in the admin property panel.
  const coordsFillable = row.latitude == null && row.longitude == null;
  const typeFillable = !row.property_type;
  if (row.latitude != null && row.longitude != null && row.property_type) {
    return { skipped: 'complete' };
  }
  if (!coordsFillable && !typeFillable) {
    return { skipped: 'unrepairable_partial' };
  }
  // Street + ZIP required BEFORE spending: the call pipeline permits a
  // first property without city/ZIP, and "123 Main St, FL" is ambiguous
  // enough to geocode onto another premise entirely.
  if (!String(row.address_line1 || '').trim() || !String(row.zip || '').trim()) {
    return { skipped: 'incomplete_address' };
  }
  const address = propertyRowAddress(row);
  if (!address) return { skipped: 'no_address' };

  // In-flight dedupe: performPropertyLookup has no internal one, and an
  // estimator-initiated lookup for the same address may already be running
  // (it stamps last_attempt_status='pending' in the attempt ledger when it
  // starts). Skipping avoids double-buying the county/LLM/vision fan-out
  // and racing its cache writes; the finished lookup warms the same cache
  // this lane exists to warm, and the row it would have filled is caught
  // by the nightly sweep as a near-free cache hit. Best-effort BY DESIGN:
  // the check-then-run window is not atomic — two simultaneous starts cost
  // one duplicate lookup at worst, which is not worth a lock on a paid
  // path. Fail-open: a ledger error is no signal.
  try {
    const { addressKey: cacheKey } = require('./property-lookup/lookup-cache');
    const { hash } = cacheKey(address);
    const inFlight = await db('property_lookups')
      .where({ address_hash: hash, last_attempt_status: 'pending' })
      .whereRaw("last_attempt_at > NOW() - INTERVAL '10 minutes'")
      .first();
    if (inFlight) return { skipped: 'lookup_in_flight' };
  } catch (err) {
    logger.warn('[call-property-lookup] in-flight check failed', { error: errId(err) });
  }

  // Lazy require: the route module is heavy and circular-prone at load time,
  // and tests mock it per-case.
  const { performPropertyLookup } = require('../routes/property-lookup-v2');
  const result = await performPropertyLookup(address);
  const enriched = result?.enriched;
  if (!enriched) {
    logger.info('[call-property-lookup] no profile', { propertyId, elapsedMs: Date.now() - t0 });
    return { enriched: false };
  }
  // Wrong-premise guard: an 'address' field-verify flag means the lookup
  // may describe a DIFFERENT property (snapped house number, ambiguous
  // geocode), and the whole-profile 'all' flag means the ENTIRE result
  // needs human verification (e.g. AI-only record, no county anchor).
  // The cache is still warmed — the estimator surfaces show the flag —
  // but nothing becomes a durable customer_properties fact.
  const addressQuestioned = Array.isArray(enriched.fieldVerifyFlags)
    && enriched.fieldVerifyFlags.some((f) => f?.field === 'address' || f?.field === 'all');
  if (addressQuestioned) {
    logger.info('[call-property-lookup] address flagged — cache warmed, no fill', {
      propertyId, elapsedMs: Date.now() - t0,
    });
    return { enriched: true, filled: [], complete: false };
  }

  const patch = {};
  // Null-safe + area-checked: Number(null) is 0, and a COALESCE'd 0,0
  // write would be unrepairable by later successful lookups. The service-
  // area verdict is the LOOKUP'S OWN (satellite.inServiceArea, the shared
  // SWFL_BOUNDS) — not a second bounding box that could disagree with it.
  const lat = enriched.lat == null ? NaN : Number(enriched.lat);
  const lng = enriched.lng == null ? NaN : Number(enriched.lng);
  const inServiceArea = result?.satellite?.inServiceArea === true;
  if (Number.isFinite(lat) && Number.isFinite(lng) && inServiceArea) {
    // ATOMIC-PAIR fill-only: both components write only when BOTH are
    // currently absent — a lone stored coordinate (e.g. a manual partial
    // correction) must never be paired with the lookup's other half, which
    // would identify no actual property. Never overwrites either value.
    patch.latitude = db.raw('CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE latitude END', [lat]);
    patch.longitude = db.raw('CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE longitude END', [lng]);
  }
  // Property type persists only when the profile marks it OBSERVED (the
  // lookup synthesizes 'Single Family' as a display default) and no
  // propertyType field-verify flag disputes it — a synthesized or disputed
  // classification must stay behind the estimator's review surfaces.
  const typeDisputed = Array.isArray(enriched.fieldVerifyFlags)
    && enriched.fieldVerifyFlags.some((f) => f?.field === 'propertyType');
  const propertyType = (enriched._observed?.propertyType && !typeDisputed)
    ? snakePropertyType(enriched.propertyType)
    : null;
  if (propertyType) {
    patch.property_type = db.raw('COALESCE(property_type, ?)', [propertyType]);
  }
  let updated = 0;
  if (Object.keys(patch).length) {
    patch.updated_at = db.fn.now();
    // Fenced to the ADDRESS THAT WAS LOOKED UP: the external fan-out can
    // run for a minute, and an address edit meanwhile (syncPrimaryAddress
    // clears coordinates on edit) must not receive the OLD address's
    // facts. A changed address_key or deactivated row matches nothing and
    // the result is discarded.
    updated = await db('customer_properties')
      .where({ id: propertyId, address_key: row.address_key, active: true })
      .update(patch);
    if (!updated) {
      logger.info('[call-property-lookup] row changed during lookup — result discarded', {
        propertyId, elapsedMs: Date.now() - t0,
      });
      return { enriched: true, filled: [], complete: false };
    }
  }
  const filled = Object.keys(patch).filter((k) => k !== 'updated_at');
  // Post-patch completeness (drives the sweep's offset accounting): the
  // row leaves the NULL-candidate set only when coords AND type are all
  // present now — a partial fill (coords taken, synthesized type refused)
  // keeps it in the set.
  // The atomic-pair CASE only writes when BOTH were null — a patched key
  // with one lone stored coordinate wrote nothing.
  const coordsComplete = (row.latitude != null && row.longitude != null)
    || (filled.includes('latitude') && row.latitude == null && row.longitude == null);
  const typeComplete = Boolean(row.property_type) || filled.includes('property_type');
  logger.info('[call-property-lookup] enriched', {
    propertyId,
    filled,
    elapsedMs: Date.now() - t0,
  });
  return { enriched: true, filled, complete: coordsComplete && typeComplete };
}

/**
 * Fire-and-forget entry for the call pipeline: never blocks or throws into
 * call processing. Gate is checked inside the run (flips apply without a
 * deploy), but a cheap pre-check here skips the setImmediate churn when
 * dark.
 */
const IN_FLIGHT_RETRY_MS = 3 * 60 * 1000;

function enqueueCallPropertyLookup({ propertyId, isRetry } = {}) {
  if (!gateEnvValue('GATE_CALL_PROPERTY_LOOKUP')) return;
  if (!propertyId) return;
  setImmediate(() => {
    runCallPropertyLookup({ propertyId })
      .then((res) => {
        // ONE bounded retry after an in-flight skip: by then the pending
        // estimator lookup has finished, so the retry is a near-free cache
        // hit that fills the row — without this, the nightly backfill (its
        // OWN gate, possibly off) was the only catcher. unref() so a retry
        // timer never holds a shutting-down process open.
        if (res?.skipped === 'lookup_in_flight' && !isRetry) {
          const timer = setTimeout(
            () => enqueueCallPropertyLookup({ propertyId, isRetry: true }),
            IN_FLIGHT_RETRY_MS,
          );
          if (typeof timer.unref === 'function') timer.unref();
        }
      })
      .catch((err) => {
        logger.warn('[call-property-lookup] failed', { propertyId, error: errId(err) });
      });
  });
}

const DEFAULT_BACKFILL_BATCH = 20;
const BACKFILL_ATTEMPT_COOLDOWN_DAYS = 14;

function backfillBatchSize() {
  const n = Number(process.env.PROPERTY_BACKFILL_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BACKFILL_BATCH;
}

/**
 * Backfill candidates: active property rows of REAL customers
 * (active_customer/won/at_risk — leads' addresses churn and their lookups
 * run through the quote flow anyway) that are missing enrichment and carry
 * a geocodable-enough address (street + zip). Priority: rows with an
 * upcoming visit first, then rows with a linked estimate, then newest —
 * the row most likely to price something soon gets enriched first.
 * Paged (offset) so the sweep can walk past cooled-down rows — a fixed
 * overfetch let a head of perpetually-unresolvable rows starve the
 * backlog forever.
 */
async function fetchBackfillCandidates(limit, offset = 0) {
  const { etDateString } = require('../utils/datetime-et');
  const todayEt = etDateString(new Date());
  // Canonical live-customer predicate (customer-stages.whereLiveCustomer,
  // aliased): stage alone would include soft-deleted/archived accounts,
  // and a retained address of a deleted account must never reach paid
  // external lookup providers.
  const { CUSTOMER_STAGES } = require('./customer-stages');
  return db('customer_properties as cp')
    .join('customers as c', 'c.id', 'cp.customer_id')
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .where('cp.active', true)
    // Only rows THIS writer can repair: the coordinate pair fills
    // atomically (both null), so a lone-coordinate row with a type is not
    // a candidate — it would consume a batch slot every night unrepaired.
    .whereRaw('((cp.latitude IS NULL AND cp.longitude IS NULL) OR cp.property_type IS NULL)')
    .whereRaw("COALESCE(TRIM(cp.address_line1), '') <> ''")
    .whereRaw("COALESCE(TRIM(cp.zip), '') <> ''")
    .select('cp.*')
    .select(db.raw(
      'EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.property_id = cp.id AND ss.scheduled_date >= ?) as has_upcoming_visit',
      [todayEt],
    ))
    .select(db.raw(
      'EXISTS (SELECT 1 FROM estimates e WHERE e.property_id = cp.id) as has_estimate',
    ))
    .orderBy([
      { column: 'has_upcoming_visit', order: 'desc' },
      { column: 'has_estimate', order: 'desc' },
      { column: 'cp.created_at', order: 'desc' },
    ])
    .limit(limit)
    .offset(offset);
}

// Attempt outcomes that mean "retrying soon re-buys the same nothing":
// failures, unresolvable addresses, and in-flight runs. resolved/cache_hit
// are deliberately NOT here — a fresh successful lookup makes the enrich a
// near-free cache hit, which is exactly what the sweep wants to consume
// (an in-flight-skipped call-time fill is caught this way the next night).
const COOLDOWN_STATUSES = [
  'pending', 'error', 'provider_timeout', 'geocode_failed',
  'incomplete_address', 'vacant_or_unassessed', 'no_parcel', 'no_record',
];

/**
 * True when this address's last lookup attempt was an UNPRODUCTIVE one
 * inside the cooldown window. Fail-open: an attempt-table error just means
 * "no cooldown".
 */
async function attemptedRecently(address) {
  try {
    const { addressKey: cacheKey } = require('./property-lookup/lookup-cache');
    const { hash } = cacheKey(address);
    const row = await db('property_lookups')
      .where({ address_hash: hash })
      .whereIn('last_attempt_status', COOLDOWN_STATUSES)
      .whereRaw(`last_attempt_at > NOW() - INTERVAL '${BACKFILL_ATTEMPT_COOLDOWN_DAYS} days'`)
      .first();
    return Boolean(row);
  } catch (err) {
    logger.warn('[call-property-lookup] attempt-cooldown check failed', { error: errId(err) });
    return false;
  }
}

/**
 * Nightly backfill sweep (scheduler): enrich up to PROPERTY_BACKFILL_BATCH
 * existing NULL rows per night. Own gate (GATE_PROPERTY_ENRICH_BACKFILL —
 * checked here, single source of truth) so the per-call lane and the
 * backfill can flip independently; each row is real lookup spend, so the
 * batch cap is the budget. Serial by design: the lookup fan-out is heavy
 * enough without concurrency, and a nightly batch has no latency budget.
 */
async function sweepUnenrichedProperties({ limit } = {}) {
  if (!gateEnvValue('GATE_PROPERTY_ENRICH_BACKFILL')) return { skipped: 'gated' };
  const batch = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : backfillBatchSize();
  const t0 = Date.now();
  let processed = 0;
  let enriched = 0;
  let failed = 0;
  let cooled = 0;
  let offset = 0;
  let seen = 0;
  // Page through candidates until the batch is filled or the backlog is
  // exhausted — cooled-down rows advance the page instead of consuming the
  // batch, so a head of unresolvable rows can't starve older candidates.
  while (processed < batch) {
    const page = await fetchBackfillCandidates(batch, offset);
    if (!page.length) break;
    seen += page.length;
    // OFFSET advances only by rows that STAY in the NULL-filtered result
    // set (cooled/failed/no-data/partially-filled). Only a row that is now
    // COMPLETE leaves the set and shifts everything left — a partial fill
    // (coords taken, synthesized type refused) still matches the filter.
    let completedThisPage = 0;
    for (const row of page) {
      if (processed >= batch) break;
      if (await attemptedRecently(propertyRowAddress(row))) { cooled += 1; continue; }
      processed += 1;
      try {
        const res = await enrichPropertyById(row.id);
        if (res.enriched) enriched += 1;
        if (res.complete) completedThisPage += 1;
      } catch (err) {
        failed += 1;
        logger.warn('[call-property-lookup] backfill row failed', { propertyId: row.id, error: errId(err) });
      }
    }
    offset += page.length - completedThisPage;
  }
  logger.info('[call-property-lookup] backfill sweep complete', {
    candidates: seen,
    processed,
    enriched,
    failed,
    cooledDown: cooled,
    elapsedMs: Date.now() - t0,
  });
  return { candidates: seen, processed, enriched, failed, cooledDown: cooled };
}

module.exports = {
  runCallPropertyLookup,
  enqueueCallPropertyLookup,
  sweepUnenrichedProperties,
  _private: { snakePropertyType, propertyRowAddress, fetchBackfillCandidates, attemptedRecently, backfillBatchSize },
};
