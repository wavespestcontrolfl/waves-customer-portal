// Lawn Fast Complete server half: the one eligibility function (every lawn visit
// type, recurring first; the re-service and assessment visit keep their own
// lanes), the context, the watering preview (must equal the report's own
// instruction), and the /complete preflight (gate, eligible visit, confirmed
// assessment; photo floor advisory). Synthetic data; a table-keyed fake knex.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
}));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const { recapVisitIdentityChanged, recapServiceIdentity, RECAP_COMPARED_IDENTITY_KEYS } = require('../services/pest-recap');
const {
  lawnFastIneligibleReason,
  lawnFastVisitType,
  REQUIRED_IDENTITY_KEYS,
  evaluatePhotoFloor,
  buildLawnFastContext,
  buildLawnFastWateringPreview,
  preflightLawnFastCompletion,
  assertLawnFastVisitTypeUnderLock,
} = require('../services/lawn-fast-complete');
const reportData = require('../services/service-report/report-data');
const { resolveWateringRule } = require('../services/service-report/lawn-watering-rule');

// Ids reach uuid columns, so every fixture id is a well-formed uuid.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ASSESSMENT = uuid(2);
const P_HERB = uuid(11);
const P_GRAN = uuid(12);
const P_UN = uuid(13);
const P_MISSING = uuid(14);

const PROFILE = (extra = {}) => ({
  category: 'lawn_care', serviceKey: 'lawn_care_monthly', billingType: 'recurring', findingsType: null,
  projectBacked: false, requiresProject: false, companions: [], ...extra,
});

const visit = (extra = {}) => ({
  id: VISIT, customer_id: 'cust-1', property_id: 'prop-1', service_type: 'Lawn Care',
  service_id: 'cat-1', scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null,
  cust_address_line1: '100 Example Court', cust_city: 'Bradenton', cust_state: 'FL', cust_zip: '34201',
  ...extra,
});

function fakeKnex(tables) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'leftJoin', 'join', 'orderBy', 'select']) chain[m] = () => chain;
    chain.first = async () => {
      if (data instanceof Error) throw data;
      return Array.isArray(data) ? data[0] : data;
    };
    const settle = () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  return knex;
}

const herbicide = {
  id: P_HERB, name: 'Test Weed Spray', category: 'herbicide', product_type: 'pesticide', formulation: 'WG',
  epa_reg_number: '100-1', approved_for_service_report: true,
  post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label' },
};
const granular = {
  id: P_GRAN, name: 'Test Feed Granular', category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular',
  approved_for_service_report: true,
  post_application_watering: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' },
};
const unapproved = { id: P_UN, name: 'Test Unapproved', category: 'fertilizer', formulation: 'granular', approved_for_service_report: false };

describe('lawnFastIneligibleReason: one rule for every lawn visit type', () => {
  const reason = (profile, extra = {}) => lawnFastIneligibleReason({ svc: visit(), profile, ...extra });

  test.each([
    ['recurring program visit', PROFILE()],
    ['recurring, every program key', PROFILE({ serviceKey: 'lawn_care_quarterly' })],
    ['per-application lawn visit', PROFILE({ serviceKey: 'lawn_care_recurring' })],
    ['one-time lawn visit', PROFILE({ serviceKey: 'lawn_care_one_time', billingType: 'one_time' })],
    ['typed one-time lawn treatment', PROFILE({ serviceKey: 'lawn_care_one_time', billingType: 'one_time', findingsType: 'one_time_lawn_treatment' })],
  ])('%s is eligible', (_label, profile) => {
    expect(reason(profile)).toBeNull();
  });

  test.each([
    ['no profile', null, 'profile_unavailable'],
    ['a pest visit', PROFILE({ category: 'pest_control', serviceKey: 'pest_general_quarterly' }), 'not_lawn'],
    ['the lawn re-service (own sheet)', PROFILE({ serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment' }), 'lawn_re_service'],
    ['the Waves Assessment visit (own lane)', PROFILE({ serviceKey: 'lawn_inspection' }), 'assessment_visit'],
    ['a project-backed visit', PROFILE({ projectBacked: true }), 'project_backed'],
    ['a visit requiring a project', PROFILE({ requiresProject: true }), 'project_backed'],
    ['a visit with companion sections', PROFILE({ companions: ['tree_shrub'] }), 'has_companions'],
  ])('%s is refused: %s', (_label, profile, expected) => {
    expect(reason(profile)).toBe(expected);
  });

  test('a grouped stop and an orphaned group pointer take the full form; a dissolved group does not', () => {
    expect(reason(PROFILE(), { hasVisitGroup: true, visitGroupStatus: 'active' })).toBe('grouped_visit');
    expect(reason(PROFILE(), { hasVisitGroup: true, visitGroupStatus: null })).toBe('grouped_visit');
    expect(reason(PROFILE(), { hasVisitGroup: true, visitGroupStatus: 'dissolved' })).toBeNull();
  });

  test.each(['completed', 'cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled'])('status %s is terminal', (status) => {
    expect(lawnFastIneligibleReason({ svc: visit({ status }), profile: PROFILE() })).toBe('terminal_status');
    expect(lawnFastIneligibleReason({ svc: visit({ status }), profile: PROFILE(), allowStatuses: ['completed'] }))
      .toBe(status === 'completed' ? null : 'terminal_status');
  });
});

describe('lawnFastVisitType: decided from the appointment, never the customer plan', () => {
  test.each([
    [PROFILE(), null, false, 'recurring'],
    [PROFILE({ serviceKey: 'lawn_care_recurring' }), 'monthly_membership', false, 'recurring'],
    [PROFILE(), 'per_visit', false, 'recurring'],
    // Most program customers pay per application: their recurring plan visit is a program visit.
    [PROFILE(), 'per_application', false, 'recurring'],
    [PROFILE({ serviceKey: 'lawn_fertilization' }), 'per_application', false, 'per_application'],
    [PROFILE(), 'per_application', true, 'per_application'],
    [PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }), null, false, 'one_time'],
    [PROFILE(), 'one_time', false, 'one_time'],
    [PROFILE({ billingType: null }), null, false, 'other'],
    // A recurring-billed profile whose key is not a recurring lawn plan key is not a program visit.
    [PROFILE({ serviceKey: 'lawn_fertilization' }), null, false, 'other'],
    [PROFILE({ serviceKey: 'lawn_care_one_time' }), null, false, 'other'],
    // A callback is not part of the program; a synthesized profile proves nothing.
    [PROFILE(), null, true, 'other'],
    [PROFILE({ synthesized: true }), null, false, 'other'],
  ])('%#', (profile, mode, callback, expected) => {
    expect(lawnFastVisitType(profile, mode, callback)).toBe(expected);
  });
});

describe('evaluatePhotoFloor is advisory', () => {
  test('a full set meets the floor with no warning', () => {
    const status = evaluatePhotoFloor([{ zone: 'front' }, { zone: 'close_up' }, { zone: 'trouble' }]);
    expect(status).toMatchObject({ soft: true, count: 3, meetsFloor: true, missing: [], warning: null });
  });

  test('a light set warns and names what is missing', () => {
    const status = evaluatePhotoFloor([{ zone: 'front' }]);
    expect(status.meetsFloor).toBe(false);
    expect(status.missing).toEqual(['photos', 'close_up']);
    expect(status.warning).toMatch(/1 of 3 photos/);
  });

  test('photos that failed the quality gate do not count; none at all warns', () => {
    expect(evaluatePhotoFloor([{ zone: 'front', quality_gate_passed: false }]).count).toBe(0);
    expect(evaluatePhotoFloor([]).meetsFloor).toBe(false);
    expect(evaluatePhotoFloor(null).warning).toBeTruthy();
  });

  test('legacy back/side zones count as wide shots', () => {
    expect(evaluatePhotoFloor([{ zone: 'back' }, { zone: 'side' }, { zone: 'trouble' }]).meetsFloor).toBe(true);
  });
});

describe('buildLawnFastContext', () => {
  const savedDefaults = [process.env.GATE_LAWN_COMPLETION_DEFAULTS, process.env.GATE_LAWN_PROPERTY_HISTORY];
  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue(PROFILE());
    buildPlanForService.mockReset();
    delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  });
  afterAll(() => {
    const [a, b] = savedDefaults;
    if (a === undefined) delete process.env.GATE_LAWN_COMPLETION_DEFAULTS; else process.env.GATE_LAWN_COMPLETION_DEFAULTS = a;
    if (b === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY; else process.env.GATE_LAWN_PROPERTY_HISTORY = b;
  });

  const tables = (extra = {}) => ({ scheduled_services: visit(), customers: { billing_mode: null }, ...extra });

  test('a missing visit is not_found', async () => {
    expect(await buildLawnFastContext('nope', { knex: fakeKnex({ scheduled_services: undefined }) })).toEqual({ ok: false, reason: 'not_found' });
  });

  test('an ineligible visit answers eligible:false with the reason and identity, and reads nothing heavier', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ serviceKey: 'lawn_re_service' }));
    const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables()) });
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'lawn_re_service', service: { id: VISIT, serviceKey: 'lawn_re_service' } });
    expect(ctx.plannedProducts).toBeUndefined();
    expect(buildPlanForService).not.toHaveBeenCalled();
  });

  test.each([
    ['recurring', PROFILE(), null, 'recurring'],
    ['per-application', PROFILE({ serviceKey: 'lawn_fertilization' }), 'per_application', 'per_application'],
    ['one-time', PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }), null, 'one_time'],
  ])('a %s lawn visit opens the sheet (no plan: empty planned products, never refused)', async (_label, profile, billingMode, visitType) => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
    const ctx = await buildLawnFastContext(VISIT, {
      knex: fakeKnex(tables({ customers: { billing_mode: billingMode }, lawn_assessments: undefined })),
      technicianId: 'tech-1',
    });
    expect(ctx).toMatchObject({
      ok: true, eligible: true, reason: null, visitType,
      plannedProducts: { source: null, items: [], addOns: [] },
      assessment: { exists: false, id: null, confirmed: false },
      photoStatus: null,
      previousFrontPhoto: null,
    });
    // The methods a product row may take: the lawn re-service sheet's own list,
    // the common three first, each with /complete's sqft verdict.
    expect(ctx.methods).toEqual(require('../services/lawn-reservice-fast-context').lawnMethodChoices());
    expect(ctx.methods.slice(0, 3)).toEqual([
      { value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false },
      { value: 'broadcast_spray', label: 'Broadcast spray', common: true, requiresSqft: true },
      { value: 'granular_broadcast', label: 'Granular broadcast', common: true, requiresSqft: true },
    ]);
    expect(ctx.methods.every((choice) => choice.value !== 'perimeter_spray')).toBe(true);
  });

  test('a typed lawn visit hides the height capture the typed form never renders', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ findingsType: 'one_time_lawn_treatment', billingType: 'one_time' }));
    const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables()), technicianId: 'tech-1' });
    expect(ctx.turfHeightCapture).toBe(false);
  });

  test('turfHeightCapture follows the per-tech flag row on an untyped lawn visit', async () => {
    const TECH = uuid(5);
    const read = (flag) => buildLawnFastContext(VISIT, { knex: fakeKnex(tables({ user_feature_flags: flag })), technicianId: TECH });
    expect((await read({ enabled: true })).turfHeightCapture).toBe(true);
    expect((await read({ enabled: false })).turfHeightCapture).toBe(false);
    expect((await read(undefined)).turfHeightCapture).toBe(false);
    // No technician (or a malformed id): nothing to look up, hidden.
    expect((await buildLawnFastContext(VISIT, { knex: fakeKnex(tables({ user_feature_flags: { enabled: true } })), technicianId: 'tech-1' })).turfHeightCapture).toBe(false);
  });

  test('a recurring program visit carries the planned products with each watering rule', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    buildPlanForService.mockResolvedValue({
      completionDefaults: {
        items: [
          { product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: 2, amountUnit: 'fl oz' } },
          { product: { id: P_GRAN, name: 'Test Feed Granular' }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb' } },
          { product: { id: P_UN, name: 'Test Unapproved' }, applicationMethod: null, mix: {} },
        ],
      },
    });
    const ctx = await buildLawnFastContext(VISIT, {
      knex: fakeKnex(tables({ products_catalog: [herbicide, granular, unapproved] })),
    });
    expect(ctx.plannedProducts.source).toBe('plan');
    const [h, g, u] = ctx.plannedProducts.items;
    expect(h).toMatchObject({ productId: P_HERB, applicationMethod: 'broadcast_spray', amount: 2, amountUnit: 'fl oz', approvedForReport: true });
    expect(h.wateringRule).toEqual(resolveWateringRule(herbicide));
    expect(g.wateringRule).toEqual(resolveWateringRule(granular));
    expect(g.wateringRule.mode).toBe('water_in');
    // Not approved for reports: no frozen facts, so no rule and no claim.
    expect(u).toMatchObject({ approvedForReport: false, wateringRule: null, wateringSummary: 'No watering rule on file' });
    // The catalog row (cost, vendor and all) is never returned.
    expect(JSON.stringify(ctx)).not.toMatch(/epa_reg|post_application_watering/);
  });

  test('a recurring program visit carries the plan\'s opt-in products as add-ons, in the planned items\' shape plus the plan\'s words', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    buildPlanForService.mockResolvedValue({
      completionDefaults: {
        items: [{ product: { id: P_GRAN, name: 'Test Feed Granular' }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb' } }],
        addOns: [
          {
            product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'spot_treatment', raw: '  If sedge: Test Weed Spray ',
            substitution: { originalProductName: 'Celsius WG' },
            gateNotes: [{ key: 'tankMixWith', severity: 'note', text: 'Tank mix with NIS.' }, { key: 'x', text: '' }],
            mix: { amount: 0.4, amountUnit: 'oz', ratePer1000: 0.085, rateUnit: 'oz', treatedSqft: 4000 },
          },
          { product: { name: 'No id' }, mix: {} },
        ],
      },
    });
    const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables({ products_catalog: [herbicide, granular] })) });
    expect(ctx.plannedProducts.items.map((item) => item.productId)).toEqual([P_GRAN]);
    expect(ctx.plannedProducts.addOns).toEqual([expect.objectContaining({
      productId: P_HERB, applicationMethod: 'spot_treatment', amount: 0.4, amountUnit: 'oz', ratePer1000: 0.085, rateUnit: 'oz', treatedSqft: 4000, areaUnit: 'sqft',
      line: 'If sedge: Test Weed Spray', substituteFor: 'Celsius WG', gateNotes: ['Tank mix with NIS.'], approvedForReport: true,
    })]);
    expect(ctx.plannedProducts.month).toBe(10);
  });

  describe('a visit that OFFERS the bermuda removal mix takes the full form, whatever the completion defaults or the visit type say', () => {
    const removal = require('../services/lawn-bermuda-removal');
    let offered;
    beforeEach(() => { offered = jest.spyOn(removal, 'stepOffered'); });
    afterEach(() => offered.mockRestore());
    const ctxFor = (profile, billingMode) => {
      resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
      return buildLawnFastContext(VISIT, { knex: fakeKnex(tables({ customers: { billing_mode: billingMode }, products_catalog: [herbicide, granular] })) });
    };

    test.each([
      ['defaults gate on, property history on, recurring', { GATE_LAWN_COMPLETION_DEFAULTS: 'true', GATE_LAWN_PROPERTY_HISTORY: 'true' }, PROFILE(), 'monthly_membership'],
      ['completion defaults gate OFF', { GATE_LAWN_COMPLETION_DEFAULTS: undefined, GATE_LAWN_PROPERTY_HISTORY: 'true' }, PROFILE(), 'monthly_membership'],
      ['property history gate OFF', { GATE_LAWN_COMPLETION_DEFAULTS: 'true', GATE_LAWN_PROPERTY_HISTORY: undefined }, PROFILE(), 'monthly_membership'],
      ['both gates off', { GATE_LAWN_COMPLETION_DEFAULTS: undefined, GATE_LAWN_PROPERTY_HISTORY: undefined }, PROFILE(), 'monthly_membership'],
      ['a one-time visit', { GATE_LAWN_COMPLETION_DEFAULTS: 'true', GATE_LAWN_PROPERTY_HISTORY: 'true' }, PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }), 'monthly_membership'],
      ['a per-application visit', { GATE_LAWN_COMPLETION_DEFAULTS: 'true', GATE_LAWN_PROPERTY_HISTORY: 'true' }, PROFILE(), 'per_application'],
    ])('%s: offered step gives the bermuda_removal handoff with no plan read', async (_label, env, profile, billingMode) => {
      for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      offered.mockResolvedValue(true);
      buildPlanForService.mockClear();
      const ctx = await ctxFor(profile, billingMode);
      expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'bermuda_removal', needsFullForm: 'Bermuda removal mix this visit: use the full form' });
      expect(ctx.plannedProducts).toBeUndefined();
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test('a read error while checking the step fails closed to the full form, never an eligible sheet', async () => {
      process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
      process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
      offered.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONN' }));
      const ctx = await ctxFor(PROFILE(), 'monthly_membership');
      expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'bermuda_removal' });
    });

    test('no step offered: the sheet works as before, with no needsFullForm anywhere', async () => {
      process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
      process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
      offered.mockResolvedValue(false);
      buildPlanForService.mockResolvedValue({ completionDefaults: { items: [], options: [{ product: { id: P_GRAN, name: 'x' } }] } });
      const plain = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables({ products_catalog: [herbicide, granular] })) });
      expect(plain.eligible).toBe(true);
      expect(JSON.stringify(plain)).not.toMatch(/needsFullForm/);
    });
  });

  describe('program defaults only on a recurring program appointment', () => {
    const PLAN = {
      completionDefaults: {
        items: [{ product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: 2, amountUnit: 'fl oz' } }],
      },
    };
    beforeEach(() => {
      process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
      process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
      // The planner keys the program off the customer, so it returns the recipe for every appointment of a member.
      buildPlanForService.mockResolvedValue(PLAN);
    });
    const ctxFor = (profile, billingMode, visitExtra = {}) => {
      resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
      return buildLawnFastContext(VISIT, {
        knex: fakeKnex(tables({ customers: { billing_mode: billingMode }, scheduled_services: visit(visitExtra), products_catalog: [herbicide] })),
      });
    };

    test('a member\'s one-time appointment starts blank', async () => {
      const ctx = await ctxFor(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }), 'monthly_membership');
      expect(ctx.visitType).toBe('one_time');
      expect(ctx.plannedProducts).toEqual({ source: null, items: [], addOns: [] });
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test("a per-application customer's recurring plan visit is a program visit (the plan is read)", async () => {
      const ctx = await ctxFor(PROFILE(), 'per_application');
      expect(ctx.visitType).toBe('recurring');
      expect(buildPlanForService).toHaveBeenCalled();
    });

    test('a per-application visit under a non-program key starts blank', async () => {
      const ctx = await ctxFor(PROFILE({ serviceKey: 'lawn_fertilization' }), 'per_application');
      expect(ctx.visitType).toBe('per_application');
      expect(ctx.plannedProducts).toEqual({ source: null, items: [], addOns: [] });
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test('a member\'s extra visit under a non-program key, and a callback, start blank', async () => {
      expect((await ctxFor(PROFILE({ serviceKey: 'lawn_fertilization' }), 'monthly_membership')).plannedProducts.items).toEqual([]);
      expect((await ctxFor(PROFILE(), 'monthly_membership', { is_callback: true })).plannedProducts.items).toEqual([]);
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test('a member\'s recurring program visit gets the planned items', async () => {
      const ctx = await ctxFor(PROFILE(), 'monthly_membership');
      expect(ctx.visitType).toBe('recurring');
      expect(ctx.plannedProducts.source).toBe('plan');
      expect(ctx.plannedProducts.items.map((i) => i.productId)).toEqual([P_HERB]);
    });

    test('a non-member recurring visit gets whatever the existing defaults rule gives', async () => {
      buildPlanForService.mockResolvedValue({ completionDefaults: { enabled: false } });
      const ctx = await ctxFor(PROFILE(), null);
      expect(ctx.visitType).toBe('recurring');
      expect(buildPlanForService).toHaveBeenCalledTimes(1);
      expect(ctx.plannedProducts).toEqual({ source: 'plan', items: [], addOns: [], month: 10 });
    });
  });

  test('a failed plan read degrades to an empty list, never blocks opening', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    buildPlanForService.mockRejectedValue(new Error('plan down'));
    const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables()) });
    expect(ctx).toMatchObject({ eligible: true, plannedProducts: { source: null, items: [], addOns: [] } });
  });

  test('an existing confirmed assessment, with the advisory photo status', async () => {
    const ctx = await buildLawnFastContext(VISIT, {
      knex: fakeKnex(tables({
        lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true },
        lawn_assessment_photos: [{ zone: 'front' }, { zone: 'trouble' }],
      })),
    });
    expect(ctx.assessment).toEqual({ exists: true, id: ASSESSMENT, confirmed: true, unusableReason: null, readFailed: false });
    expect(ctx.photoStatus).toMatchObject({ soft: true, count: 2, meetsFloor: false });
    expect(ctx.photoStatus.warning).toMatch(/can still finish/);
  });

  test('an unconfirmed assessment reads confirmed:false', async () => {
    const ctx = await buildLawnFastContext(VISIT, {
      knex: fakeKnex(tables({ lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: false }, lawn_assessment_photos: [] })),
    });
    expect(ctx.assessment).toEqual({ exists: true, id: ASSESSMENT, confirmed: false, unusableReason: null, readFailed: false });
  });
});

// Equality with the report's real entry point lives in lawn-fast-watering-preview-report.test.js;
// these cover the preview's own no-claim, gate and request handling.
describe('buildLawnFastWateringPreview', () => {
  const savedRule = process.env.GATE_LAWN_WATERING_RULE;
  const now = new Date('2026-10-05T14:00:00Z');
  afterEach(() => {
    if (savedRule === undefined) delete process.env.GATE_LAWN_WATERING_RULE; else process.env.GATE_LAWN_WATERING_RULE = savedRule;
  });
  const knexFor = (rows, prefs = null) => fakeKnex({
    scheduled_services: { id: VISIT, customer_id: 'cust-1' },
    products_catalog: rows,
    property_preferences: prefs,
  });
  // What the report does for the same products: frozen facts, then its own
  // instruction builder and banner.
  async function reportBanner(rows, knex) {
    const products = rows.map((row) => ({ product_name: row.name, approved_report_product_facts: reportData.approvedReportProductFacts(row) }));
    const instruction = await reportData.buildReportWateringInstruction({
      products, service: { customer_id: 'cust-1' }, completionTime: now, lawnAssessment: null, knex,
    });
    return reportData.buildWateringBanner(instruction, null);
  }

  test('a hold that reaches the water-in deadline makes no claim, as the report does', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const rows = [herbicide, granular];
    const preview = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: rows.map((r) => r.id), knex: knexFor(rows), now });
    expect(await reportBanner(rows, knexFor(rows))).toBeNull();
    expect(preview.sentence).toBeNull();
  });

  test('a product with no rule on file makes no claim, as the report does', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const rows = [herbicide, unapproved];
    const preview = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: rows.map((r) => r.id), knex: knexFor(rows), now });
    const banner = await reportBanner(rows, knexFor(rows));
    expect(banner).toBeNull();
    expect(preview.lines).toEqual([]);
    expect(preview.sentence).toBeNull();
  });

  test('an unknown product id is an unknown rule, so no claim', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const preview = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [P_HERB, P_MISSING], knex: knexFor([herbicide]), now });
    expect(preview.sentence).toBeNull();
    expect(preview.products[1]).toMatchObject({ productId: P_MISSING, name: null, rule: null });
  });

  test('an uppercase product id finds its row (ids are canonicalized before lookup)', async () => {
    // Postgres returns uuid columns in lowercase; the client may send any case.
    const id = 'abcdef12-0000-4000-8000-0000000000ab';
    const row = { ...herbicide, id };
    const lower = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [id], knex: knexFor([row]), now });
    const upper = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [id.toUpperCase(), id], knex: knexFor([row]), now });
    expect(id.toUpperCase()).not.toBe(id);
    expect(lower.products[0].rule).toEqual(resolveWateringRule(row));
    expect(upper.products).toHaveLength(1);
    expect(upper.products).toEqual(lower.products);
    expect(upper.lines).toEqual(lower.lines);
    expect(upper.sentence).toEqual(lower.sentence);
  });

  test('with GATE_LAWN_WATERING_RULE off the report prints none, so the preview lists rules but no sentence', async () => {
    delete process.env.GATE_LAWN_WATERING_RULE;
    const preview = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [P_HERB], knex: knexFor([herbicide]), now });
    expect(preview).toMatchObject({ ok: true, wateringRuleLive: false, lines: [], sentence: null });
    expect(preview.products[0].rule).toEqual(resolveWateringRule(herbicide));
  });

  test('the response never carries the frozen facts or catalog row', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const preview = await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [P_HERB], knex: knexFor([herbicide]), now });
    expect(Object.keys(preview.products[0]).sort()).toEqual(['approvedForReport', 'mowHoldDays', 'name', 'productId', 'rule', 'ruleSummary']);
  });

  test('bad requests', async () => {
    const knex = knexFor([]);
    expect(await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: P_HERB, knex })).toEqual({ ok: false, reason: 'invalid_product_ids' });
    expect(await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: [1], knex })).toEqual({ ok: false, reason: 'invalid_product_ids' });
    expect(await buildLawnFastWateringPreview({ serviceId: VISIT, productIds: Array.from({ length: 21 }, (_, i) => uuid(100 + i)), knex })).toEqual({ ok: false, reason: 'too_many_products' });
    const noVisit = fakeKnex({ scheduled_services: undefined });
    expect(await buildLawnFastWateringPreview({ serviceId: uuid(99), productIds: [P_HERB], knex: noVisit })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('preflightLawnFastCompletion', () => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  beforeEach(() => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue(PROFILE());
  });
  afterAll(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
  });

  // The full identity the context returns (every compared key; nulls echoed as null).
  const IDENTITY = {
    propertyId: 'prop-1', customerId: 'cust-1', catalogServiceId: 'cat-1', serviceType: 'Lawn Care',
    scheduledDate: '2026-10-05', isCallback: false,
    address: { line1: '100 Example Court', line2: null, city: 'Bradenton', state: 'FL', zip: '34201' },
    technicianId: null,
  };
  const run = (tables, args = {}) => preflightLawnFastCompletion({
    knex: fakeKnex({ scheduled_services: visit(), customers: { billing_mode: null }, ...tables }),
    svc: { id: VISIT, customer_id: 'cust-1' },
    lawnAssessmentId: ASSESSMENT,
    expectedVisit: IDENTITY,
    lawnFast: { visitType: 'recurring' },
    ...args,
  });

  test('gate off: 409 lawn_fast_disabled (terminal for the shared client hook)', async () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    expect(await run({})).toMatchObject({ status: 409, payload: { code: 'lawn_fast_disabled' } });
  });

  test('an ineligible visit: 409 lawn_fast_not_eligible with the reason', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ serviceKey: 'lawn_re_service' }));
    expect(await run({})).toMatchObject({ status: 409, payload: { code: 'lawn_fast_not_eligible', reason: 'lawn_re_service' } });
  });

  test('a missing visit: 404', async () => {
    expect(await run({ scheduled_services: undefined })).toMatchObject({ status: 404 });
  });

  test('no assessment id, or one that is not this visit\'s: 400 lawn_fast_assessment_required', async () => {
    expect(await run({}, { lawnAssessmentId: null })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_assessment_required' } });
    expect(await run({ lawn_assessments: undefined })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_assessment_required' } });
  });

  test('an unconfirmed assessment: 400 lawn_assessment_unconfirmed', async () => {
    expect(await run({ lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: false } }))
      .toMatchObject({ status: 400, payload: { code: 'lawn_assessment_unconfirmed', lawnAssessmentId: ASSESSMENT } });
  });

  test.each([
    ['recurring', PROFILE()],
    ['one-time', PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' })],
  ])('a confirmed assessment on a %s visit passes, even with no photos at all (advisory floor)', async (label, profile) => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
    expect(await run({ lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true }, lawn_assessment_photos: [] }, { lawnFast: { visitType: label === 'one-time' ? 'one_time' : 'recurring' } })).toBeNull();
  });

  // The visit type the sheet opened with, echoed in the lawnFast block and recomputed with
  // the same strict reads. Fixtures: the profile is recurring, the customer's lane is `mode`.
  describe('the visit type the sheet opened with', () => {
    const CONFIRMED = { lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true } };
    const withLane = (mode) => ({ ...CONFIRMED, customers: { billing_mode: mode } });

    test('unchanged recurring is accepted; unchanged one_time is accepted', async () => {
      expect(await run(withLane(null), { lawnFast: { visitType: 'recurring' } })).toBeNull();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      expect(await run(withLane(null), { lawnFast: { visitType: 'one_time' } })).toBeNull();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE());
      expect(await run(withLane('per_application'), { lawnFast: { visitType: 'recurring' } })).toBeNull();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ serviceKey: 'lawn_fertilization' }));
      expect(await run(withLane('per_application'), { lawnFast: { visitType: 'per_application' } })).toBeNull();
    });

    test('the customer moved to one_time after the sheet opened as recurring: refused as a changed visit (terminal)', async () => {
      expect(await run(withLane('one_time'), { lawnFast: { visitType: 'recurring' } }))
        .toMatchObject({ status: 409, payload: { code: 'visit_identity_changed', reason: 'visit_type_changed' } });
    });

    test("the profile's billing type changed after open: refused", async () => {
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      expect(await run(withLane(null), { lawnFast: { visitType: 'recurring' } }))
        .toMatchObject({ status: 409, payload: { code: 'visit_identity_changed', reason: 'visit_type_changed' } });
    });

    test('a sheet that opened with an unknown type is refused: its recipe is never accepted as recurring', async () => {
      expect(await run(withLane(null), { lawnFast: { visitType: 'unknown' } }))
        .toMatchObject({ status: 409, payload: { code: 'visit_identity_changed', reason: 'visit_type_changed' } });
    });

    test('the billing lane cannot be read at submit: 503 retry, never accepted (even if the echo says recurring or unknown)', async () => {
      for (const visitType of ['recurring', 'unknown']) {
        expect(await run({ ...CONFIRMED, customers: new Error('connection lost') }, { lawnFast: { visitType } }))
          .toMatchObject({ status: 503, payload: { code: 'lawn_fast_visit_type_unavailable' } });
      }
    });

    test.each([
      ['no lawnFast object', null],
      ['an empty lawnFast object', {}],
      ['an array', []],
      ['visitType undefined (dropped by JSON)', JSON.parse(JSON.stringify({ visitType: undefined }))],
    ])('%s: 400 lawn_fast_expected_visit_required (correctable)', async (_label, lawnFast) => {
      expect(await run(CONFIRMED, { lawnFast })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_expected_visit_required' } });
    });

    test('a null visitType key is present but never equals a computed type: refused as changed', async () => {
      expect(await run(withLane(null), { lawnFast: { visitType: null } })).toMatchObject({ status: 409, payload: { reason: 'visit_type_changed' } });
    });

    test('the context returns the visitType the sheet must echo', async () => {
      const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex({ scheduled_services: visit(), customers: { billing_mode: 'per_application' } }) });
      expect(ctx.visitType).toBe('recurring');
    });
  });

  // Every reason lawnFastIneligibleReason can return has a defined outcome at
  // submit. Terminal ones are 409 lawn_fast_not_eligible (the tech leaves).
  describe('reason by reason at submit', () => {
    const CONFIRMED = { lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true } };

    test.each([
      ['not_lawn', PROFILE({ category: 'pest_control', serviceKey: 'pest_general_quarterly' }), {}],
      ['lawn_re_service', PROFILE({ serviceKey: 'lawn_re_service' }), {}],
      ['assessment_visit', PROFILE({ serviceKey: 'lawn_inspection' }), {}],
      ['project_backed', PROFILE({ projectBacked: true }), {}],
      ['has_companions', PROFILE({ companions: ['tree_shrub'] }), {}],
      ['grouped_visit', PROFILE(), { scheduled_services: visit({ visit_id: 'grp-1' }), service_visits: { status: 'active' } }],
    ])('%s is refused 409 lawn_fast_not_eligible', async (reason, profile, tables) => {
      resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
      expect(await run({ ...CONFIRMED, ...tables })).toMatchObject({ status: 409, payload: { code: 'lawn_fast_not_eligible', reason } });
    });

    test.each(['cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled'])('terminal_status: a %s visit is refused 409 (terminal, not corrected-and-resubmitted)', async (status) => {
      expect(await run({ ...CONFIRMED, scheduled_services: visit({ status }) }))
        .toMatchObject({ status: 409, payload: { code: 'lawn_fast_not_eligible', reason: 'terminal_status' } });
    });

    test('terminal_status: a completed visit passes the preflight (the main flow answers service_already_completed; replays never reach it)', async () => {
      expect(await run({ ...CONFIRMED, scheduled_services: visit({ status: 'completed' }) })).toBeNull();
    });

    test('profile_unavailable is a 503 retry, not a terminal refusal', async () => {
      resolveCompletionProfileForScheduledService.mockRejectedValue(new Error('db down'));
      expect(await run(CONFIRMED)).toMatchObject({ status: 503, payload: { code: 'completion_profile_lookup_failed' } });
    });

    test('a dissolved group does not block', async () => {
      expect(await run({ ...CONFIRMED, scheduled_services: visit({ visit_id: 'grp-1' }), service_visits: { status: 'dissolved' } })).toBeNull();
    });
  });

  describe('the visit identity the sheet echoes back', () => {
    const CONFIRMED = { lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true } };

    test.each([
      ['none at all', null],
      ['an empty object', {}],
      ['a partial identity', { customerId: 'cust-1' }],
      ['an array', []],
    ])('%s is refused 400 lawn_fast_expected_visit_required', async (_label, expectedVisit) => {
      expect(await run(CONFIRMED, { expectedVisit })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_expected_visit_required' } });
    });

    test('the required keys are everything the locked-row compare uses, plus the technician', () => {
      expect([...REQUIRED_IDENTITY_KEYS].sort()).toEqual([...RECAP_COMPARED_IDENTITY_KEYS, 'technicianId'].sort());
      expect(REQUIRED_IDENTITY_KEYS).toEqual(expect.arrayContaining(['catalogServiceId', 'serviceType', 'isCallback', 'address', 'scheduledDate', 'customerId', 'propertyId', 'technicianId']));
    });

    test.each(REQUIRED_IDENTITY_KEYS)('omitting %s is refused 400 lawn_fast_expected_visit_required', async (key) => {
      const { [key]: _omitted, ...rest } = IDENTITY;
      expect(await run(CONFIRMED, { expectedVisit: rest })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_expected_visit_required' } });
    });

    test('every key present, with nulls where the context has none, is accepted', async () => {
      const nulls = { ...IDENTITY, propertyId: null, catalogServiceId: null, technicianId: null, address: null };
      expect(await run(CONFIRMED, { expectedVisit: nulls })).toBeNull();
    });

    test('a key present but undefined (dropped by JSON) is not an echo', async () => {
      const body = JSON.parse(JSON.stringify({ ...IDENTITY, catalogServiceId: undefined }));
      expect(await run(CONFIRMED, { expectedVisit: body })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_expected_visit_required' } });
    });

    test('every compared key is one recapServiceIdentity returns, so the lists cannot drift', () => {
      const returned = recapServiceIdentity(visit({ is_callback: false }), PROFILE());
      for (const key of RECAP_COMPARED_IDENTITY_KEYS) expect(Object.keys(returned)).toContain(key);
    });

    test("the context's service identity carries the keys the submit must echo, and /complete's compare catches a change", async () => {
      const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex({ scheduled_services: visit({ technician_id: 'tech-1' }), customers: { billing_mode: null } }) });
      const expected = ctx.service;
      expect(expected).toMatchObject({ customerId: 'cust-1', propertyId: 'prop-1', technicianId: 'tech-1' });
      expect(expected.scheduledDate).toBeTruthy();
      for (const key of REQUIRED_IDENTITY_KEYS) expect(key in expected).toBe(true);
      const locked = { customer_id: 'cust-1', property_id: 'prop-1', service_id: 'cat-1', service_type: 'Lawn Care', technician_id: 'tech-1', scheduled_date: '2026-10-05', is_callback: false };
      const customerRow = { address_line1: '100 Example Court', city: 'Bradenton', state: 'FL', zip: '34201' };
      expect(recapVisitIdentityChanged(expected, locked, customerRow)).toBe(false);
      expect(recapVisitIdentityChanged(expected, { ...locked, scheduled_date: '2026-10-12' }, customerRow)).toBe(true);
      expect(recapVisitIdentityChanged(expected, { ...locked, customer_id: 'cust-2' }, customerRow)).toBe(true);
      expect(recapVisitIdentityChanged(expected, { ...locked, technician_id: 'tech-2' }, customerRow)).toBe(true);
      expect(recapVisitIdentityChanged(expected, { ...locked, property_id: 'prop-2' }, customerRow)).toBe(true);
      // The fields a partial echo used to leave unchecked.
      expect(recapVisitIdentityChanged(expected, { ...locked, service_id: 'cat-2' }, customerRow)).toBe(true);
      expect(recapVisitIdentityChanged(expected, { ...locked, service_type: 'Lawn Care Treatment' }, customerRow)).toBe(true);
      expect(recapVisitIdentityChanged(expected, { ...locked, is_callback: true }, customerRow)).toBe(true);
      expect(recapVisitIdentityChanged(expected, locked, { ...customerRow, address_line1: '200 Example Court' })).toBe(true);
      expect(recapVisitIdentityChanged(expected, { ...locked, service_address_line1: '300 Example Court' }, customerRow)).toBe(true);
    });
  });

  test('an incomplete visit is not judged (with the gate on; the gate is checked first, see below)', async () => {
    expect(await run({}, { isIncompleteVisit: true })).toBeNull();
  });
});

describe('an incomplete outcome and the dark gate', () => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
  });
  const incomplete = (args = {}) => preflightLawnFastCompletion({ knex: fakeKnex({}), svc: { id: VISIT, customer_id: 'cust-1' }, isIncompleteVisit: true, lawnFast: {}, ...args });

  test('gate off: ANY /complete carrying lawnFast is refused, an incomplete outcome included', async () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    expect(await incomplete()).toMatchObject({ status: 409, payload: { code: 'lawn_fast_disabled' } });
  });

  test('gate on: an incomplete outcome is exempt from the rest (identity echo, visit type, eligibility, assessment), and reads nothing', async () => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    const knex = fakeKnex({});
    expect(await incomplete({ knex, expectedVisit: null, lawnFast: {} })).toBeNull();
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('assertLawnFastVisitTypeUnderLock (the authority, inside the completion transaction)', () => {
  const lockedSvc = { id: VISIT, customer_id: 'cust-1', is_callback: false, service_id: 'cat-1' };
  const lock = (billingMode, lawnFast = { visitType: 'recurring' }, extra = {}) => assertLawnFastVisitTypeUnderLock({
    trx: extra.trx || {}, lockedCustomer: 'lockedCustomer' in extra ? extra.lockedCustomer : { billing_mode: billingMode }, lockedSvc, lawnFast,
  });
  beforeEach(() => resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue(PROFILE()));

  test('unchanged: passes (recurring, one_time and per_application)', async () => {
    await expect(lock(null)).resolves.toBeUndefined();
    await expect(lock('per_application')).resolves.toBeUndefined();
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ serviceKey: 'lawn_fertilization' }));
    await expect(lock('per_application', { visitType: 'per_application' })).resolves.toBeUndefined();
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
    await expect(lock(null, { visitType: 'one_time' })).resolves.toBeUndefined();
  });

  test('billing_mode changed between the preflight and the transaction: visit_identity_changed / visit_type_changed', async () => {
    await expect(lock('one_time')).rejects.toMatchObject({ code: 'visit_identity_changed', reason: 'visit_type_changed' });
  });

  test('the profile\'s billing type changed: the same abort', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
    await expect(lock(null)).rejects.toMatchObject({ code: 'visit_identity_changed', reason: 'visit_type_changed' });
  });

  test('an echoed unknown (or a non-object echo) is never accepted', async () => {
    await expect(lock(null, { visitType: 'unknown' })).rejects.toMatchObject({ code: 'visit_identity_changed' });
    await expect(lock(null, { visitType: null })).rejects.toMatchObject({ code: 'visit_identity_changed' });
    await expect(lock(null, true)).rejects.toMatchObject({ code: 'visit_identity_changed' });
  });

  test('the profile read fails inside the transaction: aborts retryably (503 class), never passes', async () => {
    resolveCompletionProfileForScheduledService.mockRejectedValue(Object.assign(new Error('connection lost'), { code: '08006' }));
    await expect(lock(null)).rejects.toMatchObject({ code: 'lawn_fast_visit_type_unavailable' });
  });

  test('the strict resolver is used, on the transaction', async () => {
    const trx = { isTransaction: true };
    await lock(null, { visitType: 'recurring' }, { trx });
    expect(resolveCompletionProfileForScheduledService).toHaveBeenCalledWith(lockedSvc, trx, { strict: true });
  });

  test('a locked customer row without billing_mode (column not selected) cannot be judged: aborts retryably', async () => {
    await expect(lock(null, { visitType: 'recurring' }, { lockedCustomer: { first_name: 'Test' } })).rejects.toMatchObject({ code: 'lawn_fast_visit_type_unavailable' });
    await expect(lock(null, { visitType: 'recurring' }, { lockedCustomer: null })).rejects.toMatchObject({ code: 'lawn_fast_visit_type_unavailable' });
  });

  test('no lawnFast block: nothing runs (no query, no profile read)', async () => {
    const trx = jest.fn();
    for (const absent of [null, undefined]) await expect(assertLawnFastVisitTypeUnderLock({ trx, lockedCustomer: { billing_mode: 'per_application' }, lockedSvc, lawnFast: absent })).resolves.toBeUndefined();
    expect(trx).not.toHaveBeenCalled();
    expect(resolveCompletionProfileForScheduledService).not.toHaveBeenCalled();
  });
});

describe('the preflight reasons are ones the shared client hook classifies', () => {
  // client/src/hooks/useFastCompleteSubmit.js completionFailureOutcome and
  // client/src/lib/completion-idempotency.js, restated on the server codes:
  // a 400 is correctable (fresh key), a 409 outside the saved/in-progress/reset
  // codes is terminal.
  const SAVED = new Set(['service_already_completed', 'completion_resume_payload_mismatch']);
  const IN_PROGRESS = new Set(['service_completion_pending', 'completion_pending', 'completion_side_effects_running']);
  const RESET_409 = new Set(['lawn_assessment_stale', 'completion_pricing_changed', 'property_service_area_changed']);
  const outcome = ({ status, code }) => {
    if (status === 409 && SAVED.has(code)) return 'saved';
    if (status >= 400 && status < 500 && (status !== 409 || RESET_409.has(code))) return 'correctable';
    if (!Number.isFinite(status) || status >= 500 || (status === 409 && IN_PROGRESS.has(code))) return 'retry';
    return 'terminal';
  };
  test.each([
    [{ status: 409, code: 'lawn_fast_disabled' }, 'terminal'],
    [{ status: 409, code: 'lawn_fast_not_eligible' }, 'terminal'],
    [{ status: 503, code: 'completion_profile_lookup_failed' }, 'retry'],
    [{ status: 400, code: 'lawn_fast_expected_visit_required' }, 'correctable'],
    [{ status: 409, code: 'visit_identity_changed' }, 'terminal'],
    [{ status: 503, code: 'lawn_fast_visit_type_unavailable' }, 'retry'],
    [{ status: 409, code: 'service_reassigned' }, 'terminal'],
    [{ status: 400, code: 'lawn_fast_assessment_required' }, 'correctable'],
    [{ status: 400, code: 'lawn_assessment_unconfirmed' }, 'correctable'],
  ])('%j is %s', (err, expected) => {
    expect(outcome(err)).toBe(expected);
  });
});
