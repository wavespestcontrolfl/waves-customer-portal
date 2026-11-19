// The sprinkler timer on file (step 1 of sprinkler timer connect): three property_preferences columns that are ONE
// record about one box on the wall of one home. The customer card and the staff form write it through the shared
// validator; services/controller-timer.js makes each writer save it whole or not at all. The staff route's cases are
// in admin-customers-property-preferences-route.test.js, the move in lawn-sod-move.test.js, the merge in
// customer-dedupe.test.js. No database: one in-memory preference row.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', waveguard_tier: null, lawn_type: null };
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/termite-stations', () => ({}));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(), hasIrrigationEmailOptIn: jest.fn(async () => false) }));
jest.mock('../services/irrigation-app-plan', () => ({ appPlanEnabled: jest.fn(() => false), loadCustomerWateringPlan: jest.fn() }));
jest.mock('../models/db', () => {
  const state = { row: null };
  const table = () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => state.row);
    q.update = jest.fn(async (patch) => { state.row = { ...state.row, ...patch }; return 1; });
    q.insert = jest.fn(async (data) => { state.row = { id: 'pref-1', created_at: 'x', ...data }; return [1]; });
    return q;
  };
  const dbFn = jest.fn((name) => {
    if (name !== 'property_preferences') throw new Error(`Unexpected table ${name}`);
    return table();
  });
  dbFn.transaction = jest.fn(async (cb) => cb(dbFn));
  dbFn.raw = jest.fn(async () => undefined);
  dbFn.fn = { now: jest.fn(() => 'NOW') };
  dbFn._state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const { CONTROLLER_BRANDS, CONTROLLER_MODELS, CONTROLLER_APP_ANSWERS, controllerAsksAboutApp } = require('@waves/irrigation-runtime');
const { PREFS_FIELD_SCHEMAS, ALLOWED_FIELDS, validatePrefsBody } = require('../services/property-preferences-schema');
const { IRRIGATION_INPUT_FIELDS, IRRIGATION_SIZING_FIELDS } = require('../services/irrigation-schedule-confirmation');
const { CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerToCarry, settleControllerTimer } = require('../services/controller-timer');
const AccountMembershipEmail = require('../services/account-membership-email');
const propertyRouter = require('../routes/property');

const app = express();
app.use(express.json());
app.use('/api/property', propertyRouter);
app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Unavailable' }));
let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { jest.clearAllMocks(); db._state.row = null; });

async function putPrefs(body) {
  const response = await fetch(`${base}/api/property/preferences`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const X2_ON_APP = { irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: 'yes' };
const timerOf = (row) => CONTROLLER_TIMER_FIELDS.map((column) => row?.[column] ?? null);
const settle = (updates, options) => ({ rejected: settleControllerTimer(updates, options), left: updates });

describe('timer fields: what the validator accepts', () => {
  test('every key on the shared list is accepted, and a clear stores null', () => {
    const body = { irrigationControllerBrand: 'hunter', irrigationControllerModel: 'pro_c', irrigationControllerApp: 'unknown' };
    expect(validatePrefsBody(PREFS_FIELD_SCHEMAS, body)).toMatchObject({ value: body, rejected: [] });
    for (const [field, labels] of [
      ['irrigationControllerBrand', CONTROLLER_BRANDS], ['irrigationControllerModel', CONTROLLER_MODELS], ['irrigationControllerApp', CONTROLLER_APP_ANSWERS],
    ]) {
      for (const key of Object.keys(labels)) expect(PREFS_FIELD_SCHEMAS[field].validate(key).error).toBeUndefined();
      expect(PREFS_FIELD_SCHEMAS[field].validate('').value).toBeNull();
      expect(PREFS_FIELD_SCHEMAS[field].validate('Hunter').error).toBeTruthy();
    }
    for (const column of CONTROLLER_TIMER_FIELDS) expect(ALLOWED_FIELDS).toContain(column);
  });
});

describe('the timer saves whole or not at all', () => {
  test('the phone-app question exists for a Rain Bird and for the Hunter models that can go on Hydrawise', () => {
    const asked = [];
    for (const brand of [null, ...Object.keys(CONTROLLER_BRANDS)]) {
      for (const model of [null, ...Object.keys(CONTROLLER_MODELS)]) if (controllerAsksAboutApp(brand, model)) asked.push(`${brand}/${model}`);
    }
    expect(asked).toEqual(['hunter/x2', 'hunter/pro_c', 'hunter/hydrawise', ...[null, ...Object.keys(CONTROLLER_MODELS)].map((m) => `rain_bird/${m}`)]);
  });

  test('a whole timer that can exist passes untouched, beside other fields', () => {
    for (const timer of [
      ['hunter', 'x2', 'yes'], ['hunter', 'hydrawise', null], ['hunter', 'x_core', null], ['hunter', null, null],
      ['rain_bird', null, 'unknown'], ['other', null, null], [null, null, null],
    ]) {
      const updates = { irrigation_zones: 6, irrigation_controller_brand: timer[0], irrigation_controller_model: timer[1], irrigation_controller_app: timer[2] };
      expect(settle({ ...updates })).toEqual({ rejected: [], left: updates });
    }
    expect(settle({ irrigation_zones: 6 }, { fresh: false })).toEqual({ rejected: [], left: { irrigation_zones: 6 } });
  });

  test('a timer field sent without the other two is rejected: an answer never lands on a timer the writer did not see', () => {
    const { rejected, left } = settle({ irrigation_controller_app: 'no', irrigation_zones: 6 });
    expect(left).toEqual({ irrigation_zones: 6 });
    expect(rejected).toEqual([{ field: 'irrigationControllerApp', message: expect.stringMatching(/saves as one record/) }]);
    expect(settle({ irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null }).left).toEqual({});
  });

  test('a timer that cannot exist is rejected whole, with one reason on each field', () => {
    for (const [timer, reason] of [
      [['rain_bird', 'x2', null], /Only a Hunter/],
      [['other', null, 'yes'], /no phone-app question/],
      [['hunter', 'x_core', 'no'], /no phone-app question/],
      [['hunter', null, 'yes'], /no phone-app question/],
      [[null, 'x2', null], /no brand/],
      [[null, null, 'yes'], /no brand/],
    ]) {
      const { rejected, left } = settle({ irrigation_controller_brand: timer[0], irrigation_controller_model: timer[1], irrigation_controller_app: timer[2] });
      expect(left).toEqual({});
      expect(rejected.map((r) => r.field)).toEqual(['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp']);
      for (const r of rejected) expect(r.message).toMatch(reason);
    }
  });

  test('a write rendered against a home the customer has left is rejected, a clear included', () => {
    for (const timer of [{ irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' }, clearedControllerTimer()]) {
      const { rejected, left } = settle({ ...timer }, { fresh: false });
      expect(left).toEqual({});
      expect(rejected).toHaveLength(3);
      expect(rejected[0].message).toMatch(/home on this account changed/);
    }
  });

  test('a same-home merge carries the other row\'s whole timer, and only onto a row that has none', () => {
    const x2 = { irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' };
    expect(controllerTimerToCarry({ irrigation_controller_brand: null, irrigation_controller_model: null }, x2)).toEqual(x2);
    expect(controllerTimerToCarry({}, { irrigation_controller_brand: 'rain_bird' }))
      .toEqual({ irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null, irrigation_controller_app: null });
    expect(controllerTimerToCarry({ irrigation_controller_brand: 'rain_bird' }, x2)).toEqual({});
    expect(controllerTimerToCarry({}, { irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' })).toEqual({});
  });
});

describe('PUT /api/property/preferences: the customer card', () => {
  test('a whole timer saves, comes back in the response, stamps no irrigation system and sends no email', async () => {
    const res = await putPrefs(X2_ON_APP);
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject(X2_ON_APP);
    expect(timerOf(db._state.row)).toEqual(['hunter', 'x2', 'yes']);
    expect(db._state.row.irrigation_system).toBeUndefined();
    expect(db._state.row.irrigation_confirmed_fields).toBeUndefined();
    expect(AccountMembershipEmail.sendAccountUpdated).not.toHaveBeenCalled();
  });

  test('an answer sent alone is a 400 that names the field, and nothing is written', async () => {
    db._state.row = { id: 'pref-1', customer_id: 'cust-1', irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null, irrigation_controller_app: null };
    const res = await putPrefs({ irrigationControllerApp: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual([{ field: 'irrigationControllerApp', message: expect.stringMatching(/saves as one record/) }]);
    expect(timerOf(db._state.row)).toEqual(['rain_bird', null, null]);
    expect(db._state.row.updated_at).toBeUndefined();
  });

  test('a timer that cannot exist is rejected beside a field that saves', async () => {
    const res = await putPrefs({ irrigationControllerBrand: 'rain_bird', irrigationControllerModel: 'x2', irrigationControllerApp: null, parkingNotes: 'Driveway' });
    expect(res.status).toBe(200);
    expect(res.body.rejected.map((r) => r.field)).toEqual(['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp']);
    expect(db._state.row.parking_notes).toBe('Driveway');
    expect(timerOf(db._state.row)).toEqual([null, null, null]);
  });

  test('after a move, only a page rendered against the new home may set the timer', async () => {
    const movedAt = '2026-11-10T15:00:00.000Z';
    const moved = () => ({ id: 'pref-1', customer_id: 'cust-1', irrigation_home_changed_at: movedAt, ...clearedControllerTimer() });
    db._state.row = moved();
    for (const stale of [X2_ON_APP, { ...X2_ON_APP, confirmed_as_of: null }, { ...X2_ON_APP, confirmed_as_of: '2026-09-01T00:00:00.000Z' }]) {
      const res = await putPrefs(stale);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('The home on this account changed. Reload, then set the sprinkler timer again.');
      expect(timerOf(db._state.row)).toEqual([null, null, null]);
    }
    expect((await putPrefs({ ...X2_ON_APP, confirmed_as_of: movedAt })).status).toBe(200);
    expect(timerOf(db._state.row)).toEqual(['hunter', 'x2', 'yes']);
  });
});

describe('timer fields: not a watering input, and no customer email', () => {
  test('recording a timer neither stamps the irrigation system on nor confirms a sizing field', () => {
    for (const column of CONTROLLER_TIMER_FIELDS) {
      expect(IRRIGATION_INPUT_FIELDS).not.toContain(column);
      expect(IRRIGATION_SIZING_FIELDS).not.toContain(column);
    }
  });

  test('a timer change adds nothing to the account-updated email', () => {
    const items = propertyRouter._private.propertyChangeItems(
      { irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' },
      clearedControllerTimer(),
    );
    expect(items).toEqual([]);
  });
});
