// Lawn Fast Complete: the fail-closed rule. A caught read failure is recorded and
// never continues with a value more permissive than a successful read could give;
// and every client-supplied id is checked for uuid syntax before it reaches a
// uuid column (Postgres 22P02 would be a 500). Table-driven: for each read, make
// it throw and assert the fail-closed output. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Failures are injected at the QUERY level (the fake db throws), not by making a
// helper throw, so a helper that swallows its own query failure cannot hide: the
// profile resolver, the feature-flag read and the week-plan loader all run for real.
// The global db is the week-plan loader's (it reads the module-level connection).
jest.mock('../models/db', () => jest.fn());
// No grass track known here: the protocol-window read resolves nothing and reads nothing.
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn(), selectProtocolVisit: jest.fn(() => ({ trackKey: null, track: null, month: 'Oct', visit: null })) }));

const globalDb = require('../models/db');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const { gates } = require('../config/feature-gates');
const {
  isUuid,
  buildLawnFastContext,
  buildLawnFastWateringPreview,
  preflightLawnFastCompletion,
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

// A db that raises Postgres 22P02 for a malformed uuid in an id predicate, as the
// real one does: the test would have caught a malformed id reaching a query.
const ID_COLUMNS = new Set(['id', 'scheduled_services.id', 'assessment_id']);
function uuidStrictKnex(tables, calls = []) {
  const base = fakeKnex(tables, { calls });
  const bad = (value) => (Array.isArray(value) ? value.some(bad) : !isUuid(String(value)));
  const invalid = () => Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
  const strict = jest.fn((table) => {
    const chain = base(table);
    for (const method of ['where', 'whereIn']) {
      const original = chain[method];
      chain[method] = (...args) => {
        if (args[0] && typeof args[0] === 'object') {
          for (const [key, value] of Object.entries(args[0])) if (ID_COLUMNS.has(key) && bad(value)) throw invalid();
        } else if (ID_COLUMNS.has(args[0]) && bad(args[args.length - 1])) {
          throw invalid();
        }
        return original(...args);
      };
    }
    return chain;
  });
  strict.schema = base.schema;
  return strict;
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

const saved = {
  defaults: process.env.GATE_LAWN_COMPLETION_DEFAULTS,
  history: process.env.GATE_LAWN_PROPERTY_HISTORY,
  rule: process.env.GATE_LAWN_WATERING_RULE,
  fast: process.env.GATE_LAWN_FAST_COMPLETE,
  plan: gates.irrigationWeekPlan,
};
beforeEach(() => {
  process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  process.env.GATE_LAWN_WATERING_RULE = 'true';
  process.env.GATE_LAWN_FAST_COMPLETE = 'true';
  gates.irrigationWeekPlan = false;
  buildPlanForService.mockReset().mockResolvedValue({
    completionDefaults: { items: [{ product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: 2, amountUnit: 'fl oz' } }] },
  });
  globalDb.mockReset().mockImplementation(() => { throw new Error('the global db is only for the week-plan loader'); });
});
afterAll(() => {
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  restore('GATE_LAWN_COMPLETION_DEFAULTS', saved.defaults);
  restore('GATE_LAWN_PROPERTY_HISTORY', saved.history);
  restore('GATE_LAWN_WATERING_RULE', saved.rule);
  restore('GATE_LAWN_FAST_COMPLETE', saved.fast);
  gates.irrigationWeekPlan = saved.plan;
});

describe('buildLawnFastContext: every read, made to throw', () => {
  const ctx = (tables, options) => buildLawnFastContext(VISIT, { knex: fakeKnex(baseTables(tables), options), technicianId: TECH });

  test('the control: a recurring program visit with every read healthy gets the planned items', async () => {
    const result = await ctx({});
    expect(result).toMatchObject({ eligible: true, visitType: 'recurring', plannedProductsUnavailable: null, readFailures: [] });
    expect(result.plannedProducts.items).toHaveLength(1);
    expect(result.assessment).toMatchObject({ confirmed: true, readFailed: false });
  });

  test('billing mode read fails: visit type unknown, no program defaults, eligibility unchanged', async () => {
    const calls = [];
    const result = await buildLawnFastContext(VISIT, { knex: fakeKnex(baseTables({ customers: readError() }), { calls }) });
    expect(result).toMatchObject({
      eligible: true, reason: null, visitType: 'unknown',
      plannedProducts: { source: null, items: [] }, plannedProductsUnavailable: 'billing_mode_lookup_failed',
    });
    expect(result.readFailures).toContain('billing_mode');
    expect(buildPlanForService).not.toHaveBeenCalled();
  });

  test('billing mode read fails on a per_application customer with a recurring profile: no seasonal defaults', async () => {
    // The failed read is exactly what hid per_application; the type must not become recurring.
    const result = await ctx({ customers: readError() });
    expect(result.visitType).not.toBe('recurring');
    expect(result.plannedProducts.items).toEqual([]);
  });

  test('billing mode read fails on an ineligible visit: still the same refusal', async () => {
    const result = await ctx({ customers: readError(), services: { ...SERVICE_ROW, service_key: 'lawn_re_service' }, service_completion_profiles: PROFILE_ROW({ service_key: 'lawn_re_service' }) });
    expect(result).toMatchObject({ eligible: false, reason: 'lawn_re_service' });
  });

  test('assessment read fails: reads as no confirmed assessment, flagged, never confirmed', async () => {
    const result = await ctx({ lawn_assessments: readError() });
    expect(result.assessment).toEqual({ exists: false, id: null, confirmed: false, unusableReason: null, readFailed: true });
    expect(result.photoStatus).toBeNull();
    expect(result.readFailures).toContain('assessment');
  });

  test('photo read fails: no photo status (advisory), recorded', async () => {
    const result = await ctx({ lawn_assessment_photos: readError() });
    expect(result.photoStatus).toBeNull();
    expect(result.readFailures).toContain('photo_status');
    expect(result.assessment.confirmed).toBe(true);
  });

  test('plan read fails: empty planned products with a reason', async () => {
    buildPlanForService.mockRejectedValue(readError());
    const result = await ctx({});
    expect(result.plannedProducts).toEqual({ source: null, items: [] });
    expect(result.plannedProductsUnavailable).toBe('planned_products_lookup_failed');
    expect(result.readFailures).toContain('planned_products');
  });

  test('catalog read for the planned rules fails: empty planned products, never rule-less items', async () => {
    const result = await ctx({ products_catalog: readError() });
    expect(result.plannedProducts).toEqual({ source: null, items: [] });
    expect(result.plannedProductsUnavailable).toBe('planned_products_lookup_failed');
  });

  test('height flag read fails: capture hidden, recorded', async () => {
    const result = await ctx({ user_feature_flags: readError() });
    expect(result.turfHeightCapture).toBe(false);
    expect(result.readFailures).toContain('turf_height_flag');
  });

  test('visit group read fails: the request fails (no eligible verdict is invented)', async () => {
    await expect(ctx({ scheduled_services: visit({ visit_id: uuid(7) }), service_visits: readError() })).rejects.toThrow('connection lost');
  });

  // The profile read, failed at the QUERY level. The non-strict resolver turned a failed
  // availability probe into a synthesized lawn profile that had lost projectBacked /
  // requiresProject / companions, approving a project-backed visit.
  describe('profile reads', () => {
    const PROJECT_BACKED = { service_completion_profiles: PROFILE_ROW({ completion_mode: 'project_required', project_type: 'special' }) };
    const COMPANION = { service_completion_profiles: PROFILE_ROW({ companion_types: [{ type: 'tree_shrub', delivery: 'internal_only' }] }) };

    test('the controls: a project-backed profile and a companion profile are refused when the read succeeds', async () => {
      expect(await ctx(PROJECT_BACKED)).toMatchObject({ eligible: false, reason: 'project_backed' });
      expect(await ctx(COMPANION)).toMatchObject({ eligible: false, reason: 'has_companions' });
    });

    test('the availability probe (schema.hasTable) fails: profile_unavailable, not an eligible synthesized lawn profile', async () => {
      for (const tables of [{}, PROJECT_BACKED, COMPANION]) {
        const result = await buildLawnFastContext(VISIT, { knex: fakeKnex(baseTables(tables), { hasTableFails: true }) });
        expect(result).toMatchObject({ ok: true, eligible: false, reason: 'profile_unavailable' });
      }
    });

    test('the profile row query fails: profile_unavailable', async () => {
      expect(await ctx({ service_completion_profiles: readError() })).toMatchObject({ eligible: false, reason: 'profile_unavailable' });
    });

    test('the catalog service query fails: profile_unavailable', async () => {
      expect(await ctx({ services: readError() })).toMatchObject({ eligible: false, reason: 'profile_unavailable' });
    });

    test('a SUCCESSFUL read that finds no profile row may still synthesize one (as before; a synthesized profile is never a recurring program visit)', async () => {
      expect(await ctx({ service_completion_profiles: undefined })).toMatchObject({ eligible: true, visitType: 'other' });
    });

    test('the submit preflight: the same probe failure is a 503 retry, never an approval', async () => {
      const expectedVisit = {
        propertyId: 'prop-1', customerId: CUSTOMER, catalogServiceId: CATALOG, serviceType: 'Lawn Care', scheduledDate: '2026-10-05',
        isCallback: false, address: {}, technicianId: 'tech-1',
      };
      const run = (options, tables = {}) => preflightLawnFastCompletion({
        knex: fakeKnex(baseTables(tables), options), svc: { id: VISIT, customer_id: CUSTOMER }, lawnAssessmentId: ASSESSMENT, expectedVisit, lawnFast: { visitType: 'recurring' },
      });
      expect(await run({ hasTableFails: true }, PROJECT_BACKED)).toMatchObject({ status: 503, payload: { code: 'completion_profile_lookup_failed' } });
      expect(await run({}, PROJECT_BACKED)).toMatchObject({ status: 409, payload: { reason: 'project_backed' } });
    });
  });
});

describe('buildLawnFastWateringPreview: any move-guard or plan read failure withholds the sentence', () => {
  const now = new Date('2026-09-30T18:40:00Z');
  const preview = (tables, options) => buildLawnFastWateringPreview({
    serviceId: VISIT, productIds: [P_HERB], knex: fakeKnex(baseTables(tables), options), now,
  });
  const expectWithheld = (result, reason) => {
    expect(result.ok).toBe(true);
    expect(result.sentence).toBeNull();
    expect(result.lines).toEqual([]);
    expect(result.state).toBeNull();
    expect(result.omitted).toContain(reason);
  };

  test('the control: healthy reads give the hold sentence', async () => {
    const result = await preview({});
    expect(result.sentence).toMatch(/^Skip your turf watering until/);
    expect(result.omitted).toEqual([]);
  });

  test.each([
    ['customer_turf_profiles', { customer_turf_profiles: readError() }],
    ['property_preferences', { property_preferences: readError() }],
    ['lawn_assessments', { lawn_assessments: readError() }],
  ])('%s read fails: no sentence, even if the instruction\'s own prefs read would succeed', async (_name, tables) => {
    expectWithheld(await preview(tables), 'irrigation_context');
  });

  test('the context\'s prefs read fails once and the builder\'s later read succeeds: still no sentence', async () => {
    expectWithheld(await preview({}, { failFirst: { property_preferences: 1 } }), 'irrigation_context');
  });

  test('the turf profile read fails once and everything later succeeds: still no sentence', async () => {
    expectWithheld(await preview({ customer_turf_profiles: { customer_id: CUSTOMER } }, { failFirst: { customer_turf_profiles: 1 } }), 'irrigation_context');
  });

  test('week plan read fails (gate on): no sentence', async () => {
    gates.irrigationWeekPlan = true;
    // The loader reads the module-level db: its irrigation_week_plans query fails.
    globalDb.mockImplementation(() => {
      const chain = { where: () => chain, first: () => Promise.reject(readError()) };
      return chain;
    });
    expectWithheld(await preview({}), 'week_plan');
  });

  test('the builder\'s own prefs read fails after the context read succeeded: no sentence', async () => {
    // First prefs read (context) succeeds, the second (inside the instruction) fails.
    let reads = 0;
    const base = fakeKnex(baseTables());
    const knex = jest.fn((table) => {
      if (table === 'property_preferences' && ++reads === 2) return fakeKnex(baseTables({ property_preferences: readError() }))(table);
      return base(table);
    });
    const result = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [P_HERB], knex, now });
    expectWithheld(result, 'irrigation_inputs');
  });

  test('catalog read fails: the request fails, no rule-less preview', async () => {
    await expect(preview({ products_catalog: readError() })).rejects.toThrow('connection lost');
  });

  test('visit read fails: the request fails', async () => {
    await expect(preview({ scheduled_services: readError() })).rejects.toThrow('connection lost');
  });
});

describe('client-supplied ids are checked before they reach a uuid column (22P02)', () => {
  test('the uuid check', () => {
    expect(isUuid(VISIT)).toBe(true);
    for (const value of ['missing', '', 'visit-1', null, undefined, 123, `${VISIT}x`]) expect(isUuid(value)).toBe(false);
  });

  test('a malformed productId is a 400-class invalid_product_ids and the db is never reached', async () => {
    const calls = [];
    const knex = uuidStrictKnex(baseTables(), calls);
    for (const productIds of [['missing'], [P_HERB, 'missing'], [' not-a-uuid '], [123]]) {
      expect(await buildLawnFastWateringPreview({ serviceId: VISIT, productIds, knex })).toEqual({ ok: false, reason: 'invalid_product_ids' });
    }
    expect(calls).toEqual([]);
  });

  test('a well-formed unknown product id still yields the no-rule entry (and the strict db does not throw)', async () => {
    const knex = uuidStrictKnex(baseTables({ products_catalog: [] }));
    const result = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [P_UNKNOWN], knex });
    expect(result.ok).toBe(true);
    expect(result.products).toEqual([expect.objectContaining({ productId: P_UNKNOWN, name: null, rule: null, approvedForReport: false })]);
  });

  test('the strict db really throws 22P02 on a malformed id (the harness would catch the bug)', () => {
    const knex = uuidStrictKnex(baseTables());
    expect(() => knex('products_catalog').whereIn('id', ['missing'])).toThrow(expect.objectContaining({ code: '22P02' }));
  });

  test('a malformed serviceId is not_found for the context and the preview, db untouched', async () => {
    const calls = [];
    const knex = uuidStrictKnex(baseTables(), calls);
    expect(await buildLawnFastContext('abc', { knex })).toEqual({ ok: false, reason: 'not_found' });
    expect(await buildLawnFastWateringPreview({ serviceId: 'abc', productIds: [P_HERB], knex })).toEqual({ ok: false, reason: 'not_found' });
    expect(calls).toEqual([]);
  });

  test('a malformed lawnAssessmentId is lawn_fast_assessment_required, never a query', async () => {
    const calls = [];
    const knex = uuidStrictKnex(baseTables(), calls);
    const expectedVisit = {
      propertyId: 'prop-1', customerId: CUSTOMER, catalogServiceId: CATALOG, serviceType: 'Lawn Care', scheduledDate: '2026-10-05',
      isCallback: false, address: {}, technicianId: 'tech-1',
    };
    const result = await preflightLawnFastCompletion({ knex, svc: { id: VISIT, customer_id: CUSTOMER }, lawnAssessmentId: 'not-a-uuid', expectedVisit, lawnFast: { visitType: 'recurring' } });
    expect(result).toMatchObject({ status: 400, payload: { code: 'lawn_fast_assessment_required' } });
    expect(calls).not.toContain('lawn_assessments');
  });
});
