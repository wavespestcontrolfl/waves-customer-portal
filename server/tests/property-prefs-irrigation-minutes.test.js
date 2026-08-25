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

const fs = require('fs');
const path = require('path');
const propertyRouter = require('../routes/property');

const { propertyChangeItems, prefsSchema } = propertyRouter._private;

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
    expect(src).toMatch(/irrigationRunMinutes: Joi\.number\(\)\.integer\(\)\.min\(0\)\.max\(240\)\.allow\(null\)/);
    expect(src).toMatch(/'irrigation_run_minutes'/); // ALLOWED_FIELDS
    expect(src).toMatch(/irrigationRunMinutes: null/); // GET defaults
  });

  // The derivation normalizes against canonical vocabularies — a persisted
  // value outside them silently vanishes from the conversion and the email
  // then claims the input is missing (GH codex P1 on #3478 r3). Writes must
  // therefore reject anything but the exact keys the portal pills emit.
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
