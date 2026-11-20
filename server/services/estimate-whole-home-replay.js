'use strict';

/**
 * Quote-time whole-home exclusion terms for estimate replay (GATE_EXCLUSION_WHOLE_HOME).
 *
 * The whole-home minimum comes from the home-size table in Settings (pricing_config onetime_exclusion) and the renewal
 * price from the guarantee tiers, both editable. Every replay re-runs generateEstimate under whatever they say NOW, so
 * without an input-level restore a Settings change would re-price an ALREADY-SENT quote. Same contract as the area add-on
 * and Tree & Shrub knob replays, shared by BOTH authoritative replay paths (estimate-public#savedFloorReplayOverrides and
 * admin-estimate-persistence#serverRecomputeFromEstimateData).
 *
 * Trusted source: the SAVED priced rows of the estimate (result one-time rows, else the raw engine result), which the pricer
 * stamped with wholeHomeMinimum and guaranteeRenewalPrice. Never client-posted input: the engine honors the signal only on
 * a savedEstimateReplay, and the key is stripped from posted bodies (estimate-client-identity-fields). A row saved before the
 * stamp carries a missing value: it replays the live table (per field).
 */
function savedRows(estData) {
  const oneTime = estData?.result?.oneTime || {};
  return [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
    ...(Array.isArray(estData?.engineResult?.lineItems) ? estData.engineResult.lineItems : []),
  ];
}

const positive = (value) => (Number(value) > 0 ? Number(value) : null);

// { minimum, renewal } from the first saved whole-home exclusion row that carries either, else null (replay live).
function wholeHomeSealReplaySignal(estData) {
  const { isRodentExclusionRow } = require('../../shared/estimate-purchased-warranty.cjs');
  for (const row of savedRows(estData)) {
    if (!isRodentExclusionRow(row) || row.includesReentryGuarantee !== true) continue;
    const minimum = positive(row.wholeHomeMinimum);
    const renewal = positive(row.guaranteeRenewalPrice);
    if (minimum || renewal) return { minimum, renewal };
  }
  return null;
}

module.exports = { wholeHomeSealReplaySignal };
