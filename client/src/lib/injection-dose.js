// client/src/lib/injection-dose.js
//
// Tree & Shrub injection doses in the truck's measures (owner ruling
// 2026-09-29: an injection is measured in tsp or fl oz like everything else,
// never mL). A trunk-injection label in the catalog gives its rate in mL per
// inch of trunk (DBH) or per palm: the Arborjet injectables. The injection
// record shows that rate through the job card's spoon-and-cup formatter
// (lib/mix-amount.js), rounded inside the label; the dose itself is entered
// as a number of tsp or fl oz.
import { formatMeasuredAmount, formatMeasuredRange } from "./mix-amount";
import { isMlUnit } from "./measure-units";

const ML_PER_FL_OZ = 29.5735;

/** The units a dose is entered in. */
export const DOSE_UNITS = [
  { value: "tsp", label: "tsp" },
  { value: "fl_oz", label: "fl oz" },
];

function labelBasis(unit) {
  if (!isMlUnit(unit)) return null;
  const per = unit.split("/").slice(1).join("/").trim().toLowerCase();
  if (/^(inch|in\b)/.test(per)) return "inch";
  return /^palm/.test(per) ? "palm" : null;
}

/**
 * A catalog label's injection rate: { low, high, basis } in mL per inch of
 * trunk (basis "inch") or per palm (basis "palm"); null for any other label.
 */
export function injectionLabelRate(product) {
  const basis = labelBasis(String(product?.default_unit ?? product?.defaultUnit ?? ""));
  if (!basis) return null;
  const bounds = String(product?.default_rate ?? product?.defaultRate ?? "")
    .split(/\s*(?:-|–|to)\s*/)
    .map(Number);
  if (bounds.length > 2 || bounds.some((n) => !(n > 0))) return null;
  const [low, high = low] = bounds.sort((a, b) => a - b);
  return { low, high, basis };
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

/** The label's rate as the tech reads it: "¼ – 1 tsp per inch of trunk". */
export function injectionLabelText(rate) {
  return `${rangeText(rate.low, rate.high)} ${basisText(rate.basis)}`;
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
 * products: the chosen product (by catalog id, else by name) and its label
 * rate, the trunk in inches, the dose entered, and the saved values the form
 * cannot read.
 */
export function injectionRecordView(record = {}, injectionProducts = []) {
  const chosen =
    (record.productId && injectionProducts.find((product) => product.productId && String(product.productId) === String(record.productId))) ||
    injectionProducts.find((product) => product.name === record.product) ||
    null;
  const rate = chosen?.rate || null;
  const sizeText = String(record.sizeClassOrDbh || "").trim();
  const trunkInches = trunkInchesText(sizeText);
  const dose = parseDose(record.dose);
  const doseSaved = String(record.dose || "").trim();
  return {
    chosen,
    rate,
    trunkInches,
    dose,
    // A saved size that is not in inches ("30 cm DBH") or a saved dose that
    // is not tsp or fl oz: shown, to enter again, never read as something else.
    unreadableTrunk: rate?.basis === "inch" && sizeText && !trunkInches ? sizeText : "",
    unreadableDose: doseSaved && !dose.amount ? doseSaved : "",
  };
}

/**
 * The record naming another product, by name and (for one of this visit's
 * catalog products) catalog id. A dose belongs to the product it was entered
 * for, so a new product starts without one; the trunk measured stays.
 */
export function recordForProduct(record = {}, product, { productAuto = false, productId = null } = {}) {
  if (product === record.product) return { ...record, productAuto, productId: productId ?? record.productId ?? null };
  return { ...record, product, productId, productAuto, dose: "" };
}

/** What the tech is typing, while the record still holds what it stored. */
export function typedDraft(typed, saved) {
  return typed && typed.stored === String(saved || "") ? typed.typed : null;
}
