// Spray-rate math for the misting install calibration form's live preview (GATE_MOSQUITO_MISTING; the
// records are dark with it). Same formulas as server/services/misting-calibration-math.js, which is
// the authority (it computes and stores the numbers). Both are tested against
// shared/misting-calibration-cases.json so the two copies cannot drift.
//
// A known product (shared/misting-products.json) states its daily limit for one mix; a stronger mix
// lowers the allowed volume (strength factor, never below 1). An unknown product (null) takes the
// limit staff enter, with no strength factor.

// Round to the column scale; toPrecision drops float noise before the half-up.
export const roundTo = (value, places) => {
  const f = 10 ** places;
  return Math.round(Number((Number(value) * f).toPrecision(12))) / f;
};

export function computeCalibration(input, product = null) {
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
    withinLabel: dailyOutputFlOz <= labelDailyCapFlOz,
  };
}

// One decimal, trailing zeros dropped; three decimals when one decimal would print the pair the same.
const trimmed = (n, places) => String(Number(Number(n).toFixed(places)));
export function formatOzPair(daily, cap) {
  const places = trimmed(daily, 1) === trimmed(cap, 1) ? 3 : 1;
  return [trimmed(daily, places), trimmed(cap, places)];
}

export function overLabelMessage(dailyOutputFlOz, labelDailyCapFlOz) {
  const [daily, cap] = formatOzPair(dailyOutputFlOz, labelDailyCapFlOz);
  return `This schedule puts out ${daily} fl oz a day. The label allows ${cap}. Shorten the mist or run fewer cycles.`;
}

// The live line under the form. Red (over) is the caller's job: it reads withinLabel.
export function previewLine(result) {
  const [daily, cap] = formatOzPair(result.dailyOutputFlOz, result.labelDailyCapFlOz);
  if (!result.withinLabel) return overLabelMessage(result.dailyOutputFlOz, result.labelDailyCapFlOz);
  const stronger = result.strengthFactor > 1 ? ' Stronger mix: the daily limit is lower.' : '';
  return `Puts out ${daily} fl oz a day. The label allows ${cap} at this mix.${stronger}`;
}
