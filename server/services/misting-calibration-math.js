'use strict';

// Spray-rate math for the misting install calibration (GATE_MOSQUITO_MISTING; the records are dark with it).
//
// The product label caps the finished solution a system may put out per 1,000 cu ft per day. At install
// the technician times one nozzle, and this module turns that into the system's daily output and the
// label's daily cap for the treated volume. wiki/protocols/mosquito-misting-systems.md step 7.
//
// A KNOWN product (shared/misting-products.json) states its limit for one mix (labelRateMix). A stronger
// mix lowers the volume the label allows, so the cap is divided by the strength factor (never below 1:
// a weaker mix does not raise the cap). An unknown product (product = null) takes the limit staff enter,
// with no strength factor.
//
// client/src/lib/mistingCalibrationMath.js is the same math for the form preview. Both are tested against
// shared/misting-calibration-cases.json, so the two copies cannot drift.

// Round to the column scale. toPrecision first drops float noise (1.4374999999 -> 1.4375) before the half-up.
const roundTo = (value, places) => {
  const f = 10 ** places;
  return Math.round(Number((Number(value) * f).toPrecision(12))) / f;
};

/**
 * @param {object} input camelCase: tankGallons, nozzleCount, riserCount, nozzleFlowFlOzPerMin, cycleSeconds,
 *   mistTimes (array; its length is the cycles a day), treatedAreaSqFt, treatedHeightFt,
 *   labelMaxFlOzPer1000CuFtDay, concentrateFlOzPerTank
 * @param {object|null} product an entry of shared/misting-products.json, or null for an unknown product
 */
function computeCalibration(input, product = null) {
  const emitters = Number(input.nozzleCount) + Number(input.riserCount);
  const treatedVolumeCuFt = roundTo(Number(input.treatedAreaSqFt) * Number(input.treatedHeightFt), 1);
  const perCycle = (emitters * Number(input.nozzleFlowFlOzPerMin) * Number(input.cycleSeconds)) / 60;
  const cycles = Array.isArray(input.mistTimes) ? input.mistTimes.length : 0;
  const mixFlOzPerGal = Number(input.concentrateFlOzPerTank) / Number(input.tankGallons);
  const rate = product?.labelRateMix;
  const strengthFactor = rate
    ? (Number(input.concentrateFlOzPerTank) * rate.waterGal) / (Number(input.tankGallons) * rate.concentrateFlOz)
    : 1;
  const cap = (Number(input.labelMaxFlOzPer1000CuFtDay) * treatedVolumeCuFt) / 1000 / Math.max(1, strengthFactor);
  const outputFlOzPerCycle = roundTo(perCycle, 3);
  const dailyOutputFlOz = roundTo(perCycle * cycles, 3);
  const labelDailyCapFlOz = roundTo(cap, 3);
  return {
    emitters,
    treatedVolumeCuFt,
    outputFlOzPerCycle,
    dailyOutputFlOz,
    strengthFactor: roundTo(strengthFactor, 4),
    labelDailyCapFlOz,
    mixFlOzPerGal: roundTo(mixFlOzPerGal, 3),
    // The stored (rounded) numbers are compared, so this agrees with the table's CHECK.
    withinLabel: dailyOutputFlOz <= labelDailyCapFlOz,
  };
}

// One decimal, trailing zeros dropped ("61.9", "47.5", "100"). Three decimals when one decimal
// would print the two numbers the same ("47.5 against 47.5").
const trimmed = (n, places) => String(Number(Number(n).toFixed(places)));
function formatOzPair(daily, cap) {
  const places = trimmed(daily, 1) === trimmed(cap, 1) ? 3 : 1;
  return [trimmed(daily, places), trimmed(cap, places)];
}

function overLabelMessage(dailyOutputFlOz, labelDailyCapFlOz) {
  const [daily, cap] = formatOzPair(dailyOutputFlOz, labelDailyCapFlOz);
  return `This schedule puts out ${daily} fl oz a day. The label allows ${cap}. Shorten the mist or run fewer cycles.`;
}

/**
 * The daily cap at a different mix than the calibration's: what a refill must stay under.
 *
 * @param {object} args
 * @param {object} args.calibration camelCase calibration: tankGallons, concentrateFlOzPerTank,
 *   labelMaxFlOzPer1000CuFtDay, treatedVolumeCuFt, labelDailyCapFlOz
 * @param {number} args.mixFlOzPerGal the refill's concentrate per gallon of water
 * @param {object|null} args.product the calibration's known product, or null
 *
 * A KNOWN product states its limit for its label mix, so the cap is the calibration formula at the
 * refill's strength. An UNKNOWN product's entered limit was for the calibration's own mix, so the stored
 * cap shrinks by the refill's strength against that mix. Stronger lowers the cap; weaker never raises it.
 */
function capAtMix({ calibration, mixFlOzPerGal, product = null }) {
  const mix = Number(mixFlOzPerGal);
  const rate = product?.labelRateMix;
  if (rate) {
    const factor = mix / (rate.concentrateFlOz / rate.waterGal);
    const cap = (Number(calibration.labelMaxFlOzPer1000CuFtDay) * Number(calibration.treatedVolumeCuFt)) / 1000 / Math.max(1, factor);
    return roundTo(cap, 3);
  }
  const calibrationMix = Number(calibration.concentrateFlOzPerTank) / Number(calibration.tankGallons);
  return roundTo(Number(calibration.labelDailyCapFlOz) / Math.max(1, mix / calibrationMix), 3);
}

// A known product's label mix range with 2% slack on each end, in fl oz of concentrate per gallon.
const MIX_SLACK = 0.02;
function labelMixRange(product) {
  return {
    low: (product.labelRateMix.concentrateFlOz / product.labelRateMix.waterGal) * (1 - MIX_SLACK),
    high: (product.maxMix.concentrateFlOz / product.maxMix.waterGal) * (1 + MIX_SLACK),
  };
}
const mixWithinLabelRange = (product, mixFlOzPerGal) => {
  const { low, high } = labelMixRange(product);
  return mixFlOzPerGal >= low && mixFlOzPerGal <= high;
};

module.exports = { roundTo, computeCalibration, overLabelMessage, formatOzPair, capAtMix, labelMixRange, mixWithinLabelRange };
