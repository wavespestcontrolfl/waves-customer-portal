// The sprinkler timer on file (step 1 of sprinkler timer connect): three property_preferences fields the customer
// card and the staff form write through the shared validator, and one read-only count. No database: knex compiles
// with the pg dialect and every query is captured and answered from a canned list.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn().mockResolvedValue(undefined) }));
const mockQueries = [];
let mockTimerRows = [];
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  knex.client.acquireConnection = async () => ({});
  knex.client.releaseConnection = async () => {};
  knex.client._query = async (conn, obj) => {
    mockQueries.push(obj.sql);
    obj.response = { rows: mockTimerRows, rowCount: mockTimerRows.length };
    return obj;
  };
  knex.client.processResponse = (obj) => obj.response.rows;
  return knex;
});

const { CONTROLLER_BRANDS, CONTROLLER_MODELS, CONTROLLER_APP_ANSWERS } = require('@waves/irrigation-runtime');
const {
  PREFS_FIELD_SCHEMAS, ALLOWED_FIELDS, validatePrefsBody, normalizeUpdatesForStorage,
} = require('../services/property-preferences-schema');
const { IRRIGATION_INPUT_FIELDS, IRRIGATION_SIZING_FIELDS } = require('../services/irrigation-schedule-confirmation');
const propertyRouter = require('../routes/property');
const { executeTool } = require('../services/intelligence-bar/tools');

const TIMER_COLUMNS = ['irrigation_controller_brand', 'irrigation_controller_model', 'irrigation_controller_app'];

beforeEach(() => { mockQueries.length = 0; mockTimerRows = []; });

describe('timer fields: what a writer may store', () => {
  test('every key on the shared list is accepted, and a clear stores null', () => {
    const body = { irrigationControllerBrand: 'hunter', irrigationControllerModel: 'pro_c', irrigationControllerApp: 'unknown' };
    expect(validatePrefsBody(PREFS_FIELD_SCHEMAS, body)).toMatchObject({ value: body, rejected: [] });
    for (const [field, labels] of [
      ['irrigationControllerBrand', CONTROLLER_BRANDS], ['irrigationControllerModel', CONTROLLER_MODELS], ['irrigationControllerApp', CONTROLLER_APP_ANSWERS],
    ]) {
      for (const key of Object.keys(labels)) expect(PREFS_FIELD_SCHEMAS[field].validate(key).error).toBeUndefined();
      expect(PREFS_FIELD_SCHEMAS[field].validate('').value).toBeNull();
      expect(PREFS_FIELD_SCHEMAS[field].validate(null).value).toBeNull();
    }
  });

  test('a value off the list is rejected for that field only, and the rest of the save stands', () => {
    const { value, rejected } = validatePrefsBody(PREFS_FIELD_SCHEMAS, {
      irrigationControllerBrand: 'Hunter', irrigationControllerModel: 'esp_tm2', irrigationControllerApp: 'yes',
    });
    expect(rejected.map((r) => r.field).sort()).toEqual(['irrigationControllerBrand', 'irrigationControllerModel']);
    expect(value).toEqual({ irrigationControllerApp: 'yes' });
  });

  test('both writers may store the three columns', () => {
    for (const column of TIMER_COLUMNS) expect(ALLOWED_FIELDS).toContain(column);
  });
});

describe('timer fields: one box on the wall', () => {
  test('a brand that is not Hunter drops the model; the app answer stays', () => {
    expect(normalizeUpdatesForStorage({ irrigation_controller_brand: 'rain_bird', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' }))
      .toEqual({ irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null, irrigation_controller_app: 'yes' });
  });

  test('clearing the brand clears the model and the app answer, even when the write names neither', () => {
    expect(normalizeUpdatesForStorage({ irrigation_controller_brand: null }))
      .toEqual({ irrigation_controller_brand: null, irrigation_controller_model: null, irrigation_controller_app: null });
  });

  test('a Hunter keeps its model, and a write that does not name the brand is left alone', () => {
    const hunter = { irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2' };
    expect(normalizeUpdatesForStorage({ ...hunter })).toEqual(hunter);
    expect(normalizeUpdatesForStorage({ irrigation_controller_app: 'no' })).toEqual({ irrigation_controller_app: 'no' });
    expect(normalizeUpdatesForStorage({ irrigation_zones: 6 })).toEqual({ irrigation_zones: 6 });
  });
});

describe('timer fields: not a watering input, and no customer email', () => {
  test('recording a timer neither stamps the irrigation system on nor confirms a sizing field', () => {
    for (const column of TIMER_COLUMNS) {
      expect(IRRIGATION_INPUT_FIELDS).not.toContain(column);
      expect(IRRIGATION_SIZING_FIELDS).not.toContain(column);
    }
  });

  test('a timer change adds nothing to the account-updated email', () => {
    const items = propertyRouter._private.propertyChangeItems(
      { irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' },
      { irrigation_controller_brand: null, irrigation_controller_model: null, irrigation_controller_app: null },
    );
    expect(items).toEqual([]);
  });
});

describe('get_sprinkler_timer_counts', () => {
  test('counts live customers only, and names no customer', async () => {
    mockTimerRows = [{ brand: 'hunter', model: 'x2', app: 'yes', homes: '3' }];
    const result = await executeTool('get_sprinkler_timer_counts', {});
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0]).toMatch(/from "property_preferences"/);
    expect(mockQueries[0]).toMatch(/"irrigation_controller_brand" is not null/);
    // whereLiveCustomer, inside the customer subquery.
    expect(mockQueries[0]).toMatch(/"customer_id" in \(select "id" from "customers" where .*"deleted_at" is null.*"pipeline_stage" in/s);
    expect(mockQueries[0]).toMatch(/group by "irrigation_controller_brand", "irrigation_controller_model", "irrigation_controller_app"/);
    expect(JSON.stringify(result)).not.toMatch(/customer_id|first_name|address/);
    expect(result.homes_with_a_timer_on_file).toBe(3);
  });

  test('sorts each recorded timer into where it stands for the Hydrawise app', async () => {
    mockTimerRows = [
      { brand: 'hunter', model: 'x2', app: 'yes', homes: '5' },
      { brand: 'hunter', model: 'x2', app: 'no', homes: '4' },
      { brand: 'hunter', model: 'x2', app: 'unknown', homes: '2' },
      { brand: 'hunter', model: 'pro_c', app: null, homes: '1' },
      { brand: 'hunter', model: 'hydrawise', app: null, homes: '3' },
      { brand: 'hunter', model: 'x_core', app: null, homes: '6' },
      { brand: 'hunter', model: null, app: null, homes: '1' },
      { brand: 'rain_bird', model: null, app: 'yes', homes: '7' },
      { brand: 'other', model: null, app: null, homes: '2' },
    ];
    const result = await executeTool('get_sprinkler_timer_counts', {});
    expect(result.homes_with_a_timer_on_file).toBe(31);
    // A Rain Bird on its own app has no Hydrawise route; a Hydrawise touchscreen needs no answer to be on Hydrawise.
    expect(result.summary).toEqual({ on_hydrawise: 8, needs_wifi_part: 4, no_hydrawise_route: 15, not_answered: 4 });
    expect(result.by_timer[0]).toEqual({ timer: 'Rain Bird', runs_from_phone_app: 'Yes', standing: 'no_hydrawise_route', homes: 7 });
    expect(result.by_timer).toContainEqual({ timer: 'Hunter X2', runs_from_phone_app: 'Not sure', standing: 'not_answered', homes: 2 });
    expect(result.by_timer).toContainEqual({ timer: 'Hunter (model not recorded)', runs_from_phone_app: 'Not answered', standing: 'not_answered', homes: 1 });
  });

  test('no timer on file yet is an answer, not an error', async () => {
    expect(await executeTool('get_sprinkler_timer_counts', {})).toEqual({
      homes_with_a_timer_on_file: 0,
      summary: { on_hydrawise: 0, needs_wifi_part: 0, no_hydrawise_route: 0, not_answered: 0 },
      by_timer: [],
    });
  });
});
