/**
 * Property-lookup parser canary.
 *
 * The county data behind the estimator (Manatee/Sarasota/Charlotte PAO
 * parsers + the FDOR cadastral parcel match) is scrape-based: a county site
 * redesign degrades the pipeline SILENTLY — records stop carrying facts,
 * hasPool falls back to unknown, and pricing inputs quietly revert to vision
 * guesses for every lookup until someone notices. This canary runs one
 * golden parcel per county through the REAL by-parcel pipeline nightly and
 * alerts when a previously-parsing surface stops parsing.
 *
 * Assertions are PRESENCE-level only (record exists, sqft parsed, pool row
 * found) — never exact-value: reassessments legitimately change numbers,
 * but a pool on the assessed roll doesn't vanish; only a parser break makes
 * it vanish. Exact-value checks would make the canary flaky, and a flaky
 * canary gets ignored.
 *
 * NOISE SUPPRESSION: a failure is classified per check as one of —
 *   'ok'         — every assertion passed.
 *   'regression' — a record came back but a surface that USED to parse is
 *                  gone (sqft/pool/etc. missing) or FDOR resolved the wrong
 *                  parcel id. Unambiguous code/layout break → alert on the
 *                  first run.
 *   'transient'  — we couldn't reach the data at all (fetch threw/timed out,
 *                  or the lookup returned no record). A slow county site at
 *                  4am looks identical to a real outage for one run, so this
 *                  is SUPPRESSED until a check has failed
 *                  TRANSIENT_FAILURE_ALERT_THRESHOLD nights in a row (state in
 *                  property_lookup_canary_state), then alerts once + re-pings
 *                  weekly. Mirrors event-source-health.js. The estimator
 *                  degrades gracefully to vision guesses meanwhile, so a few
 *                  silent nights on a genuine outage is the right trade for
 *                  killing single-night-blip noise.
 *
 * Kill switch: PROPERTY_LOOKUP_CANARY_DISABLED=1.
 */

const logger = require('./logger');
const db = require('../models/db');
const { runExclusive } = require('../utils/cron-lock');
const { triggerNotification } = require('./notification-triggers');
const { lookupPropertyFromCountyByParcel } = require('./property-lookup/ai-property-lookup');
const { lookupParcelByPoint } = require('./property-lookup/parcel-gis');

const CANARY_TIMEOUT_MS = 20000;

// Consecutive nights a "can't reach the data" (transient) failure must persist
// before it pages — 3 nights ≈ a real multi-day county outage, not a blip.
const TRANSIENT_FAILURE_ALERT_THRESHOLD = 3;
// Re-ping cadence (in nightly runs) while a check stays past its threshold —
// one alert per breakage plus a weekly reminder, never nightly spam.
const REPING_EVERY_RUNS = 7;

// One known pool home per county, live-verified 2026-06-12. Each exercises
// that county's full detail surface: Manatee land+buildings+features models;
// Sarasota detail page + Extra Features grid; Charlotte Show_Parcel tables +
// ownership GIS (lotSize). Failure labels deliberately carry only the county
// — no parcel IDs or addresses (AGENTS.md non-card PII rule applies to the
// notification fan-out and logs alike).
const GOLDEN_PARCELS = [
  {
    label: 'Manatee golden parcel',
    parcel: { county: 'Manatee', paoParcelId: '579642409', situsAddress: '12071 FOREST PARK CIR', situsCity: 'BRADENTON' },
  },
  {
    label: 'Sarasota golden parcel',
    parcel: { county: 'Sarasota', paoParcelId: '0069140016', situsAddress: '4740 MEADOWVIEW CIR', situsCity: 'SARASOTA' },
  },
  {
    label: 'Charlotte golden parcel',
    parcel: { county: 'Charlotte', paoParcelId: '402217351013', situsAddress: '2965 ROCK CREEK DR', situsCity: 'PORT CHARLOTTE' },
  },
];

// Rooftop point inside the Manatee golden parcel — exercises the FDOR
// statewide cadastral layer (point-in-polygon → parcel + PAO key). The
// expected PAO id is asserted exactly: county-only validation would pass
// through parcel-id normalization drift or adjacent-polygon selection while
// the production point→PAO handoff is broken.
const GOLDEN_POINT = { lat: 27.4536, lng: -82.4221, expectCounty: 'Manatee', expectPaoParcelId: '579642409' };

function isCanaryDisabled() {
  const flag = process.env.PROPERTY_LOOKUP_CANARY_DISABLED;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// Short, PII-safe label for a thrown lookup error — the whole point of the
// throw path is to read as a "network/timeout blip, watch tomorrow" signal,
// so a timeout has to *look* like one. An AbortController timeout surfaces as
// a DOMException whose numeric `.code` is 20 (legacy ABORT_ERR), which renders
// as an opaque "(20)" and buries the signal; collapse all the abort spellings
// to "timeout". Other codes (ETIMEDOUT/ECONNRESET/…) already read fine and are
// kept verbatim. Stays on code/name only — err.message can embed the lookup
// URL, and the county-only PII rule applies to failure text as much as logs.
function errLabel(err) {
  if (!err) return 'network/timeout';
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20) return 'timeout';
  return err.code || err.name || 'network/timeout';
}

// Presence-level expectations every golden parcel must satisfy. Each maps to
// a distinct parsing surface, so the failure text names what broke.
function evaluateGoldenRecord(label, record) {
  if (!record) return [`${label}: by-parcel lookup returned no record`];
  const failures = [];
  if (!(record.squareFootage > 0)) failures.push(`${label}: squareFootage not parsed`);
  if (!(record.lotSize > 0)) failures.push(`${label}: lotSize not parsed`);
  if (!record.yearBuilt) failures.push(`${label}: yearBuilt not parsed`);
  if (record.hasPool !== true) failures.push(`${label}: pool not found on extra-features roll`);
  if (!(record.poolCageSqft > 0)) failures.push(`${label}: screen cage sqft not parsed`);
  return failures;
}

// A counter is "at an alert point" on the run it first crosses its threshold,
// then every REPING_EVERY_RUNS runs after — so a long-broken check pages once
// up front plus a weekly reminder, never nightly. Lifted from
// event-source-health.js so both fleets escalate identically.
function atAlertPoint(count, threshold) {
  return count >= threshold && (count - threshold) % REPING_EVERY_RUNS === 0;
}

// Pure escalation decision over this run's checks + the prior consecutive-
// failure counts. Returns what to alert on, what to stay quiet about, and the
// next counter per check — no I/O, so the whole policy is unit-testable.
//   checks: [{ key, status: 'ok'|'transient'|'regression', details: string[] }]
//   priorCounts: { [key]: number }  (missing key = 0, i.e. a fresh check)
function decideCanaryAlert(checks, priorCounts = {}, threshold = TRANSIENT_FAILURE_ALERT_THRESHOLD) {
  const alertFailures = [];
  const suppressed = [];
  const nextCounts = {};
  for (const check of checks) {
    if (check.status === 'transient') {
      // Reaching the data failed — advance the streak; only escalate once it
      // has persisted past the threshold (and on each weekly re-ping after).
      const count = Number(priorCounts[check.key] || 0) + 1;
      nextCounts[check.key] = count;
      if (atAlertPoint(count, threshold)) {
        alertFailures.push(...check.details.map((d) => `${d} — ${count} nights running`));
      } else {
        suppressed.push(...check.details.map((d) => `${d} (night ${count}/${threshold})`));
      }
    } else {
      // 'ok' or 'regression' both mean the data was reachable, so the
      // can't-reach-data streak resets. A regression still alerts immediately
      // — a vanished parsing surface is never a transient blip.
      nextCounts[check.key] = 0;
      if (check.status === 'regression') alertFailures.push(...check.details);
    }
  }
  return { alertFailures, suppressed, nextCounts };
}

// Prior consecutive-failure counts keyed by check. Fail-open: if the state
// table is unreachable, treat every check as fresh (count 0) so a regression
// still pages immediately and a transient is merely suppressed one more night.
async function loadPriorCounts(keys) {
  try {
    const rows = await db('property_lookup_canary_state')
      .whereIn('check_key', keys)
      .select('check_key', 'consecutive_failures');
    return Object.fromEntries(rows.map((r) => [r.check_key, Number(r.consecutive_failures) || 0]));
  } catch (err) {
    logger.warn(`[property-lookup-canary] state load failed, treating checks as fresh: ${err.message}`);
    return {};
  }
}

// Persist the post-run counter + last status/detail per check (upsert). Best
// effort: a write failure is logged, never fatal — the canary's job is the
// lookup, not the bookkeeping. Detail stays county-only (PII rule).
async function persistCheckStates(checks, nextCounts) {
  for (const check of checks) {
    try {
      await db('property_lookup_canary_state')
        .insert({
          check_key: check.key,
          consecutive_failures: Number(nextCounts[check.key] || 0),
          last_status: check.status,
          last_detail: check.details.join('; ') || null,
          last_run_at: db.fn.now(),
          updated_at: db.fn.now(),
        })
        .onConflict('check_key')
        .merge();
    } catch (err) {
      logger.warn(`[property-lookup-canary] state persist failed for ${check.key}: ${err.message}`);
    }
  }
}

async function runPropertyLookupCanaryInner() {
  logger.info('[property-lookup-canary] canary started', {
    parcels: GOLDEN_PARCELS.length, pointChecks: 1,
  });

  // Classify every check this run into ok/transient/regression. Throws and
  // clean nulls are both 'transient' (couldn't reach the data); a record that
  // came back but is missing a surface is 'regression'. Only the error
  // code/name is recorded — err.message can embed the lookup URL, and the PII
  // rule (county-only labels) applies to logs and failure text alike.
  const checks = [];

  let pointErrCode = null;
  const parcel = await lookupParcelByPoint(GOLDEN_POINT.lat, GOLDEN_POINT.lng, { timeoutMs: CANARY_TIMEOUT_MS, rethrowErrors: true })
    .catch((err) => { pointErrCode = errLabel(err); return null; });
  if (pointErrCode) {
    checks.push({ key: 'fdor_point', status: 'transient', details: [`FDOR cadastral layer: golden point lookup threw (${pointErrCode})`] });
  } else if (!parcel) {
    // Layer unreachable / empty response — couldn't get the data → transient.
    checks.push({ key: 'fdor_point', status: 'transient', details: ['FDOR cadastral layer: golden point no longer resolves to a parcel'] });
  } else if (parcel.county !== GOLDEN_POINT.expectCounty) {
    // The layer WAS reachable but resolved a different county — adjacent-
    // polygon selection / a broken point→parcel handoff, exactly the
    // production break the GOLDEN_POINT comment flags. Page immediately.
    checks.push({ key: 'fdor_point', status: 'regression', details: ['FDOR cadastral layer: golden point resolves to the wrong county'] });
  } else if (parcel.paoParcelId !== GOLDEN_POINT.expectPaoParcelId) {
    checks.push({ key: 'fdor_point', status: 'regression', details: ['FDOR cadastral layer: golden point resolves to the wrong PAO parcel id'] });
  } else {
    checks.push({ key: 'fdor_point', status: 'ok', details: [] });
  }

  // Sequential on purpose — three polite hits a night, and a shared-cause
  // outage reads as three clean failure lines instead of a thundering herd.
  for (const golden of GOLDEN_PARCELS) {
    let errCode = null;
    const record = await lookupPropertyFromCountyByParcel(golden.parcel, golden.parcel.situsAddress, {
      timeoutMs: CANARY_TIMEOUT_MS,
      rethrowErrors: true,
    }).catch((err) => { errCode = errLabel(err); return null; });
    const key = `golden:${golden.parcel.county}`;
    if (errCode) {
      logger.warn('[property-lookup-canary] by-parcel lookup threw', { label: golden.label, code: errCode });
      checks.push({ key, status: 'transient', details: [`${golden.label}: by-parcel lookup threw (${errCode})`] });
    } else if (!record) {
      checks.push({ key, status: 'transient', details: [`${golden.label}: by-parcel lookup returned no record`] });
    } else {
      const fieldFailures = evaluateGoldenRecord(golden.label, record);
      checks.push(fieldFailures.length
        ? { key, status: 'regression', details: fieldFailures }
        : { key, status: 'ok', details: [] });
    }
  }

  // Escalate against the persisted streak, then advance it.
  const priorCounts = await loadPriorCounts(checks.map((c) => c.key));
  const { alertFailures, suppressed, nextCounts } = decideCanaryAlert(checks, priorCounts);
  await persistCheckStates(checks, nextCounts);

  if (suppressed.length) {
    logger.info('[property-lookup-canary] transient failures below alert threshold — suppressed', { suppressed });
  }

  if (alertFailures.length) {
    logger.warn('[property-lookup-canary] alert-worthy failures', {
      failing: alertFailures.length,
      failures: alertFailures,
    });
    await triggerNotification('property_lookup_canary_failed', { failures: alertFailures });
  } else {
    logger.info('[property-lookup-canary] no alert-worthy failures', { checks: checks.length });
  }

  return {
    ok: alertFailures.length === 0,
    failures: alertFailures,
    suppressed,
    checked: GOLDEN_PARCELS.length + 1,
  };
}

async function runPropertyLookupCanary() {
  if (isCanaryDisabled()) {
    logger.info('[property-lookup-canary] disabled via PROPERTY_LOOKUP_CANARY_DISABLED');
    return { skipped: true, reason: 'disabled' };
  }
  return runExclusive('property-lookup-canary', runPropertyLookupCanaryInner);
}

module.exports = {
  runPropertyLookupCanary,
  _private: {
    GOLDEN_PARCELS,
    GOLDEN_POINT,
    TRANSIENT_FAILURE_ALERT_THRESHOLD,
    REPING_EVERY_RUNS,
    evaluateGoldenRecord,
    errLabel,
    atAlertPoint,
    decideCanaryAlert,
    isCanaryDisabled,
    runPropertyLookupCanaryInner,
  },
};
