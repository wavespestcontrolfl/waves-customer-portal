/**
 * invoice-tier-line-check.js: the nightly check for a WaveGuard tier saving an invoice would leave out. The invoice
 * decision (completion-pricing.js acceptedVisitBreakdown) is mocked, with the estimate row and the saved row it matched:
 * this suite proves the witness (the estimate's own engine line record) and which visits it reads.
 * completion-pricing.postgres.test.js runs it on the real decision. Synthetic estimates in the saved engine shape
 * (memory saved-estimate-tier-shape-trap); no real figures.
 */
jest.mock('../services/completion-pricing', () => ({ acceptedVisitBreakdown: jest.fn() }));
// The real module, one reader overridden: estimate-public (recurringServiceKey) reads other gates when it loads.
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), invoiceEstimateDiscountLinesLive: jest.fn(() => true) }));

const { acceptedVisitBreakdown } = require('../services/completion-pricing');
const { invoiceEstimateDiscountLinesLive } = require('../config/feature-gates');
const { tierSavingsLeftOffInvoices, _private: { engineTierRecord } } = require('../services/invoice-tier-line-check');

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
const pestItem = (extra = {}) => ({ service: 'pest_control', visitsPerYear: 4, annualBeforeDiscount: 400, annualAfterDiscount: 340,
  tiers: [{ freq: 4, perApp: 100, selected: true }, { freq: 6, perApp: 90, selected: false }], discount: waveguard(0.15), ...extra });
// $140 a visit, 9 visits, 20%: $1,260 list, $1,008 net, $112 a visit.
const lawnItem = (extra = {}) => ({ service: 'lawn_care', visitsPerYear: 9, annualBeforeDiscount: 1260, annualAfterDiscount: 1008,
  perApp: 140, discount: waveguard(0.2), ...extra });
const estimate = ({ lineItems = [pestItem()], tier = 'Gold', recurring = { tier: 'Gold', waveGuardTier: 'Gold' } } = {}) => ({
  id: 'e1', waveguard_tier: tier, estimate_data: JSON.stringify({ engineResult: { lineItems }, result: { recurring } }) });
const pestRow = { service: 'pest_control', name: 'Pest Control', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 340 };
const lawnRow = { service: 'lawn_care', name: 'Lawn Care', perTreatment: 140, visitsPerYear: 9, annualAfterDiscount: 1008 };
const visit = (extra = {}) => ({ id: 'v1', source_estimate_id: 'e1', service_type: 'Quarterly Pest Control Service', estimated_price: '85.00', ...extra });
const unnamed = (extra = {}) => ({ breakdown: null, reason: 'discount_unnamed', estimate: estimate(), line: pestRow, ...extra });
const findingsFor = async (row, decision) => {
  acceptedVisitBreakdown.mockResolvedValue(decision);
  return (await tierSavingsLeftOffInvoices(fakeDb([row]), { today: TODAY })).findings;
};

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

  // Pre-push audit P1: an empty tier column does not hide the engine's tier; records that disagree name no saving.
  test('the tier comes from the estimate\'s records: the engine\'s, the column and the saved block must not disagree', async () => {
    const tierFor = async (records) => (await findingsFor(visit(), unnamed({ estimate: estimate(records) }))).map((f) => f.tier);
    expect(await tierFor({ tier: null })).toEqual(['gold']);
    expect(await tierFor({ tier: null, recurring: {} })).toEqual(['gold']);
    expect(await tierFor({ lineItems: [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }] } })] })).toEqual(['gold']);
    expect(await tierFor({ tier: 'Silver' })).toEqual([]);
    expect(await tierFor({ tier: null, recurring: { tier: 'Silver' } })).toEqual([]);
    expect(await tierFor({ tier: 'Bronze', recurring: { tier: 'Bronze' }, lineItems: [pestItem({ discount: waveguard(0.15, 'bronze') })] })).toEqual([]);
  });

  // The engine discounts the annual, so a few cents off the tier's share is its rounding; more is not the tier alone.
  test.each([
    ['85.04', 1], ['84.95', 1], ['80.00', 0], ['84.90', 0], ['100.00', 0], ['101.00', 0],
  ])('a visit billed %s against a $100 list at 15%% gives %i finding', async (price, n) => {
    expect(await findingsFor(visit({ estimated_price: price }), unnamed())).toHaveLength(n);
  });

  // Pre-push audit P1: a staff change to $84.99 sits within the rounding allowance, so the engine's own record of it
  // must stop the finding first.
  test('a staff discount on recurring work, a service credit or a floor on the line is not the tier alone', async () => {
    const billed = (price, lineItems, line = pestRow) => findingsFor(visit({ estimated_price: price }), unnamed({ estimate: estimate({ lineItems }), line }));
    expect(await billed('84.99', [pestItem({ manualFinalAnnual: 339.96 })])).toEqual([]);
    expect(await billed('85.00', [pestItem(), lawnItem({ manualFinalAnnual: 1000 })])).toEqual([]);
    expect(await billed('84.99', [pestItem({ serviceSpecificDiscounts: [{ presetKey: 'credit', amount: 0.04 }] })])).toEqual([]);
    // A floor raised the lawn net to $1,008.36 ($112.04 a visit): 4 cents off the share, but not the tier's rate.
    expect(await billed('112.04', [lawnItem({ annualAfterDiscount: 1008.36 })], lawnRow)).toEqual([]);
    expect(await billed('112.00', [lawnItem()], lawnRow)).toHaveLength(1);
  });

  test('the engine record must hold the tier as its only discount, on one line item of the service', async () => {
    const cases = [
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }, { type: 'manual', amount: 0.05 }] } })],
      [pestItem({ discount: { appliedDiscounts: [] } })],
      [pestItem({ discount: {} })],
      [pestItem(), pestItem()],
      [lawnItem()],
    ];
    for (const lineItems of cases) expect(await findingsFor(visit(), unnamed({ estimate: estimate({ lineItems }) }))).toEqual([]);
    const noEngine = { id: 'e1', waveguard_tier: 'Gold', estimate_data: { result: { recurring: { tier: 'Gold' } } } };
    expect(await findingsFor(visit(), unnamed({ estimate: noEngine }))).toEqual([]);
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

describe('engineTierRecord', () => {
  const data = (...lineItems) => ({ engineResult: { lineItems } });
  test('the per-visit list price: the selected frequency\'s, else the item\'s own, else its list annual over its visits', () => {
    expect(engineTierRecord(data(pestItem()), 'pest_control')).toEqual({ rate: 0.15, listCents: 10000, tier: 'gold' });
    // The lawn shape: the selected program is an object of its own.
    expect(engineTierRecord(data(lawnItem({ selected: { perApp: 140 }, perApp: 150, discount: waveguard(0.2, 'platinum') })), 'lawn_care'))
      .toEqual({ rate: 0.2, listCents: 14000, tier: 'platinum' });
    // The tree and shrub shape: no tier list, the item's own per-visit price.
    const shrub = (extra) => ({ service: 'tree_shrub', visitsPerYear: 6, discount: waveguard(0.1, 'silver'), ...extra });
    expect(engineTierRecord(data(shrub({ perApp: 90.5, annualBeforeDiscount: 543, annualAfterDiscount: 488.7 })), 'tree_shrub'))
      .toEqual({ rate: 0.1, listCents: 9050, tier: 'silver' });
    expect(engineTierRecord(data(shrub({ annualBeforeDiscount: 600, annualAfterDiscount: 540 })), 'tree_shrub'))
      .toEqual({ rate: 0.1, listCents: 10000, tier: 'silver' });
    // No price of its own and no visit count: no list price to read.
    expect(engineTierRecord(data(shrub({ visitsPerYear: undefined, annualBeforeDiscount: 600, annualAfterDiscount: 540 })), 'tree_shrub')).toBeNull();
  });

  test('two tier rates, a rate above 100%, no annuals, no service, or no engine result name no record', () => {
    expect(engineTierRecord(data(pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }, { type: 'waveguard', amount: 0.15 }] } })), 'pest_control')).toBeNull();
    expect(engineTierRecord(data(pestItem({ discount: waveguard(1.5) })), 'pest_control')).toBeNull();
    expect(engineTierRecord(data(pestItem({ annualBeforeDiscount: undefined, annualAfterDiscount: undefined })), 'pest_control')).toBeNull();
    expect(engineTierRecord(data(pestItem()), null)).toBeNull();
    expect(engineTierRecord({}, 'pest_control')).toBeNull();
    expect(engineTierRecord(null, 'pest_control')).toBeNull();
  });
});
