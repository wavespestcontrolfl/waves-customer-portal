const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const AccountMembershipEmail = require('../services/account-membership-email');
const TermiteStations = require('../services/termite-stations');
const { hasRecurringLawnEvidence } = require('../services/irrigation-weekly-email');

// Cap the JSON body for this route family. The global limit is generous;
// property preferences never need more than a few KB.
router.use(express.json({ limit: '64kb' }));
router.use(authenticate);

const shortText = Joi.string().trim().allow('', null).max(200);
const longText = Joi.string().trim().allow('', null).max(2000);
const petSchema = Joi.object({
  name: Joi.string().trim().allow('', null).max(60),
  species: Joi.string().trim().allow('', null).max(40),
  breed: Joi.string().trim().allow('', null).max(60),
  friendly: Joi.boolean(),
  secured: Joi.boolean(),
  notes: Joi.string().trim().allow('', null).max(300),
}).unknown(true);

const prefsSchema = Joi.object({
  neighborhoodGateCode: shortText,
  propertyGateCode: shortText,
  garageCode: shortText,
  lockboxCode: shortText,
  parkingNotes: longText,
  sideGateAccess: shortText,
  petCount: Joi.number().integer().min(0).max(20),
  petDetails: longText,
  petsSecuredPlan: longText,
  petsStructured: Joi.array().items(petSchema).max(20),
  preferredDay: shortText,
  preferredTime: shortText,
  contactPreference: shortText,
  blackoutStart: Joi.date().allow(null, ''),
  blackoutEnd: Joi.date().allow(null, ''),
  irrigationControllerLocation: shortText,
  irrigationZones: Joi.number().integer().min(0).max(100).allow(null),
  irrigationInchesPerWeek: Joi.number().min(0).max(5).precision(2).allow(null),
  // Minutes each zone runs on a watering day — the natural-unit schedule
  // @waves/irrigation-runtime converts to inches (× days × head type).
  // 1–240 with null-to-clear: the runtime treats <= 0 as missing, so a
  // persisted 0 would show in the portal while the email claims no minutes
  // are on file. Zero is not a schedule — clearing is.
  irrigationRunMinutes: Joi.number().integer().min(1).max(240).allow(null),
  irrigationScheduleNotes: longText,
  // Same seven keys the pills emit — mirrors mowingDays below. A length-only
  // check would persist "Monday" with a 200, and @waves/irrigation-runtime
  // normalizes against the canonical keys, so the day would silently vanish
  // from the derivation and the email would claim the days are missing.
  wateringDays: Joi.array().items(Joi.string().valid('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')).unique().max(7),
  // Customers can have multiple sprinkler types on one property. Accept an
  // array (current client) or a legacy scalar string for backward compat;
  // the route normalizes to an array before storage. Vocabulary is the three
  // types the portal pills emit and @waves/irrigation-runtime has rates or
  // rules for — an unknown type would persist fine and then derail the
  // derivation into unknown_head_type copy. Legacy rows keep whatever they
  // hold; only new writes are restricted.
  irrigationSystemType: Joi.alternatives().try(
    Joi.array().items(Joi.string().valid('spray', 'drip', 'rotor')).unique().max(3),
    Joi.string().valid('spray', 'drip', 'rotor', '')
  ).allow(null),
  rainSensor: Joi.boolean(),
  irrigationIssues: longText,
  // Same seven keys the pills emit. A length-only check would persist
  // "Monday" with a 200, and both the portal summary and mowingAlertText
  // filter against the canonical keys — so the day would silently vanish
  // from the customer's view AND the technician's alert.
  mowingDays: Joi.array()
    .items(Joi.string().valid('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'))
    .unique()
    .max(7),
  // Controlled vocabulary, not free text: the column is varchar(30), so a
  // longer value would turn a client mistake into a Postgres 22001 → 500.
  // The four keys mirror the portal's Typical Time pills.
  mowingTimeOfDay: Joi.string().trim().valid('', 'morning', 'midday', 'afternoon', 'varies').allow(null),
  mowingNotes: longText,
  hoaName: shortText,
  hoaRestrictions: longText,
  hoaCompany: shortText,
  hoaPhone: shortText,
  hoaEmail: Joi.string().trim().allow('', null).email().max(254),
  hoaLawnHeight: shortText,
  hoaSignageRules: longText,
  hoaTimingRestrictions: longText,
  hoaInspectionPeriod: shortText,
  accessNotes: longText,
  specialInstructions: longText,
}).unknown(false);

const ALLOWED_FIELDS = [
  'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
  'parking_notes', 'side_gate_access',
  'pet_count', 'pet_details', 'pets_secured_plan', 'pets_structured',
  'preferred_day', 'preferred_time', 'contact_preference',
  'blackout_start', 'blackout_end',
  'irrigation_system', 'irrigation_controller_location', 'irrigation_zones',
  'irrigation_inches_per_week', 'irrigation_run_minutes', 'irrigation_schedule_notes', 'watering_days', 'irrigation_system_type',
  'rain_sensor', 'irrigation_issues',
  'mowing_days', 'mowing_time_of_day', 'mowing_notes',
  'hoa_name', 'hoa_restrictions', 'hoa_company', 'hoa_phone', 'hoa_email',
  'hoa_lawn_height', 'hoa_signage_rules', 'hoa_timing_restrictions',
  'hoa_inspection_period',
  'access_notes', 'special_instructions',
];

const CUSTOMER_EMAIL_FIELDS = {
  preferred_day: 'Preferred service day',
  preferred_time: 'Preferred service time',
  contact_preference: 'Service contact preference',
  blackout_start: 'Blackout start date',
  blackout_end: 'Blackout end date',
  irrigation_system: 'Irrigation system',
  irrigation_inches_per_week: 'Irrigation inches per week',
  irrigation_run_minutes: 'Irrigation minutes per zone',
  watering_days: 'Watering days',
  irrigation_system_type: 'Irrigation system type',
  rain_sensor: 'Rain sensor',
  mowing_days: 'Mowing days',
  mowing_time_of_day: 'Mowing time of day',
};

function displayPrefValue(value) {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Not set';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length ? parsed.join(', ') : 'Not set';
    } catch {
      // Keep the original value below.
    }
    return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return String(value);
}

function propertyChangeItems(updates = {}, existing = {}) {
  return Object.keys(updates)
    .filter((field) => CUSTOMER_EMAIL_FIELDS[field])
    .filter((field) => displayPrefValue(existing?.[field]) !== displayPrefValue(updates[field]))
    .map((field) => ({
      key: field,
      label: CUSTOMER_EMAIL_FIELDS[field],
      oldValue: displayPrefValue(existing?.[field]),
      newValue: displayPrefValue(updates[field]),
      scope: 'Property profile',
    }));
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, l => `_${l.toLowerCase()}`);
}

function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
}

function transformKeys(obj, fn) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[fn(k)] = v;
  }
  return result;
}

function customerHasLawnCare(customer = {}) {
  const tier = String(customer.waveguard_tier || customer.tier || '').trim();
  return ['Silver', 'Gold', 'Platinum'].includes(tier) || !!String(customer.lawn_type || '').trim();
}

// Weekly Inches eligibility. The tier / lawn_type shortcut misses standalone
// lawn-plan customers with no turf type on file, so fall back to the same
// recurring-lawn-service evidence the Monday irrigation email qualifies on
// (2026-08-27: a lawn customer had no Inches field on the day of her
// service). Used by BOTH the GET (render gate) and the PUT (store gate) so
// the field can never render and then be silently dropped on save.
async function customerQualifiesForLawnInches(customer = {}) {
  if (customerHasLawnCare(customer)) return true;
  try {
    return await hasRecurringLawnEvidence(customer.id);
  } catch (err) {
    logger.warn(`[property] lawn evidence lookup failed for ${customer.id}: ${err.message}`);
    return false;
  }
}

// Irrigation is ON by default (owner ruling 2026-08-27: no toggle). The
// portal presents the section as on, so ANY edit under it — including a
// clear — is the customer working a system that exists; the write stamps
// irrigation_system = true. The report and weekly email still read the
// column and would otherwise keep suppressing a derived figure behind a
// false the old toggle left in the row (the migration rewrites no rows).
const IRRIGATION_INPUT_FIELDS = [
  'irrigation_controller_location', 'irrigation_zones', 'irrigation_inches_per_week',
  'irrigation_run_minutes', 'irrigation_schedule_notes', 'watering_days',
  'irrigation_system_type', 'rain_sensor', 'irrigation_issues',
];

// =========================================================================
// GET /api/property/preferences
// =========================================================================
router.get('/preferences', async (req, res, next) => {
  try {
    const [prefs, hasLawnCare] = await Promise.all([
      db('property_preferences').where({ customer_id: req.customerId }).first(),
      customerQualifiesForLawnInches(req.customer),
    ]);

    if (!prefs) {
      // Return empty defaults
      return res.json({
        preferences: {
          neighborhoodGateCode: '', propertyGateCode: '', garageCode: '', lockboxCode: '',
          parkingNotes: '', sideGateAccess: '',
          petCount: 0, petDetails: '', petsSecuredPlan: '', petsStructured: [],
          preferredDay: 'no_preference', preferredTime: 'no_preference', contactPreference: 'text',
          blackoutStart: null, blackoutEnd: null,
          irrigationSystem: true, irrigationControllerLocation: '', irrigationZones: null,
          irrigationInchesPerWeek: null, irrigationRunMinutes: null,
          irrigationScheduleNotes: '', wateringDays: [], irrigationSystemType: [],
          rainSensor: false, irrigationIssues: '',
          mowingDays: [], mowingTimeOfDay: '', mowingNotes: '',
          hoaName: '', hoaRestrictions: '', hoaCompany: '', hoaPhone: '', hoaEmail: '',
          hoaLawnHeight: '', hoaSignageRules: '', hoaTimingRestrictions: '',
          hoaInspectionPeriod: '',
          accessNotes: '', specialInstructions: '',
          updatedAt: null,
        },
        hasLawnCare,
      });
    }

    // Convert snake_case DB columns to camelCase for frontend
    const { id, customer_id, created_at, ...fields } = prefs;
    // Parse JSON fields
    const JSON_COLS = ['watering_days', 'pets_structured', 'irrigation_system_type', 'mowing_days'];
    for (const jc of JSON_COLS) {
      if (fields[jc] && typeof fields[jc] === 'string') {
        try {
          fields[jc] = JSON.parse(fields[jc]);
        } catch (e) {
          logger.warn(`[property] Invalid JSON in ${jc} for customer ${req.customerId}: ${e.message}`);
          fields[jc] = [];
        }
      }
      if (!fields[jc]) fields[jc] = [];
    }
    const camelFields = transformKeys(fields, snakeToCamel);
    // Rows written before the toggle was retired carry the old false
    // default; the portal has no toggle any more, so present ON.
    camelFields.irrigationSystem = true;

    res.json({ preferences: camelFields, hasLawnCare });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /api/property/preferences — partial update
// =========================================================================
router.put('/preferences', async (req, res, next) => {
  try {
    const { value, error } = prefsSchema.validate(req.body, { stripUnknown: true, abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.details.map(d => d.message).join('; ') });
    }

    // Convert camelCase input to snake_case, filter to allowed fields only
    const snakeBody = transformKeys(value, camelToSnake);
    const updates = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in snakeBody) {
        updates[field] = snakeBody[field];
      }
    }
    if ('irrigation_inches_per_week' in updates && !(await customerQualifiesForLawnInches(req.customer))) {
      delete updates.irrigation_inches_per_week;
    }
    // Stamped on the row, not on `updates`: the account-updated email lists
    // what the customer changed, and the stamp is not a customer edit.
    const stampIrrigationOn = IRRIGATION_INPUT_FIELDS.some((f) => f in updates)
      ? { irrigation_system: true }
      : {};

    // Normalize irrigation system type to an array (accepts legacy scalar)
    if ('irrigation_system_type' in updates) {
      const v = updates.irrigation_system_type;
      updates.irrigation_system_type = Array.isArray(v) ? v : (v ? [v] : []);
    }

    // Stringify JSON fields for DB storage
    const JSON_FIELDS = ['watering_days', 'pets_structured', 'irrigation_system_type', 'mowing_days'];
    for (const jf of JSON_FIELDS) {
      if (jf in updates && typeof updates[jf] !== 'string') {
        updates[jf] = JSON.stringify(updates[jf]);
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const existing = await db('property_preferences')
      .where({ customer_id: req.customerId })
      .first();

    if (existing) {
      await db('property_preferences')
        .where({ customer_id: req.customerId })
        .update({ ...updates, ...stampIrrigationOn, updated_at: db.fn.now() });
    } else {
      await db('property_preferences').insert({
        customer_id: req.customerId,
        ...updates,
        ...stampIrrigationOn,
      });
    }

    // Return the full updated record
    const prefs = await db('property_preferences')
      .where({ customer_id: req.customerId })
      .first();

    const { id, customer_id, created_at, ...fields } = prefs;
    const camelFields = transformKeys(fields, snakeToCamel);
    const emailItems = propertyChangeItems(updates, existing || {});
    if (emailItems.length) {
      void AccountMembershipEmail.sendAccountUpdated({
        customerId: req.customerId,
        actorCustomerId: req.customerId,
        changedItems: emailItems,
        changeSummary: `${emailItems.length === 1 ? 'A property preference was' : 'Property preferences were'} updated for future service visits.`,
        accountSection: 'Property profile',
      }).catch((emailErr) => logger.warn(`[property] account.updated email failed for ${req.customerId}: ${emailErr.message}`));
    }

    res.json({ preferences: camelFields, saved: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/property/station-map — current bait-station layout for the
// authenticated customer's own home, grouped by program (termite / rodent),
// for the My Plan service-row embeds. Each pin carries the station's LATEST
// check status across all visits (never checked → null → "on file" state).
// Dark behind GATE_PORTAL_STATION_MAP (default OFF — owner flips after
// stations are mapped); the satellite provider gates still apply beneath it.
// Trapping pins are deliberately excluded: the plan rows cover the two bait
// programs; the trap map remains a report artifact.
const PORTAL_STATION_MAP_PROGRAMS = ['termite', 'rodent'];
function portalStationMapEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.GATE_PORTAL_STATION_MAP || '').trim().toLowerCase());
}

router.get('/station-map', async (req, res, next) => {
  try {
    if (!portalStationMapEnabled()) {
      return res.json({ available: false, reason: 'disabled', programs: {} });
    }
    const { getBasemapProvider, isSatelliteTreatmentMapEnabled } = require('../services/maps/basemap-provider');
    if (!isSatelliteTreatmentMapEnabled()) {
      return res.json({ available: false, reason: 'disabled', programs: {} });
    }
    const provider = getBasemapProvider();
    if (!provider?.capabilities?.canDisplayLive) {
      return res.json({ available: false, reason: 'provider_unavailable', programs: {} });
    }

    const stationRows = await db('termite_stations')
      .where({ customer_id: req.customerId, is_active: true })
      .orderBy('station_number')
      .catch(() => []);
    if (!stationRows.length) {
      return res.json({ available: false, reason: 'no_stations', programs: {} });
    }

    const customer = await db('customers')
      .where({ id: req.customerId })
      .select('latitude', 'longitude')
      .first();
    // Number(null) = 0 trap: null coordinates must read as missing, not 0,0.
    const lat = customer?.latitude == null ? NaN : Number(customer.latitude);
    const lng = customer?.longitude == null ? NaN : Number(customer.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.json({ available: false, reason: 'missing_coordinates', programs: {} });
    }

    // Same provider params as the report + marking surfaces (center/zoom,
    // 640x340) so pins stay pixel-consistent with where they were dropped.
    const geometryRow = await db('property_geometries')
      .where({ customer_id: req.customerId })
      .orderBy('version', 'desc')
      .first()
      .catch(() => null);
    const zoom = Number(geometryRow?.zoom) || 20;
    const center = { lat, lng };
    const liveConfig = await provider.getLiveMapConfig({
      center,
      zoom,
      width: 640,
      height: 340,
      mapType: 'satellite',
    });
    if (!liveConfig?.imageUrl) {
      return res.json({ available: false, reason: 'provider_config_unavailable', programs: {} });
    }

    // Latest check per station: ascending by visit so the last assignment
    // wins. Same-day tie-break is the service record's completion write
    // time (service_records rows are created at completion), NOT the check
    // row's updated_at — a delayed retry/resync of the OLDER visit's checks
    // would otherwise overwrite the newer visit's status (codex P2).
    // Fail-soft — a checks error renders every pin as on-file rather than
    // dropping the map.
    const checkRows = await db('termite_station_checks as c')
      .join('service_records as sr', 'sr.id', 'c.service_record_id')
      .whereIn('c.station_id', stationRows.map((row) => row.id))
      .select('c.station_id', 'c.status', 'sr.service_date', 'sr.created_at', 'c.updated_at')
      .orderBy([
        { column: 'sr.service_date', order: 'asc' },
        { column: 'sr.created_at', order: 'asc' },
        { column: 'c.updated_at', order: 'asc' },
      ])
      .catch(() => []);
    const latestStatusByStationId = new Map();
    for (const row of checkRows) {
      latestStatusByStationId.set(String(row.station_id), row.status);
    }

    const satelliteMap = {
      available: true,
      live: {
        url: liveConfig.imageUrl,
        width: liveConfig.width || 640,
        height: liveConfig.height || 340,
      },
      attributionText: liveConfig.attributionText || '',
    };
    const imageContext = {
      center: liveConfig.center || center,
      zoom,
      width: liveConfig.width || 640,
      height: liveConfig.height || 340,
    };

    const programs = {};
    for (const program of PORTAL_STATION_MAP_PROGRAMS) {
      const context = TermiteStations.buildStationMapCurrentContext({
        stationRows,
        latestStatusByStationId,
        satelliteMap,
        imageContext,
        program,
      });
      if (context.available) programs[program] = context;
    }
    return res.json({ available: Object.keys(programs).length > 0, programs });
  } catch (err) {
    next(err);
  }
});

// GET /api/property/termite-bond — the authenticated customer's active
// termite bond(s) for the My Plan coverage card: term, start, and renewal
// dates only. Coverage TERMS stay out of the payload on purpose — the card
// holds the same generic-coverage line as the renewal email
// (termite.bond_renewal): specifics are a conversation, not portal copy.
// Dark behind GATE_PORTAL_TERMITE_BOND (default OFF), read at request time
// via the shared gateEnvValue parser (the renewal-email sweep reads the
// same gate through the same parser); gate-off and no-bond both answer 200
// {available:false} — the client renders nothing rather than an error.
// termite_bonds.started_at / renews_at are ET business-calendar DATEs;
// dateOnlyString handles the pg string/UTC-midnight-Date duality and
// returns null on anything malformed (never throws — fail-soft).
const { gateEnvValue } = require('../config/feature-gates');
const { activeTermiteBondsForCustomer, TERMITE_BOND_GATE } = require('../services/termite-bonds');

router.get('/termite-bond', async (req, res, next) => {
  try {
    if (!gateEnvValue(TERMITE_BOND_GATE)) {
      return res.json({ available: false, reason: 'disabled', bonds: [] });
    }
    // Shared lookup with the service report's warranty cell — one owner
    // for the gate/status/ordering/date rules. Fail-soft: a bonds query
    // error renders no card, never a broken tab.
    const bonds = await activeTermiteBondsForCustomer(req.customerId);
    if (!bonds.length) {
      return res.json({ available: false, reason: 'no_bond', bonds: [] });
    }
    return res.json({ available: true, bonds });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

module.exports._private = {
  propertyChangeItems,
  displayPrefValue,
  prefsSchema,
  customerHasLawnCare,
  customerQualifiesForLawnInches,
  IRRIGATION_INPUT_FIELDS,
};
