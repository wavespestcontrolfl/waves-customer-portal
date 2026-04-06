const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

const ALLOWED_FIELDS = [
  'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
  'parking_notes', 'side_gate_access',
  'pet_count', 'pet_details', 'pets_secured_plan', 'pets_structured',
  'preferred_day', 'preferred_time', 'contact_preference',
  'blackout_start', 'blackout_end',
  'irrigation_system', 'irrigation_controller_location', 'irrigation_zones',
  'irrigation_schedule_notes', 'watering_days', 'irrigation_system_type',
  'rain_sensor', 'irrigation_issues',
  'hoa_name', 'hoa_restrictions', 'hoa_company', 'hoa_phone', 'hoa_email',
  'hoa_lawn_height', 'hoa_signage_rules', 'hoa_timing_restrictions',
  'hoa_inspection_period',
  'access_notes', 'special_instructions',
];

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

// =========================================================================
// GET /api/property/preferences
// =========================================================================
router.get('/preferences', async (req, res, next) => {
  try {
    let prefs = await db('property_preferences')
      .where({ customer_id: req.customerId })
      .first();

    if (!prefs) {
      // Return empty defaults
      return res.json({
        preferences: {
          neighborhoodGateCode: '', propertyGateCode: '', garageCode: '', lockboxCode: '',
          parkingNotes: '', sideGateAccess: '',
          petCount: 0, petDetails: '', petSecuredPlan: '', petsStructured: [],
          preferredDay: 'no_preference', preferredTime: 'no_preference', contactPreference: 'text',
          blackoutStart: null, blackoutEnd: null,
          irrigationSystem: false, irrigationControllerLocation: '', irrigationZones: null,
          irrigationScheduleNotes: '', wateringDays: [], irrigationSystemType: '',
          rainSensor: false, irrigationIssues: '',
          hoaName: '', hoaRestrictions: '', hoaCompany: '', hoaPhone: '', hoaEmail: '',
          hoaLawnHeight: '', hoaSignageRules: '', hoaTimingRestrictions: '',
          hoaInspectionPeriod: '',
          accessNotes: '', specialInstructions: '',
          updatedAt: null,
        },
      });
    }

    // Convert snake_case DB columns to camelCase for frontend
    const { id, customer_id, created_at, ...fields } = prefs;
    // Parse JSON fields
    const JSON_COLS = ['watering_days', 'pets_structured'];
    for (const jc of JSON_COLS) {
      if (fields[jc] && typeof fields[jc] === 'string') {
        try { fields[jc] = JSON.parse(fields[jc]); } catch (e) { fields[jc] = []; }
      }
      if (!fields[jc]) fields[jc] = [];
    }
    const camelFields = transformKeys(fields, snakeToCamel);

    res.json({ preferences: camelFields });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /api/property/preferences — partial update
// =========================================================================
router.put('/preferences', async (req, res, next) => {
  try {
    // Convert camelCase input to snake_case, filter to allowed fields only
    const snakeBody = transformKeys(req.body, camelToSnake);
    const updates = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in snakeBody) {
        updates[field] = snakeBody[field];
      }
    }

    // Stringify JSON fields for DB storage
    const JSON_FIELDS = ['watering_days', 'pets_structured'];
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
        .update({ ...updates, updated_at: db.fn.now() });
    } else {
      await db('property_preferences').insert({
        customer_id: req.customerId,
        ...updates,
      });
    }

    // Return the full updated record
    const prefs = await db('property_preferences')
      .where({ customer_id: req.customerId })
      .first();

    const { id, customer_id, created_at, ...fields } = prefs;
    const camelFields = transformKeys(fields, snakeToCamel);

    res.json({ preferences: camelFields, saved: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
