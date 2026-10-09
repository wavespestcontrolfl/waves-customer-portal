/**
 * Places and trouble areas of the lawn Fast Complete sheet (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09).
 *
 * Three parts, all behind the one gate (lawnTroubleAreasLive, which also needs the spot rules and the v13
 * program), all for the technician sheet and the office: nothing here reaches a customer text, a report
 * or a public payload.
 *
 *   1. A PLACE on every spot-treatment row: one of a closed list (PLACES). The lawn has no named zone model
 *      (the treatment-zone map holds drawn outlines, the photo shots hold three views), so the list is fixed.
 *      The place rides the /complete product row as `areaPlace`, is stored on the product record
 *      (service_products.treated_place) and on the application ledger row (treated_place).
 *   2. A per-property store of TROUBLE AREAS (lawn_trouble_areas): one row per (property, place, type).
 *      The completion writes it from the spot rows that carry a place (the first writer wins, a later visit
 *      moves last seen / last treated and reactivates a cleared area). The context reads it for a compact
 *      "Known trouble areas" line and the default place of a matching row; a technician can clear one.
 *   3. The yearly LIMITS per place: the v13 caps (count 2, the Arena 56-day interval, the Arena yearly
 *      amount) are judged per (property, place) for spot rows with a place (application-limits
 *      checkLimits opts.place). A ledger row with no place on record counts at EVERY place. This module
 *      reads the plan's own limit reader once per place, so the sheet decides instantly and /complete
 *      asks the same reader again (preflightPlaces).
 *
 * No limit value is added or changed here. A limit read that fails is the existing "unknown": the sheet
 * and the completion keep their old behavior (record, flag the office); it is never read as "allowed".
 */
const db = require('../models/db');
const logger = require('./logger');
const { etCalendarDayOf } = require('../utils/datetime-et');

const PLACES = Object.freeze([
  Object.freeze({ id: 'front', label: 'Front' }),
  Object.freeze({ id: 'back', label: 'Back' }),
  Object.freeze({ id: 'left_side', label: 'Left side' }),
  Object.freeze({ id: 'right_side', label: 'Right side' }),
]);
const PLACE_IDS = Object.freeze(PLACES.map((place) => place.id));
const PLACE_LABELS = Object.freeze(Object.fromEntries(PLACES.map((place) => [place.id, place.label])));

const TYPES = Object.freeze([
  Object.freeze({ id: 'weeds', label: 'Weeds' }),
  Object.freeze({ id: 'fungus', label: 'Fungus' }),
  Object.freeze({ id: 'take_all', label: 'Take-all' }),
  Object.freeze({ id: 'chinch', label: 'Chinch bugs' }),
  Object.freeze({ id: 'other_insect', label: 'Insects' }),
  Object.freeze({ id: 'dry_spot', label: 'Dry spot' }),
]);
const TYPE_IDS = Object.freeze(TYPES.map((type) => type.id));
const TYPE_LABELS = Object.freeze(Object.fromEntries(TYPES.map((type) => [type.id, type.label])));
const SOURCES = Object.freeze(['tech_tap', 'guide_card']);


const isPlace = (value) => typeof value === 'string' && PLACE_IDS.includes(value);
const placeLabel = (id) => PLACE_LABELS[id] || id;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const live = () => require('../config/feature-gates').lawnTroubleAreasLive();

// The property the places work on for a visit: the visit's own link, else what the property-area flow resolves from the visit's address
// or the customer's sole property (property-service-areas resolveVisitPropertyId: the one shared resolver). null = the gate is off or the
// property cannot be resolved: the places are OFF for that visit (no place asked, none stored or judged), as if the gate were off.
// A visit that has its own property_id uses it as is (that is the resolver's first evidence); only the nullable case reads. Read once per svc.
const resolved = new WeakMap();
async function propertyOf(knex, svc) {
  if (!live() || !svc) return null;
  if (svc.property_id) return svc.property_id;
  if (!svc.customer_id) return null;
  if (!resolved.has(svc)) {
    resolved.set(svc, require('./property-service-areas').resolveVisitPropertyId(svc, knex).catch((err) => {
      logger.warn(`[lawn-trouble-areas] visit property unresolved for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
      return null;
    }));
  }
  return resolved.get(svc);
}

// The closed list as the context sends it (the sheet draws no place of its own).
const placeChoices = () => PLACES.map((place) => ({ id: place.id, label: place.label }));

// ── type of an area ─────────────────────────────────────────────────────────

const CATEGORY_TYPE = Object.freeze({ herbicide: 'weeds', fungicide: 'fungus', insecticide: 'other_insect' });
// The sheet's own word for what a row was opened for (the guide card or entry), when the catalog category alone
// cannot say it (Arena is an insecticide, the chinch tap says chinch).
const sourceOf = (value) => (value === 'guide_card' ? 'guide_card' : 'tech_tap');

/**
 * The trouble-area type a spot row stands for, or null (a product that is not a treatment of one: an adjuvant
 * alone, a fertilizer). The sheet's `troubleType` hint wins when it is on the closed list; else the catalog
 * category decides. Pure.
 */
function troubleTypeFor({ category, hint = null, takeAll = false, chinch = false, chinchOnly = false }) {
  const byCategory = CATEGORY_TYPE[String(category || '').trim().toLowerCase()] || null;
  // The server's own staged sets decide the special products, whatever the sheet said: a take-all row is always take_all, and the chinch
  // ladder's chinch-only first rung is always chinch. The shared later rung (Talak is also the caterpillar product) is chinch only when
  // the sheet says so AND the server confirms it is a rung of the ladder. The hint is never trusted to CREATE take_all or chinch.
  if (takeAll) return 'take_all';
  if (chinchOnly) return 'chinch';
  if ((hint === 'take_all') || (hint === 'chinch' && !chinch)) return byCategory;
  if (TYPE_IDS.includes(hint)) return hint;
  return byCategory;
}

// ── the store ───────────────────────────────────────────────────────────────

const dayOf = (value) => (value ? etCalendarDayOf(value) : null);

/**
 * The property's ACTIVE trouble areas, newest treatment first, as the context shows them:
 * `{ id, place, placeLabel, type, typeLabel, lastTreatedOn }`. A read failure throws (the caller records it
 * and sends an empty line; nothing is invented).
 */
async function loadActive(knex, propertyId) {
  if (!propertyId || !UUID_RE.test(String(propertyId))) return [];
  const rows = await knex('lawn_trouble_areas')
    .where({ property_id: propertyId, status: 'active' })
    .orderByRaw('last_treated_on DESC NULLS LAST, created_at DESC')
    .select('id', 'place', 'type', 'last_treated_on', 'last_seen_on');
  return rows.map((row) => ({
    id: row.id,
    place: row.place,
    placeLabel: placeLabel(row.place),
    type: row.type,
    typeLabel: TYPE_LABELS[row.type] || row.type,
    lastTreatedOn: dayOf(row.last_treated_on || row.last_seen_on),
  }));
}

/**
 * Writes the store from a completion's spot rows. `rows` are `{ place, type, source }` (already validated:
 * a closed-list place and type), one entry per treated spot. The first writer wins per (property, place,
 * type) (first seen, source, first record); a later treatment moves last seen, last treated and the last
 * record and reactivates a cleared area (only when the treatment day is not before the day it was cleared: a backdated completion keeps it cleared). Idempotent, so a durable-completion resume or a retry writes no
 * second row. Runs inside the completion's transaction through `trx`; returns the number of areas written.
 */
async function recordFromCompletion(trx, { svc, record, rows }) {
  const propertyId = svc?.property_id || null;
  if (!propertyId || !record?.id || !Array.isArray(rows) || !rows.length) return 0;
  const day = dayOf(record.service_date) || dayOf(svc.scheduled_date);
  const unique = new Map();
  for (const row of rows) {
    if (!isPlace(row.place) || !TYPE_IDS.includes(row.type)) continue;
    const key = `${row.place}:${row.type}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  for (const row of unique.values()) {
    await trx.raw(
      `INSERT INTO lawn_trouble_areas
         (customer_id, property_id, place, type, status, source, first_seen_on, last_seen_on, last_treated_on, first_service_record_id, last_service_record_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (property_id, place, type) DO UPDATE SET
         status = CASE WHEN lawn_trouble_areas.status = 'cleared' AND EXCLUDED.last_treated_on < (lawn_trouble_areas.cleared_at AT TIME ZONE 'America/New_York')::date
                       THEN 'cleared' ELSE 'active' END,
         cleared_at = CASE WHEN lawn_trouble_areas.status = 'cleared' AND EXCLUDED.last_treated_on < (lawn_trouble_areas.cleared_at AT TIME ZONE 'America/New_York')::date
                           THEN lawn_trouble_areas.cleared_at END,
         cleared_by_technician_id = CASE WHEN lawn_trouble_areas.status = 'cleared' AND EXCLUDED.last_treated_on < (lawn_trouble_areas.cleared_at AT TIME ZONE 'America/New_York')::date
                                         THEN lawn_trouble_areas.cleared_by_technician_id END,
         last_seen_on = GREATEST(lawn_trouble_areas.last_seen_on, EXCLUDED.last_seen_on),
         last_service_record_id = CASE
           WHEN lawn_trouble_areas.last_treated_on IS NULL OR EXCLUDED.last_treated_on >= lawn_trouble_areas.last_treated_on
           THEN EXCLUDED.last_service_record_id ELSE lawn_trouble_areas.last_service_record_id END,
         last_treated_on = GREATEST(COALESCE(lawn_trouble_areas.last_treated_on, EXCLUDED.last_treated_on), EXCLUDED.last_treated_on),
         updated_at = now()`,
      [svc.customer_id, propertyId, row.place, row.type, sourceOf(row.source), day, day, day, record.id, record.id],
    );
  }
  return unique.size;
}

/**
 * Clears one ACTIVE trouble area of the visit's property (a technician's one tap and confirm). The property
 * scope is part of the update, so an id from another lawn clears nothing. Returns the cleared area, or null.
 */
async function clearArea(knex, { areaId, propertyId, technicianId = null }) {
  if (!propertyId || !UUID_RE.test(String(areaId || ''))) return null;
  const [row] = await knex('lawn_trouble_areas')
    .where({ id: areaId, property_id: propertyId, status: 'active' })
    .update({
      status: 'cleared',
      cleared_at: knex.fn.now(),
      cleared_by_technician_id: technicianId && UUID_RE.test(String(technicianId)) ? technicianId : null,
      updated_at: knex.fn.now(),
    })
    .returning(['id', 'place', 'type']);
  return row || null;
}

// ── the product record ──────────────────────────────────────────────────────

/**
 * The area rows a completion writes to the store: the spot rows (by the method the completion resolved) that carry
 * a closed-list place and resolve to a type. `requestRows` are the /complete product rows (the sheet's hints);
 * `inserted` the service_products rows just written (treated_place, product_id, application_method) and `catalog`
 * a Map of catalog rows by product id.
 */
function areaRowsOf({ requestRows, inserted, catalog, confirmed = null, readFailed = false }) {
  const byProduct = new Map((requestRows || []).filter((row) => row?.productId).map((row) => [String(row.productId).toLowerCase(), row]));
  const out = [];
  for (const sp of inserted || []) {
    if (!isPlace(sp.treated_place) || sp.application_method !== 'spot_treatment') continue;
    const request = byProduct.get(String(sp.product_id || '').toLowerCase()) || {};
    const product = catalog?.get?.(String(sp.product_id).toLowerCase()) || null;
    const id = String(sp.product_id).toLowerCase();
    const category = product?.category || sp.product_category;
    // A staged-set read that failed leaves a row that could be a take-all or chinch row unclassified: its area is not stored (the
    // application itself is). A wrong generic area, or one that skips the mapped-place rule, is worse than none.
    if (readFailed && couldBeSpecial(category, request.troubleType)) {
      logger.warn(`[lawn-trouble-areas] staged sets unavailable: no area stored for product ${id}`);
      continue;
    }
    const type = troubleTypeFor({ category, hint: request.troubleType, takeAll: !!confirmed?.takeAll?.has(id), chinch: !!confirmed?.chinch?.has(id), chinchOnly: !!confirmed?.chinchOnly?.has(id) });
    if (type) out.push({ place: sp.treated_place, type, source: request.troubleSource });
  }
  return out;
}

// Whether a row's product could be a take-all fungicide or a chinch rung: a fungicide or an insecticide, or a row the sheet tagged so.
const couldBeSpecial = (category, hint) => ['fungicide', 'insecticide'].includes(String(category || '').trim().toLowerCase()) || hint === 'take_all' || hint === 'chinch';

// The place a completion stores for a product row: only a spot row, only a closed-list place.
const storedPlace = (applicationMethod, value) => (applicationMethod === 'spot_treatment' && isPlace(value) ? value : null);

/**
 * The place column of a product record being inserted: `{ treated_place }` for a spot row that carries a closed-list place while the
 * gate is live and the column exists, else `{}` (the insert is then the same statement as before the gate). `cols` is the table's
 * columnInfo, `input` the /complete product row.
 */
function placeFields({ cols, applicationMethod, input, enabled = true }) {
  const place = live() && enabled && cols?.treated_place ? storedPlace(applicationMethod, typeof input?.areaPlace === 'string' ? input.areaPlace.trim() : null) : null;
  return place ? { treated_place: place } : {};
}

// The place column of a ledger row from its product record: `{ treated_place }` when the record carries one, else `{}`.
const ledgerPlace = (serviceProduct) => (serviceProduct?.treated_place ? { treated_place: serviceProduct.treated_place } : {});

/**
 * The completion's store write (inside its transaction, after the ledger): the spot rows that carry a place become trouble areas.
 * Secondary to the completion: nothing happens while the gate is off or no row carries a place, and a failed write is logged and never
 * fails the visit (savepointScope keeps the transaction usable).
 */
async function recordStore(trx, { svc, record, products, inserted, catalog, confirm = null }) {
  if (!live() || !inserted.some((sp) => sp.treated_place)) return;
  const { savepointScope } = require('../utils/savepoint-read');
  try {
    // The places are off for a visit whose property cannot be resolved (the same property the context and the preflight used).
    const propertyId = await propertyOf(trx, svc);
    if (!propertyId) return;
    const scoped = { ...svc, property_id: propertyId };
    // The server's staged sets (take-all rows, chinch rungs) classify the special products whatever the sheet said. They are read once, and
    // only when a placed row could need them; a read that fails stores nothing for such a row (areaRowsOf).
    const byProduct = new Map((products || []).filter((row) => row?.productId).map((row) => [String(row.productId).toLowerCase(), row]));
    const needs = inserted.some((sp) => sp.treated_place && sp.application_method === 'spot_treatment'
      && couldBeSpecial(catalog?.get?.(String(sp.product_id).toLowerCase())?.category || sp.product_category, byProduct.get(String(sp.product_id || '').toLowerCase())?.troubleType));
    const confirmed = needs && confirm ? await confirm().catch(() => null) : null;
    let rows = areaRowsOf({ requestRows: products, inserted, catalog, confirmed, readFailed: needs && !confirmed });
    // A take-all row from the guide CARD maps nothing new (the preflight holds it to a mapped place): never store one at an unmapped place.
    if (rows.some((row) => row.type === 'take_all' && row.source === 'guide_card')) {
      const mapped = new Set((await loadActive(trx, propertyId)).filter((area) => area.type === 'take_all').map((area) => area.place));
      rows = rows.filter((row) => !(row.type === 'take_all' && row.source === 'guide_card' && !mapped.has(row.place)));
    }
    await savepointScope(trx, (k) => module.exports.recordFromCompletion(k, { svc: scoped, record, rows }));
  } catch (err) {
    logger.warn(`[dispatch] trouble-area store write failed (non-blocking) for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
  }
}

// ── the limits, per place ───────────────────────────────────────────────────

/**
 * The plan's own limit reader (v13VisitLimits) for some products at each place: `{ wide, byPlace }`, where `wide`
 * is the per-lawn read (a Map of product id -> hard blocks, as the plan reads it) and `byPlace[place]` the same
 * map judged at that place. A product blocked nowhere lawn-wide cannot be blocked at a place (the history at a
 * place is a part of the lawn's), so only the products blocked lawn-wide are read again, once per place. A read
 * that fails comes back as a block with no limit type, exactly as in the plan (fail closed, per product).
 * `products` are `{ id, name }`; `rows` the staged v13 protocol rows.
 */
async function cappedByPlace({ knex, svc, products, rows }) {
  const engine = require('./waveguard-plan-engine');
  const lines = (list) => list.map((product) => ({ selected: true, product }));
  const list = [...new Map((products || []).filter((p) => p?.id).map((p) => [String(p.id), p])).values()];
  const wide = (await engine.v13VisitLimits(knex, svc, lines(list), rows, {})).capped;
  const blocked = list.filter((product) => wide.has(String(product.id)));
  const byPlace = {};
  for (const place of PLACE_IDS) {
    byPlace[place] = blocked.length
      ? (await engine.v13VisitLimits(knex, svc, lines(blocked), rows, {}, { place })).capped
      : wide;
  }
  return { wide, byPlace };
}

/**
 * The context's `blocked` map: `{ [productId]: { [place]: message } }` for the products a TYPED limit closes at a
 * place (only those the lawn-wide read blocked can be), from a cappedByPlace result. A typeless block (an unreadable
 * limit) is not listed: the sheet's existing unreadable handling stays. Pure.
 */
function blockedMap({ wide, byPlace }) {
  const out = {};
  for (const [id, place, block] of typedBlocks({ wide, byPlace })) (out[id] = out[id] || {})[place] = block.message || 'A yearly limit is reached for this place.';
  return out;
}

/**
 * The limit type of each entry of blockedMap, `{ [productId]: { [place]: limitType } }` (same keys). The sheet needs it because a
 * block of the yearly AMOUNT (`annual_max_rate`) depends on the dose the tech enters, while a count or an interval block does not:
 * a refresh judges the program dose, so the chip reopens when the row's own dose changes. Pure.
 */
function blockedTypeMap({ wide, byPlace }) {
  const out = {};
  for (const [id, place, block] of typedBlocks({ wide, byPlace })) (out[id] = out[id] || {})[place] = block.type;
  return out;
}

function* typedBlocks({ wide, byPlace }) {
  for (const [id] of wide) {
    for (const place of PLACE_IDS) {
      const block = (byPlace[place].get(id) || []).find((b) => b.type);
      if (block) yield [id, place, block];
    }
  }
}

/**
 * The troubleAreas block of the lawn Fast Complete context, or `{}` (gate off): the closed list of places, the
 * lawn's known areas and the products a limit closes at a place.
 *   { troubleAreas: { v: 1, places, known, knownUnavailable, blocked } }
 */
async function buildContextBlock({ knex, svc, seed = null, readFailures, extraIds = null, products = seed?.products || [], rows = seed?.rows || new Map() }) {
  // Gate off, or a visit whose property cannot be resolved: no troubleAreas, so the sheet asks for no place (see propertyOf).
  const propertyId = await propertyOf(knex, svc);
  if (!propertyId) return {};
  const failed = (what, name) => (err) => {
    logger.warn(`[lawn-trouble-areas] ${what} unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add(name);
    return null;
  };
  // Products the sheet names that the month's recipe does not (Search-added rows, sent after /complete refused a place) are read too.
  const named = await withSearched(knex, products, extraIds).catch(failed('searched products', 'trouble_area_limits')) || products;
  const known = await loadActive(knex, propertyId).catch(failed('known areas', 'trouble_areas'));
  const read = await cappedByPlace({ knex, svc, products: named, rows }).catch(failed('place limits', 'trouble_area_limits'));
  return { troubleAreas: { v: 1, places: placeChoices(), known: known || [], knownUnavailable: known === null, blocked: read ? blockedMap(read) : {}, blockedTypes: read ? blockedTypeMap(read) : {} } };
}

const MAX_SEARCHED_PRODUCTS = 20;

// The products plus the named ids not already among them, with their catalog names ({ id, name }). Ids that are not uuids are ignored.
async function withSearched(knex, products, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).toLowerCase()).filter((id) => UUID_RE.test(id)))].slice(0, MAX_SEARCHED_PRODUCTS)
    .filter((id) => !products.some((product) => String(product.id).toLowerCase() === id));
  if (!wanted.length) return products;
  const found = await knex('products_catalog').whereIn('id', wanted).select('id', 'name');
  return [...products, ...found.map((row) => ({ id: row.id, name: row.name }))];
}

/**
 * The per-place blocks of products the sheet names (`ids`), in the context's shape: every product read has an entry (empty = open at every
 * place), a typed block names the place. Used by the treatment-guide answer for Search-added rows outside the month's recipe.
 */
async function searchedPlaceBlocks({ knex, svc, rows, ids }) {
  const products = await withSearched(knex, [], ids);
  if (!products.length) return { blocked: {}, types: {} };
  const result = await cappedByPlace({ knex, svc, products, rows });
  return { blocked: { ...Object.fromEntries(products.map((product) => [String(product.id), {}])), ...blockedMap(result) }, types: blockedTypeMap(result) };
}

// ── the /complete preflight ─────────────────────────────────────────────────

/**
 * The submitted rows the completion will record as SPOT treatments, by the very function the persistence uses
 * (complete-scheduled-service inferServiceReportApplicationMethod, same inputs: the catalog row, the submitted row with its `method` alias,
 * the lawn service line), so a row that omits its method, uses the alias or rides the catalog default is judged exactly as it will be stored.
 */
async function spotRowsOf(knex, products) {
  const { inferServiceReportApplicationMethod } = require('./complete-scheduled-service');
  const rows = (Array.isArray(products) ? products : []).filter((row) => row && typeof row === 'object');
  const ids = [...new Set(rows.map((row) => String(row.productId || '').toLowerCase()).filter((id) => UUID_RE.test(id)))];
  const catalog = new Map((ids.length ? await knex('products_catalog').whereIn('id', ids).select('*') : []).map((row) => [String(row.id).toLowerCase(), row]));
  return rows.filter((row) => inferServiceReportApplicationMethod(catalog.get(String(row.productId || '').toLowerCase()) || {}, row, 'lawn') === 'spot_treatment');
}

const UNMAPPED_REASON = 'Take-all is treated on mapped take-all areas only. Pick a mapped place, or add the fungicide through Search to map a new one.';

/**
 * The mapped-places rule for a take-all row that came from the guide CARD (`troubleSource: 'guide_card'`, the deliberate card the sheet
 * offers for the lawn's mapped areas): its place must hold an active take_all area of the property (400 lawn_place_not_mapped). A take-all row
 * that came through Search (`troubleSource: 'tech_tap'`) is the deliberate path that maps a NEW area and is not held to it. Only a product the
 * server itself identifies as a take-all row counts, so a mislabelled claim on any other product enforces nothing.
 */
async function unmappedRefusal({ knex, svc, spots, propertyId }) {
  // The card path is decided by the row's source alone; whether the PRODUCT is a take-all row is the server's call, never the sheet's tag.
  const claims = spots.filter((row) => row.troubleSource === 'guide_card' && isPlace(String(row.areaPlace || '').trim()));
  if (!claims.length) return null;
  let takeAll;
  try {
    takeAll = (await require('./lawn-fast-complete').troubleTypeIdsFor(svc, knex)).takeAll;
  } catch (err) {
    // A read failure never refuses the completion; the store then keeps a card take-all row off any unmapped place (recordStore).
    logger.warn(`[lawn-trouble-areas] take-all products unavailable at completion for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
  const rows = claims.filter((row) => takeAll.has(String(row.productId || '').toLowerCase()));
  if (!rows.length) return null;
  const mapped = new Set((await loadActive(knex, propertyId)).filter((area) => area.type === 'take_all').map((area) => area.place));
  const bad = rows.find((row) => !mapped.has(row.areaPlace.trim()));
  return bad ? { status: 400, payload: { error: UNMAPPED_REASON, code: 'lawn_place_not_mapped', productId: String(bad.productId).toLowerCase(), place: bad.areaPlace.trim() } } : null;
}

// Every spot row names a closed-list place, or the first refusal.
function placeRefusal(spots) {
  for (const row of spots) {
    const place = typeof row.areaPlace === 'string' ? row.areaPlace.trim() : '';
    if (!place) return requiredRefusal((typeof row.name === 'string' && row.name.trim()) || null);
    if (!isPlace(place)) return { status: 400, payload: { error: 'That place is not on the list. Pick Front, Back, Left side or Right side.', code: 'lawn_place_invalid' } };
  }
  return null;
}

const requiredRefusal = (name) => ({
  status: 400,
  payload: { error: `Pick where on the lawn ${name || 'the spot treatment'} went.`, code: 'lawn_place_required' },
});

// The row as the completion will record it on the ledger (compliance.createComplianceRecords): the rate and its unit, the typed
// quantity in its base unit (a "/gal" mix concentration is stored as the base unit) and the spot area rounded to whole square feet.
// application-limits sizes it with the function that sizes a recorded ledger row, so a large typed quantity on a small spot counts
// at quantity over the row's own area, exactly as the closeout audit will count it.
function proposedRow(row) {
  const { baseQuantityUnit } = require('./inventory-units');
  const rate = parseFloat(row?.rate);
  const quantity = row?.totalAmount != null && row.totalAmount !== '' ? parseFloat(row.totalAmount) : null;
  const area = row?.areaUnit === 'sqft' && Number(row.areaValue) > 0 ? Math.round(Number(row.areaValue)) : null;
  return {
    application_rate: rate || null,
    rate_unit: row?.rateUnit || null,
    quantity_applied: Number.isFinite(quantity) ? quantity : null,
    quantity_unit: Number.isFinite(quantity) ? baseQuantityUnit(row.amountUnit || row.rateUnit || null) || null : null,
    area_treated_sqft: area,
  };
}

// The limit types a place may refuse at completion: the product's OWN count, minimum interval and v13 yearly amount, the three the
// closeout audit judges (application-limits auditHardCountLimits). The shared active-ingredient cap, a stored yearly rate,
// MOA rotation and everything else stay advisory after the fact, exactly as before the gate.
function refusesAtPlace(block) {
  const matchType = block.matchType || 'product';
  if (block.type === 'annual_max_apps' || block.type === 'min_interval_days') return matchType === 'product';
  return block.type === 'annual_max_rate' && matchType === 'v13_amount';
}

/**
 * The /complete preflight of the places (called from preflightLawnFastCompletion while the gate is live): every spot
 * row names a closed-list place (400 lawn_place_required / lawn_place_invalid), and the place the cap forbids is
 * refused (400 lawn_place_limit, the limit's own words), by the SAME reader the sheet followed
 * (application-limits checkLimits at that place, as a proposal on the visit's date, the visit's own rows left out).
 * Only the product's own count, interval and yearly amount refuse here. A read that fails refuses nothing: it is the
 * existing "unknown" (the completion records the visit and flags the office), never "allowed" by this check.
 * Returns `{ status, payload }` or null.
 */
async function preflightPlaces({ knex = db, svc, products }) {
  // The places are off for a visit whose property cannot be resolved: nothing is asked and nothing is judged, as with the gate off.
  const propertyId = await propertyOf(knex, svc);
  if (!propertyId) return null;
  const spots = await spotRowsOf(knex, products);
  const missing = placeRefusal(spots);
  if (missing) return missing;
  const unmapped = await unmappedRefusal({ knex, svc, spots, propertyId });
  if (unmapped) return unmapped;
  const limits = require('./application-limits');
  const day = !svc.scheduled_date ? new Date() : svc.scheduled_date instanceof Date ? svc.scheduled_date : new Date(`${etCalendarDayOf(svc.scheduled_date)}T12:00:00`);
  const seen = new Set();
  for (const row of spots) {
    const productId = String(row.productId || '').toLowerCase();
    if (!UUID_RE.test(productId)) continue; // the main flow refuses a malformed id with its own code
    if (seen.has(`${productId}:${row.areaPlace}`)) continue;
    seen.add(`${productId}:${row.areaPlace}`);
    let result;
    try {
      // Two rules of the same kind. (1) Two completions for the same lawn, place and product that both pass here before either commits are
      // both RECORDED: each records an application that already happened, so a refusal inside the transaction could only drop a real one
      // from the ledger. The closeout audit runs after each commit (complete-scheduled-service.js, after persistRecord) on its own
      // connection, so the later-committing completion always sees both rows and raises the alert; no ordering leaves both blind.
      // (2) The rule for a backdated completion: it is RECORDED and FLAGGED, never refused, because the application already happened.
      // checkLimits reads the history up to the visit's own day (application-limits.js, priorApplications), so an application recorded
      // LATER than this visit (a September visit completed after an October one at the same place) is not held against it here; the
      // closeout audit (auditHardCountLimits) judges both sides of the date and raises the office alert after the commit.
      result = await limits.checkLimits(svc.customer_id, productId, day, knex, {
        propertyId,
        place: row.areaPlace.trim(),
        proposal: true,
        proposedRow: proposedRow(row),
        excludeScheduledServiceId: svc.id,
      });
    } catch (err) {
      logger.warn(`[lawn-trouble-areas] place limits unavailable at completion for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
      continue;
    }
    const block = (result.blocks || []).find(refusesAtPlace);
    if (block) {
      // 400, not 409: the shared submit hook treats a 4xx other than a 409 conflict as correctable (a fresh key and an editable
      // sheet), which is what the technician needs: pick another place or take the row off, then complete again.
      return {
        status: 400,
        payload: {
          error: `${block.message} Choose another place, or take it off the sheet.`,
          code: 'lawn_place_limit',
          productId,
          place: row.areaPlace.trim(),
          limitType: block.type,
        },
      };
    }
  }
  return null;
}

module.exports = {
  PLACES,
  PLACE_IDS,
  TYPES,
  TYPE_IDS,
  SOURCES,
  refusesAtPlace,
  proposedRow,
  isPlace,
  placeLabel,
  placeChoices,
  troubleTypeFor,
  loadActive,
  recordFromCompletion,
  clearArea,
  areaRowsOf,
  storedPlace,
  placeFields,
  ledgerPlace,
  recordStore,
  cappedByPlace,
  propertyOf,
  blockedMap,
  blockedTypeMap,
  buildContextBlock,
  searchedPlaceBlocks,
  preflightPlaces,
};
