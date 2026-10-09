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
// the schedule feed sets `areaAddOnRowsAttached` and lists the add-ons in
// `areaAddOns`). The lightweight completion shortcuts (pest report flow, lawn /
// re-service / Tree & Shrub Fast Complete, the voice fill) record no add-on product
// or treated area, so a visit like that stays off them. This is the SHORTCUT rule
// only: which completion form a visit takes is isAreaAddOnVisit (below).
export function carriesAreaAddOnWork(service) {
  return isAreaAddOnVisit(service) || service?.areaAddOnRowsAttached === true;
}

// The add-on that IS the visit is lawn-family (everything except the web sweep,
// which is pest control): its generic form asks for the treated square feet on a
// broadcast or granular product ("Fire Ant Yard Treatment" reads as pest).
const WEB_SWEEP_KEY = "area_addon_web_sweep";
export function isChemicalAreaAddOnKey(key) {
  return isAreaAddOnServiceKey(key) && key !== WEB_SWEEP_KEY;
}
function isChemicalAreaAddOnVisit(service) {
  return [service?.completionProfile?.serviceKey, service?.serviceKey, service?.service_key_snapshot]
    .some(isChemicalAreaAddOnKey);
}

// Only an appointment whose own service is an area add-on takes the generic
// lane. A normal pest or lawn visit with add-on rows attached keeps its own full
// completion form and gains the add-on fields beside it (AreaAddOnFields).
export const LAWN_AREA_SERVICE_TYPE = "Lawn Care";

// The add-ons ATTACHED to the visit as rows, each of which gets product fields beside the
// visit's own form: [] for a visit with none attached. A visit whose own service is a chemical
// add-on records that add-on in its generic product list (an untagged row is the visit's own);
// every other add-on on it, like every add-on on a pest or lawn host, is recorded here.
export function hostAreaAddOns(service) {
  if (!Array.isArray(service?.areaAddOns)) return [];
  return service.areaAddOns.filter((addOn) => isAreaAddOnServiceKey(addOn?.key));
}

// The service type a product row's application method and area requirement are
// judged by. A row recorded for a chemical add-on (tagged `areaAddOnKey`) is
// lawn-family work whatever line the visit is; an untagged row on a visit whose own
// service is a chemical add-on is the same; every other row follows the visit.
export function areaAddOnRowServiceType(service, ownServiceType, row) {
  const lawnFamily = row?.areaAddOnKey ? isChemicalAreaAddOnKey(row.areaAddOnKey) : isAreaAddOnVisit(service) && isChemicalAreaAddOnVisit(service);
  return lawnFamily ? LAWN_AREA_SERVICE_TYPE : ownServiceType;
}

// The add-on a product row belongs to, or null: its tag when it has one (it must be attached to the
// visit), else the visit's own add-on when the visit IS a chemical add-on. `governed` is the server's
// governed rate for it (the schedule feed: protocols.json area_addon), or null when the feed carried none.
export function addOnForRow(service, row) {
  if (row?.areaAddOnKey) {
    const attached = hostAreaAddOns(service).find((addOn) => addOn.key === row.areaAddOnKey);
    return attached ? { key: attached.key, governed: attached.governed || null } : null;
  }
  const ownKey = [service?.completionProfile?.serviceKey, service?.serviceKey, service?.service_key_snapshot].find(isChemicalAreaAddOnKey);
  return ownKey ? { key: ownKey, governed: service?.areaAddOnOwn?.key === ownKey ? service.areaAddOnOwn.governed || null : null } : null;
}

// Is this catalog product the add-on's governed product? By the ID the feed carries (`governed.productId`), never by name.
export function isGovernedProduct(governed, product) {
  return governed?.productId != null && product?.id != null && String(governed.productId) === String(product.id);
}

// "0.147 oz per 1,000 sq ft" for the governed rate shown beside an add-on, or null when there is none.
export function governedRateText(governed) {
  const rate = Number(governed?.ratePer1000);
  if (!(rate > 0) || governed?.withheld) return null;
  return `${rate} ${String(governed.rateUnit || "").replace("_", " ")} per 1,000 sq ft`;
}

// A product row built for an area add-on, with the GOVERNED rate in place of the catalog's default rate
// (Arena 0.29 oz and Acelepryn 0.05 fl oz per 1,000 sq ft are not the add-on rates: 0.147 and 0.184). The
// row prefills the governed rate and unit, and the governed rate is its ceiling for the existing high-rate
// review. Only the add-on's own product has a governed rate, found by the catalog ID the server resolved (never the
// name: a product renamed in the Service Library is still the same product): any other product on the row, a rate the
// server holds back (unverified label, wrong grass), a product the server could not resolve or a feed that carried none
// starts with NO rate, never the catalog default. A row that belongs to no add-on comes back unchanged.
export function withGovernedAddOnRate(service, product, row) {
  const addOn = addOnForRow(service, product);
  if (!addOn) return row;
  const governed = addOn.governed;
  const applies = governed && !governed.withheld && isGovernedProduct(governed, product);
  const rate = applies ? Number(governed.ratePer1000) : "";
  const unit = applies ? governed.rateUnit : row.rateUnit;
  return {
    ...row,
    rate,
    rateUnit: unit,
    amountUnit: applies ? unit : row.amountUnit,
    catalogRateUnit: applies ? unit : row.catalogRateUnit,
    maxLabelRatePer1000: applies ? rate : null,
    // The amount from the treated area, at the governed rate (the shared rate x sq ft / 1,000 rule).
    totalAmount: applies && row.areaUnit === "sqft" && Number(row.areaValue) > 0 ? Math.round(rate * (Number(row.areaValue) / 1000) * 100) / 100 : "",
  };
}

// Does a product row record a chemical add-on (the server tags it and the closeout counts it)? A row tagged with a
// chemical add-on does; so does an untagged row on a visit whose own service is a chemical add-on.
export function isAddOnRecordRow(service, row) {
  return row?.areaAddOnKey ? isChemicalAreaAddOnKey(row.areaAddOnKey) : isChemicalAreaAddOnVisit(service);
}

// A per-gallon mix concentration ("oz/gal") has no treated area to multiply by, so its total amount is typed.
const hasAreaBasis = (unit) => !String(unit || "").includes("/") || /\/(1000sf|acre)$/i.test(String(unit));

// The fields an add-on's application row still lacks. The server refuses the completion without them (the row is that
// add-on's application record), so the form asks first: a positive rate with its unit, the treated square feet, and
// a total amount (filled from the rate and area unless the unit is a per-gallon mix).
export function missingAddOnActuals(row) {
  const positive = (value) => value !== "" && value != null && Number(value) > 0;
  const missing = [];
  if (!positive(row?.rate)) missing.push("application rate");
  else if (!String(row?.rateUnit || "").trim()) missing.push("rate unit");
  if (!(positive(row?.areaValue) && row?.areaUnit === "sqft")) missing.push("treated square feet");
  if (!missing.length && !positive(row?.totalAmount) && !hasAreaBasis(row?.rateUnit)) missing.push("total amount");
  return missing;
}

// The first add-on row that cannot be saved yet, as the sentence to show, or null.
export function addOnActualsProblem(service, rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isAddOnRecordRow(service, row)) continue;
    const missing = missingAddOnActuals(row);
    if (!missing.length) continue;
    const key = row.areaAddOnKey || addOnForRow(service, row)?.key;
    const name = hostAreaAddOns(service).find((addOn) => addOn.key === key)?.name || "Area";
    return `${name} add-on: enter the ${missing.join(" and ")} for ${row.name || "the product"}, then complete the visit.`;
  }
  return null;
}

// What the estimate sold for an attached add-on, in plain words, or null (the web
// sweep has no area): "Sold: up to 2,000 sq ft of bed area".
export function soldAreaText(addOn) {
  const tier = Number(addOn?.tierSqFt);
  const area = Number(addOn?.areaSqFt);
  const label = addOn?.areaLabel ? ` of ${addOn.areaLabel} area` : "";
  if (tier > 0) return `Sold: up to ${tier.toLocaleString("en-US")} sq ft${label}`;
  return area > 0 ? `Sold: about ${area.toLocaleString("en-US")} sq ft${label}` : null;
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
    // The server states the yearly limit in one sentence ("4 in 12 months, at least 60 days apart"); none for the web sweep.
    limitText: typeof item.limitText === "string" && item.limitText ? item.limitText : null,
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
