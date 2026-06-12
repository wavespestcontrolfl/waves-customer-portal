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
 * Kill switch: PROPERTY_LOOKUP_CANARY_DISABLED=1.
 */

const logger = require('./logger');
const { runExclusive } = require('../utils/cron-lock');
const { triggerNotification } = require('./notification-triggers');
const { lookupPropertyFromCountyByParcel } = require('./property-lookup/ai-property-lookup');
const { lookupParcelByPoint } = require('./property-lookup/parcel-gis');

const CANARY_TIMEOUT_MS = 20000;

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

async function runPropertyLookupCanaryInner() {
  logger.info('[property-lookup-canary] canary started', {
    parcels: GOLDEN_PARCELS.length, pointChecks: 1,
  });
  const failures = [];

  // Throws are tracked separately from clean nulls so the alert reads as
  // "network/timeout blip" (watch tomorrow's run) vs "parser regression"
  // (act now) — the 2026-06-12 first run fired on a transient county-site
  // error indistinguishable from a real regression. Only the error
  // code/name is recorded: err.message can embed the lookup URL, and the
  // PII rule (county-only labels) applies to logs and failure text alike.
  let pointErrCode = null;
  const parcel = await lookupParcelByPoint(GOLDEN_POINT.lat, GOLDEN_POINT.lng, { timeoutMs: CANARY_TIMEOUT_MS, rethrowErrors: true })
    .catch((err) => { pointErrCode = (err && (err.code || err.name)) || 'network/timeout'; return null; });
  if (!parcel || parcel.county !== GOLDEN_POINT.expectCounty) {
    failures.push(pointErrCode
      ? `FDOR cadastral layer: golden point lookup threw (${pointErrCode})`
      : 'FDOR cadastral layer: golden point no longer resolves to a parcel');
  } else if (parcel.paoParcelId !== GOLDEN_POINT.expectPaoParcelId) {
    failures.push('FDOR cadastral layer: golden point resolves to the wrong PAO parcel id');
  }

  // Sequential on purpose — three polite hits a night, and a shared-cause
  // outage reads as three clean failure lines instead of a thundering herd.
  for (const golden of GOLDEN_PARCELS) {
    let errCode = null;
    const record = await lookupPropertyFromCountyByParcel(golden.parcel, golden.parcel.situsAddress, {
      timeoutMs: CANARY_TIMEOUT_MS,
      rethrowErrors: true,
    }).catch((err) => { errCode = (err && (err.code || err.name)) || 'network/timeout'; return null; });
    if (errCode) {
      logger.warn('[property-lookup-canary] by-parcel lookup threw', { label: golden.label, code: errCode });
      failures.push(`${golden.label}: by-parcel lookup threw (${errCode})`);
    } else {
      failures.push(...evaluateGoldenRecord(golden.label, record));
    }
  }

  if (failures.length) {
    logger.warn('[property-lookup-canary] parser regression detected', {
      failing: failures.length,
      failures,
    });
    await triggerNotification('property_lookup_canary_failed', { failures });
  } else {
    logger.info('[property-lookup-canary] all golden parcels parsed clean', {
      parcels: GOLDEN_PARCELS.length,
    });
  }

  return { ok: failures.length === 0, failures, checked: GOLDEN_PARCELS.length + 1 };
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
    evaluateGoldenRecord,
    isCanaryDisabled,
    runPropertyLookupCanaryInner,
  },
};
