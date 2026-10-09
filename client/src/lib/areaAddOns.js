// Area add-on treatments (GATE_AREA_ADDONS) on the staff estimator.
//
// The server owns the table: GET /admin/pricing-config/lawn_pricing_v2 carries
// `areaAddOns = { enabled, visitContexts, items[] }`, and the screen reads names,
// tiers and limits from it. Nothing here hardcodes a price, a tier list or a
// display name. The only add-on keys named in this file are the three whose
// treated area the estimator already knows (the pre-fill rule, owner 2026-10-08).
//
// The form keeps one field, `areaAddOns`: a map of add-on key to
// { areaSqFt: string, larger: boolean, visitContext, grassType? }. A key that is
// present is a key that is selected. `grassType` exists only on an add-on whose
// price is bound to a grass (catalog `requiresGrassTrack`): "" until the rep
// chooses, never the form's default grass. `buildAreaAddOnRequest` turns it into the
// `options.areaAddOns` list the calculate and save requests carry.

export const STANDALONE_VISIT = "standalone";
export const SAME_VISIT = "sameTripAddOn";
export const LARGER_TIER = "larger";

// Where each pre-fillable add-on reads its known area from. The two judgment
// add-ons (lawn insect spot, hardscape weed) are not listed: the treated area
// is the rep's call, so they start at the smallest tier.
const PREFILL_SOURCE = {
  bed_pre_emergent: "bed",
  fire_ant_yard: "lawn",
  lawn_insect_preventive: "lawn",
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A positive number from a number or a numeric string; anything else is null.
function positiveNumber(value) {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeCatalogItem(item) {
  const tiers = Array.isArray(item.tiers)
    ? item.tiers.map(positiveNumber).filter((tier) => tier !== null).sort((a, b) => a - b)
    : [];
  return {
    key: item.key,
    name: item.name,
    areaLabel: typeof item.areaLabel === "string" ? item.areaLabel : null,
    tiers: tiers.length > 0 ? tiers : null,
    maxPerYear: positiveNumber(item.maxPerYear),
    requiresGrassTrack: typeof item.requiresGrassTrack === "string" ? item.requiresGrassTrack : null,
  };
}

// The catalog from the lawn_pricing_v2 read. Fail closed: a missing field, an
// older server or a failed read is "not enabled, no items".
export function readAreaAddOnCatalog(row) {
  const block = row?.areaAddOns;
  const items = Array.isArray(block?.items)
    ? block.items
      .filter((item) => isPlainObject(item) && typeof item.key === "string" && typeof item.name === "string")
      .map(normalizeCatalogItem)
    : [];
  return { enabled: block?.enabled === true && items.length > 0, items };
}

export function countAreaAddOns(selection) {
  return isPlainObject(selection) ? Object.keys(selection).length : 0;
}

// An estimate whose only selection is area add-ons: it prices with no home or
// lot size (a web sweep takes no area; a tiered add-on carries its own treated
// area), so the footprint gate lets it through.
export function isAreaAddOnOnly(selectedServices, selection) {
  return Array.isArray(selectedServices) && selectedServices.length === 0 && countAreaAddOns(selection) > 0;
}

// The smallest tier that holds the area, or null when the area is above the
// largest tier.
export function tierHolding(tiers, area) {
  return tiers.find((tier) => area <= tier) ?? null;
}

// The area the estimator already knows for this add-on, or null.
// knownAreas = { bed: { sqft, source } | null, lawn: { sqft, source } | null }.
export function knownAreaFor(key, knownAreas) {
  const source = PREFILL_SOURCE[key];
  return source ? knownAreas?.[source] ?? null : null;
}

// The value a grass-bound add-on sends until the rep chooses a grass: the
// server prices a missing or unknown grass as a custom quote, never as the
// estimate's default grass.
export const UNKNOWN_GRASS = "unknown";

// The grass the rep chose on the screen: the form's grass once the rep has
// edited that field (`_manualFields` records every edit), else null. The
// untouched default grass is never a choice.
export function pickedGrass(form, grassChoices) {
  return form?._manualFields?.includes("grassType") && grassChoices.some((grass) => grass.value === form.grassType)
    ? form.grassType
    : null;
}

// The entry created when a row is first checked. `pickedGrass` is a grass the
// rep chose elsewhere on the screen (never the untouched default); a
// grass-bound add-on starts on it, else with no grass.
export function newAddOnEntry(item, known, pickedGrass = null) {
  const base = {
    visitContext: STANDALONE_VISIT,
    ...(item.requiresGrassTrack ? { grassType: pickedGrass || "" } : {}),
  };
  if (!item.tiers) return base;
  const knownSqFt = positiveNumber(known?.sqft);
  if (knownSqFt === null) return { ...base, areaSqFt: String(item.tiers[0]), larger: false };
  const tier = tierHolding(item.tiers, knownSqFt);
  return tier === null
    ? { ...base, areaSqFt: String(Math.ceil(knownSqFt)), larger: true }
    : { ...base, areaSqFt: String(tier), larger: false };
}

// The value the area select shows for an entry.
export function tierSelectValue(item, entry) {
  if (entry.larger === true) return LARGER_TIER;
  const area = positiveNumber(entry.areaSqFt);
  if (area === null) return "";
  const tier = tierHolding(item.tiers, area);
  return tier === null ? LARGER_TIER : String(tier);
}

// The entry after the rep picks an area choice. "Larger" keeps a real area
// above the largest tier (the known one, else what was already typed).
export function withTierChoice(item, entry, choice, known) {
  if (choice !== LARGER_TIER) return { ...entry, larger: false, areaSqFt: String(Number(choice)) };
  const largest = item.tiers[item.tiers.length - 1];
  const knownSqFt = positiveNumber(known?.sqft);
  const typed = positiveNumber(entry.areaSqFt);
  const keep = knownSqFt !== null && knownSqFt > largest ? Math.ceil(knownSqFt)
    : typed !== null && typed > largest ? typed : null;
  return { ...entry, larger: true, areaSqFt: keep === null ? "" : String(keep) };
}

// The `options.areaAddOns` list, or undefined when nothing is selected (the
// field is then left out of the request). One entry per key. An entry with no
// usable area sends none; the server then answers with its own message. A
// grass-bound add-on (the catalog says so, or its entry carries a grass) always
// sends its own grass: the rep's choice, else "unknown".
export function buildAreaAddOnRequest(selection, catalog = null) {
  if (!isPlainObject(selection)) return undefined;
  const entries = Object.entries(selection);
  if (entries.length === 0) return undefined;
  const grassBound = new Set((catalog?.items || []).filter((item) => item.requiresGrassTrack).map((item) => item.key));
  return entries.map(([key, entry]) => {
    const area = positiveNumber(entry?.areaSqFt);
    const chosenGrass = typeof entry?.grassType === "string" ? entry.grassType.trim() : "";
    return {
      key,
      ...(area === null ? {} : { areaSqFt: area }),
      visitContext: entry?.visitContext === SAME_VISIT ? SAME_VISIT : STANDALONE_VISIT,
      ...(grassBound.has(key) || (isPlainObject(entry) && "grassType" in entry) ? { grassType: chosenGrass || UNKNOWN_GRASS } : {}),
    };
  });
}

// Spread into the request options: `{}` when nothing is selected.
export function areaAddOnOption(selection, catalog = null) {
  const areaAddOns = buildAreaAddOnRequest(selection, catalog);
  return areaAddOns ? { areaAddOns } : {};
}

// A saved estimate's request list back into the form map.
export function selectionFromRequest(list) {
  if (!Array.isArray(list)) return {};
  const selection = {};
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.key !== "string" || entry.key === "") continue;
    const area = positiveNumber(entry.areaSqFt);
    selection[entry.key] = {
      ...(area === null ? {} : { areaSqFt: String(area) }),
      larger: false,
      visitContext: entry.visitContext === SAME_VISIT ? SAME_VISIT : STANDALONE_VISIT,
      // The sent "unknown" reads back as "not chosen yet".
      ...("grassType" in entry ? { grassType: entry.grassType === UNKNOWN_GRASS ? "" : String(entry.grassType ?? "") } : {}),
    };
  }
  return selection;
}

// What a reopened estimate shows: the form snapshot it saved, else the list
// its stored engine request carried.
export function savedAreaAddOns(editSource) {
  const fromInputs = editSource?.inputs?.areaAddOns;
  if (isPlainObject(fromInputs) && Object.keys(fromInputs).length > 0) return fromInputs;
  return selectionFromRequest(editSource?.engineRequest?.options?.areaAddOns);
}

// The known areas for the pre-fill, from what the form already uses.
// bed: the Bed Area box (manualFields says whether staff typed it); lawn: the
// Treatable Lawn Area the screen shows (turfSource is its "Confirmed" /
// "Using AI" / "Lot estimate" label).
const LAWN_SOURCE_TEXT = { Confirmed: "Confirmed lawn area", "Using AI": "Property lookup" };

export function buildKnownAreas({ bedSqFt, manualFields, lawnSqFt, turfSource }) {
  const bed = positiveNumber(bedSqFt);
  const lawn = positiveNumber(lawnSqFt);
  const bedEntered = Array.isArray(manualFields) && manualFields.includes("bedArea");
  return {
    bed: bed === null ? null : {
      sqft: Math.round(bed),
      source: bedEntered ? "Bed area entered" : "Property lookup",
      noun: "of beds",
      advice: "Change it if the beds are larger.",
    },
    lawn: lawn === null ? null : {
      sqft: Math.round(lawn),
      source: LAWN_SOURCE_TEXT[turfSource] || "Lot estimate",
      noun: "of lawn",
      advice: "Change it if the treated lawn is different.",
    },
  };
}

// The one-time card on the estimate preview: an add-on row says which visit it
// rides on; every other row keeps its own label.
export function areaAddOnRowLabel(item, fallback) {
  if (item?.service !== "area_addon") return fallback;
  return item.visitContext === SAME_VISIT ? "Same visit" : "Own visit";
}

// Add-ons carry no recurring-customer perk (the line says discountable: false).
export function recurringDiscountApplies(item) {
  return !item?.noRecurringDiscount && item?.discountable !== false;
}

// The client mirror (estimateEngine.js) has no add-on table: it refuses a
// request that carries add-ons instead of returning an estimate without them.
export function assertNoAreaAddOns(inputs) {
  if (Array.isArray(inputs?.areaAddOns) && inputs.areaAddOns.length > 0) {
    throw new Error("Area add-on pricing is server-only: use the server estimate endpoint.");
  }
}
