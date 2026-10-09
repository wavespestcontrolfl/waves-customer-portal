// Lawn Fast Complete server half: the one eligibility function (every lawn visit
// type, recurring first; the re-service and assessment visit keep their own
// lanes), the context, the watering preview (must equal the report's own
// instruction), and the /complete preflight (gate, eligible visit, confirmed
// assessment; photo floor advisory). Synthetic data; a table-keyed fake knex.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
}));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn(), v13VisitLimits: jest.fn(), v13ProtocolRows: jest.fn(() => new Map()), v13GateNotes: jest.fn(() => []) }));
jest.mock('../services/property-coordinates', () => ({ resolvePropertyCoordinates: jest.fn() }));
jest.mock('../services/fawn-weather', () => ({ getCurrent: jest.fn() }));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { buildPlanForService, v13VisitLimits, v13ProtocolRows, v13GateNotes } = require('../services/waveguard-plan-engine');
const { resolvePropertyCoordinates } = require('../services/property-coordinates');
const { getCurrent } = require('../services/fawn-weather');
const { recapVisitIdentityChanged, recapServiceIdentity, RECAP_COMPARED_IDENTITY_KEYS } = require('../services/pest-recap');
const {
  lawnFastIneligibleReason,
  lawnFastVisitType,
  REQUIRED_IDENTITY_KEYS,
  evaluatePhotoFloor,
  buildLawnFastContext,
  buildLawnFastWateringPreview,
  buildLawnTreatmentGuide,
  takeAllProductIdsFor,
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
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNotNull', 'whereRaw', 'leftJoin', 'join', 'orderBy', 'orderByRaw', 'select']) chain[m] = () => chain;
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

  describe('weed spot rules (GATE_LAWN_SPOT_RULES)', () => {
    const P_LEAD = uuid(21);
    const P_SURF = uuid(22);
    const P_BLIND = uuid(23);
    const row = (id, name, gates, extra = {}) => ({ product: { id, name }, applicationMethod: 'spot_treatment', mix: {}, gates, ...extra });
    const PLAN = () => ({
      protocol: { structured: { products: [] } },
      completionDefaults: {
        items: [],
        addOns: [
          row(P_LEAD, 'Test Lead WG', { annualCounter: 'x' }),
          row(P_SURF, 'Test Surfactant', { concentration: '0.25% v/v', tankMixWith: 'Test Lead WG' }),
          row(P_BLIND, 'Test Blind Herbicide', { trigger: 'celsius_annual_cap_reached' }),
        ],
      },
    });
    const read = () => buildLawnFastContext(VISIT, { knex: fakeKnex({ scheduled_services: visit(), customers: { billing_mode: null }, products_catalog: [herbicide] }) });
    beforeEach(() => {
      process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
      process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
      buildPlanForService.mockResolvedValue(PLAN());
      v13VisitLimits.mockReset().mockResolvedValue({ capped: new Map(), warnings: [], blocks: [] });
      resolvePropertyCoordinates.mockReset().mockResolvedValue({ latitude: 27.4, longitude: -82.5 });
      getCurrent.mockReset().mockResolvedValue({ temp_f: 82, station: 'Test Station', timestamp: new Date().toISOString(), observation_time: new Date().toISOString() });
    });
    afterEach(() => { delete process.env.GATE_LAWN_SPOT_RULES; });

    test('gate off: the payload carries neither weedMix nor spotRules, and nothing is read', async () => {
      const ctx = await read();
      expect('weedMix' in ctx.plannedProducts).toBe(false);
      expect('spotRules' in ctx).toBe(false);
      expect(ctx.plannedProducts.addOns.map((a) => a.productId)).toEqual([P_LEAD, P_SURF, P_BLIND]);
      expect(v13VisitLimits).not.toHaveBeenCalled();
      expect(getCurrent).not.toHaveBeenCalled();
    });

    test('gate on: weedMix in plannedProducts and spotRules on the context; the add-ons list is unchanged', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      const ctx = await read();
      expect(ctx.spotRules).toBe(true);
      expect(ctx.plannedProducts.weedMix).toMatchObject({
        mode: 'lead', productIds: [P_LEAD, P_SURF], groupProductIds: [P_LEAD, P_SURF, P_BLIND], replacementProductId: P_BLIND,
        surfactant: { productId: P_SURF, included: true, note: null }, noAreaProductIds: [P_SURF], tempF: 82,
      });
      expect(ctx.plannedProducts.addOns.map((a) => a.productId)).toEqual([P_LEAD, P_SURF, P_BLIND]);
    });

    test('gate on, lead at its cap: the replacement mode, no weather read', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      v13VisitLimits.mockResolvedValue({ capped: new Map([[P_LEAD, [{ type: 'annual_max_apps', message: 'limit' }]]]), warnings: [], blocks: [] });
      const ctx = await read();
      expect(ctx.plannedProducts.weedMix).toMatchObject({ mode: 'replacement', productIds: [P_BLIND] });
      expect(getCurrent).not.toHaveBeenCalled();
    });

    describe("a spot add-on carries the program's approved rate (the staged protocol row's)", () => {
      const ROWS = new Map([
        [P_LEAD, { productId: P_LEAD, ratePer1000: '0.085', rateUnit: 'oz', gates: { annualCounter: 'x' } }],
        [P_SURF, { productId: P_SURF, ratePer1000: null, rateUnit: 'label_rate', gates: { concentration: '0.25% v/v' } }],
        [P_BLIND, { productId: P_BLIND, ratePer1000: null, rateUnit: 'label_rate', gates: {} }],
      ]);
      beforeEach(() => v13ProtocolRows.mockReset().mockReturnValue(ROWS));
      const rateOf = (ctx, id) => ctx.plannedProducts.addOns.find((a) => a.productId === id);

      test('gate on: the row\'s rate and unit ride the add-on; a row with no rate or a concentration carries none', async () => {
        process.env.GATE_LAWN_SPOT_RULES = 'true';
        const ctx = await read();
        expect(rateOf(ctx, P_LEAD)).toMatchObject({ ratePer1000: 0.085, rateUnit: 'oz' });
        expect(rateOf(ctx, P_SURF)).toMatchObject({ ratePer1000: null, rateUnit: null });
        expect(rateOf(ctx, P_BLIND)).toMatchObject({ ratePer1000: null, rateUnit: null });
        expect(v13ProtocolRows).toHaveBeenCalledWith({ products: [] });
      });

      test('a rate the plan itself gave is kept', async () => {
        process.env.GATE_LAWN_SPOT_RULES = 'true';
        const plan = PLAN();
        plan.completionDefaults.addOns[0].mix = { ratePer1000: 0.1, rateUnit: 'fl oz', amount: 1, amountUnit: 'fl oz' };
        buildPlanForService.mockResolvedValue(plan);
        expect(rateOf(await read(), P_LEAD)).toMatchObject({ ratePer1000: 0.1, rateUnit: 'fl oz' });
      });

      test('gate off: the protocol rows are not read and the add-on carries no rate', async () => {
        const ctx = await read();
        expect(rateOf(ctx, P_LEAD)).toMatchObject({ ratePer1000: null, rateUnit: null });
        expect(v13ProtocolRows).not.toHaveBeenCalled();
      });
    });

    describe('places and trouble areas (GATE_LAWN_TROUBLE_AREAS)', () => {
      const KNOWN = { id: uuid(31), place: 'back', type: 'fungus', last_treated_on: '2026-09-12', last_seen_on: '2026-09-12' };
      const readWith = (extraTables = {}) => buildLawnFastContext(VISIT, {
        knex: fakeKnex({ scheduled_services: visit({ property_id: uuid(40) }), customers: { billing_mode: null }, products_catalog: [herbicide], lawn_trouble_areas: [KNOWN], ...extraTables }),
      });
      // The lead is at its yearly count at the front only; everywhere else it is open.
      const leadCappedAtFront = () => v13VisitLimits.mockImplementation(async (knex, svcRow, items, rows, targets, options) => ({
        capped: options?.place === 'front' || !options?.place ? new Map([[P_LEAD, [{ type: 'annual_max_apps', message: 'Lead: 2/2 applications this year — LIMIT REACHED.' }]]]) : new Map(),
        warnings: [], blocks: [],
      }));
      beforeEach(() => { process.env.GATE_LAWN_SPOT_RULES = 'true'; process.env.GATE_LAWN_V13 = 'true'; });
      afterEach(() => { delete process.env.GATE_LAWN_TROUBLE_AREAS; delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_TREATMENT_GUIDE; });

      test('gate off (spot rules on): no troubleAreas, no byPlace, and the limits are read once per product as before', async () => {
        const ctx = await readWith();
        expect('troubleAreas' in ctx).toBe(false);
        expect('byPlace' in ctx.plannedProducts.weedMix).toBe(false);
        expect(v13VisitLimits.mock.calls.every((call) => call.length === 5)).toBe(true);
      });

      test('gate on, nothing capped: the closed list, the known areas, no closed place, and every place takes the lawn-wide mix', async () => {
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
        const ctx = await readWith();
        expect(ctx.troubleAreas).toEqual({
          v: 1,
          places: [{ id: 'front', label: 'Front' }, { id: 'back', label: 'Back' }, { id: 'left_side', label: 'Left side' }, { id: 'right_side', label: 'Right side' }],
          known: [{ id: KNOWN.id, place: 'back', placeLabel: 'Back', type: 'fungus', typeLabel: 'Fungus', lastTreatedOn: '2026-09-12' }],
          knownUnavailable: false,
          blocked: {},
          blockedTypes: {},
        });
        expect(Object.keys(ctx.plannedProducts.weedMix.byPlace)).toEqual(['front', 'back', 'left_side', 'right_side']);
        expect(ctx.plannedProducts.weedMix.byPlace.front).toMatchObject({ mode: 'lead', productIds: [P_LEAD, P_SURF] });
        // Nothing was capped lawn-wide, so no place was read again.
        expect(v13VisitLimits.mock.calls.every((call) => !call[5])).toBe(true);
      });

      test('gate on, the lead capped at the front only: the front takes the replacement, the others the lead; the top level follows the first place that can take the lead', async () => {
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
        leadCappedAtFront();
        const mix = (await readWith()).plannedProducts.weedMix;
        expect(mix.byPlace.front).toMatchObject({ mode: 'replacement', productIds: [P_BLIND] });
        expect(mix.byPlace.back).toMatchObject({ mode: 'lead', productIds: [P_LEAD, P_SURF] });
        expect(mix).toMatchObject({ mode: 'lead', productIds: [P_LEAD, P_SURF] });
      });

      test('gate on: the temperature is read once however many places are judged', async () => {
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
        leadCappedAtFront();
        await readWith();
        expect(getCurrent).toHaveBeenCalledTimes(1);
      });

      test('the gate needs the spot rules and the v13 program: without either, nothing changes', async () => {
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
        delete process.env.GATE_LAWN_V13;
        expect('troubleAreas' in (await readWith())).toBe(false);
      });

      test('a failed read of the known areas is named and sends an empty line, never invented areas', async () => {
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
        const ctx = await readWith({ lawn_trouble_areas: new Error('synthetic read failure') });
        expect(ctx.troubleAreas).toMatchObject({ known: [], knownUnavailable: true });
        expect(ctx.readFailures).toContain('trouble_areas');
      });

      test('a visit with no plan (one-time) still carries the places, with nothing closed', async () => {
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
        resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
        const ctx = await readWith();
        expect(ctx.troubleAreas).toMatchObject({ v: 1, blocked: {} });
        expect(ctx.troubleAreas.places).toHaveLength(4);
      });
    });

    test('gate on, a visit with no plan (one-time): spotRules only, no weedMix', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      const ctx = await read();
      expect(ctx.spotRules).toBe(true);
      expect('weedMix' in ctx.plannedProducts).toBe(false);
    });

    test('gate on, no weed group in the window: no weedMix', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      buildPlanForService.mockResolvedValue({ protocol: { structured: {} }, completionDefaults: { items: [], addOns: [row(P_BLIND, 'Test Blind Herbicide', { trigger: 'celsius_annual_cap_reached' })] } });
      const ctx = await read();
      expect('weedMix' in ctx.plannedProducts).toBe(false);
      expect(ctx.spotRules).toBe(true);
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
// The "Suggested from this lawn" cards (GATE_LAWN_TREATMENT_GUIDE, owner 2026-10-08): the context
// offers the standing chinch bug tap, and the treatment-guide read answers the cards for the
// visit's confirmed assessment. The plan engine and the staged rows are faked.
describe('treatment guide (GATE_LAWN_TREATMENT_GUIDE)', () => {
  const P_LEAD = uuid(41);
  const P_CERT = uuid(42);
  const P_ART = uuid(43);
  const P_ACE = uuid(44);
  const P_DISP = uuid(45);
  const P_ARENA = uuid(46);
  const P_TALAK = uuid(47);
  const CONFIRMED = uuid(48);
  const GATES = ['GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13', 'GATE_LAWN_TREATMENT_GUIDE'];
  const row = (id, name, gates, extra = {}) => ({ product: { id, name }, applicationMethod: 'spot_treatment', mix: {}, gates, ...extra });
  const addOns = () => [
    row(P_LEAD, 'Test Lead WG', { annualCounter: 'x' }, { raw: 'Test Lead WG — weed spots' }),
    row(P_CERT, 'Test Cert Herbicide', { tankMixWith: 'Test Lead WG' }),
    row(P_ART, 'Test Artavia', {}, { raw: 'Test Artavia — mapped large patch' }),
    row(P_ACE, 'Test Acelepryn', {}, { raw: 'Test Acelepryn — caterpillars' }),
    row(P_DISP, 'Test Dispatch', {}),
  ];
  const plan = (list = addOns(), eligible = true) => ({ protocol: { structured: { id: 'protocol-1', products: [] } }, completionDefaults: { eligible, items: [], addOns: eligible ? list : [] } });
  const PROGRAM = new Map([
    [P_LEAD, { productId: P_LEAD, role: 'post_emergent_spot', gates: { annualCounter: 'x' } }],
    [P_ART, { productId: P_ART, role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } }],
    [P_ACE, { productId: P_ACE, role: 'insecticide_spot', gates: { trigger: 'caterpillars' } }],
    [P_DISP, { productId: P_DISP, role: 'wetting_agent_spot', gates: { trigger: 'dry_spots' } }],
  ]);
  const staged = (productId, name, trigger, month) => ({
    product_id: productId, product_name: name, gates: { trigger }, rate_per_1000: null, rate_unit: 'label_rate', sort_order: 4, month,
    catalog_id: productId, catalog_name: name, catalog_active: true,
  });
  const STAGED = () => [staged(P_ARENA, 'Test Arena', 'chinch_20_to_25_per_sqft', 4), staged(P_TALAK, 'Test Talak', 'chinch_second_product_or_caterpillars', 7)];
  const assessmentRow = (extra = {}) => ({
    id: CONFIRMED, service_id: VISIT, customer_id: 'cust-1', confirmed_by_tech: true, weed_suppression: 100, composite_scores: { drought_stress: 'none' }, ...extra,
  });
  const run = (severities = {}) => ({ severities: { fungal_activity: { level: 'none' }, insect_damage: { level: 'none' }, drought_stress: { level: 'none' }, ...severities } });
  const tablesFor = (extra = {}) => ({
    scheduled_services: visit({ scheduled_date: '2026-07-14' }), customers: { billing_mode: null }, products_catalog: [herbicide],
    'lawn_protocol_products as lpp': STAGED(), lawn_assessments: assessmentRow(), lawn_assessment_runs: run(), ...extra,
  });
  const capsFor = (entries) => v13VisitLimits.mockImplementation(async (_k, _s, items) => ({
    capped: new Map(items.filter((i) => entries[i.product.id]).map((i) => [i.product.id, entries[i.product.id]])), warnings: [], blocks: [],
  }));
  const YEARLY = [{ type: 'annual_max_apps', message: 'limit' }];
  const saved = {};
  const context = (tables) => buildLawnFastContext(VISIT, { knex: fakeKnex(tables) });
  const guide = (tables, assessmentId = CONFIRMED) => buildLawnTreatmentGuide({ serviceId: VISIT, assessmentId, knex: fakeKnex(tables) });
  const live = () => { for (const name of GATES) process.env[name] = 'true'; };

  beforeEach(() => {
    for (const name of GATES) { saved[name] = process.env[name]; delete process.env[name]; }
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue(PROFILE());
    buildPlanForService.mockReset().mockResolvedValue(plan());
    v13ProtocolRows.mockReset().mockReturnValue(PROGRAM);
    v13VisitLimits.mockReset().mockResolvedValue({ capped: new Map(), warnings: [], blocks: [] });
    v13GateNotes.mockReset().mockReturnValue([]);
    resolvePropertyCoordinates.mockReset().mockResolvedValue({ latitude: 27.4, longitude: -82.5 });
    getCurrent.mockReset().mockResolvedValue({ temp_f: 82, station: 'Test Station', timestamp: new Date().toISOString(), observation_time: new Date().toISOString() });
    const history = require('../services/lawn-assessment-history');
    jest.spyOn(history, 'installedForVisit').mockResolvedValue({ id: CONFIRMED });
    jest.spyOn(history, 'historyForAssessment').mockResolvedValue({ current: { id: CONFIRMED } });
  });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    jest.restoreAllMocks();
  });

  describe('the context', () => {
    test('gate off: the payload is the old one, and no chinch product is looked up', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      const ctx = await context(tablesFor());
      expect('treatmentGuide' in ctx).toBe(false);
      expect('spotTargets' in ctx).toBe(false);
      expect('chinch' in ctx.plannedProducts).toBe(false);
      expect(v13VisitLimits).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.arrayContaining([expect.objectContaining({ product: expect.objectContaining({ id: P_ARENA }) })]), expect.anything(), expect.anything());
    });

    test('the guide gate alone (spot rules off) is off', async () => {
      process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
      const ctx = await context(tablesFor());
      expect('treatmentGuide' in ctx).toBe(false);
      expect('chinch' in ctx.plannedProducts).toBe(false);
    });

    test('the v13 program off (fail closed): the guide is off even with the guide and spot-rules gates on', async () => {
      live();
      delete process.env.GATE_LAWN_V13;
      const ctx = await context(tablesFor());
      expect('treatmentGuide' in ctx).toBe(false);
      expect('chinch' in ctx.plannedProducts).toBe(false);
      expect(await guide(tablesFor())).toEqual({ ok: false, reason: 'disabled' });
    });

    test('gate on: treatmentGuide, and Arena built from the staged row when the month does not hold it', async () => {
      live();
      const ctx = await context(tablesFor());
      expect(ctx.treatmentGuide).toBe(true);
      expect(ctx.spotTargets).toMatchObject({ v: 1, chinch: 'Southern chinch bugs', takeAll: 'Take-all root rot' });
      expect(ctx.plannedProducts.chinch).toEqual({
        item: expect.objectContaining({
          productId: P_ARENA, name: 'Test Arena', applicationMethod: 'spot_treatment', amount: null, treatedSqft: null, ratePer1000: null, rateUnit: null, line: null, gateNotes: [],
        }),
        note: null,
        // Both rungs are governed by the guide, offered or not.
        rungIds: [P_ARENA, P_TALAK],
        blockedIds: [],
        unreadableIds: [],
      });
      expect(ctx.plannedProducts.addOns.map((a) => a.productId)).toEqual([P_LEAD, P_CERT, P_ART, P_ACE, P_DISP]);
    });

    test('the weed mix whose limits could not be read carries the guide wording only while the guide is live', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      v13VisitLimits.mockRejectedValue(new Error('db down'));
      // Guide off: the merged spot-rules note stands.
      expect((await context(tablesFor())).plannedProducts.weedMix).toMatchObject({ mode: 'unavailable', note: 'The weed-spray limits could not be checked. Use Other product for what you sprayed.' });
      live();
      expect((await context(tablesFor())).plannedProducts.weedMix).toMatchObject({ mode: 'unavailable', note: 'The limits could not be checked. Use Search products for what you applied; the office will review it.' });
    });

    test('the add-ons a card may own are named, so the sheet holds their taps until the fresh guide answers', async () => {
      live();
      expect((await context(tablesFor())).plannedProducts.guidedProductIds).toEqual([P_ART, P_ACE, P_DISP]);
      buildPlanForService.mockResolvedValue(plan(addOns(), false));
      expect('guidedProductIds' in (await context(tablesFor())).plannedProducts).toBe(false);
      for (const name of ['GATE_LAWN_TREATMENT_GUIDE']) delete process.env[name];
      buildPlanForService.mockResolvedValue(plan());
      expect('guidedProductIds' in (await context(tablesFor())).plannedProducts).toBe(false);
    });

    test('lawnReportTies (the sheet records the standing chinch tap as a find) exists only while the report ties are live', async () => {
      const TIE_GATES = ['GATE_LAWN_REPORT_FACTS', 'GATE_LAWN_VISIT_SUMMARY_V2', 'GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
      try {
        live();
        expect('lawnReportTies' in (await context(tablesFor()))).toBe(false);
        for (const name of TIE_GATES.slice(0, 3)) process.env[name] = 'true';
        expect('lawnReportTies' in (await context(tablesFor()))).toBe(false);
        process.env.GATE_LAWN_REPORT_LEAD = 'true';
        expect((await context(tablesFor())).lawnReportTies).toBe(true);
        delete process.env.GATE_LAWN_REPORT_FACTS;
        expect('lawnReportTies' in (await context(tablesFor()))).toBe(false);
      } finally {
        for (const name of TIE_GATES) delete process.env[name];
      }
    });

    test('lawnReportFacts (the sheet names the spot rows whose area it recorded) exists only while GATE_LAWN_REPORT_FACTS is live', async () => {
      try {
        live();
        expect('lawnReportFacts' in (await context(tablesFor()))).toBe(false);
        process.env.GATE_LAWN_REPORT_FACTS = 'true';
        expect((await context(tablesFor())).lawnReportFacts).toBe(true);
      } finally {
        delete process.env.GATE_LAWN_REPORT_FACTS;
      }
    });

    test('the month\'s take-all fungicide rows are named, a pick or not; with the guide off or no take-all row the key says so', async () => {
      live();
      expect((await context(tablesFor())).plannedProducts.takeAllProductIds).toEqual([]);
      const takeAllPlan = plan(addOns());
      takeAllPlan.completionDefaults.addOns[2].raw = 'Test Artavia — mapped take-all areas, second spring application';
      buildPlanForService.mockResolvedValue(takeAllPlan);
      v13ProtocolRows.mockReturnValue(new Map([...PROGRAM, [P_ART, { productId: P_ART, role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_2' } }]]));
      expect((await context(tablesFor())).plannedProducts.takeAllProductIds).toEqual([P_ART]);
      delete process.env.GATE_LAWN_TREATMENT_GUIDE;
      expect('takeAllProductIds' in (await context(tablesFor())).plannedProducts).toBe(false);
    });

    test('the staged row\'s gate notes ride an off-plan chinch product', async () => {
      live();
      v13GateNotes.mockReturnValue([{ key: 'delayWateringHours', severity: 'note', text: 'Delay watering for 24 hours.' }]);
      const ctx = await context(tablesFor());
      expect(ctx.plannedProducts.chinch.item.gateNotes).toEqual(['Delay watering for 24 hours.']);
      expect(v13GateNotes).toHaveBeenCalledWith({ trigger: 'chinch_20_to_25_per_sqft' }, { monthNumber: 7 });
    });

    test('Arena at its yearly cap: the bifenthrin product, and the note says so', async () => {
      live();
      capsFor({ [P_ARENA]: YEARLY });
      const ctx = await context(tablesFor());
      expect(ctx.plannedProducts.chinch).toMatchObject({ item: { productId: P_TALAK, name: 'Test Talak' }, note: 'Test yearly limit reached; Test is used in its place.' });
    });

    test('both at their cap: a line and no product', async () => {
      live();
      capsFor({ [P_ARENA]: YEARLY, [P_TALAK]: YEARLY });
      expect((await context(tablesFor())).plannedProducts.chinch).toEqual({ item: null, note: 'The yearly limit is reached for the chinch bug products on this lawn.', rungIds: [P_ARENA, P_TALAK], blockedIds: [P_ARENA, P_TALAK], unreadableIds: [] });
    });

    test('a product the month\'s plan holds is the plan\'s own add-on', async () => {
      live();
      buildPlanForService.mockResolvedValue(plan([...addOns(), row(P_ARENA, 'Test Arena', {}, { raw: 'Test Arena — chinch bugs at 20 to 25 per sq ft' })]));
      const ctx = await context(tablesFor());
      expect(ctx.plannedProducts.chinch.item).toMatchObject({ productId: P_ARENA, line: 'Test Arena — chinch bugs at 20 to 25 per sq ft' });
    });

    test('an ineligible plan offers no chinch product: nothing from the staged rows, nothing read', async () => {
      live();
      buildPlanForService.mockResolvedValue(plan(addOns(), false));
      const ctx = await context(tablesFor());
      // The plan is read and offers nothing (no program applies, the profile does not match, the
      // protocol is not the visit's): no chinch key, and the staged rows are not looked at.
      expect(ctx.plannedProducts).toMatchObject({ source: 'plan', items: [], addOns: [] });
      expect('chinch' in ctx.plannedProducts).toBe(false);
      expect(v13VisitLimits).not.toHaveBeenCalled();
      // A plan that does not say it is eligible reads as not eligible (fail closed).
      const bare = plan();
      delete bare.completionDefaults.eligible;
      buildPlanForService.mockResolvedValue(bare);
      expect('chinch' in (await context(tablesFor())).plannedProducts).toBe(false);
    });

    test('(1) no chinch row staged: no chinch key, and the guide is still on (a real "nothing to offer")', async () => {
      live();
      const ctx = await context(tablesFor({ 'lawn_protocol_products as lpp': [] }));
      expect('chinch' in ctx.plannedProducts).toBe(false);
      expect(ctx.treatmentGuide).toBe(true);
      expect(ctx.readFailures).not.toContain('treatment_guide');
    });

    test.each([
      ['(2) the staged lookup threw', () => tablesFor({ 'lawn_protocol_products as lpp': new Error('rows down') })],
      ['the chinch item could not be built', () => { v13GateNotes.mockImplementation(() => { throw new Error('notes down'); }); return tablesFor(); }],
    ])('%s: the read failure is named and the visit has no guide (never a clean "no chinch rows")', async (_name, make) => {
      live();
      const ctx = await context(make());
      expect(ctx.readFailures).toContain('treatment_guide');
      expect('treatmentGuide' in ctx).toBe(false);
      expect('chinch' in ctx.plannedProducts).toBe(false);
      expect('guidedProductIds' in ctx.plannedProducts).toBe(false);
      // The sheet is not blocked: the plan's add-ons are listed as ever.
      expect(ctx.plannedProducts.addOns).toHaveLength(5);
    });

    test('(3) rows found but the limit read failed: the guide is on, the rungs are known and unreadable', async () => {
      live();
      v13VisitLimits.mockRejectedValue(new Error('limits down'));
      const ctx = await context(tablesFor());
      expect(ctx.treatmentGuide).toBe(true);
      expect(ctx.plannedProducts.chinch).toMatchObject({ item: null, rungIds: [P_ARENA, P_TALAK], unreadableIds: [P_ARENA, P_TALAK], blockedIds: [] });
    });

    test('a visit with no plan has no guide', async () => {
      live();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      expect('treatmentGuide' in (await context(tablesFor()))).toBe(false);
    });
  });

  describe('the treatment-guide read', () => {
    const kinds = (result) => result.cards.map((card) => card.kind);

    test('gate off: refused, nothing read', async () => {
      process.env.GATE_LAWN_SPOT_RULES = 'true';
      expect(await guide(tablesFor())).toEqual({ ok: false, reason: 'disabled' });
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test.each([
      ['a malformed assessment id', 'nope', {}, 'invalid_assessment'],
      ['an assessment that is not this visit\'s', CONFIRMED, { lawn_assessments: undefined }, 'not_found'],
      ['an assessment not yet confirmed', CONFIRMED, { lawn_assessments: assessmentRow({ confirmed_by_tech: false }) }, 'not_confirmed'],
    ])('%s is refused', async (_label, id, extra, reason) => {
      live();
      expect(await guide(tablesFor(extra), id)).toEqual({ ok: false, reason });
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test('a confirmed assessment the report would reject is refused', async () => {
      live();
      require('../services/lawn-assessment-history').installedForVisit.mockResolvedValue({ id: uuid(99) });
      expect(await guide(tablesFor())).toEqual({ ok: false, reason: 'not_usable' });
    });

    test('an ineligible visit and a missing visit', async () => {
      live();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ serviceKey: 'lawn_re_service' }));
      expect(await guide(tablesFor())).toEqual({ ok: false, reason: 'not_eligible' });
      expect(await guide({ scheduled_services: undefined })).toEqual({ ok: false, reason: 'not_found' });
    });

    test('a clean lawn: no cards, and the Weed spots decision read fresh rides the answer', async () => {
      live();
      expect(await guide(tablesFor())).toEqual({
        ok: true, v: 1, assessmentId: CONFIRMED, cards: [],
        weedMix: expect.objectContaining({ mode: 'lead', productIds: [P_LEAD, P_CERT] }),
        chinch: expect.objectContaining({ item: expect.objectContaining({ productId: P_ARENA }) }),
        // A clean read blocks nothing: a pick without a finding is not blocked.
        blockedProductIds: [],
        unreadableProductIds: [],
        unreadableNote: 'The limits could not be checked. Use Search products for what you applied; the office will review it.',
        // No take-all row in this month's plan.
        takeAllProductIds: [],
      });
    });

    describe('places (GATE_LAWN_TROUBLE_AREAS): a product is held back only when no place permits it', () => {
      // Capped lawn-wide and at the places named; open elsewhere.
      const cappedAt = (id, ...places) => v13VisitLimits.mockImplementation(async (_k, _s, items, _r, _t, options) => ({
        capped: new Map(items.filter((i) => i.product.id === id && (!options?.place || places.includes(options.place))).map((i) => [id, YEARLY])), warnings: [], blocks: [],
      }));
      const fungusTables = () => tablesFor({ lawn_assessment_runs: run({ fungal_activity: { level: 'severe' } }) });
      afterEach(() => { delete process.env.GATE_LAWN_TROUBLE_AREAS; });

      test('gate off: a fungicide capped at the front is blocked lawn-wide, as before', async () => {
        live();
        cappedAt(P_ART, 'front');
        const result = await guide(fungusTables());
        expect(result.blockedProductIds).toContain(P_ART);
        expect(result.cards.map((card) => card.kind)).not.toContain('fungus');
      });

      test('gate off: the guide answer has no placeBlocked key', async () => {
        live();
        cappedAt(P_ART, 'front');
        const answer = await guide(fungusTables());
        expect(answer).not.toHaveProperty('placeBlocked');
        expect(answer).not.toHaveProperty('placeBlockedTypes');
      });

      test('gate on: the answer carries the per-place blocks it just read, for every product it read, so the sheet can drop the opening map', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        cappedAt(P_ART, 'front');
        const result = await guide(fungusTables());
        expect(result.placeBlocked[P_ART]).toEqual({ front: 'limit' });
        // The limit type rides with each closed place (the sheet drops a yearly-amount block when the row's dose changes, never a count).
        expect(result.placeBlockedTypes).toEqual({ [P_ART]: { front: 'annual_max_apps' } });
        // Products the read found open everywhere are empty entries, not absent: "no longer closed" is an answer.
        expect(result.placeBlocked[P_ACE]).toEqual({});
        expect(result.placeBlocked[P_DISP]).toEqual({});
      });

      test('gate on: capped at the front only, the fungus card is offered and the pick is not blocked', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        cappedAt(P_ART, 'front');
        const result = await guide(fungusTables());
        expect(result.blockedProductIds).not.toContain(P_ART);
        expect(result.cards.find((card) => card.kind === 'fungus')).toMatchObject({ productIds: [P_ART] });
      });

      test('gate on: capped at every place, it is blocked and has no card', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        cappedAt(P_ART, 'front', 'back', 'left_side', 'right_side');
        const result = await guide(fungusTables());
        expect(result.blockedProductIds).toContain(P_ART);
        expect(result.cards.map((card) => card.kind)).not.toContain('fungus');
      });

      test('gate on: the lead capped at the front only gives the weeds card a set per place (the front takes the replacement)', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        buildPlanForService.mockResolvedValue(plan([
          ...addOns(), row(uuid(44), 'Test Blind Herbicide', { trigger: 'celsius_annual_cap_reached' }),
        ]));
        cappedAt(P_LEAD, 'front');
        const result = await guide(tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }) }));
        const weeds = result.cards.find((card) => card.kind === 'weeds');
        expect(weeds.byPlace.front.productIds).toEqual([uuid(44)]);
        expect(weeds.byPlace.back.productIds).toEqual([P_LEAD, P_CERT]);
        expect(weeds.productIds).toEqual([P_LEAD, P_CERT]);
      });
    });

    test('the plan\'s take-all fungicide rows, read now, ride the answer', async () => {
      live();
      const takeAllPlan = plan(addOns());
      takeAllPlan.completionDefaults.addOns[2].raw = 'Test Artavia — mapped take-all areas, second spring application';
      buildPlanForService.mockResolvedValue(takeAllPlan);
      v13ProtocolRows.mockReturnValue(new Map([...PROGRAM, [P_ART, { productId: P_ART, role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_2' } }]]));
      expect((await guide(tablesFor())).takeAllProductIds).toEqual([P_ART]);
    });

    test('takeAllProductIdsFor: the visit\'s take-all fungicide ids by the staged-row rule (what the completion confirms a take_all claim against)', async () => {
      live();
      const takeAllPlan = plan(addOns());
      takeAllPlan.completionDefaults.addOns[2].raw = 'Test Artavia — mapped take-all areas, second spring application';
      buildPlanForService.mockResolvedValue(takeAllPlan);
      v13ProtocolRows.mockReturnValue(new Map([...PROGRAM, [P_ART, { productId: P_ART, role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_2' } }]]));
      const knex = fakeKnex(tablesFor());
      expect([...(await takeAllProductIdsFor(visit({ scheduled_date: '2026-07-14' }), knex))]).toEqual([P_ART]);
      // Large patch is not take-all; a lawn with no plan has none.
      v13ProtocolRows.mockReturnValue(PROGRAM);
      buildPlanForService.mockResolvedValue(plan(addOns()));
      expect((await takeAllProductIdsFor(visit({ scheduled_date: '2026-07-14' }), knex)).size).toBe(0);
      buildPlanForService.mockResolvedValue(plan(addOns(), false));
      expect((await takeAllProductIdsFor(visit({ scheduled_date: '2026-07-14' }), knex)).size).toBe(0);
    });

    test('the fresh chinch decision rides the answer: the product, then the fallback, then nothing', async () => {
      live();
      const tables = tablesFor();
      expect((await guide(tables)).chinch).toMatchObject({ item: { productId: P_ARENA }, note: null });
      capsFor({ [P_ARENA]: YEARLY });
      expect((await guide(tables)).chinch).toMatchObject({ item: { productId: P_TALAK }, note: expect.stringMatching(/yearly limit reached/) });
      capsFor({ [P_ARENA]: YEARLY, [P_TALAK]: YEARLY });
      const both = await guide(tables);
      expect(both.chinch).toMatchObject({ item: null, note: 'The yearly limit is reached for the chinch bug products on this lawn.', rungIds: [P_ARENA, P_TALAK], blockedIds: [P_ARENA, P_TALAK] });
      expect(both.blockedProductIds).toEqual(expect.arrayContaining([P_ARENA, P_TALAK]));
      // A fresh limit read that fails offers nothing, never Arena.
      v13VisitLimits.mockRejectedValue(new Error('db down'));
      expect((await guide(tables)).chinch).toMatchObject({ item: null, note: expect.stringMatching(/could not be checked/) });
    });

    test('an ineligible plan: the route answers no chinch decision and no chinch card, whatever the photos say', async () => {
      live();
      buildPlanForService.mockResolvedValue(plan(addOns(), false));
      const result = await guide(tablesFor({
        scheduled_services: visit({ scheduled_date: '2026-07-14' }),
        lawn_assessment_runs: run({ insect_damage: { level: 'severe' }, fungal_activity: { level: 'severe' } }),
        lawn_assessments: assessmentRow({ weed_suppression: 50 }),
      }));
      expect(result).toMatchObject({ ok: true, cards: [], weedMix: null, chinch: null });
      expect(v13VisitLimits).not.toHaveBeenCalled();
    });

    test('blockedProductIds, per governed kind: a cap that was READ, the chinch rungs and the weed group', async () => {
      live();
      const tables = tablesFor();
      // Nothing capped: nothing blocked, nothing unreadable.
      const clean = await guide(tables);
      expect(clean.blockedProductIds).toEqual([]);
      expect(clean.unreadableProductIds).toEqual([]);
      // The fungicide and the wetting agent at a cap, the lead at its cap (July: no replacement row).
      capsFor({ [P_ART]: YEARLY, [P_DISP]: YEARLY, [P_LEAD]: YEARLY });
      const capped = await guide(tables);
      expect(capped.blockedProductIds).toEqual(expect.arrayContaining([P_ART, P_DISP, P_LEAD, P_CERT]));
      expect(capped.blockedProductIds).not.toContain(P_ACE);
      expect(capped.unreadableProductIds).toEqual([]);
      // Arena alone at its cap: the first rung is blocked, the second is the offer.
      capsFor({ [P_ARENA]: YEARLY });
      expect((await guide(tables)).blockedProductIds).toEqual([P_ARENA]);
    });

    test('unreadableProductIds, per governed kind: a limit read that FAILED forbids nothing', async () => {
      live();
      const tables = tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }), lawn_assessment_runs: run({ fungal_activity: { level: 'severe' }, insect_damage: { level: 'severe' } }) });
      // The whole read fails: every pick, every rung and the weed group are unreadable; none is blocked.
      v13VisitLimits.mockRejectedValue(new Error('db down'));
      const failed = await guide(tables);
      expect(failed.unreadableProductIds).toEqual(expect.arrayContaining([P_ART, P_ACE, P_DISP, P_ARENA, P_TALAK, P_LEAD, P_CERT]));
      expect(failed.blockedProductIds).toEqual([]);
      // Nothing is offered for them: no card, and the weed and chinch lines carry the one wording.
      expect(failed.cards).toEqual([]);
      const note = 'The limits could not be checked. Use Search products for what you applied; the office will review it.';
      expect(failed.weedMix).toMatchObject({ mode: 'unavailable', note });
      expect(failed.chinch).toMatchObject({ item: null, note, unreadableIds: [P_ARENA, P_TALAK], blockedIds: [] });
      expect(failed.unreadableNote).toBe(note);
      // One product's own read fails (a block with no type): only it is unreadable.
      v13VisitLimits.mockImplementation(async (_k, _s, items) => ({
        capped: new Map(items.filter((i) => i.product.id === P_ART).map((i) => [i.product.id, [{ message: 'read failed' }]])), warnings: [], blocks: [],
      }));
      const one = await guide(tables);
      expect(one.unreadableProductIds).toContain(P_ART);
      expect(one.blockedProductIds).not.toContain(P_ART);
      expect(one.cards.find((c) => c.kind === 'fungus')).toBeUndefined();
    });

    test('per product: one chinch rung blocked, the other unreadable (Arena stays blocked; only Talak is released)', async () => {
      live();
      capsFor({ [P_ARENA]: YEARLY, [P_TALAK]: [{ message: 'read failed' }] });
      const result = await guide(tablesFor());
      expect(result.chinch).toMatchObject({ item: null, rungIds: [P_ARENA, P_TALAK], blockedIds: [P_ARENA], unreadableIds: [P_TALAK] });
      expect(result.blockedProductIds).toContain(P_ARENA);
      expect(result.blockedProductIds).not.toContain(P_TALAK);
      expect(result.unreadableProductIds).toContain(P_TALAK);
      expect(result.unreadableProductIds).not.toContain(P_ARENA);
    });

    test('per product: a weed member read as capped stays blocked when its sibling\'s read fails; the sibling is released', async () => {
      live();
      capsFor({ [P_LEAD]: YEARLY, [P_CERT]: [{ message: 'read failed' }] });
      const result = await guide(tablesFor());
      expect(result.weedMix).toMatchObject({ mode: 'unavailable', blockedIds: [P_LEAD] });
      expect(result.blockedProductIds).toContain(P_LEAD);
      expect(result.blockedProductIds).not.toContain(P_CERT);
      expect(result.unreadableProductIds).toContain(P_CERT);
      expect(result.unreadableProductIds).not.toContain(P_LEAD);
    });

    test('per product: picks are judged one by one (one unreadable does not release a capped one)', async () => {
      live();
      capsFor({ [P_ART]: YEARLY, [P_ACE]: [{ message: 'read failed' }] });
      const result = await guide(tablesFor());
      expect(result.blockedProductIds).toContain(P_ART);
      expect(result.unreadableProductIds).toContain(P_ACE);
      expect(result.unreadableProductIds).not.toContain(P_ART);
      expect(result.blockedProductIds).not.toContain(P_ACE);
    });

    test('a pick with both a named limit and an unreadable one is blocked (the read forbids it)', async () => {
      live();
      capsFor({ [P_ART]: [{ message: 'read failed' }, { type: 'annual_max_apps', message: 'limit' }] });
      const result = await guide(tablesFor());
      expect(result.blockedProductIds).toContain(P_ART);
      expect(result.unreadableProductIds).not.toContain(P_ART);
    });

    test('a city hold blocks its pick too', async () => {
      live();
      const held = plan(addOns());
      held.completionDefaults.addOns[3].unavailable = { kind: 'city_hold' };
      buildPlanForService.mockResolvedValue(held);
      expect((await guide(tablesFor())).blockedProductIds).toEqual([P_ACE]);
    });

    test('no staged chinch rows, or no plan: the fresh chinch decision is null', async () => {
      live();
      expect((await guide(tablesFor({ 'lawn_protocol_products as lpp': [] }))).chinch).toBeNull();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      expect((await guide(tablesFor())).chinch).toBeNull();
    });

    test('the fresh weed decision and the weed card agree: a cap reached after the sheet opened', async () => {
      live();
      capsFor({ [P_LEAD]: YEARLY });
      const result = await guide(tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }) }));
      // The lead is capped and the month's data holds no replacement row: no card, and the mix says so.
      expect(result.cards).toEqual([]);
      expect(result.weedMix).toMatchObject({ mode: 'none', productIds: [] });
    });

    test('the weed card carries the fresh offer\'s own add-ons, so the tap adds exactly those', async () => {
      live();
      const result = await guide(tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }) }));
      const weeds = result.cards.find((c) => c.kind === 'weeds');
      expect(weeds.items.map((i) => i.productId)).toEqual(weeds.productIds);
      expect(result.weedMix.productIds).toEqual(weeds.productIds);
    });

    // After the program data change (February = Celsius only; no Blindside row in May and October)
    // the same outcomes fall out of the data. The weed card needs the Weed spots group.
    test('(a) no weed group, only a lone weed herbicide add-on: no weeds card, no weed decision', async () => {
      live();
      buildPlanForService.mockResolvedValue(plan([row(P_LEAD, 'Test Lead WG', { annualCounter: 'x' }, { raw: 'Test Lead WG — weed spots' }), row(P_ART, 'Test Artavia', {})]));
      const result = await guide(tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }) }));
      expect(kinds(result)).not.toContain('weeds');
      expect(result.weedMix).toBeNull();
    });

    test('(b) the lead at its cap and no replacement row this month: no weeds card, the mix says the yearly limit is reached', async () => {
      live();
      capsFor({ [P_LEAD]: YEARLY });
      const result = await guide(tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }) }));
      expect(kinds(result)).not.toContain('weeds');
      expect(result.weedMix).toMatchObject({ mode: 'none', productIds: [], replacementProductId: null, note: 'The yearly weed-spray limit is reached for this lawn.' });
    });

    test('a visit with no plan answers no weed decision', async () => {
      live();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      expect(await guide(tablesFor())).toMatchObject({ cards: [], weedMix: null });
    });

    test('a one-time visit has no plan, so no cards', async () => {
      live();
      resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
      const result = await guide(tablesFor({ lawn_assessment_runs: run({ fungal_activity: { level: 'severe' } }) }));
      expect(result.cards).toEqual([]);
      expect(buildPlanForService).not.toHaveBeenCalled();
    });

    test('every finding at once, in July: all five cards, each with the plan\'s own add-on', async () => {
      live();
      const result = await guide(tablesFor({
        lawn_assessments: assessmentRow({ weed_suppression: 70, composite_scores: { drought_stress: 'moderate' } }),
        lawn_assessment_runs: run({ fungal_activity: { level: 'minor' }, insect_damage: { level: 'moderate' } }),
      }));
      expect(kinds(result)).toEqual(['weeds', 'fungus', 'chinch', 'caterpillars', 'dry_spots']);
      const byKind = Object.fromEntries(result.cards.map((card) => [card.kind, card]));
      expect(byKind.weeds).toMatchObject({ finding: 'Photos show weeds on about 30% of the lawn.', productIds: [P_LEAD, P_CERT], detail: 'Test Lead WG, Test Cert Herbicide' });
      expect(byKind.fungus).toMatchObject({ productIds: [P_ART], detail: 'Test Artavia — mapped large patch', items: [expect.objectContaining({ productId: P_ART })] });
      expect(byKind.chinch).toMatchObject({ productIds: [P_ARENA], check: 'Check first: part the grass at the sunny edge of the damaged patch. Do a float test only if you are unsure.', actionLabel: 'Found at the edge. Add it' });
      expect(byKind.caterpillars).toMatchObject({ productIds: [P_ACE] });
      expect(byKind.dry_spots).toMatchObject({ productIds: [P_DISP] });
    });

    test('a take-all month: the fungus card is the check only, with no product to tap', async () => {
      live();
      const takeAllPlan = plan(addOns());
      takeAllPlan.completionDefaults.addOns[2].raw = 'Test Artavia — mapped take-all areas, second spring application';
      buildPlanForService.mockResolvedValue(takeAllPlan);
      v13ProtocolRows.mockReturnValue(new Map([...PROGRAM, [P_ART, { productId: P_ART, role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_2' } }]]));
      const result = await guide(tablesFor({ lawn_assessment_runs: run({ fungal_activity: { level: 'moderate' } }) }));
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0]).toMatchObject({ kind: 'fungus', productIds: [], actionLabel: null, note: 'Take-all is treated on known trouble areas only. None is on file for this lawn.' });
    });

    describe('take-all areas on file (GATE_LAWN_TROUBLE_AREAS)', () => {
      const AREA = { id: uuid(70), place: 'back', type: 'take_all', last_treated_on: '2026-06-01', last_seen_on: '2026-06-01' };
      const takeAllMonth = () => {
        const takeAllPlan = plan(addOns());
        takeAllPlan.completionDefaults.addOns[2].raw = 'Test Artavia — mapped take-all areas, second spring application';
        buildPlanForService.mockResolvedValue(takeAllPlan);
        v13ProtocolRows.mockReturnValue(new Map([...PROGRAM, [P_ART, { productId: P_ART, role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_2' } }]]));
      };
      const read = (areasOnFile) => guide(tablesFor({
        scheduled_services: visit({ scheduled_date: '2026-07-14', property_id: uuid(40) }),
        lawn_trouble_areas: areasOnFile,
        lawn_assessment_runs: run({ fungal_activity: { level: 'moderate' } }),
      }));
      afterEach(() => { delete process.env.GATE_LAWN_TROUBLE_AREAS; });

      test('gate off: an area on file changes nothing (the check only, as before)', async () => {
        live();
        takeAllMonth();
        const result = await read([AREA]);
        expect(result.cards[0]).toMatchObject({ kind: 'fungus', productIds: [], actionLabel: null });
      });

      test('gate on, a take_all area on file: the card offers the take-all product with one tap, and the note names the stored place', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        takeAllMonth();
        const result = await read([AREA]);
        expect(result.cards[0]).toMatchObject({ kind: 'fungus', productIds: [P_ART], actionLabel: 'I checked. Add it', note: 'Take-all area on file: Back.', allowedPlaces: ['back'] });
        // Still governed: the answer lists it as a take-all product, so the sheet never lists it with the plain add-ons.
        expect(result.takeAllProductIds).toEqual([P_ART]);
      });

      test('gate on: no area on file (or only another type) is the check only; a cleared area is not returned by the store, so it offers nothing', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        takeAllMonth();
        expect((await read([])).cards[0]).toMatchObject({ productIds: [], actionLabel: null });
        expect((await read([{ ...AREA, type: 'fungus' }])).cards[0]).toMatchObject({ productIds: [], actionLabel: null });
      });

      test('gate on: the stored place where the product is capped is not offered; with no other stored place the card is the check only', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        takeAllMonth();
        v13VisitLimits.mockImplementation(async (_k, _s, items, _r, _t, options) => ({
          capped: new Map(items.filter((i) => i.product.id === P_ART && (!options?.place || options.place === 'back')).map((i) => [P_ART, YEARLY])), warnings: [], blocks: [],
        }));
        expect((await read([AREA])).cards[0]).toMatchObject({ productIds: [], actionLabel: null });
        // The same product capped at the back but a second stored area at the front: the card stands, naming the front only.
        expect((await read([AREA, { ...AREA, id: uuid(71), place: 'front' }])).cards[0]).toMatchObject({ productIds: [P_ART], note: 'Take-all area on file: Front.', allowedPlaces: ['front'] });
      });

      test('gate on: a failed read of the store is the check only, never a guess', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        takeAllMonth();
        expect((await read(new Error('synthetic read failure'))).cards[0]).toMatchObject({ productIds: [], actionLabel: null });
      });
    });

    describe('products the sheet names (Search-added rows outside the month\'s recipe)', () => {
      const P_SEARCHED = uuid(80);
      afterEach(() => { delete process.env.GATE_LAWN_TROUBLE_AREAS; });

      test('gate on: they are read per place and ride the answer in the context\'s shape; the guide\'s own reads stand', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        v13VisitLimits.mockImplementation(async (_k, _s, items, _r, _t, options) => ({
          capped: new Map(items.filter((i) => i.product.id === P_SEARCHED && (!options?.place || options.place === 'front')).map((i) => [P_SEARCHED, YEARLY])), warnings: [], blocks: [],
        }));
        const tables = tablesFor({ products_catalog: [{ id: P_SEARCHED, name: 'Searched Product' }] });
        const result = await buildLawnTreatmentGuide({ serviceId: VISIT, assessmentId: CONFIRMED, knex: fakeKnex(tables), productIds: [P_SEARCHED, 'not-a-uuid'] });
        expect(result.placeBlocked[P_SEARCHED]).toEqual({ front: 'limit' });
        expect(result.placeBlockedTypes[P_SEARCHED]).toEqual({ front: 'annual_max_apps' });
        expect(result.placeBlocked[P_ART]).toEqual({});
      });

      test('gate off, or no ids named: the answer is as it was', async () => {
        live();
        const tables = tablesFor();
        expect(await buildLawnTreatmentGuide({ serviceId: VISIT, assessmentId: CONFIRMED, knex: fakeKnex(tables), productIds: [P_SEARCHED] })).not.toHaveProperty('placeBlocked');
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        expect((await guide(tables)).placeBlocked).not.toHaveProperty(P_SEARCHED);
      });

      test('the context reads them too (a one-time visit with no plan has an empty seed)', async () => {
        live();
        process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
        resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }));
        v13VisitLimits.mockImplementation(async (_k, _s, items, _r, _t, options) => ({
          capped: new Map(items.filter((i) => i.product.id === P_SEARCHED && (!options?.place || options.place === 'back')).map((i) => [P_SEARCHED, YEARLY])), warnings: [], blocks: [],
        }));
        const knex = fakeKnex({ ...tablesFor(), products_catalog: [{ id: P_SEARCHED, name: 'Searched Product' }] });
        expect((await buildLawnFastContext(VISIT, { knex })).troubleAreas.blocked).toEqual({});
        const named = await buildLawnFastContext(VISIT, { knex, productIds: [P_SEARCHED] });
        expect(named.troubleAreas.blocked).toEqual({ [P_SEARCHED]: { back: 'limit' } });
        expect(named.troubleAreas.blockedTypes).toEqual({ [P_SEARCHED]: { back: 'annual_max_apps' } });
      });
    });

    test('the chinch card is seasonal: October has none, and the caterpillar card stays', async () => {
      live();
      const result = await guide(tablesFor({
        scheduled_services: visit({ scheduled_date: '2026-10-05' }),
        lawn_assessment_runs: run({ insect_damage: { level: 'severe' } }),
      }));
      expect(kinds(result)).toEqual(['caterpillars']);
    });

    test('a legacy assessment (no run) reads the worst per-photo level', async () => {
      live();
      const result = await guide(tablesFor({
        lawn_assessment_runs: undefined,
        lawn_assessments: assessmentRow({ gemini_raw: [{ fungal_activity: 'none' }, { fungal_activity: 'moderate' }] }),
      }));
      expect(kinds(result)).toEqual(['fungus']);
    });

    test('Arena at its cap hands the chinch card to the bifenthrin product; both capped: no chinch card', async () => {
      live();
      const tables = tablesFor({ lawn_assessment_runs: run({ insect_damage: { level: 'moderate' } }) });
      capsFor({ [P_ARENA]: YEARLY });
      expect((await guide(tables)).cards.find((c) => c.kind === 'chinch')).toMatchObject({ productIds: [P_TALAK], note: expect.stringMatching(/yearly limit reached/) });
      capsFor({ [P_ARENA]: YEARLY, [P_TALAK]: YEARLY });
      expect(kinds(await guide(tables))).not.toContain('chinch');
    });

    test('a failed limit read leaves the products off the cards, never on them', async () => {
      live();
      v13VisitLimits.mockRejectedValue(new Error('db down'));
      const result = await guide(tablesFor({
        lawn_assessments: assessmentRow({ weed_suppression: 50 }),
        lawn_assessment_runs: run({ fungal_activity: { level: 'severe' }, insect_damage: { level: 'severe' } }),
      }));
      expect(result.cards).toEqual([]);
    });

    test('the weed card follows the Weed spots entry: at both caps there is no card', async () => {
      live();
      const tables = tablesFor({ lawn_assessments: assessmentRow({ weed_suppression: 50 }) });
      expect(kinds(await guide(tables))).toEqual(['weeds']);
      capsFor({ [P_LEAD]: YEARLY });
      expect(kinds(await guide(tables))).toEqual([]);
    });

    // A read that THROWS must fail the request (the sheet then follows the context's decisions), never
    // answer "nothing found". Each read in the guide path:
    test('a missing run row (a legacy assessment) is no run, and the legacy reads speak', async () => {
      live();
      const tables = tablesFor({ lawn_assessment_runs: undefined, lawn_assessments: assessmentRow({ gemini_raw: [{ fungal_activity: 'severe' }] }) });
      expect(kinds(await guide(tables))).toEqual(['fungus']);
    });

    test.each([
      ['the assessment run read', () => tablesFor({ lawn_assessment_runs: new Error('runs down') })],
      ['the assessment read', () => tablesFor({ lawn_assessments: new Error('assessments down') })],
      ['the staged chinch lookup', () => tablesFor({ 'lawn_protocol_products as lpp': new Error('rows down') })],
      ['the catalog read', () => tablesFor({ products_catalog: new Error('catalog down') })],
    ])('%s throwing fails the request', async (_name, make) => {
      live();
      await expect(guide(make())).rejects.toBeTruthy();
    });

    test('the plan build throwing fails the request', async () => {
      live();
      buildPlanForService.mockRejectedValue(new Error('plan down'));
      await expect(guide(tablesFor())).rejects.toThrow('plan down');
    });

    test('a weed-mix defect fails the request instead of answering "no weed group"', async () => {
      live();
      jest.spyOn(require('../services/lawn-weed-mix'), 'buildWeedMix').mockRejectedValue(new Error('weed defect'));
      await expect(guide(tablesFor())).rejects.toThrow('weed mix unavailable');
    });

    test('the three chinch cases at route level: (1) no row staged is null, (2) a thrown lookup fails, (3) a failed limit read is unreadable', async () => {
      live();
      expect((await guide(tablesFor({ 'lawn_protocol_products as lpp': [] }))).chinch).toBeNull();
      await expect(guide(tablesFor({ 'lawn_protocol_products as lpp': new Error('rows down') }))).rejects.toThrow('rows down');
      v13VisitLimits.mockRejectedValue(new Error('limits down'));
      expect((await guide(tablesFor())).chinch).toMatchObject({ item: null, rungIds: [P_ARENA, P_TALAK], unreadableIds: [P_ARENA, P_TALAK], blockedIds: [] });
    });
  });
});

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
    svc: { id: VISIT, customer_id: 'cust-1', property_id: 'prop-1' },
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

  describe('the places (GATE_LAWN_TROUBLE_AREAS)', () => {
    const CONFIRMED = { lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true }, lawn_assessment_photos: [] };
    const spotRow = (extra = {}) => ({ productId: P_HERB, name: 'Test Weed Spray', applicationMethod: 'spot_treatment', ...extra });
    beforeEach(() => {
      process.env.GATE_LAWN_SPOT_RULES = 'true'; process.env.GATE_LAWN_V13 = 'true'; process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
      v13VisitLimits.mockReset().mockResolvedValue({ capped: new Map(), warnings: [], blocks: [] });
    });
    afterEach(() => { delete process.env.GATE_LAWN_SPOT_RULES; delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_TROUBLE_AREAS; delete process.env.GATE_LAWN_TREATMENT_GUIDE; });

    test('gate off: the products are not looked at', async () => {
      delete process.env.GATE_LAWN_TROUBLE_AREAS;
      expect(await run(CONFIRMED, { products: [spotRow()] })).toBeNull();
    });

    test('a spot row with no place: 400 lawn_place_required, naming the product; a bad place: 400 lawn_place_invalid', async () => {
      expect(await run(CONFIRMED, { products: [spotRow()] })).toMatchObject({ status: 400, payload: { code: 'lawn_place_required', error: 'Pick where on the lawn Test Weed Spray went.' } });
      expect(await run(CONFIRMED, { products: [spotRow({ areaPlace: 'roof' })] })).toMatchObject({ status: 400, payload: { code: 'lawn_place_invalid' } });
    });

    test('a row with a place, and a whole-lawn row without one, pass the preflight', async () => {
      expect(await run(CONFIRMED, { products: [spotRow({ areaPlace: 'front' }), { productId: P_GRAN, applicationMethod: 'granular_broadcast' }] })).toBeNull();
    });

    test('an incomplete outcome is exempt, as for every other check', async () => {
      expect(await run(CONFIRMED, { isIncompleteVisit: true, products: [spotRow()] })).toBeNull();
    });

    test('the earlier checks come first: no confirmed assessment is still lawn_fast_assessment_required', async () => {
      expect(await run({ lawn_assessments: undefined }, { products: [spotRow()] })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_assessment_required' } });
    });
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
