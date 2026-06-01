/**
 * Admin Equipment Systems & Calibrations — PR 1.2 of the WaveGuard rollout.
 *
 * Distinct concept from server/routes/admin-equipment.js, which handles
 * single-asset inventory + tank-mix recipes + job costing. This router
 * owns the *composed* spray rig — the (tank + pump + reel + hose + gun
 * + nozzle) combinations the plan engine reads carrier-rate from. Keeping
 * the two namespaces apart so a route name like /equipment/:id doesn't
 * have to disambiguate "asset" vs "system".
 *
 *   GET  /                    — list active equipment systems
 *   GET  /:id                 — one system + its current active calibration
 *   GET  /calibrations        — active calibrations across all systems
 *   POST /calibrations/:id/verify — verify an estimated calibration with field measurements
 *   POST /:id/calibrations    — record a new calibration; deactivates prior active
 *                                 in the same trx so the unique-active partial
 *                                 index can't catch a race
 *   PUT  /calibrations/:id    — amend notes / deactivate a stale calibration
 *
 * No mix calculator here — PR 1.2 only makes calibrated equipment data
 * available. The treatment-plan engine reads it later.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const {
  SYSTEM_ASSET_FIELDS,
  COMPONENT_ASSET_FIELDS,
  SYSTEM_ASSET_LABELS,
  buildEquipmentReconciliation,
} = require('../services/equipment-reconciliation');

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// Sensible bounds. A backpack at 0.25 gal/1k or a 110-gal rig at 4.0 gal/1k
// are both legitimate. Anything below 0.05 or above 10.0 is almost
// certainly a measurement / unit error.
const CARRIER_MIN = 0.05;
const CARRIER_MAX = 10.0;
const DEFAULT_EXPIRY_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// technician_id intentionally NOT in this whitelist. POST always uses
// the auth-derived req.technicianId; PUT never lets the caller change
// who recorded the calibration. Lets the audit trail stay trustworthy.
const CALIBRATION_COLUMNS = [
  'carrier_gal_per_1000',
  'test_area_sqft', 'captured_gallons',
  'pressure_psi', 'engine_rpm_setting',
  'swath_width_ft', 'pass_time_seconds',
  'calibration_status', 'estimated_sq_ft_per_4gal_tank', 'flow_output_reference_gpm',
  'likely_sq_ft_per_4gal_tank_min', 'likely_sq_ft_per_4gal_tank_max',
  'carrier_gal_per_1000_range_min', 'carrier_gal_per_1000_range_max',
  'conservative_carrier_gal_per_1000', 'conservative_sq_ft_per_4gal_tank',
  'estimated_sq_ft_per_full_tank', 'estimated_acres_per_full_tank',
  'tank_size_gallons', 'gun_output_reference_gpm', 'pump_output_reference_gpm',
  'pass_time_reference',
  'low_volume_carrier_gal_per_1000', 'low_volume_sq_ft_per_full_tank',
  'heavy_carrier_gal_per_1000', 'heavy_sq_ft_per_full_tank',
  'very_heavy_carrier_gal_per_1000', 'very_heavy_sq_ft_per_full_tank',
  'recommended_test_area_sqft', 'expected_refill_gallons',
  'acceptable_first_pass_refill_min_gallons', 'acceptable_first_pass_refill_max_gallons',
  'final_formula',
  'pump_pressure_reference_psi', 'pump_amp_reference', 'pump_weight_reference_lb',
  'electric_pump_setting', 'target_bucket_30_sec_oz',
  'low_volume_bucket_30_sec_oz', 'heavy_bucket_30_sec_oz',
  'very_heavy_bucket_30_sec_oz', 'pump_max_bucket_30_sec_oz',
  'incorrect_pump_max_carrier_gal_per_1000',
  'incorrect_pump_max_sq_ft_per_full_tank',
  'incorrect_pump_max_acres_per_full_tank',
  'example_result',
  'verified_at', 'verified_test_area_sqft', 'verified_captured_gallons',
  'verification_notes', 'previous_calibration_status',
  'calibrated_at', 'expires_at', 'active',
  'notes',
];

function pickCalibrationFields(body) {
  const out = {};
  for (const k of CALIBRATION_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

function pickSystemAssetFields(body) {
  const out = {};
  for (const k of SYSTEM_ASSET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      out[k] = body[k] === '' ? null : body[k];
    }
  }
  return out;
}

function invalidSystemAssetIdFields(payload) {
  return Object.entries(payload)
    .filter(([, value]) => value != null && !(typeof value === 'string' && UUID_RE.test(value)))
    .map(([field]) => field);
}

function compactEquipmentAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    asset_tag: row.asset_tag,
    category: row.category,
    status: row.status,
    make: row.make,
    model: row.model,
    serial_number: row.serial_number,
  };
}

async function loadSystemAssets(system) {
  const ids = SYSTEM_ASSET_FIELDS
    .map(field => system?.[field])
    .filter(Boolean);

  if (!ids.length) {
    return {
      primary_equipment: null,
      component_assets: Object.fromEntries(
        COMPONENT_ASSET_FIELDS.map(field => [field.replace('_asset_id', ''), null]),
      ),
    };
  }

  const rows = await db('equipment')
    .whereIn('id', [...new Set(ids)])
    .select('id', 'name', 'asset_tag', 'category', 'status', 'make', 'model', 'serial_number');
  const byId = new Map(rows.map(row => [row.id, row]));

  return {
    primary_equipment: compactEquipmentAsset(byId.get(system.primary_equipment_id)),
    component_assets: Object.fromEntries(
      COMPONENT_ASSET_FIELDS.map(field => [
        field.replace('_asset_id', ''),
        compactEquipmentAsset(byId.get(system[field])),
      ]),
    ),
  };
}

// Columns that the schema declares NOT NULL. Sending an explicit null
// for any of these would pass the value into the update object, then
// get rejected at the DB → 500 instead of a clean 400. Reject up front
// so a malformed admin request becomes a client error, not a server one.
//
// calibrated_at is included because the PUT update loop now iterates
// CALIBRATION_COLUMNS (so callers can edit calibrated_at). Without this,
// `{"calibrated_at": null}` slips past the validator and crashes the
// NOT NULL constraint. Was a regression from the drop-validated-fields
// fix in 184deae — caught by Codex on 41cd8b6.
const NOT_NULL_COLUMNS = ['carrier_gal_per_1000', 'active', 'calibrated_at'];

// Boolean columns. Postgres won't coerce strings like "maybe" or "true"
// to booleans without complaint — it'll throw "invalid input syntax
// for type boolean" which surfaces as a 500. Type-check at the boundary.
const BOOLEAN_COLUMNS = ['active'];

// String column max-lengths from the schema (migration 20260430000008).
// Submitting more than the column allows produces "value too long for
// type character varying(N)" → 500. Reject upstream with a 400 that
// names the field and limit so the caller can fix the input.
const STRING_MAX_LENGTHS = {
  engine_rpm_setting: 30,
  calibration_status: 40,
  pass_time_reference: 160,
  final_formula: 180,
  electric_pump_setting: 160,
  example_result: 180,
  previous_calibration_status: 40,
};

// Date fields the route accepts from clients. We must validate the
// parsed Date is finite before letting it reach Postgres — `new Date()`
// will happily return Invalid Date for garbage input, then bubble as
// a "invalid input syntax for type timestamp" 500.
const DATE_COLUMNS = ['calibrated_at', 'expires_at', 'verified_at'];

// Stricter Number() that only accepts actual numbers and numeric
// strings. Without these guards, JS's coercion table lets booleans,
// arrays, and various objects slip past:
//   Number(true)    === 1
//   Number(false)   === 0
//   Number([])      === 0
//   Number([1])     === 1
//   Number('')      === 0
//   Number(' ')     === 0
// Postgres then rejects whichever non-numeric primitive bubbles
// through with 22P02 → 500 instead of a clean 400. Limit the
// accepted input shape to number-or-string and reject empty /
// whitespace-only strings explicitly.
function parseFiniteNumber(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return NaN;
  if (typeof v === 'string' && v.trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validateCalibrationPayload(payload, { requireCarrier = true } = {}) {
  const errors = [];

  // ── carrier_gal_per_1000 ───────────────────────────────────────────
  // Distinguish "key omitted" from "key sent as null". On POST,
  // requireCarrier=true demands the key be present; on PUT, the key
  // may be omitted (partial update) but if it IS sent, it must not
  // be null on this NOT NULL column.
  const carrierSent = Object.prototype.hasOwnProperty.call(payload, 'carrier_gal_per_1000');
  const carrierIsNull = carrierSent && payload.carrier_gal_per_1000 === null;
  if (!carrierSent) {
    if (requireCarrier) errors.push('carrier_gal_per_1000 is required');
  } else if (carrierIsNull) {
    errors.push('carrier_gal_per_1000 cannot be null');
  } else {
    const n = parseFiniteNumber(payload.carrier_gal_per_1000);
    if (Number.isNaN(n) || n < CARRIER_MIN || n > CARRIER_MAX) {
      errors.push(`carrier_gal_per_1000 must be between ${CARRIER_MIN} and ${CARRIER_MAX}`);
    }
  }

  // ── other NOT NULL columns ─────────────────────────────────────────
  // For NOT NULL columns OTHER than carrier (which is handled above
  // because it has a range check), reject explicit null with a clear
  // 400. `active` is the only one in the PUT whitelist, but the loop
  // future-proofs adding more NOT NULL columns to the whitelist.
  for (const k of NOT_NULL_COLUMNS) {
    if (k === 'carrier_gal_per_1000') continue; // already handled
    if (
      Object.prototype.hasOwnProperty.call(payload, k)
      && payload[k] === null
    ) {
      errors.push(`${k} cannot be null`);
    }
  }

  // ── boolean type check ─────────────────────────────────────────────
  // `{"active": "maybe"}` would pass the null check above, then
  // Postgres would reject the string→boolean cast as a 500. Reject
  // at the boundary; only true / false land in the update object.
  for (const k of BOOLEAN_COLUMNS) {
    if (
      Object.prototype.hasOwnProperty.call(payload, k)
      && payload[k] !== null
      && payload[k] !== undefined
      && typeof payload[k] !== 'boolean'
    ) {
      errors.push(`${k} must be a boolean (true or false)`);
    }
  }

  // ── string length caps ─────────────────────────────────────────────
  // Schema declares string column sizes; over-length input throws
  // "value too long for type character varying(N)" → 500. Cap them
  // here so the validator owns the constraint, not Postgres.
  for (const [k, max] of Object.entries(STRING_MAX_LENGTHS)) {
    if (
      Object.prototype.hasOwnProperty.call(payload, k)
      && payload[k] !== null
      && payload[k] !== undefined
      && typeof payload[k] === 'string'
      && payload[k].length > max
    ) {
      errors.push(`${k} must be ${max} characters or fewer`);
    }
  }

  // ── nullable numeric columns ───────────────────────────────────────
  // test_area_sqft is the only INTEGER column in the calibration
  // numeric set (others are decimal). The schema would silently round
  // a fractional input or 500 on the integer cast, so enforce
  // Number.isInteger upfront.
  const INTEGER_NUMERIC_COLUMNS = new Set(['test_area_sqft', 'verified_test_area_sqft']);
  for (const k of [
    'test_area_sqft', 'captured_gallons',
    'pressure_psi', 'swath_width_ft', 'pass_time_seconds',
    'estimated_sq_ft_per_4gal_tank', 'flow_output_reference_gpm',
    'likely_sq_ft_per_4gal_tank_min', 'likely_sq_ft_per_4gal_tank_max',
    'carrier_gal_per_1000_range_min', 'carrier_gal_per_1000_range_max',
    'conservative_carrier_gal_per_1000', 'conservative_sq_ft_per_4gal_tank',
    'estimated_sq_ft_per_full_tank', 'estimated_acres_per_full_tank',
    'tank_size_gallons', 'gun_output_reference_gpm', 'pump_output_reference_gpm',
    'low_volume_carrier_gal_per_1000', 'low_volume_sq_ft_per_full_tank',
    'heavy_carrier_gal_per_1000', 'heavy_sq_ft_per_full_tank',
    'very_heavy_carrier_gal_per_1000', 'very_heavy_sq_ft_per_full_tank',
    'recommended_test_area_sqft', 'expected_refill_gallons',
    'acceptable_first_pass_refill_min_gallons', 'acceptable_first_pass_refill_max_gallons',
    'pump_pressure_reference_psi', 'pump_amp_reference', 'pump_weight_reference_lb',
    'target_bucket_30_sec_oz', 'low_volume_bucket_30_sec_oz',
    'heavy_bucket_30_sec_oz', 'very_heavy_bucket_30_sec_oz',
    'pump_max_bucket_30_sec_oz',
    'incorrect_pump_max_carrier_gal_per_1000',
    'incorrect_pump_max_sq_ft_per_full_tank',
    'incorrect_pump_max_acres_per_full_tank',
    'verified_test_area_sqft', 'verified_captured_gallons',
  ]) {
    if (payload[k] != null) {
      const n = parseFiniteNumber(payload[k]);
      if (Number.isNaN(n) || n < 0) {
        errors.push(`${k} must be a non-negative number`);
      } else if (INTEGER_NUMERIC_COLUMNS.has(k) && !Number.isInteger(n)) {
        errors.push(`${k} must be a non-negative integer`);
      }
    }
  }

  if (
    payload.acceptable_first_pass_refill_min_gallons != null
    && payload.acceptable_first_pass_refill_max_gallons != null
    && Number(payload.acceptable_first_pass_refill_min_gallons) > Number(payload.acceptable_first_pass_refill_max_gallons)
  ) {
    errors.push('acceptable_first_pass_refill_min_gallons cannot exceed acceptable_first_pass_refill_max_gallons');
  }

  // ── date fields ────────────────────────────────────────────────────
  // expires_at IS nullable in the schema (an open-ended calibration
  // is allowed), but if a non-null value is sent it must parse. Same
  // for calibrated_at on POST (defaults to now() server-side, so null
  // / omitted is fine).
  for (const k of DATE_COLUMNS) {
    if (
      Object.prototype.hasOwnProperty.call(payload, k)
      && payload[k] !== null
      && payload[k] !== undefined
    ) {
      const d = new Date(payload[k]);
      if (Number.isNaN(d.getTime())) {
        errors.push(`${k} must be a valid ISO date string`);
      }
    }
  }

  return errors;
}

// =========================================================================
// GET / — list active systems
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const systems = await db('equipment_systems')
      .where({ active: true })
      .orderBy('system_type', 'asc')
      .orderBy('name', 'asc');
    res.json({ systems });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /reconciliation — operational/tax/system linkage report
// =========================================================================
router.get('/reconciliation', async (req, res, next) => {
  try {
    const [systems, equipment, taxRegister, calibrations] = await Promise.all([
      db('equipment_systems')
        .orderBy('active', 'desc')
        .orderBy('system_type', 'asc')
        .orderBy('name', 'asc'),
      db('equipment')
        .select(
          'id',
          'name',
          'asset_tag',
          'category',
          'status',
          'make',
          'model',
          'serial_number',
          'purchase_price',
          'tax_equipment_id',
        )
        .orderBy('name', 'asc'),
      db('equipment_register')
        .select(
          'id',
          'name',
          'asset_category',
          'active',
          'disposed',
          'purchase_cost',
          'current_book_value',
          'serial_number',
          'make_model',
        )
        .orderBy('name', 'asc'),
      db('equipment_calibrations')
        .where({ active: true })
        .select('id', 'equipment_system_id', 'carrier_gal_per_1000', 'calibrated_at', 'expires_at'),
    ]);

    res.json(buildEquipmentReconciliation({
      systems,
      equipment,
      taxRegister,
      calibrations,
    }));
  } catch (err) { next(err); }
});

// =========================================================================
// GET /calibrations — active calibrations across all systems
// (declared BEFORE /:id so Express doesn't match "calibrations" as an id)
// =========================================================================
router.get('/calibrations', async (req, res, next) => {
  try {
    const rows = await db('equipment_calibrations as ec')
      .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
      .where('ec.active', true)
      .where('es.active', true)
      .select(
        'ec.*',
        'es.name as system_name',
        'es.system_type',
        'es.tank_capacity_gal',
      )
      .orderBy('ec.expires_at', 'asc');
    res.json({ calibrations: rows });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /calibrations/:id/verify — convert estimate to field-verified
// =========================================================================
router.post('/calibrations/:id/verify', async (req, res, next) => {
  try {
    const existing = await db('equipment_calibrations').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Calibration not found' });
    if (!existing.active) {
      return res.status(400).json({
        error: 'Only the active calibration can be field-verified',
      });
    }

    const body = req.body || {};
    const measuredTestAreaSqft = body.verified_test_area_sqft ?? body.test_area_sqft ?? body.measured_test_area_sqft;
    const measuredCapturedGallons = body.verified_captured_gallons ?? body.captured_gallons ?? body.measured_captured_gallons;
    const testArea = parseFiniteNumber(measuredTestAreaSqft);
    const captured = parseFiniteNumber(measuredCapturedGallons);
    const errors = [];

    if (!Number.isInteger(testArea) || testArea <= 0) {
      errors.push('verified_test_area_sqft must be a positive integer');
    }
    if (Number.isNaN(captured) || captured <= 0) {
      errors.push('verified_captured_gallons must be a positive number');
    }

    const verifiedAtInput = body.verified_at ?? body.calibrated_at;
    const verifiedAt = verifiedAtInput ? new Date(verifiedAtInput) : new Date();
    if (Number.isNaN(verifiedAt.getTime())) {
      errors.push('verified_at must be a valid ISO date string');
    }

    const verificationNotes = body.verification_notes ?? body.notes ?? null;
    if (typeof verificationNotes === 'string' && verificationNotes.length > 5000) {
      errors.push('verification_notes must be 5000 characters or fewer');
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid calibration verification', details: errors });
    }

    const carrier = Math.round((captured / (testArea / 1000)) * 1000) / 1000;
    if (carrier < CARRIER_MIN || carrier > CARRIER_MAX) {
      return res.status(400).json({
        error: 'Invalid calibration verification',
        details: [`computed carrier_gal_per_1000 must be between ${CARRIER_MIN} and ${CARRIER_MAX}`],
      });
    }

    const expiresAt = body.expires_at
      ? new Date(body.expires_at)
      : new Date(verifiedAt.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    if (Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({
        error: 'Invalid calibration verification',
        details: ['expires_at must be a valid ISO date string'],
      });
    }

    const [saved] = await db('equipment_calibrations')
      .where({ id: existing.id })
      .update({
        previous_calibration_status: existing.calibration_status ?? null,
        calibration_status: 'field_verified',
        carrier_gal_per_1000: carrier,
        test_area_sqft: testArea,
        captured_gallons: captured,
        verified_test_area_sqft: testArea,
        verified_captured_gallons: captured,
        verified_at: verifiedAt,
        verified_by_technician_id: req.technicianId ?? null,
        verification_notes: verificationNotes,
        calibrated_at: verifiedAt,
        expires_at: expiresAt,
        updated_at: new Date(),
      })
      .returning('*');

    logger.info?.(`[equipment] calibration verified id=${existing.id} carrier=${carrier} by tech=${req.technicianId}`);
    res.json({ calibration: saved });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /calibrations/:id — amend notes / deactivate / correct values
// =========================================================================
router.put('/calibrations/:id', async (req, res, next) => {
  try {
    const existing = await db('equipment_calibrations').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Calibration not found' });

    const payload = pickCalibrationFields(req.body || {});
    const errors = validateCalibrationPayload(payload, { requireCarrier: false });
    if (errors.length) return res.status(400).json({ error: 'Invalid calibration', details: errors });

    // Reject re-activating a stale row when another active calibration
    // already exists for this system. Without this guard, the partial
    // unique index `idx_eqcal_one_active_per_system` rejects the write
    // and bubbles as a 500 — surprising for the caller and useless
    // diagnostically. The normal "I want a new active calibration"
    // path is POST /:id/calibrations, which atomically deactivates
    // the prior active in the same trx; PUT-toggling-active is almost
    // always a tech mistake worth surfacing loudly.
    if (payload.active === true && existing.active === false) {
      const conflict = await db('equipment_calibrations')
        .where({ equipment_system_id: existing.equipment_system_id, active: true })
        .whereNot({ id: existing.id })
        .first();
      if (conflict) {
        return res.status(400).json({
          error: 'Cannot activate this calibration while another is active for the same system',
          details: [
            'Use POST /api/admin/equipment-systems/:id/calibrations to record a new calibration (it deactivates the prior active in the same transaction), or PUT active:false on the conflicting row first.',
          ],
          conflicting_calibration_id: conflict.id,
        });
      }
    }

    // active=false is a no-op against the partial unique index;
    // active=true (re-activation) is gated by the pre-check above
    // and the unique-violation catch below — so blindly copying
    // payload.active into the update is safe at this point. Other
    // NOT NULL columns are null-rejected upfront in the validator.
    //
    // Iterate over CALIBRATION_COLUMNS rather than a hand-curated
    // subset. The previous version dropped fields the validator
    // accepted (test_area_sqft, captured_gallons, swath_width_ft,
    // pass_time_seconds, calibrated_at) — callers got a 200 but
    // the values were silently discarded. Anything in
    // CALIBRATION_COLUMNS has been validated; anything not in it
    // (e.g. technician_id) is intentionally excluded.
    const update = { updated_at: new Date() };
    for (const k of CALIBRATION_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) update[k] = payload[k];
    }

    // Belt-and-suspenders for the partial unique index. The pre-check
    // above catches the user-error case with a clear 400, but it has
    // a TOCTOU window: between our SELECT and this UPDATE, a concurrent
    // writer could activate a different calibration for the same
    // system. Without this catch, that race surfaces as a 500. We
    // collapse it into the same 400 shape so callers handle one
    // failure mode regardless of which writer arrived first.
    let saved;
    try {
      [saved] = await db('equipment_calibrations')
        .where({ id: existing.id })
        .update(update)
        .returning('*');
    } catch (err) {
      const isActiveIndexViolation = err
        && err.code === '23505'
        && (err.constraint === 'idx_eqcal_one_active_per_system'
            || /idx_eqcal_one_active_per_system/.test(String(err.message || '')));
      if (isActiveIndexViolation) {
        return res.status(400).json({
          error: 'Cannot activate this calibration while another is active for the same system',
          details: [
            'Another active calibration was created for this system between read and write. Refresh the calibration list and try again, or use POST /api/admin/equipment-systems/:id/calibrations to record a new calibration (it deactivates the prior active in the same transaction).',
          ],
        });
      }
      throw err;
    }

    res.json({ calibration: saved });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /:id/assets — link a calibrated system to operational equipment
// =========================================================================
router.put('/:id/assets', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid equipment system id' });
    }

    const system = await db('equipment_systems').where({ id: req.params.id }).first();
    if (!system) return res.status(404).json({ error: 'Equipment system not found' });

    const payload = pickSystemAssetFields(req.body || {});
    const fields = Object.keys(payload);
    if (!fields.length) {
      return res.status(400).json({
        error: 'No equipment links supplied',
        allowed_fields: SYSTEM_ASSET_FIELDS,
      });
    }

    const invalidFields = invalidSystemAssetIdFields(payload);
    if (invalidFields.length) {
      return res.status(400).json({
        error: 'Invalid equipment link ids',
        invalid_fields: invalidFields,
      });
    }

    const ids = [...new Set(Object.values(payload).filter(Boolean))];
    if (ids.length) {
      const found = await db('equipment').whereIn('id', ids).select('id');
      const foundIds = new Set(found.map(row => row.id));
      const missing = ids.filter(id => !foundIds.has(id));
      if (missing.length) {
        return res.status(400).json({
          error: 'One or more equipment links do not exist',
          missing_equipment_ids: missing,
        });
      }
    }

    const [updated] = await db('equipment_systems')
      .where({ id: req.params.id })
      .update({ ...payload, updated_at: db.fn.now() })
      .returning('*');
    const linkedAssets = await loadSystemAssets(updated);

    logger.info?.(`[equipment] system asset links updated system=${req.params.id} fields=${fields.join(',')}`);
    res.json({
      system: updated,
      link_labels: SYSTEM_ASSET_LABELS,
      ...linkedAssets,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /:id — system + active calibration
// =========================================================================
router.get('/:id', async (req, res, next) => {
  try {
    const system = await db('equipment_systems').where({ id: req.params.id }).first();
    if (!system) return res.status(404).json({ error: 'Equipment system not found' });

    const calibration = await db('equipment_calibrations')
      .where({ equipment_system_id: req.params.id, active: true })
      .first();

    const linkedAssets = await loadSystemAssets(system);

    res.json({
      system,
      calibration: calibration || null,
      link_labels: SYSTEM_ASSET_LABELS,
      ...linkedAssets,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /:id/calibrations — record new calibration; deactivate prior active
// =========================================================================
router.post('/:id/calibrations', async (req, res, next) => {
  try {
    const systemId = req.params.id;
    const system = await db('equipment_systems').where({ id: systemId }).first();
    if (!system) return res.status(404).json({ error: 'Equipment system not found' });

    const payload = pickCalibrationFields(req.body || {});
    const errors = validateCalibrationPayload(payload, { requireCarrier: true });
    if (errors.length) return res.status(400).json({ error: 'Invalid calibration', details: errors });

    const calibratedAt = payload.calibrated_at ? new Date(payload.calibrated_at) : new Date();
    const expiresAt = payload.expires_at
      ? new Date(payload.expires_at)
      : new Date(calibratedAt.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    let saved;
    try {
      saved = await db.transaction(async (trx) => {
        // Deactivate the prior active row for this system in the same
        // trx the new insert runs in. The unique partial index on
        // (equipment_system_id) WHERE active=true will reject a parallel
        // attempt — this trx makes that the "good" race outcome instead
        // of the "panic" one.
        await trx('equipment_calibrations')
          .where({ equipment_system_id: systemId, active: true })
          .update({ active: false, updated_at: new Date() });

        const [row] = await trx('equipment_calibrations').insert({
          equipment_system_id: systemId,
          // technician_id is auth-derived only — never trust the payload.
          // The original `payload.technician_id ?? req.technicianId` let
          // any logged-in tech attribute a calibration to a different
          // tech by posting their UUID, which would corrupt the audit
          // trail. A future "backfill an old calibration as someone
          // else" path would need an explicit admin-only override route.
          technician_id: req.technicianId ?? null,
          carrier_gal_per_1000: payload.carrier_gal_per_1000,
          test_area_sqft: payload.test_area_sqft ?? null,
          captured_gallons: payload.captured_gallons ?? null,
          pressure_psi: payload.pressure_psi ?? null,
          engine_rpm_setting: payload.engine_rpm_setting ?? null,
          swath_width_ft: payload.swath_width_ft ?? null,
          pass_time_seconds: payload.pass_time_seconds ?? null,
          calibration_status: payload.calibration_status ?? null,
          estimated_sq_ft_per_4gal_tank: payload.estimated_sq_ft_per_4gal_tank ?? null,
          flow_output_reference_gpm: payload.flow_output_reference_gpm ?? null,
          likely_sq_ft_per_4gal_tank_min: payload.likely_sq_ft_per_4gal_tank_min ?? null,
          likely_sq_ft_per_4gal_tank_max: payload.likely_sq_ft_per_4gal_tank_max ?? null,
          carrier_gal_per_1000_range_min: payload.carrier_gal_per_1000_range_min ?? null,
          carrier_gal_per_1000_range_max: payload.carrier_gal_per_1000_range_max ?? null,
          conservative_carrier_gal_per_1000: payload.conservative_carrier_gal_per_1000 ?? null,
          conservative_sq_ft_per_4gal_tank: payload.conservative_sq_ft_per_4gal_tank ?? null,
          estimated_sq_ft_per_full_tank: payload.estimated_sq_ft_per_full_tank ?? null,
          estimated_acres_per_full_tank: payload.estimated_acres_per_full_tank ?? null,
          tank_size_gallons: payload.tank_size_gallons ?? null,
          gun_output_reference_gpm: payload.gun_output_reference_gpm ?? null,
          pump_output_reference_gpm: payload.pump_output_reference_gpm ?? null,
          pass_time_reference: payload.pass_time_reference ?? null,
          low_volume_carrier_gal_per_1000: payload.low_volume_carrier_gal_per_1000 ?? null,
          low_volume_sq_ft_per_full_tank: payload.low_volume_sq_ft_per_full_tank ?? null,
          heavy_carrier_gal_per_1000: payload.heavy_carrier_gal_per_1000 ?? null,
          heavy_sq_ft_per_full_tank: payload.heavy_sq_ft_per_full_tank ?? null,
          very_heavy_carrier_gal_per_1000: payload.very_heavy_carrier_gal_per_1000 ?? null,
          very_heavy_sq_ft_per_full_tank: payload.very_heavy_sq_ft_per_full_tank ?? null,
          recommended_test_area_sqft: payload.recommended_test_area_sqft ?? null,
          expected_refill_gallons: payload.expected_refill_gallons ?? null,
          acceptable_first_pass_refill_min_gallons: payload.acceptable_first_pass_refill_min_gallons ?? null,
          acceptable_first_pass_refill_max_gallons: payload.acceptable_first_pass_refill_max_gallons ?? null,
          final_formula: payload.final_formula ?? null,
          pump_pressure_reference_psi: payload.pump_pressure_reference_psi ?? null,
          pump_amp_reference: payload.pump_amp_reference ?? null,
          pump_weight_reference_lb: payload.pump_weight_reference_lb ?? null,
          electric_pump_setting: payload.electric_pump_setting ?? null,
          target_bucket_30_sec_oz: payload.target_bucket_30_sec_oz ?? null,
          low_volume_bucket_30_sec_oz: payload.low_volume_bucket_30_sec_oz ?? null,
          heavy_bucket_30_sec_oz: payload.heavy_bucket_30_sec_oz ?? null,
          very_heavy_bucket_30_sec_oz: payload.very_heavy_bucket_30_sec_oz ?? null,
          pump_max_bucket_30_sec_oz: payload.pump_max_bucket_30_sec_oz ?? null,
          incorrect_pump_max_carrier_gal_per_1000: payload.incorrect_pump_max_carrier_gal_per_1000 ?? null,
          incorrect_pump_max_sq_ft_per_full_tank: payload.incorrect_pump_max_sq_ft_per_full_tank ?? null,
          incorrect_pump_max_acres_per_full_tank: payload.incorrect_pump_max_acres_per_full_tank ?? null,
          example_result: payload.example_result ?? null,
          calibrated_at: calibratedAt,
          expires_at: expiresAt,
          active: true,
          notes: payload.notes ?? null,
        }).returning('*');
        return row;
      });
    } catch (err) {
      // Race-window catch — same pattern as the PUT path. Two concurrent
      // POSTs for the same system can both pass the deactivate-prior
      // step (each finds no active row at its read), then collide at
      // the partial unique index. Without this, the loser surfaces as
      // a 500 instead of a clean client conflict.
      const isActiveIndexViolation = err
        && err.code === '23505'
        && (err.constraint === 'idx_eqcal_one_active_per_system'
            || /idx_eqcal_one_active_per_system/.test(String(err.message || '')));
      if (isActiveIndexViolation) {
        return res.status(409).json({
          error: 'Calibration write conflicted with a concurrent calibration for the same system',
          details: [
            'Another calibration was saved for this system at the same time. Refresh the calibration list and try again.',
          ],
        });
      }
      throw err;
    }

    logger.info?.(`[equipment] calibration saved system=${systemId} carrier=${saved.carrier_gal_per_1000} by tech=${req.technicianId}`);
    res.json({ calibration: saved });
  } catch (err) { next(err); }
});

module.exports = router;
