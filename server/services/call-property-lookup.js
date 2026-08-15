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
const { normalizePropertyType } = require('./pricing-engine/commercial-helpers');

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
      .whereRaw(`last_attempt_at > NOW() - INTERVAL '${PENDING_ACTIVE_MINUTES} minutes'`)
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
    // touch is the "worked" half of the sweep's parked verdict
    // (recentLookupVerdict: productive attempt + touched row = skip free
    // for a week). Fenced to the
    // ADDRESS THAT WAS LOOKED UP: an address edit (or deactivation) mid-
    // lookup means the CORRECTED address was never looked up — parking it
    // a week on the old address's verdict would deprioritize a legitimate
    // fresh candidate.
    try {
      await db('customer_properties')
        .where({ id: propertyId, address_key: row.address_key, active: true })
        .update({ updated_at: db.fn.now() });
    } catch (err) {
      logger.warn('[call-property-lookup] flag-touch failed', { propertyId, error: errId(err) });
    }
    return { enriched: true, filled: [], complete: false, exitedCandidateSet: false };
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
  const observedType = (enriched._observed?.propertyType && !typeDisputed)
    ? snakePropertyType(enriched.propertyType)
    : null;
  // Commercial-lane subtypes ('office', 'warehouse', 'medical_office', …)
  // canonicalize to the literal 'commercial' BEFORE storage: tax, triage,
  // and the never-mirror-to-customers guards all test the exact value, so a
  // preserved subtype would read as residential downstream AND slip past the
  // mirror fence. Predicate only — the pricing normalizer's residential
  // outputs ('condo_ground', …) are pricing vocabulary, not this column's.
  const propertyType = (observedType && normalizePropertyType(observedType) === 'commercial')
    ? 'commercial'
    : observedType;
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
      return { enriched: true, filled: [], complete: false, exitedCandidateSet: false };
    }
  } else {
    after = { latitude: row.latitude, longitude: row.longitude, property_type: row.property_type };
    // Touch updated_at, same as the flagged path above: a COMPLETED lookup
    // with nothing durable to write (out-of-area coordinates, an
    // unobserved/disputed type) stamps resolved/cache_hit — deliberately
    // outside the attempt cooldown — and leaves the row untouched, so it
    // would head the nightly candidate order and consume a batch slot
    // every night. The touch makes the sweep's parked verdict skip it
    // free for a week instead (recentLookupVerdict).
    // Same address fence as the flagged path: a row edited or deactivated
    // during the lookup is a fresh candidate, not one to park.
    try {
      await db('customer_properties')
        .where({ id: propertyId, address_key: row.address_key, active: true })
        .update({ updated_at: db.fn.now() });
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
  // Each mirror is its own failure domain: a visit-fill blip must not
  // skip the customers mirror (and vice versa). Both remain fail-open —
  // the enrichment itself already landed — and the NIGHTLY RECONCILIATION
  // (reconcileVisitCoordinates + reconcileCustomerMirrors) is the durable
  // retry: a completed property leaves the sweep's candidate set, so a
  // swallowed mirror failure here would otherwise be permanent.
  const mirrorLat = after.latitude == null ? null : Number(after.latitude);
  const mirrorLng = after.longitude == null ? null : Number(after.longitude);
  const { addressKey } = require('./customer-properties');
  try {
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
  } catch (err) {
    logger.warn('[call-property-lookup] visit mirror update failed', { propertyId, error: errId(err) });
  }
  try {
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
        if (afterType && normalizePropertyType(afterType) !== 'commercial') {
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
    logger.warn('[call-property-lookup] customer mirror update failed', { propertyId, error: errId(err) });
  }
  // Post-patch completeness from the AUTHORITATIVE post-update row (drives
  // the sweep's offset accounting): the row leaves the NULL-candidate set
  // only when coords AND type are all present now.
  const complete = after.latitude != null && after.longitude != null && Boolean(afterType);
  // Departure from the SWEEP'S candidate predicate — (coords both NULL) OR
  // type missing — not full completeness: a type fill on a lone-coordinate
  // row exits the set while still incomplete (the broken pair is a
  // human-repair case), and the sweep's offset must count that departure
  // exactly like a completion or it advances past a shifted candidate.
  const exitedCandidateSet = Boolean(afterType) && !(after.latitude == null && after.longitude == null);
  logger.info('[call-property-lookup] enriched', {
    propertyId,
    filled,
    elapsedMs: Date.now() - t0,
  });
  return { enriched: true, filled, complete, exitedCandidateSet };
}

/**
 * Fire-and-forget entry for the call pipeline: never blocks or throws into
 * call processing. Gate is checked inside the run (flips apply without a
 * deploy), but a cheap pre-check here skips the setImmediate churn when
 * dark.
 */
// Bounded retry ladder after an in-flight skip. The second delay must
// OUTLAST the 10-minute pending window in the in-flight check: a killed
// process leaves a stale last_attempt_status='pending' stamp, and a single
// 3-minute retry still lands inside the window and skips again — with the
// independently gated backfill off, that row stayed unenriched forever.
// 3m catches a genuinely running estimator lookup finishing (near-free
// cache hit); 3m+8m=11m guarantees one attempt after any stamp written
// just before our first run has aged out. Still pending after that means
// an ACTIVE re-stamped lookup — its result warms the same cache, and the
// nightly sweep catches leftovers.
const IN_FLIGHT_RETRY_DELAYS_MS = [3 * 60 * 1000, 8 * 60 * 1000];

// One bound for "a 'pending' ledger stamp is a LIVE lookup": shared by the
// in-flight guard above and the sweep's cooldown verdict. Past it, the
// stamp is a crashed process that will never produce a result.
const PENDING_ACTIVE_MINUTES = 10;

// ONE bounded retry after a thrown error or a no-profile result: a brief
// provider/DB blip at call time otherwise left the row unenriched forever
// when the (independently gated) backfill is off. Ten minutes clears
// transient outages; exactly one re-buy because enriched:false can also be
// deterministic (no discoverable profile) and each attempt is paid spend.
// Deterministic skips (gated/missing/complete/bad address) never retry.
const FAILURE_RETRY_MS = 10 * 60 * 1000;

function enqueueCallPropertyLookup({ propertyId, retryAttempt = 0 } = {}) {
  if (!gateEnvValue('GATE_CALL_PROPERTY_LOOKUP')) return;
  if (!propertyId) return;
  const scheduleRetry = (delayMs) => {
    // unref() so a retry timer never holds a shutting-down process open.
    const timer = setTimeout(
      () => enqueueCallPropertyLookup({ propertyId, retryAttempt: retryAttempt + 1 }),
      delayMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
  };
  setImmediate(() => {
    runCallPropertyLookup({ propertyId })
      .then((res) => {
        if (res?.skipped === 'lookup_in_flight' && retryAttempt < IN_FLIGHT_RETRY_DELAYS_MS.length) {
          scheduleRetry(IN_FLIGHT_RETRY_DELAYS_MS[retryAttempt]);
        } else if (res?.enriched === false && retryAttempt < 1) {
          scheduleRetry(FAILURE_RETRY_MS);
        }
      })
      .catch((err) => {
        logger.warn('[call-property-lookup] failed', { propertyId, error: errId(err) });
        // retryAttempt is shared with the in-flight ladder — a failure after
        // in-flight retries doesn't get its own; the bound is the point.
        if (retryAttempt < 1) scheduleRetry(FAILURE_RETRY_MS);
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
 * callRecovery fences the CALL-TIME RECOVERY mode (backfill gate off) to
 * rows the call-time lane was already authorized to buy lookups for:
 * PROVENANCE (cp.source = 'call_pipeline' — a creation-date window alone
 * would sweep admin/import/self-book rows into paid lookups) AND a recent
 * creation window (so recovery re-buys only what a recent crash could
 * have dropped, not months of call history). The pre-existing backlog
 * stays behind the backfill gate.
 */
async function fetchBackfillCandidates(limit, offset = 0, { callRecovery } = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const todayEt = etDateString(new Date());
  // Canonical live-customer predicate (customer-stages.whereLiveCustomer,
  // aliased): stage alone would include soft-deleted/archived accounts,
  // and a retained address of a deleted account must never reach paid
  // external lookup providers.
  const { CUSTOMER_STAGES } = require('./customer-stages');
  const q = db('customer_properties as cp')
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
    // Terminal statuses excluded: a future cancelled/skipped visit needs no
    // dispatch coordinates, and a batch of them would outrank properties
    // with REAL upcoming appointments for the bounded nightly budget.
    // (Vocabulary pinned by the scheduled_services status CHECK constraint;
    // terminal set matches admin-dispatch's.)
    .select(db.raw(
      "EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.property_id = cp.id AND ss.scheduled_date >= ? AND ss.status NOT IN ('completed', 'cancelled', 'skipped')) as has_upcoming_visit",
      [todayEt],
    ))
    .select(db.raw(
      'EXISTS (SELECT 1 FROM estimates e WHERE e.property_id = cp.id) as has_estimate',
    ))
    // NO recently-touched sort key here: an ORDER BY on cp.updated_at
    // parked rows on the wrong evidence — an ordinary admin edit (say a
    // ZIP fill that first makes the row geocodable) sank a property with
    // an imminent visit behind the whole backlog for a week. Rows the
    // sweep already worked resurface at the head instead and are skipped
    // FREE by the ledger-based verdict in the sweep loop (see
    // recentLookupVerdict) — the ordering below stays STABLE while the
    // sweep runs, which is what keeps the offset accounting sound.
    .orderBy([
      { column: 'has_upcoming_visit', order: 'desc' },
      { column: 'has_estimate', order: 'desc' },
      { column: 'cp.created_at', order: 'desc' },
    ])
    .limit(limit)
    .offset(offset);
  if (callRecovery) {
    q.where('cp.source', 'call_pipeline')
      .whereRaw(`cp.created_at > NOW() - INTERVAL '${CALL_TIME_RECOVERY_WINDOW_DAYS} days'`);
  }
  return q;
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

// enrichPropertyById pre-spend skip reasons that mean the row NO LONGER
// matches fetchBackfillCandidates' predicate (deleted/deactivated, filled
// complete by another writer, unrepairable lone coordinate, address no
// longer geocodable) — for the sweep's offset accounting these shift the
// result set exactly like a completed enrichment does. 'lookup_in_flight'
// is deliberately absent: that row still matches and keeps its position.
const LEFT_CANDIDATE_SET_SKIPS = [
  'missing', 'complete', 'unrepairable_partial', 'incomplete_address', 'no_address',
];

/**
 * Classifies a candidate row by its address's most recent lookup attempt
 * inside the cooldown window:
 * - 'cooldown'  — the last attempt was UNPRODUCTIVE; retrying soon re-buys
 *   the same nothing.
 * - 'parked'    — a PRODUCTIVE attempt (resolved/cache_hit) already ran AND
 *   the enrich lane worked this row RIGHT AFTER it: updated_at falls
 *   inside a short window past last_attempt_at (the fact-fill and the
 *   deliberate no-fill/flag touches all stamp updated_at seconds after the
 *   attempt lands in the ledger), and past created_at + 1s slop so
 *   insertion's own stamp never qualifies. Re-selecting a worked row
 *   nightly would let a batch-sized head of partially enriched rows starve
 *   the backlog; it resurfaces when the attempt ages out.
 * - null        — go: no recent attempt, or a productive attempt the enrich
 *   lane never consumed (the in-flight-skip catch-up case — the enrich is
 *   a near-free cache hit, exactly what the sweep wants to consume).
 * Evidence is the ATTEMPT LEDGER, never property updated_at alone — an
 * ordinary admin edit must not park a row a week (that was the old
 * recently_touched sort sink's failure). The window makes updated_at
 * usable both ways without a dedicated marker column: an edit BEFORE the
 * attempt predates it, an edit well AFTER it overshoots the window — both
 * read as unworked and keep their catch-up. The residual ambiguity (an
 * unrelated edit landing inside the window right after someone else's
 * lookup) can only false-park until the attempt ages out; a worked row
 * whose later edit falsely UN-parks it just re-enriches as a cache hit,
 * whose fresh attempt + touch re-park it the following night.
 * Fail-open: a ledger error means "go".
 */
// The enrich touch trails the ledger stamp by the lookup fan-out's own
// latency — comfortably under the 10-minute stale-'pending' window that
// already bounds a single run; anything past this is another writer.
const ENRICH_TOUCH_WINDOW_MS = 15 * 60 * 1000;
async function recentLookupVerdict(row) {
  try {
    const { addressKey: cacheKey } = require('./property-lookup/lookup-cache');
    const { hash } = cacheKey(propertyRowAddress(row));
    const attempt = await db('property_lookups')
      .where({ address_hash: hash })
      .whereRaw(`last_attempt_at > NOW() - INTERVAL '${BACKFILL_ATTEMPT_COOLDOWN_DAYS} days'`)
      .first('last_attempt_status', 'last_attempt_at');
    if (!attempt) return null;
    const attemptedAt = attempt.last_attempt_at ? new Date(attempt.last_attempt_at).getTime() : NaN;
    if (COOLDOWN_STATUSES.includes(attempt.last_attempt_status)) {
      // 'pending' is NONTERMINAL: it cools only while a lookup is
      // genuinely in flight — the same PENDING_ACTIVE_MINUTES bound the
      // in-flight guard applies. An older stamp is a crashed process
      // that will never produce a result; cooling it for the full
      // window stranded the row for weeks while the call-time retry
      // ladder had already (correctly) moved on after ten minutes.
      if (attempt.last_attempt_status === 'pending'
          && !(Number.isFinite(attemptedAt) && attemptedAt > Date.now() - PENDING_ACTIVE_MINUTES * 60 * 1000)) {
        return null;
      }
      return 'cooldown';
    }
    const created = row.created_at ? new Date(row.created_at).getTime() : NaN;
    const updated = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
    const worked = Number.isFinite(created) && Number.isFinite(updated) && Number.isFinite(attemptedAt)
      && updated > created + 1000
      && updated >= attemptedAt
      && updated <= attemptedAt + ENRICH_TOUCH_WINDOW_MS;
    return worked ? 'parked' : null;
  } catch (err) {
    logger.warn('[call-property-lookup] attempt-cooldown check failed', { error: errId(err) });
    return null;
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
const RECONCILE_VISIT_PAGE = 200;
const RECONCILE_VISIT_MAX_PAGES = 20;

// Durable scan cursors (system_settings, the portal's generic KV): a night
// that exhausts MAX_PAGES persists where it stopped, so the next night
// resumes PAST the scanned prefix instead of restarting from the top — a
// permanent residue of unreconcilable rows (canonical mismatches the SQL
// prefilter can't express) larger than one night's budget would otherwise
// pin every scan to the same head and the tail would never be examined.
// The cursor is CHRONOLOGICAL — (created_at, id), not id alone: ids are
// random UUIDs, so an id-keyset cursor would exclude a row created AFTER
// it was persisted whenever the new UUID happens to sort below it, leaving
// a fresh booking without coordinates for however many nights the wrap
// takes — the exact enrich-before-booking race this pass repairs. Ordered
// by creation time, new rows always sort past any persisted position.
// A completed scan clears the cursor (wrap to the top). Best-effort +
// fail-open: a KV error or malformed value just means one night rescans
// from the top. Serialized as '<timestamp text>|<id>' where the timestamp
// is Postgres's OWN text rendering of created_at (`::text`), bound back
// with `?::timestamptz` — it round-trips MICROSECOND precision exactly.
// A JS Date/toISOString round trip truncates to milliseconds, and when a
// full page shares one sub-millisecond created_at (bulk imports do this)
// the truncated cursor sorts BEFORE every row on the page, so the tuple
// predicate re-selects the same head forever and the scan never advances.
const RECONCILE_VISIT_CURSOR_KEY = 'call_property_lookup.reconcile_visit_cursor';
const RECONCILE_CUSTOMER_CURSOR_KEY = 'call_property_lookup.reconcile_customer_cursor';

// Loose shape check only — the value is always PG's own ::text output (or
// a legacy ISO string, which PG also parses); a stricter parse here would
// just re-implement the database's timestamp grammar badly.
const RECONCILE_CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function encodeReconcileCursor(createdAt, id) {
  const ts = String(createdAt == null ? '' : createdAt).trim();
  if (!id || ts.includes('|') || !RECONCILE_CURSOR_TS_RE.test(ts)) return null;
  return `${ts}|${id}`;
}

function parseReconcileCursor(value) {
  const s = String(value || '');
  const i = s.indexOf('|');
  if (i <= 0) return null;
  const ts = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!id || !RECONCILE_CURSOR_TS_RE.test(ts)) return null;
  return { ts, id };
}

async function readReconcileCursor(key) {
  try {
    const row = await db('system_settings').where({ key }).first();
    return parseReconcileCursor(row && row.value);
  } catch (err) {
    logger.warn('[call-property-lookup] cursor read failed', { key, error: errId(err) });
    return null;
  }
}

async function writeReconcileCursor(key, value) {
  try {
    await db('system_settings')
      .insert({
        key,
        value: value == null ? null : String(value),
        category: 'call_property_lookup',
        description: 'Nightly reconciliation keyset resume point (null = start from top)',
      })
      .onConflict('key')
      .merge({ value: value == null ? null : String(value), updated_at: db.fn.now() });
  } catch (err) {
    logger.warn('[call-property-lookup] cursor write failed', { key, error: errId(err) });
  }
}

async function reconcileVisitCoordinates() {
  let filled = 0;
  try {
    const { addressKey } = require('./customer-properties');
    // Keyset pagination (ordered by ss.id) so rows the canonical filter
    // skips cannot occupy a stable scan prefix and starve everything
    // behind them — an unordered LIMIT did exactly that. The SQL prefilter
    // mirrors the cheap canonical-key components: unstamped rows (key '')
    // and different-zip5 stamps can never key-match, so the permanent
    // residue the JS filter would re-skip nightly mostly never leaves the
    // database. MAX_PAGES bounds a night at 4k rows; the DURABLE
    // CHRONOLOGICAL CURSOR makes successive nights cover the whole set even
    // when the residue exceeds one night's budget, without ever excluding
    // rows created after it was persisted (see cursor comment above).
    let cursor = await readReconcileCursor(RECONCILE_VISIT_CURSOR_KEY);
    let resumed = Boolean(cursor);
    let exhausted = false;
    for (let page = 0; page < RECONCILE_VISIT_MAX_PAGES; page += 1) {
      const q = db('scheduled_services as ss')
        .join('customer_properties as cp', 'cp.id', 'ss.property_id')
        .whereNull('ss.lat')
        .whereNull('ss.lng')
        .whereNotNull('cp.latitude')
        .whereNotNull('cp.longitude')
        .where('cp.active', true)
        .whereRaw("COALESCE(TRIM(ss.service_address_line1), '') <> ''")
        .whereRaw("LEFT(TRIM(COALESCE(ss.service_address_zip, '')), 5) = LEFT(TRIM(COALESCE(cp.zip, '')), 5)")
        .select(
          'ss.id as visit_id',
          // ::text — the cursor must survive the round trip at the
          // database's own precision (see cursor comment above).
          db.raw('ss.created_at::text as visit_created_key'),
          'ss.service_address_line1', 'ss.service_address_line2',
          'ss.service_address_city', 'ss.service_address_zip',
          'cp.latitude', 'cp.longitude',
          'cp.address_line1', 'cp.address_line2', 'cp.city', 'cp.zip',
        )
        .orderBy([{ column: 'ss.created_at', order: 'asc' }, { column: 'ss.id', order: 'asc' }])
        .limit(RECONCILE_VISIT_PAGE);
      if (cursor) q.whereRaw('(ss.created_at, ss.id) > (?::timestamptz, ?)', [cursor.ts, cursor.id]);
      const rows = (await q) || [];
      if (!rows.length) {
        // A resumed cursor past the current tail wraps to the top ONCE so
        // the night isn't wasted; an empty page from the top means done.
        if (resumed) {
          resumed = false;
          cursor = null;
          page -= 1;
          continue;
        }
        exhausted = true;
        break;
      }
      const tail = rows[rows.length - 1];
      cursor = { ts: tail.visit_created_key, id: tail.visit_id };
      for (const r of rows) {
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
      if (rows.length < RECONCILE_VISIT_PAGE) {
        exhausted = true;
        break;
      }
    }
    // Completed the set → next night starts from the top; page-capped →
    // resume past tonight's prefix.
    await writeReconcileCursor(
      RECONCILE_VISIT_CURSOR_KEY,
      exhausted || !cursor ? null : encodeReconcileCursor(cursor.ts, cursor.id),
    );
  } catch (err) {
    logger.warn('[call-property-lookup] visit reconciliation failed', { error: errId(err) });
  }
  return filled;
}

// Customer-side twin of the visit reconciliation, and the durable retry
// for the fail-open customers mirror: a transient mirror failure on a
// property that finished COMPLETE would otherwise be permanent (complete
// rows never re-enter the sweep's candidate set), leaving the legacy
// surfaces — dispatch maps, completion tax — stale. Same shape: keyset
// pages, SQL narrows to rows the mirror could actually fill, JS applies
// the canonical addressKey fence, and the UPDATE re-asserts the captured
// address columns plus fill-only CASE/COALESCE. The commercial ruling
// holds here too: never mirrored.
async function reconcileCustomerMirrors() {
  let filled = 0;
  try {
    const { addressKey } = require('./customer-properties');
    // Same durable chronological-cursor shape as the visit sweep: a
    // permanent residue (JS-fenced mismatches, commercial-type skips)
    // larger than one night's page budget must not pin the scan head
    // forever, and new customers must never land behind the cursor.
    let cursor = await readReconcileCursor(RECONCILE_CUSTOMER_CURSOR_KEY);
    let resumed = Boolean(cursor);
    let exhausted = false;
    for (let page = 0; page < RECONCILE_VISIT_MAX_PAGES; page += 1) {
      const q = db('customers as c')
        .join('customer_properties as cp', 'cp.customer_id', 'c.id')
        .where('cp.is_primary', true)
        .where('cp.active', true)
        .whereNull('c.deleted_at')
        .whereRaw(`(
          (c.latitude IS NULL AND c.longitude IS NULL AND cp.latitude IS NOT NULL AND cp.longitude IS NOT NULL)
          OR (NULLIF(TRIM(c.property_type), '') IS NULL AND NULLIF(TRIM(cp.property_type), '') IS NOT NULL AND cp.property_type <> 'commercial')
        )`)
        .select(
          'c.id as customer_id',
          db.raw('c.created_at::text as customer_created_key'),
          'c.address_line1 as c_line1', 'c.address_line2 as c_line2', 'c.city as c_city', 'c.zip as c_zip',
          'cp.latitude', 'cp.longitude', 'cp.property_type as cp_type',
          'cp.address_line1', 'cp.address_line2', 'cp.city', 'cp.zip',
        )
        .orderBy([{ column: 'c.created_at', order: 'asc' }, { column: 'c.id', order: 'asc' }])
        .limit(RECONCILE_VISIT_PAGE);
      if (cursor) q.whereRaw('(c.created_at, c.id) > (?::timestamptz, ?)', [cursor.ts, cursor.id]);
      const rows = (await q) || [];
      if (!rows.length) {
        if (resumed) {
          resumed = false;
          cursor = null;
          page -= 1;
          continue;
        }
        exhausted = true;
        break;
      }
      const tail = rows[rows.length - 1];
      cursor = { ts: tail.customer_created_key, id: tail.customer_id };
      for (const r of rows) {
        const propKey = addressKey(r);
        const custKey = addressKey({
          address_line1: r.c_line1, address_line2: r.c_line2, city: r.c_city, zip: r.c_zip,
        });
        if (!propKey || custKey !== propKey) continue;
        const mirror = {};
        const lat = r.latitude == null ? NaN : Number(r.latitude);
        const lng = r.longitude == null ? NaN : Number(r.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          mirror.latitude = db.raw('CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE latitude END', [lat]);
          mirror.longitude = db.raw('CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE longitude END', [lng]);
        }
        // Normalized guard (not just the literal): an admin-typed subtype
        // ('office') stored on the property row is still a commercial
        // classification and must never activate taxability via the mirror.
        const cpType = String(r.cp_type || '').trim();
        if (cpType && normalizePropertyType(cpType) !== 'commercial') {
          mirror.property_type = db.raw("COALESCE(NULLIF(TRIM(property_type), ''), ?)", [cpType]);
        }
        if (!Object.keys(mirror).length) continue;
        mirror.updated_at = db.fn.now();
        await db('customers')
          .where({ id: r.customer_id })
          .whereRaw("COALESCE(address_line1, '') = ? AND COALESCE(address_line2, '') = ? AND COALESCE(city, '') = ? AND COALESCE(zip, '') = ?", [
            r.c_line1 || '', r.c_line2 || '', r.c_city || '', r.c_zip || '',
          ])
          .update(mirror);
        filled += 1;
      }
      if (rows.length < RECONCILE_VISIT_PAGE) {
        exhausted = true;
        break;
      }
    }
    await writeReconcileCursor(
      RECONCILE_CUSTOMER_CURSOR_KEY,
      exhausted || !cursor ? null : encodeReconcileCursor(cursor.ts, cursor.id),
    );
  } catch (err) {
    logger.warn('[call-property-lookup] customer mirror reconciliation failed', { error: errId(err) });
  }
  return filled;
}

// Call-time crash recovery window: with ONLY the call-time gate on, a
// deploy or crash mid-lookup loses the in-memory retry ladder (unref'd
// timers, no durable work record), and the committed property would stay
// unenriched forever — the nightly sweep is the only durable retry. It
// therefore still runs in that configuration, fenced to CALL-PROVENANCE
// rows (cp.source = 'call_pipeline'; the call pipeline stamps it on every
// row it creates, including the ensured primary) CREATED inside this
// window: those are exactly the rows the call-time lane was already
// authorized to spend a lookup on, so recovery re-buys at most what a
// crash dropped and everything else — admin/import/self-book rows and the
// pre-existing backlog — stays behind the backfill gate. The window is
// wide enough to straddle a weekend outage, with the 14-day attempt
// cooldown shielding anything already attempted.
const CALL_TIME_RECOVERY_WINDOW_DAYS = 7;

async function sweepUnenrichedProperties({ limit } = {}) {
  const backfillOn = gateEnvValue('GATE_PROPERTY_ENRICH_BACKFILL');
  const callTimeOn = gateEnvValue('GATE_CALL_PROPERTY_LOOKUP');
  // Reconciliation heals the CALL-TIME lane's enrich↔booking race, so it
  // runs whenever EITHER lane is live: with only the call-time gate on,
  // a backfill-gated reconciliation would never repair those visits. It
  // is free (no lookup spend), so gating it on the paid sweep's budget
  // gate was never the point.
  const reconcileOn = backfillOn || callTimeOn;
  const visitCoordsReconciled = reconcileOn ? await reconcileVisitCoordinates() : 0;
  const customerMirrorsReconciled = reconcileOn ? await reconcileCustomerMirrors() : 0;
  if (!backfillOn && !callTimeOn) return { skipped: 'gated', visitCoordsReconciled, customerMirrorsReconciled };
  // Backfill off + call-time on = RECOVERY mode: same loop, same budget
  // cap, candidates fenced to call-provenance rows in the recovery window
  // (see constant above).
  const recoveryOnly = !backfillOn;
  const candidateOpts = recoveryOnly ? { callRecovery: true } : {};
  const batch = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : backfillBatchSize();
  const t0 = Date.now();
  let processed = 0;
  let enriched = 0;
  let failed = 0;
  let cooled = 0;
  let parked = 0;
  let offset = 0;
  let seen = 0;
  // Page through candidates until the batch is filled or the backlog is
  // exhausted — cooled/parked rows advance the page instead of consuming
  // the batch, so a head of unresolvable or already-worked rows can't
  // starve older candidates.
  while (processed < batch) {
    const page = await fetchBackfillCandidates(batch, offset, candidateOpts);
    if (!page.length) break;
    seen += page.length;
    // OFFSET advances only by rows that STAY in the NULL-filtered result
    // set (cooled/parked/failed/no-data/partially-filled). A row that
    // LEAVES the set shifts everything after it left — that is a completed
    // enrichment, but also any concurrent departure enrichPropertyById
    // reports pre-spend: the row vanished/deactivated ('missing'), was
    // completed by another writer ('complete'), became unrepairable
    // ('unrepairable_partial'), or lost its geocodable address
    // ('incomplete_address'/'no_address' — the candidate SQL requires
    // one). Counting only enrich-completions over-advanced the offset and
    // skipped a shifted eligible row for the night. A partial fill (coords
    // taken, synthesized type refused) and an in-flight skip still match
    // the filter and stay counted. This accounting also requires the
    // candidate ORDER to be stable while the sweep runs: every sort key
    // (upcoming visit, estimate, created_at) is untouched by the sweep's
    // own writes — a sort key derived from updated_at would move each
    // looked-up row to the tail mid-sweep and the advancing offset would
    // jump over unseen rows.
    let leftSetThisPage = 0;
    for (const row of page) {
      if (processed >= batch) break;
      const verdict = await recentLookupVerdict(row);
      if (verdict === 'cooldown') { cooled += 1; continue; }
      if (verdict === 'parked') { parked += 1; continue; }
      try {
        const res = await enrichPropertyById(row.id);
        // Only rows that reached a REAL lookup consume the batch budget —
        // pre-spend skips (row vanished, unrepairable, in-flight) are free
        // and must not let a head of skip rows exhaust the nightly cap.
        if (!res.skipped) processed += 1;
        if (res.enriched) enriched += 1;
        if (res.exitedCandidateSet || LEFT_CANDIDATE_SET_SKIPS.includes(res.skipped)) leftSetThisPage += 1;
      } catch (err) {
        processed += 1;
        failed += 1;
        logger.warn('[call-property-lookup] backfill row failed', { propertyId: row.id, error: errId(err) });
      }
    }
    offset += page.length - leftSetThisPage;
  }
  logger.info('[call-property-lookup] backfill sweep complete', {
    mode: recoveryOnly ? 'call_time_recovery' : 'backfill',
    candidates: seen,
    processed,
    enriched,
    failed,
    cooledDown: cooled,
    parked,
    visitCoordsReconciled,
    customerMirrorsReconciled,
    elapsedMs: Date.now() - t0,
  });
  return {
    mode: recoveryOnly ? 'call_time_recovery' : 'backfill',
    candidates: seen,
    processed,
    enriched,
    failed,
    cooledDown: cooled,
    parked,
    visitCoordsReconciled,
    customerMirrorsReconciled,
  };
}

module.exports = {
  runCallPropertyLookup,
  enqueueCallPropertyLookup,
  sweepUnenrichedProperties,
  _private: {
    snakePropertyType, propertyRowAddress, fetchBackfillCandidates, recentLookupVerdict, backfillBatchSize,
    reconcileVisitCoordinates, reconcileCustomerMirrors, SQL_PRIMARY_NUMBER_RE, SQL_LEADING_UNIT_RE,
  },
};
