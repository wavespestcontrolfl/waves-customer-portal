/**
 * Admin Equipment, Tank Mix Calculator & Job Costing Routes
 *
 * Equipment CRUD + maintenance logging
 * Tank mix recipes with auto-cost from products_catalog
 * Job costing with margin analysis
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const equipmentService = require('../services/equipment-maintenance');
const { etDateString } = require('../utils/datetime-et');
const { normalizeKitKey, isValidKitKey } = require('../services/kit-key');

router.use(adminAuthenticate, requireTechOrAdmin);

// Custody columns (docs/tool-inventory-tracker-scope.md, PR 0). A tool is an
// equipment row that rides on a truck: assigned_vehicle_id points at the
// equipment row with category 'vehicle' it is kept on, location says where it
// is kept, asset_tag is the label on the item (unique in the table) and
// condition_rating is 1 to 10. Until this change only seeds could set them;
// the Assets dialog is now the writer.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_TAG_MAX = 50;
const LOCATION_MAX = 100;

// undefined = the body did not carry the key (leave the column alone);
// null or blank = clear it.
function optionalText(value, max) {
  if (value === undefined) return { skip: true };
  if (value === null) return { value: null };
  const text = String(value).trim();
  if (!text) return { value: null };
  if (text.length > max) return { error: `must be at most ${max} characters` };
  return { value: text };
}

// condition_rating: undefined = leave alone; null or blank = clear; else 1 to 10.
function conditionValue(raw) {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  const rating = Number(raw);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return { error: 'condition_rating must be a whole number from 1 to 10' };
  }
  return { value: rating };
}

// kit_key (PR 2): what the tool is, lowercase snake_case; blank clears it.
function kitKeyValue(raw) {
  if (raw === undefined) return { skip: true };
  const key = normalizeKitKey(raw);
  if (key && !isValidKitKey(key)) return { error: 'kit_key must be letters, digits and underscores, 2 to 60 characters' };
  return { value: key };
}

// assigned_vehicle_id: the equipment row (category 'vehicle') a tool rides on.
// A row can never be its own truck, and a truck is never cargo on another
// truck (by the body's category, or the stored one when the body is silent).
async function vehicleTarget(body, selfId) {
  const raw = body.assigned_vehicle_id;
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  const vehicleId = String(raw);
  if (!UUID_RE.test(vehicleId) || vehicleId === selfId) return { error: 'assigned_vehicle_id must be a vehicle' };
  // ...and a live one: a retired, sold or lost truck carries no kit.
  const vehicle = await db('equipment').where({ id: vehicleId, category: 'vehicle' }).whereNotIn('status', DEAD_ITEM_STATUSES).first('id');
  if (!vehicle) return { error: 'assigned_vehicle_id must be a live vehicle' };
  let category = body.category;
  if (category === undefined && selfId) {
    const self = await db('equipment').where({ id: selfId }).first('category');
    category = self ? self.category : undefined;
  }
  if (category === 'vehicle') return { error: 'a vehicle cannot be assigned to a truck' };
  return { value: vehicleId };
}

// The custody values a body carries, validated. Returns { values } holding
// only the keys present in the body, or { error } with the first problem.
async function custodyFields(body, { selfId = null } = {}) {
  const values = {};
  const checks = [
    ['asset_tag', optionalText(body.asset_tag, ASSET_TAG_MAX)],
    ['location', optionalText(body.location, LOCATION_MAX)],
    ['condition_rating', conditionValue(body.condition_rating)],
    ['kit_key', kitKeyValue(body.kit_key)],
    ['assigned_vehicle_id', await vehicleTarget(body, selfId)],
  ];
  for (const [key, result] of checks) {
    if (result.error) return { error: key === 'asset_tag' || key === 'location' ? `${key} ${result.error}` : result.error };
    if (!result.skip) values[key] = result.value;
  }
  // Recategorizing a row as a vehicle drops any truck it rode on.
  if (body.category === 'vehicle') values.assigned_vehicle_id = null;
  return { values };
}

// A technician holds one live truck: a second vehicle assigned to the same
// person would leave the truck check guessing which roster is theirs.
const DEAD_ITEM_STATUSES = ['lost', 'retired', 'sold'];
const SECOND_TRUCK_ERROR = 'That technician already has a truck. Unassign the other vehicle first.';
async function secondLiveTruck({ category, assigned_to, status }, selfId, conn = db) {
  if (category !== 'vehicle' || !assigned_to || DEAD_ITEM_STATUSES.includes(status)) return null;
  let q = conn('equipment').where({ category: 'vehicle', assigned_to }).whereNotIn('status', DEAD_ITEM_STATUSES);
  if (selfId) q = q.whereNot('id', selfId);
  return (await q.first('id')) || null;
}

// Postgres unique violation on equipment.asset_tag (the only unique column a
// caller can set): answered as a 409 instead of a 500.
function isAssetTagConflict(err) {
  return Boolean(err) && err.code === '23505' && /asset_tag/.test(String(err.constraint || err.detail || err.message || ''));
}
// Job margins belong to the owner-only Costs workspace, including legacy
// writers and the dashboard's copy of the margin summary.
router.use(['/job-costs', '/dashboard'], requireAdmin);

// =========================================================================
// EQUIPMENT CRUD
// =========================================================================

// GET /equipment — list all with maintenance status
router.get('/equipment', async (req, res, next) => {
  try {
    const { category, status, assigned_to, assigned_vehicle_id } = req.query;

    let query = db('equipment')
      .leftJoin('technicians', 'equipment.assigned_to', 'technicians.id')
      .leftJoin('equipment as vehicle', 'equipment.assigned_vehicle_id', 'vehicle.id')
      .select(
        'equipment.*',
        db.raw("COALESCE(technicians.name, 'Unassigned') as assigned_tech_name"),
        'vehicle.name as assigned_vehicle_name',
        'vehicle.asset_tag as assigned_vehicle_tag'
      )
      .orderBy('equipment.name');

    if (category) query = query.where('equipment.category', category);
    if (status) query = query.where('equipment.status', status);
    if (assigned_to) query = query.where('equipment.assigned_to', assigned_to);
    // One truck's roster, or the rows on no truck at all ('none').
    if (assigned_vehicle_id === 'none') query = query.whereNull('equipment.assigned_vehicle_id');
    else if (assigned_vehicle_id) query = query.where('equipment.assigned_vehicle_id', assigned_vehicle_id);

    const equipment = await query;

    // Check maintenance status for each piece
    const enriched = equipment.map(eq => {
      const hoursUntilService = eq.next_service_hours
        ? parseFloat(eq.next_service_hours) - parseFloat(eq.current_hours || 0)
        : null;
      return {
        ...eq,
        hours_until_service: hoursUntilService,
        maintenance_due: hoursUntilService !== null && hoursUntilService <= 10,
        maintenance_overdue: hoursUntilService !== null && hoursUntilService <= 0,
      };
    });

    res.json({ equipment: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /kit-keys — every kit key in use (checklist items and equipment rows),
// for the Assets dialog's suggestions (docs/tool-inventory-tracker-scope.md PR 2).
// The gate's answer is the dialog's capability: off = 404 { enabled: false }
// and the Kit key field stays away (fail closed, like the tech route).
router.get('/kit-keys', async (req, res, next) => {
  try {
    const truckKit = require('../services/truck-kit');
    if (!truckKit.truckKitEnabled()) return res.status(404).json({ enabled: false });
    res.json({ enabled: true, keys: await truckKit.kitKeyVocabulary() });
  } catch (err) {
    next(err);
  }
});

// POST /equipment — add new
// Custody and identity columns are the office's: a technician token never
// creates or edits an asset, whatever GATE_STAFF_DEFAULT_DENY says.
router.post('/equipment', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, category, make, model, serial_number,
      purchase_date, purchase_price, current_hours,
      next_service_hours, next_service_type, assigned_to,
      status, depreciation_method, depreciation_annual,
      book_value, specs, notes,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Equipment name is required' });
    const custody = await custodyFields(req.body);
    if (custody.error) return res.status(400).json({ error: custody.error });
    // A vehicle given to a technician: the one-live-truck check and the
    // insert serialize on that technician's lock.
    const record = await db.transaction(async (trx) => {
      // A new item placed straight onto a truck waits for a check in flight
      // on that truck (same lock as recordTruckCheck), then the target is
      // validated AGAIN under the lock: a truck retired meanwhile is refused.
      if (custody.values.assigned_vehicle_id) {
        await require('../services/truck-kit').lockTruck(trx, custody.values.assigned_vehicle_id);
        const target = await trx('equipment').where({ id: custody.values.assigned_vehicle_id, category: 'vehicle' }).whereNotIn('status', DEAD_ITEM_STATUSES).first('id');
        if (!target) return 'target-gone';
      }
      if (category === 'vehicle' && assigned_to) {
        await require('../services/truck-kit').lockTechnician(trx, assigned_to);
        if (await secondLiveTruck({ category, assigned_to, status: status || 'active' }, null, trx)) return 'second-truck';
      }
      const [row] = await trx('equipment').insert({
      ...custody.values,
      name, category, make, model, serial_number,
      purchase_date: purchase_date || null,
      purchase_price: purchase_price || null,
      current_hours: current_hours || 0,
      next_service_hours: next_service_hours || null,
      next_service_type: next_service_type || null,
      assigned_to: assigned_to || null,
      status: status || 'active',
      depreciation_method: depreciation_method || 'section_179',
      depreciation_annual: depreciation_annual || null,
      book_value: book_value || purchase_price || null,
      specs: specs ? JSON.stringify(specs) : null,
      notes: notes || null,
    }).returning('*');
      return row;
    });
    if (record === 'second-truck') return res.status(409).json({ error: SECOND_TRUCK_ERROR });
    if (record === 'target-gone') return res.status(409).json({ error: 'That truck is no longer a live vehicle. Reload and pick another.' });

    logger.info(`Equipment added: ${record.name} (${record.id})`);
    res.status(201).json({ equipment: record });
  } catch (err) {
    if (isAssetTagConflict(err)) return res.status(409).json({ error: 'That asset tag is already on another item' });
    next(err);
  }
});

// The asset update, inside one transaction. Returns the updated row, null
// (not found) or a refusal word the handler maps to a 409.
const ITEM_COLUMNS = ['assigned_vehicle_id', 'category', 'assigned_to', 'status'];
// Every truck a write can touch: the target truck, the item's truck on a move
// or any status change, and the vehicle row itself when the write can change
// whether it serves as a truck (status, category, technician).
function trucksTouched(id, row, updates) {
  return [...new Set([
    updates.assigned_vehicle_id,
    (updates.assigned_vehicle_id !== undefined || updates.status !== undefined) ? row.assigned_vehicle_id : null,
    row.category === 'vehicle' && ['status', 'category', 'assigned_to'].some((key) => updates[key] !== undefined) ? id : null,
  ].filter(Boolean))].sort();
}
async function applyAssetUpdate(trx, id, updates, expectedStatus = undefined) {
  const truckKit = require('../services/truck-kit');
  // The item row itself is serialized first (one advisory lock per row), so
  // two saves of the same item never derive their truck locks from the same
  // stale read; then every truck the write can touch, in one order, so a
  // truck check in flight finishes before the item moves or dies; then the
  // row is read AGAIN under the locks and a raced move or recategorization
  // is refused, never applied to a truck nobody locked.
  await truckKit.lockTruck(trx, id);
  const first = await trx('equipment').where({ id }).first(...ITEM_COLUMNS);
  if (!first) return null;
  for (const truckId of trucksTouched(id, first, updates)) await truckKit.lockTruck(trx, truckId);
  const before = await trx('equipment').where({ id }).first(...ITEM_COLUMNS);
  // Truck, category OR status: an alert outcome (Lost / Retired) that landed
  // while this save waited must not be undone by the dialog's full payload.
  if (!before || ['assigned_vehicle_id', 'category', 'status'].some((key) => before[key] !== first[key])) return 'moved';
  // ...nor by a form opened before it landed: the dialog sends the status it
  // loaded (expected_status) and a different stored status refuses the save.
  if (expectedStatus !== undefined && expectedStatus !== null && String(expectedStatus) !== String(before.status)) return 'stale-status';
  const refusal = await writeRefusal(trx, id, updates, before);
  if (refusal) return refusal;
  const moved = updates.assigned_vehicle_id !== undefined && before.assigned_vehicle_id !== updates.assigned_vehicle_id;
  const oldTruck = moved ? (before.assigned_vehicle_id || null) : null;
  const [row] = await trx('equipment').where({ id }).update(updates).returning('*');
  if (row && oldTruck) await truckKit.closeTruckBellIfClear(oldTruck, new Date(), trx);
  return row || null;
}
// Why the write is refused under the locks, or null.
async function writeRefusal(trx, id, updates, before) {
  const truckKit = require('../services/truck-kit');
  // A truck with tools still riding on it cannot stop being a vehicle (the
  // riders would point at a non-vehicle): checked under the vehicle's own
  // lock, so a rider assigned meanwhile is seen.
  if (updates.category !== undefined && updates.category !== 'vehicle' && before.category === 'vehicle') {
    const rider = await trx('equipment').where({ assigned_vehicle_id: id }).first('id');
    if (rider) return 'riders';
  }
  // The target truck is re-validated under its lock: a writer that retired
  // or recategorized it while this save waited loses the race.
  if (updates.assigned_vehicle_id) {
    const target = await trx('equipment').where({ id: updates.assigned_vehicle_id, category: 'vehicle' }).whereNotIn('status', DEAD_ITEM_STATUSES).first('id');
    if (!target) return 'target-gone';
  }
  // An unresolved tool alert belongs to the truck it was found on and closes
  // only through the office's outcome (Found / Lost, Repaired / Retired,
  // routes/admin-equipment-maintenance.js): the item neither moves nor goes
  // lost, retired or sold from the dialog while one is open.
  const moved = updates.assigned_vehicle_id !== undefined && before.assigned_vehicle_id !== updates.assigned_vehicle_id;
  if ((moved || DEAD_ITEM_STATUSES.includes(updates.status)) && await truckKit.openToolAlertFor(id, trx)) return 'open-alert';
  // A technician never holds two live trucks (truck-kit.js would refuse to
  // guess). An omitted key keeps the stored value; an explicit null clears it
  // (that is how a second truck is unassigned).
  const pick = (key) => (Object.prototype.hasOwnProperty.call(updates, key) ? updates[key] : before[key]);
  const live = { category: pick('category'), assigned_to: pick('assigned_to'), status: pick('status') };
  // The invariant itself, on the FINAL row under the locks: a vehicle is
  // never cargo (a save that raced a recategorization is refused).
  if (live.category === 'vehicle' && pick('assigned_vehicle_id')) return 'vehicle-cargo';
  if (live.category === 'vehicle' && live.assigned_to && !DEAD_ITEM_STATUSES.includes(live.status)) {
    await truckKit.lockTechnician(trx, live.assigned_to);
    if (await secondLiveTruck(live, id, trx)) return 'second-truck';
  }
  return null;
}

// PUT /equipment/:id — update
router.put('/equipment/:id', requireAdmin, async (req, res, next) => {
  try {
    // Whitelist updatable columns instead of spreading req.body, so a caller
    // can't set columns they shouldn't (e.g. id/created_at, or any future
    // sensitive column added to the table). Mirrors the create handler's field
    // set above.
    const ALLOWED_FIELDS = [
      'name', 'category', 'make', 'model', 'serial_number',
      'purchase_date', 'purchase_price', 'current_hours',
      'next_service_hours', 'next_service_type', 'assigned_to',
      'status', 'depreciation_method', 'depreciation_annual',
      'book_value', 'specs', 'notes',
    ];
    const updates = { updated_at: db.fn.now() };
    for (const key of ALLOWED_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.specs) updates.specs = JSON.stringify(updates.specs);
    const custody = await custodyFields(req.body, { selfId: req.params.id });
    if (custody.error) return res.status(400).json({ error: custody.error });
    Object.assign(updates, custody.values);

    // A tool that leaves a truck (moved or unassigned) takes its open tool
    // alerts with it, so the old truck's bell must be re-judged: under both
    // trucks' locks, in the same transaction as the move (truck-kit.js).
    const record = await db.transaction((trx) => applyAssetUpdate(trx, req.params.id, updates, req.body.expected_status));
    if (record === 'moved') return res.status(409).json({ error: 'Another save changed this item (its truck, category or status). Reload and try again.' });
    if (record === 'vehicle-cargo') return res.status(409).json({ error: 'This item is now a vehicle; a vehicle cannot ride on a truck. Reload and try again.' });
    if (record === 'riders') return res.status(409).json({ error: 'Items still ride on this truck. Move them to another truck first.' });
    if (record === 'stale-status') return res.status(409).json({ error: 'This item\'s status changed since you opened it. Reload and try again.' });
    if (record === 'target-gone') return res.status(409).json({ error: 'That truck is no longer a live vehicle. Reload and pick another.' });
    if (record === 'open-alert') return res.status(409).json({ error: 'This item has an open truck check alert. Resolve it on Equipment → Maintenance (Found / Lost or Repaired / Retired) first.' });
    if (record === 'second-truck') return res.status(409).json({ error: SECOND_TRUCK_ERROR });
    if (!record) return res.status(404).json({ error: 'Equipment not found' });

    logger.info(`Equipment updated: ${record.name} (${record.id})`);
    res.json({ equipment: record });
  } catch (err) {
    if (isAssetTagConflict(err)) return res.status(409).json({ error: 'That asset tag is already on another item' });
    next(err);
  }
});

// POST /equipment/:id/maintenance — log maintenance
router.post('/equipment/:id/maintenance', async (req, res, next) => {
  try {
    const equipment = await db('equipment').where({ id: req.params.id }).first();
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const {
      service_type, hours_at_service, cost,
      parts_used, performed_by, notes, service_date,
    } = req.body;

    const log = await equipmentService.recordMaintenance({
      equipmentId: req.params.id,
      maintenanceType: 'legacy',
      taskName: service_type || 'General maintenance',
      description: [notes, parts_used ? `Parts used: ${parts_used}` : null].filter(Boolean).join('\n') || null,
      hoursAtService: hours_at_service || equipment.current_hours,
      partsCost: cost || 0,
      performedBy: performed_by || req.technician?.name || null,
      performedAt: service_date || etDateString(),
    });

    // Update equipment record
    const equipmentUpdates = {
      last_service_date: service_date || etDateString(),
      updated_at: db.fn.now(),
    };
    if (hours_at_service) equipmentUpdates.current_hours = hours_at_service;

    await db('equipment').where({ id: req.params.id }).update(equipmentUpdates);

    logger.info(`Maintenance logged for ${equipment.name}: ${service_type}`);
    res.status(201).json({ maintenance: log });
  } catch (err) {
    next(err);
  }
});

// POST /equipment/:id/calibration — log calibration
router.post('/equipment/:id/calibration', async (req, res, next) => {
  try {
    const equipment = await db('equipment').where({ id: req.params.id }).first();
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const {
      hours_at_service, notes, performed_by, service_date,
      flow_rate_oz_min, nozzle_type, pressure_psi,
    } = req.body;

    const calibrationNotes = [
      notes || '',
      flow_rate_oz_min ? `Flow rate: ${flow_rate_oz_min} oz/min` : '',
      nozzle_type ? `Nozzle: ${nozzle_type}` : '',
      pressure_psi ? `Pressure: ${pressure_psi} PSI` : '',
    ].filter(Boolean).join(' | ');

    const log = await equipmentService.recordMaintenance({
      equipmentId: req.params.id,
      maintenanceType: 'calibration',
      taskName: 'Calibration',
      description: calibrationNotes || null,
      hoursAtService: hours_at_service || equipment.current_hours,
      performedBy: performed_by || req.technician?.name || null,
      performedAt: service_date || etDateString(),
    });

    logger.info(`Calibration logged for ${equipment.name}`);
    res.status(201).json({ calibration: log });
  } catch (err) {
    next(err);
  }
});

// GET /equipment/:id/calibration-history — calibration records
router.get('/equipment/:id/calibration-history', async (req, res, next) => {
  try {
    const records = await db('maintenance_records')
      .where('equipment_id', req.params.id)
      .where(function () {
        this.where('maintenance_type', 'calibration')
          .orWhereILike('task_name', '%calibration%');
      })
      .orderBy('performed_at', 'desc');

    res.json({ calibrations: records });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// TANK MIXES
// =========================================================================

// Owner-only per-ounce catalog cost (ADMIN-BUG-R64): cost_per_oz and
// cost_in_tank are derived straight from products_catalog.best_price
// (unitCost = best_price / unit_size_oz), and unitSizeOz stays visible to
// technicians on GET /inventory — so leaving these two per-line fields in a
// technician response lets best_price be reconstructed exactly
// (cost_per_oz * unitSizeOz). cost_per_tank / cost_per_1000sf are left
// alone: EquipmentPage.jsx deliberately shows techs the $/tank and
// $/1,000 sq ft totals (OWNER_ONLY_EQUIPMENT_TABS keeps only Job Costs and
// Analytics owner-only), so stripping those would break an intended
// tech-facing feature, not close a leak.
function stripMixOwnerOnlyCost(mix) {
  const wasString = typeof mix.products === 'string';
  let prods;
  try {
    prods = wasString ? JSON.parse(mix.products) : (mix.products || []);
  } catch {
    prods = [];
  }
  if (!Array.isArray(prods)) return mix;
  const stripped = prods.map((p) => {
    if (!p || (p.cost_per_oz === undefined && p.cost_in_tank === undefined)) return p;
    const { cost_per_oz: _costPerOz, cost_in_tank: _costInTank, ...rest } = p;
    return rest;
  });
  // Preserve the column's original shape (jsonb comes back parsed from a
  // real DB; this route's own recalculate/create paths JSON.stringify it
  // before persisting) — never change the response's field type.
  return { ...mix, products: wasString ? JSON.stringify(stripped) : stripped };
}

// GET /tank-mixes — list all
router.get('/tank-mixes', async (req, res, next) => {
  try {
    const { service_type, active } = req.query;
    let query = db('tank_mixes').orderBy('name');
    if (service_type) query = query.where('service_type', service_type);
    if (active !== undefined) query = query.where('active', active === 'true');

    const mixes = await query;
    // Derive cost_incomplete from the persisted per-line cost_unknown flags
    // (r7-push P1): the mutation responses carry it, but the client reloads
    // this list right after — without the derivation the partial totals
    // would present as complete again on reload.
    const withFlags = mixes.map((m) => {
      let prods;
      try {
        prods = typeof m.products === 'string' ? JSON.parse(m.products) : (m.products || []);
      } catch {
        prods = [];
      }
      return Array.isArray(prods) && prods.some((p) => p && p.cost_unknown === true)
        ? { ...m, cost_incomplete: true }
        : m;
    });
    const isAdminRequest = req.techRole === 'admin';
    const out = isAdminRequest ? withFlags : withFlags.map(stripMixOwnerOnlyCost);
    res.json({ tank_mixes: out, mixes: out });
  } catch (err) {
    next(err);
  }
});

// Helper: calculate tank mix costs from products_catalog
async function calculateMixCosts(products, tankSizeGal, coverageSqft) {
  if (!products || !products.length) return { cost_per_tank: 0, cost_per_1000sf: 0 };

  let totalCostPerTank = 0;

  const enrichedProducts = [];
  let anyCostUnknown = false;
  for (const p of products) {
    let unitCost = 0;
    let costUnknown = false;

    // Look up current price from products_catalog. ANY catalog-linked
    // component that can't produce a usable positive price AND size is
    // UNKNOWN (r5-push P1) — a missing row, a missing/zero best_price, or a
    // missing container size all otherwise contributed $0 while the totals
    // presented as complete.
    if (p.product_id) {
      costUnknown = true;
      const catalogProduct = await db('products_catalog')
        .where({ id: p.product_id })
        .first();
      if (catalogProduct && parseFloat(catalogProduct.best_price) > 0) {
        // cost_per_oz from best price / total oz in container.
        // Column is products_catalog.unit_size_oz (there is no size_oz);
        // best_price is the price for one unit_size_oz container. A
        // missing/zero unit_size_oz is UNKNOWN, never a 1-gal guess
        // (r3-push P1): other costing paths reject missing sizes, and a
        // fabricated divisor invents tank and per-1,000-sq-ft costs.
        const containerOz = parseFloat(catalogProduct.unit_size_oz);
        if (Number.isFinite(containerOz) && containerOz > 0) {
          unitCost = parseFloat(catalogProduct.best_price) / containerOz;
          costUnknown = false;
        }
      }
    }

    const ozPerTank = parseFloat(p.oz_per_tank) || 0;
    const productCost = unitCost * ozPerTank;
    totalCostPerTank += productCost;

    if (costUnknown) anyCostUnknown = true;
    // Strip any PRIOR flag before conditionally re-adding (r8-push P1):
    // spreading p verbatim kept a stale cost_unknown:true after the
    // catalog price/size became valid.
    const { cost_unknown: _priorUnknown, ...rest } = p;
    enrichedProducts.push({
      ...rest,
      cost_per_oz: Math.round(unitCost * 10000) / 10000,
      cost_in_tank: Math.round(productCost * 100) / 100,
      ...(costUnknown ? { cost_unknown: true } : {}),
    });
  }

  const costPerTank = Math.round(totalCostPerTank * 100) / 100;
  const costPer1000 = coverageSqft > 0
    ? Math.round((totalCostPerTank / (coverageSqft / 1000)) * 10000) / 10000
    : 0;

  return {
    products: enrichedProducts,
    cost_per_tank: costPerTank,
    cost_per_1000sf: costPer1000,
    // At least one priced component had no container size — the totals
    // EXCLUDE it and understate the mix cost; surfaces must show the gap
    // instead of presenting the partial number as complete.
    ...(anyCostUnknown ? { cost_incomplete: true } : {}),
  };
}

// POST /tank-mixes — create. Admin-only: no client caller creates or edits a
// tank mix (EquipmentPage.jsx only calls GET and the recalculate POST) — a
// technician naming any product_id here would have calculateMixCosts price
// it back, a throwaway-mix probe of the same owner-only catalog cost
// (ADMIN-BUG-R64).
router.post('/tank-mixes', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, service_type, tank_size_gal, products,
      water_gal, coverage_sqft, notes,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Mix name is required' });

    const costs = await calculateMixCosts(
      products || [],
      tank_size_gal || 110,
      coverage_sqft || 0,
    );

    const [mix] = await db('tank_mixes').insert({
      name,
      service_type: service_type || null,
      tank_size_gal: tank_size_gal || 110,
      products: JSON.stringify(costs.products || products || []),
      water_gal: water_gal || null,
      coverage_sqft: coverage_sqft || null,
      cost_per_tank: costs.cost_per_tank,
      cost_per_1000sf: costs.cost_per_1000sf,
      notes: notes || null,
    }).returning('*');

    logger.info(`Tank mix created: ${mix.name}`);
    // cost_incomplete is response-level (no tank_mixes column): the per-line
    // cost_unknown flags persist inside products, and surfaces must not
    // present a partial total as complete (r6-push P1).
    res.status(201).json({ tank_mix: { ...mix, ...(costs.cost_incomplete ? { cost_incomplete: true } : {}) } });
  } catch (err) {
    next(err);
  }
});

// PUT /tank-mixes/:id — update. Admin-only, same reasoning as the create
// route above — no UI edits a tank mix, and the bare `{ ...req.body }`
// pass-through would let a technician set cost_per_tank/cost_per_1000sf or
// re-probe a product's cost directly (ADMIN-BUG-R64).
router.put('/tank-mixes/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await db('tank_mixes').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Tank mix not found' });

    const updates = { ...req.body, updated_at: db.fn.now() };
    delete updates.id;
    delete updates.created_at;

    // Recalculate costs if products changed
    if (updates.products) {
      const tankSize = updates.tank_size_gal || existing.tank_size_gal;
      const coverage = updates.coverage_sqft || existing.coverage_sqft;
      const costs = await calculateMixCosts(updates.products, tankSize, coverage);
      updates.products = JSON.stringify(costs.products || updates.products);
      updates.cost_per_tank = costs.cost_per_tank;
      updates.cost_per_1000sf = costs.cost_per_1000sf;
      updates._costIncomplete = costs.cost_incomplete === true;
    } else if (updates.products !== undefined) {
      updates.products = JSON.stringify(updates.products);
    }

    const costIncomplete = updates._costIncomplete === true;
    delete updates._costIncomplete;
    const [mix] = await db('tank_mixes')
      .where({ id: req.params.id })
      .update(updates)
      .returning('*');

    res.json({ tank_mix: { ...mix, ...(costIncomplete ? { cost_incomplete: true } : {}) } });
  } catch (err) {
    next(err);
  }
});

// POST /tank-mixes/:id/recalculate — recalculate costs from current inventory prices
router.post('/tank-mixes/:id/recalculate', async (req, res, next) => {
  try {
    const mix = await db('tank_mixes').where({ id: req.params.id }).first();
    if (!mix) return res.status(404).json({ error: 'Tank mix not found' });

    const products = typeof mix.products === 'string' ? JSON.parse(mix.products) : (mix.products || []);
    const costs = await calculateMixCosts(products, mix.tank_size_gal, mix.coverage_sqft);

    const [updated] = await db('tank_mixes')
      .where({ id: req.params.id })
      .update({
        products: JSON.stringify(costs.products || products),
        cost_per_tank: costs.cost_per_tank,
        cost_per_1000sf: costs.cost_per_1000sf,
        updated_at: db.fn.now(),
      })
      .returning('*');

    logger.info(`Tank mix recalculated: ${updated.name} — $${costs.cost_per_tank}/tank`);
    const responseMix = { ...updated, ...(costs.cost_incomplete ? { cost_incomplete: true } : {}) };
    res.json({ tank_mix: req.techRole === 'admin' ? responseMix : stripMixOwnerOnlyCost(responseMix) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// JOB COSTING
// =========================================================================

// GET /job-costs — list with date range filter
router.get('/job-costs', async (req, res, next) => {
  try {
    const { start_date, end_date, service_type, customer_id, page = 1, limit = 50 } = req.query;

    let query = db('job_costs')
      .leftJoin('customers', 'job_costs.customer_id', 'customers.id')
      .select(
        'job_costs.*',
        db.raw("COALESCE(customers.first_name || ' ' || customers.last_name, 'Unknown') as customer_name")
      )
      .orderBy('job_costs.service_date', 'desc');

    if (start_date) query = query.where('job_costs.service_date', '>=', start_date);
    if (end_date) query = query.where('job_costs.service_date', '<=', end_date);
    if (service_type) query = query.where('job_costs.service_type', service_type);
    if (customer_id) query = query.where('job_costs.customer_id', customer_id);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const jobs = await query.limit(parseInt(limit)).offset(offset);

    const [{ count }] = await db('job_costs').count('* as count');

    res.json({ job_costs: jobs, costs: jobs, total: parseInt(count), page: parseInt(page) });
  } catch (err) {
    next(err);
  }
});

// POST /job-costs — create job cost record
router.post('/job-costs', async (req, res, next) => {
  try {
    const {
      service_record_id, customer_id, service_date, service_type,
      products_cost, labor_cost, drive_cost, equipment_cost,
      revenue, tank_mix_id, sqft_treated, products_used,
    } = req.body;

    if (!customer_id || !service_date) {
      return res.status(400).json({ error: 'customer_id and service_date are required' });
    }

    const prodCost = parseFloat(products_cost) || 0;
    const labCost = parseFloat(labor_cost) || 0;
    const drvCost = parseFloat(drive_cost) || 0;
    const eqCost = parseFloat(equipment_cost) || 0;
    const totalCost = prodCost + labCost + drvCost + eqCost;
    const rev = parseFloat(revenue) || 0;
    const grossProfit = rev - totalCost;
    const marginPct = rev > 0 ? Math.round((grossProfit / rev) * 10000) / 100 : 0;

    const [job] = await db('job_costs').insert({
      service_record_id: service_record_id || null,
      customer_id,
      service_date,
      service_type: service_type || null,
      products_cost: prodCost,
      labor_cost: labCost,
      drive_cost: drvCost,
      equipment_cost: eqCost,
      total_cost: totalCost,
      revenue: rev,
      gross_profit: grossProfit,
      margin_pct: marginPct,
      tank_mix_id: tank_mix_id || null,
      sqft_treated: sqft_treated || null,
      products_used: products_used ? JSON.stringify(products_used) : '[]',
    }).returning('*');

    logger.info(`Job cost recorded: ${service_type} on ${service_date} — margin ${marginPct}%`);
    res.status(201).json({ job_cost: job });
  } catch (err) {
    next(err);
  }
});

// GET /job-costs/summary — margins by service type, avg cost per service
router.get('/job-costs/summary', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;

    let query = db('job_costs');
    if (start_date) query = query.where('service_date', '>=', start_date);
    if (end_date) query = query.where('service_date', '<=', end_date);

    const byType = await query.clone()
      .select('service_type')
      .count('* as total_jobs')
      .sum('revenue as total_revenue')
      .sum('total_cost as total_costs')
      .sum('gross_profit as total_profit')
      .avg('margin_pct as avg_margin')
      .avg('products_cost as avg_products_cost')
      .avg('labor_cost as avg_labor_cost')
      .avg('drive_cost as avg_drive_cost')
      .avg('equipment_cost as avg_equipment_cost')
      .groupBy('service_type')
      .orderBy('total_jobs', 'desc');

    const overall = await query.clone()
      .count('* as total_jobs')
      .sum('revenue as total_revenue')
      .sum('total_cost as total_costs')
      .sum('gross_profit as total_profit')
      .avg('margin_pct as avg_margin')
      .first();

    const byServiceType = byType.map(row => ({
        ...row,
        avg_margin: row.avg_margin ? Math.round(parseFloat(row.avg_margin) * 100) / 100 : 0,
      }));
    const normalizedOverall = {
        ...overall,
        avg_margin: overall?.avg_margin ? Math.round(parseFloat(overall.avg_margin) * 100) / 100 : 0,
      };
    const totalJobs = parseInt(normalizedOverall.total_jobs) || 0;
    const totalRevenue = parseFloat(normalizedOverall.total_revenue) || 0;
    const totalCosts = parseFloat(normalizedOverall.total_costs) || 0;

    res.json({
      by_service_type: byServiceType,
      overall: normalizedOverall,
      byServiceType: Object.fromEntries(byServiceType.map(row => {
        const count = parseInt(row.total_jobs) || 0;
        return [
          row.service_type || 'Unspecified',
          {
            count,
            avgRevenue: count > 0 ? (parseFloat(row.total_revenue) || 0) / count : 0,
            avgCost: count > 0 ? (parseFloat(row.total_costs) || 0) / count : 0,
            avgMargin: parseFloat(row.avg_margin) || 0,
          },
        ];
      })),
      avgMargin: normalizedOverall.avg_margin,
      avgRevenue: totalJobs > 0 ? totalRevenue / totalJobs : 0,
      avgCost: totalJobs > 0 ? totalCosts / totalJobs : 0,
      totalJobs,
    });
  } catch (err) {
    next(err);
  }
});

// POST /job-costs/auto-calculate/:serviceRecordId — auto-calculate from service record
router.post('/job-costs/auto-calculate/:serviceRecordId', async (req, res, next) => {
  try {
    const serviceRecord = await db('service_records')
      .where({ id: req.params.serviceRecordId })
      .first();

    if (!serviceRecord) {
      return res.status(404).json({ error: 'Service record not found' });
    }

    // Defaults for SW Florida pest control / lawn care
    const IRS_MILEAGE_RATE = 0.67; // 2024 standard mileage rate
    const DEFAULT_TECH_HOURLY = 22; // avg tech rate
    const DEFAULT_SERVICE_MINUTES = 30;
    const DAILY_EQUIPMENT_COST = 15; // rough daily depreciation allocation

    // Labor cost
    const minutes = serviceRecord.duration_minutes || DEFAULT_SERVICE_MINUTES;
    const laborCost = Math.round((minutes / 60) * DEFAULT_TECH_HOURLY * 100) / 100;

    // Drive cost (estimate from mileage if available)
    const miles = serviceRecord.drive_miles || 8; // avg drive in SW FL
    const driveCost = Math.round(miles * IRS_MILEAGE_RATE * 100) / 100;

    // Equipment cost (daily depreciation split across avg jobs/day)
    const jobsPerDay = 8;
    const equipmentCost = Math.round((DAILY_EQUIPMENT_COST / jobsPerDay) * 100) / 100;

    // Products cost — try to calculate from tank mix and sqft
    let productsCost = 0;
    const sqft = serviceRecord.property_sqft || req.body.sqft_treated || 5000;

    if (req.body.tank_mix_id) {
      const mix = await db('tank_mixes').where({ id: req.body.tank_mix_id }).first();
      if (mix && mix.cost_per_1000sf) {
        productsCost = Math.round(parseFloat(mix.cost_per_1000sf) * (sqft / 1000) * 100) / 100;
      }
    }

    // Revenue from service record or body
    const revenue = parseFloat(req.body.revenue || serviceRecord.price || 0);

    const totalCost = productsCost + laborCost + driveCost + equipmentCost;
    const grossProfit = revenue - totalCost;
    const marginPct = revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0;

    const [job] = await db('job_costs').insert({
      service_record_id: req.params.serviceRecordId,
      customer_id: serviceRecord.customer_id,
      service_date: serviceRecord.service_date || etDateString(),
      service_type: serviceRecord.service_type || null,
      products_cost: productsCost,
      labor_cost: laborCost,
      drive_cost: driveCost,
      equipment_cost: equipmentCost,
      total_cost: totalCost,
      revenue,
      gross_profit: grossProfit,
      margin_pct: marginPct,
      tank_mix_id: req.body.tank_mix_id || null,
      sqft_treated: sqft,
      products_used: '[]',
    }).returning('*');

    logger.info(`Auto job cost: ${serviceRecord.service_type} — margin ${marginPct}%`);
    res.status(201).json({
      job_cost: job,
      calculation_details: {
        labor: { minutes, hourly_rate: DEFAULT_TECH_HOURLY, cost: laborCost },
        drive: { miles, rate_per_mile: IRS_MILEAGE_RATE, cost: driveCost },
        equipment: { daily_depreciation: DAILY_EQUIPMENT_COST, jobs_per_day: jobsPerDay, cost: equipmentCost },
        products: { sqft, cost: productsCost },
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// DASHBOARD — equipment + margin overview
// =========================================================================

router.get('/dashboard', async (req, res, next) => {
  try {
    // Equipment status overview
    const equipmentByStatus = await db('equipment')
      .select('status')
      .count('* as count')
      .groupBy('status');

    // Upcoming maintenance (within 20 hours)
    const upcomingMaintenance = await db('equipment')
      .whereNotNull('next_service_hours')
      .whereRaw('"next_service_hours" - "current_hours" <= 20')
      .where('status', '!=', 'retired')
      .select('id', 'name', 'category', 'current_hours', 'next_service_hours', 'next_service_type')
      .orderByRaw('"next_service_hours" - "current_hours" ASC');

    // Recent maintenance
    const recentMaintenance = await db('maintenance_records')
      .join('equipment', 'maintenance_records.equipment_id', 'equipment.id')
      .select(
        'maintenance_records.*',
        'equipment.name as equipment_name'
      )
      .orderBy('maintenance_records.performed_at', 'desc')
      .limit(10);

    // Margin summary — last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const marginSummary = await db('job_costs')
      .where('service_date', '>=', thirtyDaysAgo.toISOString().split('T')[0])
      .count('* as total_jobs')
      .sum('revenue as total_revenue')
      .sum('total_cost as total_costs')
      .sum('gross_profit as total_profit')
      .avg('margin_pct as avg_margin')
      .first();

    // Equipment total book value
    const [{ total_book_value }] = await db('equipment')
      .where('status', '!=', 'retired')
      .sum('book_value as total_book_value');

    const [{ total_purchase_value }] = await db('equipment')
      .where('status', '!=', 'retired')
      .sum('purchase_price as total_purchase_value');

    res.json({
      equipment_status: equipmentByStatus,
      upcoming_maintenance: upcomingMaintenance.map(eq => ({
        ...eq,
        hours_until_service: parseFloat(eq.next_service_hours) - parseFloat(eq.current_hours),
      })),
      recent_maintenance: recentMaintenance,
      margin_summary_30d: {
        ...marginSummary,
        avg_margin: marginSummary?.avg_margin
          ? Math.round(parseFloat(marginSummary.avg_margin) * 100) / 100
          : 0,
      },
      asset_value: {
        total_book_value: parseFloat(total_book_value) || 0,
        total_purchase_value: parseFloat(total_purchase_value) || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
