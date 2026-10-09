// Area add-on treatments (GATE_AREA_ADDONS) on the staff estimator.
//
// The server owns the table: GET /admin/pricing-config/lawn_pricing_v2 carries
// `areaAddOns = { enabled, visitContexts, items[] }`, and the screen reads names,
// tiers and limits from it. Nothing here hardcodes a price, a tier list or a
// display name. The only add-on keys named in this file are the three whose
// treated area the estimator already knows (the pre-fill rule, owner 2026-10-08).
//
// The form keeps two fields. `areaAddOns` is a map of add-on key to
// { areaSqFt: string, larger: boolean, grassType? }. A key that is present is a
// key that is selected. `grassType` exists only on an add-on whose price is
// bound to a grass (catalog `requiresGrassTrack`): "" until the rep chooses,
// never the form's default grass. `areaAddOnVisit` is the ONE visit choice for
// the whole group ("standalone" or "sameTripAddOn"): several add-ons are a
// single visit and the server charges one drive for it, so the visit is never
// chosen per add-on. `buildAreaAddOnRequest` and `areaAddOnOption` turn them
// into the `options.areaAddOns` list and `options.areaAddOnVisit` the
// calculate and save requests carry.

// An area add-on visit is generic one-time work (GATE_AREA_ADDONS). The tech
// completion screens decide that by the visit's catalog service key
// (`area_addon_<key>`), never by its name: "Lawn Insect Spot Treatment" reads as
// a lawn visit and "Fire Ant Yard Treatment" as a pest one, and neither takes the
// recurring lawn or pest completion form.
export const AREA_ADDON_KEY_PREFIX = "area_addon_";

export function isAreaAddOnServiceKey(serviceKey) {
  return typeof serviceKey === "string" && serviceKey.startsWith(AREA_ADDON_KEY_PREFIX);
}

// The visit's own catalog key: the completion profile's, else the schedule row's.
export function isAreaAddOnVisit(service) {
  return isAreaAddOnServiceKey(service?.completionProfile?.serviceKey)
    || isAreaAddOnServiceKey(service?.serviceKey)
    || isAreaAddOnServiceKey(service?.service_key_snapshot);
}

// A visit that carries area add-on work: it is an add-on itself, or it has an
// add-on attached as a row (a same-trip add-on rides a normal pest or lawn visit;
// the schedule feed sets `areaAddOnRowsAttached` and lists the catalog keys in
// `areaAddOnKeys`). The lightweight completion flows (pest report flow, lawn /
// re-service / Tree & Shrub Fast Complete) record no add-on product or treated
// area, so such a visit takes the generic form.
export function carriesAreaAddOnWork(service) {
  return isAreaAddOnVisit(service) || service?.areaAddOnRowsAttached === true;
}

// The visit applies a lawn-family add-on (everything except the web sweep, which
// is pest control): its own key when the add-on is the visit, else an attached
// row's. The generic form then asks for the treated area on a lawn product
// (a broadcast or granular fire-ant or pre-emergent pass is recorded by area),
// whatever line the host visit belongs to.
const WEB_SWEEP_KEY = "area_addon_web_sweep";
export function carriesLawnAreaAddOnWork(service) {
  const keys = [
    service?.completionProfile?.serviceKey, service?.serviceKey, service?.service_key_snapshot,
    ...(Array.isArray(service?.areaAddOnKeys) ? service.areaAddOnKeys : []),
  ];
  return keys.some((key) => isAreaAddOnServiceKey(key) && key !== WEB_SWEEP_KEY);
}

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
    ...(item.requiresGrassTrack ? { grassType: pickedGrass || "" } : {}),
  };
  if (!item.tiers) return base;
  const knownSqFt = positiveNumber(known?.sqft);
  const tier = knownSqFt === null ? item.tiers[0] : tierHolding(item.tiers, knownSqFt);
  const seeded = tier === null
    ? { areaSqFt: String(Math.ceil(knownSqFt)), larger: true }
    : { areaSqFt: String(tier), larger: false };
  // seedKnown / seedArea remember what the tier was seeded from, so a later
  // change of the known area can re-seed an entry the rep never touched
  // (reseedAddOnEntries). They are never sent: buildAreaAddOnRequest picks
  // key, area and grass only.
  return { ...base, ...seeded, seedKnown: knownSqFt === null ? null : Math.round(knownSqFt), seedArea: seeded.areaSqFt };
}

// The selection with every untouched, pre-filled entry re-seeded from the
// known areas as they are now. A property lookup that reruns (or a scope
// answer) replaces the measurements; an entry seeded from the old ones would
// keep the old property's tier beside a hint that shows the new area. An entry
// whose tier the rep changed is the rep's choice and stays. Returns the SAME
// object when nothing changes.
export function reseedAddOnEntries(selection, catalog, knownAreas) {
  if (!isPlainObject(selection)) return selection;
  const items = new Map((catalog?.items || []).map((item) => [item.key, item]));
  let changed = false;
  const next = {};
  for (const [key, entry] of Object.entries(selection)) {
    const item = items.get(key);
    const known = knownAreaFor(key, knownAreas);
    const nowKnown = positiveNumber(known?.sqft) === null ? null : Math.round(known.sqft);
    const untouched = isPlainObject(entry) && item?.tiers && "seedArea" in entry && entry.areaSqFt === entry.seedArea;
    if (!untouched || nowKnown === entry.seedKnown) {
      next[key] = entry;
    } else {
      next[key] = { ...newAddOnEntry(item, known), ...("grassType" in entry ? { grassType: entry.grassType } : {}) };
      changed = true;
    }
  }
  return changed ? next : selection;
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
      ...(grassBound.has(key) || (isPlainObject(entry) && "grassType" in entry) ? { grassType: chosenGrass || UNKNOWN_GRASS } : {}),
    };
  });
}

// The group's visit as the request carries it: anything but the same-visit
// choice is the add-ons' own visit.
export function normalizeAreaAddOnVisit(visit) {
  return visit === SAME_VISIT ? SAME_VISIT : STANDALONE_VISIT;
}

// Spread into the request options: `{}` when nothing is selected. The visit
// goes out once, beside the list, never inside an entry.
export function areaAddOnOption(selection, catalog = null, visit = STANDALONE_VISIT) {
  const areaAddOns = buildAreaAddOnRequest(selection, catalog);
  return areaAddOns ? { areaAddOns, areaAddOnVisit: normalizeAreaAddOnVisit(visit) } : {};
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
      // The sent "unknown" reads back as "not chosen yet".
      ...("grassType" in entry ? { grassType: entry.grassType === UNKNOWN_GRASS ? "" : String(entry.grassType ?? "") } : {}),
    };
  }
  return selection;
}

// What a reopened estimate shows: the form snapshot it saved, else the list
// its stored engine request carried. A per-add-on visitContext (written before
// the visit became one group choice) is dropped from the entries here; the
// group visit is read by savedAreaAddOnVisit.
export function savedAreaAddOns(editSource) {
  const fromInputs = editSource?.inputs?.areaAddOns;
  if (isPlainObject(fromInputs) && Object.keys(fromInputs).length > 0) {
    return Object.fromEntries(Object.entries(fromInputs).map(([key, entry]) => {
      if (!isPlainObject(entry)) return [key, entry];
      const { visitContext: _legacyVisit, ...rest } = entry;
      return [key, rest];
    }));
  }
  return selectionFromRequest(editSource?.engineRequest?.options?.areaAddOns);
}

// The group visit a reopened estimate shows: the saved form field, else the
// stored request's, else (an estimate saved with a visit on each add-on) the
// same-visit choice only when every add-on had it.
export function savedAreaAddOnVisit(editSource) {
  const saved = editSource?.inputs?.areaAddOnVisit ?? editSource?.engineRequest?.options?.areaAddOnVisit;
  if (saved !== undefined && saved !== null) return normalizeAreaAddOnVisit(saved);
  const entries = [
    ...Object.values(isPlainObject(editSource?.inputs?.areaAddOns) ? editSource.inputs.areaAddOns : {}),
    ...(Array.isArray(editSource?.engineRequest?.options?.areaAddOns) ? editSource.engineRequest.options.areaAddOns : []),
  ].filter(isPlainObject);
  return entries.length > 0 && entries.every((entry) => entry.visitContext === SAME_VISIT) ? SAME_VISIT : STANDALONE_VISIT;
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
// rides on; every other row keeps its own label. On an own visit the add-ons
// share one trip: only the row that carries the drive is plain "Own visit".
export function areaAddOnRowLabel(item, fallback) {
  if (item?.service !== "area_addon") return fallback;
  if (item.visitContext === SAME_VISIT) return "Same visit";
  return item.carriesVisitDrive === false ? "Own visit, with the other add-ons" : "Own visit";
}

// The staff preview reads the same unit the customer does: an add-on's price is one application.
export function isAreaAddOnPricedPerApplication(item) {
  return item?.service === "area_addon" || item?.priceUnit === "application";
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
