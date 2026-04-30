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

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// Sensible bounds. A backpack at 0.25 gal/1k or a 110-gal rig at 4.0 gal/1k
// are both legitimate. Anything below 0.05 or above 10.0 is almost
// certainly a measurement / unit error.
const CARRIER_MIN = 0.05;
const CARRIER_MAX = 10.0;
const DEFAULT_EXPIRY_DAYS = 30;

// technician_id intentionally NOT in this whitelist. POST always uses
// the auth-derived req.technicianId; PUT never lets the caller change
// who recorded the calibration. Lets the audit trail stay trustworthy.
const CALIBRATION_COLUMNS = [
  'carrier_gal_per_1000',
  'test_area_sqft', 'captured_gallons',
  'pressure_psi', 'engine_rpm_setting',
  'swath_width_ft', 'pass_time_seconds',
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

function validateCalibrationPayload(payload, { requireCarrier = true } = {}) {
  const errors = [];
  const carrier = payload.carrier_gal_per_1000;
  if (carrier == null) {
    if (requireCarrier) errors.push('carrier_gal_per_1000 is required');
  } else {
    const n = Number(carrier);
    if (!Number.isFinite(n) || n < CARRIER_MIN || n > CARRIER_MAX) {
      errors.push(`carrier_gal_per_1000 must be between ${CARRIER_MIN} and ${CARRIER_MAX}`);
    }
  }
  for (const k of [
    'test_area_sqft', 'captured_gallons',
    'pressure_psi', 'swath_width_ft', 'pass_time_seconds',
  ]) {
    if (payload[k] != null) {
      const n = Number(payload[k]);
      if (!Number.isFinite(n) || n < 0) errors.push(`${k} must be a non-negative number`);
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

    const update = { updated_at: new Date() };
    for (const k of ['notes', 'active', 'expires_at', 'carrier_gal_per_1000', 'pressure_psi', 'engine_rpm_setting']) {
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
// GET /:id — system + active calibration
// =========================================================================
router.get('/:id', async (req, res, next) => {
  try {
    const system = await db('equipment_systems').where({ id: req.params.id }).first();
    if (!system) return res.status(404).json({ error: 'Equipment system not found' });

    const calibration = await db('equipment_calibrations')
      .where({ equipment_system_id: req.params.id, active: true })
      .first();

    res.json({ system, calibration: calibration || null });
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

    const saved = await db.transaction(async (trx) => {
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
        calibrated_at: calibratedAt,
        expires_at: expiresAt,
        active: true,
        notes: payload.notes ?? null,
      }).returning('*');
      return row;
    });

    logger.info?.(`[equipment] calibration saved system=${systemId} carrier=${saved.carrier_gal_per_1000} by tech=${req.technicianId}`);
    res.json({ calibration: saved });
  } catch (err) { next(err); }
});

module.exports = router;
