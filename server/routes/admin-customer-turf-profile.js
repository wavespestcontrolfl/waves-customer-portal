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
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const featureGates = require('../config/feature-gates');
const { BERMUDA_REMOVAL_TRACKS, cultivarState, excludedCultivarSql } = require('../services/lawn-bermuda-removal');
const { technicianServicesCustomer } = require('../services/technician-visit-scope');
const logger = require('../services/logger');
const { GRASS_SOURCE } = require('../services/lawn-grass-context');
const { COUNTY_CONFIRMED_FIELD, confirmIrrigationFields } = require('../services/irrigation-schedule-confirmation');

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
  'ordinance_zone', 'irrigation_status', 'irrigation_inches_per_week', 'soil_k_ppm',
  'thatch_measurement_in', 'nematode_assay_flag', 'large_patch_history',
  'last_thatch_checked_at', 'last_chinch_checked_at',
  'soil_test_date', 'soil_ph',
  'known_chinch_history', 'known_disease_history', 'known_drought_stress',
  'annual_n_budget_target', 'active',
];

// GATE_LAWN_BERMUDA_REMOVAL: the staff switch's columns ride the profile row only
// while the gate is on, so a gate-off response is the old payload. Only the
// dedicated PUT below writes them (never PROFILE_COLUMNS).
const BERMUDA_COLUMNS = ['bermuda_removal', 'bermuda_removal_set_by', 'bermuda_removal_set_at'];
// Admins only: a technician never sees the switch or its columns.
const showsBermudaRemoval = (req) => featureGates.lawnBermudaRemovalLive?.() === true && req.techRole === 'admin';
function profileForResponse(profile, req) {
  if (!profile || showsBermudaRemoval(req)) return profile;
  return Object.fromEntries(Object.entries(profile).filter(([key]) => !BERMUDA_COLUMNS.includes(key)));
}

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
  if (payload.ordinance_zone != null && !['sarasota', 'north_port', 'manatee', 'other', 'unknown'].includes(payload.ordinance_zone)) {
    errors.push('ordinance_zone must be one of: sarasota, north_port, manatee, other, unknown');
  }
  if (payload.irrigation_status != null && !['good', 'dry', 'wet', 'unknown'].includes(payload.irrigation_status)) {
    errors.push('irrigation_status must be one of: good, dry, wet, unknown');
  }
  if (payload.irrigation_inches_per_week != null) {
    const n = Number(payload.irrigation_inches_per_week);
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      errors.push('irrigation_inches_per_week must be between 0 and 5 inches');
    }
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
  if (payload.soil_k_ppm != null) {
    const n = Number(payload.soil_k_ppm);
    if (!Number.isFinite(n) || n < 0 || n > 5000) {
      errors.push('soil_k_ppm must be between 0 and 5000');
    }
  }
  if (payload.thatch_measurement_in != null) {
    const n = Number(payload.thatch_measurement_in);
    if (!Number.isFinite(n) || n < 0 || n > 12) {
      errors.push('thatch_measurement_in must be between 0 and 12 inches');
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
    if (!(await technicianServicesCustomer(req, customerId))) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [profile, prefs] = await Promise.all([
      db('customer_turf_profiles').where({ customer_id: customerId }).first(),
      db('property_preferences').where({ customer_id: customerId }).first('irrigation_home_changed_at'),
    ]);

    // Freshness token for the PUT (codex #3565 gh-r44): the panel echoes the
    // move stamp it was rendered against, so a save that races a primary-
    // address change cannot confirm the former home's county/grass.
    // lawn_v13_no_program: GATE_LAWN_V13 is on and this lawn records bahia (any spelling, in any
    // field), so the v13 program has none for it. The server decides, so the Schedule page applies
    // bahia precedence only when it is true and keeps its old resolution otherwise.
    const { lawnV13NoBahiaProgram } = require('../services/lawn-program');
    const { recordedGrassNamesBahia } = require('../services/lawn-grass-context');
    res.json({
      profile: profileForResponse(profile, req) || null,
      irrigation_home_changed_at: prefs?.irrigation_home_changed_at || null,
      lawn_v13_no_program: lawnV13NoBahiaProgram() && recordedGrassNamesBahia(profile, customer.lawn_type),
      // Gate on and an admin only: tells the editor to show the bermuda removal switch.
      ...(showsBermudaRemoval(req) ? { bermudaRemovalAvailable: true } : {}),
    });
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
    if (!(await technicianServicesCustomer(req, customerId))) {
      return res.status(404).json({ error: 'Customer not found' });
    }
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
    const countyConfirmed = (req.body || {}).county_confirmed === true
      && typeof fields.county === 'string' && !!fields.county.trim();
    // Same contract for the grass: an EXPLICIT review flag (the client sets
    // it only when the grass field was touched this session) — a Bahia →
    // Bahia move has no value change to observe, and without this signal
    // the grass could stay on the unknown fallback forever (codex gh-r42).
    const grassReviewed = (req.body || {}).grass_confirmed === true
      && typeof fields.grass_type === 'string' && !!fields.grass_type.trim();
    // Rendered-against move stamp, echoed from the GET (codex gh-r44) — the
    // same freshness contract as the portal autosave: an absent token (or a
    // stale one — the address changed after the form loaded) saves the
    // profile but confirms NOTHING for the weekly plan.
    const stampMs = (v) => (v ? new Date(v).getTime() : null);
    const hasRenderStamp = 'confirmed_as_of' in (req.body || {});
    const renderedAgainstMs = stampMs((req.body || {}).confirmed_as_of ?? null);
    // Customer-lock fence (#3391 GitHub round): FOR UPDATE on the turf row
    // cannot serialize the NO-ROW case, so this upsert could insert the
    // customer's first profile between the click-to-estimate mint's null
    // read and its estimate insert. Shared fence — every price-bearing
    // turf writer takes it (contract-pinned).
    const { withTurfProfileFence } = require('../services/customer-pricing-ai');
    const [saved] = await withTurfProfileFence(db, customerId, async (trx) => {
      // Prior grass, read under the fence: a save that CHANGES the grass is
      // an actual review of the current lawn and re-confirms it for the
      // weekly plan after a move; the form re-sends every loaded field, so
      // an unchanged value proves nothing (same lesson as the county —
      // codex #3565 gh-r32/r41).
      const priorRow = await trx('customer_turf_profiles').where({ customer_id: customerId }).first('grass_type', 'lawn_sqft');
      // A grass staff changed or explicitly reviewed on this save is theirs:
      // a later photo AI read never replaces it. The form re-sends every
      // loaded field, so an unchanged, unreviewed grass keeps its source.
      const staffGrass = typeof fields.grass_type === 'string' && !!fields.grass_type.trim()
        && (fields.grass_type !== (priorRow ? priorRow.grass_type : null) || grassReviewed);
      const sourceField = staffGrass ? { grass_type_source: GRASS_SOURCE.STAFF } : {};
      const rows = await trx('customer_turf_profiles')
        .insert({ ...insertRow, ...sourceField })
        .onConflict('customer_id')
        .merge({ ...fields, ...sourceField, updated_at: new Date() })
        .returning('*');
      const nextLawnSqft = fields.lawn_sqft == null ? null : Number(fields.lawn_sqft);
      if (Object.hasOwn(fields, 'lawn_sqft') && nextLawnSqft !== (priorRow?.lawn_sqft ?? null)) {
        // This older editor does not review service areas. A changed turf
        // amount withdraws any lawn review (its stamp must not sit on a
        // different number) and moves the lawn mirrors — property and
        // customer property_sqft — to the same amount on every edit, so no
        // reader keeps pricing a former value. Only the primary property at
        // the customer's own address carries those mirrors (the shared
        // editor's rule). Same customer fence as the shared editor. The
        // mirror rule lives in lawn-size-sync (shared with the estimate
        // acceptance write); it is a no-op before the service-areas
        // migration, where there is no review to withdraw.
        await require('../services/lawn-size-sync').syncLawnSqftMirrors(trx, customerId, nextLawnSqft);
      }
      // The fence already holds the prefs advisory lock, so this read is
      // serialized against the address fan-out's stamp write (gh-r44).
      const prefsRow = await trx('property_preferences').where({ customer_id: customerId }).first('irrigation_home_changed_at');
      const requestFresh = stampMs(prefsRow?.irrigation_home_changed_at) == null
        || (hasRenderStamp && renderedAgainstMs === stampMs(prefsRow.irrigation_home_changed_at));
      const grassEdited = ((typeof fields.grass_type === 'string' && fields.grass_type.trim()
        && fields.grass_type !== (priorRow ? priorRow.grass_type : null)) || grassReviewed) && requestFresh;
      if (grassEdited) {
        const { GRASS_CONFIRMED_FIELD } = require('../services/irrigation-schedule-confirmation');
        await confirmIrrigationFields(trx, customerId, [GRASS_CONFIRMED_FIELD]);
      }
      // A county the technician EXPLICITLY reviewed on this save
      // (`county_confirmed: true` — the client sets it only when the county
      // field was edited in this session) is their statement about the
      // CURRENT home: it confirms the turf county in the sprinkler-settings
      // ledger, so the weekly watering plan may trust it for jurisdiction
      // again after a move. Payload presence alone proves nothing — the
      // form re-sends every loaded field on every save, so a grass-type
      // edit would otherwise re-confirm the former home's county (codex
      // #3565 gh-r32/r33). SAME transaction as the profile write, under the
      // customer row lock every address move also takes first: a move can
      // never land between the two and be followed by a confirmation of
      // the former home's county (hook P1 on 45beb0731).
      if (countyConfirmed && requestFresh) {
        await confirmIrrigationFields(trx, customerId, [COUNTY_CONFIRMED_FIELD]);
      }
      return rows;
    });

    logger.info?.(`[turf-profile] saved customer=${customerId} by tech=${req.technicianId}`);
    res.json({ profile: profileForResponse(saved, req) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /:customerId/turf-profile/bermuda-removal — the staff switch
// (GATE_LAWN_BERMUDA_REMOVAL). Admin only. Gate off: 404, as if the route did
// not exist. Turning it ON needs an existing active profile whose grass is St.
// Augustine or Zoysia (any other grass never gets the step); turning it OFF is
// always allowed. Stamps who and when, and moves updated_at so a completion
// built on the older profile re-reads it.
// =========================================================================
router.put('/:customerId/turf-profile/bermuda-removal', requireAdmin, async (req, res, next) => {
  try {
    if (featureGates.lawnBermudaRemovalLive?.() !== true) return res.status(404).json({ error: 'Not found' });
    const { customerId } = req.params;
    const enabled = (req.body || {}).enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const customer = await db('customers').where({ id: customerId }).first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const profile = await db('customer_turf_profiles').where({ customer_id: customerId }).first('id', 'grass_type', 'cultivar', 'active');
    if (!profile) return res.status(400).json({ error: 'Create the turf profile first' });
    if (enabled) {
      if (profile.active !== true) return res.status(400).json({ error: 'The turf profile is inactive; reactivate it first' });
      if (!BERMUDA_REMOVAL_TRACKS.includes(profile.grass_type)) {
        return res.status(400).json({ error: 'Bermuda removal runs on St. Augustine and Zoysia lawns only' });
      }
      if (cultivarState(profile.grass_type, profile.cultivar) === 'excluded') {
        return res.status(400).json({ error: 'This St. Augustine cultivar (ProVista, Captiva or Seville) never gets bermuda removal' });
      }
    }
    // Turning it on re-checks the active profile, the eligible grass and the cultivar inside the
    // UPDATE itself, so a profile edit that lands between the read and the write wins.
    const query = db('customer_turf_profiles').where({ customer_id: customerId });
    if (enabled) {
      // The excluded-cultivar rule rides the UPDATE too, so a cultivar changed to an excluded
      // one after the read above makes the update hit no row (409), never a switched-on lawn.
      const cultivarRule = excludedCultivarSql();
      query.where({ active: true }).whereIn('grass_type', BERMUDA_REMOVAL_TRACKS).whereRaw(cultivarRule.sql, cultivarRule.bindings);
    }
    const [saved] = await query
      .update({
        bermuda_removal: enabled,
        bermuda_removal_set_by: String(req.technicianId || '').slice(0, 80) || null,
        bermuda_removal_set_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    if (!saved) return res.status(409).json({ error: 'The turf profile changed; reload and try again' });
    logger.info?.(`[turf-profile] bermuda_removal=${enabled} customer=${customerId} by=${req.technicianId}`);
    res.json({ profile: saved });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
