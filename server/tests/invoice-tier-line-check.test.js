/**
 * invoice-tier-line-check.js: the nightly check for a WaveGuard tier saving an invoice would leave out. The invoice
 * decision (completion-pricing.js acceptedVisitBreakdown) is mocked, with the estimate row and the saved row it matched:
 * this suite proves the witness (the estimate's own engine line record) and which visits it reads. The staff-discount
 * reader stays the real one. completion-pricing.postgres.test.js runs the check on the real decision. Synthetic
 * estimates in the saved engine shape (memory saved-estimate-tier-shape-trap); no real figures.
 */
jest.mock('../services/completion-pricing', () => ({ ...jest.requireActual('../services/completion-pricing'), acceptedVisitBreakdown: jest.fn() }));
// The real module, one reader overridden: estimate-public (recurringServiceKey) reads other gates when it loads.
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), invoiceEstimateDiscountLinesLive: jest.fn(() => true) }));

const { acceptedVisitBreakdown } = require('../services/completion-pricing');
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
// A plan's one-time first-visit fee: no annual.
const firstVisitFee = { service: 'pest_initial_roach', price: 49, priceBeforeDiscount: 49, priceAfterDiscount: 49, discount: { appliedDiscounts: [] } };
const gold = { tier: 'Gold', waveGuardTier: 'Gold' };
const estimate = ({ lineItems = [pestItem()], tier = 'Gold', recurring = gold, data } = {}) => ({
  id: 'e1', waveguard_tier: tier, estimate_data: JSON.stringify(data || { engineResult: { lineItems }, result: { recurring } }) });
// The saved rows the mapper writes from those lines (v1-legacy-mapper.js svcAdd).
const pestRow = { service: 'pest_control', name: 'Pest Control', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 340 };
const lawnRow = { service: 'lawn_care', name: 'Lawn Care', perTreatment: 140, visitsPerYear: 9, annualAfterDiscount: 1008 };
const visit = (extra = {}) => ({ id: 'v1', source_estimate_id: 'e1', service_type: 'Quarterly Pest Control Service', estimated_price: '85.00', ...extra });
const unnamed = (extra = {}) => ({ breakdown: null, reason: 'discount_unnamed', estimate: estimate(), line: pestRow, ...extra });
const findingsFor = async (row, decision) => {
  acceptedVisitBreakdown.mockResolvedValue(decision);
  return (await tierSavingsLeftOffInvoices(fakeDb([row]), { today: TODAY })).findings;
};
const findingsOn = (records, extra = {}) => findingsFor(visit(extra.visit), unnamed({ estimate: estimate(records), ...extra.decision }));

beforeEach(() => {
  jest.clearAllMocks();
  invoiceEstimateDiscountLinesLive.mockReturnValue(true);
});

describe('tierSavingsLeftOffInvoices', () => {
  test('a visit whose saving is the engine\'s tier rate on the list price, left unnamed on the invoice, is a finding', async () => {
    const conn = fakeDb([visit()]);
    acceptedVisitBreakdown.mockResolvedValue(unnamed());
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({
      checked: 1, findings: [{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', tier: 'gold' }],
    });
    expect(acceptedVisitBreakdown).toHaveBeenCalledWith(visit(), { database: conn });
  });

  test('an invoice that names the tier is not a finding; lines that name only another discount are read like an unnamed saving', async () => {
    const lines = (name) => ({ breakdown: { base: 100, amount: 85, discounts: [{ name, dollars: 15 }] }, estimate: estimate(), line: pestRow });
    expect(await findingsFor(visit(), lines('WaveGuard Gold'))).toEqual([]);
    expect(await findingsFor(visit(), lines('Courtesy'))).toHaveLength(1);
  });

  test.each(['no_discount', 'price_changed', 'not_priced', 'own_price_or_discount', 'prepaid', 'line_unmatched'])(
    'a visit that keeps one line for %s is not a finding', async (reason) => {
      expect(await findingsFor(visit(), { breakdown: null, reason })).toEqual([]);
    },
  );

  // Pre-push audit P1: the invoice matches a visit to its line by service id or key; the visit's label is display text.
  test('the saved row the invoice matched names the service, not the visit\'s label', async () => {
    const both = estimate({ lineItems: [pestItem(), lawnItem()] });
    const keyFor = async (row, decision) => (await findingsFor(row, decision)).map((f) => f.serviceKey);
    expect(await keyFor(visit({ service_type: 'Home Protection Plan' }), unnamed({ estimate: both }))).toEqual(['pest_control']);
    expect(await keyFor(visit({ service_type: 'Lawn Care' }), unnamed({ estimate: both }))).toEqual(['pest_control']);
    expect(await keyFor(visit({ estimated_price: '112.00' }), unnamed({ estimate: both, line: lawnRow }))).toEqual(['lawn_care']);
    expect(await keyFor(visit(), unnamed({ line: null }))).toEqual([]);
  });

  // Pre-push audit P1: a plan's one-time first-visit fee maps to the plan's key; only recurring lines are matched.
  test('a one-time engine line with the plan\'s key does not hide the plan\'s line', async () => {
    expect(recurringServiceKey(firstVisitFee)).toBe('pest_control');
    expect(await findingsOn({ lineItems: [pestItem(), firstVisitFee] })).toHaveLength(1);
  });

  // Pre-push audit P1: the engine lines come from the saved result the estimate's lines come from.
  test('the engine lines of the result the lines come from, and only the same pricing revision as the matched row', async () => {
    // An engine result saved whole, with its lines on the result itself.
    expect(await findingsOn({ data: { result: { lineItems: [pestItem()], recurring: gold } } })).toHaveLength(1);
    // Its own lines win over an older engine result kept beside it.
    const older = { lineItems: [pestItem({ discount: waveguard(0.1, 'silver'), annualAfterDiscount: 360 })] };
    expect(await findingsOn({ data: { result: { lineItems: [pestItem()], recurring: gold }, engineResult: older } })).toHaveLength(1);
    // A reprice replaced the mapped row ($339.96 a year, $84.99 a visit) and kept an older engine result: not the row's
    // revision, so no finding, though the saving is 1 cent off the older line's tier share.
    expect(await findingsOn({}, { visit: { estimated_price: '84.99' }, decision: { line: { ...pestRow, annualAfterDiscount: 339.96 } } })).toEqual([]);
    expect(await findingsOn({}, { decision: { line: { ...pestRow, perTreatment: 110 } } })).toEqual([]);
    expect(await findingsOn({}, { decision: { line: { ...pestRow, manualFinalAnnual: 339.96 } } })).toEqual([]);
    // The row's list price is its first per-visit price, as the invoice reads it.
    const noTreatment = { service: 'pest_control', name: 'Pest Control', visitsPerYear: 4, annualAfterDiscount: 340 };
    expect(await findingsOn({}, { decision: { line: { ...noTreatment, perApp: 110 } } })).toEqual([]);
    expect(await findingsOn({}, { decision: { line: { ...noTreatment, perApp: 100 } } })).toHaveLength(1);
  });

  // Every reason the invoice names no tier by design (completion-pricing.js namingTier, savedEstimateTier) is not a finding.
  test('a row the tier percentage does not reach, or a legacy nested block, keeps one line by design', async () => {
    const on = (line, records = {}) => findingsOn(records, { decision: { line } });
    expect(await on({ ...pestRow, discountable: false })).toEqual([]);
    expect(await on({ ...pestRow, waveGuardDiscountEligible: false })).toEqual([]);
    expect(await on({ ...pestRow, excludeFromPctDiscount: true })).toEqual([]);
    // A rate the row recorded for itself must be the engine line's rate.
    expect(await on({ ...pestRow, discount: { effectiveDiscount: 0.1 } })).toEqual([]);
    expect(await on({ ...pestRow, discount: { appliedDiscountPercent: 0.15, effectiveDiscount: 0.15 } })).toHaveLength(1);
    // Palm injection takes a flat tier credit, not the percentage, unless the row saved that it takes the percentage.
    const palm = { lineItems: [pestItem({ service: 'palm_injection' })] };
    const palmRow = { ...pestRow, service: 'palm_injection', name: 'Palm Injection' };
    expect(await on(palmRow, palm)).toEqual([]);
    expect(await on({ ...palmRow, waveGuardDiscountEligible: true }, palm)).toHaveLength(1);
    // The legacy nested block also supplies service rows: which block priced the line is then unknown.
    const nested = (services) => ({ data: { engineResult: { lineItems: [pestItem()] }, result: { recurring: gold, results: { recurring: { services } } } } });
    expect(await findingsOn(nested([pestRow]))).toEqual([]);
    expect(await findingsOn(nested([]))).toHaveLength(1);
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
  });

  // Pre-push audit P1: a row with its own per-visit net proves the tier to the cent, as the invoice requires.
  test('a row with its own per-visit net bills the tier\'s net only to the cent', async () => {
    const own = (net, price = net, records = {}, row = {}) => findingsOn(records,
      { visit: { estimated_price: price }, decision: { line: { ...pestRow, priceAfterDiscount: net, ...row } } });
    expect(await own(85)).toHaveLength(1);
    expect(await own(85.04)).toEqual([]);
    expect(await own(85, 85.04)).toEqual([]);
    // $100.10 at 15% is $85.085: either neighbour is the tier's net.
    const halfCent = { lineItems: [pestItem({ perApp: 100.1, annualBeforeDiscount: 400.4, annualAfterDiscount: 340.34 })] };
    const halfRow = { perTreatment: 100.1, annualAfterDiscount: 340.34 };
    expect(await own(85.08, 85.08, halfCent, halfRow)).toHaveLength(1);
    expect(await own(85.09, 85.09, halfCent, halfRow)).toHaveLength(1);
    expect(await own(85.1, 85.1, halfCent, halfRow)).toEqual([]);
  });

  // The engine discounts the annual, so a few cents off the tier's share is its rounding; more is not the tier alone.
  test.each([
    ['85.04', 1], ['84.95', 1], ['80.00', 0], ['84.90', 0], ['100.00', 0], ['101.00', 0],
  ])('a visit billed %s against a $100 list at 15%% gives %i finding', async (price, n) => {
    expect(await findingsFor(visit({ estimated_price: price }), unnamed())).toHaveLength(n);
  });

  // Pre-push audit P1 (twice): a staff change to $84.99 sits within the rounding allowance, so every record of a staff
  // discount, a credit or a floor must stop the finding first.
  test('a staff discount on recurring work, a service credit or a floor on the line is not the tier alone', async () => {
    const billed = (price, records, line = pestRow) => findingsOn(records, { visit: { estimated_price: price }, decision: { line } });
    expect(await billed('84.99', { lineItems: [pestItem({ manualFinalAnnual: 339.96 })] })).toEqual([]);
    expect(await billed('85.00', { lineItems: [pestItem(), lawnItem({ manualFinalAnnual: 1000 })] })).toEqual([]);
    // A staff discount kept only in the estimate's saved summary (completion-pricing.js staffDiscountOnRecurring).
    const summary = { manualDiscount: { amount: 0.04, recurringAmount: 0.04, label: 'Courtesy' } };
    expect(await billed('84.99', { data: { engineResult: { lineItems: [pestItem()] }, result: { recurring: gold }, summary } })).toEqual([]);
    expect(await billed('84.99', { lineItems: [pestItem({ serviceSpecificDiscounts: [{ presetKey: 'credit', amount: 0.04 }] })] })).toEqual([]);
    expect(await billed('84.99', {}, { ...pestRow, serviceSpecificDiscounts: [{ presetKey: 'credit', amount: 0.04 }] })).toEqual([]);
    // A floor raised the lawn net to $1,008.36 ($112.04 a visit): 4 cents off the share, but not the tier's rate.
    expect(await billed('112.04', { lineItems: [lawnItem({ annualAfterDiscount: 1008.36 })] }, { ...lawnRow, annualAfterDiscount: 1008.36 })).toEqual([]);
    // The tier's annual is exact to the cent (a half cent rounds either way): 1 cent over is not the tier alone either.
    expect(await billed('112.00', { lineItems: [lawnItem({ annualAfterDiscount: 1008.01 })] }, { ...lawnRow, annualAfterDiscount: 1008.01 })).toEqual([]);
    expect(await billed('112.00', { lineItems: [lawnItem()] }, lawnRow)).toHaveLength(1);
  });

  test('the engine record must hold the tier as its only discount, on one recurring line of the service', async () => {
    const cases = [
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }, { type: 'manual', amount: 0.05 }] } })],
      [pestItem({ discount: { appliedDiscounts: [] } })],
      [pestItem({ discount: {} })],
      [pestItem(), pestItem()],
      [lawnItem()],
    ];
    for (const lineItems of cases) expect(await findingsOn({ lineItems })).toEqual([]);
    expect(await findingsOn({ data: { result: { recurring: gold } } })).toEqual([]);
    expect(await findingsFor(visit(), unnamed({ estimate: null }))).toEqual([]);
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
  test('the per-visit list price: the line\'s own, else its list annual over its visits', () => {
    expect(engineTierRecord([pestItem()], pestRow, 'pest_control')).toEqual({ rate: 0.15, listCents: 10000, tier: 'gold' });
    expect(engineTierRecord([lawnItem({ discount: waveguard(0.2, 'platinum') })], lawnRow, 'lawn_care'))
      .toEqual({ rate: 0.2, listCents: 14000, tier: 'platinum' });
    // The tree and shrub shape: the item's own per-visit price, or none.
    const shrub = (extra) => ({ service: 'tree_shrub', visitsPerYear: 6, discount: waveguard(0.1, 'silver'), ...extra });
    const shrubRow = { service: 'tree_shrub', name: 'Tree & Shrub' };
    expect(engineTierRecord([shrub({ perApp: 90.5, annualBeforeDiscount: 543, annualAfterDiscount: 488.7 })], { ...shrubRow, perTreatment: 90.5 }, 'tree_shrub'))
      .toEqual({ rate: 0.1, listCents: 9050, tier: 'silver' });
    expect(engineTierRecord([shrub({ annualBeforeDiscount: 600, annualAfterDiscount: 540 })], shrubRow, 'tree_shrub'))
      .toEqual({ rate: 0.1, listCents: 10000, tier: 'silver' });
    // No price of its own and no visit count: no list price to read.
    expect(engineTierRecord([shrub({ visitsPerYear: undefined, annualBeforeDiscount: 600, annualAfterDiscount: 540 })], shrubRow, 'tree_shrub')).toBeNull();
  });

  test('two tier rates, a rate above 100%, no annuals or no engine lines name no record', () => {
    expect(engineTierRecord([pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }, { type: 'waveguard', amount: 0.15 }] } })], pestRow, 'pest_control')).toBeNull();
    expect(engineTierRecord([pestItem({ discount: waveguard(1.5) })], pestRow, 'pest_control')).toBeNull();
    expect(engineTierRecord([pestItem({ annualBeforeDiscount: undefined, annualAfterDiscount: undefined })], pestRow, 'pest_control')).toBeNull();
    expect(engineTierRecord([], pestRow, 'pest_control')).toBeNull();
  });
});
