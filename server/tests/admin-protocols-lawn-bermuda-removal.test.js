// Lawn tank sheet (GET /api/admin/protocols/lawn-mix) and /completion-actions with
// the bermuda removal step (GATE_LAWN_BERMUDA_REMOVAL + GATE_LAWN_V13). A sheet
// opened for a visit (`scheduledServiceId`) carries the April / June step when that
// visit's account asked for it: the SERVER reads the account (staff switch or
// accepted estimate, then the cultivar policy); no client names the step. Real
// handlers and plan engine; protocol context, catalog and account are fixtures.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/application-limits', () => ({ checkLimits: jest.fn(async () => ({ blocks: [], warnings: [] })) }));
jest.mock('../services/lawn-protocol-operating-layer', () => ({
  getActiveLawnProtocol: jest.fn(),
  getProtocolWindowContext: jest.fn(),
  summarizeProtocolContext: jest.fn(),
  protocolReferenceSyncIssues: jest.fn(),
  lockDraftProtocol: jest.fn(),
}));

const db = require('../models/db');
const operatingLayer = require('../services/lawn-protocol-operating-layer');
const applicationLimits = require('../services/application-limits');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

const REC = 'Recognition Post Emergent Herbicide';
const FUS = 'Fusilade II Post Emergent Liquid Herbicide';
const NIS = 'LESCO 90/10 Nonionic Surfactant';
const CATALOG = [
  { id: 'rec', name: REC, aliases: [], default_rate_per_1000: 0.03, rate_unit: 'oz', cost_per_unit: 1, cost_unit: 'oz' },
  { id: 'fus', name: FUS, aliases: [], default_rate_per_1000: 0.55, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'nis', name: NIS, aliases: [], default_rate_per_1000: 0.25, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'f24', name: 'LESCO 24-0-11 with PolyPlus OPTI', aliases: [], analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
];
const GATES = { bermudaRemoval: true, activelyGrowingOnly: true, noRainOrIrrigationHours: 3, noMowDaysBeforeAfter: 2, skipCelsiusInBermudaArea: true };
const ROWS = {
  f24: { productId: 'f24', ratePer1000: null, rateUnit: 'lb_n', gates: {} },
  rec: { productId: 'rec', applicationMode: 'spot', ratePer1000: 0.03, rateUnit: 'oz', gates: { ...GATES, tankMixWith: FUS } },
  fus: { productId: 'fus', applicationMode: 'spot', ratePer1000: 0.55, rateUnit: 'fl oz', gates: { ...GATES, requiresProduct: 'Recognition' } },
  nis: { productId: 'nis', applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', gates: { ...GATES, concentration: '0.25% of the spray volume' } },
};

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
// The visit's account, as the fake db serves it. Reset before each test.
let account;
const freshAccount = () => ({
  customerId: 'cust-1',
  profile: { grass_type: 'st_augustine', cultivar: 'Floratam', bermuda_removal: true, active: true },
  estimates: [],
});

const handler = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/lawn-mix' && layer.route.methods.get).route.stack[0].handle;

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'whereNull', 'orWhereNull', 'whereIn', 'join', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  query.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return query;
}

async function lawnMix(query) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { track: 'st_augustine', month: '4', lawnSqft: '10000', ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}
const itemFor = (body, name) => body.items.find((item) => item.product?.name === name);
const blockCodes = (body) => body.blocks.map((block) => block.code);

function stage(rows) {
  operatingLayer.getProtocolWindowContext.mockResolvedValue({ protocol: { version: LAWN_V13_VERSION } });
  operatingLayer.summarizeProtocolContext.mockReturnValue({ version: LAWN_V13_VERSION, products: rows });
}

beforeEach(() => {
  jest.clearAllMocks();
  account = freshAccount();
  process.env.GATE_LAWN_V13 = 'true';
  process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
  stage(Object.values(ROWS));
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') {
      return readQuery([{ id: 'cal', equipment_system_id: 'tank', system_name: 'Tank', system_type: 'tank', carrier_gal_per_1000: 1, tank_capacity_gal: 110, expires_at: '2099-01-01T00:00:00Z' }]);
    }
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery([]);
    if (table === 'scheduled_services') return readQuery(account.customerId ? [{ id: SERVICE_ID, customer_id: account.customerId, scheduled_date: '2026-04-14' }] : []);
    if (table === 'customer_turf_profiles') return readQuery(account.profile ? [account.profile] : []);
    if (table === 'estimates') return readQuery(account.estimates);
    throw new Error(`Unexpected table: ${table}`);
  });
});
afterEach(() => { delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });

test.each([['st_augustine', '4'], ['zoysia', '6']])('%s month %s: the three spot lines show with the label rate and no amount; the loader asks for the bermuda rows', async (track, month) => {
  const body = await lawnMix({ track, month, scheduledServiceId: SERVICE_ID });
  expect(operatingLayer.getProtocolWindowContext).toHaveBeenCalledWith(db, expect.objectContaining({ includeBermudaRemoval: true }));
  for (const name of [REC, FUS, NIS]) {
    const item = itemFor(body, name);
    expect(item.jobMix).toBeNull();
    expect(item.plannedMix).toBeNull();
    expect(item.spot.note).toMatch(/enter the area/i);
  }
  expect(itemFor(body, REC).spot.reference).toBe('Label rate 0.03 oz per 1,000 sq ft');
  expect(itemFor(body, FUS).spot.reference).toBe('Label rate 0.55 fl oz per 1,000 sq ft');
  expect(blockCodes(body)).toEqual([]);
});

test.each([['fus'], ['rec'], ['nis']])('selecting only %s selects all three lines together', async (id) => {
  const body = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: id });
  expect(body.selectedItems.filter((item) => item.bermudaStep).map((item) => item.product?.name).sort()).toEqual([FUS, NIS, REC].sort());
  expect(blockCodes(body)).toEqual([]);
});

test.each([['rec'], ['fus'], ['nis']])('%s has no staged row: none of the three is on the sheet, with the reason', async (missing) => {
  stage(Object.entries(ROWS).filter(([key]) => key !== missing).map(([, row]) => row));
  const body = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec,fus' });
  for (const name of [REC, FUS, NIS]) expect(itemFor(body, name)).toBeUndefined();
  expect(blockCodes(body)).toContain('lawn_bermuda_step_unavailable');
});

describe('/completion-actions', () => {
  const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
  const call = async (query) => {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    await completionActions({ query: { serviceType: 'Lawn Care', track: 'st_augustine', month: '4', ...query } }, res, jest.fn());
    return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
  };
  const productNames = (body) => body.actions.map((action) => action.product?.name).filter(Boolean);

  test('a bermuda removal visit lists the three products, with no amounts', async () => {
    const body = await call({ scheduledServiceId: SERVICE_ID });
    expect(productNames(body)).toEqual(expect.arrayContaining([REC, FUS, NIS]));
    expect(JSON.stringify(body.actions)).not.toMatch(/"defaultRatePer1000":\s*[1-9]/);
  });

  test.each([
    ['no visit named', { scheduledServiceId: undefined }, {}],
    ['the old bermudaRemoval=true parameter does nothing without a visit', { scheduledServiceId: undefined, bermudaRemoval: 'true' }, {}],
    ['Bermuda track', { track: 'bermuda', scheduledServiceId: SERVICE_ID }, {}],
    ['other month', { month: '5', scheduledServiceId: SERVICE_ID }, {}],
    ['gate off', { scheduledServiceId: SERVICE_ID }, { GATE_LAWN_BERMUDA_REMOVAL: undefined }],
  ])('%s: none of the three', async (_label, query, env) => {
    for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const names = productNames(await call(query));
    for (const name of [REC, FUS]) expect(names).not.toContain(name);
  });
});

test.each([
  ['no visit named', { scheduledServiceId: undefined }, {}],
    ['the old bermudaRemoval=true parameter does nothing without a visit', { scheduledServiceId: undefined, bermudaRemoval: 'true' }, {}],
  ['Bermuda track', { track: 'bermuda', scheduledServiceId: SERVICE_ID }, {}],
  ['Bahia track', { track: 'bahia', scheduledServiceId: SERVICE_ID }, {}],
  ['other month (May)', { month: '5', scheduledServiceId: SERVICE_ID }, {}],
  ['gate off', { scheduledServiceId: SERVICE_ID }, { GATE_LAWN_BERMUDA_REMOVAL: undefined }],
])('%s: no bermuda lines, no bermuda loader flag', async (_label, query, env) => {
  for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  const body = await lawnMix(query);
  expect(itemFor(body, REC)).toBeUndefined();
  expect(itemFor(body, FUS)).toBeUndefined();
  expect(operatingLayer.getProtocolWindowContext).toHaveBeenCalledWith(db, expect.not.objectContaining({ includeBermudaRemoval: true }));
});

describe('the account decides, on the server', () => {
  const stepNames = (body) => body.items.filter((item) => item.bermudaStep).map((item) => item.product?.name).sort();
  const all = [FUS, NIS, REC].sort();
  const estimate = { estimate_data: { engineRequest: { options: { bermudaSuppression: true } } } };

  test('staff switch on: the step is on the sheet for the visit', async () => {
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test('neither the switch nor an estimate: no step', async () => {
    account.profile.bermuda_removal = false;
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual([]);
  });

  test('an accepted estimate carrying the add-on on a St. Augustine lawn: the step', async () => {
    account.profile.bermuda_removal = false;
    account.estimates = [estimate];
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test('the estimate counts only while the CURRENT profile grass is St. Augustine: a reclassified Zoysia lawn needs the staff switch', async () => {
    account.profile = { ...account.profile, grass_type: 'zoysia', bermuda_removal: false };
    account.estimates = [estimate];
    expect(stepNames(await lawnMix({ track: 'zoysia', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    account.profile.bermuda_removal = true;
    expect(stepNames(await lawnMix({ track: 'zoysia', scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test.each(['ProVista', 'Captiva', 'Seville'])('%s: no step, and the sheet says why', async (cultivar) => {
    account.profile.cultivar = cultivar;
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID });
    expect(stepNames(body)).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain('lawn_bermuda_cultivar_excluded');
  });

  test.each(['CitraBlue', null])('cultivar %p: the step with a hard test-patch note on each line', async (cultivar) => {
    account.profile.cultivar = cultivar;
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec' });
    const lines = body.items.filter((item) => item.bermudaStep);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.gateNotes.find((n) => n.key === 'testPatchFirst')).toMatchObject({ severity: 'required' });
    expect(body.warnings.filter((w) => w.code === 'lawn_v13_product_gate' && /Test patch first/.test(w.message))).toHaveLength(3);
  });

  test.each([['rec'], ['fus']])('%s limited by an application limit: none of the three is on the sheet, with the limit block and the reason', async (limited) => {
    applicationLimits.checkLimits.mockImplementation(async (_customer, productId) => (productId === limited
      ? { blocks: [{ message: 'Limit reached.' }], warnings: [] } : { blocks: [], warnings: [] }));
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID });
    expect(stepNames(body)).toEqual([]);
    expect(blockCodes(body)).toEqual(expect.arrayContaining(['lawn_bermuda_step_unavailable']));
    applicationLimits.checkLimits.mockImplementation(async () => ({ blocks: [], warnings: [] }));
  });

  test('a malformed visit id reads nothing and shows no step', async () => {
    expect(stepNames(await lawnMix({ scheduledServiceId: 'not-a-uuid' }))).toEqual([]);
    expect(db.mock.calls.some(([table]) => table === 'scheduled_services')).toBe(false);
  });

  test('the three completion actions share one group id; other actions carry none', async () => {
    const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    await completionActions({ query: { serviceType: 'Lawn Care', track: 'st_augustine', month: '4', scheduledServiceId: SERVICE_ID } }, res, jest.fn());
    const { actions } = JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
    const grouped = actions.filter((a) => a.group);
    expect(grouped.map((a) => a.product?.name).sort()).toEqual(all);
    expect(new Set(grouped.map((a) => a.group))).toEqual(new Set(['bermuda_removal']));
    expect(actions.filter((a) => !a.group && /Recognition|Fusilade/.test(a.raw || ''))).toEqual([]);
  });
});

describe('/programs and the recipe readers with the removal gate off', () => {
  const programs = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/programs' && layer.route.methods.get).route.stack[0].handle;
  const call = async (query) => {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    await programs({ query, techRole: 'admin' }, res, jest.fn());
    return JSON.stringify(res.json.mock.calls[0][0]);
  };

  test('gate off: the track program shows no addOns; gate on: the April and June visits carry them', async () => {
    delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
    expect(await call({ track: 'zoysia' })).not.toContain('addOns');
    expect(await call({ track: 'st_augustine' })).not.toContain('Recognition');
    process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
    expect((await call({ track: 'zoysia' })).match(/"addOns"/g)).toHaveLength(2);
  });
});
