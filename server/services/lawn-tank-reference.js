/**
 * The tank sheet's reference amounts (Protocols tab, lawn "110-gallon tank mixing reference", GET /admin/protocols/lawn-mix).
 *
 * For each sprayed product the sheet shows what goes in one fill:
 *   per100Gal     100 gal of the big tank (a broadcast liquid line, or any product sold in a 2.5 gal jug),
 *   fullTank      a full tank of the selected rig when it is not 100 gal (the 110 gal tank),
 *   backpack4Gal  the 4 gal FlowZone backpack (every sprayed product: spot work, or a top-up).
 * amount = rate per 1,000 sq ft x (tank gallons / carrier gal per 1,000 sq ft), sized by calculateProductAmount over the area one
 * fill covers. The carrier is the staged program row's own carrier where the job calculation uses it (the spring catch-up, a spot row
 * with its own rate), else the protocol line's stated spray volume ("in 4 gal per 1,000 sq ft"), else the last calibration of that sprayer. A percent-of-spray product (surfactant, 0.25% v/v) is that share of the fill. A spreader
 * product has no tank amount, only its rate per 1,000 sq ft.
 *
 * Reference only (owner 2026-11-26: every safety or limit alert is a warning, never hides an amount): an overdue or estimated
 * sprayer test, a plan hold or a limit is a warning beside the amount. The plan, the job card and the close-out keep their own
 * rules; nothing here feeds a job amount, a cost or a completion.
 */
const { calculateProductAmount, v13RateOptions } = require('./waveguard-plan-engine');
const { etDateString } = require('../utils/datetime-et');
const roundsCatchUp = require('./lawn-rounds-catchup');

const BIG_TANK_GAL = 100;
const BACKPACK_GAL = 4;
const TANK_CATEGORIES = new Set(['water_conditioner', 'dry_wg_wdg_wp_df', 'liquid_flowable_sc', 'ec_ew', 'solution_sl', 'liquid_fertilizer', 'adjuvant_last']);
const LIQUID_UNIT = /^(fl[\s_]*oz|gal|gallons?|qt|quarts?|pt|pints?|ml)$/i;
const SMALL_AMOUNT = 0.25;
const GRAMS_PER_OZ = 28.3495;
const ML_PER_FL_OZ = 29.5735;
const FL_OZ_PER_GAL = 128;

// The spray volume a protocol line fixes: "in 4 gal per 1,000 sq ft", "at 2 gal per 1,000 sq ft", "in 4 gal of water per 1,000 sq ft",
// "3 fl oz per 1,000 sq ft in 5 gal of water". null when the line states none.
const LINE_VOLUME = [
  /\b(?:in|at)\s+(\d+(?:\.\d+)?)\s*gal(?:lons?)?\s+(?:of\s+water\s+)?per\s+1,?000\s*sq\.?\s*ft/i,
  /\bin\s+(\d+(?:\.\d+)?)\s*gal(?:lons?)?\s+of\s+water\b/i,
];
function lineCarrierGalPer1000(raw) {
  for (const pattern of LINE_VOLUME) {
    const found = String(raw || '').match(pattern);
    if (found && Number(found[1]) > 0) return Number(found[1]);
  }
  return null;
}

// A percent of the spray volume (a surfactant): the staged row's concentration, else the line's "0.25% of the spray volume".
function concentrationPercent(row, raw) {
  const found = String(row?.gates?.concentration || '').match(/(\d+(?:\.\d+)?)\s*%/)
    || String(raw || '').match(/(\d+(?:\.\d+)?)\s*%\s+of\s+the\s+spray\s+volume/i);
  return found && Number(found[1]) > 0 ? Number(found[1]) : null;
}

const isTwoAndHalfGallonJug = (product) => /^\s*2\.5\s*-?\s*gal/i.test(String(product?.container_size || ''));

function isSpreaderProduct(product, rateUnit) {
  if (TANK_CATEGORIES.has(product?.mixing_order_category)) return false;
  if (LIQUID_UNIT.test(String(rateUnit || '').trim())) return false;
  return /granul|spread/i.test(`${product?.application_method || ''} ${product?.category || ''} ${product?.name || ''}`)
    || /^lb/i.test(String(rateUnit || ''));
}

// A small amount also in metric: dry oz under 0.25 in grams, fl oz under 0.25 in mL.
function metricFor(amount, unit) {
  if (!(amount > 0) || amount >= SMALL_AMOUNT) return {};
  const key = String(unit || '').trim().toLowerCase();
  if (/^fl[\s_]*oz$/.test(key)) return { metricAmount: Number((amount * ML_PER_FL_OZ).toFixed(1)), metricUnit: 'mL' };
  if (key === 'oz') return { metricAmount: Number((amount * GRAMS_PER_OZ).toFixed(1)), metricUnit: 'g' };
  return {};
}

function fill({ gallons, carrier, carrierSource, rateArgs, percent }) {
  if (percent) {
    const amount = Number(((percent / 100) * gallons * FL_OZ_PER_GAL).toFixed(3));
    return { gallons, carrierGalPer1000: null, carrierSource: 'concentration', amount, amountUnit: 'fl oz', ...metricFor(amount, 'fl oz') };
  }
  if (!(carrier > 0)) return null;
  const mix = calculateProductAmount({ ...rateArgs, lawnSqft: (gallons / carrier) * 1000, carrierGalPer1000: carrier });
  if (!(mix.amount > 0) || !mix.amountUnit) return null;
  return { gallons, carrierGalPer1000: carrier, carrierSource, amount: mix.amount, amountUnit: mix.amountUnit, ...metricFor(mix.amount, mix.amountUnit) };
}

const rigCarrier = (calibration) => Number(calibration?.carrier_gal_per_1000 || 0);

// The spray volume a line's amount is stated over, read as the job calculation reads it, so the sheet and the job card agree:
//   'row'   the staged row's own carrier: the spring catch-up's hose pass (roundsCatchUp.carrierFor, as the plan sizes it), or a spot
//           row that states its own rate (job-card.js sizes that dose on the row's carrier, never the rig's);
//   'line'  the volume the protocol line's text states ("in 4 gal per 1,000 sq ft");
// else [null, null]: each sprayer's own calibration.
function fixedCarrier(item, row, planState) {
  const rowCarrier = roundsCatchUp.carrierFor(item, row, null)
    || (planState === 'spot' && Number(row?.ratePer1000) > 0 && Number(row?.carrierGalPer1000) > 0 ? Number(row.carrierGalPer1000) : null);
  if (rowCarrier) return [rowCarrier, 'row'];
  const stated = lineCarrierGalPer1000(item.raw);
  return stated ? [stated, 'line'] : [null, null];
}

// The big tank: a 2.5 gal jug, or a whole-lawn line (a staged row that is not a spot row; with no staged row, a base line).
function goesInBigTank(product, item, row) {
  if (isTwoAndHalfGallonJug(product)) return true;
  return row ? row.applicationMode !== 'spot' : item.role === 'base' && !item.conditional;
}

/**
 * The reference amounts of one matched line. `rig` is the selected calibration (the big tank), `backpack` the FlowZone's;
 * `v13Line` the plan's own decision for the line (v13LineState: its staged row and state), absent with the gate off.
 */
function tankReference({ product, item, v13Line, nutrientTargets, rig, backpack }) {
  if (!product) return null;
  const { row, state: planState } = v13Line || {};
  const rateArgs = { product, ...nutrientTargets, ...v13RateOptions(row) };
  const rate = calculateProductAmount({ ...rateArgs, lawnSqft: 1000, carrierGalPer1000: 0 });
  const percent = concentrationPercent(row, item.raw);
  const none = { bigTank: false, fixedCarrierGalPer1000: null, fixedCarrierSource: null, per100Gal: null, fullTank: null, backpack4Gal: null, backpackMissing: false };
  const base = { ratePer1000: rate.ratePer1000, rateUnit: rate.rateUnit, rateSource: rate.rateSource, concentrationPercent: percent, planState: planState || null, ...none };
  if (!percent && isSpreaderProduct(product, rate.rateUnit)) return { ...base, application: 'spreader' };
  const [lineCarrier, lineSource] = fixedCarrier(item, row, planState);
  // A backpack picked as the rig is not the big tank.
  const tankRig = rig?.system_type === 'backpack' ? null : rig;
  const sized = (gallons, calibration) => fill({
    gallons, carrier: lineCarrier || rigCarrier(calibration), carrierSource: lineSource || 'calibration', rateArgs, percent,
  });
  const bigTank = goesInBigTank(product, item, row);
  const fullGallons = Number(tankRig?.tank_capacity_gal || 0);
  const backpack4Gal = sized(BACKPACK_GAL, backpack);
  return {
    ...base,
    application: 'spray',
    bigTank,
    fixedCarrierGalPer1000: lineCarrier,
    fixedCarrierSource: lineSource,
    per100Gal: bigTank ? sized(BIG_TANK_GAL, tankRig) : null,
    fullTank: bigTank && fullGallons > 0 && fullGallons !== BIG_TANK_GAL ? sized(fullGallons, tankRig) : null,
    backpack4Gal,
    // The FlowZone has no sprayer test on file, so its amount cannot be sized (a rate exists, the line fixes no volume).
    backpackMissing: !backpack4Gal && rate.ratePer1000 > 0 && !(lineCarrier || percent || rigCarrier(backpack) > 0),
  };
}

// Why a calibration is not a field test: an estimated (or any other non-verified) status, or no status on file at all.
const notFieldTested = (status) => (status == null ? 'field test not on file' : status !== 'field_verified' ? 'estimated, not field tested' : null);

// The sheet warning for a sprayer whose test is overdue or is not a field test. The amounts stay; this line says what they assume.
function sprayerTestWarning(calibration, { code, now = new Date() } = {}) {
  const carrier = rigCarrier(calibration);
  if (!calibration || !(carrier > 0)) return null;
  const overdue = Boolean(calibration.expires_at) && new Date(calibration.expires_at) <= now;
  const untested = notFieldTested(calibration.calibration_status);
  if (!overdue && !untested) return null;
  const name = calibration.system_name || 'The selected sprayer';
  const at = `${carrier} gal per 1,000 sq ft`;
  const testedOn = calibration.calibrated_at ? ` last tested ${etDateString(new Date(calibration.calibrated_at))}` : '';
  const message = overdue
    ? `Sprayer test overdue: ${name}${testedOn} at ${at}${untested ? ` (${untested})` : ''}. Amounts below assume that. Test the sprayer again.`
    : `Sprayer not field tested: ${name} at ${at} (${untested}). Amounts below assume that. Test the sprayer.`;
  return { code, severity: 'warning', equipmentSystemId: calibration.equipment_system_id || null, message };
}

module.exports = { tankReference, sprayerTestWarning, lineCarrierGalPer1000, BIG_TANK_GAL, BACKPACK_GAL };
