// Lawn Fast Complete with new-sod mode (GATE_LAWN_NEW_SOD_MODE, P35): the context
// carries a short "New sod laid <date>" note and the watering preview shows the
// lines the report prints for such a visit, never the engine's own instruction.
// Gate off changes nothing. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Failures are injected at the QUERY level (the fake db throws), not by making a
// helper throw, so a helper that swallows its own query failure cannot hide: the
// profile resolver, the feature-flag read and the week-plan loader all run for real.
// The global db is the week-plan loader's (it reads the module-level connection).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));

const globalDb = require('../models/db');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const { gates } = require('../config/feature-gates');
const {
  buildLawnFastContext,
  buildLawnFastWateringPreview,
} = require('../services/lawn-fast-complete');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ASSESSMENT = uuid(2);
const CATALOG = uuid(3);
const CUSTOMER = uuid(30);
const TECH = uuid(5);
const P_HERB = uuid(11);
const P_UNKNOWN = uuid(14);

// The catalog service and its completion-profile row, as the real resolver reads them.
const SERVICE_ROW = { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' };
const PROFILE_ROW = (extra = {}) => ({
  service_key: 'lawn_care_monthly', service_name_snapshot: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring',
  completion_mode: 'service_report', project_type: null, companion_types: null, active: true, ...extra,
});
const visit = (extra = {}) => ({
  id: VISIT, customer_id: CUSTOMER, property_id: 'prop-1', service_type: 'Lawn Care', service_id: CATALOG,
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null, technician_id: 'tech-1',
  cust_address_line1: '100 Example Court', cust_city: 'Bradenton', cust_state: 'FL', cust_zip: '34201', ...extra,
});
const herbicide = {
  id: P_HERB, name: 'Test Weed Spray', category: 'herbicide', product_type: 'pesticide', formulation: 'WG',
  epa_reg_number: '100-1', approved_for_service_report: true,
  post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label' },
};
const PREFS = {
  customer_id: CUSTOMER, irrigation_system: true, irrigation_system_type: ['rotor'], irrigation_run_minutes: 30,
  watering_days: ['Mon', 'Thu'], irrigation_confirmed_fields: ['irrigation_system_type', 'irrigation_run_minutes', 'watering_days'],
};

const readError = () => Object.assign(new Error('connection lost'), { code: '08006' });

// A table-keyed fake knex. A table whose data is an Error rejects every read; a
// table in `failFirst` rejects its first N reads and then serves its rows.
// `calls` lists each table touched, in order.
function fakeKnex(tables, { failFirst = {}, calls = [], hasTableFails = false } = {}) {
  const attempts = {};
  const knex = jest.fn((table) => {
    calls.push(table);
    attempts[table] = (attempts[table] || 0) + 1;
    const data = tables[table];
    const failing = data instanceof Error || attempts[table] <= (failFirst[table] || 0);
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'leftJoin', 'join', 'orderBy', 'select']) chain[m] = () => chain;
    chain.first = async () => {
      if (failing) throw (data instanceof Error ? data : readError());
      return Array.isArray(data) ? data[0] : data;
    };
    const settle = () => (failing ? Promise.reject(data instanceof Error ? data : readError()) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  knex.schema = {
    hasTable: async () => {
      if (hasTableFails) throw readError();
      return true;
    },
  };
  return knex;
}

const baseTables = (extra = {}) => ({
  scheduled_services: visit(),
  services: SERVICE_ROW,
  service_completion_profiles: PROFILE_ROW(),
  user_feature_flags: { enabled: true },
  customers: { billing_mode: null },
  lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true, service_date: '2026-10-05' },
  // What the property-history resolver reads (the visit's installed assessment, joined; the
  // customer's properties; any recorded move and baseline reset).
  'lawn_assessments as la': [{
    id: ASSESSMENT, customer_id: CUSTOMER, service_id: VISIT, confirmed_by_tech: true, property_id: 'prop-1',
    history_visit_id: VISIT, history_visit_customer_id: CUSTOMER, history_visit_property_id: 'prop-1',
    history_visit_date: '2026-10-05', service_date: '2026-10-05', created_at: '2026-10-05T12:00:00Z',
  }],
  customer_properties: [{ id: 'prop-1', customer_id: CUSTOMER, active: true, is_primary: true, address_line1: '100 Example Court' }],
  lawn_baseline_resets: [],
  lawn_assessment_photos: [{ zone: 'front' }, { zone: 'close_up' }, { zone: 'trouble' }],
  products_catalog: [herbicide],
  property_preferences: PREFS,
  customer_turf_profiles: undefined,
  ...extra,
});


const KEYS = ['GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_FAST_COMPLETE', 'GATE_LAWN_NEW_SOD_MODE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const savedPlan = gates.irrigationWeekPlan;
beforeEach(() => {
  process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  process.env.GATE_LAWN_WATERING_RULE = 'true';
  process.env.GATE_LAWN_FAST_COMPLETE = 'true';
  delete process.env.GATE_LAWN_NEW_SOD_MODE;
  gates.irrigationWeekPlan = false;
  buildPlanForService.mockReset().mockResolvedValue({
    completionDefaults: { items: [{ product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: 2, amountUnit: 'fl oz' } }] },
  });
  globalDb.mockReset().mockImplementation(() => { throw new Error('the global db is only for the week-plan loader'); });
});
afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  gates.irrigationWeekPlan = savedPlan;
});

const prefsWith = (sod_laid_on) => ({ ...PREFS, sod_laid_on });
const ctx = (tables) => buildLawnFastContext(VISIT, { knex: fakeKnex(baseTables(tables)), technicianId: TECH });
const preview = (tables) => buildLawnFastWateringPreview({
  serviceId: VISIT, productIds: [P_HERB], knex: fakeKnex(baseTables(tables)), now: new Date('2026-10-05T14:00:00Z'),
});

describe('Lawn Fast Complete context: the New sod note', () => {
  test('gate off: no key, whatever the date', async () => {
    expect(await ctx({ property_preferences: prefsWith('2026-10-01') })).not.toHaveProperty('newSod');
  });

  test('gate on, visit inside the window: the note and the date', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const result = await ctx({ property_preferences: prefsWith('2026-10-01') });
    expect(result.newSod).toEqual({ laidOn: '2026-10-01', note: 'New sod laid Oct 1' });
  });

  test('gate on, visit past day 21, before the sod date, or no date: no key', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    for (const sod of ['2026-09-01', '2026-10-06', null]) {
      expect(await ctx({ property_preferences: prefsWith(sod) })).not.toHaveProperty('newSod');
    }
  });

  test('gate on, preference unreadable: no note, and the context still answers', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const result = await ctx({ property_preferences: readError() });
    expect(result).not.toHaveProperty('newSod');
    expect(result.eligible).toBe(true);
  });
});

describe('Lawn Fast Complete watering preview with new sod', () => {
  test('gate off: the engine\'s own hold sentence, as before', async () => {
    const result = await preview({ property_preferences: prefsWith('2026-10-01') });
    expect(result.sentence).toMatch(/^Skip your turf watering until/);
    expect(result).not.toHaveProperty('newSod');
  });

  test('gate on, inside the window: the lines the report always prints, no skip-watering sentence', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const result = await preview({ property_preferences: prefsWith('2026-10-01') });
    expect(result).toMatchObject({
      ok: true,
      state: 'new_sod',
      lines: ['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.'],
      sentence: 'Water your new sod lightly every day. Please hold off on mowing until the sod has rooted.',
      newSod: { laidOn: '2026-10-01', note: 'New sod laid Oct 1' },
      omitted: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/Skip your turf watering/);
  });

  test('gate on, even with the watering rule gate off, the new-sod lines show (the report prints them regardless)', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'false';
    const result = await preview({ property_preferences: prefsWith('2026-10-01') });
    expect(result.state).toBe('new_sod');
  });

  test('gate on, visit outside the window: the engine\'s own sentence', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const result = await preview({ property_preferences: prefsWith('2026-09-01') });
    expect(result.sentence).toMatch(/^Skip your turf watering until/);
  });
});
