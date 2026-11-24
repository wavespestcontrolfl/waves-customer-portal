// Verify the composed customer-page projection and the reader's disclosure
// gates without rebuilding the public pricing engine in this suite.
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__queries = [];
  db.__rows = () => [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    db.__queries.push(query);
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
const mockCallSideBlock = jest.fn(async () => null);
jest.mock('../utils/estimate-claim-sql', () => ({
  ...jest.requireActual('../utils/estimate-claim-sql'),
  callSideBlockForEstimateData: (...a) => mockCallSideBlock(...a),
}));
const calls = [];
const mockCompose = jest.fn(async () => ({}));
const mockReconcile = jest.fn(async () => undefined);
jest.mock('../routes/estimate-public', () => {
  const unpublished = ['draft', 'scheduled'];
  return {
    composeEstimateDataPayload: (...a) => { calls.push('compose'); return mockCompose(...a); },
    reconcileFrozenMembershipSnapshot: (...a) => { calls.push('reconcile'); return mockReconcile(...a); },
    isEstimateCustomerViewable: (e) => !e.archived_at && !unpublished.includes(e.status) && !['expired', 'send_failed'].includes(e.status),
    // Real parser (estimate-public.js parseEstimateDataSafe) — the tool feeds
    // the provenance gate through the route's own copy, not a second one.
    parseEstimateDataSafe: (e = {}) => {
      const raw = e.estimate_data;
      if (!raw) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw) || {}; } catch { return {}; } }
      return raw || {};
    },
    adminDraftPreviewEligible: (e, p) => p === '1' && !e.archived_at && unpublished.includes(e.status),
  };
});
const db = require('../models/db');
const { shapeEstimate, GET_ESTIMATE_DETAIL_TOOL } = require('../services/intelligence-bar/estimate-detail');

// The 11-22 miss: monthly, bi-monthly and quarterly pest options on the page,
// the customer took bi-monthly, and the reader quoted the monthly option.
const row = (overrides = {}) => ({
  id: 'est-acc', customer_id: 'cust-1', customer_name: 'Robin Sample', address: '1 Sample Way',
  status: 'accepted', category: 'RESIDENTIAL', service_interest: 'Pest Control', waveguard_tier: 'silver',
  monthly_total: '99999.00', annual_total: '88888.00', onetime_total: null, token: 'tok-acc',
  accepted_at: '2026-11-20T15:00:00Z', price_locked_at: '2026-11-20T15:00:00Z', archived_at: null,
  accepted_service_mode: 'recurring', accepted_frequency_key: 'bimonthly',
  estimate_data: '{}', ...overrides,
});

const pestFrequencies = () => [
  { key: 'monthly', label: 'Monthly', monthlyBase: 80, monthly: 72, perTreatment: 72, visitsPerYear: 12 },
  { key: 'bimonthly', label: 'Bi-monthly', monthlyBase: 50, monthly: 45, perTreatment: 90, visitsPerYear: 6 },
  { key: 'quarterly', label: 'Quarterly', monthlyBase: 40, monthly: 36, perTreatment: 108, visitsPerYear: 4 },
];
const payload = () => ({
  estimate: { id: 'est-acc', status: 'accepted' },
  pricing: {
    manualDiscount: { label: 'Neighbor discount' },
    frequencies: pestFrequencies(),
    services: [
      { key: 'pest_control', label: 'Pest Control', isRecurring: true, defaultFrequencyKey: 'quarterly', frequencies: pestFrequencies() },
      { key: 'rodent_bait', label: 'Rodent Bait Stations', isRecurring: true, defaultFrequencyKey: 'recurring',
        frequencies: [{ key: 'recurring', label: 'Quarterly monitoring', monthly: 30, perTreatment: 90, visitsPerYear: 4 }] },
    ],
  },
  cta: { canAccept: false },
});

beforeEach(() => {
  mockCompose.mockReset();
  mockCompose.mockResolvedValue(payload());
  mockReconcile.mockReset();
  mockCallSideBlock.mockReset();
  mockCallSideBlock.mockResolvedValue(null);
  db.__rows = () => [];
});

test('tool description tells the reader to quote the accepted block', () => {
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/quote the `accepted` block/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/offers the customer did not take/);
});

test('accepted bi-monthly among three options: block carries the bi-monthly price, others are marked not accepted', async () => {
  const shaped = await shapeEstimate(row());
  const pest = shaped.accepted.services.find((s) => s.service_key === 'pest_control');
  expect(pest).toMatchObject({ frequency_key: 'bimonthly', per_visit: 90, visits_per_year: 6, monthly: 45,
    monthly_before_discount: 50, basis: 'accepted_key' });
  expect(shaped.accepted).toMatchObject({ service_mode: 'recurring', frequency: 'bimonthly',
    other_options_not_accepted: true, discount: { label: 'Neighbor discount' } });
  expect(shaped.accepted).not.toHaveProperty('accepted_choice_unknown');
  const options = shaped.page.pricing.services[0].frequencies;
  expect(options.map((o) => [o.key, o.accepted])).toEqual([['monthly', false], ['bimonthly', true], ['quarterly', false]]);
  expect(shaped.page.pricing.frequencies.find((o) => o.key === 'monthly').accepted).toBe(false);
  // A single-cadence section rides along as the only option the plan can hold.
  expect(shaped.accepted.services.find((s) => s.service_key === 'rodent_bait'))
    .toMatchObject({ frequency_key: 'recurring', basis: 'only_option', per_visit: 90 });
  // Stored aggregate columns never become the accepted price.
  expect(JSON.stringify(shaped)).not.toMatch(/99999|88888/);
});

test('one-time acceptance marks every recurring option not accepted', async () => {
  const shaped = await shapeEstimate(row({ accepted_service_mode: 'one_time', accepted_frequency_key: null }));
  expect(shaped.accepted).toMatchObject({ service_mode: 'one_time', services: [], other_options_not_accepted: true });
  expect(shaped.accepted.price_unavailable).toMatch(/no one-time treatment or price/);
  expect(shaped.page.pricing.services[0].frequencies.every((o) => o.accepted === false)).toBe(true);
});

test('an estimate that was not accepted has no accepted block and unmarked options', async () => {
  const shaped = await shapeEstimate(row({ status: 'sent', accepted_at: null, price_locked_at: null,
    accepted_service_mode: null, accepted_frequency_key: null }));
  expect(shaped.accepted).toBeNull();
  expect(shaped.page.pricing.services[0].frequencies.some((o) => 'accepted' in o)).toBe(false);
});

test('an accept with no stored choice says the choice is unknown and leaves options unmarked', async () => {
  const shaped = await shapeEstimate(row({ accepted_service_mode: null, accepted_frequency_key: null }));
  expect(shaped.accepted.accepted_choice_unknown).toMatch(/no accepted service mode or frequency was stored/);
  expect(shaped.accepted).not.toHaveProperty('services');
  expect(shaped.page.pricing.services[0].frequencies.some((o) => 'accepted' in o)).toBe(false);
});

test('accepted choice stays visible when the page is unavailable', async () => {
  mockCompose.mockRejectedValue(new Error('boom'));
  const shaped = await shapeEstimate(row());
  expect(shaped.accepted).toMatchObject({ frequency: 'bimonthly', services: [] });
  expect(shaped.accepted.price_unavailable).toMatch(/could not be composed/);
});

// Bundle fixtures: a pest ladder plus a lawn tier ladder, with the stored
// per-service selection the accept handler writes to customerSelection.
const lawnTiers = () => [
  { key: 'basic', label: 'Basic', monthly: 40, perTreatment: 80, visitsPerYear: 6, manualDiscount: null },
  { key: 'standard', label: 'Standard', monthly: 55, perTreatment: 73, visitsPerYear: 9, manualDiscount: null },
  { key: 'enhanced', label: 'Enhanced', monthly: 70, perTreatment: 70, visitsPerYear: 12, manualDiscount: { label: 'Neighbor discount', amount: 5 } },
];
const neighborCredit = () => ({ label: 'Neighbor discount', amount: 5 });
const bundlePayload = ({ billsMonthly = true, lawn = lawnTiers(), combos } = {}) => ({
  estimate: { id: 'est-acc', status: 'accepted' },
  pricing: {
    manualDiscount: neighborCredit(),
    services: [
      { key: 'pest_control', label: 'Pest Control', isRecurring: true, defaultFrequencyKey: 'quarterly', frequencies: pestFrequencies() },
      { key: 'lawn_care', label: 'Lawn Care', isRecurring: true, defaultFrequencyKey: 'standard', frequencies: lawn },
    ],
    serviceCadenceCombos: combos || [
      { key: 'p-bimonthly-l-enhanced', selection: { pest_control: 'bimonthly', lawn_care: 'enhanced' }, monthly: 115, manualDiscount: neighborCredit() },
      { key: 'p-bimonthly-l-standard', selection: { pest_control: 'bimonthly', lawn_care: 'standard' }, monthly: 100, manualDiscount: null },
      { key: 'p-monthly-l-enhanced', selection: { pest_control: 'monthly', lawn_care: 'enhanced' }, monthly: 142, manualDiscount: null },
    ],
  },
  cta: { canAccept: false, monthlyBilled: billsMonthly },
});
const bundleRow = (cadences) => row({ estimate_data: JSON.stringify(cadences ? { customerSelection: { serviceCadences: cadences } } : {}) });

test('bundle: each service resolves from its own stored selection, not the pest key', async () => {
  mockCompose.mockResolvedValue(bundlePayload());
  const shaped = await shapeEstimate(bundleRow({ lawn_care: 'enhanced' }));
  const byKey = (k) => shaped.accepted.services.find((s) => s.service_key === k);
  expect(byKey('pest_control')).toMatchObject({ frequency_key: 'bimonthly', basis: 'accepted_key' });
  expect(byKey('lawn_care')).toMatchObject({ frequency_key: 'enhanced', basis: 'stored_service_cadence', per_visit: 70 });
  const lawnRows = shaped.page.pricing.services[1].frequencies;
  expect(lawnRows.map((o) => [o.key, o.accepted])).toEqual([['basic', false], ['standard', false], ['enhanced', true]]);
  expect(shaped.page.pricing.serviceCadenceCombos.map((c) => c.accepted)).toEqual([true, false, false]);
});

test('bundle: a service the stored selection cannot resolve is unknown, never its default tier', async () => {
  mockCompose.mockResolvedValue(bundlePayload());
  const shaped = await shapeEstimate(bundleRow(null));
  const lawn = shaped.accepted.services.find((s) => s.service_key === 'lawn_care');
  expect(lawn.accepted_choice_unknown).toMatch(/does not identify/);
  expect(lawn).not.toHaveProperty('frequency_key');
  expect(shaped.page.pricing.services[1].frequencies.every((o) => o.accepted === null)).toBe(true);
  expect(shaped.accepted.services.find((s) => s.service_key === 'pest_control')).toMatchObject({ frequency_key: 'bimonthly' });
  expect(shaped.page.pricing.serviceCadenceCombos.some((c) => 'accepted' in c)).toBe(false);
});

test('discount comes from the chosen combination and honors suppression', async () => {
  mockCompose.mockResolvedValue(bundlePayload());
  const granted = await shapeEstimate(bundleRow({ lawn_care: 'enhanced' }));
  expect(granted.accepted.discount).toEqual(neighborCredit());

  // The plan-level credit stays populated, but the chosen combination's lawn minimum suppressed it.
  mockCompose.mockResolvedValue(bundlePayload({ combos: [
    { key: 'a', selection: { pest_control: 'bimonthly', lawn_care: 'basic' }, monthly: 90, manualDiscount: null, manualDiscountSuppressed: true },
    { key: 'b', selection: { pest_control: 'bimonthly', lawn_care: 'enhanced' }, monthly: 115, manualDiscount: neighborCredit() },
  ] }));
  const suppressed = await shapeEstimate(bundleRow({ lawn_care: 'basic' }));
  expect(suppressed.accepted).toMatchObject({ discount: null, discount_suppressed: true });

  // No combination to read: the chosen tier row's own suppression still wins over the plan credit.
  const tiers = lawnTiers();
  tiers[0].manualDiscountSuppressed = true;
  const noCombos = bundlePayload({ lawn: tiers });
  delete noCombos.pricing.serviceCadenceCombos;
  mockCompose.mockResolvedValue(noCombos);
  const rowSuppressed = await shapeEstimate(bundleRow({ lawn_care: 'basic' }));
  expect(rowSuppressed.accepted).toMatchObject({ discount: null, discount_suppressed: true });
  expect(rowSuppressed.accepted.services.find((s) => s.service_key === 'lawn_care')).toMatchObject({ discount_suppressed: true });
});

test('combined residential plan: a stripped combination yields discount_unavailable, not the plan credit', async () => {
  mockCompose.mockResolvedValue(bundlePayload({ billsMonthly: false }));
  const shaped = await shapeEstimate(bundleRow({ lawn_care: 'enhanced' }));
  expect(shaped.accepted.discount).toBeNull();
  expect(shaped.accepted.discount_unavailable).toMatch(/combined plan/);
  expect(shaped.page.pricing.serviceCadenceCombos.map((c) => c.accepted)).toEqual([true, false, false]);
});

test('one-time acceptance carries the accepted treatment and its displayed price', async () => {
  const withOneTime = payload();
  withOneTime.pricing.oneTimeBreakdown = { items: [{ service: 'pest_initial_roach', label: 'Initial roach treatment', amount: 185, kind: 'charge', detail: 'x' }], total: 185 };
  withOneTime.pricing.anchorOneTimePrice = 185;
  mockCompose.mockResolvedValue(withOneTime);
  const shaped = await shapeEstimate(row({ accepted_service_mode: 'one_time', accepted_frequency_key: null }));
  expect(shaped.accepted.one_time).toEqual({ price: 185, items: [{ service: 'pest_initial_roach', label: 'Initial roach treatment', amount: 185, kind: 'charge' }] });
  expect(shaped.accepted).not.toHaveProperty('price_unavailable');
});
