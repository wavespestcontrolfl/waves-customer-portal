/**
 * invoice-tier-line-check.js: the nightly check for a WaveGuard tier saving an invoice would leave out. The invoice
 * decision (completion-pricing.js acceptedVisitBreakdown) is mocked, with the estimate row and the schedule line it
 * matched. The invoice's own line pricing (acceptedPricing) and staff-discount reader stay the real ones: this suite
 * proves the witness (the estimate's own engine line record and the records that must agree with it), the question the
 * check asks of that pricing, and which visits it reads. completion-pricing.postgres.test.js runs the check on the real
 * decision. Synthetic estimates in the saved engine shape (memory saved-estimate-tier-shape-trap); no real figures.
 */
jest.mock('../services/completion-pricing', () => {
  const actual = jest.requireActual('../services/completion-pricing');
  return { ...actual, acceptedVisitBreakdown: jest.fn(), acceptedPricing: jest.fn(actual.acceptedPricing) };
});
// The real module, one reader overridden: estimate-public (recurringServiceKey) reads other gates when it loads.
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), invoiceEstimateDiscountLinesLive: jest.fn(() => true) }));

const { acceptedVisitBreakdown, acceptedPricing } = require('../services/completion-pricing');
const { invoiceEstimateDiscountLinesLive } = require('../config/feature-gates');
const { recurringServiceKey } = require('../routes/estimate-public');
const { tierSavingsLeftOffInvoices, _private: { engineTierRecord, pricingRecords } } = require('../services/invoice-tier-line-check');

const TODAY = '2026-06-15';

// A knex stand-in for the visit query: it returns `visits`. The check reads nothing else itself.
function fakeDb(visits = []) {
  const chain = {};
  for (const m of ['join', 'leftJoin', 'where', 'whereNull', 'whereIn', 'whereRaw', 'orderBy']) chain[m] = jest.fn(() => chain);
  chain.select = jest.fn(async () => visits);
  return jest.fn(() => chain);
}

const waveguard = (amount, tier = 'gold') => ({ appliedDiscounts: [{ type: 'waveguard', tier, amount }] });
// $100 a visit, 4 visits, Gold 15%: $400 list, $340 net, $85 a visit.
const pestItem = (extra = {}) => ({ service: 'pest_control', perApp: 100, visitsPerYear: 4, annual: 400, annualBeforeDiscount: 400,
  annualAfterDiscount: 340, discount: waveguard(0.15), ...extra });
// $140 a visit, 9 visits, 20%: $1,260 list, $1,008 net, $112 a visit.
const lawnItem = (extra = {}) => ({ service: 'lawn_care', perApp: 140, visitsPerYear: 9, annual: 1260, annualBeforeDiscount: 1260,
  annualAfterDiscount: 1008, discount: waveguard(0.2), ...extra });
// A plan's one-time first-visit fee: no annual. It maps to the plan's key.
const firstVisitFee = { service: 'pest_initial_roach', price: 49, priceBeforeDiscount: 49, priceAfterDiscount: 49, discount: { appliedDiscounts: [] } };
const gold = { tier: 'Gold', waveGuardTier: 'Gold' };
const estimate = ({ lineItems = [pestItem()], tier = 'Gold', recurring = gold, data } = {}) => ({
  id: 'e1', waveguard_tier: tier, estimate_data: JSON.stringify(data || { engineResult: { lineItems }, result: { recurring } }) });
// The saved rows the mapper writes from those lines (v1-legacy-mapper.js svcAdd).
const pestRow = { service: 'pest_control', name: 'Pest Control', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 340 };
const lawnRow = { service: 'lawn_care', name: 'Lawn Care', perTreatment: 140, visitsPerYear: 9, annualAfterDiscount: 1008 };
// The schedule line the invoice matched (admin-customers.js scheduleLinesFromEstimate), with its saved row.
const scheduleLine = (sourceLine = pestRow, extra = {}) => ({ source: 'recurring', cadence: 'quarterly', perApplicationPrice: 85,
  serviceKey: 'pest_control_quarterly', sourceLine, ...extra });
const visit = (extra = {}) => ({ id: 'v1', source_estimate_id: 'e1', service_type: 'Quarterly Pest Control Service', estimated_price: '85.00', ...extra });
const unnamed = (extra = {}) => ({ breakdown: null, reason: 'discount_unnamed', estimate: estimate(), line: scheduleLine(), ...extra });
const lines = (...names) => ({ breakdown: { base: 100, amount: 85, discounts: names.map((name) => ({ name, dollars: 15 / names.length })) } });
const findingsFor = async (actual, row = visit()) => {
  acceptedVisitBreakdown.mockResolvedValue(actual);
  return (await tierSavingsLeftOffInvoices(fakeDb([row]), { today: TODAY })).findings;
};
const findingsOn = (records, extra = {}) => findingsFor(unnamed({ estimate: estimate(records), ...extra }));
const pricedWith = () => acceptedPricing.mock.calls.map(([, context]) => context.estimateTier);

beforeEach(() => {
  jest.clearAllMocks();
  invoiceEstimateDiscountLinesLive.mockReturnValue(true);
});

describe('tierSavingsLeftOffInvoices', () => {
  test('a saving the invoice leaves unnamed, which its own pricing names with the engine\'s tier and rate, is a finding', async () => {
    const conn = fakeDb([visit()]);
    acceptedVisitBreakdown.mockResolvedValue(unnamed());
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({
      checked: 1, findings: [{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', tier: 'gold' }],
    });
    expect(acceptedVisitBreakdown.mock.calls).toEqual([[visit(), { database: conn }]]);
    // The invoice's own discount context (estimateDiscountContext), with only its tier reading replaced.
    expect(acceptedPricing.mock.calls).toEqual([[scheduleLine(), { manualName: null, tierDiscounted: true, estimateTier: { tier: 'gold', amount: 0.15 } }]]);
    jest.clearAllMocks();
    expect(await findingsOn({ tier: null, recurring: {} })).toHaveLength(1);
    expect(acceptedPricing.mock.calls[0][1]).toEqual({ manualName: null, tierDiscounted: false, estimateTier: { tier: 'gold', amount: 0.15 } });
  });

  // The invoice's own row rules keep one line on purpose; given the engine's tier and rate, its pricing still does.
  test('a row the invoice keeps on one line by its own rules is not a finding, even with the engine\'s tier and rate', async () => {
    const keeps = [
      { ...pestRow, serviceSpecificDiscounts: [{ amount: 5 }] }, // a service credit shares the saving
      { ...pestRow, manualFinalAnnual: 339.96 }, // staff moved the row's own price
      { ...pestRow, excludeFromPctDiscount: true }, // the row is out of percentage discounts
      { ...pestRow, discount: { effectiveDiscount: 0.1 } }, // the row recorded another rate
      { ...pestRow, priceAfterDiscount: 84.99 }, // the row's own net is not the billed net
      { ...pestRow, annualAfterDiscount: 352 }, // the row's saved annual is not the tier's
    ];
    for (const row of keeps) expect(await findingsFor(unnamed({ line: scheduleLine(row) }))).toEqual([]);
    expect(acceptedPricing).toHaveBeenCalledTimes(keeps.length);
    expect(await findingsFor(unnamed())).toHaveLength(1);
  });

  // completion-pricing.js estimateDiscountContext and savedEstimateTier name no tier for these estimates on purpose.
  test('an estimate the invoice names no tier for by design is not a finding: staff discount on recurring work, nested block', async () => {
    const withData = (extra, recurring = gold) => findingsOn({ data: { engineResult: { lineItems: [pestItem()] }, result: { recurring }, ...extra } });
    expect(await withData({ summary: { manualDiscount: { amount: 5, recurringAmount: 5, label: 'Courtesy' } } })).toEqual([]);
    expect(await withData({}, { ...gold, manualDiscount: { amount: 5 } })).toEqual([]);
    expect(await withData({ engineResult: { lineItems: [pestItem()], summary: { manualDiscount: { amount: 5 } } } })).toEqual([]);
    expect(await withData({}, { ...gold, results: undefined })).toHaveLength(1);
    const nested = { result: { recurring: gold, results: { recurring: { services: [{ service: 'pest_control' }] } } } };
    expect(await findingsOn({ data: { ...nested, engineResult: { lineItems: [pestItem()] } } })).toEqual([]);
    expect(acceptedPricing).toHaveBeenCalledTimes(1);
    // A staff discount saved as one-time only does not reach recurring work.
    expect(await withData({ summary: { manualDiscount: { amount: 5, recurringAmount: 0, label: 'Courtesy' } } })).toHaveLength(1);
  });

  test('an invoice that names the tier is not read; lines that name only another discount are', async () => {
    expect(await findingsFor(lines('WaveGuard Gold'))).toEqual([]);
    expect(acceptedPricing).not.toHaveBeenCalled();
    expect(await findingsFor({ ...lines('Courtesy'), estimate: estimate(), line: scheduleLine() })).toHaveLength(1);
  });

  test.each(['no_discount', 'price_changed', 'not_priced', 'own_price_or_discount', 'prepaid', 'line_unmatched', 'line_ambiguous'])(
    'a visit that keeps one line for %s is not read', async (reason) => {
      expect(await findingsFor({ breakdown: null, reason })).toEqual([]);
      expect(acceptedPricing).not.toHaveBeenCalled();
    },
  );

  // Pre-push audit P1 (twice): the invoice matches a visit to its line by service id or key; the visit's label is
  // display text, and a row saved without a service field takes the key the schedule matched it to.
  test('the saved row the invoice matched names the service, else the key it was matched to', async () => {
    const both = estimate({ lineItems: [pestItem(), lawnItem()] });
    const keyFor = async (actual, row = visit()) => (await findingsFor(actual, row)).map((f) => f.serviceKey);
    expect(await keyFor(unnamed({ estimate: both }), visit({ service_type: 'Home Protection Plan' }))).toEqual(['pest_control']);
    expect(await keyFor(unnamed({ estimate: both }), visit({ service_type: 'Lawn Care' }))).toEqual(['pest_control']);
    expect(await keyFor(unnamed({ estimate: both, line: scheduleLine(lawnRow, { serviceKey: 'lawn_care', perApplicationPrice: 112 }) })))
      .toEqual(['lawn_care']);
    const plan = { serviceKey: 'pest_control', name: 'Home Protection Plan', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 340 };
    expect(recurringServiceKey(plan)).toBe('home_protection_plan');
    expect(await keyFor(unnamed({ line: scheduleLine(plan) }))).toEqual(['pest_control']);
    expect(await keyFor(unnamed({ line: scheduleLine(plan, { serviceKey: null }) }))).toEqual([]);
    expect(await keyFor(unnamed({ line: null }))).toEqual([]);
  });

  // Pre-push audit P1: a plan's one-time first-visit fee maps to the plan's key; only recurring lines are read.
  test('a one-time engine line with the plan\'s key does not hide the plan\'s line', async () => {
    expect(recurringServiceKey(firstVisitFee)).toBe('pest_control');
    expect(await findingsOn({ lineItems: [pestItem(), firstVisitFee] })).toHaveLength(1);
    expect(await findingsOn({ lineItems: [pestItem(), pestItem({ perApp: 120 })] })).toEqual([]);
  });

  // Pre-push audit P1: the engine lines come from the saved result the estimate's lines come from.
  test('the engine lines are the ones of the result the estimate\'s lines come from', async () => {
    expect(await findingsOn({ data: { result: { lineItems: [pestItem()], recurring: gold } } })).toHaveLength(1);
    // Its own lines win over an older engine result kept beside it (Silver there, which the Gold column disputes).
    const older = { lineItems: [pestItem({ discount: waveguard(0.1, 'silver'), annualAfterDiscount: 360 })] };
    expect(await findingsOn({ data: { result: { lineItems: [pestItem()], recurring: gold }, engineResult: older } })).toHaveLength(1);
    expect(await findingsOn({ data: { result: { recurring: gold }, engineResult: older } })).toEqual([]);
  });

  test('the engine line must hold the tier as its only discount, at one rate', async () => {
    const cases = [
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }, { type: 'manual', amount: 0.05 }] } })],
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }, { type: 'waveguard', amount: 0.15 }] } })],
      [pestItem({ discount: waveguard(1.5) })],
      [pestItem({ discount: { appliedDiscounts: [] } })],
      [pestItem({ discount: {} })],
      [lawnItem()],
      [],
    ];
    for (const lineItems of cases) expect(await findingsOn({ lineItems })).toEqual([]);
    expect(await findingsFor(unnamed({ estimate: null }))).toEqual([]);
    expect(acceptedPricing).not.toHaveBeenCalled();
  });

  // Pre-push audit P1: an empty tier column does not hide the engine's tier; records that disagree name no saving.
  test('the tier comes from the estimate\'s records: the engine\'s, the column and the saved block must not disagree', async () => {
    const tierFor = async (records) => (await findingsOn(records)).map((f) => f.tier);
    expect(await tierFor({ tier: null })).toEqual(['gold']);
    expect(await tierFor({ tier: null, recurring: {} })).toEqual(['gold']);
    expect(await tierFor({ lineItems: [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }] } })] })).toEqual(['gold']);
    expect(await tierFor({ tier: 'Silver' })).toEqual([]);
    expect(await tierFor({ tier: null, recurring: { tier: 'Silver' } })).toEqual([]);
    expect(await tierFor({ tier: 'Bronze', recurring: { tier: 'Bronze' }, lineItems: [pestItem({ discount: waveguard(0.15, 'bronze') })] })).toEqual([]);
  });

  // Pre-push audit P1: a saved 0 is a rate, and the invoice reads the send snapshot first.
  test('the rate the estimate saved for its tier, as the invoice reads it, must be the engine line\'s rate', async () => {
    const withData = (extra, recurring = gold) => findingsOn({ data: { engineResult: { lineItems: [pestItem()] }, result: { recurring }, ...extra } });
    const snapshot = (tierDiscounts) => ({ sendSnapshot: { tierDiscounts } });
    expect(await withData({}, { ...gold, discount: 0.15 })).toHaveLength(1);
    expect(await withData({}, { ...gold, discount: 0.1 })).toEqual([]);
    expect(await withData({}, { ...gold, discount: 0 })).toEqual([]);
    expect(await withData(snapshot({ Gold: 0.15 }))).toHaveLength(1);
    expect(await withData(snapshot({ Gold: 0.1 }))).toEqual([]);
    expect(await withData(snapshot({ Gold: 0 }))).toEqual([]);
    expect(await withData(snapshot({ gold: 0 }))).toEqual([]);
    // The snapshot wins over the block's rate; a block that names no tier saved no rate for it.
    expect(await withData(snapshot({ Gold: 0.15 }), { ...gold, discount: 0 })).toHaveLength(1);
    expect(await withData(snapshot({ Gold: 0 }), { ...gold, discount: 0.15 })).toEqual([]);
    expect(await withData({}, { discount: 0.1 })).toHaveLength(1);
    // The invoice's pricing gets the engine line's own rate, and that rate must price the row.
    jest.clearAllMocks();
    expect(await findingsOn({ lineItems: [pestItem({ discount: waveguard(0.1) })] })).toEqual([]);
    expect(pricedWith()).toEqual([{ tier: 'gold', amount: 0.1 }]);
  });

  test('gate off: every invoice keeps one line by design, so no visit is read', async () => {
    invoiceEstimateDiscountLinesLive.mockReturnValue(false);
    const conn = fakeDb([visit()]);
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({ checked: 0, findings: [] });
    expect(conn).not.toHaveBeenCalled();
    expect(acceptedVisitBreakdown).not.toHaveBeenCalled();
  });

  test('a visit the invoice decision cannot read fails the run: a check that did not run proves nothing', async () => {
    acceptedVisitBreakdown.mockRejectedValue(new Error('read failed'));
    await expect(tierSavingsLeftOffInvoices(fakeDb([visit()]), { today: TODAY })).rejects.toThrow('read failed');
    acceptedVisitBreakdown.mockReset();
    acceptedVisitBreakdown.mockResolvedValueOnce(unnamed()).mockRejectedValueOnce(new Error('second read failed'));
    await expect(tierSavingsLeftOffInvoices(fakeDb([visit(), visit({ id: 'v2' })]), { today: TODAY })).rejects.toThrow('second read failed');
  });

  test('the visit query reads today through 90 days ahead by default', async () => {
    const conn = fakeDb();
    await tierSavingsLeftOffInvoices(conn, { today: TODAY });
    const chain = conn.mock.results[0].value;
    expect(conn).toHaveBeenCalledWith('scheduled_services as s');
    expect(chain.whereRaw).toHaveBeenCalledWith('s.scheduled_date >= ?::date AND s.scheduled_date < ?::date + ?::int', [TODAY, TODAY, 90]);
  });
});

describe('pricingRecords', () => {
  test('the result the lines come from, its block, and its own engine lines, else the engine result beside it', () => {
    const own = pestItem(); const beside = lawnItem();
    expect(pricingRecords({ result: { recurring: gold, lineItems: [own] }, engineResult: { lineItems: [beside] } }))
      .toEqual({ block: gold, lineItems: [own] });
    expect(pricingRecords({ result: { recurring: gold }, engineResult: { lineItems: [beside] } })).toEqual({ block: gold, lineItems: [beside] });
    expect(pricingRecords({ engineResult: { recurring: gold, lineItems: [beside] } })).toEqual({ block: gold, lineItems: [beside] });
    expect(pricingRecords({})).toEqual({ block: {}, lineItems: [] });
  });
});

describe('engineTierRecord', () => {
  test('the tier and rate of the one recurring engine line of the service', () => {
    expect(engineTierRecord([pestItem(), firstVisitFee], 'pest_control')).toEqual({ rate: 0.15, tier: 'gold' });
    expect(engineTierRecord([lawnItem({ discount: waveguard(0.2, 'platinum') })], 'lawn_care')).toEqual({ rate: 0.2, tier: 'platinum' });
    const shrub = { service: 'tree_shrub', visitsPerYear: 6, annualBeforeDiscount: 600, annualAfterDiscount: 540, discount: waveguard(0.1, 'silver') };
    expect(engineTierRecord([shrub], 'tree_shrub')).toEqual({ rate: 0.1, tier: 'silver' });
  });

  test('no recurring line of the service, or two of them, name no record', () => {
    expect(engineTierRecord([firstVisitFee], 'pest_control')).toBeNull();
    expect(engineTierRecord([pestItem(), pestItem({ perApp: 120 })], 'pest_control')).toBeNull();
    expect(engineTierRecord([pestItem({ annual: undefined, annualBeforeDiscount: undefined, annualAfterDiscount: undefined })], 'pest_control')).toBeNull();
    expect(engineTierRecord([], 'pest_control')).toBeNull();
  });
});
