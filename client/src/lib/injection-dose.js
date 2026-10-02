// client/src/lib/injection-dose.js
//
// Tree & Shrub injection doses in the truck's measures (owner ruling
// 2026-09-29: an injection is measured in tsp or fl oz like everything else,
// never mL). A trunk-injection label in the catalog gives its rate in mL per
// inch of trunk (DBH) or per palm: the Arborjet injectables. The injection
// record shows that rate, and the dose for the tree measured, through the job
// card's spoon-and-cup formatter (lib/mix-amount.js), rounded inside the
// label; the dose itself is entered as a number of tsp or fl oz.
import { formatMeasuredAmount, formatMeasuredRange } from "./mix-amount";
import { TSP_PER_FL_OZ, isMlUnit } from "./measure-units";
import LABEL_BANDS from "../../../shared/injection-label-bands.json";

const ML_PER_FL_OZ = 29.5735;

/** The units a dose is entered in. */
export const DOSE_UNITS = [
  { value: "tsp", label: "tsp" },
  { value: "fl_oz", label: "fl oz" },
];

// The label's own bands (owner rulings 2026-10-01, #5361): the catalog keeps
// one display range per injectable, but each label splits it by trunk size,
// palm size, target pest or season. Only labels read in full are here
// (shared/injection-label-bands.json, shared with the server's closeout
// check; each row cites its label). A trunk-size band has below / from /
// through / above inches; the other bands are the tech's pick, and a picked
// band can split again by trunk (its sizes). An injectable
// with no row (IMA-jet 10, Propizol until their labels are read) gets no
// worked-out dose: the record shows the label line only.
export const INJECTION_LABEL_BANDS = LABEL_BANDS.map((row) => ({ ...row, match: new RegExp(row.match, "i") }));

// "inch" or "palm" for an injection label unit in mL or g per inch of trunk
// or per palm ("ml/inch dbh", "g/inch dbh", "ml/palm"); null otherwise.
// Mirrors injectionBasisOf in server/services/tree-shrub-closeout.js.
function unitBasis(unit) {
  const match = /^\s*(?:ml|cc|millilit(?:er|re)s?|g|grams?)\s*\/\s*(.*)$/i.exec(String(unit || ""));
  if (!match) return null;
  const per = match[1].trim().toLowerCase();
  if (/^(inch|in\b)/.test(per)) return "inch";
  return /^palm/.test(per) ? "palm" : null;
}

/**
 * Whether a catalog injection label is dosed per inch of trunk or per palm,
 * whatever its unit (Arbor-OTC's is grams): the record needs the trunk in
 * inches for a per-inch label.
 */
export function injectionBasis(product) {
  return unitBasis(product?.default_unit ?? product?.defaultUnit);
}

/**
 * A catalog label's injection rate: { low, high, basis, bands, pick, note,
 * recordsAs } in mL per inch of trunk (basis "inch") or per palm (basis
 * "palm"), with the label's band table when it has one; null for any other
 * label.
 */
export function injectionLabelRate(product) {
  const unit = String(product?.default_unit ?? product?.defaultUnit ?? "");
  const basis = isMlUnit(unit) ? unitBasis(unit) : null;
  if (!basis) return null;
  const bounds = String(product?.default_rate ?? product?.defaultRate ?? "")
    .split(/\s*(?:-|–|to)\s*/)
    .map(Number);
  if (bounds.length > 2 || bounds.some((n) => !(n > 0))) return null;
  const [low, high = low] = bounds.sort((a, b) => a - b);
  const name = String(product?.name ?? "");
  const table = INJECTION_LABEL_BANDS.find((row) => row.match.test(name) && row.basis === basis) || null;
  const { bands = null, pick = null, note = null, recordsAs = null } = table || {};
  return { low, high, basis, bands, pick, note, recordsAs };
}

const isSizeBand = (band) => ["below", "from", "through", "above"].some((edge) => band[edge] != null);
const fitsTrunk = (band, inches) =>
  !(inches >= (band.below ?? Infinity)) && !(inches < (band.from ?? 0)) &&
  !(inches > (band.through ?? Infinity)) && !(inches <= (band.above ?? -Infinity));

/**
 * The band that applies: by trunk size, or the tech's pick (the only band
 * when there is one); null until a trunk size or a pick settles it.
 */
export function injectionBand(rate, trunkInches, pickKey) {
  const bands = rate?.bands;
  if (!bands) return null;
  if (bands.length === 1) return bands[0];
  if (bands.some(isSizeBand)) {
    const inches = Number(trunkInches);
    if (!(inches > 0)) return null;
    return bands.find((band) => fitsTrunk(band, inches)) || null;
  }
  const picked = bands.find((band) => band.key === pickKey) || null;
  if (!picked?.sizes) return picked;
  // A picked band the label splits again by trunk (IMA-jet: the lower rate
  // under 12 in, the highest over 24 in).
  const inches = Number(trunkInches);
  const size = inches > 0 ? picked.sizes.find((band) => fitsTrunk(band, inches)) : null;
  return size ? { ...picked, low: size.low, high: size.high } : null;
}

// A single-rate dose in the truck's measures, never more than 5% under it
// (the job card's spoon tolerance): a spoon or a quarter fl oz at or just
// under the dose when one is that close, else the exact fl oz, cut (never
// rounded up) to hundredths, or thousandths under 1 fl oz.
const FIXED_DOSE_TOLERANCE = 0.05;
function fixedDoseText(ml) {
  const flOz = ml / ML_PER_FL_OZ;
  if (flOz < 1) {
    const spoon = formatMeasuredAmount(ml, "ml");
    return / tsp$/.test(spoon) ? spoon : `${Math.floor(flOz * 1000 + 1e-9) / 1000} fl oz`;
  }
  const quarter = Math.floor(flOz * 4 + 1e-9) / 4;
  if ((flOz - quarter) / flOz <= FIXED_DOSE_TOLERANCE) return formatMeasuredAmount(ml, "ml", { truckMeasures: true });
  return `${Math.floor(flOz * 100 + 1e-9) / 100} fl oz`;
}

// An mL range in spoons or ounces, rounded inside it (the job card's truck
// measures); "½ fl oz – 2 fl oz" reads "½ – 2 fl oz" when both ends share a
// unit. A single rate is one amount, measured at or just under it (see
// fixedDoseText).
function rangeText(lowMl, highMl) {
  if (lowMl === highMl) return fixedDoseText(lowMl);
  const text = formatMeasuredRange(lowMl, highMl, "ml", { truckMeasures: true });
  const shared = /^(.+?) (tsp|fl oz) – (.+?) \2$/.exec(text || "");
  return shared ? `${shared[1]} – ${shared[3]} ${shared[2]}` : text;
}

const basisText = (basis) => (basis === "palm" ? "per palm" : "per inch of trunk");

/** A rate (or band) as the tech reads it: "¼ – 1 tsp per inch of trunk". */
export function injectionLabelText(rate, band = null) {
  const { low, high } = band || rate;
  return `${rangeText(low, high)} ${basisText(rate.basis)}`;
}

/**
 * The dose for this tree ("½ – 2 fl oz"): the band's rate times the trunk's
 * inches, or the band's per-palm rate. Null while the band is not settled,
 * while a per-inch label has no trunk size, and for an injectable with no
 * band table (the label's display range is not a dose for every tree).
 */
export function injectionDoseText(rate, trunkInches, pickKey) {
  const band = injectionBand(rate, trunkInches, pickKey);
  if (!band) return null;
  if (rate.basis === "palm") return rangeText(band.low, band.high);
  const inches = Number(trunkInches);
  if (!(inches > 0)) return null;
  return rangeText(band.low * inches, band.high * inches);
}

// A dose this far under the band's low end is still the band's rounded-down
// suggestion (fixedDoseText reads at most 5% under), never an under-dose.
const UNDER_LABEL_TOLERANCE = 0.05;

/**
 * Whether a dose entered is less than the settled band's lowest dose for
 * this tree (or one palm), allowing for the 5% the suggestion rounds down.
 */
export function doseUnderLabel(rate, trunkInches, amount, unit, pickKey) {
  const band = injectionBand(rate, trunkInches, pickKey);
  const inches = rate.basis === "palm" ? 1 : Number(trunkInches);
  const n = Number(amount);
  if (!band || !(inches > 0) || !(n > 0)) return false;
  const flOz = unit === "tsp" ? n / TSP_PER_FL_OZ : n;
  return flOz * ML_PER_FL_OZ < band.low * inches * (1 - UNDER_LABEL_TOLERANCE) * (1 - 1e-9);
}

/**
 * Whether a dose entered is more than the label allows for this tree (or one
 * palm), against the exact limit rather than the rounded range shown: the
 * band's limit once it is settled, else the label's highest rate.
 */
export function doseOverLabel(rate, trunkInches, amount, unit, pickKey) {
  const inches = rate.basis === "palm" ? 1 : Number(trunkInches);
  const n = Number(amount);
  if (!(inches > 0) || !(n > 0)) return false;
  const limit = injectionBand(rate, trunkInches, pickKey)?.high ?? rate.high;
  const flOz = unit === "tsp" ? n / TSP_PER_FL_OZ : n;
  return flOz * ML_PER_FL_OZ > limit * inches * (1 + 1e-9);
}

const FRACTIONS = { "⅛": 0.125, "¼": 0.25, "⅜": 0.375, "½": 0.5, "⅝": 0.625, "¾": 0.75, "⅞": 0.875 };
const UNIT_WORDS = [
  [/^(tsp|teaspoons?)$/, "tsp"],
  [/^(fl\.?\s*oz\.?|floz|fluid\s+ounces?|oz\.?|ounces?)$/, "fl_oz"],
];

// A typed quantity: "2", "1.5", or "2." / "." / ".5" while typing (kept as
// typed, so a dot is never lost mid-entry), or a fraction a dose typed before
// this form may hold: "½", "1½", "1 1/2".
export function quantityOf(text) {
  const t = text.trim();
  if (/^(\d+\.?\d*|\.\d*)$/.test(t)) return t;
  let match = /^(?:(\d+)\s*)?([⅛¼⅜½⅝¾⅞])$/.exec(t);
  if (match) return String(Number(match[1] || 0) + FRACTIONS[match[2]]);
  match = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(t);
  if (match && Number(match[3]) > 0) {
    return String(Math.round((Number(match[1] || 0) + Number(match[2]) / Number(match[3])) * 10000) / 10000);
  }
  return "";
}

/**
 * A stored dose as { amount, unit } ("1 fl oz", "1.5 tsp", "½ fl oz", "2
 * teaspoons"); a dose that is not a number of tsp or fl oz (such as "20 mL")
 * reads empty, for the tech to enter again.
 */
export function parseDose(text) {
  const match = /^\s*(.*?)\s*([a-z][a-z.\s]*)$/i.exec(String(text || ""));
  if (!match) return { amount: "", unit: "" };
  const amount = quantityOf(match[1]);
  const words = match[2].trim().toLowerCase();
  const unit = UNIT_WORDS.find(([pattern]) => pattern.test(words))?.[1] || "";
  return amount && unit ? { amount, unit } : { amount: "", unit: "" };
}

/** The dose as the record stores it: "1 fl oz", "1.5 tsp"; blank with no amount. */
export function doseText(amount, unit) {
  const n = String(amount ?? "").trim();
  if (!n) return "";
  return `${n} ${unit === "tsp" ? "tsp" : "fl oz"}`;
}

/**
 * The trunk size the record stores ("10 in DBH") as the number of inches
 * ("10"). Only a bare number or a number in inches reads; a size in another
 * unit ("30 cm DBH"), or a size class, reads empty for the tech to enter in
 * inches.
 */
export function trunkInchesText(sizeClassOrDbh) {
  const match = /^\s*(\d+\.?\d*|\.\d+)\s*(?:(?:in\.?|inch(?:es)?|")\s*(?:dbh)?|dbh)?\s*$/i.exec(String(sizeClassOrDbh || ""));
  return match ? match[1] : "";
}

/**
 * What the injection record shows for a record and this visit's injection
 * products: the chosen product's label rate, the band (by the tech's pick,
 * saved for this product, or by the trunk), the trunk in inches, the dose
 * for the tree, the dose entered, and the saved values the form cannot read.
 */
export function injectionRecordView(record = {}, injectionProducts = []) {
  const chosen =
    (record.productId && injectionProducts.find((product) => product.productId && String(product.productId) === String(record.productId))) ||
    injectionProducts.find((product) => product.name === record.product) ||
    null;
  const rate = chosen?.rate || null;
  const pickKey = record.labelBand?.product === record.product ? record.labelBand?.key || "" : "";
  // Per inch or per palm, from the label's unit even when its rate does not
  // read as a liquid (Arbor-OTC in grams).
  const basis = chosen?.basis || rate?.basis || null;
  const sizeText = String(record.sizeClassOrDbh || "").trim();
  const trunkInches = trunkInchesText(sizeText);
  const dose = parseDose(record.dose);
  const doseSaved = String(record.dose || "").trim();
  return {
    chosen,
    rate,
    pickKey,
    basis,
    trunkInches,
    band: rate ? injectionBand(rate, trunkInches, pickKey) : null,
    doseRange: rate ? injectionDoseText(rate, trunkInches, pickKey) : null,
    dose,
    // A saved size that is not in inches ("30 cm DBH") or a saved dose that
    // is not tsp or fl oz: shown, to enter again, never read as something else.
    unreadableTrunk: basis === "inch" && sizeText && !trunkInches ? sizeText : "",
    unreadableDose: doseSaved && !dose.amount ? doseSaved : "",
    overLabel: (unit) => Boolean(rate) && doseOverLabel(rate, trunkInches, dose.amount, unit, pickKey),
    underLabel: (unit) => Boolean(rate) && doseUnderLabel(rate, trunkInches, dose.amount, unit, pickKey),
  };
}

/**
 * The record naming another product, by name and (for one of this visit's
 * catalog products) catalog id. A dose, a band, or a field the band set
 * (clearField: the palm size or target pest the old label's band wrote)
 * belongs to the product it was worked out for, so a new product starts
 * without them. The size also starts over when the new label measures
 * another way (clearSize: a trunk for a palm label, or a palm size for a
 * per-inch one); otherwise the trunk measured stays.
 */
export function recordForProduct(record = {}, product, { productAuto = false, productId = null, clearField = null, clearSize = false } = {}) {
  if (product === record.product) return { ...record, productAuto, productId: productId ?? record.productId ?? null };
  return {
    ...record,
    product,
    productId,
    productAuto,
    dose: "",
    labelBand: null,
    ...(clearField ? { [clearField]: "" } : {}),
    ...(clearSize ? { sizeClassOrDbh: "" } : {}),
  };
}

/** What the tech is typing, while the record still holds what it stored. */
export function typedDraft(typed, saved) {
  return typed && typed.stored === String(saved || "") ? typed.typed : null;
}

/**
 * The record with the band the tech picked. A band that answers one of the
 * record's own fields (recordsAs: Palm-jet's palm size, IMA-jet's target
 * pest) writes that field too: never a second answer that can disagree.
 */
export function recordWithBand(record = {}, rate, key) {
  const labelBand = { product: record.product, key };
  const answer = rate?.recordsAs ? rate.bands?.find((band) => band.key === key)?.label : null;
  return { ...record, labelBand, ...(answer ? { [rate.recordsAs]: answer } : {}) };
}

/** The record field a label's band answers, and how the form names it. */
export const BAND_FIELD_NAMES = { sizeClassOrDbh: "Palm size", targetIssue: "Target issue" };
