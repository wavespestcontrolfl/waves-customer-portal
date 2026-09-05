jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../config/protocols.json', () => ({
  lawn: { st_augustine: { name: 'Fixture lawn track', visits: [] } },
}));

const db = require('../models/db');
const protocols = require('../config/protocols.json');
const adminProtocolsRouter = require('../routes/admin-protocols');
const {
  parseProtocolLines,
  resolveProtocolItems,
  effectiveAreaFactor,
  calculateProductAmount,
} = require('../services/waveguard-plan-engine');

const { isPricedProtocolLine, unmatchedPricedProtocolLines } = adminProtocolsRouter._internals;

// Catalog fixtures mirror the prod rows the lawn-mix preview resolves against.
// Arena's rate matches migration 20260703000001 (sourced from the operating
// layer's owner-approved July chinch-rescue seed).
const CATALOG = [
  {
    id: 'arena',
    name: 'Arena 50 WDG',
    aliases: ['Arena'],
    default_rate_per_1000: 0.29,
    rate_unit: 'oz',
    cost_per_unit: 5.2,
    cost_unit: 'oz',
  },
  {
    id: 'kflow',
    name: 'LESCO K-Flow 0-0-25',
    aliases: ['K-Flow'],
    default_rate_per_1000: 3,
    rate_unit: 'fl_oz',
    cost_per_unit: 0.12,
    cost_unit: 'fl_oz',
  },
  {
    id: 'hydretain',
    name: 'Hydretain Liquid',
    aliases: ['Hydretain'],
    default_rate_per_1000: 9,
    rate_unit: 'fl_oz',
    cost_per_unit: 0.13,
    cost_unit: 'fl_oz',
  },
];

// This suite runs the real handler and plan engine. Only stored protocol,
// catalog and calibration inputs are fixtures; no database or provider runs.
const lawnMixHandler = adminProtocolsRouter.stack.find((layer) => (
  layer.route?.path === '/lawn-mix' && layer.route.methods.get
)).route.stack[0].handle;

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'join', 'select', 'orderByRaw', 'orderBy']) {
    query[method] = jest.fn(() => query);
  }
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  return query;
}

async function lawnMix(query = {}) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await lawnMixHandler({ query: { track: 'A_St_Aug_Sun', month: '7', lawnSqft: '10000', ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledTimes(1);
  // Assert the serialized response, including nulls and absent fields.
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

let calibration;
let visit;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2030-07-15T16:00:00Z'));
  calibration = {
    id: 'calibration-fixture', equipment_system_id: 'tank-fixture',
    system_name: 'Fixture tank', system_type: 'tank',
    carrier_gal_per_1000: 2, tank_capacity_gal: 40,
    expires_at: '2030-07-16T16:00:00Z',
  };
  visit = {
    month: 'Jul', visit: 7, notes: '',
    primary: 'BLACKOUT — K-Flow 0-0-25 ($2.18)',
    secondary: '★ If Talstar failed Jun: Arena 50 WDG (Group 4A) ($5.20)\nHydretain drought prep Premium ($10.59)',
  };
  protocols.lawn.st_augustine.visits = [visit];
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') return readQuery(calibration ? [calibration] : []);
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery(CATALOG.flatMap((product) => (
      product.aliases.map((alias_name) => ({ product_id: product.id, alias_name }))
    )));
    throw new Error(`Unexpected table: ${table}`);
  });
});

afterEach(() => jest.useRealTimers());

describe('lawn-mix response for optional products', () => {
  test('unselected rescue and premium products retain previews without entering actual costs', async () => {
    const body = await lawnMix();
    expect(body.items).toHaveLength(3);
    const [base, rescue, premium] = body.items;
    expect(base).toMatchObject({
      selected: true, product: { id: 'kflow' },
      jobMix: { amount: 30, materialCost: 3.6 },
      plannedMix: { amount: 30, materialCost: 3.6 },
    });
    expect(rescue).toMatchObject({
      selected: false, scope: 'CONDITIONAL_RESCUE', product: { id: 'arena' },
      jobMix: null, fullTankMix: null,
      plannedMix: { amount: 2.9, amountUnit: 'oz', ratePer1000: 0.29, carrierGallons: 20, materialCost: 15.08 },
      plannedFullTankMix: { amount: 5.8, carrierGallons: 40 },
    });
    expect(premium).toMatchObject({
      selected: false, scope: 'PREMIUM_ONLY', product: { id: 'hydretain' },
      jobMix: null, fullTankMix: null,
      plannedMix: { amount: 90, amountUnit: 'fl_oz', materialCost: 11.7 },
      plannedFullTankMix: { amount: 180, carrierGallons: 40 },
    });
    expect(body.selectedItems.map((item) => item.product.id)).toEqual(['kflow']);
    expect(body.materialCostSummary).toMatchObject({ total: 3.6, pricedLineCount: 1, selectedLineCount: 1 });
    expect(body.warnings).toEqual([]);
  });

  test.each([
    ['rescue', { selectedConditionalProductIds: 'arena' }, 'arena', 2.9, 18.68],
    ['premium', { includePremiumOnly: 'true' }, 'hydretain', 90, 15.3],
  ])('selecting the %s moves its quantity and cost into the actual mix', async (_label, query, id, amount, total) => {
    const body = await lawnMix(query);
    const item = body.items.find((row) => row.product?.id === id);
    expect(item).toMatchObject({ selected: true, jobMix: { amount }, plannedMix: { amount } });
    expect(body.selectedItems.map((row) => row.product.id)).toEqual(['kflow', id]);
    expect(body.materialCostSummary).toMatchObject({ total, pricedLineCount: 2, selectedLineCount: 2 });
  });

  test('SKIP instructions expose no product mix even when their product is matched', async () => {
    visit.primary = '★ IF soil K >80 ppm: SKIP K-Flow → micros only';
    visit.secondary = '';
    const body = await lawnMix();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      scope: 'INSPECTION_ONLY', matched: true, product: { id: 'kflow' }, selected: false,
      jobMix: null, fullTankMix: null, plannedMix: null, plannedFullTankMix: null,
    });
    expect(body.selectedItems).toEqual([]);
    expect(body.materialCostSummary).toMatchObject({ total: 0, pricedLineCount: 0 });
  });

  test('calibration expiry does not withhold mix amounts when inputs exist', async () => {
    calibration.expires_at = '2000-01-01T00:00:00Z';
    const body = await lawnMix();
    expect(body.items.find(item => item.product?.id === 'kflow').jobMix.amount).toBeGreaterThan(0);
    expect(body.warnings).toEqual([]);
  });

  test.each([
    ['missing', null, 'missing_calibration'],
    ['zero carrier', { carrier_gal_per_1000: 0 }, null],
    ['nonnumeric carrier', { carrier_gal_per_1000: 'unavailable' }, null],
  ])('%s calibration withholds all actual and preview amounts', async (_label, overrides, warning) => {
    calibration = overrides === null ? null : { ...calibration, ...overrides };
    const body = await lawnMix();
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item).toMatchObject({ jobMix: null, fullTankMix: null, plannedMix: null, plannedFullTankMix: null });
    }
    expect(body.materialCostSummary).toMatchObject({ total: 0, pricedLineCount: 0 });
    if (warning) expect(body.warnings).toEqual([expect.objectContaining({ code: warning })]);
  });
});

describe('rescue engine quantity and selection', () => {
  test('unselected rescue has no live area; full-area calculation keeps its literal quantity and cost', () => {
    const lines = parseProtocolLines('★ If Talstar failed Jun: Arena 50 WDG (Group 4A) ($5.20)', 'conditional');
    const [item] = resolveProtocolItems(lines, CATALOG, {}, {});
    expect(item.selected).toBe(false);
    expect(effectiveAreaFactor(item, {})).toBe(0);
    expect(calculateProductAmount({
      product: item.product, lawnSqft: 10000, carrierGalPer1000: 2, areaFactor: 1,
    })).toMatchObject({ amount: 2.9, ratePer1000: 0.29, materialCost: 15.08 });
  });
});

describe('task-line classification', () => {
  test('priced-line helper matches the unmatched-warning convention', () => {
    expect(isPricedProtocolLine('Moisture Manager ($7.45)')).toBe(true);
    expect(isPricedProtocolLine('★ Chinch re-check ≥20/sq ft threshold')).toBe(false);
    expect(isPricedProtocolLine('★ Conditional ceiling check: >$60 YTD = reprice flag')).toBe(false);
    expect(isPricedProtocolLine(null)).toBe(false);
  });

  test('an unmatched line is a task exactly when the unmatched-product warning would ignore it', () => {
    const items = [
      { raw: '★ Chinch re-check ≥20/sq ft threshold', matched: false },
      { raw: 'Spot Celsius if breakthrough ($3.84)', matched: false },
    ];
    const warned = unmatchedPricedProtocolLines(items);
    for (const item of items) {
      const taskLine = !item.matched && !isPricedProtocolLine(item.raw);
      expect(taskLine).toBe(!warned.includes(item.raw));
    }
  });
});
