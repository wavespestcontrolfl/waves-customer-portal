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
};

// Date fields the route accepts from clients. We must validate the
// parsed Date is finite before letting it reach Postgres — `new Date()`
// will happily return Invalid Date for garbage input, then bubble as
// a "invalid input syntax for type timestamp" 500.
const DATE_COLUMNS = ['calibrated_at', 'expires_at'];

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
  const INTEGER_NUMERIC_COLUMNS = new Set(['test_area_sqft']);
  for (const k of [
    'test_area_sqft', 'captured_gallons',
    'pressure_psi', 'swath_width_ft', 'pass_time_seconds',
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
