/**
 * Send-time hold for an estimate-tool price the 2026-09-26 lookup guards now
 * refuse (#4862 condo unit, #4871 development parcel, #4878 guessed home
 * size). An estimate saved before those guards keeps its stored price, and
 * every send path replays that stored price — the scheduled-send cron
 * included — whether or not anyone reopens it. assertEstimateSendable refuses
 * it (LEGACY_AUTOFILL_PRICE) until staff regenerate and save it in the
 * estimate tool, which clears the values below.
 *
 * Mirrors the estimate tool's reopen rules (client/src/lib/lookupPrefill.js
 * scrubReopenedEstimateForm + EstimateToolViewV2 linesPricedOnGuessedHomeSize);
 * keep the two in step. Only builder-saved rows are judged — they alone
 * carry the form snapshot (`inputs`) these rules read; engine-drafted rows
 * (lead auto-send, call drafts) are out of scope. Values the operator typed
 * (_manualFields / edited flags) never hold a send.
 */

const AUTO_DERIVED_TERMITE_MEASUREMENTS = [
  ['termiteFootprintSqFt', '_termiteFootprintAuto'],
  ['trenchingPerimeterLF', '_trenchingPerimeterAuto'],
  ['boracareSqft', '_boracareSqftAuto'],
  ['preslabSqft', '_preslabSqftAuto'],
];

// Parcel reads the estimate tool withholds under the unit_parcel flag and that
// size a price. Presence is the test — a stored 0% still priced the lot.
const PARCEL_PRICED_AREA_READS = [
  'estimatedTurfSf', 'turfFallbackPreviewSf',
  'imperviousSurfacePercent', 'imperviosSurfacePercent', 'estimatedBedAreaPercent',
];

function isUnitParcel(profile) {
  return Array.isArray(profile?.fieldVerifyFlags)
    && profile.fieldVerifyFlags.some((f) => f && f.field === 'lotSize' && f.scope === 'unit_parcel');
}

function presentNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function pricedLines(result) {
  return [
    ...(result?.recurring?.services || []),
    ...(result?.oneTime?.items || []),
    ...(result?.oneTime?.specItems || []),
  ];
}

/**
 * @param {object|null} data parsed estimate_data
 * @returns {string[]} what the stored price was built from that today's
 *   guards refuse (empty = sendable as far as this hold is concerned)
 */
function legacyAutofillPriceReasons(data) {
  const inputs = data?.inputs;
  if (!inputs || typeof inputs !== 'object') return [];
  const profile = data.engineRequest?.profile || {};
  const typed = (key) => Array.isArray(inputs._manualFields) && inputs._manualFields.includes(key);
  const reasons = [];

  if (pricedLines(data.result).some((line) => line?.footprintWasDefaulted === true
    && !line.quoteRequired && line.priceOverridden !== true)) {
    reasons.push(profile.footprintUnknown === true
      ? 'a guessed home footprint (enter the number of stories)'
      : 'a guessed 2,000 sq ft home size (enter home sq ft)');
  }

  if (profile.residentialUnitLookup && /^condo/i.test(String(inputs.propertyType || ''))) {
    if (inputs.svcTrenching && inputs.trenchingEstimateFromFootprint) {
      reasons.push('a trenching perimeter estimated from one unit\'s footprint');
    }
    if (AUTO_DERIVED_TERMITE_MEASUREMENTS.some(([key, flag]) => inputs[flag] && String(inputs[key] || '').trim() !== '')) {
      reasons.push('termite measurements the lookup derived from one unit');
    }
  }

  if (isUnitParcel(profile)) {
    if (!inputs._lotSqFtEdited && !typed('lotSqFt') && Number(inputs.lotSqFt) > 0) {
      reasons.push('the development\'s lot size');
    }
    if (!typed('bedArea') && Number(inputs.bedArea) > 0) {
      reasons.push('the lookup\'s bed area for the development');
    }
    if (inputs.fleaExteriorAreaSource === 'AI_ESTIMATE' && !typed('fleaExteriorAreaSqFt')
      && Number(inputs.fleaExteriorAreaSqFt) > 0) {
      reasons.push('a flea exterior area copied from the development\'s lawn');
    }
    // A TYPED bed area is also written to estimatedBedAreaSf, marked 'manual'.
    if (PARCEL_PRICED_AREA_READS.some((key) => presentNumber(profile[key]))
      || (Number(profile.estimatedBedAreaSf) > 0 && profile.bedAreaSource !== 'manual')) {
      reasons.push('lawn and bed areas from the development\'s parcel');
    }
  }
  return [...new Set(reasons)];
}

function parseData(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return typeof value === 'object' ? value : null;
}

// An authored proposal prices from its own stored itemization — building
// line items, service programs, or corrective work (estimate-proposal.js
// normalizeProposal). A bare `enabled` flag without any falls back to the
// synthesized builder price, which the hold still judges (codex r2 P1 #4941).
function proposalCarriesItemization(proposal) {
  if (!proposal || proposal.enabled !== true) return false;
  return ['buildings', 'programs', 'correctiveWork'].some((key) => Array.isArray(proposal[key]) && proposal[key].length > 0);
}

/**
 * The row verdict every customer-facing rail shares (assertEstimateSendable,
 * the group-sibling preflight, and pricing-authority-gate's
 * rowPassesGatedSendAuthority, which the follow-up / engagement / renewal /
 * extension / composer / deposit / voice rails all ask). Exempt: an itemized
 * proposal (its line items are the price; the retained builder snapshot is
 * inert — codex r1 P1 #4941) and a price the customer already accepted.
 */
function rowHeldForLegacyAutofillPrice(row = {}) {
  const data = parseData(row?.estimate_data ?? row?.estimateData);
  if (!data || proposalCarriesItemization(data.proposal)) return false;
  if (row.price_locked_at != null || String(row.status || '') === 'accepted') return false;
  return legacyAutofillPriceReasons(data).length > 0;
}

module.exports = { legacyAutofillPriceReasons, rowHeldForLegacyAutofillPrice };
