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

const ML_PER_FL_OZ = 29.5735;

/** The units a dose is entered in. */
export const DOSE_UNITS = [
  { value: "tsp", label: "tsp" },
  { value: "fl_oz", label: "fl oz" },
];

// The label's own bands (owner ruling 2026-10-01, #5361): the catalog keeps
// one display range per injectable, but each label splits it by trunk size,
// palm size, target pest or season. Figures are mL per inch of trunk (or per
// palm), cited from the catalog rows' label notes in
// server/models/migrations/20260816000010_catalog_per_basis_rate_render.js.
// A band picked by trunk size has minInches/maxInches (max exclusive); the
// other bands are the tech's pick. An injectable with no row here gets no
// worked-out dose: the record shows the label line only.
export const INJECTION_LABEL_BANDS = [
  {
    // IMA-jet 10, EPA 74578-6.
    match: /\bima[\s-]*jet[\s-]*10\b/i,
    basis: "inch",
    pick: "Label rate",
    bands: [
      { key: "low", label: "Low rate", low: 1, high: 2 },
      { key: "high", label: "Larger tree or heavier pressure", low: 3, high: 6 },
    ],
  },
  {
    // IMA-jet, EPA 74578-1.
    match: /\bima[\s-]*jet\b(?![\s-]*10\b)/i,
    basis: "inch",
    pick: "Target pest",
    bands: [
      { key: "aphids_scales", label: "Aphids or scales", low: 2, high: 4 },
      { key: "borers", label: "Borers (EAB)", low: 4, high: 8 },
    ],
  },
  {
    // PHOSPHO-jet, EPA 74578-3: 3.5 under 12 in, up to 7 for larger trees.
    match: /\bphospho[\s-]*jet\b/i,
    basis: "inch",
    bands: [
      { key: "under_12", label: "Under 12 in", maxInches: 12, low: 3.5, high: 3.5 },
      { key: "12_up", label: "12 in and up", minInches: 12, low: 3.5, high: 7 },
    ],
  },
  {
    // Propizol micro-injection use rate table, EPA 74578-8.
    match: /\bpropizol\b/i,
    basis: "inch",
    bands: [{ key: "label", label: "Label rate", low: 10, high: 20 }],
  },
  {
    // Mn-jet Fe label insert.
    match: /\bmn[\s-]*jet\b/i,
    basis: "inch",
    pick: "Season",
    bands: [
      { key: "low", label: "Low rate", low: 5, high: 5 },
      { key: "late_season", label: "Late summer or fall", low: 10, high: 15 },
    ],
  },
  {
    // PALM-jet Mg palm rates table.
    match: /\bpalm[\s-]*jet\b/i,
    basis: "palm",
    pick: "Palm size",
    bands: [
      { key: "small", label: "Small palm", low: 5, high: 10 },
      { key: "medium", label: "Medium palm", low: 10, high: 20 },
      { key: "large", label: "Large palm", low: 20, high: 30 },
    ],
  },
];

/**
 * A catalog label's injection rate: { low, high, basis, bands, pick } in mL
 * per inch of trunk (basis "inch") or per palm (basis "palm"); null for any
 * other label. `bands` is the label's band table (null when the product has
 * none, or when its catalog unit does not match the table's basis); `pick`
 * names the choice the tech makes between bands (null when trunk size picks).
 */
function labelBasis(unit) {
  if (!isMlUnit(unit)) return null;
  const per = unit.split("/").slice(1).join("/").trim().toLowerCase();
  if (/^(inch|in\b)/.test(per)) return "inch";
  return /^palm/.test(per) ? "palm" : null;
}

export function injectionLabelRate(product) {
  const basis = labelBasis(String(product?.default_unit ?? product?.defaultUnit ?? ""));
  if (!basis) return null;
  const bounds = String(product?.default_rate ?? product?.defaultRate ?? "")
    .split(/\s*(?:-|–|to)\s*/)
    .map(Number);
  if (bounds.length > 2 || bounds.some((n) => !(n > 0))) return null;
  const [low, high = low] = bounds.sort((a, b) => a - b);
  const name = String(product?.name ?? "");
  const table = INJECTION_LABEL_BANDS.find((row) => row.match.test(name) && row.basis === basis) || null;
  return { low, high, basis, bands: table ? table.bands : null, pick: table?.pick || null };
}

/**
 * The band that applies: by trunk size, or the tech's pick (the only band
 * when there is one); null until a trunk size or a pick settles it.
 */
export function injectionBand(rate, trunkInches, pickKey) {
  const bands = rate?.bands;
  if (!bands) return null;
  if (bands.length === 1) return bands[0];
  if (bands.some((band) => band.minInches != null || band.maxInches != null)) {
    const inches = Number(trunkInches);
    if (!(inches > 0)) return null;
    return bands.find((band) => !(inches < (band.minInches ?? 0)) && !(inches >= (band.maxInches ?? Infinity))) || null;
  }
  return bands.find((band) => band.key === pickKey) || null;
}

// A single-rate dose in the truck's measures, never more than 5% under it
// (the job card's spoon tolerance): a spoon or a quarter fl oz at or just
// under the dose when one is that close, else the exact fl oz, cut (never
// rounded up) to hundredths.
const FIXED_DOSE_TOLERANCE = 0.05;
function fixedDoseText(ml) {
  const flOz = ml / ML_PER_FL_OZ;
  if (flOz < 1) return formatMeasuredAmount(ml, "ml");
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
