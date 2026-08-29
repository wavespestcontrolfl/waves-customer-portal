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
function callerStatedBedroomCount({ extraction, intent, override } = {}) {
  // A clarify REPLY is the customer's newest statement and outranks what
  // the call extraction or the composer captured earlier.
  const fromReply = positiveInt(override);
  if (fromReply !== null) return { count: fromReply, source: 'clarify_reply' };
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
// row carries an HMAC over its rate fields + the quoted address;
// estimate-engine honors a row only when the signature verifies AND the
// input's address is the signed one (a signed 1BR row cannot be
// transplanted onto another quote).
//
// KEYRING — persisted snapshots must keep verifying for the life of the
// estimate (in-flight tokenized links, existing DB rows), so signing is
// decoupled from the auth secret: PRICING_SNAPSHOT_SECRET signs; every
// secret in PRICING_SNAPSHOT_SECRET_PREVIOUS (comma-separated) still
// VERIFIES, and each row carries the key id (`kid`) it was signed under.
// Rotation = move the old secret into _PREVIOUS and set a new one —
// nothing already quoted stops pricing. JWT_SECRET is the bootstrap
// fallback only while no dedicated secret is set (it is never consulted
// once one is). Fail closed: no secret at all → nothing signs, nothing
// verifies, the standard ladder prices.
const SNAPSHOT_SIG_VERSION = 'v1';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length ? value.trim() : null;
}

function keyIdFor(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

function signingKeyring() {
  const current = nonEmpty(process.env.PRICING_SNAPSHOT_SECRET) || nonEmpty(process.env.JWT_SECRET);
  if (!current) return { current: null, byKid: new Map() };
  const previous = String(process.env.PRICING_SNAPSHOT_SECRET_PREVIOUS || '')
    .split(',').map((v) => v.trim()).filter(Boolean);
  const byKid = new Map();
  for (const secret of [current, ...previous]) byKid.set(keyIdFor(secret), secret);
  return { current, byKid };
}

function signingSecret() {
  return signingKeyring().current;
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

/** Returns { sig, kid } under the CURRENT key, or null without a secret. */
function signUnitBandSnapshot(band, subjectAddress) {
  const { current } = signingKeyring();
  if (!current) return null;
  return {
    sig: crypto.createHmac('sha256', current).update(snapshotCanonical(band, subjectAddress)).digest('hex'),
    kid: keyIdFor(current),
  };
}

function verifyUnitBandSnapshot(band, subjectAddress) {
  if (!band || typeof band.sig !== 'string' || !/^[0-9a-f]{64}$/.test(band.sig)) return false;
  const { byKid } = signingKeyring();
  // The row names the key it was signed under; a kid the ring no longer
  // carries (or a row without one) cannot verify.
  const secret = typeof band.kid === 'string' ? byKid.get(band.kid) : null;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(snapshotCanonical(band, subjectAddress)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(band.sig, 'hex'));
}

/**
 * The engine's ONLY door to a band row. Verdicts:
 *   { status: 'absent' }                 — no snapshot for this key: the
 *                                          standard footprint pricer runs.
 *   { status: 'ineligible', reason }     — a snapshot exists but the CURRENT
 *                                          input no longer qualifies for a
 *                                          band (real sqft, roach program,
 *                                          commercial): standard pricer.
 *   { status: 'trusted', band }          — signed for this input's address,
 *                                          names this engine key, carries
 *                                          the REQUESTED cadence.
 *   { status: 'untrusted', reason }      — a snapshot exists but cannot be
 *                                          honored (bad/missing signature,
 *                                          other address, other key, a
 *                                          cadence it was not signed for).
 * 'untrusted' must FAIL CLOSED to a quote-required line, never fall back
 * to the footprint ladder: a stored quote whose snapshot stops verifying
 * (secret rotation, an authorized address correction) would otherwise
 * silently re-price on the public replay path — in-flight tokenized
 * estimates must keep working or visibly stop, never change dollars.
 *
 * Cadence: the resolver signs a row PER cadence the table carries
 * (`pestCadences`), because the public ladder recomputes every cadence
 * from one stored input; the row for the requested cadence is selected
 * here, so a quarterly row can never authorize a bi-monthly price.
 */
function trustedUnitBand(engineInput, key, { requestedFrequency, roachType } = {}) {
  const snapshot = engineInput?.unitBandPricing;
  const primary = snapshot?.[key];
  if (!primary || typeof primary !== 'object') return { status: 'absent' };
  // Eligibility is re-checked against the CURRENT input on every replay
  // (the admin save path recomputes from client-edited inputs): a unit
  // that now carries a real measurement prices on the standard ladder,
  // and a roach program keeps its own rules — a still-valid signature
  // must not pin the band once the inputs that justified it are gone.
  // These are legitimate re-pricings, so the verdict is 'ineligible'
  // (standard pricer), not 'untrusted' (fail closed).
  const measured = [engineInput.homeSqFt, engineInput.footprintSqFt, engineInput.footprint, engineInput.livingAreaSqFt, engineInput.buildingSqFt]
    .some((v) => Number(v) > 0);
  if (measured) return { status: 'ineligible', reason: 'unit_sqft_resolved' };
  if (engineInput.isCommercial === true) return { status: 'ineligible', reason: 'commercial_intent' };
  if (String(roachType || 'none').toLowerCase() !== 'none') return { status: 'ineligible', reason: 'roach_program' };
  let band = primary;
  if (key === 'pest') {
    const cadence = bandFrequencyForIntent(requestedFrequency || primary.intentFrequency || 'quarterly');
    if (!cadence) return { status: 'untrusted', reason: 'unsupported_cadence' };
    const byCadence = snapshot.pestCadences && typeof snapshot.pestCadences === 'object'
      ? snapshot.pestCadences[cadence]
      : null;
    band = byCadence || (primary.frequency === cadence ? primary : null);
    if (!band) return { status: 'untrusted', reason: 'no_row_for_cadence' };
    // The map KEY is unsigned — a legitimately signed bi-monthly row filed
    // under `quarterly` would price bi-monthly dollars at quarterly visits.
    // The signed row itself must name the requested cadence.
    if (band.frequency !== cadence) return { status: 'untrusted', reason: 'cadence_mismatch' };
  }
  if (band.serviceCode !== BAND_SERVICE_KEYS[key]) return { status: 'untrusted', reason: 'service_key_mismatch' };
  if (!(Number(band.recurringPrice) > 0)) return { status: 'untrusted', reason: 'no_price' };
  if (!verifyUnitBandSnapshot(band, engineInput.address)) return { status: 'untrusted', reason: 'signature' };
  // The customer-facing scope copy is NOT part of the signature (it is
  // derived, not a rate) — so it is rebuilt here from the signed
  // includedScope key rather than read off the snapshot: a browser-edited
  // snapshot with a valid price signature cannot alter or drop the
  // approved exclusion language (codex GH round on #3576).
  return {
    status: 'trusted',
    band: {
      ...band,
      scopeExclusions: SCOPE_EXCLUSIONS[band.includedScope] || [],
      scopeNote: SCOPE_NOTES[band.includedScope] || null,
    },
  };
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
async function resolveUnitBandPricing(db, { intent, unitScope, propertyFacts, extraction, bedroomCountOverride = null, asOf = new Date() } = {}) {
  if (!unitBandPricingEnabled()) return null;
  const verdict = unitBandEligibility({ intent, unitScope, propertyFacts });
  const parked = {};
  for (const [key, k] of Object.entries(verdict.keys || {})) {
    if (!k.eligible) parked[key] = k.reason;
  }
  if (!verdict.eligible) {
    // A unit whose only band keys are PARKED (monthly-only recurring, a
    // roach program) still returns its audit — the lane's monthly /
    // excluded-program review reason reads parked.pest, and dropping it
    // here would let a probable German-roach/flea ask through on generic
    // fallback-size reasons alone. Nothing is priced from the band.
    if (Object.keys(parked).length) {
      return { eligible: false, reason: verdict.reason, parked, missing: [], unresolved: null, pricingBasis: null, sizeBasis: null, bedroomCount: null, bedroomSource: null, pricingBand: null };
    }
    return null;
  }
  const stated = callerStatedBedroomCount({ extraction, intent, override: bedroomCountOverride });
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
  const signedRow = (row, extra = {}) => {
    const snapshot = { ...extra, ...rowToPrice(row) };
    return {
      ...snapshot,
      subjectAddress: normalizeSubjectAddress(intent.address),
      ...signUnitBandSnapshot(snapshot, intent.address),
    };
  };
  for (const [key, k] of Object.entries(verdict.keys)) {
    if (!k.eligible) continue;
    const row = rows.get(`${BAND_SERVICE_KEYS[key]}|${k.frequency}|${base.pricingBand}`);
    if (!row) { missingRow = true; continue; }
    priced[key] = signedRow(row, {
      frequency: k.frequency,
      ...(k.intentFrequency ? { intentFrequency: k.intentFrequency } : {}),
    });
    if (key === 'pest') {
      // Every cadence the table carries for this band, each signed on its
      // own: the public ladder recomputes quarterly AND bi-monthly from
      // one stored input, and each must price from ITS row.
      const pestCadences = {};
      for (const cadence of Object.values(INTENT_FREQUENCY_TO_BAND)) {
        const cadenceRow = rows.get(`pest|${cadence}|${base.pricingBand}`);
        if (cadenceRow) pestCadences[cadence] = signedRow(cadenceRow, { frequency: cadence });
      }
      priced.pestCadences = pestCadences;
    }
  }
  if (!priced.pest && !priced.oneTimePest) {
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
  _private: { loadBandRows, rowToPrice, snapshotCanonical, signingKeyring, keyIdFor },
};
