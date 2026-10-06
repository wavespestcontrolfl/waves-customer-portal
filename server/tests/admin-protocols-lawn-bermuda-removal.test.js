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

// An accepted estimate whose current priced result still carries the add-on on its lawn line.
const BERMUDA_ESTIMATE = { engineRequest: { options: { bermudaSuppression: true } }, result: { results: { lawnMeta: { bermudaSuppression: { perApp: 25 } } } } };
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
  properties: [{ id: 'prop-1', is_primary: true }],
  visitProperty: 'prop-1',
  visitDate: '2026-04-14',
  serviceType: 'Lawn Care',
  pin: null,
  // The program's tagged product_limits rows: Recognition holds the label-rate row, Fusilade II the others.
  tagged: [{ product_id: 'rec', limit_type: 'annual_max_apps' }, { product_id: 'rec', limit_type: 'annual_max_rate' }, { product_id: 'fus', limit_type: 'annual_max_apps' }],
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
    if (table === 'scheduled_services') return readQuery(account.customerId ? [{ id: SERVICE_ID, customer_id: account.customerId, property_id: account.visitProperty, scheduled_date: account.visitDate, service_type: account.serviceType, lawn_protocol_version: account.pin }] : []);
    if (table === 'customer_turf_profiles') return readQuery(account.profile ? [account.profile] : []);
    if (table === 'estimates') return readQuery(account.estimates);
    if (table === 'customer_properties') return readQuery(account.properties);
    if (table === 'product_limits') return readQuery(account.tagged);
    throw new Error(`Unexpected table: ${table}`);
  });
});
afterEach(() => { delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });

test.each([['st_augustine', '4'], ['zoysia', '6']])('%s month %s: the three spot lines show with the label rate and no amount; the loader asks for the bermuda rows', async (track, month) => {
  account.profile.grass_type = track;
  account.visitDate = month === '6' ? '2026-06-16' : '2026-04-14';
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

describe('the Zoysia 2(ee) note: a required gate note on the Zoysia lines only', () => {
  const NOTE = 'Zoysia: this mix is a Syngenta FIFRA 2(ee) recommendation (2023-03-28), not the printed label — keep the 2(ee) on hand when applying.';
  const stageWithNote = () => stage(Object.values(ROWS).map((row) => (row.gates.bermudaRemoval ? { ...row, gates: { ...row.gates, zoysia2eeOnHand: true } } : row)));
  const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
  const actionsFor = async (query) => {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    await completionActions({ query: { serviceType: 'Lawn Care', month: '4', scheduledServiceId: SERVICE_ID, ...query } }, res, jest.fn());
    return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
  };
  const noteOf = (item) => (item.gateNotes || []).find((n) => n.key === 'zoysia2eeOnHand');

  test('Zoysia: the sheet lines, the selected-line warnings and the completion actions carry it, required', async () => {
    account.profile.grass_type = 'zoysia';
    stageWithNote();
    const body = await lawnMix({ track: 'zoysia', scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec' });
    const lines = body.items.filter((item) => item.bermudaStep);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(noteOf(line)).toEqual({ key: 'zoysia2eeOnHand', severity: 'required', text: NOTE });
    expect(body.warnings.filter((w) => w.gate === 'zoysia2eeOnHand')).toHaveLength(3);
    const actions = (await actionsFor({ track: 'zoysia' })).actions.filter((a) => a.group);
    expect(actions).toHaveLength(3);
    for (const action of actions) expect(noteOf(action)).toMatchObject({ severity: 'required', text: NOTE });
  });

  test('St. Augustine lines (rows without the key) never carry it', async () => {
    stageWithNote();
    // The St. Augustine staged rows are the ones without the key: stage them as the migration leaves them.
    stage(Object.values(ROWS));
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec' });
    for (const line of body.items.filter((item) => item.bermudaStep)) expect(noteOf(line)).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/2\(ee\)/);
    for (const action of (await actionsFor({})).actions.filter((a) => a.group)) expect(noteOf(action)).toBeUndefined();
  });
});

test.each([['fus'], ['rec'], ['nis']])('selecting only %s selects all three lines together', async (id) => {
  const body = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: id });
  expect(body.selectedItems.filter((item) => item.bermudaStep).map((item) => item.product?.name).sort()).toEqual([FUS, NIS, REC].sort());
  expect(blockCodes(body)).toEqual([]);
});

describe('a step that cannot be applied', () => {
  const warningCodes = (body) => body.warnings.map((w) => w.code);
  const f24 = (body) => itemFor(body, 'LESCO 24-0-11 with PolyPlus OPTI');

  test.each([['rec'], ['fus'], ['nis']])('%s has no staged row, nothing selected: the three lines leave with a warning; base quantities and mixing order stay', async (missing) => {
    stage(Object.entries(ROWS).filter(([key]) => key !== missing).map(([, row]) => row));
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID });
    for (const name of [REC, FUS, NIS]) expect(itemFor(body, name)).toBeUndefined();
    expect(warningCodes(body)).toContain('lawn_bermuda_step_unavailable');
    expect(blockCodes(body)).not.toContain('lawn_bermuda_step_unavailable');
    expect(body.blocks).toEqual([]);
    expect(f24(body).jobMix).toMatchObject({ amountUnit: 'lb' });
    expect(f24(body).jobMix.amount).toBeGreaterThan(0);
  });

  test.each([['rec'], ['fus'], ['nis']])('%s has no staged row, the step selected: the three lines stay unavailable with product-scoped blocks, and base quantities and mixing order still stand', async (missing) => {
    stage(Object.entries(ROWS).filter(([key]) => key !== missing).map(([, row]) => row));
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec,fus' });
    const lines = body.items.filter((item) => item.bermudaStep);
    expect(lines).toHaveLength(3);
    for (const line of lines) { expect(line.unavailable.reason).toMatch(/Bermuda removal is blocked/); expect(line.spot).toBeNull(); }
    expect(body.blocks.filter((b) => b.code === 'lawn_bermuda_step_unavailable')).toHaveLength(3);
    expect(f24(body).jobMix.amount).toBeGreaterThan(0);
    expect(body.mixingOrder.length).toBeGreaterThan(0);
  });
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
    // (A Bermuda REQUEST track no longer matters with a visit named: the profile's grass decides; see the Zoysia test below.)
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
  const estimate = { estimate_data: BERMUDA_ESTIMATE };

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

  test.each([['rec'], ['fus']])('%s limited by an application limit, nothing selected: the three lines leave with a warning; the sheet is not blocked', async (limited) => {
    applicationLimits.checkLimits.mockImplementation(async (_customer, productId) => (productId === limited
      ? { blocks: [{ message: 'Limit reached.' }], warnings: [] } : { blocks: [], warnings: [] }));
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID });
    expect(stepNames(body)).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain('lawn_bermuda_step_unavailable');
    expect(body.blocks).toEqual([]);
    expect(body.mixingOrder.length).toBeGreaterThan(0);
    applicationLimits.checkLimits.mockImplementation(async () => ({ blocks: [], warnings: [] }));
  });

  test('the track comes from the active profile, never the request: a ProVista St. Augustine profile asked as zoysia gets no step', async () => {
    account.profile.cultivar = 'ProVista';
    expect(stepNames(await lawnMix({ track: 'zoysia', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    account.profile.cultivar = 'Floratam';
    expect(stepNames(await lawnMix({ track: 'zoysia', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    // And the reverse: a Zoysia profile asked as St. Augustine.
    account.profile = { ...account.profile, grass_type: 'zoysia' };
    expect(stepNames(await lawnMix({ track: 'st_augustine', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    expect(stepNames(await lawnMix({ track: 'zoysia', scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test('a two-property customer: the step is on the primary property\'s visit only', async () => {
    account.properties = [{ id: 'prop-1', is_primary: true }, { id: 'prop-2', is_primary: false }];
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual(all);
    account.visitProperty = 'prop-2';
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual([]);
    account.visitProperty = null;
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual([]);
  });

  test('estimate evidence for another property does not open the step', async () => {
    account.profile.bermuda_removal = false;
    account.properties = [{ id: 'prop-1', is_primary: true }, { id: 'prop-2', is_primary: false }];
    account.estimates = [{ ...estimate, property_id: 'prop-2' }];
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual([]);
    account.estimates = [{ ...estimate, property_id: 'prop-1' }];
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test('the step month is the VISIT\'s: a June request on an October visit opens nothing on the sheet or the actions; an April visit asked as June or June as April neither', async () => {
    const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
    const actionGroups = async (month) => {
      const res = { json: jest.fn(), status: jest.fn() };
      res.status.mockReturnValue(res);
      await completionActions({ query: { serviceType: 'Lawn Care', track: 'st_augustine', month, scheduledServiceId: SERVICE_ID } }, res, jest.fn());
      return JSON.parse(JSON.stringify(res.json.mock.calls[0][0])).actions.filter((a) => a.group);
    };
    account.visitDate = '2026-10-12';
    expect(stepNames(await lawnMix({ month: '6', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    expect(await actionGroups('6')).toEqual([]);
    expect(await actionGroups('4')).toEqual([]);
    account.visitDate = '2026-04-14';
    expect(stepNames(await lawnMix({ month: '6', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    expect(await actionGroups('6')).toEqual([]);
    expect(stepNames(await lawnMix({ month: '4', scheduledServiceId: SERVICE_ID }))).toEqual(all);
    expect(await actionGroups('4')).toHaveLength(3);
    account.visitDate = '2026-06-16';
    expect(stepNames(await lawnMix({ month: '4', scheduledServiceId: SERVICE_ID }))).toEqual([]);
    expect(stepNames(await lawnMix({ month: '6', scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test('the visit month is read as an Eastern calendar day (a late-evening UTC instant stays that ET day)', async () => {
    // 2026-05-01 03:00 UTC is April 30 in Eastern time: an April visit.
    account.visitDate = new Date('2026-05-01T03:00:00Z');
    expect(stepNames(await lawnMix({ month: '4', scheduledServiceId: SERVICE_ID }))).toEqual(all);
  });

  test('the base mixing order never holds a step line; the step has its own order (water, Recognition, Fusilade II, surfactant last) only when selected and available', async () => {
    const orderText = (body) => JSON.stringify(body.mixingOrder);
    // The base visit's own order is the order of a visit with no step at all.
    account.profile.bermuda_removal = false;
    const plain = await lawnMix({ scheduledServiceId: SERVICE_ID });
    expect(plain.bermudaMixingOrder).toBeUndefined();
    account.profile.bermuda_removal = true;
    const unselected = await lawnMix({ scheduledServiceId: SERVICE_ID });
    expect(unselected.bermudaMixingOrder).toBeUndefined();
    expect(unselected.mixingOrder).toEqual(plain.mixingOrder);
    const clean = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec' });
    expect(orderText(clean)).not.toMatch(/Recognition|Fusilade|Surfactant/);
    expect(clean.mixingOrder).toEqual(plain.mixingOrder);
    expect(clean.bermudaMixingOrder.map((step) => [step.step, step.productName])).toEqual([[1, 'Water'], [2, REC], [3, FUS], [4, NIS]]);
    // Capped Recognition with the group selected: the step is unavailable, so it has no order.
    applicationLimits.checkLimits.mockImplementation(async (_customer, productId) => (productId === 'rec'
      ? { blocks: [{ message: 'Limit reached.' }], warnings: [] } : { blocks: [], warnings: [] }));
    const capped = await lawnMix({ scheduledServiceId: SERVICE_ID, selectedConditionalProductIds: 'rec' });
    expect(capped.items.filter((item) => item.bermudaStep).every((item) => item.unavailable)).toBe(true);
    expect(orderText(capped)).not.toMatch(/Recognition|Fusilade|Surfactant/);
    expect(capped.bermudaMixingOrder).toBeUndefined();
    expect(capped.mixingOrder).toEqual(plain.mixingOrder);
    applicationLimits.checkLimits.mockImplementation(async () => ({ blocks: [], warnings: [] }));
  });

  test('the program\'s tagged limit rows missing: the step is unavailable (never judged on names), with the warning', async () => {
    account.tagged = [];
    const body = await lawnMix({ scheduledServiceId: SERVICE_ID });
    expect(stepNames(body)).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain('lawn_bermuda_step_unavailable');
    expect(body.blocks).toEqual([]);
  });

  test.each([['Pest Control Quarterly', null], ['Tree & Shrub Care', null], ['Lawn Care', '2026.05']])('the visit must be a lawn visit on the v13 program: %s pinned to %s shows no step on the sheet or the actions', async (serviceType, pin) => {
    const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
    const actionGroups = async () => {
      const res = { json: jest.fn(), status: jest.fn() };
      res.status.mockReturnValue(res);
      await completionActions({ query: { serviceType: 'Lawn Care', track: 'st_augustine', month: '4', scheduledServiceId: SERVICE_ID } }, res, jest.fn());
      return JSON.parse(JSON.stringify(res.json.mock.calls[0][0])).actions.filter((a) => a.group);
    };
    account.serviceType = serviceType;
    account.pin = pin;
    expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual([]);
    expect(await actionGroups()).toEqual([]);
    // The same account and month on a v13-pinned or unpinned lawn visit shows the step.
    account.serviceType = 'Lawn Care';
    for (const ok of ['2026.10-v13', null]) {
      account.pin = ok;
      expect(stepNames(await lawnMix({ scheduledServiceId: SERVICE_ID }))).toEqual(all);
      expect(await actionGroups()).toHaveLength(3);
    }
  });

  test('a malformed visit id reads nothing and shows no step', async () => {
    expect(stepNames(await lawnMix({ scheduledServiceId: 'not-a-uuid' }))).toEqual([]);
    expect(db.mock.calls.some(([table]) => table === 'scheduled_services')).toBe(false);
  });

  describe('/completion-actions runs the plan\'s step limit check', () => {
    const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
    const actionsFor = async (month = '4') => {
      const res = { json: jest.fn(), status: jest.fn() };
      res.status.mockReturnValue(res);
      await completionActions({ query: { serviceType: 'Lawn Care', track: 'st_augustine', month, scheduledServiceId: SERVICE_ID } }, res, jest.fn());
      return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
    };
    afterEach(() => applicationLimits.checkLimits.mockImplementation(async () => ({ blocks: [], warnings: [] })));

    test.each([['rec'], ['fus']])('%s capped or too soon: none of the three removal actions is offered, with the warning; other actions stay', async (limited) => {
      applicationLimits.checkLimits.mockImplementation(async (_customer, productId, _date, _db, opts) => (productId === limited && opts?.program === 'bermuda_removal'
        ? { blocks: [{ message: 'Limit reached.' }], warnings: [] } : { blocks: [], warnings: [] }));
      const body = await actionsFor();
      expect(body.actions.filter((a) => a.group)).toEqual([]);
      expect(body.actions.map((a) => a.product?.name)).not.toEqual(expect.arrayContaining([REC]));
      expect(body.warnings.map((w) => w.code)).toEqual(['lawn_bermuda_step_unavailable']);
      expect(body.actions.length).toBeGreaterThan(0);
    });

    test.each([['rec'], ['fus'], ['nis']])('%s has no staged row in the serving v13 window: none of the three removal actions is offered, with the warning', async (missing) => {
      stage(Object.entries(ROWS).filter(([key]) => key !== missing).map(([, row]) => row));
      const body = await actionsFor();
      expect(body.actions.filter((a) => a.group)).toEqual([]);
      expect(body.warnings.map((w) => w.code)).toEqual(['lawn_bermuda_step_unavailable']);
      expect(body.actions.length).toBeGreaterThan(0);
    });

    test('no staged v13 protocol at all: the removal actions are withheld, never offered', async () => {
      operatingLayer.getProtocolWindowContext.mockResolvedValue({ protocol: { version: '2026.06' } });
      operatingLayer.summarizeProtocolContext.mockReturnValue({ version: '2026.06', products: [] });
      const body = await actionsFor();
      expect(body.actions.filter((a) => a.group)).toEqual([]);
      expect(body.warnings.map((w) => w.code)).toEqual(['lawn_bermuda_step_unavailable']);
    });

    test.each([['CitraBlue'], [null]])('cultivar %p: each of the three actions carries the test-patch note', async (cultivar) => {
      account.profile.cultivar = cultivar;
      const body = await actionsFor();
      const grouped = body.actions.filter((a) => a.group);
      expect(grouped).toHaveLength(3);
      for (const action of grouped) expect(action.gateNotes.at(-1)).toMatchObject({ key: 'testPatchFirst', severity: 'required', text: expect.stringMatching(/3 x 3 ft patch/) });
      expect(body.actions.filter((a) => !a.group && a.gateNotes)).toEqual([]);
    });

    // Every spray condition of the staged rows rides each of the three actions (and only those
    // conditions: not the recipe note or the pairing note), no test-patch note
    // for an eligible cultivar. April has no morning limit; June adds it.
    test.each([
      ['4', ['activelyGrowingOnly', 'noRainOrIrrigationHours', 'noMowDaysBeforeAfter', 'skipCelsiusInBermudaArea']],
      ['6', ['activelyGrowingOnly', 'morningUnderF', 'noRainOrIrrigationHours', 'noMowDaysBeforeAfter', 'skipCelsiusInBermudaArea']],
    ])('month %s: each of the three actions carries the spray conditions %j', async (month, keys) => {
      account.visitDate = month === '6' ? '2026-06-16' : '2026-04-14';
      const withMorning = (gates) => (month === '6' ? { ...gates, morningUnderF: 85 } : gates);
      stage(Object.values(ROWS).map((row) => (row.gates.bermudaRemoval ? { ...row, gates: withMorning(row.gates) } : row)));
      const grouped = (await actionsFor(month)).actions.filter((a) => a.group);
      expect(grouped).toHaveLength(3);
      for (const action of grouped) expect(action.gateNotes.map((n) => n.key)).toEqual(keys);
      expect(grouped[0].gateNotes.find((n) => n.key === 'noMowDaysBeforeAfter').text).toMatch(/2 days/);
      expect(grouped[0].gateNotes.find((n) => n.key === 'skipCelsiusInBermudaArea').text).toBe('Skip the Celsius weed spot in the bermuda area today.');
      // Each action is a spot line with no catalog-derived amount.
      for (const action of grouped) expect(action).toMatchObject({ applicationMode: 'spot', prefillAmount: false });
    });

    test('an eligible cultivar carries no test-patch note; an excluded cultivar offers none of the three and says why', async () => {
      const ok = await actionsFor();
      expect(ok.actions.filter((a) => a.group && a.gateNotes.some((n) => n.key === 'testPatchFirst'))).toEqual([]);
      account.profile.cultivar = 'ProVista';
      const excluded = await actionsFor();
      expect(excluded.actions.filter((a) => a.group)).toEqual([]);
      expect(excluded.warnings.map((w) => w.code)).toEqual(['lawn_bermuda_cultivar_excluded']);
    });

    test('the step probe gets the staged rate, and a label-rate warning (0.12 recorded + 0.03 planned) reaches the response warnings, never a block', async () => {
      const message = 'Recognition Post Emergent Herbicide: cumulative 0.150 oz/1000sf/year (0.120 recorded plus 0.030 for this application) approaching/exceeding max 0.1437.';
      // The limit check warns only when the planned rate is counted: the proposal carries the staged 0.03.
      applicationLimits.checkLimits.mockImplementation(async (_customer, productId, _date, _db, opts) => (productId === 'rec' && opts?.program === 'bermuda_removal' && opts?.proposed?.ratePer1000 === 0.03
        ? { blocks: [], warnings: [{ type: 'annual_max_rate', message }] } : { blocks: [], warnings: [] }));
      const body = await actionsFor();
      expect(body.actions.filter((a) => a.group)).toHaveLength(3);
      expect(body.warnings).toEqual([expect.objectContaining({ code: 'lawn_v13_limit_warning', productId: 'rec', message })]);
      // Without a planned rate counted there is nothing to warn about: the proposal is what makes the warning.
      applicationLimits.checkLimits.mockImplementation(async () => ({ blocks: [], warnings: [] }));
      expect((await actionsFor()).warnings).toBeUndefined();
    });

    test('a Zoysia profile with a blank or stale request track still gets the April mix: the track comes from the visit\'s active profile, and never from the request when the visit is known', async () => {
      account.profile.grass_type = 'zoysia';
      const ask = async (query) => {
        const res = { json: jest.fn(), status: jest.fn() };
        res.status.mockReturnValue(res);
        await completionActions({ query: { serviceType: 'Lawn Care', month: '4', scheduledServiceId: SERVICE_ID, ...query } }, res, jest.fn());
        return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
      };
      // No track, a blank lawn type, and a stale track from the customer's lawn_type all get the mix.
      for (const query of [{}, { lawnType: '' }, { track: 'st_augustine' }, { lawnType: 'Bermuda' }, { track: 'bahia' }]) {
        expect((await ask(query)).actions.filter((a) => a.group)).toHaveLength(3);
      }
      // Without a booked visit the request's track is all there is: no step, as before.
      expect((await ask({ scheduledServiceId: undefined, track: 'zoysia' })).actions.filter((a) => a.group)).toEqual([]);
      // A profile of another grass opens nothing, whatever the request says.
      for (const grass of ['bahia', 'bermuda']) {
        account.profile.grass_type = grass;
        expect((await ask({ track: 'zoysia' })).actions.filter((a) => a.group)).toEqual([]);
      }
      // Gate off: the request's track is the answer and there is no step.
      account.profile.grass_type = 'zoysia';
      delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
      expect((await ask({ track: 'zoysia' })).actions.filter((a) => a.group)).toEqual([]);
    });

    test('nothing limited: the three actions are offered and there is no warning; the program is passed to the limit check', async () => {
      const body = await actionsFor();
      expect(body.actions.filter((a) => a.group)).toHaveLength(3);
      expect(body.warnings).toBeUndefined();
      expect(applicationLimits.checkLimits.mock.calls.some((call) => call[4]?.program === 'bermuda_removal')).toBe(true);
    });
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
