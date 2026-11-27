/**
 * procurement/weekly-buy-list.js — what to buy for one Monday-to-Saturday week.
 *
 * Owner 2026-11-27: "once a week look at upcoming appts, and buy for the entire
 * week, based on current inventory ... we are hiring a 2nd tech, this tech's
 * SiteOne location is the Sarasota branch, so ideally all purchases for him
 * would be based on this branch". The list is per technician, each with their
 * own supply store (technicians.supply_store). READ ONLY: it orders nothing and
 * writes nothing; weekly-buy-alert.js turns the result into admin alerts.
 *
 * Demand per booked visit (scheduled_services in the week that are not done,
 * cancelled, skipped, moved or no-show), grouped by technician_id:
 *   - lawn: the WaveGuard planner's own products, through
 *     buildWaveGuardInventoryForecast over the week's explicit date range. Each
 *     forecast appointment is mapped to its visit's technician.
 *   - pest house mix: the three-product tank mix every general-pest visit records
 *     (pest-house-mix.js, a tested copy of the client's mix). Taurus SC stays on a
 *     visit only where the home's yearly label limit leaves room, judged as the
 *     close-out judges it (taurus-yearly-count.js, one batched read, visits in date
 *     order); an unknown count leaves it off.
 *   - per-completion supplies (yard signs, stickers, stakes): one per booked visit
 *     of a line the product names, by the close-out's own rule (supplies-consumption
 *     noKitReason, fed by the visit's completion profile: an internal-only
 *     consultation leaves none, the WDO inspection project still leaves its notice).
 * Estimate-slot holds (customer_id NULL with a reservation stamp) are not bookings.
 * Visits of any other kind (roach, flea, bed bug, mosquito, rodent, tree and
 * shrub ...) are not planned; each technician's list says how many.
 *
 * Supply is products_catalog.inventory_on_hand plus what is already ordered and not
 * received (a request marked ordered, or an automatic order placing or placed and not
 * revoked; an open request with no order is not supply), one company-wide figure. With
 * two technicians drawing on it, stock goes to assigned technicians first (earliest
 * first visit, then id), then to visits with no technician. Short = need minus the stock
 * given to that technician. Packs are whole vendor packs, read the way the dispatcher
 * reads them (reorder-limit-suggestions: eligible price row, packFor, packReorder); each
 * line names the vendor that row is from, which may not be the technician's store.
 * Spare floor (a volume, not a container count: stock is one number, and nothing here can show
 * that a container is unopened): after the week's booked need, at least one full container's
 * worth of each everyday pest liquid (CrossCheck, Taurus) should remain. Remaining = on hand +
 * on order + the volume bought - the week's need; under one pack size, one more pack is bought.
 * N/P fertilizer is held June 1 - Sept 30 (fertilizer-blackout.js): listed, not bought.
 */
const db = require('../../models/db');
const { etParts, etWeekStart, etDateString, addETDays } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { calcLandedCost, parsePackCount } = require('../product-costing');
const { convertInventoryQuantity, normalizeInventoryUnit } = require('../inventory-units');
const { eligibleVendorPricing } = require('../vendor-pricing-eligibility');
const { packFor, packReorder, pickPriceRow } = require('./reorder-limit-suggestions');
const { fertilizerBlackoutHold, FERTILIZER_COLUMNS } = require('./fertilizer-blackout');
const { appliesToLine, noKitReason, serviceLinesInvalid, INSPECTION_SERVICE_RE } = require('../supplies-consumption');
const { detectServiceLine } = require('../service-report/service-line-configs');
const { isPestHouseMixVisit, resolveHouseMix, PEST_HOUSE_MIX } = require('./pest-house-mix');
const { projectTaurusEligibility } = require('../taurus-yearly-count');
const { RECEIVED_SETTLES_SQL } = require('./order-dispatch');

// The forecast reads at most this many lawn visits (its own cap).
const FORECAST_VISIT_LIMIT = 300;
// A visit in one of these states needs nothing bought (technician-visit-scope's dead list, plus done and void).
const FINISHED_STATUSES = ['completed', 'cancelled', 'canceled', 'void', 'rescheduled', 'skipped', 'no_show'];
const UNASSIGNED = 'unassigned';

const exact = (n) => Number(Number(n).toPrecision(12));
// Float noise only, never a real amount: two quantities within this fraction of a pack (or of the need, with no
// pack size) are the same quantity. Full precision everywhere else; rounding is for display (the alert's num()).
const NOISE = 1e-9;
const plural = (n, one, many) => (n === 1 ? one : many);

function addYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return etDateString(addETDays(new Date(Date.UTC(y, m - 1, d, 12)), days));
}

/**
 * The Monday-to-Saturday ET week for `now`, and the day this run's demand starts
 * (today, never before Monday). A Sunday run looks ahead to the coming week.
 */
function weekBounds(now = new Date()) {
  const anchor = etParts(now).dayOfWeek === 0 ? addETDays(now, 1) : now;
  const weekStart = etWeekStart(anchor);
  const today = etDateString(now);
  return { weekStart, weekEnd: addYmd(weekStart, 5), fromDate: today > weekStart ? today : weekStart };
}

// ---- demand ----------------------------------------------------------------

// A visit's start as a sortable key: its day, then its window start; no start time sorts after every time that day.
const visitStart = (v) => `${dateOnlyString(v.scheduled_date)}T${v.window_start ? String(v.window_start).slice(0, 8) : '99'}`;

function newGroup() {
  return { demand: new Map(), firstAt: null, lawnNoPlan: 0, lawnNoUsable: 0, unplanned: 0, unitProblems: new Set(), mixMissing: new Set(), taurusLeft: 0, hasLawn: false, mixVisit: false, extra: new Set(), lawnMismatch: new Set(), lawnPartial: 0 };
}

// Sum demand for one product, kept in the unit of its first entry.
function addDemand(group, productId, qty, unit, reason) {
  const amount = Number(qty);
  if (!(amount > 0)) return;
  const key = String(productId);
  const held = group.demand.get(key);
  if (!held) { group.demand.set(key, { qty: amount, unit, reasons: new Set([reason]) }); return; }
  const converted = held.unit === unit ? amount : convertInventoryQuantity(amount, unit, held.unit);
  if (converted == null) { group.unitProblems.add(key); return; }
  held.qty = exact(held.qty + converted);
  held.reasons.add(reason);
}

// The forecast finds lawn visits by their service name (lawn, fertiliz, turf), so it can plan a visit this list does
// not call a lawn visit ("Tree & Shrub Fertilization"). Lawn demand counts only for visits the close-out reads as lawn
// (detectServiceLine); a visit the forecast planned that is not one is warned about on its list, not counted, so it
// cannot double with the pest mix or another line.
function addLawnDemand(groups, visitById, forecast) {
  const groupOf = (serviceId) => {
    const visit = visitById.get(String(serviceId));
    if (!visit) return null;
    const g = groups.get(visit.groupKey);
    if (visit.line === 'lawn') return g;
    g.lawnMismatch.add(String(visit.id));
    return null;
  };
  for (const row of forecast?.products || []) {
    for (const a of row.appointments || []) {
      const g = groupOf(a.serviceId);
      if (g) addDemand(g, row.productId, a.inventoryAmount ?? a.amount, row.inventoryUnit || a.unit, 'lawn_plan');
    }
    for (const a of row.mismatchAppointments || []) {
      const g = groupOf(a.serviceId);
      if (g) g.unitProblems.add(String(row.productId));
    }
  }
  countLawnGaps(groupOf, forecast);
}

// Lawn visits the forecast could not plan (an error entry), could not use or only part-planned (ids), or left out as not on a program.
function countLawnGaps(groupOf, forecast) {
  const counted = [[forecast?.errors, 'lawnNoPlan'], [forecast?.noUsablePlan, 'lawnNoUsable'], [forecast?.partialPlan, 'lawnPartial'], [forecast?.skippedNonProgram, 'unplanned']];
  for (const [entries, field] of counted) {
    for (const entry of entries || []) {
      const g = groupOf(entry?.serviceId ?? entry);
      if (g) g[field] += 1;
    }
  }
}

/**
 * Pure: demand per technician group from the week's visits, the lawn forecast,
 * the resolved pest house mix and the per-completion supplies.
 * visits: scheduled_services rows { id, technician_id, service_type, scheduled_date, is_callback, service_key_snapshot }
 * kit: products_catalog rows { id, per_completion_usage, per_completion_service_lines, inventory_unit }
 */
function deriveDemand({ visits, forecast, mix, kit }) {
  const groups = new Map();
  const visitById = new Map();
  for (const v of visits) {
    const groupKey = v.technician_id ? String(v.technician_id) : UNASSIGNED;
    if (!groups.has(groupKey)) groups.set(groupKey, newGroup());
    visitById.set(String(v.id), { ...v, groupKey, line: detectServiceLine(v.service_type) });
  }
  addLawnDemand(groups, visitById, forecast);
  const forecastIds = new Set((forecast?.serviceIds || []).map(String));
  for (const v of visitById.values()) {
    const g = groups.get(v.groupKey);
    const at = visitStart(v);
    if (at < (g.firstAt || '9999')) g.firstAt = at;
    const { line } = v;
    addPlannedDemand(g, v, { line, mix, planned: forecastIds.has(String(v.id)) });
    // The close-out's own rule for the kit: an inspection or an internal-only visit leaves none (noKitReason).
    const left = !noKitReason({ isInternalOnlyCompletion: v.internal_only, serviceType: v.service_type, projectType: v.project_type });
    for (const p of left ? kit : []) {
      if (appliesToLine(p.per_completion_service_lines, line)) addDemand(g, p.id, p.per_completion_usage, p.inventory_unit, 'visit_supply');
    }
  }
  return groups;
}

// What a booked visit needs from the planned lines: the lawn forecast's own rows, the pest house mix, or
// nothing planned (counted, so the list never reads complete). A visit that applies nothing (an inspection, an
// internal-only consultation) is not a gap.
function addPlannedDemand(g, v, { line, mix, planned }) {
  const idle = v.internal_only === true || INSPECTION_SERVICE_RE.test(String(v.service_type || ''));
  if (line === 'lawn') {
    g.hasLawn = true;
    if (!planned && !idle) g.unplanned += 1;
  } else if (isPestHouseMixVisit(v)) {
    g.mixVisit = true;
    for (const m of mix.matched) {
      // The close-out drops Taurus SC where the home's label limit is reached or its history is unknown.
      if (m.entry.key === 'taurus_sc' && v.taurus_ok === false) g.taurusLeft += 1;
      else if (m.perVisit == null) g.unitProblems.add(String(m.product.id));
      else addDemand(g, m.product.id, m.perVisit, m.product.inventory_unit, 'pest_mix');
    }
    // A mix product missing from the catalog is a warning on every list whose visits need it, never a silent skip.
    for (const entry of mix.missing) g.mixMissing.add(entry.key.replace(/_/g, ' '));
  } else if (!idle) {
    g.unplanned += 1;
  }
}

// ---- planning --------------------------------------------------------------

// Assigned technicians first, always; then the earlier first visit (day, then start time, an unset time last); then the lower id.
const compareGroups = (groups) => (a, b) => {
  if ((a === UNASSIGNED) !== (b === UNASSIGNED)) return a === UNASSIGNED ? 1 : -1;
  const da = groups.get(a).firstAt || '9999';
  const db2 = groups.get(b).firstAt || '9999';
  if (da !== db2) return da < db2 ? -1 : 1;
  return a < b ? -1 : 1;
};

// Whole packs to buy for `short`, or why not. Held fertilizer buys nothing.
function packsFor(product, short) {
  if (product.hold) return { packs: 0, label: null };
  if (product.countOrder) return { packs: Math.max(1, Math.ceil(short - 1e-9)), label: 'each' };
  const packed = packReorder({ packSize: product.pack?.pack, reorderRaw: short, packMessage: product.pack?.message });
  return { packs: packed.packs, label: product.packLabel || null };
}

function lineNotes(product, line) {
  const out = [];
  if (product.onHand == null) out.push(`${product.name}: stock not counted, treated as none on hand.`);
  if (product.hold && line.short > 0) out.push(`${product.name}: N/P fertilizer is held June 1 to Sept 30, so it is not bought.`);
  else if (line.short > 0 && line.packs == null) {
    out.push(`${product.name}: ${product.picked?.row ? (product.pack?.message || 'no pack size on the price row') : 'no price on file'}.`);
  } else if (line.packs > 0 && product.price > 0 && product.packCents == null && !product.countOrder) {
    out.push(`${product.name}: the price row's delivery cost cannot be worked out, so the line has no price.`);
  }
  return out;
}

// Cost of the packs: the delivered cost of ONE pack, times packs. The delivered cost is resolved the way the Inventory price
// comparison resolves a row (admin-inventory scoreVendorRows: stated shipping and tax, the price-sync worker's landed unit
// price, a shipping estimate, a vendor shipping rule), so the list and the comparison never disagree. A row that carries
// delivery in a form that gives no pack cost has NO cost here (the line is unpriced: the sticker price is never shown as the
// full cost). A stated shipping + tax row is costed by calcLandedCost, as the comparison does for it; one that also has a
// delivery or hazmat estimate on top reads "plus shipping".
function packCostCents(row, price) {
  if (!row || !(price > 0)) return { cents: null, plusShipping: false };
  if (row.shipping_cost != null || row.tax_rate != null) {
    return {
      cents: Math.round(calcLandedCost(price, row.shipping_cost, row.tax_rate) * 100),
      plusShipping: Number(row.shipping_estimate) > 0 || Number(row.hazmat_fee_estimate) > 0,
    };
  }
  const { scoreVendorRows, quantityToOz } = require('../../routes/admin-inventory');
  const oz = quantityToOz(row.quantity);
  // A pack sold by item count ("25 ea"): the comparison ranks it per item. The catalog's own container is this pack, so one
  // pack is the row's count of items; the delivered pack cost is the delivered per-item figure times that count.
  const scored = scoreVendorRows([{ ...row, price_amount: price }], oz > 0 ? {} : { container_size: row.quantity }).ranked[0];
  const carriesDelivery = ['landed_unit_price', 'shipping_estimate', 'hazmat_fee_estimate', 'rebate_estimate'].some((c) => row[c] != null);
  // A count row is resolved when a shipping rule or estimate was added, or it states a landed price per item (valid when its unit
  // is a count unit; equal to the sticker is valid: free delivery). Otherwise the per-item figure is only the sticker.
  const landedPerItem = Number(row.landed_unit_price) > 0 && parsePackCount(`1 ${row.unit_normalized || ''}`) != null;
  const delivered = oz > 0 ? scored.deliveredPerOz * oz : (scored.shipping != null || landedPerItem) && scored.rankPerUnit * (price / scored.perUnit);
  if (delivered > 0) return { cents: Math.round(delivered * 100), plusShipping: false };
  return { cents: carriesDelivery ? null : Math.round(price * 100), plusShipping: false };
}

function costCents(product, packs) {
  if (!(packs > 0) || product.packCents == null || product.countOrder) return null;
  return product.packCents * packs;
}

/**
 * Pure: the stock split, whole packs, spare floor and cost for every group.
 * groups: from deriveDemand. products: Map(String(id) -> plan product).
 * techs: Map(id -> { name, supplyStore }). Returns Map(groupKey -> list entry).
 */
const storeProduct = (products, pid, techs, key) => products.has(pid) && productForStore(products.get(pid), techs.get(key)?.supplyStore);

function planGroups({ groups, products, techs }) {
  const order = [...groups.keys()].sort(compareGroups(groups));
  const stock = new Map();
  const lines = new Map(order.map((key) => [key, []]));
  const notes = new Map(order.map((key) => [key, []]));
  const sharing = new Map();
  for (const key of order) {
    for (const [pid, d] of groups.get(key).demand) {
      const product = storeProduct(products, pid, techs, key);
      if (!product) continue;
      const need = d.unit === product.unit ? d.qty : convertInventoryQuantity(d.qty, d.unit, product.unit);
      if (need == null) { groups.get(key).unitProblems.add(pid); continue; }
      if (!stock.has(pid)) stock.set(pid, Math.max(0, product.onHand ?? 0) + product.onOrder);
      const take = Math.min(stock.get(pid), need);
      stock.set(pid, exact(stock.get(pid) - take));
      sharing.set(pid, (sharing.get(pid) || 0) + 1);
      const gap = exact(need - take);
      const short = gap > (product.pack?.pack > 0 ? product.pack.pack : need) * NOISE ? gap : 0;
      const line = { key, pid, product, need, short, reasons: [...d.reasons], packs: null, label: null };
      if (line.short > 0) Object.assign(line, packsFor(product, line.short));
      lines.get(key).push(line);
      notes.get(key).push(...lineNotes(product, line));
    }
    if (groups.get(key).taurusLeft) notes.get(key).push(`Taurus SC is left out of ${groups.get(key).taurusLeft} ${plural(groups.get(key).taurusLeft, 'visit', 'visits')}: the home reached the label's yearly limit, or its count is unavailable.`);
  }
  applySpareFloor({ order, lines, groups });
  const out = new Map();
  for (const key of order) out.set(key, groupEntry({ key, group: groups.get(key), lines: lines.get(key), notes: notes.get(key), sharing, techs }));
  return out;
}

// The spare floor, as a VOLUME rule (owner 2026-11-27: keep one unopened container of the everyday liquids; the portal
// counts volume, not containers, so it keeps one container's worth). Per product, company-wide, once, after every
// technician's purchase: remaining = on hand + on order + volume bought - the week's whole need. Under one pack size
// remaining: one more pack, on the first technician with demand for it. At least one pack size: nothing, no note.
// A liquid with no pack size on file cannot be worked out: a warning on every list that uses it.
function applySpareFloor({ order, lines, groups }) {
  const floorKeys = new Set(PEST_HOUSE_MIX.filter((e) => e.floor).map((e) => e.key));
  const byProduct = new Map();
  for (const key of order) for (const line of lines.get(key)) {
    if (!line.product.floorKey || !floorKeys.has(line.product.floorKey)) continue;
    if (!byProduct.has(line.pid)) byProduct.set(line.pid, []);
    byProduct.get(line.pid).push(line);
  }
  for (const entries of byProduct.values()) {
    const { product } = entries[0];
    if (product.hold || product.countOrder) continue;
    // Each line's packs are in ITS OWN pack size (a branch row can carry another size); the spare is one pack of the
    // technician who gets it.
    const sizeOf = (l) => l.product.pack?.pack;
    const unsized = entries.filter((l) => !(sizeOf(l) > 0));
    if (unsized.length) {
      for (const l of entries) groups.get(l.key).extra.add(`No pack size on file for ${product.name}, so the spare cannot be worked out.`);
      continue;
    }
    const bought = entries.reduce((sum, l) => sum + (l.packs || 0) * sizeOf(l), 0);
    const need = entries.reduce((sum, l) => sum + l.need, 0);
    const remaining = Math.max(0, product.onHand ?? 0) + product.onOrder + bought - need;
    const first = entries[0];
    if (exact(remaining / sizeOf(first)) >= 1 - NOISE) continue;
    first.packs = (first.packs || 0) + 1;
    first.label = first.product.packLabel || null;
    first.reasons = [...first.reasons, 'spare_floor'];
  }
}

// [value read off a group (falsy = no warning), the sentence for it]
const WARNING_TEXT = [
  [(g) => g.lawnNoPlan, (n) => `${n} lawn ${plural(n, 'visit has', 'visits have')} no lawn plan`],
  [(g) => g.lawnPartial, (n) => `${n} lawn ${plural(n, 'visit has', 'visits have')} a product with no amount, so that product is missing from its need`],
  [(g) => g.lawnMismatch.size, (n) => `${n} ${plural(n, 'visit', 'visits')} the lawn forecast planned ${plural(n, 'is', 'are')} not read as lawn here, so ${plural(n, 'its', 'their')} lawn products are left out`],
  [(g) => g.lawnNoUsable, (n) => `${n} lawn ${plural(n, 'visit has', 'visits have')} no usable plan, so its need is unknown`],
  [(g) => g.unplanned, (n) => `${n} ${plural(n, 'visit', 'visits')} of types this list does not plan yet`],
  [(g) => g.unitProblems.size, (n) => `${n} ${plural(n, 'product has', 'products have')} units that do not convert, so its need is left out`],
  [(g) => [...g.mixMissing].sort().join(', '), (names) => `The pest house mix is missing from the catalog (${names}), so it is left out`],
];

function itemOf(l, cents) {
  return {
    productId: l.pid, name: l.product.name, needQty: l.need, unit: l.product.unit,
    onHand: Math.max(0, l.product.onHand ?? 0), onOrder: l.product.onOrder, shortQty: l.short,
    packs: l.packs, packLabel: l.label, estCostCents: cents, plusShipping: Boolean(cents != null && l.product.plusShipping), otherBranch: Boolean(cents != null && l.product.otherBranch),
    vendorName: l.product.picked?.row?.vendor_name || l.product.picked?.vendorName || null, reasons: l.reasons,
  };
}

function groupEntry({ key, group, lines, notes, sharing, techs }) {
  const tech = key === UNASSIGNED ? null : techs.get(key);
  const items = [];
  let total = 0;
  for (const l of lines.sort((a, b) => a.product.name.localeCompare(b.product.name))) {
    if (sharing.get(l.pid) > 1) notes.push(`${l.product.name}: one company count is shared by ${sharing.get(l.pid)} lists, given out by first visit.`);
    if (!(l.packs > 0 || (l.short > 0 && (l.product.hold || l.packs == null)))) continue;
    const cents = costCents(l.product, l.packs);
    total += cents || 0;
    items.push(itemOf(l, cents));
  }
  return {
    technicianId: key === UNASSIGNED ? null : key,
    technicianName: tech?.name || (key === UNASSIGNED ? null : 'Technician'),
    supplyStore: tech?.supplyStore || null,
    items,
    estTotalCents: items.some((i) => i.estCostCents != null) ? total : null,
    // Lines to buy with no price (no price row, no readable pack, or bought by count): the total leaves them out.
    unpricedLines: items.filter((i) => i.packs !== 0 && i.estCostCents == null).length,
    // Priced lines whose row also carries a delivery or hazmat charge the estimate does not include.
    shippingLines: items.filter((i) => i.plusShipping).length,
    notes: [...new Set(notes)],
    warnings: [...WARNING_TEXT.filter(([read]) => read(group)).map(([read, text]) => text(read(group))), ...[...group.extra].sort()],
  };
}

// ---- read ------------------------------------------------------------------

// One catalog row, its eligible price rows and the clock, as the planner reads it.
function toPlanProduct({ row, pricing, now, floorKey = null, onOrder = 0 }) {
  return {
    id: row.id, name: row.name, unit: row.inventory_unit,
    onHand: row.inventory_on_hand == null || row.inventory_on_hand === '' ? null : Number(row.inventory_on_hand),
    onOrder,
    hold: fertilizerBlackoutHold(row, now),
    floorKey,
    catalogRow: row, pricingRows: pricing,
    ...priceView(pickPriceRow(pricing, row), row.inventory_unit),
  };
}

// The pack and the price of ONE picked price row: the pack in stock units, its label, its delivered cost.
function priceView(picked, unit) {
  const { pack, countOrder } = packFor(picked, unit);
  const price = Number(picked.row?.price_amount ?? picked.row?.price);
  const cost = countOrder ? { cents: null, plusShipping: false } : packCostCents(picked.row, price);
  return {
    picked, pack, countOrder,
    packLabel: String(picked.row?.quantity || '').trim() || null,
    price: Number.isFinite(price) ? price : null,
    packCents: cost.cents, plusShipping: cost.plusShipping,
  };
}

// ---- the technician's branch -------------------------------------------------------------------------------------
// A price row can be for one branch of a supplier (vendor_pricing.branch_name, e.g. "Sarasota"). A technician's supply
// store is free text ("SiteOne Sarasota"). A row matches the store when its branch name, as whole words, is a run of
// the store's words. Case, spacing and punctuation are ignored; nothing else is: no spelling or abbreviation matching.
const wordsOf = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function hasWordRun(haystack, run) {
  return run.length > 0 && haystack.some((_, i) => run.every((w, j) => haystack[i + j] === w));
}

// The product as this store sees it: the price row of its branch when one exists (the catalog's vendor choice still
// holds; the supplier the store names wins among several; then the lower price), else the product as picked, marked
// `otherBranch` so the line says the price is not from the store's branch. No store: the product, unmarked.
function productForStore(product, store) {
  const storeWords = wordsOf(store);
  if (!storeWords.length) return product;
  const vendorId = product.catalogRow.auto_reorder_vendor_id;
  const branchRows = product.pricingRows.filter((r) => (!vendorId || r.vendor_id === vendorId) && hasWordRun(storeWords, wordsOf(r.branch_name)));
  if (!branchRows.length) return { ...product, otherBranch: true };
  const supplierHit = (r) => (hasWordRun(storeWords, wordsOf(r.vendor_name)) ? 0 : 1);
  const price = (r) => Number(r.price_amount ?? r.price) || Infinity;
  const row = [...branchRows].sort((a, b) => supplierHit(a) - supplierHit(b) || price(a) - price(b))[0];
  const picked = { row, vendorName: row.vendor_name, vendor: { code: row.vendor_code, name: row.vendor_name } };
  return { ...product, ...priceView(picked, product.unit), otherBranch: false };
}

function weekVisits(knex, { fromDate, weekEnd }) {
  return knex('scheduled_services as ss')
    .whereBetween('ss.scheduled_date', [fromDate, weekEnd])
    .where((q) => q.whereNull('ss.status').orWhereNotIn('ss.status', FINISHED_STATUSES))
    // An estimate-slot hold (customer_id NULL with a reservation stamp, live or awaiting cleanup) is not a booking;
    // a pending booking has a customer or no stamp. Same rule as scheduling/occupancy.js (includeHolds: false).
    .where((q) => q.whereNotNull('ss.customer_id').orWhereNull('ss.reservation_expires_at'))
    .select('ss.id', 'ss.technician_id', 'ss.service_type', 'ss.scheduled_date', 'ss.is_callback', 'ss.service_key_snapshot', 'ss.service_id', 'ss.is_recurring', 'ss.customer_id', 'ss.property_id', 'ss.window_start');
}

// What each visit's close-out will be, read the way the close-out reads it (its completion profile): an
// internal-only consultation (a Waves Assessment) and a project-backed completion (the WDO inspection) change
// which per-completion supplies it consumes. One profile read per distinct service identity.
async function withCompletionKind(visits, knex) {
  const { resolveCompletionProfileForScheduledService, resolveCompletionDeliveryPosture } = require('../service-completion-profiles');
  const kinds = new Map();
  const out = [];
  for (const v of visits) {
    const key = [v.service_id, v.service_key_snapshot, v.service_type, v.is_recurring].join('|');
    if (!kinds.has(key)) {
      const profile = await resolveCompletionProfileForScheduledService(v, knex);
      const { isInternalOnly } = resolveCompletionDeliveryPosture({ typedFindingsType: profile.findingsType || null, completionMode: profile.completionMode });
      kinds.set(key, {
        internal_only: isInternalOnly, project_type: profile.projectType || null,
        profile_service_key: profile.serviceKey || null, typed_findings: Boolean(profile.findingsType),
      });
    }
    out.push({ ...v, ...kinds.get(key) });
  }
  return out;
}

// What is already bought and not yet in stock, per product, in the product's stock unit: a request marked
// ordered, and an automatic order that is placing or was placed and is not revoked (the live-order rule of
// order-dispatch findLiveAutoOrder). An open request with no order is not supply. The quantity is what the
// order actually holds (orderedQuantityFor: packages round up), else the request's own figure.
async function readOnOrder(knex, ids) {
  if (!ids.length) return [];
  return knex('product_restock_requests as prr')
    .leftJoin('vendor_orders as vo', function liveOrder() {
      this.on('vo.restock_request_id', 'prr.id')
        .andOn(knex.raw("NULLIF(vo.evidence->>'revokedAt', '') IS NULL"))
        .andOn(knex.raw("(vo.status = 'placing' OR vo.placed_at IS NOT NULL)"));
    })
    .whereIn('prr.product_id', ids)
    .where((q) => q.where('prr.status', 'ordered').orWhere((live) => live.whereNotNull('vo.id').whereRaw(RECEIVED_SETTLES_SQL)))
    .select('prr.id', 'prr.product_id', 'prr.requested_quantity', 'prr.unit', 'vo.request_payload', 'vo.status as order_status');
}

const asObject = (value) => (typeof value === 'string' ? (() => { try { return JSON.parse(value) || {}; } catch { return {}; } })() : (value || {}));

// Sum the on-order rows per product in its stock unit; a row that does not convert is reported, not guessed.
function onOrderByProduct(orderRows, units, problems, unsettled) {
  const total = new Map();
  for (const row of orderRows) {
    // Counted as on order (no duplicate buy), but a claim still being placed, or parked for review after submit, is not
    // confirmed yet: the list says so until it settles as placed.
    if (['placing', 'needs_review'].includes(row.order_status)) unsettled.add(String(row.product_id));
    const held = Number(asObject(row.request_payload).orderedQuantity);
    const qty = held > 0 ? held : Number(row.requested_quantity);
    const unit = units.get(String(row.product_id));
    // Receive reads a request with no unit in the product's stock unit (inventory-operations restockActionPlan: request.unit || inventory_unit).
    const rowUnit = row.unit || unit;
    const same = normalizeInventoryUnit(rowUnit) === normalizeInventoryUnit(unit);
    const converted = same ? qty : convertInventoryQuantity(qty, rowUnit, unit);
    if (converted == null || !(converted > 0)) {
      problems.add(String(row.product_id));
      continue;
    }
    total.set(String(row.product_id), exact((total.get(String(row.product_id)) || 0) + converted));
  }
  return total;
}

// Returns { products, onOrderProblems, onOrderUnsettled }. Callers read it inside ONE snapshot (inSnapshot): stock and what is on order
// must be the same moment, or a receive between the two reads is counted twice (or missed).
async function readCatalog(knex, { ids, mixRows, now }) {
  const rows = ids.length
    ? await knex('products_catalog as pc')
      .leftJoin('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
      .whereIn('pc.id', ids)
      .select('pc.id', 'pc.name', 'pc.inventory_on_hand', 'pc.inventory_unit', 'pc.auto_reorder_vendor_id',
        ...FERTILIZER_COLUMNS.map((c) => `pc.${c}`), 'v.name as vendor_name', 'v.code as vendor_code')
    : [];
  const pricing = ids.length
    ? await eligibleVendorPricing(
      knex('vendor_pricing').leftJoin('vendors as pv', 'pv.id', 'vendor_pricing.vendor_id').whereIn('vendor_pricing.product_id', ids),
    ).select('vendor_pricing.product_id', 'vendor_pricing.vendor_id', 'vendor_pricing.quantity', 'vendor_pricing.is_best_price',
      'vendor_pricing.vendor_sku', 'vendor_pricing.branch_name', 'vendor_pricing.price', 'vendor_pricing.price_amount', 'vendor_pricing.tax_rate',
      'vendor_pricing.shipping_cost', 'vendor_pricing.shipping_estimate', 'vendor_pricing.hazmat_fee_estimate', 'vendor_pricing.rebate_estimate',
      'vendor_pricing.landed_unit_price', 'vendor_pricing.unit_normalized', 'vendor_pricing.normalized_unit_price', 'vendor_pricing.price_per_oz',
      'vendor_pricing.source_type', 'vendor_pricing.vendor_product_url',
      'pv.name as vendor_name', 'pv.code as vendor_code')
    : [];
  const onOrderProblems = new Set();
  const onOrderUnsettled = new Set();
  const onOrder = onOrderByProduct(await readOnOrder(knex, ids), new Map(rows.map((r) => [String(r.id), r.inventory_unit])), onOrderProblems, onOrderUnsettled);
  const floorKeyOf = new Map(mixRows.matched.map((m) => [String(m.product.id), m.entry.key]));
  const products = new Map(rows.map((row) => [String(row.id), toPlanProduct({
    row, now, floorKey: floorKeyOf.get(String(row.id)) || null, onOrder: onOrder.get(String(row.id)) || 0,
    pricing: pricing.filter((p) => String(p.product_id) === String(row.id)),
  })]));
  return { products, onOrderProblems, onOrderUnsettled };
}

// One consistent read: a read-only REPEATABLE READ transaction, so every statement sees the same moment. A caller
// that already holds a transaction (the dry-run script, tests) keeps it; its own isolation applies.
function inSnapshot(knex, read) {
  return knex.isTransaction ? read(knex) : knex.transaction(read, { isolationLevel: 'repeatable read', readOnly: true });
}

// A warning about the whole list belongs on every list it affects, or a list with nothing short would be closed
// as "nothing to buy" while the list is incomplete.
function warnGroups(groups, affected, text) {
  for (const g of groups.values()) if (affected(g)) g.extra.add(text);
}

// Taurus SC stays on a visit's mix only where the home's yearly label limit leaves room (one batched ledger
// read for every home this week, judged in visit order); an unknown count leaves it off, as the close-outs do.
async function withTaurusAnswer(visits, { knex, now, mix }) {
  if (!mix.matched.some((m) => m.entry.key === 'taurus_sc')) return { visits, failed: false };
  const mixVisits = visits.filter((v) => isPestHouseMixVisit(v));
  const { fits, failed } = await projectTaurusEligibility(mixVisits, { knex, now });
  return { visits: visits.map((v) => (fits.has(v.id) ? { ...v, taurus_ok: fits.get(v.id) } : v)), failed };
}

const TAURUS_FAILED = 'Taurus SC yearly counts could not be read, so Taurus is left out of every pest visit this week.';
const LAWN_CAPPED = `The lawn forecast stopped at ${FORECAST_VISIT_LIMIT} visits, so lawn needs may read low.`;

/**
 * The buy list for the ET week containing `now` (Monday to Saturday), from
 * `fromDate` (default: today, not before Monday) forward.
 */
async function buildWeeklyBuyList({ knex = db, now = new Date() } = {}) {
  const { weekStart, weekEnd, fromDate } = weekBounds(now);
  // EVERYTHING the list reads, in one snapshot: a close-out between the visit read and the stock read would otherwise
  // count the visit and its stock use twice. Nothing is written here.
  const read = await inSnapshot(knex, (conn) => readWeek(conn, { now, fromDate, weekEnd }));
  const { groups, products, techs, kit, onOrderProblems, onOrderUnsettled, taurusFailed, lawnCapped } = read;
  for (const pid of read.demandIds) {
    if (!products.has(pid)) warnGroups(groups, (g) => g.demand.has(pid), 'A product with scheduled need is no longer in the catalog, so its need is left out.');
  }
  for (const pid of onOrderProblems) warnGroups(groups, (g) => g.demand.has(pid), 'An order already placed is in a unit that does not convert to its stock unit, so it is not counted as on order.');
  for (const pid of onOrderUnsettled) warnGroups(groups, (g) => g.demand.has(pid), 'An order is being placed or waiting for review and is not confirmed yet: it is counted as on order for now.');
  if (kit.some((p) => serviceLinesInvalid(p.per_completion_service_lines))) warnGroups(groups, () => true, 'A per-visit supply has service lines that are not a list, so its need is left out.');
  if (taurusFailed) warnGroups(groups, (g) => g.mixVisit, TAURUS_FAILED);
  if (lawnCapped) warnGroups(groups, (g) => g.hasLawn, LAWN_CAPPED);
  const listWarnings = [taurusFailed && TAURUS_FAILED, lawnCapped && LAWN_CAPPED].filter(Boolean);
  const planned = planGroups({ groups, products, techs });
  const unassigned = planned.get(UNASSIGNED) || groupEntry({ key: UNASSIGNED, group: newGroup(), lines: [], notes: [], sharing: new Map(), techs });
  planned.delete(UNASSIGNED);
  return {
    weekStart, weekEnd, fromDate,
    technicians: [...planned.values()],
    unassigned,
    warnings: [...new Set([...listWarnings, ...[...groups.values()].flatMap((g) => [...g.extra])])],
  };
}

// Every read of the week, on one connection (the caller's snapshot): visits and their close-out kinds, technicians, the
// lawn forecast, the catalog (house mix, kit, stock), prices, what is on order, and Taurus's yearly ledger. Returns what
// the pure planning needs.
async function readWeek(conn, { now, fromDate, weekEnd }) {
  const visits = await withCompletionKind(await weekVisits(conn, { fromDate, weekEnd }), conn);
  const techIds = [...new Set(visits.map((v) => v.technician_id).filter(Boolean))];
  const techRows = techIds.length ? await conn('technicians').whereIn('id', techIds).select('id', 'name', 'supply_store') : [];
  const techs = new Map(techRows.map((t) => [String(t.id), { name: t.name, supplyStore: t.supply_store }]));

  const { buildWaveGuardInventoryForecast } = require('../waveguard-inventory-forecast');
  const forecast = await buildWaveGuardInventoryForecast({ knex: conn, startDate: fromDate, endDate: weekEnd, limit: FORECAST_VISIT_LIMIT, narrow: { excludeStatuses: FINISHED_STATUSES, bookedOnly: true } });

  const mixCandidates = await conn('products_catalog').where('active', true).orderBy('name').orderBy('id').select('id', 'name', 'inventory_unit');
  const mix = resolveHouseMix(mixCandidates);
  const kit = await conn('products_catalog').where('active', true).where('per_completion_usage', '>', 0)
    .select('id', 'per_completion_usage', 'per_completion_service_lines', 'inventory_unit');

  const { visits: withTaurus, failed: taurusFailed } = await withTaurusAnswer(visits, { knex: conn, now, mix });
  const groups = deriveDemand({ visits: withTaurus, forecast, mix, kit });
  const demandIds = new Set([...groups.values()].flatMap((g) => [...g.demand.keys()]));
  const catalog = await readCatalog(conn, { ids: [...demandIds], mixRows: mix, now });
  return { groups, techs, kit, demandIds, taurusFailed, lawnCapped: (forecast.serviceCount || 0) >= FORECAST_VISIT_LIMIT, ...catalog };
}

module.exports = {
  buildWeeklyBuyList, weekBounds, deriveDemand, planGroups, toPlanProduct, UNASSIGNED, FORECAST_VISIT_LIMIT,
};
