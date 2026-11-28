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
  query.then = (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected);
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
let backpackCalibration;
let visit;

// The calibration reads: the selected rig (getActiveCalibration, .first()) and the FlowZone backpack (system_type 'backpack', a list).
function calibrationQuery() {
  const query = readQuery([]);
  let backpackOnly = false;
  query.where = jest.fn((key, value) => { if (key === 'es.system_type' && value === 'backpack') backpackOnly = true; return query; });
  const rows = () => [].concat(backpackOnly ? backpackCalibration : calibration).filter(Boolean);
  query.first = jest.fn(async () => rows()[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows()).catch(onRejected);
  query.then = (onFulfilled, onRejected) => Promise.resolve(rows()).then(onFulfilled, onRejected);
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2030-07-15T16:00:00Z'));
  calibration = {
    id: 'calibration-fixture', equipment_system_id: 'tank-fixture',
    system_name: 'Fixture tank', system_type: 'tank',
    carrier_gal_per_1000: 2, tank_capacity_gal: 40,
    expires_at: '2030-07-16T16:00:00Z', calibration_status: 'field_verified',
  };
  backpackCalibration = null;
  visit = {
    month: 'Jul', visit: 7, notes: '',
    primary: 'BLACKOUT — K-Flow 0-0-25 ($2.18)',
    secondary: '★ If Talstar failed Jun: Arena 50 WDG (Group 4A) ($5.20)\nHydretain drought prep Premium ($10.59)',
  };
  protocols.lawn.st_augustine.visits = [visit];
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') return calibrationQuery();
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
      // The tank sheet gives the SKIP line no fill either.
      tankAmounts: { skipped: true, per100Gal: null, fullTank: null, backpack4Gal: null, useFills: [] },
    });
    expect(body.selectedItems).toEqual([]);
    expect(body.materialCostSummary).toMatchObject({ total: 0, pricedLineCount: 0 });
  });

  // Owner 2026-11-26: a safety or limit alert is a warning, never a hidden amount. The sheet keeps the last test's carrier and says so.
  test('an overdue sprayer test keeps every amount and warns with the last test date and carrier', async () => {
    calibration.expires_at = '2000-01-01T00:00:00Z';
    calibration.calibrated_at = '2030-06-07T14:00:00Z';
    const body = await lawnMix();
    const kflow = body.items.find(item => item.product?.id === 'kflow');
    expect(kflow.jobMix.amount).toBeGreaterThan(0);
    expect(kflow.tankAmounts.per100Gal).toMatchObject({ gallons: 100, amount: 150, amountUnit: 'fl_oz', carrierGalPer1000: 2, carrierSource: 'calibration' });
    expect(body.warnings).toEqual([expect.objectContaining({
      code: 'calibration_overdue_or_estimated',
      message: 'Sprayer test overdue: Fixture tank last tested 2030-06-07 at 2 gal per 1,000 sq ft. Amounts below assume that. Test the sprayer again.',
    })]);
  });

  test('an estimated (never field tested) sprayer keeps its amounts and says so', async () => {
    calibration.calibration_status = 'estimated';
    const body = await lawnMix();
    expect(body.items.find(item => item.product?.id === 'kflow').tankAmounts.per100Gal).toMatchObject({ amount: 150 });
    expect(body.equipment).toMatchObject({ calibrationStatus: 'estimated' });
    expect(body.warnings).toEqual([expect.objectContaining({
      code: 'calibration_overdue_or_estimated',
      message: 'Sprayer not field tested: Fixture tank at 2 gal per 1,000 sq ft (estimated, not field tested). Amounts below assume that. Test the sprayer.',
    })]);
  });

  test('tank amounts: the base liquid per 100 gal and per full tank; every sprayed product, unselected or not, per 4 gal FlowZone', async () => {
    backpackCalibration = {
      id: 'calibration-backpack', equipment_system_id: 'backpack-fixture', system_name: 'FlowZone fixture backpack', system_type: 'backpack',
      carrier_gal_per_1000: 1.33, tank_capacity_gal: 4, calibration_status: 'estimated', expires_at: '2030-08-01T00:00:00Z',
    };
    const body = await lawnMix();
    const [base, rescue, premium] = body.items;
    // amount = rate per 1,000 sq ft x (tank gallons / carrier gal per 1,000 sq ft)
    expect(base.tankAmounts).toMatchObject({
      application: 'spray', bigTank: true, ratePer1000: 3, rateUnit: 'fl_oz', fixedCarrierGalPer1000: null,
      per100Gal: { gallons: 100, amount: 150, carrierGalPer1000: 2, carrierSource: 'calibration' },
      fullTank: { gallons: 40, amount: 60 },
      backpack4Gal: { gallons: 4, amount: 9.023, amountUnit: 'fl_oz', carrierGalPer1000: 1.33, carrierSource: 'calibration', sprayerName: 'FlowZone fixture backpack' },
    });
    expect(rescue).toMatchObject({ selected: false, jobMix: null, fullTankMix: null });
    expect(rescue.tankAmounts).toMatchObject({ bigTank: false, per100Gal: null, fullTank: null, backpack4Gal: { amount: 0.872, amountUnit: 'oz' } });
    expect(premium.tankAmounts).toMatchObject({ bigTank: false, backpack4Gal: { amount: 27.068 } });
    expect(body.warnings).toEqual([expect.objectContaining({
      code: 'backpack_calibration_overdue_or_estimated',
      message: 'Sprayer not field tested: FlowZone fixture backpack at 1.33 gal per 1,000 sq ft (estimated, not field tested). Amounts below assume that. Test the sprayer.',
    })]);
  });

  test('the FlowZone is found by what it is (4 gal backpack named FlowZone): a field-verified test first, then the newest test', async () => {
    const flowZone = (id, name, status, calibratedAt, carrier) => ({
      id, equipment_system_id: `${id}-system`, system_name: name, system_type: 'backpack', tank_capacity_gal: 4,
      carrier_gal_per_1000: carrier, calibration_status: status, calibrated_at: calibratedAt, expires_at: '2030-08-01T00:00:00Z',
    });
    const other = { ...flowZone('alpha', 'Alpha 3 gal backpack', 'field_verified', '2030-07-10T12:00:00Z', 1), tank_capacity_gal: 3 };
    const estimated = flowZone('fz-new', 'FlowZone Typhoon Backpack #2', 'estimated', '2030-07-01T12:00:00Z', 1.33);
    const verified = flowZone('fz-old', 'FlowZone Typhoon Backpack #1', 'field_verified', '2030-06-20T12:00:00Z', 1.6);
    backpackCalibration = [other, estimated, verified];
    const kflowFill = async () => (await lawnMix()).items.find((item) => item.product?.id === 'kflow').tankAmounts.backpack4Gal;
    expect(await kflowFill()).toMatchObject({ carrierGalPer1000: 1.6 });
    backpackCalibration = [other, { ...verified, calibration_status: 'estimated' }, estimated];
    expect(await kflowFill()).toMatchObject({ carrierGalPer1000: 1.33 });
    const body = await lawnMix();
    expect(body.warnings).toContainEqual(expect.objectContaining({ code: 'backpack_calibration_overdue_or_estimated', message: expect.stringContaining('FlowZone Typhoon Backpack #2') }));
  });

  test('a FlowZone picked as the rig sizes its own 4 gal fill, not the FlowZone ranked first', async () => {
    const flowZone = (id, carrier, status) => ({
      id, equipment_system_id: `${id}-system`, system_name: `FlowZone Typhoon Backpack ${id}`, system_type: 'backpack', tank_capacity_gal: 4,
      carrier_gal_per_1000: carrier, calibration_status: status, calibrated_at: '2030-07-01T12:00:00Z', expires_at: '2030-08-01T00:00:00Z',
    });
    calibration = flowZone('picked', 1.1, 'estimated');
    backpackCalibration = [flowZone('ranked-first', 1.6, 'field_verified')];
    const body = await lawnMix({ equipmentSystemId: 'picked-system' });
    const kflow = body.items.find((item) => item.product?.id === 'kflow').tankAmounts;
    expect(kflow).toMatchObject({ per100Gal: null, fullTank: null, backpack4Gal: { carrierGalPer1000: 1.1 } });
    // One warning for the one sprayer in use, naming it.
    expect(body.warnings.filter((w) => /Sprayer/.test(w.message))).toEqual([expect.objectContaining({ message: expect.stringContaining('FlowZone Typhoon Backpack picked') })]);
  });

  test('a sprayer with no test status on file warns that its field test is not on file, and keeps its amounts', async () => {
    calibration.calibration_status = null;
    const body = await lawnMix();
    expect(body.items.find(item => item.product?.id === 'kflow').tankAmounts.per100Gal).toMatchObject({ amount: 150 });
    expect(body.warnings).toEqual([expect.objectContaining({
      code: 'calibration_overdue_or_estimated',
      message: 'Sprayer not field tested: Fixture tank at 2 gal per 1,000 sq ft (field test not on file). Amounts below assume that. Test the sprayer.',
    })]);
  });

  test('a line that fixes its spray volume sizes every fill on it, with or without a sprayer test', async () => {
    visit.secondary = '★ If Talstar failed Jun: Arena 50 WDG (Group 4A) in 4 gal per 1,000 sq ft ($5.20)';
    calibration = null;
    const body = await lawnMix();
    const arena = body.items.find((item) => item.product?.id === 'arena');
    expect(arena.tankAmounts).toMatchObject({ fixedCarrierGalPer1000: 4, fixedCarrierSource: 'line', backpack4Gal: { amount: 0.29, carrierGalPer1000: 4, carrierSource: 'line' } });
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
      // No sprayer test at all (no FlowZone test either): no tank amount, and the sheet says which sprayer needs one.
      expect(item.tankAmounts).toMatchObject({ per100Gal: null, fullTank: null, backpack4Gal: null, backpackMissing: true });
    }
    expect(body.materialCostSummary).toMatchObject({ total: 0, pricedLineCount: 0 });
    if (warning) expect(body.warnings).toEqual([expect.objectContaining({ code: warning, message: 'No sprayer test on file for the selected tank: amounts that need its spray volume are not shown.' })]);
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

// Owner 2026-11-18: LESCO Crosscheck Plus is the house bifenthrin. The gate-off July chinch rescue is the product to use when the June
// bifenthrin failed, so its line may name only Arena: with the full Crosscheck name in it, the matcher took Crosscheck (the longer name).
describe('the gate-off July chinch rescue line', () => {
  test('resolves to Arena 50 WDG with LESCO Crosscheck Plus in the catalog, never to the bifenthrin that failed', () => {
    const fs = require('fs');
    const path = require('path');
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'protocols.json'), 'utf8'));
    const july = real.lawn.st_augustine.visits.find((visit) => visit.month === 'Jul');
    const line = july.secondary.split('\n').find((text) => text.includes('Arena 50 WDG'));
    expect(line).toBeTruthy();
    const catalog = [...CATALOG, {
      id: 'crosscheck', name: 'LESCO Crosscheck Plus', aliases: ['Crosscheck Plus', 'Talstar P'],
      default_rate_per_1000: 0.5, rate_unit: 'fl_oz', cost_per_unit: 0.2414, cost_unit: 'fl_oz',
    }];
    const items = resolveProtocolItems(parseProtocolLines(line, 'conditional'), catalog, {}, {});
    expect(items.map((item) => item.product?.id)).toEqual(['arena']);
  });
});

// Owner 2026-11-18: the gate-off June bifenthrin lines name LESCO Crosscheck Plus, whose label (page 7) keeps a ground spray 25 ft from
// lakes, ponds and streams. The tank sheet shows each line with the setback, still a rescue the technician selects.
describe('the gate-off June LESCO Crosscheck Plus lines', () => {
  const fs = require('fs');
  const path = require('path');
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'protocols.json'), 'utf8'));
  const CROSSCHECK = {
    id: 'crosscheck', name: 'LESCO Crosscheck Plus', aliases: ['Crosscheck Plus'],
    default_rate_per_1000: 0.5, rate_unit: 'fl_oz', cost_per_unit: 0.2414, cost_unit: 'fl_oz',
  };

  test.each([
    ['A_St_Aug_Sun', 'st_augustine'],
    ['C1_Bermuda', 'bermuda'],
  ])('%s: the sheet line keeps 25 ft from ponds, lakes and canals', async (trackParam, track) => {
    const fixture = protocols.lawn[track];
    protocols.lawn[track] = { name: `Fixture ${track}`, visits: [real.lawn[track].visits.find((v) => v.month === 'Jun')] };
    const catalog = [...CATALOG, CROSSCHECK];
    db.mockImplementation((table) => {
      if (table === 'equipment_calibrations as ec') return readQuery([calibration]);
      if (table === 'products_catalog') return readQuery(catalog);
      if (table === 'product_aliases') return readQuery(catalog.flatMap((product) => product.aliases.map((alias_name) => ({ product_id: product.id, alias_name }))));
      throw new Error(`Unexpected table: ${table}`);
    });
    try {
      const body = await lawnMix({ track: trackParam, month: '6' });
      const items = body.items.filter((item) => item.product?.id === 'crosscheck');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ scope: 'CONDITIONAL_RESCUE', selected: false });
      expect(items[0].raw).toMatch(/LESCO Crosscheck Plus curative[^\n]*; keep 25 ft from ponds, lakes and canals/);
    } finally {
      if (fixture) protocols.lawn[track] = fixture; else delete protocols.lawn[track];
    }
  });
});

// The mix safety table on the sheet (services/product-mix-rules.js checkMix): every pair of sprayed products, for the
// sheet's mix-line helper to show under each shared tank. A warning only; a failed check is left out and logged.
describe('lawn-mix mixCheck', () => {
  const mixRules = require('../services/product-mix-rules');
  const logger = require('../services/logger');

  test('checks every sprayed product on the sheet and sends each pair\'s verdict and reason', async () => {
    const check = jest.spyOn(mixRules, 'checkMix').mockResolvedValue({
      products: [],
      pairs: [{ productAId: 'kflow', productAName: 'LESCO K-Flow 0-0-25', productBId: 'arena', productBName: 'Arena 50 WDG', verdict: 'caution', reason: 'Jar test first.', source: 'owner', jarTestRequired: true, entries: [{ kind: 'pair' }] }],
      catalogNotes: [],
    });
    const body = await lawnMix();
    expect(check).toHaveBeenCalledWith(['kflow', 'arena', 'hydretain'], { max: 3 });
    expect(body.mixCheck).toEqual({ pairs: [{ productAId: 'kflow', productAName: 'LESCO K-Flow 0-0-25', productBId: 'arena', productBName: 'Arena 50 WDG', verdict: 'caution', reason: 'Jar test first.', jarTestRequired: true }] });
    // A warning only: every product keeps its amounts.
    expect(body.items.map((item) => item.plannedMix?.amount)).toEqual([30, 2.9, 90]);
    check.mockRestore();
  });

  test('a failed check returns the unavailable status, logs, and the sheet still renders', async () => {
    const check = jest.spyOn(mixRules, 'checkMix').mockRejectedValue(new Error('product_mix_rules is missing'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const body = await lawnMix();
    expect(body.mixCheck).toEqual({ status: 'unavailable', pairs: [] });
    expect(body.items).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('product_mix_rules is missing'));
    check.mockRestore();
    warn.mockRestore();
  });

  test('a sheet with fewer than two sprayed products makes no check', async () => {
    visit.primary = 'BLACKOUT — K-Flow 0-0-25 ($2.18)';
    visit.secondary = '';
    const check = jest.spyOn(mixRules, 'checkMix');
    const body = await lawnMix();
    expect(check).not.toHaveBeenCalled();
    expect(body.mixCheck).toBeNull();
    check.mockRestore();
  });
});

describe('resolveMixWith: the tank sheet ties a mix by product id, from the plan line resolver', () => {
  const { resolveMixWith } = adminProtocolsRouter._internals;
  const catalog = [
    { id: 'cel', name: 'Celsius WG Herbicide', aliases: ['Celsius WG'] },
    // No NIS alias on the row: the protocol's short name resolves by the explicit map.
    { id: 'nis', name: 'LESCO 90/10 Nonionic Surfactant', aliases: [] },
    { id: 'kflow', name: 'LESCO K-Flow 0-0-25', aliases: ['K-Flow'] },
    { id: 'rec', name: 'Recognition Post Emergent Herbicide', aliases: ['Recognition'] },
    { id: 'fus', name: 'Fusilade II Turf and Ornamental', aliases: ['Fusilade II'] },
  ];
  const line = (id, mixWith) => ({ product: { id }, tankAmounts: { mixWith } });

  test('names and aliases resolve to ids; a seller word alone and an unknown name resolve to nothing', () => {
    const [nis, cel, both, seller, unknown, none] = resolveMixWith([
      line('nis', 'Celsius WG'), line('cel', 'NIS'), line('nis', 'Recognition Post Emergent Herbicide and Fusilade II'),
      line('cel', 'LESCO'), line('cel', 'Unknown blend'), line('kflow', null),
    ], catalog);
    expect(nis.tankAmounts.mixWithProductIds).toEqual(['cel']);
    expect(cel.tankAmounts.mixWithProductIds).toEqual(['nis']);
    expect(both.tankAmounts.mixWithProductIds).toEqual(['rec', 'fus']);
    // "LESCO" is the seller, not a product: no LESCO product attaches, and the sheet says "No rule on file".
    expect(seller.tankAmounts.mixWithProductIds).toEqual([]);
    expect(unknown.tankAmounts.mixWithProductIds).toEqual([]);
    expect(none.tankAmounts).toEqual({ mixWith: null });
  });
});

describe('loadSheetCalibration: scheduled tank sheet scopes calibrations like the plan engine', () => {
  const { loadSheetCalibration, getBackpackCalibration, getActiveBigTanks } = adminProtocolsRouter._internals;

  test('system-only visit assignment excludes another technician calibration and keeps shared or assigned technician rows', async () => {
    const otherTechRow = { id: 'cal-b', equipment_system_id: 'sys-1', technician_id: 'tech-b', system_name: 'Truck #1', carrier_gal_per_1000: 2.5 };
    const ownTechRow = { id: 'cal-a', equipment_system_id: 'sys-1', technician_id: 'tech-a', system_name: 'Truck #1', carrier_gal_per_1000: 1.5 };
    const sharedRow = { id: 'cal-shared', equipment_system_id: 'sys-1', technician_id: null, system_name: 'Truck #1', carrier_gal_per_1000: 2 };

    calibration = [otherTechRow];
    const rejected = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'sys-1', assigned_calibration_id: null, technician_id: 'tech-a' },
    );
    expect(rejected).toMatchObject({ rigId: 'sys-1', calibration: null, calibrationScope: { scopeByTechnician: true, technicianId: 'tech-a' } });

    // The backpack fallback and alternate 110-gal tank options obey the same technician scope.
    backpackCalibration = [{ id: 'bp-b', equipment_system_id: 'bp-sys', technician_id: 'tech-b', system_name: 'FlowZone Typhoon 3.0', system_type: 'backpack', tank_capacity_gal: 4, carrier_gal_per_1000: 1.5 }];
    expect(await getBackpackCalibration(rejected.calibration, rejected.calibrationScope)).toBeNull();
    backpackCalibration = [
      ...backpackCalibration,
      { id: 'bp-a', equipment_system_id: 'bp-sys', technician_id: 'tech-a', system_name: 'FlowZone Typhoon 3.0', system_type: 'backpack', tank_capacity_gal: 4, carrier_gal_per_1000: 1.2 },
    ];
    expect(await getBackpackCalibration(rejected.calibration, rejected.calibrationScope)).toMatchObject({ id: 'bp-a' });

    calibration = [
      { id: 'tank-b', equipment_system_id: 'sys-2', technician_id: 'tech-b', system_name: '110-Gallon Spray Tank #2', system_type: 'tank', tank_capacity_gal: 110, carrier_gal_per_1000: 3 },
      { id: 'tank-shared', equipment_system_id: 'sys-1', technician_id: null, system_name: '110-Gallon Spray Tank #1', system_type: 'tank', tank_capacity_gal: 110, carrier_gal_per_1000: 2 },
    ];
    expect((await getActiveBigTanks(rejected.calibrationScope)).map((r) => r.id)).toEqual(['tank-shared']);
    expect((await getActiveBigTanks({ scopeByTechnician: false })).map((r) => r.id)).toEqual(['tank-b', 'tank-shared']);

    calibration = [otherTechRow, ownTechRow];
    const matchedOwn = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'sys-1', assigned_calibration_id: null, technician_id: 'tech-a' },
    );
    expect(matchedOwn.calibration).toEqual(ownTechRow);

    calibration = [otherTechRow, sharedRow];
    const matchedShared = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'sys-1', assigned_calibration_id: null, technician_id: 'tech-a' },
    );
    expect(matchedShared.calibration).toEqual(sharedRow);
  });

  test('admin explicit rig pick on the reference tab (no scheduled visit) honors technician-owned calibrations', async () => {
    const techOwnedRow = { id: 'cal-b', equipment_system_id: 'sys-b', technician_id: 'tech-b', system_name: 'Truck #2', carrier_gal_per_1000: 2.5 };
    calibration = [techOwnedRow];
    const picked = await loadSheetCalibration({ query: { equipmentSystemId: 'sys-b' }, admin: { role: 'admin' } }, null);
    expect(picked).toMatchObject({ rigId: 'sys-b', calibration: techOwnedRow, calibrationScope: { scopeByTechnician: false } });
  });

  test('explicit assigned_calibration_id queries that calibration directly, and overriding to a different rig clears the stale pin', async () => {
    const pinned = { id: 'cal-pinned', equipment_system_id: 'sys-1', technician_id: 'tech-b', system_name: 'Truck #1', carrier_gal_per_1000: 2.2 };
    const whereCalls = [];
    db.mockImplementation((table) => {
      if (table === 'equipment_calibrations as ec') {
        const q = readQuery([pinned]);
        q.where = jest.fn((...args) => { whereCalls.push(args); return q; });
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const out = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'sys-1', assigned_calibration_id: 'cal-pinned', technician_id: 'tech-a' },
    );
    expect(out).toMatchObject({ rigId: 'sys-1', calibration: pinned });
    expect(whereCalls).toContainEqual(['ec.id', 'cal-pinned']);

    whereCalls.length = 0;
    await loadSheetCalibration(
      { query: { equipmentSystemId: 'sys-2' }, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'sys-1', assigned_calibration_id: 'cal-pinned', technician_id: 'tech-a' },
    );
    expect(whereCalls).not.toContainEqual(['ec.id', 'cal-pinned']);
    expect(whereCalls).toContainEqual(['ec.equipment_system_id', 'sys-2']);
  });

  test('an unresolved/superseded FlowZone calibration pin suppresses replacement and other-backpack FlowZone fills even when the pinned FlowZone has no active calibrations', async () => {
    const otherFlowZone = { id: 'bp-other', equipment_system_id: 'bp-sys-2', technician_id: null, system_name: 'FlowZone Typhoon 3.0 #2', system_type: 'backpack', tank_capacity_gal: 4, carrier_gal_per_1000: 1.5 };
    db.mockImplementation((table) => {
      if (table === 'equipment_calibrations as ec') {
        const q = readQuery([]);
        let backpackOnly = false;
        q.where = jest.fn((col, val) => { if (col === 'es.system_type' && val === 'backpack') backpackOnly = true; return q; });
        const rows = () => (backpackOnly ? [otherFlowZone] : []);
        q.first = jest.fn(async () => rows()[0] || null);
        q.then = (res, rej) => Promise.resolve(rows()).then(res, rej);
        q.catch = (rej) => Promise.resolve(rows()).catch(rej);
        return q;
      }
      if (table === 'equipment_systems') {
        let queriedId = null;
        const q = readQuery([]);
        q.where = jest.fn((arg) => { queriedId = arg?.id || null; return q; });
        q.first = jest.fn(async () => (queriedId === 'bp-sys-1'
          ? { system_type: 'backpack', tank_capacity_gal: 4, system_name: 'FlowZone Typhoon 3.0 #1' }
          : { system_type: 'tank', tank_capacity_gal: 110, system_name: '110-Gallon Spray Tank #1' }));
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const fzPin = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'bp-sys-1', assigned_calibration_id: 'bp-old-superseded', technician_id: 'tech-a' },
    );
    expect(fzPin.calibration).toBeNull();
    expect(fzPin.calibrationScope.unresolvedPinRigId).toBe('bp-sys-1');
    expect(await getBackpackCalibration(fzPin.calibration, fzPin.calibrationScope)).toBeNull();

    // A stale pin on a 110-gal truck tank still permits the independent 4-gal FlowZone spot column.
    const truckPin = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: 'tank-sys-1', assigned_calibration_id: 'tank-old-superseded', technician_id: 'tech-a' },
    );
    expect(await getBackpackCalibration(truckPin.calibration, truckPin.calibrationScope)).toEqual(otherFlowZone);
  });

  test('an unresolved calibration-only pin skips the alternate 110-gal tank fallback even when two tanks have different outputs', async () => {
    const tank1 = { id: 'tank-1', equipment_system_id: 'sys-1', technician_id: null, system_name: '110-Gallon Spray Tank #1', system_type: 'tank', tank_capacity_gal: 110, carrier_gal_per_1000: 1.5 };
    const tank2 = { id: 'tank-2', equipment_system_id: 'sys-2', technician_id: null, system_name: '110-Gallon Spray Tank #2', system_type: 'tank', tank_capacity_gal: 110, carrier_gal_per_1000: 2.5 };
    db.mockImplementation((table) => {
      if (table === 'equipment_calibrations') {
        const q = readQuery([]);
        q.first = jest.fn(() => Promise.reject(new Error('lookup failed')));
        return q;
      }
      if (table === 'equipment_calibrations as ec') {
        let filteredOut = false;
        const q = readQuery([tank1, tank2]);
        q.where = jest.fn((col, val) => { if (col === 'ec.id' && val === 'cal-missing') filteredOut = true; return q; });
        q.first = jest.fn(async () => (filteredOut ? null : tank1));
        q.then = (res, rej) => Promise.resolve(filteredOut ? [] : [tank1, tank2]).then(res, rej);
        q.catch = (rej) => Promise.resolve(filteredOut ? [] : [tank1, tank2]).catch(rej);
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const sheetCal = await loadSheetCalibration(
      { query: {}, admin: { role: 'admin' } },
      { assigned_equipment_system_id: null, assigned_calibration_id: 'cal-missing', technician_id: 'tech-a' },
    );
    expect(sheetCal.rigId).toBeNull();
    expect(sheetCal.calibrationScope.unresolvedPinRigId).toBe('__unknown__');
    expect(await getActiveBigTanks(sheetCal.calibrationScope)).toEqual([]);
    expect(await getBackpackCalibration(sheetCal.calibration, sheetCal.calibrationScope)).toBeNull();
  });
});

