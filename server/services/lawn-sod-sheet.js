'use strict';

/**
 * The lawn Fast Complete sheet applies the new-sod holds (GATE_LAWN_NEW_SOD_NOTE,
 * owner 2026-10-09). The office records sod someone else laid on the customer's
 * property preferences (sod_laid_on, sod_covers, sod_area, sod_rooted_on) and
 * lawn-sod-holds.js says what a visit on a given day holds back. This module is
 * the glue between that pure rule module and the sheet:
 *
 *   - loadSodForContext: for one visit, the record (only when the visit is at the
 *     home it belongs to), its holds on the visit's day, the product lines each
 *     hold covers, the October bag swap and the banner words. Technician sheet
 *     only; it never writes, texts or emails.
 *   - confirmSodRooted: the one write, the technician's "Sod mowed twice and does
 *     not lift" tick, which saves sod_rooted_on.
 *
 * No hold rule is restated here: every date, scope and swap decision is read
 * from sodHolds(). What this module adds is only (1) which catalog product
 * belongs to which hold class, and (2) the plain words the sheet prints.
 *
 * How a product is placed in a hold class (from its catalog row, never from the
 * sheet):
 *   preEmergent  active ingredient is one of PRE_EMERGENT_INGREDIENTS (prodiamine,
 *                dithiopyr, ...). A combination bag (Dimension 18-0-10, Stonewall
 *                15-0-15) is a pre-emergent AND a fertilizer.
 *   fertilizer   analysis_n > 0 and the product is a granular (spreader) bag, or the
 *                plan's own method for the line is granular broadcast. Nutra-TECH
 *                (liquid micronutrient, hose) is therefore never held.
 *   weedKiller   category is a herbicide that is not a pre-emergent (Celsius,
 *                Certainty, Blindside, Dismiss), and every product of the Weed spots
 *                group (plannedProducts.weedMix.groupProductIds, which also holds
 *                the surfactant). Artavia, Headway and Velista are fungicides:
 *                not held.
 *   tetrino      active ingredient tetraniliprole (catalog name Tetrino as a fallback).
 *   dylox        active ingredient trichlorfon (catalog name Dylox as a fallback).
 *   fungicideGravex  active ingredient myclobutanil (catalog name Gravex as a
 *                fallback: the catalog row carries no active ingredient yet).
 */

const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { sodHolds, SOD_SWAP_BAG, swapBagFor } = require('./lawn-sod-holds');
const { formatDay } = require('./lawn-sod-form-summary');
const { etCalendarDayOf, validCalendarDate } = require('../utils/datetime-et');

const PRE_EMERGENT_INGREDIENTS = Object.freeze([
  'prodiamine', 'dithiopyr', 'pendimethalin', 'oxadiazon', 'indaziflam', 'isoxaben', 'benefin', 'bensulide',
]);

// Brand-name fallbacks for classes the catalog may not carry an active ingredient for.
const NAME_FALLBACK = Object.freeze({
  tetrino: /^\s*tetrino\b/i,
  dylox: /^\s*dylox\b/i,
  fungicideGravex: /^\s*gravex\b/i,
});
const INGREDIENT = Object.freeze({
  tetrino: 'tetraniliprole',
  dylox: 'trichlorfon',
  fungicideGravex: 'myclobutanil',
});

// Plain labels, in the order the banner lists them.
const CLASS_LABELS = Object.freeze({
  fertilizer: 'Fertilizer',
  weedKiller: 'Weed killer',
  preEmergent: 'Pre-emergent',
  tetrino: 'Tetrino',
  dylox: 'Dylox',
  fungicideGravex: 'Gravex',
});
const CLASS_ORDER = Object.freeze(['fertilizer', 'weedKiller', 'preEmergent', 'tetrino', 'dylox', 'fungicideGravex']);

const NO_WHOLE_LAWN_TEXT = 'No whole-lawn product today. Spot work only.';
// The same words once the sheet may be completed with no product (every planned line held).
const NO_PRODUCT_TEXT = `${NO_WHOLE_LAWN_TEXT} If there is no spot work, complete the visit with no product.`;
// The record's own sentence starts with this; the completion preflight looks for it.
const NO_PRODUCT_NOTE_PREFIX = 'No product applied: new sod';
const SWAP_REASON = 'New sod: no pre-emergent yet.';
const SWAP_BY_HAND = `Use ${SOD_SWAP_BAG.name.replace(/ with PolyPlus OPTI$/, '')} by hand.`;
const UNAVAILABLE_TEXT = 'Could not check this lawn for new sod. Ask the office before you spread fertilizer or spray weed killer.';
const ROOTED_LABEL = 'Sod mowed twice and does not lift';

const norm = (value) => String(value ?? '').trim().toLowerCase();
const lowerId = (id) => String(id ?? '').toLowerCase();

function ymdOrNull(value) {
  if (value == null || value === '') return null;
  try {
    return validCalendarDate(etCalendarDayOf(value)) || null;
  } catch {
    return null;
  }
}

// ── hold classes ────────────────────────────────────────────────────────────

/**
 * The hold classes a catalog product belongs to (see the module comment), in
 * CLASS_ORDER. `row` is a products_catalog row (name, category, active_ingredient,
 * analysis_n, formulation); `method` is the plan's application method for the line,
 * when there is one; `inWeedGroup` marks a member of the Weed spots group.
 */
function classesOf(row, { method = null, inWeedGroup = false } = {}) {
  if (!row) return inWeedGroup ? ['weedKiller'] : [];
  const ingredient = norm(row.active_ingredient);
  const category = norm(row.category);
  const found = new Set();
  const preEmergent = PRE_EMERGENT_INGREDIENTS.some((name) => ingredient.includes(name));
  if (preEmergent) found.add('preEmergent');
  const spreader = norm(row.formulation).includes('granul') || norm(method) === 'granular_broadcast';
  if (Number(row.analysis_n) > 0 && spreader) found.add('fertilizer');
  if (inWeedGroup || (category.includes('herbicide') && !preEmergent)) found.add('weedKiller');
  for (const key of Object.keys(INGREDIENT)) {
    if (ingredient.includes(INGREDIENT[key]) || NAME_FALLBACK[key].test(String(row.name || ''))) found.add(key);
  }
  return CLASS_ORDER.filter((key) => found.has(key));
}

// ── the words ───────────────────────────────────────────────────────────────

// One class's held words: "Fertilizer starts Oct 31, 2026." The weed killer and Gravex
// also wait for the technician's rooted check.
function startsWords(key, hold) {
  const label = CLASS_LABELS[key];
  if (key === 'weedKiller' || key === 'fungicideGravex') {
    return hold.until
      ? `${label} starts ${formatDay(hold.until)}, once the sod has been mowed twice and does not lift.`
      : `${label} waits until the sod has been mowed twice and does not lift.`;
  }
  return `${label} starts ${formatDay(hold.until)}.`;
}

const skipWords = (area) => (area ? `Skip the new sod: ${area}` : 'Skip the new sod.');
// Part-of-lawn sod inside its first 30 days: the fertilizer line stays on, kept off the new sod (local ordinance:
// no nitrogen on new turf for 30 days).
const keepOffWords = (area) => (area ? `Keep fertilizer off the new sod: ${area}.` : 'Keep fertilizer off the new sod.');

// What the holds say about one product line: { held, kinds, reason } for a line the hold
// keeps off the sheet, { held: false, note } for a part-of-lawn skip note, or null.
function decisionFor(classes, holds) {
  const heldKinds = [];
  const reasons = [];
  const notes = [];
  for (const key of classes) {
    const hold = holds[key];
    if (key === 'fertilizer' && holds.fertilizerKeepOff?.on) notes.push(keepOffWords(holds.area));
    if (!hold?.held) continue;
    if (hold.scope === 'area') {
      const skip = skipWords(holds.area);
      if (!notes.includes(skip)) notes.push(skip);
      continue;
    }
    heldKinds.push(key);
    reasons.push(startsWords(key, hold));
  }
  if (heldKinds.length) return { held: true, kinds: heldKinds, reason: `Held: new sod. ${reasons.join(' ')}` };
  if (notes.length) return { held: false, kinds: [], note: notes.join(' ') };
  return null;
}

// The class names as the banner lists them in a sentence.
const BANNER_NAMES = Object.freeze({
  fertilizer: 'fertilizer',
  weedKiller: 'weed killer',
  preEmergent: 'pre-emergent',
  tetrino: 'Tetrino',
  dylox: 'Dylox',
  fungicideGravex: 'Gravex',
});

// The banner's lines, from the holds alone.
function bannerOf(holds, { swap, noWholeLawn, noProductAllowed }) {
  const heldNames = CLASS_ORDER.filter((key) => holds[key]?.held || (key === 'fertilizer' && holds.fertilizerKeepOff?.on)).map((key) => BANNER_NAMES[key]);
  const part = holds.covers === 'part';
  let heldLine = null;
  if (heldNames.length) heldLine = part ? `Skip the new sod area for: ${heldNames.join(', ')}.` : `Held: ${heldNames.join(', ')}.`;
  let where = 'Whole lawn.';
  if (part) where = holds.area ? `Part of the lawn: ${holds.area}.` : 'Part of the lawn.';
  return {
    headline: `New sod, day ${holds.day}. Laid ${formatDay(holds.sodLaidOn)}.`,
    where,
    heldLine,
    largePatch: holds.largePatchWatch.on ? 'Watch for large patch.' : null,
    swap,
    noWholeLawn: noProductAllowed ? NO_PRODUCT_TEXT : (noWholeLawn ? NO_WHOLE_LAWN_TEXT : null),
  };
}

// ── the visit's home ────────────────────────────────────────────────────────

/**
 * True only when the visit is PROVABLY at the home the customer's preferences row
 * describes (the sod record belongs to that home: it is cleared on a move). The shared
 * visit scope chain decides: the visit's own address stamp, property link or creating
 * estimate against the customer's own address; a visit with no evidence at all counts
 * only on an account proven to have a single premises. Anything unproven is false (no
 * holds). A failed read throws, and the caller says the sod could not be checked.
 */
async function visitIsAtSodHome(svc, knex) {
  const linkage = require('./estimate-property-linkage');
  const { resolveVisitPropertyScope, sameResolvedProperty, customerHasOnlyPrimaryPremises } = require('./service-report/visit-property-scope');
  const mirrorKey = linkage.normalizedStampedStreet(svc.cust_address_line1, svc.cust_address_line2, svc.cust_city, svc.cust_zip) || null;
  if (!mirrorKey) return false;
  let failed = false;
  const scope = await resolveVisitPropertyScope(svc, knex, { onLookupFailure: () => { failed = true; } });
  if (failed) throw new Error('visit property lookup failed');
  if (scope.hasEvidence) return !!scope.key && sameResolvedProperty(scope.key, mirrorKey);
  // The single-premises fallback proves nothing from a customer address with no locality (a legacy partial stamp could be
  // any city's street): rejected, as every other caller of the fallback does. No holds.
  if (linkage.scopeKeyLacksLocality(mirrorKey)) return false;
  const customer = await knex('customers').where({ id: svc.customer_id }).first('has_multi_home');
  return customerHasOnlyPrimaryPremises(knex, svc.customer_id, customer, mirrorKey, { unresolvedFails: true });
}

const prefsRowOf = (knex, customerId) => knex('property_preferences')
  .where({ customer_id: customerId })
  .first('sod_laid_on', 'sod_covers', 'sod_area', 'sod_rooted_on');

async function grassOf(svc, knex) {
  try {
    const profile = await knex('customer_turf_profiles').where({ customer_id: svc.customer_id, active: true }).first('track_key', 'grass_type');
    if (!profile) return null;
    const { resolveTrackKey, normalizeGrassType } = require('./lawn-grass-context');
    return resolveTrackKey(profile.track_key, normalizeGrassType(profile.grass_type));
  } catch (err) {
    // Advisory only (the large patch watch is a note): a miss is no note.
    logger.warn(`[lawn-sod-sheet] grass unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

// ── the sheet's lines ───────────────────────────────────────────────────────

async function loadClassRows(knex, ids) {
  if (!ids.length) return new Map();
  const rows = await knex('products_catalog').whereIn('id', ids).select('id', 'name', 'category', 'active_ingredient', 'analysis_n', 'formulation');
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [lowerId(row.id), row]));
}

// The catalog row the swap bag names (exact name, active), or null.
async function loadSwapRow(knex) {
  const rows = await knex('products_catalog').whereRaw('lower(trim(name)) = ?', [norm(SOD_SWAP_BAG.name)]).select('*');
  return (Array.isArray(rows) ? rows : []).find((row) => norm(row.name) === norm(SOD_SWAP_BAG.name) && row.active !== false) || null;
}

const round2 = (n) => Math.round(n * 100) / 100;

// The swap bag as a plan-shaped item, built from the item it replaces (method, area) and the
// bag's own catalog row (watering rule, name). The rate is the owner's: 2.5 lb per 1,000 sq ft.
function swapItemFor(original, swapRow, ruleFor, bag) {
  const entry = ruleFor(swapRow);
  const sqft = Number(original.treatedSqft) > 0 && (!original.areaUnit || original.areaUnit === 'sqft') ? Number(original.treatedSqft) : null;
  return {
    productId: swapRow.id,
    name: swapRow.name,
    applicationMethod: original.applicationMethod,
    amount: sqft ? round2((bag.lbPer1000 * sqft) / 1000) : null,
    amountUnit: sqft ? 'lb' : null,
    treatedSqft: sqft,
    areaUnit: sqft ? 'sqft' : null,
    ratePer1000: bag.lbPer1000,
    rateUnit: 'lb',
    approvedForReport: entry.approvedForReport,
    wateringRule: entry.rule,
    wateringSummary: entry.ruleSummary,
    mowHoldDays: entry.mowHoldDays,
    sodSwap: { forProductId: lowerId(original.productId), reason: SWAP_REASON },
  };
}

/**
 * Applies the new-sod holds to one visit's sheet context.
 *
 * @param {object} args
 * @param {object} args.svc  the scheduled visit joined to its customer (loadServiceWithCustomer)
 * @param {object} args.knex
 * @param {Set} args.readFailures  the context's read-failure names ('new_sod' is added on a failed read)
 * @param {object} args.plannedProducts  the context's plannedProducts
 * @param {Function} args.ruleFor  (catalogRow) => { approvedForReport, rule, ruleSummary, mowHoldDays }
 * @returns {Promise<{ newSod: object|null, plannedProducts: object }>} newSod is null when
 *   the visit has no active sod hold; plannedProducts is the input unless a swap bag was added
 */
async function loadSodForContext({ svc, knex, readFailures, plannedProducts, ruleFor }) {
  const none = { newSod: null, plannedProducts };
  try {
    const prefs = await prefsRowOf(knex, svc.customer_id);
    const laid = ymdOrNull(prefs?.sod_laid_on);
    if (!laid) return none;
    if (!(await visitIsAtSodHome(svc, knex))) return none;
    const visitDay = etCalendarDayOf(svc.scheduled_date);
    const holds = sodHolds({
      sodLaidOn: laid,
      sodCovers: prefs.sod_covers,
      sodArea: prefs.sod_area,
      sodRootedOn: prefs.sod_rooted_on,
      visitDate: visitDay,
      grass: await grassOf(svc, knex),
    });
    if (!holds?.active) return none;
    return await withLines({ holds, visitDay, knex, plannedProducts, ruleFor });
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[lawn-sod-sheet] sod record unavailable for ${svc?.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('new_sod');
    return { newSod: { v: 1, unavailable: true, message: UNAVAILABLE_TEXT }, plannedProducts };
  }
}

/**
 * What the sheet context takes from the new-sod holds: `{ plannedProducts, fields }`, where `fields` is
 * spread into the context (`newSod`, or nothing).
 *
 * The hold-adjusted context goes ONLY to a client that says it understands it (`sodAware`, the
 * `sodAware=1` query parameter of GET /lawn-fast/context; lawn-fast-complete.js passes it through). An old
 * or cached sheet ignores `newSod` and would pre-select every planned item, the held Dimension bag AND
 * the appended swap bag. So without the signal, or with the gate off, the context is the legacy one
 * exactly: the same planned items (none appended, none removed), no `newSod`, and no read of the sod
 * record. That client then pre-selects held products exactly as it does with the gate off today: the
 * accepted status quo until its sheet is reloaded.
 */
async function sodContextParts({ sodAware, svc, knex, readFailures, plannedProducts, ruleFor }) {
  if (sodAware !== true || !featureGates.lawnNewSodNoteLive()) return { plannedProducts, fields: {} };
  const sod = await loadSodForContext({ svc, knex, readFailures, plannedProducts, ruleFor });
  return { plannedProducts: sod.plannedProducts, fields: sod.newSod ? { newSod: sod.newSod } : {} };
}

const NO_PRODUCT_STALE = Object.freeze({
  status: 409,
  payload: { error: 'The new sod record changed. Reopen the visit.', code: 'lawn_sod_no_product_stale' },
});

// A completion CLAIMS "the new sod holds every planned product" when the list is empty and the technician note carries
// the new-sod no-product sentence. Nothing else is judged here: an empty list without the sentence, and any list with a
// product, are judged exactly as before.
const claimsNoProduct = (products, technicianNotes) => (!Array.isArray(products) || products.length === 0)
  && String(technicianNotes || '').includes(NO_PRODUCT_NOTE_PREFIX);

// True only when the sheet context rebuilt NOW (as a sod-aware sheet, on `knex`) allows no product and generated the note sent.
async function noProductStillAllowed({ knex, svc, technicianNotes }) {
  let sod = null;
  try {
    const ctx = await require('./lawn-fast-complete').buildLawnFastContext(svc.id, { knex, sodAware: true });
    sod = ctx.ok && ctx.eligible ? ctx.newSod : null;
  } catch (err) {
    logger.warn(`[lawn-sod-sheet] no-product check unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
  }
  return sod?.noProductAllowed === true && String(technicianNotes || '').includes(sod.noProductNote);
}

/**
 * The completion preflight's no-product check (called from preflightLawnFastCompletion; `next` is the
 * rest of the preflight), UNLOCKED: it gives the technician the early plain answer. The same check is
 * repeated inside the commit transaction (`lockSodRecordForNoProduct` + `assertNoProductUnderLock`), because
 * the office can change the sod record between the two. A claim the rebuilt context does not back (record
 * cleared or changed to part of the lawn, a different sod date, a failed read, the gate off) is 409
 * lawn_sod_no_product_stale, a terminal "reopen".
 */
async function checkNoProductNote({ knex, svc, products, technicianNotes, next }) {
  if (!claimsNoProduct(products, technicianNotes)) return next();
  return (await noProductStillAllowed({ knex, svc, technicianNotes })) ? next() : NO_PRODUCT_STALE;
}

/**
 * The commit transaction's half (complete-scheduled-service.js persistRecord). `lockSodRecordForNoProduct` is
 * called FIRST in that transaction, before any other lock, and takes the property-preferences advisory lock sod
 * record writers take (writeAdminPreferences, the rooted tick) so the record cannot change until this completion
 * commits; the order is then the writers' own: advisory lock, customer (FOR SHARE), visit row. It returns whether
 * the case applies (gate on, completed lawn sheet, empty list, the sentence); only then is the recheck needed.
 * `assertNoProductUnderLock` runs after the visit row lock and rolls the completion back with
 * lawn_sod_no_product_stale (409) when the rebuilt context no longer backs the claim.
 */
async function lockSodRecordForNoProduct(trx, { customerId, lawnFast, isIncompleteVisit, products, technicianNotes }) {
  if (lawnFast == null || isIncompleteVisit || !featureGates.lawnNewSodNoteLive() || !claimsNoProduct(products, technicianNotes)) return false;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerId)]);
  return true;
}

async function assertNoProductUnderLock(trx, { svc, technicianNotes }) {
  if (await noProductStillAllowed({ knex: trx, svc, technicianNotes })) return;
  throw Object.assign(new Error('new sod record changed during completion'), { code: 'lawn_sod_no_product_stale' });
}

/**
 * The completion ledger's half of the bag swap (lawn-protocol-completion.js recordLawnProtocolCompletion).
 * The swap bag is not a row of the staged program, so the plan carries no substitution for it; without one the
 * ledger would record the swap bag as an off-protocol product and the Dimension bag it stands in for as a skipped
 * default. This returns the swap as substitutions in the plan's own shape (planSubstitutionSnapshot), so both
 * products resolve to the Dimension bag's protocol row: `[]` unless the gate is on, this is a lawn sheet
 * completion, the visit applied the swap bag, and the sheet context rebuilt NOW on the transaction (as a sod-aware
 * sheet) still makes that swap. A failed read is `[]` (the ledger is secondary; it never fails the visit).
 */
async function sodSwapSubstitutions(trx, { svc, lawnFast, appliedProducts }) {
  if (lawnFast == null || !featureGates.lawnNewSodNoteLive()) return [];
  const applied = new Set((Array.isArray(appliedProducts) ? appliedProducts : []).map((row) => lowerId(row?.product_id)).filter(Boolean));
  if (!applied.size) return [];
  try {
    const ctx = await require('./lawn-fast-complete').buildLawnFastContext(svc.id, { knex: trx, sodAware: true });
    const items = ctx?.ok && ctx.eligible && Array.isArray(ctx.plannedProducts?.items) ? ctx.plannedProducts.items : [];
    return items.filter((item) => item?.sodSwap?.forProductId && applied.has(lowerId(item.productId))).map((item) => {
      const original = items.find((other) => !other.sodSwap && lowerId(other.productId) === item.sodSwap.forProductId);
      return {
        id: null,
        originalProductId: original?.productId || item.sodSwap.forProductId,
        originalProductName: original?.name || null,
        substituteProductId: item.productId,
        substituteProductName: item.name,
        reason: item.sodSwap.reason,
        approvedByName: null,
        approvedAt: null,
        ratePer1000: item.ratePer1000 ?? null,
        rateUnit: item.rateUnit || null,
        source: 'new_sod',
      };
    });
  } catch (err) {
    logger.warn(`[lawn-sod-sheet] swap substitution unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return [];
  }
}

// Every product the plan could put on this visit, with the hold classes of each (by lower-case id).
async function classifyLines({ holds, plannedProducts, knex }) {
  const items = Array.isArray(plannedProducts?.items) ? plannedProducts.items : [];
  const addOns = Array.isArray(plannedProducts?.addOns) ? plannedProducts.addOns : [];
  const weedGroup = new Set((plannedProducts?.weedMix?.groupProductIds || []).map(lowerId));
  const chinch = plannedProducts?.chinch || {};
  const chinchItems = [chinch.item, ...Object.values(chinch.byPlace || {}).map((d) => d?.item)].filter((i) => i?.productId);
  const listed = [...items, ...addOns, ...chinchItems];
  const ids = [...new Set([...listed.map((i) => lowerId(i.productId)), ...weedGroup].filter(Boolean))];
  const rows = await loadClassRows(knex, ids);

  const classesById = new Map();
  for (const item of listed) {
    const id = lowerId(item.productId);
    if (!id || classesById.has(id)) continue;
    classesById.set(id, classesOf(rows.get(id), { method: item.applicationMethod, inWeedGroup: weedGroup.has(id) }));
  }
  for (const id of weedGroup) {
    if (!classesById.has(id)) classesById.set(id, classesOf(rows.get(id), { inWeedGroup: true }));
  }
  const lines = {};
  for (const [id, classes] of classesById) {
    const decision = decisionFor(classes, holds);
    if (decision) lines[id] = decision;
  }
  return { items, lines, classesById };
}

// The bag swap: the primary spreader line is the pre-emergent fertilizer bag, the
// pre-emergent is held and the fertilizer is not (lawn-sod-holds: swapPreEmergentBag).
// Adds the swap line after the bag and holds the bag (writes into `lines`).
async function applyBagSwap({ holds, visitDay, knex, ruleFor, items, classesById, lines }) {
  if (!holds.swapPreEmergentBag) return { swap: null, nextItems: items };
  const bag = items.find((item) => {
    const classes = classesById.get(lowerId(item.productId)) || [];
    return classes.includes('preEmergent') && classes.includes('fertilizer');
  });
  if (!bag) return { swap: null, nextItems: items };
  const bagId = lowerId(bag.productId);
  const swapRow = await loadSwapRow(knex);
  if (!swapRow) {
    // Never invent a product: hold the bag and say what to do by hand.
    lines[bagId] = { held: true, kinds: ['preEmergent'], reason: `Held: new sod. ${startsWords('preEmergent', holds.preEmergent)} ${SWAP_BY_HAND}` };
    return { swap: { resolved: false, forProductId: bagId, reason: SWAP_BY_HAND }, nextItems: items };
  }
  // October: 2.5 lb per 1,000. April (the 9-visit plan): 2.1 lb per 1,000. Keyed on the visit's month in lawn-sod-holds.
  const swapBag = swapBagFor(visitDay);
  const swapItem = swapItemFor(bag, swapRow, ruleFor, swapBag);
  lines[bagId] = { held: true, kinds: ['preEmergent'], reason: `Held: new sod. ${startsWords('preEmergent', holds.preEmergent)} Use ${swapRow.name} instead.` };
  return {
    swap: { resolved: true, forProductId: bagId, productId: lowerId(swapRow.id), name: swapRow.name, lbPer1000: swapBag.lbPer1000, reason: SWAP_REASON },
    nextItems: items.flatMap((item) => (item === bag ? [item, swapItem] : [item])),
  };
}

// The one sentence the record carries when the holds took every planned line off the visit: why no
// product went down and until when each held class waits. Built from the held planned lines only.
function noProductNoteOf(holds, heldKinds) {
  const waits = CLASS_ORDER.filter((key) => heldKinds.has(key)).map((key) => {
    const until = holds[key]?.until;
    return `${BANNER_NAMES[key]} ${until ? `until ${formatDay(until)}` : 'until the sod is rooted'}`;
  });
  return `${NO_PRODUCT_NOTE_PREFIX} is rooting (laid ${formatDay(holds.sodLaidOn)}).${waits.length ? ` Held: ${waits.join(', ')}.` : ''}`;
}

// The hold classes the customer report card names, in the order it prints them. Tetrino and Gravex are held on the
// sheet but never named to the customer.
const REPORT_CLASSES = Object.freeze(['fertilizer', 'weedKiller', 'preEmergent', 'dylox']);

// The hold that applies to a PLANNED line of this class today, or null. A whole-lawn record holds the class itself; a
// part-of-lawn record keeps the line on and skips the sod area (fertilizer: keeps it off the sod until day 30).
function reportHoldOf(holds, kind) {
  if (holds.covers === 'part' && kind === 'fertilizer') return holds.fertilizerKeepOff?.on ? { until: holds.fertilizerKeepOff.until } : null;
  return holds[kind]?.held ? holds[kind] : null;
}

/**
 * The classes that kept a PLANNED line (the plan's own primary lines, never the swap bag or an add-on) off, or away from
 * the sod area on, this visit: `[{ kind, until, rootedCheck, productIds }]` in REPORT_CLASSES order. The completion
 * transaction freezes it for the report card (lawn-sod-report-card.js). `until` is the first day the class is allowed
 * again (null for a weed killer that waits only for the rooted check).
 */
function plannedHeldOf(holds, items, classesById) {
  const found = [];
  for (const kind of REPORT_CLASSES) {
    const hold = reportHoldOf(holds, kind);
    const productIds = hold ? items.map((item) => lowerId(item.productId)).filter((id) => (classesById.get(id) || []).includes(kind)) : [];
    if (productIds.length) found.push({ kind, until: hold.until || null, rootedCheck: kind === 'weedKiller', productIds });
  }
  return found;
}

/**
 * Applies the holds to the plan: the hold decision of every line, the bag swap, the banner.
 * `noProductAllowed` (with `noProductNote`) is set only when this is a whole-lawn record, every
 * planned line is held, and no swap is left for the technician to do by hand (a bag spread by
 * hand is a product applied). The completion preflight re-derives it from this same function.
 */
async function withLines({ holds, visitDay, knex, plannedProducts, ruleFor }) {
  const { items, lines, classesById } = await classifyLines({ holds, plannedProducts, knex });
  const { swap, nextItems } = await applyBagSwap({ holds, visitDay, knex, ruleFor, items, classesById, lines });

  // Every primary line held (the swap bag, when added, is a line that is not): nothing goes
  // down on the whole lawn today.
  const isHeld = (item) => lines[lowerId(item.productId)]?.held === true;
  const noWholeLawn = nextItems.length > 0 && nextItems.every(isHeld);
  const noProductAllowed = noWholeLawn && holds.covers !== 'part' && !(swap && swap.resolved === false);
  const heldKinds = new Set(nextItems.filter(isHeld).flatMap((item) => lines[lowerId(item.productId)].kinds || []));

  const banner = bannerOf(holds, { swap, noWholeLawn, noProductAllowed });
  const newSod = {
    v: 1,
    day: holds.day,
    sodLaidOn: holds.sodLaidOn,
    covers: holds.covers,
    area: holds.area,
    ...banner,
    ...(noProductAllowed ? { noProductAllowed: true, noProductNote: noProductNoteOf(holds, heldKinds) } : {}),
    rooted: holds.weedKiller.needsRootedCheck ? { sodLaidOn: holds.sodLaidOn, label: ROOTED_LABEL } : null,
    lines,
    plannedHeld: plannedHeldOf(holds, items, classesById),
  };
  return { newSod, plannedProducts: nextItems === items ? plannedProducts : { ...plannedProducts, items: nextItems } };
}

// ── the rooted tick ─────────────────────────────────────────────────────────

const refusal = (status, code, error) => ({ status, body: { error, code } });

/**
 * Saves sod_rooted_on = the visit's ET day (the technician's "Sod mowed twice and does
 * not lift" tick). Runs inside the caller's transaction, AFTER the route took the locks in
 * this order: the customer's property-preferences advisory lock, the customer row (FOR SHARE),
 * the scheduled visit row (customer first, then its visits, as the review-reply runner and
 * publisher do); this function then takes the preferences row FOR UPDATE. A visit on a later
 * ET day than today is refused (the day saved is the visit's own day, never a future one;
 * the same future-visit check the completion flow uses). Idempotent: a day already saved is returned unchanged and never
 * moved or cleared. It only ever writes the day onto the record whose sod date is the
 * one the sheet rendered (`expectedLaidOn`), and only from the day the weed killer hold's
 * 30 days have passed (sodHolds says so: needsRootedCheck).
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
async function confirmSodRooted(trx, { svc, expectedLaidOn }) {
  const expected = typeof expectedLaidOn === 'string' ? validCalendarDate(expectedLaidOn.trim()) : null;
  if (!expected) return refusal(400, 'sod_date_required', 'Send the sod date shown on the sheet.');

  if (require('./track-transitions').isFutureScheduledDate(svc.scheduled_date)) {
    return refusal(409, 'sod_rooted_future_visit', 'This visit is on a later day. Confirm the sod on the day of the visit.');
  }
  const prefs = await trx('property_preferences').where({ customer_id: svc.customer_id }).forUpdate().first();
  if (!prefs || ymdOrNull(prefs.sod_laid_on) !== expected) {
    return refusal(409, 'sod_record_changed', 'The sod record changed. Close this sheet and open the visit again.');
  }
  if (!(await visitIsAtSodHome(svc, trx))) {
    return refusal(409, 'sod_not_this_home', 'This visit is not at the home with the sod record.');
  }

  const already = ymdOrNull(prefs.sod_rooted_on);
  if (already) return { status: 200, body: { sodRootedOn: already, changed: false } };

  const visitDay = etCalendarDayOf(svc.scheduled_date);
  const holds = sodHolds({ sodLaidOn: expected, sodCovers: prefs.sod_covers, sodArea: prefs.sod_area, sodRootedOn: null, visitDate: visitDay });
  if (!holds?.weedKiller?.needsRootedCheck) {
    return refusal(409, 'sod_rooted_too_early', 'The sod is still inside its first 30 days. Confirm it after day 30.');
  }

  // The guard is repeated in SQL: a day is only ever written onto an empty rooted day of this very record.
  const updated = await trx('property_preferences')
    .where({ customer_id: svc.customer_id })
    .whereNull('sod_rooted_on')
    .whereRaw('sod_laid_on = ?', [expected])
    .update({ sod_rooted_on: visitDay, updated_at: trx.fn.now() });
  if (!updated) return refusal(409, 'sod_record_changed', 'The sod record changed. Close this sheet and open the visit again.');
  logger.info(`[lawn-sod-sheet] sod rooted confirmed for visit ${svc.id}`);
  return { status: 200, body: { sodRootedOn: visitDay, changed: true } };
}

module.exports = {
  NO_WHOLE_LAWN_TEXT,
  NO_PRODUCT_TEXT,
  NO_PRODUCT_NOTE_PREFIX,
  SWAP_REASON,
  SWAP_BY_HAND,
  UNAVAILABLE_TEXT,
  ROOTED_LABEL,
  PRE_EMERGENT_INGREDIENTS,
  classesOf,
  decisionFor,
  visitIsAtSodHome,
  loadSodForContext,
  sodContextParts,
  checkNoProductNote,
  lockSodRecordForNoProduct,
  assertNoProductUnderLock,
  sodSwapSubstitutions,
  NO_PRODUCT_STALE,
  confirmSodRooted,
};
