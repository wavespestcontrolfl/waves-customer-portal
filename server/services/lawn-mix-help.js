/**
 * Mix help of the lawn Fast Complete sheet (GATE_LAWN_MIX_HELP, owner 2026-10-09).
 *
 * A spot product's rate is a tiny dose per 1,000 sq ft (100 sq ft of Celsius is a fraction of a gram); the technician puts product in a
 * backpack. This module answers, for each spot-spray product of the visit's program:
 *
 *   - the amount for a FULL TANK of 1, 2 or 4 gallons at the staged row's own rate, rate unit and carrier volume (gallons of finished
 *     spray per 1,000 sq ft; lawn_protocol_products.carrier_gal_per_1000), in units a technician can measure: ounces by weight to 2
 *     decimals and grams for a dry product, fluid ounces and mL for a liquid;
 *   - the surfactant's amount from its staged concentration (a share of the finished tank, 0.25% v/v), which the sheet shows only
 *     while the weed entry's existing 90 F rule keeps the surfactant in the mix (lawn-weed-mix.js);
 *   - the mixing order the catalog already states (products_catalog.mixing_order_category, the order the plan engine's buildMixOrder
 *     uses), only when every product of the group has one;
 *   - the Celsius WG label's own tank-stability lines, matched by EPA registration number, never by name.
 *
 * AND the other direction: GALLONS SPRAYED entered instead of an area. /complete converts them with the product's STAGED carrier (the
 * sheet's figure is a preview only) into the recorded spot area, which then flows to the per-place limits, the ledger and the customer
 * card's "about N sq ft" exactly as a typed area does; the row is marked on structured_notes.lawnSprayedGallons so the record says the
 * area was derived.
 *
 * No agronomy number is added here: the rate, the unit and the carrier are the staged row's. Unit constants are physical. Fail closed:
 * a row whose rate, unit or carrier is missing, or whose rows disagree, shows less (no tank amount) and never a guess. Technician sheet
 * only; nothing here reaches a customer text, a report or a public payload.
 */
const logger = require('./logger');

const TANKS = Object.freeze([1, 2, 4]);
const OZ_TO_G = 28.349523125;
const FLOZ_TO_ML = 29.5735295625;
const FLOZ_PER_GAL = 128;
const OZ_PER_LB = 16;

// The most gallons one spot job can state: ten fills of the largest tank offered (4 gal, a backpack), 40 gallons. The tank sizes are the
// only sprayer volume in the data (the job card's rig list is 110 gal truck tanks and 4 gal backpacks), and a spot job past ten backpack
// fills is a whole-lawn pass, which has its own area. At the staged carriers (1 to 4 gal per 1,000 sq ft) 40 gallons is 10,000 to 40,000 sq ft,
// above any spot. A larger number is a typing slip (or an overflow such as 1e308), so it is refused as invalid, never converted.
const MAX_FILLS = 10;
const MAX_GALLONS = Math.max(...TANKS) * MAX_FILLS;

const live = () => require('../config/feature-gates').lawnMixHelpLive();

// The Celsius WG label on file (EPA Reg. No. 432-1507, the EPA-stamped 2021-09-01 version), word for word, the stricter instruction first. Keyed by EPA registration
// number so a rename of the catalog product changes nothing and no product is matched by its name.
const LABEL_LINES = Object.freeze({
  '432-1507': Object.freeze([
    Object.freeze({ text: 'Prepare only as much spray mixture as needed for application on the same day.', source: 'Celsius WG label, Mixing Instructions' }),
    Object.freeze({ text: 'Apply spray mixtures of this product within 5 days of mixing to avoid product degradation.', source: 'Celsius WG label, Precautions, item 3' }),
  ]),
});

// ── units ───────────────────────────────────────────────────────────────────

// 'oz' and 'lb' are weights (shown as oz and grams), 'fl oz' a volume (fl oz and mL). Any other unit (label_rate, lb_n, a percent) has no
// tank amount here.
function unitOf(unit) {
  const key = String(unit || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
  if (key === 'oz') return { kind: 'weight', toBase: 1 };
  if (key === 'lb' || key === 'lbs') return { kind: 'weight', toBase: OZ_PER_LB };
  if (key === 'fl oz' || key === 'floz') return { kind: 'volume', toBase: 1 };
  return null;
}

const weightText = (oz) => `${oz.toFixed(2)} oz (${(oz * OZ_TO_G).toFixed(2)} g)`;
const volumeText = (flOz) => `${flOz.toFixed(2)} fl oz (${(flOz * FLOZ_TO_ML).toFixed(1)} mL)`;
const doseText = (kind, base) => (kind === 'weight' ? weightText(base) : volumeText(base));

// '0.25% v/v' -> 0.0025 (a share of the finished tank by volume), or null for any other spelling.
function volumeShare(concentration) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*v\s*\/\s*v\s*$/i.exec(String(concentration || ''));
  const percent = match ? Number(match[1]) : NaN;
  return percent > 0 && percent < 100 ? percent / 100 : null;
}

const positive = (value) => (Number(value) > 0 ? Number(value) : null);

/** The sq ft one tank covers at a carrier volume (gallons per 1,000 sq ft), whole square feet. */
const coversSqft = (tankGal, carrier) => Math.round((tankGal / carrier) * 1000);

/**
 * The area a number of gallons sprayed covers at the product's carrier volume (gallons per 1,000 sq ft), whole square feet, at least 1;
 * null for anything that is not a positive number. The ONE conversion: /complete uses it, and the sheet's preview mirrors it.
 */
function areaFromGallons(gallons, carrier) {
  const gal = positive(gallons);
  const per = positive(carrier);
  if (!gal || !per || gal > MAX_GALLONS) return null;
  const area = Math.round((gal * 1000) / per);
  return Number.isFinite(area) ? Math.max(1, area) : null;
}

// ── one product's mix help ──────────────────────────────────────────────────

/** `{ [tank]: { text, coversSqft } }` for a concentration row or a rate-and-carrier row; null when the row cannot be sized. */
function tankDoses(staged) {
  const doses = {};
  const share = staged.concentration ? volumeShare(staged.concentration) : null;
  if (staged.concentration) {
    if (!share) return null;
    for (const tank of TANKS) doses[tank] = { text: volumeText(share * tank * FLOZ_PER_GAL), coversSqft: null };
    return doses;
  }
  const unit = unitOf(staged.rateUnit);
  const rate = positive(staged.ratePer1000);
  const carrier = positive(staged.carrierGalPer1000);
  if (!unit || !rate || !carrier) return null;
  for (const tank of TANKS) doses[tank] = { text: doseText(unit.kind, (rate * unit.toBase * tank) / carrier), coversSqft: coversSqft(tank, carrier) };
  return doses;
}

// The dose per 1,000 sq ft, for a row whose carrier is not on file.
function per1000Text(staged) {
  const unit = unitOf(staged.rateUnit);
  const rate = positive(staged.ratePer1000);
  return unit && rate ? doseText(unit.kind, rate * unit.toBase) : null;
}

const CARRIER_MISSING = 'The carrier volume is not on file for this product, so there is no tank amount.';

/**
 * One product's entry, from its agreed staged row (`{ ratePer1000, rateUnit, carrierGalPer1000, concentration }`) and its catalog row
 * (`{ name, epa_reg_number }`), or null when there is nothing to show (no rate and no concentration). Pure.
 */
function entryFor(staged, catalogRow) {
  const perTank = tankDoses(staged);
  const per1000 = staged.concentration ? null : per1000Text(staged);
  if (!perTank && !per1000) return null;
  const labelLines = LABEL_LINES[String(catalogRow?.epa_reg_number || '').trim()] || null;
  return {
    name: catalogRow?.name || null,
    carrierGalPer1000: staged.concentration ? null : positive(staged.carrierGalPer1000),
    perTank,
    per1000,
    concentration: staged.concentration || null,
    note: perTank ? null : CARRIER_MISSING,
    ...(labelLines ? { labelLines: labelLines.map((line) => ({ ...line })) } : {}),
  };
}

// ── the staged rows ─────────────────────────────────────────────────────────

const num = (value) => (value == null || value === '' ? null : Number(value));
function parseGates(gates) {
  if (gates && typeof gates === 'object') return gates;
  try { return JSON.parse(gates) || {}; } catch { return {}; }
}

/**
 * The staged protocol rows of some products, as `Map(lower-case product id -> [row])`. Retired rows are left out. A failed read THROWS
 * (the caller shows no mix help; it is never an empty answer).
 */
async function stagedRows({ knex, protocolId, productIds }) {
  const out = new Map();
  if (!protocolId || !productIds.length) return out;
  const { activeProtocolProducts } = require('./lawn-protocol-retired');
  const rows = await activeProtocolProducts(knex('lawn_protocol_products as lpp'), 'lpp')
    .join('lawn_protocol_windows as w', 'lpp.lawn_protocol_window_id', 'w.id')
    .where('w.lawn_protocol_id', protocolId)
    .whereRaw('lpp.product_id::text = ANY(?)', [productIds])
    .select('lpp.product_id', 'lpp.application_mode', 'lpp.rate_per_1000', 'lpp.rate_unit', 'lpp.carrier_gal_per_1000', 'lpp.gates', 'w.month');
  for (const row of rows) {
    const id = String(row.product_id).toLowerCase();
    out.set(id, [...(out.get(id) || []), row]);
  }
  return out;
}

const stagedKey = (row) => JSON.stringify([row.application_mode, num(row.rate_per_1000), String(row.rate_unit || '').trim().toLowerCase(), num(row.carrier_gal_per_1000), parseGates(row.gates).concentration || null]);

/**
 * The one staged row a product's mix help follows: the visit's own month window when it has the product, else all its windows; the rows
 * of that pool must AGREE on mode, rate, unit, carrier and concentration, else null (two rows that disagree are not a guess to pick from).
 * Returns `{ mode, ratePer1000, rateUnit, carrierGalPer1000, concentration }` or null.
 */
function agreedRow(rows, month) {
  const own = rows.filter((row) => Number(row.month) === Number(month));
  const pool = own.length ? own : rows;
  if (!pool.length || new Set(pool.map(stagedKey)).size !== 1) return null;
  const row = pool[0];
  return {
    mode: row.application_mode,
    ratePer1000: num(row.rate_per_1000),
    rateUnit: row.rate_unit || null,
    carrierGalPer1000: num(row.carrier_gal_per_1000),
    concentration: parseGates(row.gates).concentration || null,
  };
}

// ── the context block ───────────────────────────────────────────────────────

async function catalogRowsFor(knex, ids) {
  if (!ids.length) return new Map();
  const rows = await knex('products_catalog').whereRaw('id::text = ANY(?)', [ids]).select('id', 'name', 'epa_reg_number', 'mixing_order_category');
  return new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
}

const lowerIds = (list) => (Array.isArray(list) ? list : []).map((id) => String(id).toLowerCase());

// The product ids the block covers: the program's items and add-ons, the weed group and the chinch rungs.
function idsOf({ loaded, weed, chinch }) {
  const planned = [...(loaded?.items || []), ...(loaded?.addOns || [])].map((item) => item.product?.id);
  return [...new Set(lowerIds([...planned, ...(weed?.weedMix?.groupProductIds || []), ...(chinch?.chinch?.rungIds || [])]))];
}

/**
 * The weed group's mixing order, as product ids, from the catalog's own mixing_order_category through the plan engine's buildMixOrder:
 * only products whose category is one the engine orders (MIX_ORDER) are listed, in that order. The sheet shows the order only when
 * EVERY product on the weed card is listed, so a partly unclassified tank gets no order. null when fewer than two are listed.
 */
function weedOrder(groupIds, catalog) {
  const { buildMixOrder, MIX_ORDER } = require('./waveguard-plan-engine');
  const ids = lowerIds(groupIds).filter((id) => MIX_ORDER.includes(catalog.get(id)?.mixing_order_category));
  if (ids.length < 2) return null;
  return buildMixOrder(ids.map((id) => ({ product: { id, name: catalog.get(id).name || id, mixing_order_category: catalog.get(id).mixing_order_category } })))
    .map((step) => String(step.productId).toLowerCase());
}

// The readers a call can swap (tests); everything else is the real thing.
const DEPS = Object.freeze({
  isLive: live, readStaged: stagedRows, readCatalog: catalogRowsFor, readSpotRows: (knex, rows) => require('./lawn-trouble-areas').spotRowsOf(knex, rows),
});

// The rows of the block: each product's entry, spot work only (a whole-lawn product keeps the plan's own amount).
function rowsOf({ ids, staged, catalog, month }) {
  const rows = {};
  for (const id of ids) {
    const agreed = agreedRow(staged.get(id) || [], month);
    const entry = agreed && agreed.mode === 'spot' ? entryFor(agreed, catalog.get(id)) : null;
    if (entry) rows[id] = entry;
  }
  return rows;
}

async function buildBlock({ loaded, weed, chinch, month, knex }, { readStaged, readCatalog }) {
  const ids = idsOf({ loaded, weed, chinch });
  const protocolId = loaded?.plan?.protocol?.structured?.id;
  if (!ids.length || !protocolId) return {};
  const [staged, catalog] = await Promise.all([readStaged({ knex, protocolId, productIds: ids }), readCatalog(knex, ids)]);
  const rows = rowsOf({ ids, staged, catalog, month });
  if (!Object.keys(rows).length) return {};
  return { mixHelp: { v: 1, tanks: [...TANKS], rows, weedOrder: weedOrder(weed?.weedMix?.groupProductIds, catalog) } };
}

/**
 * `{ mixHelp }` to spread into the context's plannedProducts, or `{}` (gate off, no staged protocol, a failed read). `loaded` is the
 * plan as lawn-fast-complete loads it, `weed` / `chinch` the weed-mix and chinch blocks, `month` the visit's month (1-12).
 *   mixHelp = { v: 1, tanks: [1, 2, 4], rows: { [productId]: entry }, weedOrder: [productId, ...] | null }
 * Input: `{ loaded, weed, chinch, month, knex }` plus, for tests, `isLive`, `readStaged`, `readCatalog`.
 */
async function contextBlock(input) {
  const deps = { ...DEPS, ...input };
  if (!deps.isLive()) return {};
  try {
    return await buildBlock(input, deps);
  } catch (err) {
    logger.warn(`[lawn-mix-help] mix help unavailable: ${err?.code || err?.name || 'Error'}`);
    return {};
  }
}

// ── gallons sprayed, at completion ──────────────────────────────────────────

// Set on a product row by the server after it converted the row's gallons. A symbol cannot arrive in a JSON body, so a sheet can never
// claim a conversion the server did not make.
const FROM_GALLONS = Symbol('lawnAreaFromGallons');

const refusal = (status, code, error, extra = {}) => ({ status, payload: { error, code, ...extra } });
const asked = (row) => row.sprayedGallons !== undefined && row.sprayedGallons !== null && row.sprayedGallons !== '';

// The gallons a row states: a finite number above zero, given as a number or a plain decimal string. Anything else (Infinity, NaN,
// an exponent string, a boolean, an array or an object) is not a quantity a technician typed, so it is refused, never coerced.
const gallonsOf = (row) => {
  const raw = row.sprayedGallons;
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const monthOfVisit = (svc) => Number(String(require('../utils/datetime-et').etCalendarDayOf(svc.scheduled_date) || '').slice(5, 7)) || null;

// The staged rows of the asked products, or null when the plan or the rows could not be read (the caller refuses, retryably).
async function gallonsStaged({ knex, svc, wanted, loadPlan, readStaged }) {
  try {
    const loaded = await loadPlan(svc, knex);
    const ids = [...new Set(wanted.map((row) => String(row.productId || '').toLowerCase()))];
    return await readStaged({ knex, protocolId: loaded?.plan?.protocol?.structured?.id, productIds: ids });
  } catch (err) {
    logger.warn(`[lawn-mix-help] gallons unreadable for ${svc?.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

// Each asked row gets its area from its own staged carrier and is marked, or the step refuses (400, enter the area instead).
function convertGallons(wanted, staged, month) {
  for (const row of wanted) {
    const agreed = agreedRow(staged.get(String(row.productId || '').toLowerCase()) || [], month);
    const carrier = agreed && agreed.mode === 'spot' && !agreed.concentration ? positive(agreed.carrierGalPer1000) : null;
    const area = areaFromGallons(gallonsOf(row), carrier);
    if (!area) return refusal(400, 'lawn_gallons_unavailable', 'Gallons sprayed cannot be used for this product. Enter the area instead.', { productId: row.productId });
    row.areaValue = area;
    row.areaUnit = 'sqft';
    row[FROM_GALLONS] = { gallons: gallonsOf(row), carrierGalPer1000: carrier, areaSqft: area };
  }
  return null;
}

/**
 * The completion's gallons step (called by the lawn Fast Complete preflight, before the places are judged): every product row that
 * carries `sprayedGallons` gets its recorded spot area from the gallons and the product's STAGED carrier (areaFromGallons), replacing
 * whatever area the sheet sent, and is marked. null = nothing to refuse; otherwise `{ status, payload }`:
 *   400 lawn_gallons_invalid       not a positive number, or more than MAX_GALLONS (40: ten fills of the largest tank)
 *   400 lawn_gallons_unavailable   no spot row with a carrier volume on file for the product, or the submitted row is not a spot row as
 *                                  persistence resolves the method (enter the area instead)
 *   400 lawn_gallons_unavailable_now  the staged rows or the plan could not be read. A named PRE-COMMIT refusal (nothing is written): a 4xx,
 *                                  so the shared submit hook treats it as correctable (fresh key, form editable) and the tech can enter the
 *                                  area instead; a 5xx would lock the form to the same body and key
 * While the gate is off the field is ignored and the row is exactly what the sheet sent. Input: `{ knex, svc, products, loadPlan }`
 * (`loadPlan(svc, knex)` is the sheet's plan reader) plus, for tests, `isLive` and `readStaged`.
 */
async function applyGallons(input) {
  const { knex, svc, products, loadPlan, isLive, readStaged, readSpotRows } = { ...DEPS, ...input };
  const rows = (Array.isArray(products) ? products : []).filter((row) => row && typeof row === 'object');
  for (const row of rows) delete row[FROM_GALLONS];
  const wanted = rows.filter(asked);
  if (!wanted.length || !isLive()) return null;
  const bad = wanted.find((row) => gallonsOf(row) === null || gallonsOf(row) > MAX_GALLONS);
  if (bad) return refusal(400, 'lawn_gallons_invalid', `Enter the gallons sprayed as a number above zero (up to ${MAX_GALLONS}), or enter the area instead.`, { productId: bad.productId });
  const staged = await gallonsStaged({ knex, svc, wanted, loadPlan, readStaged });
  const spot = staged && await readSpotRows(knex, wanted).catch(() => null);
  if (!staged || !spot) return refusal(400, 'lawn_gallons_unavailable_now', 'Could not check the gallons just now. Try again in a moment, or enter the area instead.');
  // The SUBMITTED row must be a spot row as persistence resolves the method (inferServiceReportApplicationMethod, as preflightPlaces does): a
  // row sent as a whole-lawn method keeps the area it carries, so gallons never overwrite it.
  const notSpot = wanted.find((row) => !spot.includes(row));
  if (notSpot) return refusal(400, 'lawn_gallons_unavailable', 'Gallons sprayed cannot be used for this product. Enter the area instead.', { productId: notSpot.productId });
  return convertGallons(wanted, staged, monthOfVisit(svc));
}

/** Runs the gallons step, then `next()` (the places check) unless the gallons step refused. One expression for the preflight's last line. */
async function withSprayedGallons({ knex, svc, products, loadPlan }, next) {
  return (await applyGallons({ knex, svc, products, loadPlan })) || next();
}

/**
 * The completion record of the rows whose area the server derived from gallons: `{ lawnSprayedGallons: { v: 1, rows } }` to spread into
 * structured_notes, or `{}` when no row was. Read from the server's own marks (symbols), never from the request.
 */
function sprayedGallonsFreeze(products) {
  const rows = (Array.isArray(products) ? products : [])
    .filter((row) => row && typeof row === 'object' && row[FROM_GALLONS])
    .map((row) => ({ productId: String(row.productId).toLowerCase(), ...row[FROM_GALLONS] }))
    .slice(0, 50);
  return rows.length ? { lawnSprayedGallons: { v: 1, rows } } : {};
}

module.exports = {
  TANKS,
  LABEL_LINES,
  unitOf,
  volumeShare,
  areaFromGallons,
  MAX_GALLONS,
  tankDoses,
  entryFor,
  agreedRow,
  stagedRows,
  weedOrder,
  contextBlock,
  applyGallons,
  withSprayedGallons,
  sprayedGallonsFreeze,
  FROM_GALLONS,
};
