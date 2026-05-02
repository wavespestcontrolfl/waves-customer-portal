/**
 * Admin Customer Turf Profile routes — PR 1.1 of the WaveGuard rollout.
 *
 * Two endpoints, both customer-scoped:
 *
 *   GET  /api/admin/customers/:customerId/turf-profile
 *     Returns the profile object, or null when the customer doesn't
 *     have one yet (rather than 404 — null is friendlier for UI
 *     "create-or-edit" state machines).
 *
 *   PUT  /api/admin/customers/:customerId/turf-profile
 *     Upsert by customer_id. One profile per customer (DB unique
 *     constraint enforces). Returns the saved row.
 *
 * No DELETE endpoint in this PR — deactivate-style soft delete will
 * land alongside the plan engine when there's an actual reason to
 * preserve historical profiles.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// Allowed-value lists. Lives in code (not DB enums) so the WaveGuard
// plan engine can extend without a migration. Keep these names in
// sync with what the protocol-rules table will reference.
const GRASS_TYPES = ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'mixed', 'unknown'];
// 'heavy_shade' (not 'shade') — the value name itself signals severity
// for the future plan engine, which treats sun exposure as a modifier
// that gates hot herbicides / PGR rather than a separate protocol track.
// Any pre-existing 'shade' rows were normalized in migration
// 20260501000001_planner_data_prep.js.
const SUN_EXPOSURES = ['full_sun', 'partial_shade', 'heavy_shade'];
const IRRIGATION_TYPES = ['in_ground', 'manual', 'none', 'mixed'];

// Canonical column whitelist for the upsert. Keeps the API a closed
// set — a typo in the request body or a future column rename can't
// silently smuggle data into an unintended column.
const PROFILE_COLUMNS = [
  'grass_type', 'track_key', 'cultivar', 'sun_exposure',
  'lawn_sqft', 'irrigation_type', 'municipality', 'county',
  'soil_test_date', 'soil_ph',
  'known_chinch_history', 'known_disease_history', 'known_drought_stress',
  'annual_n_budget_target', 'active',
];

function pickProfileFields(body) {
  const out = {};
  for (const k of PROFILE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

function validateProfile(payload) {
  const errors = [];

  if (payload.grass_type != null && !GRASS_TYPES.includes(payload.grass_type)) {
    errors.push(`grass_type must be one of: ${GRASS_TYPES.join(', ')}`);
  }
  if (payload.sun_exposure != null && !SUN_EXPOSURES.includes(payload.sun_exposure)) {
    errors.push(`sun_exposure must be one of: ${SUN_EXPOSURES.join(', ')}`);
  }
  if (payload.irrigation_type != null && !IRRIGATION_TYPES.includes(payload.irrigation_type)) {
    errors.push(`irrigation_type must be one of: ${IRRIGATION_TYPES.join(', ')}`);
  }
  if (payload.lawn_sqft != null) {
    // The schema column is integer; the validator must enforce that
    // upfront. Without Number.isInteger, fractional inputs like
    // 1500.7 would coerce on Postgres write — silently rounding the
    // stored value or 500-ing depending on driver. The error message
    // already promised "integer", so the check now matches.
    const n = Number(payload.lawn_sqft);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1_000_000) {
      errors.push('lawn_sqft must be a non-negative integer ≤ 1,000,000');
    }
  }
  if (payload.soil_ph != null) {
    const n = Number(payload.soil_ph);
    if (!Number.isFinite(n) || n < 0 || n > 14) {
      errors.push('soil_ph must be between 0 and 14');
    }
  }
  if (payload.annual_n_budget_target != null) {
    const n = Number(payload.annual_n_budget_target);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      errors.push('annual_n_budget_target must be between 0 and 20 lb N / 1,000 sqft / year');
    }
  }
  return errors;
}

// =========================================================================
// GET /:customerId/turf-profile
// =========================================================================
router.get('/:customerId/turf-profile', async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const profile = await db('customer_turf_profiles')
      .where({ customer_id: customerId })
      .first();

    res.json({ profile: profile || null });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /:customerId/turf-profile — upsert
// =========================================================================
router.put('/:customerId/turf-profile', async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const fields = pickProfileFields(req.body || {});
    const errors = validateProfile(fields);
    if (errors.length) return res.status(400).json({ error: 'Invalid payload', details: errors });

    // Atomic upsert. The previous SELECT-then-conditional-INSERT/UPDATE
    // had a TOCTOU window: two concurrent PUTs could both observe
    // "no profile exists," both attempt INSERT, and the second hit
    // the unique customer_id constraint → 500 for a perfectly valid
    // request. ON CONFLICT DO UPDATE collapses both branches into one
    // statement that the DB enforces atomically. fields ∪ updated_at
    // is the merge set; customer_id stays the conflict key and is
    // never mutated.
    const insertRow = { customer_id: customerId, ...fields };
    const [saved] = await db('customer_turf_profiles')
      .insert(insertRow)
      .onConflict('customer_id')
      .merge({ ...fields, updated_at: new Date() })
      .returning('*');

    logger.info?.(`[turf-profile] saved customer=${customerId} by tech=${req.technicianId}`);
    res.json({ profile: saved });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
