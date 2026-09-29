// client/src/lib/injection-dose.js
//
// Tree & Shrub injection doses in the truck's measures (owner ruling
// 2026-09-29: an injection is measured in tsp or fl oz like everything else,
// never mL). A trunk-injection label in the catalog gives its rate in mL per
// inch of trunk (DBH) or per palm: the Arborjet injectables. The injection
// record shows that rate, and the dose for the tree measured, through the job
// card's spoon-and-cup formatter (lib/mix-amount.js), rounded inside the
// label; the dose itself is entered as a number of tsp or fl oz.
import { formatMeasuredRange } from "./mix-amount";
import { TSP_PER_FL_OZ, isMlUnit } from "./measure-units";

const ML_PER_FL_OZ = 29.5735;

/** The units a dose is entered in. */
export const DOSE_UNITS = [
  { value: "tsp", label: "tsp" },
  { value: "fl_oz", label: "fl oz" },
];

/**
 * A catalog label's injection rate: { low, high, basis } in mL per inch of
 * trunk (basis "inch") or per palm (basis "palm"); null for any other label.
 */
export function injectionLabelRate(product) {
  const unit = String(product?.default_unit ?? product?.defaultUnit ?? "");
  if (!isMlUnit(unit)) return null;
  const basisText = unit.split("/").slice(1).join("/").trim().toLowerCase();
  const basis = /^(inch|in\b)/.test(basisText) ? "inch" : /^palm/.test(basisText) ? "palm" : null;
  if (!basis) return null;
  const bounds = String(product?.default_rate ?? product?.defaultRate ?? "")
    .split(/\s*(?:-|–|to)\s*/)
    .map(Number);
  if (bounds.length > 2 || bounds.some((n) => !(n > 0))) return null;
  const [low, high = low] = bounds.sort((a, b) => a - b);
  return { low, high, basis };
}

// An mL range in spoons or ounces, rounded inside it (the job card's truck
// measures); "½ fl oz – 2 fl oz" reads "½ – 2 fl oz" when both ends share a
// unit.
function rangeText(lowMl, highMl) {
  const text = formatMeasuredRange(lowMl, highMl, "ml", { truckMeasures: true });
  const shared = /^(.+?) (tsp|fl oz) – (.+?) \2$/.exec(text || "");
  return shared ? `${shared[1]} – ${shared[3]} ${shared[2]}` : text;
}

/** The label's rate as the tech reads it: "¼ – 1 tsp per inch of trunk". */
export function injectionLabelText(rate) {
  return `${rangeText(rate.low, rate.high)} ${rate.basis === "palm" ? "per palm" : "per inch of trunk"}`;
}

/**
 * The dose for this tree ("½ – 2 fl oz"): the rate times the trunk's inches,
 * or the per-palm rate; null while a per-inch label has no trunk size.
 */
export function injectionDoseText(rate, trunkInches) {
  if (rate.basis === "palm") return rangeText(rate.low, rate.high);
  const inches = Number(trunkInches);
  if (!(inches > 0)) return null;
  return rangeText(rate.low * inches, rate.high * inches);
}

/**
 * Whether a dose entered is more than the label allows for this tree (or one
 * palm), against the label's exact limit rather than the rounded range shown.
 */
export function doseOverLabel(rate, trunkInches, amount, unit) {
  const inches = rate.basis === "palm" ? 1 : Number(trunkInches);
  const n = Number(amount);
  if (!(inches > 0) || !(n > 0)) return false;
  const flOz = unit === "tsp" ? n / TSP_PER_FL_OZ : n;
  return flOz * ML_PER_FL_OZ > rate.high * inches * (1 + 1e-9);
}

const FRACTIONS = { "⅛": 0.125, "¼": 0.25, "⅜": 0.375, "½": 0.5, "⅝": 0.625, "¾": 0.75, "⅞": 0.875 };
const UNIT_WORDS = [
  [/^(tsp|teaspoons?)$/, "tsp"],
  [/^(fl\.?\s*oz\.?|floz|fluid\s+ounces?|oz\.?|ounces?)$/, "fl_oz"],
];

// A typed quantity: "2", "1.5", or "2." / "." / ".5" while typing (kept as
// typed, so a dot is never lost mid-entry), or a fraction a dose typed before
// this form may hold: "½", "1½", "1 1/2".
function quantityOf(text) {
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

/** The trunk size the record stores ("10 in DBH") as the number typed ("10"). */
export function trunkInchesText(sizeClassOrDbh) {
  return (/^\s*(\d+\.?\d*|\.\d+)/.exec(String(sizeClassOrDbh || "")) || [])[1] || "";
}
