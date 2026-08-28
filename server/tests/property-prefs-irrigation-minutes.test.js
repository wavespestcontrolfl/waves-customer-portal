/**
 * irrigation_run_minutes wiring on the property-preferences route. The route
 * wires a new field through independent lists (Joi schema, ALLOWED_FIELDS,
 * email-notice labels); these pin each so a partial wiring regresses loudly —
 * same discipline as the mowing-fields test.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/irrigation-weekly-email', () => ({ hasRecurringLawnEvidence: jest.fn() }));

const fs = require('fs');
const path = require('path');
const propertyRouter = require('../routes/property');

const { hasRecurringLawnEvidence } = require('../services/irrigation-weekly-email');

const {
  propertyChangeItems, prefsSchema, customerQualifiesForLawnInches, hasIrrigationValue, IRRIGATION_INPUT_FIELDS,
} = propertyRouter._private;

describe('property preferences — irrigation minutes per zone', () => {
  test('a minutes change produces an account-updated change item', () => {
    const items = propertyChangeItems(
      { irrigation_run_minutes: 25 },
      { irrigation_run_minutes: null },
    );
    const item = items.find((i) => i.label === 'Irrigation minutes per zone');
    expect(item).toBeTruthy();
    expect(String(item.newValue)).toContain('25');
  });

  // The lists live in route-module scope; pin them at source so dropping the
  // field from any one list fails here rather than silently in prod.
  test('field is wired through schema, ALLOWED_FIELDS and the GET defaults', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/property.js'), 'utf8');
    expect(src).toMatch(/irrigationRunMinutes: Joi\.number\(\)\.integer\(\)\.min\(1\)\.max\(240\)\.allow\(null\)/);
    expect(src).toMatch(/'irrigation_run_minutes'/); // ALLOWED_FIELDS
    expect(src).toMatch(/irrigationRunMinutes: null/); // GET defaults
  });

  // The derivation normalizes against canonical vocabularies — a persisted
  // value outside them silently vanishes from the conversion and the email
  // then claims the input is missing (GH codex P1 on #3478 r3). Writes must
  // therefore reject anything but the exact keys the portal pills emit.
  // Zero is not a schedule — the runtime treats <= 0 as missing, so a
  // persisted 0 would render in the portal while the email claims no
  // minutes are on file. Null clears; 1–240 stores.
  test('irrigationRunMinutes rejects 0 and accepts 1–240 or null', () => {
    expect(prefsSchema.validate({ irrigationRunMinutes: 0 }).error).toBeTruthy();
    expect(prefsSchema.validate({ irrigationRunMinutes: 241 }).error).toBeTruthy();
    expect(prefsSchema.validate({ irrigationRunMinutes: 20 }).error).toBeUndefined();
    expect(prefsSchema.validate({ irrigationRunMinutes: null }).error).toBeUndefined();
  });

  test('wateringDays accepts only the seven canonical pill keys, unique', () => {
    expect(prefsSchema.validate({ wateringDays: ['Mon', 'Wed'] }).error).toBeUndefined();
    expect(prefsSchema.validate({ wateringDays: ['Monday'] }).error).toBeTruthy();
    expect(prefsSchema.validate({ wateringDays: ['Mon', 'Mon'] }).error).toBeTruthy();
  });

  test('irrigationSystemType accepts only spray/drip/rotor (array or legacy scalar)', () => {
    expect(prefsSchema.validate({ irrigationSystemType: ['spray', 'rotor'] }).error).toBeUndefined();
    expect(prefsSchema.validate({ irrigationSystemType: 'rotor' }).error).toBeUndefined();
    expect(prefsSchema.validate({ irrigationSystemType: '' }).error).toBeUndefined();
    expect(prefsSchema.validate({ irrigationSystemType: null }).error).toBeUndefined();
    expect(prefsSchema.validate({ irrigationSystemType: ['bubbler'] }).error).toBeTruthy();
    expect(prefsSchema.validate({ irrigationSystemType: ['spray', 'spray'] }).error).toBeTruthy();
  });
});

// Irrigation ON by default (owner ruling 2026-08-27): the portal toggle is
// retired, so any irrigation write must stamp irrigation_system = true or the
// report / weekly email keep suppressing a derived figure behind the old
// false default.
describe('property preferences — irrigation on by default', () => {
  test('a value in any irrigation input column counts as an irrigation write', () => {
    expect(IRRIGATION_INPUT_FIELDS).toEqual(expect.arrayContaining([
      'irrigation_run_minutes', 'irrigation_inches_per_week', 'watering_days', 'irrigation_system_type', 'irrigation_zones',
    ]));
    expect(hasIrrigationValue('irrigation_run_minutes', 20)).toBe(true);
    expect(hasIrrigationValue('watering_days', ['Mon'])).toBe(true);
    expect(hasIrrigationValue('rain_sensor', true)).toBe(true);
    expect(hasIrrigationValue('irrigation_controller_location', 'garage')).toBe(true);
    // Clears / blanks are not evidence of a system.
    expect(hasIrrigationValue('irrigation_run_minutes', null)).toBe(false);
    expect(hasIrrigationValue('watering_days', [])).toBe(false);
    expect(hasIrrigationValue('irrigation_zones', 0)).toBe(false);
    expect(hasIrrigationValue('irrigation_controller_location', '   ')).toBe(false);
    expect(hasIrrigationValue('rain_sensor', false)).toBe(false);
  });

  test('route stamps irrigation_system=true on irrigation writes, GET defaults ON and reports hasLawnCare', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/property.js'), 'utf8');
    expect(src).toMatch(/IRRIGATION_INPUT_FIELDS\.some\(\(f\) => hasIrrigationValue\(f, updates\[f\]\)\)[\s\S]{0,40}\{ irrigation_system: true \}/);
    expect(src).toMatch(/\.update\(\{ \.\.\.updates, \.\.\.stampIrrigationOn, updated_at/);
    expect(src).toMatch(/\.\.\.updates,\n\s+\.\.\.stampIrrigationOn,/);
    expect(src).toMatch(/irrigationSystem: true, irrigationControllerLocation/); // GET defaults (no row)
    expect(src).toMatch(/camelFields\.irrigationSystem = true/); // GET presentation of legacy false rows
    expect(src).toMatch(/res\.json\(\{ preferences: camelFields, hasLawnCare \}\)/);
    // No portal toggle — irrigationSystem is no longer a customer-writable field.
    expect(src).not.toMatch(/irrigationSystem: Joi\.boolean\(\)/);
  });
});

// Weekly Inches eligibility: tier / lawn_type shortcut, else the recurring
// lawn-service evidence the Monday email qualifies on — a standalone lawn
// plan customer with no turf type on file had no Inches field on the day of
// her service (2026-08-27). GET and PUT share this one predicate.
describe('property preferences — Weekly Inches eligibility', () => {
  beforeEach(() => hasRecurringLawnEvidence.mockReset());

  test('tier or lawn_type short-circuits without a DB lookup', async () => {
    await expect(customerQualifiesForLawnInches({ id: 'c1', waveguard_tier: 'Gold' })).resolves.toBe(true);
    await expect(customerQualifiesForLawnInches({ id: 'c1', lawn_type: 'St. Augustine' })).resolves.toBe(true);
    expect(hasRecurringLawnEvidence).not.toHaveBeenCalled();
  });

  test('falls back to recurring lawn-service evidence', async () => {
    hasRecurringLawnEvidence.mockResolvedValueOnce(true);
    await expect(customerQualifiesForLawnInches({ id: 'c2', waveguard_tier: 'Bronze', lawn_type: null })).resolves.toBe(true);
    expect(hasRecurringLawnEvidence).toHaveBeenCalledWith('c2');
    hasRecurringLawnEvidence.mockResolvedValueOnce(false);
    await expect(customerQualifiesForLawnInches({ id: 'c3' })).resolves.toBe(false);
  });

  test('a failed evidence lookup declines rather than throws', async () => {
    hasRecurringLawnEvidence.mockRejectedValueOnce(new Error('db down'));
    await expect(customerQualifiesForLawnInches({ id: 'c4' })).resolves.toBe(false);
  });

  test('PUT gates irrigation_inches_per_week on the shared predicate', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/property.js'), 'utf8');
    expect(src).toMatch(/'irrigation_inches_per_week' in updates && !\(await customerQualifiesForLawnInches\(req\.customer\)\)/);
  });
});
