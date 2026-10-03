// Lawn Fast Complete: an assessment the customer report would reject is not a
// usable confirmed assessment. The report resolves its assessment through the
// property-history resolver (lawn-assessment-history) when GATE_LAWN_PROPERTY_HISTORY
// is on; Fast Complete asks the SAME two resolver calls, so the verdict cannot drift.
// The resolver runs for real here, over an in-memory fake db that serves the joined
// rows it reads. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildLawnFastContext, preflightLawnFastCompletion } = require('../services/lawn-fast-complete');
const history = require('../services/lawn-assessment-history');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ASSESSMENT = uuid(2);
const CATALOG = uuid(3);
const NEW_PROPERTY = uuid(21);
const OLD_PROPERTY = uuid(22);
const CUSTOMER = uuid(30);

const SERVICE_ROW = { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' };
const PROFILE_ROW = {
  service_key: 'lawn_care_monthly', service_name_snapshot: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring',
  completion_mode: 'service_report', project_type: null, companion_types: null, active: true,
};

// The visit's CURRENT property is NEW_PROPERTY unless a case says otherwise.
const visit = (extra = {}) => ({
  id: VISIT, customer_id: CUSTOMER, property_id: NEW_PROPERTY, service_type: 'Lawn Care', service_id: CATALOG,
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null, technician_id: null, ...extra,
});

// The assessment as the resolver reads it (joined with its visit), and as the plain
// lawn_assessments read returns it.
const assessmentRow = (extra = {}) => ({
  id: ASSESSMENT, customer_id: CUSTOMER, service_id: VISIT, confirmed_by_tech: true, property_id: NEW_PROPERTY,
  history_visit_id: VISIT, history_visit_customer_id: CUSTOMER, history_visit_property_id: NEW_PROPERTY,
  history_visit_date: '2026-10-05', service_date: '2026-10-05', created_at: '2026-10-05T12:00:00Z', ...extra,
});

function fakeKnex(tables) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'leftJoin', 'join', 'orderBy', 'select']) chain[m] = () => chain;
    chain.first = async () => (Array.isArray(data) ? data[0] : data);
    const settle = () => Promise.resolve(Array.isArray(data) ? data : []);
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  knex.schema = { hasTable: async () => true };
  return knex;
}

function world({ assessment = {}, visitExtra = {}, properties, prefs = null } = {}) {
  const joined = assessmentRow(assessment);
  return fakeKnex({
    scheduled_services: visit(visitExtra),
    services: SERVICE_ROW,
    service_completion_profiles: PROFILE_ROW,
    customers: { billing_mode: null },
    lawn_assessments: joined,
    'lawn_assessments as la': [joined],
    lawn_assessment_photos: [],
    customer_properties: properties || [{ id: NEW_PROPERTY, customer_id: CUSTOMER, active: true, is_primary: true, address_line1: '100 Example Court' }],
    property_preferences: prefs,
    lawn_baseline_resets: [],
  });
}

const EXPECTED_VISIT = {
  propertyId: NEW_PROPERTY, customerId: CUSTOMER, catalogServiceId: CATALOG, serviceType: 'Lawn Care',
  scheduledDate: '2026-10-05', isCallback: false, address: {}, technicianId: null,
};
const preflight = (knex) => preflightLawnFastCompletion({ knex, svc: { id: VISIT, customer_id: CUSTOMER }, lawnAssessmentId: ASSESSMENT, expectedVisit: EXPECTED_VISIT, lawnFast: { visitType: 'recurring' } });
const context = (knex) => buildLawnFastContext(VISIT, { knex });

const saved = process.env.GATE_LAWN_PROPERTY_HISTORY;
const savedFast = process.env.GATE_LAWN_FAST_COMPLETE;
beforeEach(() => {
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  process.env.GATE_LAWN_FAST_COMPLETE = 'true';
});
afterAll(() => {
  if (saved === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY; else process.env.GATE_LAWN_PROPERTY_HISTORY = saved;
  if (savedFast === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedFast;
});

// Each case: what the report's resolver decides, and that context and submit agree.
const FORMER = { assessment: { property_id: OLD_PROPERTY } };
describe('property scope, decided by the report resolver', () => {
  test('the same property: usable (context confirmed, submit accepted)', async () => {
    const knex = world();
    expect((await context(knex)).assessment).toMatchObject({ confirmed: true, unusableReason: null });
    expect(await preflight(knex)).toBeNull();
  });

  test('captured for the visit\'s FORMER property: not usable (context unconfirmed with a reason, submit refused)', async () => {
    const knex = world(FORMER);
    expect((await context(knex)).assessment).toMatchObject({ exists: true, confirmed: false, unusableReason: 'property_scope' });
    expect(await preflight(knex)).toMatchObject({ status: 400, payload: { code: 'lawn_fast_assessment_required', reason: 'property_scope' } });
  });

  test('the resolver itself rejects the former-property row (the rule is reused, not re-implemented)', async () => {
    const knex = world(FORMER);
    expect(await history.installedForVisit({ customerId: CUSTOMER, serviceId: VISIT }, knex)).toBeNull();
    const ok = world();
    expect((await history.installedForVisit({ customerId: CUSTOMER, serviceId: VISIT }, ok)).id).toBe(ASSESSMENT);
  });

  test('the assessment has no property yet (completion stamps it): usable', async () => {
    const knex = world({ assessment: { property_id: null } });
    expect((await context(knex)).assessment.confirmed).toBe(true);
    expect(await preflight(knex)).toBeNull();
  });

  test('NULL property on both sides, a customer with one active property: usable', async () => {
    const knex = world({ assessment: { property_id: null, history_visit_property_id: null }, visitExtra: { property_id: null } });
    expect((await context(knex)).assessment.confirmed).toBe(true);
    expect(await preflight(knex)).toBeNull();
  });

  test('NULL property on both sides, two active properties: the resolver still installs the unscoped row', async () => {
    const properties = [
      { id: NEW_PROPERTY, customer_id: CUSTOMER, active: true, is_primary: true, address_line1: '100 Example Court' },
      { id: OLD_PROPERTY, customer_id: CUSTOMER, active: true, is_primary: false, address_line1: '200 Example Court' },
    ];
    const knex = world({ assessment: { property_id: null, history_visit_property_id: null }, visitExtra: { property_id: null }, properties });
    const resolved = await history.historyForAssessment(assessmentRow({ property_id: null, history_visit_property_id: null }), { knex });
    const expected = !!resolved.current && resolved.current.id === ASSESSMENT;
    expect((await context(knex)).assessment.confirmed).toBe(expected);
    expect(await preflight(knex)).toEqual(expected ? null : expect.objectContaining({ status: 400 }));
  });

  test('the visit moved to another property and the assessment was stamped on the old one: refused even with one active property', async () => {
    const properties = [{ id: NEW_PROPERTY, customer_id: CUSTOMER, active: true, is_primary: true, address_line1: '100 Example Court' }];
    const knex = world({ ...FORMER, properties });
    expect(await preflight(knex)).toMatchObject({ status: 400, payload: { reason: 'property_scope' } });
  });

  test('an UNCONFIRMED assessment is reported unconfirmed (no property verdict applies)', async () => {
    const knex = world({ assessment: { confirmed_by_tech: false } });
    expect((await context(knex)).assessment).toMatchObject({ confirmed: false, unusableReason: null });
  });

  test('GATE_LAWN_PROPERTY_HISTORY off: the report does no property check, and neither does this', async () => {
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    const knex = world(FORMER);
    expect((await context(knex)).assessment).toMatchObject({ confirmed: true, unusableReason: null });
    expect(await preflight(knex)).toBeNull();
  });

  test('a failed property check is not a pass: the context reads unusable, the submit throws', async () => {
    const knex = world();
    const failing = jest.fn((table) => {
      if (table === 'lawn_assessments as la') throw Object.assign(new Error('connection lost'), { code: '08006' });
      return knex(table);
    });
    failing.raw = knex.raw;
    failing.schema = knex.schema;
    const ctx = await context(failing);
    expect(ctx.assessment).toMatchObject({ confirmed: false, unusableReason: 'property_check_failed' });
    expect(ctx.readFailures).toContain('assessment_property_check');
    await expect(preflight(failing)).rejects.toThrow('connection lost');
  });
});
