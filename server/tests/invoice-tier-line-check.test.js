/**
 * invoice-tier-line-check.js: the nightly check for a WaveGuard tier saving an invoice would leave out. The invoice
 * decision (completion-pricing.js acceptedVisitBreakdown) is mocked: this suite proves the witness (the estimate's own
 * engine line record) and which visits it reads. completion-pricing.postgres.test.js runs it on the real decision.
 * Synthetic estimates in the saved engine shape (memory saved-estimate-tier-shape-trap); no real figures.
 */
jest.mock('../services/completion-pricing', () => ({ acceptedVisitBreakdown: jest.fn() }));
// The real module, one reader overridden: estimate-public (recurringServiceKey) reads other gates when it loads.
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), invoiceEstimateDiscountLinesLive: jest.fn(() => true) }));

const { acceptedVisitBreakdown } = require('../services/completion-pricing');
const { invoiceEstimateDiscountLinesLive } = require('../config/feature-gates');
const { tierSavingsLeftOffInvoices, _private: { engineTierRecord } } = require('../services/invoice-tier-line-check');

const TODAY = '2026-06-15';

// A knex stand-in: the visit query returns `visits`; estimates and series parents are read by id.
function fakeDb({ visits = [], estimates = {}, parents = {} } = {}) {
  const reads = [];
  const conn = jest.fn((table) => {
    const chain = {};
    let filter = {};
    for (const m of ['join', 'leftJoin', 'whereNull', 'whereIn', 'whereRaw', 'orderBy']) chain[m] = jest.fn(() => chain);
    chain.where = jest.fn((arg) => { if (arg && typeof arg === 'object') filter = arg; return chain; });
    chain.select = jest.fn(async () => (table === 'scheduled_services as s' ? visits : []));
    chain.first = jest.fn(async () => {
      reads.push([table, filter.id]);
      return (table === 'estimates' ? estimates : parents)[filter.id] || null;
    });
    return chain;
  });
  return { conn, reads };
}

const pestItem = (extra = {}) => ({ service: 'pest_control', visitsPerYear: 4, annualBeforeDiscount: 400, annualAfterDiscount: 340,
  tiers: [{ freq: 4, perApp: 100, selected: true }, { freq: 6, perApp: 90, selected: false }],
  discount: { appliedDiscounts: [{ type: 'waveguard', tier: 'gold', amount: 0.15 }] }, ...extra });
const estimate = (lineItems, tier = 'Gold') => ({ id: 'e1', waveguard_tier: tier, estimate_data: JSON.stringify({ engineResult: { lineItems } }) });
const visit = (extra = {}) => ({ id: 'v1', source_estimate_id: 'e1', service_type: 'Quarterly Pest Control Service', estimated_price: '85.00', ...extra });
const unnamed = { breakdown: null, reason: 'discount_unnamed' };

beforeEach(() => {
  jest.clearAllMocks();
  invoiceEstimateDiscountLinesLive.mockReturnValue(true);
});

describe('tierSavingsLeftOffInvoices', () => {
  test('a visit whose saving is the engine\'s tier rate on the list price, left unnamed on the invoice, is a finding', async () => {
    const { conn } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()]) } });
    acceptedVisitBreakdown.mockResolvedValue(unnamed);
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({
      checked: 1, findings: [{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', tier: 'gold' }],
    });
    expect(acceptedVisitBreakdown).toHaveBeenCalledWith(visit(), { database: conn });
  });

  test('an invoice that names the tier is not a finding, and its estimate is not read', async () => {
    const { conn, reads } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()]) } });
    acceptedVisitBreakdown.mockResolvedValue({ breakdown: { base: 100, amount: 85, discounts: [{ name: 'WaveGuard Gold', dollars: 15 }] } });
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toEqual([]);
    expect(reads).toEqual([]);
  });

  test('lines that name only another discount are read like an unnamed saving', async () => {
    const { conn } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()]) } });
    acceptedVisitBreakdown.mockResolvedValue({ breakdown: { base: 100, amount: 85, discounts: [{ name: 'Courtesy', dollars: 15 }] } });
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toHaveLength(1);
  });

  test.each(['no_discount', 'price_changed', 'not_priced', 'own_price_or_discount', 'prepaid', 'line_unmatched'])(
    'a visit that keeps one line for %s is not read', async (reason) => {
      const { conn, reads } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()]) } });
      acceptedVisitBreakdown.mockResolvedValue({ breakdown: null, reason });
      expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toEqual([]);
      expect(reads).toEqual([]);
    },
  );

  // A staff discount or a service credit beside the tier makes the saving larger than the tier's share: one line by
  // design. A few cents off the share is the engine's rounding of the annual.
  test.each([
    ['85.04', 1], ['84.95', 1], ['80.00', 0], ['84.90', 0], ['100.00', 0], ['101.00', 0],
  ])('a visit billed %s against a $100 list at 15%% gives %i finding', async (price, n) => {
    const { conn } = fakeDb({ visits: [visit({ estimated_price: price })], estimates: { e1: estimate([pestItem()]) } });
    acceptedVisitBreakdown.mockResolvedValue(unnamed);
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toHaveLength(n);
  });

  test('the engine record must hold the tier as its only discount, on one line item of the service', async () => {
    acceptedVisitBreakdown.mockResolvedValue(unnamed);
    const cases = [
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }, { type: 'manual', amount: 0.05 }] } })],
      [pestItem({ discount: { appliedDiscounts: [] } })],
      [pestItem({ discount: {} })],
      [pestItem(), pestItem()],
      [{ ...pestItem(), service: 'lawn_care' }],
    ];
    for (const lineItems of cases) {
      const { conn } = fakeDb({ visits: [visit()], estimates: { e1: estimate(lineItems) } });
      expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toEqual([]);
    }
    const { conn } = fakeDb({ visits: [visit()], estimates: { e1: { id: 'e1', waveguard_tier: 'Gold', estimate_data: { result: {} } } } });
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toEqual([]);
  });

  test.each(['Bronze', null, ''])('a %p estimate has no tier saving to name', async (tier) => {
    const { conn } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()], tier) } });
    acceptedVisitBreakdown.mockResolvedValue(unnamed);
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toEqual([]);
  });

  test('a series visit reads its parent\'s estimate, each estimate once', async () => {
    const child = (id) => visit({ id, source_estimate_id: null, recurring_parent_id: 'p1' });
    const { conn, reads } = fakeDb({ visits: [child('v1'), child('v2')], parents: { p1: { source_estimate_id: 'e1' } },
      estimates: { e1: estimate([pestItem()]) } });
    acceptedVisitBreakdown.mockResolvedValue(unnamed);
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings.map((f) => [f.visitId, f.estimateId]))
      .toEqual([['v1', 'e1'], ['v2', 'e1']]);
    expect(reads.filter(([table]) => table === 'estimates')).toEqual([['estimates', 'e1']]);
    expect(reads.filter(([table]) => table === 'scheduled_services')).toEqual([['scheduled_services', 'p1'], ['scheduled_services', 'p1']]);
  });

  test('a visit with no estimate behind it is not a finding', async () => {
    const { conn } = fakeDb({ visits: [visit({ source_estimate_id: null, recurring_parent_id: null })] });
    acceptedVisitBreakdown.mockResolvedValue(unnamed);
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).findings).toEqual([]);
  });

  test('gate off: every invoice keeps one line by design, so no visit is read', async () => {
    invoiceEstimateDiscountLinesLive.mockReturnValue(false);
    const { conn } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()]) } });
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({ checked: 0, findings: [] });
    expect(conn).not.toHaveBeenCalled();
    expect(acceptedVisitBreakdown).not.toHaveBeenCalled();
  });

  test('a visit the invoice decision cannot read fails the run: a check that did not run proves nothing', async () => {
    const { conn } = fakeDb({ visits: [visit()], estimates: { e1: estimate([pestItem()]) } });
    acceptedVisitBreakdown.mockRejectedValue(new Error('read failed'));
    await expect(tierSavingsLeftOffInvoices(conn, { today: TODAY })).rejects.toThrow('read failed');
  });

  test('the visit query reads today through 90 days ahead by default', async () => {
    const { conn } = fakeDb();
    await tierSavingsLeftOffInvoices(conn, { today: TODAY });
    const chain = conn.mock.results[0].value;
    expect(conn).toHaveBeenCalledWith('scheduled_services as s');
    expect(chain.whereRaw).toHaveBeenCalledWith('s.scheduled_date >= ?::date AND s.scheduled_date < ?::date + ?::int', [TODAY, TODAY, 90]);
  });
});

describe('engineTierRecord: the per-visit list price', () => {
  const data = (item) => ({ engineResult: { lineItems: [item] } });
  test('the selected frequency\'s price, else the item\'s own, else its list annual over its visits', () => {
    expect(engineTierRecord(data(pestItem()), 'pest_control')).toEqual({ rate: 0.15, listCents: 10000 });
    // The lawn shape: the selected program is an object of its own.
    expect(engineTierRecord(data({ service: 'lawn_care', frequency: 9, selected: { perApp: 140 }, perApp: 150,
      discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.2 }] } }), 'lawn_care')).toEqual({ rate: 0.2, listCents: 14000 });
    // The tree and shrub shape: no tier list, the item's own per-visit price.
    expect(engineTierRecord(data({ service: 'tree_shrub', visitsPerYear: 6, perApp: 90.5, annualBeforeDiscount: 543,
      discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }] } }), 'tree_shrub')).toEqual({ rate: 0.1, listCents: 9050 });
    expect(engineTierRecord(data({ service: 'tree_shrub', visitsPerYear: 6, annualBeforeDiscount: 600,
      discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }] } }), 'tree_shrub')).toEqual({ rate: 0.1, listCents: 10000 });
    expect(engineTierRecord(data({ service: 'tree_shrub', discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }] } }), 'tree_shrub')).toBeNull();
  });

  test('two tier rates, a rate above 100%, or no engine result name no record', () => {
    expect(engineTierRecord(data(pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }, { type: 'waveguard', amount: 0.15 }] } })), 'pest_control')).toBeNull();
    expect(engineTierRecord(data(pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 1.5 }] } })), 'pest_control')).toBeNull();
    expect(engineTierRecord({}, 'pest_control')).toBeNull();
    expect(engineTierRecord(null, 'pest_control')).toBeNull();
  });
});
