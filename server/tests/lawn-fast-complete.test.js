// Lawn Fast Complete server half: the one eligibility function (every lawn visit
// type, recurring first; the re-service and assessment visit keep their own
// lanes), the context, the watering preview (must equal the report's own
// instruction), and the /complete preflight (gate, eligible visit, confirmed
// assessment; photo floor advisory). Synthetic data; a table-keyed fake knex.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
}));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => true) }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const {
  lawnFastIneligibleReason,
  lawnFastVisitType,
  evaluatePhotoFloor,
  buildLawnFastContext,
  buildLawnFastWateringPreview,
  preflightLawnFastCompletion,
} = require('../services/lawn-fast-complete');
const reportData = require('../services/service-report/report-data');
const { resolveWateringRule } = require('../services/service-report/lawn-watering-rule');

const PROFILE = (extra = {}) => ({
  category: 'lawn_care', serviceKey: 'lawn_care_monthly', billingType: 'recurring', findingsType: null,
  projectBacked: false, requiresProject: false, companions: [], ...extra,
});

const visit = (extra = {}) => ({
  id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', service_type: 'Lawn Care',
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
  id: 'p-herb', name: 'Test Weed Spray', category: 'herbicide', product_type: 'pesticide', formulation: 'WG',
  epa_reg_number: '100-1', approved_for_service_report: true,
  post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label' },
};
const granular = {
  id: 'p-gran', name: 'Test Feed Granular', category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular',
  approved_for_service_report: true,
  post_application_watering: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' },
};
const unapproved = { id: 'p-un', name: 'Test Unapproved', category: 'fertilizer', formulation: 'granular', approved_for_service_report: false };

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
    expect(lawnFastIneligibleReason({ svc: visit({ status }), profile: PROFILE(), skipTerminal: true })).toBeNull();
  });
});

describe('lawnFastVisitType', () => {
  test.each([
    [PROFILE(), null, 'recurring'],
    [PROFILE(), 'monthly_membership', 'recurring'],
    [PROFILE(), 'per_visit', 'recurring'],
    [PROFILE(), 'per_application', 'per_application'],
    [PROFILE({ billingType: 'one_time' }), null, 'one_time'],
    [PROFILE(), 'one_time', 'one_time'],
    [PROFILE({ billingType: null }), null, 'other'],
  ])('%#', (profile, mode, expected) => {
    expect(lawnFastVisitType(profile, mode)).toBe(expected);
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
    isUserFeatureEnabled.mockClear();
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
    const ctx = await buildLawnFastContext('visit-1', { knex: fakeKnex(tables()) });
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'lawn_re_service', service: { id: 'visit-1', serviceKey: 'lawn_re_service' } });
    expect(ctx.plannedProducts).toBeUndefined();
    expect(buildPlanForService).not.toHaveBeenCalled();
  });

  test.each([
    ['recurring', PROFILE(), null, 'recurring'],
    ['per-application', PROFILE(), 'per_application', 'per_application'],
    ['one-time', PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' }), null, 'one_time'],
  ])('a %s lawn visit opens the sheet (no plan: empty planned products, never refused)', async (_label, profile, billingMode, visitType) => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
    const ctx = await buildLawnFastContext('visit-1', {
      knex: fakeKnex(tables({ customers: { billing_mode: billingMode }, lawn_assessments: undefined })),
      technicianId: 'tech-1',
    });
    expect(ctx).toMatchObject({
      ok: true, eligible: true, reason: null, visitType,
      plannedProducts: { source: null, items: [] },
      assessment: { exists: false, id: null, confirmed: false },
      photoStatus: null,
      previousFrontPhoto: null,
    });
  });

  test('a typed lawn visit hides the height capture the typed form never renders', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(PROFILE({ findingsType: 'one_time_lawn_treatment', billingType: 'one_time' }));
    const ctx = await buildLawnFastContext('visit-1', { knex: fakeKnex(tables()), technicianId: 'tech-1' });
    expect(ctx.turfHeightCapture).toBe(false);
  });

  test('turfHeightCapture follows the per-tech flag on an untyped lawn visit', async () => {
    isUserFeatureEnabled.mockResolvedValueOnce(true);
    expect((await buildLawnFastContext('visit-1', { knex: fakeKnex(tables()), technicianId: 'tech-1' })).turfHeightCapture).toBe(true);
    expect(isUserFeatureEnabled).toHaveBeenCalledWith('tech-1', 'turf-height-capture', false, expect.anything());
    isUserFeatureEnabled.mockResolvedValueOnce(false);
    expect((await buildLawnFastContext('visit-1', { knex: fakeKnex(tables()), technicianId: 'tech-1' })).turfHeightCapture).toBe(false);
  });

  test('a recurring program visit carries the planned products with each watering rule', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    buildPlanForService.mockResolvedValue({
      completionDefaults: {
        items: [
          { product: { id: 'p-herb', name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: 2, amountUnit: 'fl oz' } },
          { product: { id: 'p-gran', name: 'Test Feed Granular' }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb' } },
          { product: { id: 'p-un', name: 'Test Unapproved' }, applicationMethod: null, mix: {} },
        ],
      },
    });
    const ctx = await buildLawnFastContext('visit-1', {
      knex: fakeKnex(tables({ products_catalog: [herbicide, granular, unapproved] })),
    });
    expect(ctx.plannedProducts.source).toBe('plan');
    const [h, g, u] = ctx.plannedProducts.items;
    expect(h).toMatchObject({ productId: 'p-herb', applicationMethod: 'broadcast_spray', amount: 2, amountUnit: 'fl oz', approvedForReport: true });
    expect(h.wateringRule).toEqual(resolveWateringRule(herbicide));
    expect(g.wateringRule).toEqual(resolveWateringRule(granular));
    expect(g.wateringRule.mode).toBe('water_in');
    // Not approved for reports: no frozen facts, so no rule and no claim.
    expect(u).toMatchObject({ approvedForReport: false, wateringRule: null, wateringSummary: 'No watering rule on file' });
    // The catalog row (cost, vendor and all) is never returned.
    expect(JSON.stringify(ctx)).not.toMatch(/epa_reg|post_application_watering/);
  });

  test('a failed plan read degrades to an empty list, never blocks opening', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    buildPlanForService.mockRejectedValue(new Error('plan down'));
    const ctx = await buildLawnFastContext('visit-1', { knex: fakeKnex(tables()) });
    expect(ctx).toMatchObject({ eligible: true, plannedProducts: { source: null, items: [] } });
  });

  test('an existing confirmed assessment, with the advisory photo status', async () => {
    const ctx = await buildLawnFastContext('visit-1', {
      knex: fakeKnex(tables({
        lawn_assessments: { id: 'as-1', confirmed_by_tech: true },
        lawn_assessment_photos: [{ zone: 'front' }, { zone: 'trouble' }],
      })),
    });
    expect(ctx.assessment).toEqual({ exists: true, id: 'as-1', confirmed: true });
    expect(ctx.photoStatus).toMatchObject({ soft: true, count: 2, meetsFloor: false });
    expect(ctx.photoStatus.warning).toMatch(/can still finish/);
  });

  test('an unconfirmed assessment reads confirmed:false', async () => {
    const ctx = await buildLawnFastContext('visit-1', {
      knex: fakeKnex(tables({ lawn_assessments: { id: 'as-1', confirmed_by_tech: false }, lawn_assessment_photos: [] })),
    });
    expect(ctx.assessment).toEqual({ exists: true, id: 'as-1', confirmed: false });
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
    scheduled_services: { id: 'visit-1', customer_id: 'cust-1' },
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
    const preview = await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: rows.map((r) => r.id), knex: knexFor(rows), now });
    expect(await reportBanner(rows, knexFor(rows))).toBeNull();
    expect(preview.sentence).toBeNull();
  });

  test('a product with no rule on file makes no claim, as the report does', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const rows = [herbicide, unapproved];
    const preview = await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: rows.map((r) => r.id), knex: knexFor(rows), now });
    const banner = await reportBanner(rows, knexFor(rows));
    expect(banner).toBeNull();
    expect(preview.lines).toEqual([]);
    expect(preview.sentence).toBeNull();
  });

  test('an unknown product id is an unknown rule, so no claim', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const preview = await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: ['p-herb', 'p-missing'], knex: knexFor([herbicide]), now });
    expect(preview.sentence).toBeNull();
    expect(preview.products[1]).toMatchObject({ productId: 'p-missing', name: null, rule: null });
  });

  test('with GATE_LAWN_WATERING_RULE off the report prints none, so the preview lists rules but no sentence', async () => {
    delete process.env.GATE_LAWN_WATERING_RULE;
    const preview = await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: ['p-herb'], knex: knexFor([herbicide]), now });
    expect(preview).toMatchObject({ ok: true, wateringRuleLive: false, lines: [], sentence: null });
    expect(preview.products[0].rule).toEqual(resolveWateringRule(herbicide));
  });

  test('the response never carries the frozen facts or catalog row', async () => {
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    const preview = await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: ['p-herb'], knex: knexFor([herbicide]), now });
    expect(Object.keys(preview.products[0]).sort()).toEqual(['approvedForReport', 'mowHoldDays', 'name', 'productId', 'rule', 'ruleSummary']);
  });

  test('bad requests', async () => {
    const knex = knexFor([]);
    expect(await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: 'p-herb', knex })).toEqual({ ok: false, reason: 'invalid_product_ids' });
    expect(await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: [1], knex })).toEqual({ ok: false, reason: 'invalid_product_ids' });
    expect(await buildLawnFastWateringPreview({ serviceId: 'visit-1', productIds: Array.from({ length: 21 }, (_, i) => `p${i}`), knex })).toEqual({ ok: false, reason: 'too_many_products' });
    const noVisit = fakeKnex({ scheduled_services: undefined });
    expect(await buildLawnFastWateringPreview({ serviceId: 'nope', productIds: ['a'], knex: noVisit })).toEqual({ ok: false, reason: 'not_found' });
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

  const run = (tables, args = {}) => preflightLawnFastCompletion({
    knex: fakeKnex({ scheduled_services: visit(), customers: { billing_mode: null }, ...tables }),
    svc: { id: 'visit-1', customer_id: 'cust-1' },
    lawnAssessmentId: 'as-1',
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
    expect(await run({ lawn_assessments: { id: 'as-1', confirmed_by_tech: false } }))
      .toMatchObject({ status: 400, payload: { code: 'lawn_assessment_unconfirmed', lawnAssessmentId: 'as-1' } });
  });

  test.each([
    ['recurring', PROFILE()],
    ['one-time', PROFILE({ billingType: 'one_time', serviceKey: 'lawn_care_one_time' })],
  ])('a confirmed assessment on a %s visit passes, even with no photos at all (advisory floor)', async (_label, profile) => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
    expect(await run({ lawn_assessments: { id: 'as-1', confirmed_by_tech: true }, lawn_assessment_photos: [] })).toBeNull();
  });

  test('an already-completed visit is left to the main completion flow (no terminal refusal here)', async () => {
    expect(await run({ scheduled_services: visit({ status: 'completed' }), lawn_assessments: { id: 'as-1', confirmed_by_tech: true } })).toBeNull();
  });

  test('an incomplete visit is not judged', async () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    expect(await run({}, { isIncompleteVisit: true })).toBeNull();
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
    [{ status: 400, code: 'lawn_fast_assessment_required' }, 'correctable'],
    [{ status: 400, code: 'lawn_assessment_unconfirmed' }, 'correctable'],
  ])('%j is %s', (err, expected) => {
    expect(outcome(err)).toBe(expected);
  });
});
