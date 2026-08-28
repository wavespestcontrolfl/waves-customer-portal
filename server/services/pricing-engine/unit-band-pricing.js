/**
 * Residential-unit bedroom-band pricing (GATE_UNIT_BAND_PRICING, default
 * OFF; engine-family env-gate pattern, same value semantics as
 * GATE_UNIT_SCOPE_GUARDRAILS) — PR2 of the apartment/condo estimator lane,
 * owner ruling 2026-08-11 #1/#3/#5.
 *
 * A tenant treating the interior of ONE dwelling unit has no unit-scoped
 * square footage most of the time (rental complexes carry no per-unit
 * parcel; the county building area describes the whole structure and the
 * unit-scope guardrails clear it). The single-family footprint ladder has
 * nothing honest to price from there, and the one number the caller DID
 * give — "it's a one-bedroom" — was captured as a constraint flag and never
 * used. This module turns that bedroom count into a first-class pricing
 * basis read from the DB-authoritative `residential_unit_pricing` table.
 *
 * ⛔ Never impute square footage from a band (ruling #1): the band is
 * carried as `pricingBasis: caller_stated_bedroom_count` +
 * `pricingBand`, and the unit-scope audit's sizeBasis becomes
 * 'bedroom_band'. propertyFacts.home stays exactly as arbitrated.
 *
 * Basis ladder (ruling #2 sizeBasis order): a UNIT-SCOPED sqft that
 * resolved (county per-unit folio, caller-stated unit size) outranks the
 * band — the standard ladder prices it and this resolver declines. The band
 * applies only when the arbitrated home sqft is unresolved.
 *
 * Service-restricted ON PURPOSE (ruling #3): ordinary interior general pest
 * recurring (`pest`, roachType none) and standalone one-time (`oneTimePest`,
 * roachType none). German roach / bed bug / rodent / termite / flea /
 * exterior / common-area programs keep their own rules — any roach program
 * on the pest key falls back to the standard pricer. Monthly cadence has no
 * band row by design (a monthly apartment ask usually means a german roach
 * or flea program): the recurring line prices on the standard ladder and
 * the lane parks it for a human.
 *
 * The resolved rows travel INSIDE engineInput (`unitBandPricing`), so a
 * stored draft replays exactly what priced it — the same snapshot-on-row
 * doctrine as discount caps: stored replays never read the live table.
 */

function unitBandPricingEnabled() {
  const flag = process.env.GATE_UNIT_BAND_PRICING;
  return flag === '1' || flag === 'true' || flag === 'on';
}

const crypto = require('crypto');
const { etDateString } = require('../../utils/datetime-et');

const UNIT_BANDS = ['studio', 'one_bedroom', 'two_bedroom', 'three_bedroom', 'four_plus'];

const PRICING_BASIS = 'caller_stated_bedroom_count';
const SIZE_BASIS = 'bedroom_band';

// Engine service keys the table is allowed to price (ruling #3). The table
// carries the SAME keys verbatim so a missing row is a missing row, never a
// mapping bug.
const BAND_SERVICE_KEYS = {
  pest: 'pest',
  oneTimePest: 'oneTimePest',
};

// Intent cadence (intent-schema vocabulary) → table frequency. Monthly is
// deliberately unmapped: no band row exists for it (see module doc).
const INTENT_FREQUENCY_TO_BAND = {
  quarterly: 'quarterly',
  bimonthly: 'bi_monthly',
};

// Explicit scope language for the customer-facing quote (ruling #5: a green
// interior-only unit quote carries its exclusions). Keyed by included_scope
// so a future scope row can carry its own list.
const SCOPE_EXCLUSIONS = {
  interior_unit_general_pest: [
    'interior of your unit only — building exterior and common areas are not included',
    'adjacent units and shared walls are not treated',
    'German roach, bed bug, flea, rodent and termite programs are quoted separately',
  ],
};

// A stated count only: null/undefined/''/booleans are NOT zero — Number(null)
// is 0 and would silently read as a studio.
function positiveInt(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The one-line customer-facing scope note (rendered under the service row
// on the public estimate and the accepted row's detail) — the same
// exclusions, in the customer's words.
const SCOPE_NOTES = {
  interior_unit_general_pest: 'Interior of your unit only — building exterior, common areas and adjacent units are not included; German roach, bed bug, flea, rodent and termite programs are quoted separately.',
};

function bandForBedroomCount(count) {
  const n = positiveInt(count);
  if (n === null) return null;
  if (n === 0) return 'studio';
  if (n === 1) return 'one_bedroom';
  if (n === 2) return 'two_bedroom';
  if (n === 3) return 'three_bedroom';
  return 'four_plus';
}

function bandFrequencyForIntent(frequency) {
  return INTENT_FREQUENCY_TO_BAND[String(frequency || 'quarterly').toLowerCase()] || null;
}

/**
 * The caller-stated bedroom count, with provenance. The structured call
 * extraction is the primary source; the composer's intent field carries the
 * same fact on the SMS-thread path (where there is no call extraction —
 * it's how a clarify reply "it's a 2 bedroom" reaches pricing). Never
 * derived from sqft, rent, or property type.
 */
function callerStatedBedroomCount({ extraction, intent } = {}) {
  const fromExtraction = positiveInt(extraction?.property?.bedroom_count);
  if (fromExtraction !== null) return { count: fromExtraction, source: 'call_extraction' };
  const fromIntent = positiveInt(intent?.unit_bedroom_count);
  if (fromIntent !== null) return { count: fromIntent, source: 'composer_intent' };
  return { count: null, source: null };
}

/**
 * Latest-effective row per (service_code, frequency, unit_band) as of the
 * EASTERN business date of `asOf`. effective_date is a Postgres `date`, so
 * the comparison is date-to-date on an America/New_York calendar day — a
 * new rate goes live at ET midnight, never four hours early at UTC
 * midnight on Railway. Rows are effective-dated so a future band change
 * appends; the newest effective_date ≤ that day wins.
 */
async function loadBandRows(db, { asOf = new Date() } = {}) {
  const asOfEtDate = typeof asOf === 'string' ? asOf : etDateString(asOf);
  const rows = await db('residential_unit_pricing')
    .where('effective_date', '<=', asOfEtDate)
    .orderBy('effective_date', 'desc');
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.service_code}|${row.frequency}|${row.unit_band}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return byKey;
}

// ── Snapshot integrity ──────────────────────────────────────────
// engineInputs are browser-controlled on the recompute paths (admin save,
// public replay, admin-pricing-config), so a snapshot the engine will
// price from must prove it came from THIS resolver, for THIS property. Each
// row carries an HMAC (JWT_SECRET) over its rate fields + the quoted
// address; estimate-engine honors a row only when the signature verifies
// AND the input's address is the signed one (a signed 1BR row cannot be
// transplanted onto another quote). Fail closed: no secret → nothing signs,
// nothing verifies, the standard ladder prices.
const SNAPSHOT_SIG_VERSION = 'v1';

function signingSecret() {
  const secret = process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.length ? secret : null;
}

function normalizeSubjectAddress(address) {
  return String(address || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function snapshotCanonical(band, subjectAddress) {
  return [
    SNAPSHOT_SIG_VERSION,
    band.serviceCode, band.frequency, band.band,
    Number(band.initialPrice).toFixed(2), Number(band.recurringPrice).toFixed(2),
    band.includedScope, String(band.oversizeSqftThreshold), band.effectiveDate,
    normalizeSubjectAddress(subjectAddress),
  ].join('|');
}

function signUnitBandSnapshot(band, subjectAddress) {
  const secret = signingSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(snapshotCanonical(band, subjectAddress)).digest('hex');
}

function verifyUnitBandSnapshot(band, subjectAddress) {
  const secret = signingSecret();
  if (!secret || !band || typeof band.sig !== 'string' || !/^[0-9a-f]{64}$/.test(band.sig)) return false;
  const expected = crypto.createHmac('sha256', secret).update(snapshotCanonical(band, subjectAddress)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(band.sig, 'hex'));
}

/**
 * The engine's ONLY door to a band row: the row for `key` from
 * engineInput.unitBandPricing, iff it is signed for this input's address
 * and names the engine service key it is being used for. Anything else →
 * null → the standard footprint pricer.
 */
function trustedUnitBand(engineInput, key) {
  const band = engineInput?.unitBandPricing?.[key];
  if (!band || typeof band !== 'object') return null;
  if (band.serviceCode !== BAND_SERVICE_KEYS[key]) return null;
  if (!(Number(band.recurringPrice) > 0)) return null;
  if (!verifyUnitBandSnapshot(band, engineInput.address)) return null;
  return band;
}

function rowToPrice(row) {
  return {
    serviceCode: row.service_code,
    band: row.unit_band,
    initialPrice: Number(row.initial_price),
    recurringPrice: Number(row.recurring_price),
    includedScope: row.included_scope,
    oversizeSqftThreshold: Number(row.oversize_sqft_threshold),
    effectiveDate: row.effective_date instanceof Date
      ? row.effective_date.toISOString().slice(0, 10)
      : String(row.effective_date).slice(0, 10),
    scopeExclusions: SCOPE_EXCLUSIONS[row.included_scope] || [],
    scopeNote: SCOPE_NOTES[row.included_scope] || null,
  };
}

/**
 * Pure eligibility verdict — which pest keys of this intent may band-price,
 * and why the rest may not. Exported for pinning; the async resolver below
 * adds the DB read.
 */
function unitBandEligibility({ intent, unitScope, propertyFacts } = {}) {
  const services = intent?.services || {};
  const declined = (reason) => ({ eligible: false, reason, keys: {} });
  if (!intent || intent.decision !== 'draft') return declined('not_a_draft');
  if (intent.is_commercial === true) return declined('commercial_intent');
  if (unitScope?.serviceScope !== 'residential_unit') return declined('not_a_residential_unit');
  // Unit-scoped sqft outranks the band (basis ladder). With the guardrails
  // gate OFF a whole-building county area may still sit here — that is the
  // pre-lane behavior the kill switch preserves, and the band must not
  // second-guess a resolved measurement.
  if (Number(propertyFacts?.home?.value) > 0) return declined('unit_sqft_resolved');
  const keys = {};
  const pest = services.pest;
  if (pest && typeof pest === 'object') {
    const roach = String(pest.roachType || 'none').toLowerCase();
    if (roach !== 'none') {
      keys.pest = { eligible: false, reason: 'roach_program' };
    } else {
      const frequency = bandFrequencyForIntent(pest.frequency);
      keys.pest = frequency
        ? { eligible: true, frequency, intentFrequency: String(pest.frequency || 'quarterly') }
        : { eligible: false, reason: 'monthly_frequency' };
    }
  }
  const oneTime = services.oneTimePest;
  if (oneTime && typeof oneTime === 'object') {
    const roach = String(oneTime.roachType || 'none').toLowerCase();
    keys.oneTimePest = roach === 'none'
      ? { eligible: true, frequency: 'one_time' }
      : { eligible: false, reason: 'roach_program' };
  }
  const anyEligible = Object.values(keys).some((k) => k.eligible);
  if (!anyEligible) {
    return { eligible: false, reason: Object.keys(keys).length ? 'no_eligible_pest_service' : 'no_pest_service', keys };
  }
  return { eligible: true, reason: null, keys };
}

/**
 * Resolve band pricing for a draft. Returns null when the gate is off or
 * nothing is eligible; otherwise an audit-shaped object that ALSO carries
 * the per-service rows the pricing engine consumes:
 *
 *   {
 *     eligible: true, pricingBasis, pricingBand, bedroomCount, bedroomSource,
 *     sizeBasis: 'bedroom_band',
 *     pest?: { frequency, intentFrequency, ...row },   // when priced
 *     oneTimePest?: { frequency: 'one_time', ...row },
 *     missing: ['bedroom_count'] | [],                  // nothing priced
 *     parked: { pest: 'monthly_frequency' } | {},       // per-key declines
 *     unresolved: 'no_rate_row' | null,
 *   }
 *
 * Fail-open by contract: a table read failure returns `unresolved:
 * 'rate_lookup_failed'` and nothing prices from the band — the standard
 * ladder + its fallback-footprint review marker take over, exactly as
 * with the gate off.
 */
async function resolveUnitBandPricing(db, { intent, unitScope, propertyFacts, extraction, asOf = new Date() } = {}) {
  if (!unitBandPricingEnabled()) return null;
  const verdict = unitBandEligibility({ intent, unitScope, propertyFacts });
  if (!verdict.eligible) return null;
  const parked = {};
  for (const [key, k] of Object.entries(verdict.keys)) {
    if (!k.eligible) parked[key] = k.reason;
  }
  const stated = callerStatedBedroomCount({ extraction, intent });
  const base = {
    eligible: true,
    pricingBasis: PRICING_BASIS,
    sizeBasis: SIZE_BASIS,
    bedroomCount: stated.count,
    bedroomSource: stated.source,
    pricingBand: bandForBedroomCount(stated.count),
    missing: [],
    parked,
    unresolved: null,
  };
  if (base.pricingBand === null) {
    return { ...base, missing: ['bedroom_count'] };
  }
  if (!signingSecret()) {
    return { ...base, unresolved: 'no_signing_secret' };
  }
  let rows;
  try {
    rows = await loadBandRows(db, { asOf });
  } catch (err) {
    return { ...base, unresolved: `rate_lookup_failed: ${err.message}` };
  }
  const priced = {};
  let missingRow = false;
  for (const [key, k] of Object.entries(verdict.keys)) {
    if (!k.eligible) continue;
    const row = rows.get(`${BAND_SERVICE_KEYS[key]}|${k.frequency}|${base.pricingBand}`);
    if (!row) { missingRow = true; continue; }
    const snapshot = {
      frequency: k.frequency,
      ...(k.intentFrequency ? { intentFrequency: k.intentFrequency } : {}),
      ...rowToPrice(row),
    };
    priced[key] = {
      ...snapshot,
      subjectAddress: normalizeSubjectAddress(intent.address),
      sig: signUnitBandSnapshot(snapshot, intent.address),
    };
  }
  if (!Object.keys(priced).length) {
    return { ...base, unresolved: 'no_rate_row' };
  }
  return {
    ...base,
    ...priced,
    ...(missingRow ? { unresolved: 'no_rate_row' } : {}),
  };
}

module.exports = {
  unitBandPricingEnabled,
  UNIT_BANDS,
  PRICING_BASIS,
  SIZE_BASIS,
  SCOPE_EXCLUSIONS,
  SCOPE_NOTES,
  bandForBedroomCount,
  bandFrequencyForIntent,
  callerStatedBedroomCount,
  unitBandEligibility,
  resolveUnitBandPricing,
  trustedUnitBand,
  signUnitBandSnapshot,
  verifyUnitBandSnapshot,
  _private: { loadBandRows, rowToPrice, snapshotCanonical },
};
