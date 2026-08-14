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

/**
 * One-line lookup address from a customer_properties row (empty → '').
 * line2 goes through normalizeUnitLine so a bare "4" becomes "Unit 4" —
 * a raw comma-separated "100 Main St, 4, Bradenton" reads its second
 * component as a CITY to the cache's canonical parser, splitting this
 * lookup's cache entry from the estimator's normalized form.
 */
function propertyRowAddress(row) {
  const { formatAddress, normalizeUnitLine } = require('../utils/address-normalizer');
  const line2 = String(row.address_line2 || '').trim();
  return formatAddress({
    line1: row.address_line1,
    line2: line2 ? normalizeUnitLine(line2) : '',
    city: row.city,
    state: row.state || 'FL',
    zip: row.zip,
  });
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
  // Blank/whitespace types are MISSING (admin edits store '' verbatim) —
  // mirrors the SQL NULLIF in the fill patch and the sweep's candidate
  // filter, so the three layers can't disagree about repairability.
  const rowType = String(row.property_type || '').trim();
  const typeFillable = !rowType;
  if (row.latitude != null && row.longitude != null && rowType) {
    return { skipped: 'complete' };
  }
  if (!coordsFillable && !typeFillable) {
    return { skipped: 'unrepairable_partial' };
  }
  // Street WITH A HOUSE NUMBER + ZIP required BEFORE spending: the call
  // pipeline permits partial addresses, and a numberless "Main St" (or a
  // street + state with no ZIP) geocodes to a street centroid the lookup
  // won't flag — a fill-only write of centroid coordinates would then be
  // unrepairable by later valid lookups. Same predicate the estimator's
  // draft gate uses (unit-scope-model.hasPrimaryStreetNumber).
  const { hasPrimaryStreetNumber } = require('./estimator-engine/unit-scope-model');
  if (!String(row.address_line1 || '').trim() || !String(row.zip || '').trim()
      || !hasPrimaryStreetNumber(row.address_line1)) {
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
    // Touch updated_at: the lookup's own attempt stamp is resolved/
    // cache_hit (deliberately outside the cooldown), so without this the
    // flagged row would head the nightly candidate order forever. The
    // recently_touched sink parks it for a week instead.
    try {
      await db('customer_properties').where({ id: propertyId }).update({ updated_at: db.fn.now() });
    } catch (err) {
      logger.warn('[call-property-lookup] flag-touch failed', { propertyId, error: errId(err) });
    }
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
    // NULLIF: admin edits can store property_type = '' verbatim (and
    // ensurePrimaryProperty copies it with ??) — a blank is MISSING, not a
    // value to preserve, or the row would be permanently unenrichable.
    patch.property_type = db.raw("COALESCE(NULLIF(TRIM(property_type), ''), ?)", [propertyType]);
  }
  let after = null;
  if (Object.keys(patch).length) {
    patch.updated_at = db.fn.now();
    // Fenced to the ADDRESS THAT WAS LOOKED UP: the external fan-out can
    // run for a minute, and an address edit meanwhile (syncPrimaryAddress
    // clears coordinates on edit) must not receive the OLD address's
    // facts. A changed address_key or deactivated row matches nothing and
    // the result is discarded. RETURNING gives the POST-UPDATE row — the
    // authoritative values (this lookup's, or a concurrent writer's that
    // the CASE/COALESCE correctly preserved) that everything downstream
    // derives from.
    const rows = await db('customer_properties')
      .where({ id: propertyId, address_key: row.address_key, active: true })
      .update(patch, ['latitude', 'longitude', 'property_type']);
    after = rows && rows[0];
    if (!after) {
      logger.info('[call-property-lookup] row changed during lookup — result discarded', {
        propertyId, elapsedMs: Date.now() - t0,
      });
      return { enriched: true, filled: [], complete: false };
    }
  } else {
    after = { latitude: row.latitude, longitude: row.longitude, property_type: row.property_type };
    // Touch updated_at, same as the flagged path above: a COMPLETED lookup
    // with nothing durable to write (out-of-area coordinates, an
    // unobserved/disputed type) stamps resolved/cache_hit — deliberately
    // outside the attempt cooldown — and leaves the row untouched, so it
    // would head the nightly candidate order and consume a batch slot
    // every night. The recently_touched sink parks it for a week instead.
    try {
      await db('customer_properties').where({ id: propertyId }).update({ updated_at: db.fn.now() });
    } catch (err) {
      logger.warn('[call-property-lookup] no-fill touch failed', { propertyId, error: errId(err) });
    }
  }
  // filled = what THIS run actually changed (pre-read null → post-update
  // value); a concurrent writer's value surviving the CASE/COALESCE is not
  // a fill by this run.
  const filled = [];
  const afterType = String(after.property_type || '').trim();
  if (row.latitude == null && after.latitude != null) filled.push('latitude', 'longitude');
  if (!rowType && afterType) filled.push('property_type');
  // ── Downstream mirrors (fill-only, fenced, fail-open) ──
  // Production paths still read the LEGACY surfaces: dispatch maps/ETAs
  // read customers.latitude/longitude, completion tax reads
  // customers.property_type, and route tooling reads the coordinates on
  // scheduled_services rows linked at booking time (often inserted before
  // this fire-and-forget lookup finishes). Mirrors propagate the
  // POST-UPDATE row values — never this lookup's inputs — so a concurrent
  // writer's newer coordinates converge everywhere instead of diverging.
  try {
    const mirrorLat = after.latitude == null ? null : Number(after.latitude);
    const mirrorLng = after.longitude == null ? null : Number(after.longitude);
    const { addressKey } = require('./customer-properties');
    if (mirrorLat != null && mirrorLng != null) {
      // Visits linked to THIS property whose coordinate pair is absent —
      // fenced to the ADDRESS THAT WAS LOOKED UP: the visit's
      // service_address_* stamp is immutable booking-time truth, while
      // syncPrimaryAddress keeps the property ID across an address edit.
      // Matching by property_id alone let a later lookup for the EDITED
      // address attach its coordinates to a visit stamped with the old
      // one, dispatching to the wrong parcel. The fence compares CANONICAL
      // addressKey values — the SAME comparison that established the
      // visit↔property linkage — because a legitimately linked stamp may
      // differ textually from the property row ("Street" vs "St", "Apt 4"
      // vs "Unit 4"); a raw string compare orphaned those visits. Done in
      // JS (addressKey is not expressible in SQL); the UPDATE re-asserts
      // the null coordinate pair so this stays fill-only under races.
      // Unstamped legacy rows key to '' and never match — they render the
      // customers mirror address, which has its own fenced fill below.
      // (row.address_* is safe here — the address_key fence above already
      // proved it unchanged.)
      const propKey = addressKey(row);
      if (propKey) {
        const visits = await db('scheduled_services')
          .where({ property_id: propertyId })
          .whereNull('lat')
          .whereNull('lng')
          .select('id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
        const matchedIds = (visits || [])
          .filter((v) => addressKey({
            address_line1: v.service_address_line1,
            address_line2: v.service_address_line2,
            city: v.service_address_city,
            zip: v.service_address_zip,
          }) === propKey)
          .map((v) => v.id);
        if (matchedIds.length) {
          await db('scheduled_services')
            .whereIn('id', matchedIds)
            .whereNull('lat')
            .whereNull('lng')
            .update({ lat: mirrorLat, lng: mirrorLng });
        }
      }
    }
    if (row.is_primary) {
      const customer = await db('customers').where({ id: row.customer_id }).first();
      // Fence: mirror only while the customers primary-address mirror still
      // IS this property's address — and the SAME captured address columns
      // are reasserted in the UPDATE predicate, so an edit committing
      // between this read and the write matches nothing (the read-then-
      // compare alone left that window open).
      if (customer && addressKey(customer) === row.address_key) {
        const mirror = {};
        if (mirrorLat != null && mirrorLng != null) {
          mirror.latitude = db.raw('CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE latitude END', [mirrorLat]);
          mirror.longitude = db.raw('CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE longitude END', [mirrorLng]);
        }
        // NEVER mirror a commercial classification onto customers:
        // customers.property_type feeds service_taxability, and activating
        // sales tax off an AI-inferred classification is an owner ruling
        // (pending), not an enrichment side effect. Residential types are
        // display/routing metadata only.
        if (afterType && afterType !== 'commercial') {
          mirror.property_type = db.raw("COALESCE(NULLIF(TRIM(property_type), ''), ?)", [afterType]);
        }
        if (Object.keys(mirror).length) {
          mirror.updated_at = db.fn.now();
          await db('customers')
            .where({ id: row.customer_id })
            .whereRaw("COALESCE(address_line1, '') = ? AND COALESCE(address_line2, '') = ? AND COALESCE(city, '') = ? AND COALESCE(zip, '') = ?", [
              customer.address_line1 || '', customer.address_line2 || '', customer.city || '', customer.zip || '',
            ])
            .update(mirror);
        }
      }
    }
  } catch (err) {
    logger.warn('[call-property-lookup] mirror update failed', { propertyId, error: errId(err) });
  }
  // Post-patch completeness from the AUTHORITATIVE post-update row (drives
  // the sweep's offset accounting): the row leaves the NULL-candidate set
  // only when coords AND type are all present now.
  const complete = after.latitude != null && after.longitude != null && Boolean(afterType);
  logger.info('[call-property-lookup] enriched', {
    propertyId,
    filled,
    elapsedMs: Date.now() - t0,
  });
  return { enriched: true, filled, complete };
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

// SQL twins of the estimator's PRIMARY_STREET_NUMBER_RE and
// LEADING_SUBPREMISE_RE (unit-scope-model.hasPrimaryStreetNumber). POSIX
// classes instead of \d/\w/\s perl shorthands are avoided on purpose —
// these run under ~* / regexp_replace(...,'i'), so the a-z ranges are
// case-insensitive. The JS predicate's "strip must have CHANGED the
// string" step is redundant here: an unchanged strip re-tests the same
// string the first branch already tested.
const SQL_PRIMARY_NUMBER_RE = '^\\s*[0-9]+[a-z]?([-/][a-z0-9_]+)?\\s+\\S';
const SQL_LEADING_UNIT_RE = '^\\s*(unit|apt|apartment|ste|suite|#)\\s*#?\\s*[a-z0-9_-]+\\s*(,\\s*|\\s+at\\s+|\\s+)';

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
    // Blank types count as missing (NULLIF) — admin edits store '' verbatim.
    .whereRaw("((cp.latitude IS NULL AND cp.longitude IS NULL) OR NULLIF(TRIM(cp.property_type), '') IS NULL)")
    .whereRaw("COALESCE(TRIM(cp.address_line1), '') <> ''")
    // Mirrors the enrich guard's house-number prerequisite (estimator
    // hasPrimaryStreetNumber INCLUDING its leading-unit rule): a primary
    // street number up front, or a unit-first form ("Unit 7, 123 Main St",
    // "#12 900 Bayview Ter") whose remainder starts with one. Parity is
    // the point — a form this filter rejects but the guard accepts is
    // PERMANENTLY invisible to the sweep, while drift the other way just
    // skips unspent and churns. Patterns are BINDINGS (knex.raw eats bare
    // '?', and these regexes need optional quantifiers).
    .whereRaw(
      "(cp.address_line1 ~* ? OR regexp_replace(cp.address_line1, ?, '', 'i') ~* ?)",
      [SQL_PRIMARY_NUMBER_RE, SQL_LEADING_UNIT_RE, SQL_PRIMARY_NUMBER_RE],
    )
    .whereRaw("COALESCE(TRIM(cp.zip), '') <> ''")
    .select('cp.*')
    .select(db.raw(
      'EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.property_id = cp.id AND ss.scheduled_date >= ?) as has_upcoming_visit',
      [todayEt],
    ))
    .select(db.raw(
      'EXISTS (SELECT 1 FROM estimates e WHERE e.property_id = cp.id) as has_estimate',
    ))
    // recently_touched sinks rows the sweep (or anyone) already worked this
    // week: a PARTIAL enrichment (coords filled, type refused) stamps
    // updated_at, stays in the NULL-candidate set, and under a stable
    // priority order a batch-sized head of such rows would consume every
    // nightly batch forever. Sinking them for 7 days lets the backlog
    // progress; they resurface weekly. "Touched" means MODIFIED AFTER
    // INSERTION (updated_at > created_at, 1s slop for separately-computed
    // insert timestamps) — insertion itself stamps updated_at, and a
    // definition on the bare timestamp sank every newly created property,
    // including one with a visit booked tomorrow, behind the untouched
    // legacy backlog. The sink ranks FIRST, across visit classes: were
    // has_upcoming_visit first instead, a batch-sized head of partially
    // enriched upcoming rows would be re-selected every night, starving
    // both older upcoming rows and the whole non-upcoming backlog.
    .select(db.raw(
      "(cp.updated_at IS NOT NULL AND cp.updated_at > cp.created_at + INTERVAL '1 second' AND cp.updated_at > NOW() - INTERVAL '7 days') as recently_touched",
    ))
    .orderBy([
      { column: 'recently_touched', order: 'asc' },
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
// Nightly reconciliation for the enrich↔booking ordering race: the
// fire-and-forget call-time lookup can finish (visit mirror scan included)
// BEFORE call booking inserts its null-coordinate visit row — and a fully
// enriched property leaves the sweep's candidate set, so nothing would
// ever repair that visit and a secondary-property dispatch would fall
// back to the customer's PRIMARY pin. This scans from the VISIT side:
// null-coordinate rows linked to a property that HAS coordinates, fenced
// by the same canonical addressKey comparison as the mirror fill (raw
// stamps legitimately differ from the property row). Free (no lookup
// spend), bounded, fail-open — a reconciliation error must never sink the
// sweep. Non-matching stamps (post-edit bookings) are re-read nightly;
// that is a cheap indexed read, not churn.
const RECONCILE_VISIT_LIMIT = 200;

async function reconcileVisitCoordinates() {
  let filled = 0;
  try {
    const { addressKey } = require('./customer-properties');
    const rows = await db('scheduled_services as ss')
      .join('customer_properties as cp', 'cp.id', 'ss.property_id')
      .whereNull('ss.lat')
      .whereNull('ss.lng')
      .whereNotNull('cp.latitude')
      .whereNotNull('cp.longitude')
      .where('cp.active', true)
      .select(
        'ss.id as visit_id',
        'ss.service_address_line1', 'ss.service_address_line2',
        'ss.service_address_city', 'ss.service_address_zip',
        'cp.latitude', 'cp.longitude',
        'cp.address_line1', 'cp.address_line2', 'cp.city', 'cp.zip',
      )
      .limit(RECONCILE_VISIT_LIMIT);
    for (const r of rows || []) {
      const propKey = addressKey(r);
      const visitKey = addressKey({
        address_line1: r.service_address_line1,
        address_line2: r.service_address_line2,
        city: r.service_address_city,
        zip: r.service_address_zip,
      });
      if (!propKey || visitKey !== propKey) continue;
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Null-pair re-asserted: fill-only under concurrent writers.
      await db('scheduled_services')
        .where({ id: r.visit_id })
        .whereNull('lat')
        .whereNull('lng')
        .update({ lat, lng });
      filled += 1;
    }
  } catch (err) {
    logger.warn('[call-property-lookup] visit reconciliation failed', { error: errId(err) });
  }
  return filled;
}

async function sweepUnenrichedProperties({ limit } = {}) {
  if (!gateEnvValue('GATE_PROPERTY_ENRICH_BACKFILL')) return { skipped: 'gated' };
  const batch = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : backfillBatchSize();
  const t0 = Date.now();
  const visitCoordsReconciled = await reconcileVisitCoordinates();
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
      try {
        const res = await enrichPropertyById(row.id);
        // Only rows that reached a REAL lookup consume the batch budget —
        // pre-spend skips (row vanished, unrepairable, in-flight) are free
        // and must not let a head of skip rows exhaust the nightly cap.
        if (!res.skipped) processed += 1;
        if (res.enriched) enriched += 1;
        if (res.complete) completedThisPage += 1;
      } catch (err) {
        processed += 1;
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
    visitCoordsReconciled,
    elapsedMs: Date.now() - t0,
  });
  return {
    candidates: seen, processed, enriched, failed, cooledDown: cooled, visitCoordsReconciled,
  };
}

module.exports = {
  runCallPropertyLookup,
  enqueueCallPropertyLookup,
  sweepUnenrichedProperties,
  _private: {
    snakePropertyType, propertyRowAddress, fetchBackfillCandidates, attemptedRecently, backfillBatchSize,
    reconcileVisitCoordinates, SQL_PRIMARY_NUMBER_RE, SQL_LEADING_UNIT_RE,
  },
};
