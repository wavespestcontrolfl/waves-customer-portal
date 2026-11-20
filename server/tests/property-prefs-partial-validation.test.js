/**
 * PUT /api/property/preferences — partial-batch validation (prod incident
 * 2026-09-11): a customer typed a half-finished HOA email alongside several
 * valid fields; the Joi schema validated the WHOLE body with abortEarly:
 * false and 400'd the entire batch for that one field, so nothing saved —
 * 8 consecutive 400s, `updated_at` never moved, everything she typed lost.
 *
 * Contract under test:
 *   - a mixed batch (one invalid field + several valid ones) persists the
 *     valid fields and answers 200 with a machine-readable `rejected` list
 *     (never a blanket 400 for the whole batch);
 *   - a batch where EVERY field is invalid still 400s (nothing to save),
 *     but with the same per-field `rejected` detail, not only a joined
 *     string;
 *   - hoaEmail's email format is not weakened, and ALLOWED_FIELDS is not
 *     widened, in the process.
 *   - the sprinkler timer on file follows the same contract as ONE record
 *     (services/controller-timer.js): a timer the row cannot take is
 *     rejected whole, while the other fields of the batch save.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', waveguard_tier: null, lawn_type: null };
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/termite-stations', () => ({}));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(), hasIrrigationEmailOptIn: jest.fn(async () => false) }));
jest.mock('../services/irrigation-app-plan', () => ({ appPlanEnabled: jest.fn(() => false), loadCustomerWateringPlan: jest.fn() }));

// Minimal fake `property_preferences` table backed by one in-memory row.
// None of the fields exercised here (parkingNotes/hoaEmail/accessNotes) are
// irrigation sizing fields, so the confirmation-ledger jsonb union branch
// never runs and this fake never needs to emulate `trx.raw`'s SQL — it only
// has to resolve the advisory-lock `await trx.raw(...)` call.
jest.mock('../models/db', () => {
  const state = { row: null };
  const propertyPreferencesTable = () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => state.row);
    q.update = jest.fn(async (patch) => {
      state.row = { ...state.row, ...patch, updated_at: new Date().toISOString() };
      return 1;
    });
    q.insert = jest.fn(async (data) => {
      state.row = { id: 'pref-1', customer_id: 'cust-1', created_at: new Date().toISOString(), ...data };
      return [1];
    });
    return q;
  };
  const dbFn = jest.fn((table) => {
    if (table !== 'property_preferences') throw new Error(`Unexpected table ${table}`);
    return propertyPreferencesTable();
  });
  dbFn.transaction = jest.fn(async (cb) => cb(dbFn));
  dbFn.raw = jest.fn(async () => undefined);
  dbFn.fn = { now: jest.fn(() => new Date().toISOString()) };
  dbFn._state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');

const app = express();
app.use('/api/property', require('../routes/property'));
app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Unavailable' }));

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  jest.clearAllMocks();
  db._state.row = null;
});

async function putPrefs(body) {
  const response = await fetch(`${base}/api/property/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('PUT /api/property/preferences — mixed valid/invalid batch', () => {
  test('valid fields persist and save with 200; only the invalid field is named as rejected', async () => {
    const { status, body } = await putPrefs({
      parkingNotes: 'Leave by garage',
      accessNotes: 'Use the side gate',
      hoaEmail: 'not-an-email',
    });

    expect(status).toBe(200);
    expect(body.saved).toBe(true);
    expect(body.preferences.parkingNotes).toBe('Leave by garage');
    expect(body.preferences.accessNotes).toBe('Use the side gate');
    expect(body.rejected).toEqual([{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }]);

    // The bad field never reached storage.
    expect(db._state.row.hoa_email).toBeUndefined();
    expect(db._state.row.parking_notes).toBe('Leave by garage');
    expect(db._state.row.access_notes).toBe('Use the side gate');
  });

  test('an unknown field alongside valid ones is silently dropped, not reported as rejected', async () => {
    const { status, body } = await putPrefs({ parkingNotes: 'Leave by garage', notAField: 'x' });
    expect(status).toBe(200);
    expect(body.rejected).toBeUndefined();
    expect(db._state.row.parking_notes).toBe('Leave by garage');
  });
});

describe('PUT /api/property/preferences — all-invalid batch', () => {
  test('still 400s with nothing saved, but with per-field detail instead of only a joined string', async () => {
    const { status, body } = await putPrefs({ hoaEmail: 'not-an-email' });

    expect(status).toBe(400);
    expect(body.rejected).toEqual([{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }]);
    expect(body.error).toContain('must be a valid email');
    expect(db._state.row).toBeNull();
  });

  test('several invalid fields all report, none saved', async () => {
    const { status, body } = await putPrefs({ hoaEmail: 'not-an-email', petCount: -5 });

    expect(status).toBe(400);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected.map((r) => r.field).sort()).toEqual(['hoaEmail', 'petCount']);
    expect(db._state.row).toBeNull();
  });
});

describe('PUT /api/property/preferences — validation is not weakened', () => {
  test('hoaEmail still enforces email format for a lone, otherwise-fine-looking string', async () => {
    const { status, body } = await putPrefs({ hoaEmail: 'still not an email' });
    expect(status).toBe(400);
    expect(body.rejected[0].field).toBe('hoaEmail');
  });

  test('a syntactically valid hoaEmail still saves normally (no false rejection)', async () => {
    const { status, body } = await putPrefs({ hoaEmail: 'manager@example.com' });
    expect(status).toBe(200);
    expect(body.rejected).toBeUndefined();
    expect(body.preferences.hoaEmail).toBe('manager@example.com');
  });
});

// Per-field validation is only equivalent to whole-object validation while
// every field stands alone (pre-push audit P1). If someone later expresses a
// cross-field rule at the object level — Joi.when/xor/and/or/with/without —
// the per-field validator would silently stop enforcing it, so this pins the
// precondition rather than the implementation: add such a rule and this test
// tells you to enforce it explicitly.
describe('PREFS_FIELD_SCHEMAS must stay field-independent', () => {
  const { prefsSchema } = require('../routes/property')._private;

  test('the object schema declares no cross-field dependencies', () => {
    const described = prefsSchema.describe();
    expect(described.dependencies).toBeUndefined();
    // No per-key rule may reference a sibling either (Joi.ref / when).
    const keyed = JSON.stringify(described.keys || {});
    expect(keyed).not.toMatch(/"ref":/);
    expect(keyed).not.toMatch(/"whens":/);
  });
});

// A JSON body key that names an Object.prototype member must be stripped
// like any other unknown key, not resolved to the inherited function and
// handed to Joi (codex r1 P2 — that threw, so the whole save 500'd).
describe('prototype-inherited keys are unknown, not schemas', () => {
  const { validatePrefsBody } = require('../routes/property')._private;

  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    '%s is stripped without throwing',
    (key) => {
      const body = JSON.parse(`{"${key}": "x", "garageCode": "1234"}`);
      const out = validatePrefsBody(body);
      expect(out.rejected).toEqual([]);
      expect(out.value).toEqual({ garageCode: '1234' });
      expect(out.presentCount).toBe(1);
    },
  );
});

// The sprinkler timer on file (sprinkler timer connect, step 1): three fields that are ONE record about one box on
// the wall of one home. The customer's writer settles them under its preference lock (settleControllerTimer).
describe('PUT /api/property/preferences — the sprinkler timer on file', () => {
  const { CONTROLLER_BRANDS, CONTROLLER_MODELS, CONTROLLER_APP_ANSWERS } = require('@waves/irrigation-runtime');
  const { PREFS_FIELD_SCHEMAS, ALLOWED_FIELDS } = require('../services/property-preferences-schema');
  const { IRRIGATION_INPUT_FIELDS, IRRIGATION_SIZING_FIELDS } = require('../services/irrigation-schedule-confirmation');
  const { CONTROLLER_TIMER_FIELDS, clearedControllerTimer } = require('../services/controller-timer');
  const AccountMembershipEmail = require('../services/account-membership-email');
  const { propertyChangeItems } = require('../routes/property')._private;
  const X2_ON_APP = { irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: 'yes' };
  const timerOf = (row) => CONTROLLER_TIMER_FIELDS.map((column) => row?.[column] ?? null);

  test('each field takes a key from the shared list; a blank clears; free text is rejected', () => {
    for (const [field, labels] of [
      ['irrigationControllerBrand', CONTROLLER_BRANDS], ['irrigationControllerModel', CONTROLLER_MODELS], ['irrigationControllerApp', CONTROLLER_APP_ANSWERS],
    ]) {
      for (const key of Object.keys(labels)) expect(PREFS_FIELD_SCHEMAS[field].validate(key).error).toBeUndefined();
      expect(PREFS_FIELD_SCHEMAS[field].validate('').value).toBeNull();
      expect(PREFS_FIELD_SCHEMAS[field].validate('Hunter').error).toBeTruthy();
    }
    for (const column of CONTROLLER_TIMER_FIELDS) expect(ALLOWED_FIELDS).toContain(column);
  });

  test('a whole timer saves, comes back in the response, stamps no irrigation system and sends no email', async () => {
    const { status, body } = await putPrefs({ ...X2_ON_APP, controller_timer_seen: '||' });
    expect(status).toBe(200);
    expect(body.preferences).toMatchObject(X2_ON_APP);
    expect(timerOf(db._state.row)).toEqual(['hunter', 'x2', 'yes']);
    expect(db._state.row.irrigation_system).toBeUndefined();
    expect(db._state.row.irrigation_confirmed_fields).toBeUndefined();
    expect(AccountMembershipEmail.sendAccountUpdated).not.toHaveBeenCalled();
  });

  test('an answer sent alone is a 400 that names the field, and nothing is written', async () => {
    db._state.row = { id: 'pref-1', customer_id: 'cust-1', irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null, irrigation_controller_app: null };
    const { status, body } = await putPrefs({ irrigationControllerApp: 'yes' });
    expect(status).toBe(400);
    expect(body.rejected).toEqual([{ field: 'irrigationControllerApp', message: expect.stringMatching(/saves as one record/) }]);
    expect(timerOf(db._state.row)).toEqual(['rain_bird', null, null]);
    expect(db._state.row.updated_at).toBeUndefined();
  });

  test('a timer that cannot exist is rejected whole beside a field that saves', async () => {
    const { status, body } = await putPrefs({ irrigationControllerBrand: 'rain_bird', irrigationControllerModel: 'x2', irrigationControllerApp: null, parkingNotes: 'Driveway' });
    expect(status).toBe(200);
    expect(body.rejected.map((r) => r.field)).toEqual(['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp']);
    expect(db._state.row.parking_notes).toBe('Driveway');
    expect(timerOf(db._state.row)).toEqual([null, null, null]);
  });

  test('after a move, only a page rendered against the new home may set the timer', async () => {
    const movedAt = '2026-11-10T15:00:00.000Z';
    db._state.row = { id: 'pref-1', customer_id: 'cust-1', irrigation_home_changed_at: movedAt, ...clearedControllerTimer() };
    for (const stale of [X2_ON_APP, { ...X2_ON_APP, confirmed_as_of: null }, { ...X2_ON_APP, confirmed_as_of: '2026-09-01T00:00:00.000Z' }]) {
      const { status, body } = await putPrefs(stale);
      expect(status).toBe(400);
      expect(body.error).toBe('The home on this account changed. Reload, then set the sprinkler timer again.');
      expect(timerOf(db._state.row)).toEqual([null, null, null]);
    }
    expect((await putPrefs({ ...X2_ON_APP, confirmed_as_of: movedAt, controller_timer_seen: '||' })).status).toBe(200);
    expect(timerOf(db._state.row)).toEqual(['hunter', 'x2', 'yes']);
  });

  // Pro-C picked over an X2, its save landed but the answer was lost, and Yes was tapped meanwhile: the retry names
  // both timers the row may hold, and the row holding either one takes it.
  test('after a save that may have landed, a change naming both timers saves over either one', async () => {
    const answered = { irrigationControllerBrand: 'hunter', irrigationControllerModel: 'pro_c', irrigationControllerApp: 'yes', controller_timer_seen: ['hunter|x2|', 'hunter|pro_c|'] };
    for (const model of ['x2', 'pro_c']) {
      db._state.row = { id: 'pref-1', customer_id: 'cust-1', irrigation_controller_brand: 'hunter', irrigation_controller_model: model, irrigation_controller_app: null };
      expect((await putPrefs(answered)).status).toBe(200);
      expect(timerOf(db._state.row)).toEqual(['hunter', 'pro_c', 'yes']);
    }
  });

  test('a page that showed another timer cannot set one: the timer changed while it was open', async () => {
    db._state.row = { id: 'pref-1', customer_id: 'cust-1', irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null, irrigation_controller_app: null };
    for (const seen of [{ controller_timer_seen: 'hunter|x2|' }, {}]) {
      const { status, body } = await putPrefs({ ...X2_ON_APP, ...seen });
      expect(status).toBe(400);
      expect(body.error).toBe('The sprinkler timer on this account changed while this page was open. Reload, then set it again.');
      expect(timerOf(db._state.row)).toEqual(['rain_bird', null, null]);
    }
    expect((await putPrefs({ ...X2_ON_APP, controller_timer_seen: 'rain_bird||' })).status).toBe(200);
    expect(timerOf(db._state.row)).toEqual(['hunter', 'x2', 'yes']);
    // That save landed but its answer was lost: the page sends it again, with the timer it showed before it. The row
    // already holds this timer, so the retry is no conflict.
    const retry = await putPrefs({ ...X2_ON_APP, controller_timer_seen: 'rain_bird||' });
    expect(retry.status).toBe(200);
    expect(retry.body.rejected).toBeUndefined();
    expect(timerOf(db._state.row)).toEqual(['hunter', 'x2', 'yes']);
  });

  test('a timer is not a watering input, and a change to it adds nothing to the account-updated email', () => {
    for (const column of CONTROLLER_TIMER_FIELDS) {
      expect(IRRIGATION_INPUT_FIELDS).not.toContain(column);
      expect(IRRIGATION_SIZING_FIELDS).not.toContain(column);
    }
    const x2Columns = { irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' };
    expect(propertyChangeItems(x2Columns, clearedControllerTimer())).toEqual([]);
  });
});
