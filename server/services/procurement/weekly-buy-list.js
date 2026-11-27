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
 *     (pest-house-mix.js, a tested copy of the client's mix).
 *   - per-completion supplies (yard signs, stickers, stakes): one per booked visit
 *     of a line the product names, by the close-out's own rule (supplies-consumption
 *     noKitReason, fed by the visit's completion profile: an internal-only
 *     consultation leaves none, the WDO inspection project still leaves its notice).
 * Estimate-slot holds (customer_id NULL with a reservation stamp) are not bookings.
 * Visits of any other kind (roach, flea, bed bug, mosquito, rodent, tree and
 * shrub ...) are not planned; each technician's list says how many.
 *
 * Supply is products_catalog.inventory_on_hand, one company-wide count. With two
 * technicians drawing on it, stock goes to assigned technicians first (earliest
 * first visit, then id), then to visits with no technician. Short = need minus the stock given to
 * that technician. Packs are whole vendor packs, read the way the dispatcher
 * reads them (reorder-limit-suggestions: eligible price row, packFor, packReorder).
 * Spare floor: for the everyday pest liquids, one unopened container must still
 * be on the shelf after the week; it adds a container only when that is not true.
 * N/P fertilizer is held June 1 - Sept 30 (fertilizer-blackout.js): listed, not bought.
 */
const db = require('../../models/db');
const { etParts, etWeekStart, etDateString, addETDays } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { convertInventoryQuantity } = require('../inventory-units');
const { eligibleVendorPricing } = require('../vendor-pricing-eligibility');
const { packFor, packReorder, pickPriceRow } = require('./reorder-limit-suggestions');
const { fertilizerBlackoutHold, FERTILIZER_COLUMNS } = require('./fertilizer-blackout');
const { appliesToLine, noKitReason, INSPECTION_SERVICE_RE } = require('../supplies-consumption');
const { detectServiceLine } = require('../service-report/service-line-configs');
const { isPestHouseMixVisit, resolveHouseMix, PEST_HOUSE_MIX } = require('./pest-house-mix');

// The forecast reads at most this many lawn visits (its own cap).
const FORECAST_VISIT_LIMIT = 300;
// A visit in one of these states needs nothing bought (technician-visit-scope's dead list, plus done and void).
const FINISHED_STATUSES = ['completed', 'cancelled', 'canceled', 'void', 'rescheduled', 'skipped', 'no_show'];
const UNASSIGNED = 'unassigned';

const exact = (n) => Number(Number(n).toPrecision(12));
const round4 = (n) => Math.round(n * 10000) / 10000;
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

function newGroup() {
  return { demand: new Map(), firstDate: null, lawnNoPlan: 0, unplanned: 0, unitProblems: new Set(), mixMissing: new Set() };
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

function addLawnDemand(groups, visitById, forecast) {
  const groupOf = (serviceId) => {
    const visit = visitById.get(String(serviceId));
    return visit ? groups.get(visit.groupKey) : null;
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
  for (const e of forecast?.errors || []) {
    const g = groupOf(e.serviceId);
    if (g) g.lawnNoPlan += 1;
  }
  for (const s of forecast?.skippedNonProgram || []) {
    const g = groupOf(s.serviceId);
    if (g) g.unplanned += 1;
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
    visitById.set(String(v.id), { ...v, groupKey });
  }
  addLawnDemand(groups, visitById, forecast);
  const forecastIds = new Set((forecast?.serviceIds || []).map(String));
  for (const v of visitById.values()) {
    const g = groups.get(v.groupKey);
    const date = dateOnlyString(v.scheduled_date);
    if (date < (g.firstDate || '9999')) g.firstDate = date;
    const line = detectServiceLine(v.service_type);
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
    if (!planned && !idle) g.unplanned += 1;
  } else if (isPestHouseMixVisit(v)) {
    for (const m of mix.matched) {
      if (m.perVisit == null) g.unitProblems.add(String(m.product.id));
      else addDemand(g, m.product.id, m.perVisit, m.product.inventory_unit, 'pest_mix');
    }
    // A mix product missing from the catalog is a warning on every list whose visits need it, never a silent skip.
    for (const entry of mix.missing) g.mixMissing.add(entry.key.replace(/_/g, ' '));
  } else if (!idle) {
    g.unplanned += 1;
  }
}

// ---- planning --------------------------------------------------------------

// Assigned technicians first, always; then the earlier first visit; then the lower id.
const compareGroups = (groups) => (a, b) => {
  if ((a === UNASSIGNED) !== (b === UNASSIGNED)) return a === UNASSIGNED ? 1 : -1;
  const da = groups.get(a).firstDate || '9999';
  const db2 = groups.get(b).firstDate || '9999';
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
  }
  return out;
}

function costCents(product, packs) {
  if (!(packs > 0) || !(product.price > 0) || product.countOrder) return null;
  return Math.round(packs * product.price * (1 + (product.tax > 0 ? product.tax : 0)) * 100);
}

/**
 * Pure: the stock split, whole packs, spare floor and cost for every group.
 * groups: from deriveDemand. products: Map(String(id) -> plan product).
 * techs: Map(id -> { name, supplyStore }). Returns Map(groupKey -> list entry).
 */
function planGroups({ groups, products, techs }) {
  const order = [...groups.keys()].sort(compareGroups(groups));
  const stock = new Map();
  const lines = new Map(order.map((key) => [key, []]));
  const notes = new Map(order.map((key) => [key, []]));
  const sharing = new Map();
  for (const key of order) {
    for (const [pid, d] of groups.get(key).demand) {
      const product = products.get(pid);
      if (!product) continue;
      const need = d.unit === product.unit ? d.qty : convertInventoryQuantity(d.qty, d.unit, product.unit);
      if (need == null) { groups.get(key).unitProblems.add(pid); continue; }
      if (!stock.has(pid)) stock.set(pid, Math.max(0, product.onHand ?? 0));
      const take = Math.min(stock.get(pid), need);
      stock.set(pid, exact(stock.get(pid) - take));
      sharing.set(pid, (sharing.get(pid) || 0) + 1);
      const line = { pid, product, need: round4(need), short: Math.max(0, round4(exact(need - take))), reasons: [...d.reasons], packs: null, label: null };
      if (line.short > 0) Object.assign(line, packsFor(product, line.short));
      lines.get(key).push(line);
      notes.get(key).push(...lineNotes(product, line));
    }
  }
  applySpareFloor({ order, lines });
  const out = new Map();
  for (const key of order) out.set(key, groupEntry({ key, group: groups.get(key), lines: lines.get(key), notes: notes.get(key), sharing, techs }));
  return out;
}

// One unopened container of an everyday liquid stays on the shelf: when the
// company's stock plus every pack bought, less the week's whole need, is less
// than one container, the first technician with demand for it buys one more.
function applySpareFloor({ order, lines }) {
  const floorIds = new Set(PEST_HOUSE_MIX.filter((e) => e.floor).map((e) => e.key));
  const byProduct = new Map();
  for (const key of order) for (const line of lines.get(key)) {
    if (!line.product.floorKey || !floorIds.has(line.product.floorKey)) continue;
    if (!byProduct.has(line.pid)) byProduct.set(line.pid, []);
    byProduct.get(line.pid).push(line);
  }
  for (const entries of byProduct.values()) {
    const { product } = entries[0];
    const size = product.pack?.pack;
    if (product.hold || product.countOrder || !(size > 0)) continue;
    const need = entries.reduce((sum, l) => sum + l.need, 0);
    const bought = entries.reduce((sum, l) => sum + (l.packs || 0) * size, 0);
    if (exact(Math.max(0, product.onHand ?? 0) + bought - need) >= exact(size - 1e-9)) continue;
    const first = entries[0];
    first.packs = (first.packs || 0) + 1;
    first.label = product.packLabel || null;
    first.reasons = [...first.reasons, 'spare_floor'];
  }
}

// [value read off a group (falsy = no warning), the sentence for it]
const WARNING_TEXT = [
  [(g) => g.lawnNoPlan, (n) => `${n} lawn ${plural(n, 'visit has', 'visits have')} no lawn plan`],
  [(g) => g.unplanned, (n) => `${n} ${plural(n, 'visit', 'visits')} of types this list does not plan yet`],
  [(g) => g.unitProblems.size, (n) => `${n} ${plural(n, 'product has', 'products have')} units that do not convert, so its need is left out`],
  [(g) => [...g.mixMissing].sort().join(', '), (names) => `The pest house mix is missing from the catalog (${names}), so it is left out`],
];

function itemOf(l, cents) {
  return {
    productId: l.pid, name: l.product.name, needQty: l.need, unit: l.product.unit,
    onHand: Math.max(0, l.product.onHand ?? 0), shortQty: l.short,
    packs: l.packs, packLabel: l.label, estCostCents: cents,
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
    notes: [...new Set(notes)],
    warnings: WARNING_TEXT.filter(([read]) => read(group)).map(([read, text]) => text(read(group))),
  };
}

// ---- read ------------------------------------------------------------------

// One catalog row, its eligible price rows and the clock, as the planner reads it.
function toPlanProduct({ row, pricing, now, floorKey = null }) {
  const unit = row.inventory_unit;
  const picked = pickPriceRow(pricing, row);
  const { pack, countOrder } = packFor(picked, unit);
  const price = Number(picked.row?.price_amount ?? picked.row?.price);
  return {
    id: row.id, name: row.name, unit,
    onHand: row.inventory_on_hand == null || row.inventory_on_hand === '' ? null : Number(row.inventory_on_hand),
    hold: fertilizerBlackoutHold(row, now),
    picked, pack, countOrder,
    packLabel: String(picked.row?.quantity || '').trim() || null,
    price: Number.isFinite(price) ? price : null,
    tax: Number(picked.row?.tax_rate) || 0,
    floorKey,
  };
}

function weekVisits(knex, { fromDate, weekEnd }) {
  return knex('scheduled_services as ss')
    .whereBetween('ss.scheduled_date', [fromDate, weekEnd])
    .where((q) => q.whereNull('ss.status').orWhereNotIn('ss.status', FINISHED_STATUSES))
    // An estimate-slot hold (customer_id NULL with a reservation stamp, live or awaiting cleanup) is not a booking;
    // a pending booking has a customer or no stamp. Same rule as scheduling/occupancy.js (includeHolds: false).
    .where((q) => q.whereNotNull('ss.customer_id').orWhereNull('ss.reservation_expires_at'))
    .select('ss.id', 'ss.technician_id', 'ss.service_type', 'ss.scheduled_date', 'ss.is_callback', 'ss.service_key_snapshot', 'ss.service_id', 'ss.is_recurring');
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
      kinds.set(key, { internal_only: isInternalOnly, project_type: profile.projectType || null });
    }
    out.push({ ...v, ...kinds.get(key) });
  }
  return out;
}

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
      'vendor_pricing.vendor_sku', 'vendor_pricing.price', 'vendor_pricing.price_amount', 'vendor_pricing.tax_rate',
      'pv.name as vendor_name', 'pv.code as vendor_code')
    : [];
  const floorKeyOf = new Map(mixRows.matched.map((m) => [String(m.product.id), m.entry.key]));
  return new Map(rows.map((row) => [String(row.id), toPlanProduct({
    row, now, floorKey: floorKeyOf.get(String(row.id)) || null,
    pricing: pricing.filter((p) => String(p.product_id) === String(row.id)),
  })]));
}

/**
 * The buy list for the ET week containing `now` (Monday to Saturday), from
 * `fromDate` (default: today, not before Monday) forward.
 */
async function buildWeeklyBuyList({ knex = db, now = new Date() } = {}) {
  const { weekStart, weekEnd, fromDate } = weekBounds(now);
  const visits = await withCompletionKind(await weekVisits(knex, { fromDate, weekEnd }), knex);
  const warnings = [];
  const techIds = [...new Set(visits.map((v) => v.technician_id).filter(Boolean))];
  const techRows = techIds.length ? await knex('technicians').whereIn('id', techIds).select('id', 'name', 'supply_store') : [];
  const techs = new Map(techRows.map((t) => [String(t.id), { name: t.name, supplyStore: t.supply_store }]));

  const { buildWaveGuardInventoryForecast } = require('../waveguard-inventory-forecast');
  const forecast = await buildWaveGuardInventoryForecast({ knex, startDate: fromDate, endDate: weekEnd, limit: FORECAST_VISIT_LIMIT });
  if ((forecast.serviceCount || 0) >= FORECAST_VISIT_LIMIT) warnings.push(`The lawn forecast stopped at ${FORECAST_VISIT_LIMIT} visits, so lawn needs may read low.`);

  const mixCandidates = await knex('products_catalog').where('active', true).orderBy('name').orderBy('id').select('id', 'name', 'inventory_unit');
  const mix = resolveHouseMix(mixCandidates);
  const kit = await knex('products_catalog').where('active', true).where('per_completion_usage', '>', 0)
    .select('id', 'per_completion_usage', 'per_completion_service_lines', 'inventory_unit');

  const groups = deriveDemand({ visits, forecast, mix, kit });
  const demandIds = new Set([...groups.values()].flatMap((g) => [...g.demand.keys()]));
  const products = await readCatalog(knex, { ids: [...demandIds], mixRows: mix, now });
  for (const pid of demandIds) if (!products.has(pid)) warnings.push('A product with scheduled need is no longer in the catalog.');
  const planned = planGroups({ groups, products, techs });
  const unassigned = planned.get(UNASSIGNED) || groupEntry({ key: UNASSIGNED, group: newGroup(), lines: [], notes: [], sharing: new Map(), techs });
  planned.delete(UNASSIGNED);
  return {
    weekStart, weekEnd, fromDate,
    technicians: [...planned.values()],
    unassigned,
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  buildWeeklyBuyList, weekBounds, deriveDemand, planGroups, toPlanProduct, UNASSIGNED, FORECAST_VISIT_LIMIT,
};
