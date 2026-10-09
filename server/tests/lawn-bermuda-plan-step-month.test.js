// The visit PLAN decides the bermuda removal step from the APPOINTMENT's own month (stepMonthOf), the
// rule the tank sheet, the completion actions and the completion checks use, never from the assigned
// protocol window's month. An April-window visit moved into June has the June step, one moved into
// May has none, a June-window visit moved into April has the April step. The staged step rows are the
// appointment month's, loaded when the assigned window is another month's, and they replace the assigned
// window's own step rows in the ONE product list the plan, the completion defaults and the ledger read.
// A step row never overwrites an ordinary row for the same catalog product (May's weed-mix surfactant
// and the June step's surfactant), and a step line never reads the ordinary row.
const mockLoadRows = jest.fn();
jest.mock('../services/waveguard-plan-engine', () => ({ loadV13RowsForMonth: (...args) => mockLoadRows(...args) }));

const { openPlanStep, stepMonthOf, stepAddOn, rowsByProduct, rowFor, productRowFor } = require('../services/lawn-bermuda-removal');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

// A knex fake that answers the one property read the staff switch needs: a one-property customer.
const fakeKnex = () => {
  const query = { where: () => query, select: async () => [{ id: 'prop-1', is_primary: true }] };
  return () => query;
};
const profile = { grass_type: 'st_augustine', cultivar: 'Floratam', bermuda_removal: true };
const service = (date) => ({ id: 'plan-visit', customer_id: 'fixture-customer', property_id: null, scheduled_date: date });
const stage = async (date, windowMonth, extra = {}) => {
  const step = await openPlanStep(fakeKnex(), { enabled: true, service: service(date), profile, calendarTrackKey: 'st_augustine', ...extra });
  return step.resolve({
    structuredProtocol: { version: LAWN_V13_VERSION, window: { month: windowMonth } },
    trackKey: 'st_augustine',
    parseLines: (text) => [{ raw: text }],
  });
};
const STEP_ROW = { productId: 'rec', gates: { bermudaRemoval: true, morningUnderF: 85 } };
const BASE = { productId: 'base', gates: {} };
const ASSIGNED_STEP = { productId: 'rec', gates: { bermudaRemoval: true } };
const ASSIGNED = { version: LAWN_V13_VERSION, window: { month: 4 }, products: [BASE, ASSIGNED_STEP] };
const idsOf = (protocol) => protocol.products.map((row) => row.productId);

beforeEach(() => {
  process.env.GATE_LAWN_V13 = 'true';
  process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
  mockLoadRows.mockReset();
  mockLoadRows.mockResolvedValue(rowsByProduct([BASE, STEP_ROW]));
});
afterEach(() => { delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });

test('stepMonthOf: the appointment month when it is a step month, else null', () => {
  expect(stepMonthOf({ scheduled_date: '2026-04-14' }, 'st_augustine')).toBe('Apr');
  expect(stepMonthOf({ scheduled_date: '2026-06-02' }, 'zoysia')).toBe('Jun');
  expect(stepMonthOf({ scheduled_date: '2026-05-12' }, 'st_augustine')).toBeNull();
  expect(stepMonthOf({ scheduled_date: '2026-06-02' }, 'bahia')).toBeNull();
  expect(stepMonthOf({}, 'st_augustine')).toBeNull();
});

test('an April-window visit moved into June gets the June step, with the June staged rows', async () => {
  const result = await stage('2026-06-09', 4);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ raw: stepAddOn('st_augustine', 'Jun').secondary, bermudaStep: true });
  expect(result.field.bermudaRemoval).toEqual({ active: true, source: 'staff', mix: stepAddOn('st_augustine', 'Jun').summary, month: 'Jun' });
  expect(mockLoadRows).toHaveBeenCalledWith(expect.anything(), 'st_augustine', 'Jun', { includeBermudaRemoval: true });
  // The window's own rows stay; the June step row replaces April's.
  const protocol = result.protocol(ASSIGNED);
  expect(protocol.products).toContain(BASE);
  expect(protocol.products).toContain(STEP_ROW);
  expect(protocol.products).not.toContain(ASSIGNED_STEP);
  expect(protocol.window).toBe(ASSIGNED.window);
});

test('an April-window visit moved into May gets no step and loads nothing', async () => {
  const result = await stage('2026-05-12', 4);
  expect(result.lines).toEqual([]);
  expect(result.field).toEqual({});
  expect(mockLoadRows).not.toHaveBeenCalled();
  expect(result.protocol(ASSIGNED)).toBe(ASSIGNED);
});

test('a June-window visit moved into April gets the April step, with the April staged rows', async () => {
  const result = await stage('2026-04-14', 6);
  expect(result.field.bermudaRemoval).toEqual({ active: true, source: 'staff', mix: stepAddOn('st_augustine', 'Apr').summary, month: 'Apr' });
  expect(mockLoadRows).toHaveBeenCalledWith(expect.anything(), 'st_augustine', 'Apr', { includeBermudaRemoval: true });
});

test('a visit in its own window month keeps the window products and loads nothing', async () => {
  const result = await stage('2026-04-14', 4);
  expect(result.field.bermudaRemoval.active).toBe(true);
  expect(mockLoadRows).not.toHaveBeenCalled();
  expect(result.protocol(ASSIGNED)).toBe(ASSIGNED);
});

test('a window that is not on v13 carries no step, whatever the date', async () => {
  const step = await openPlanStep(fakeKnex(), { enabled: true, service: service('2026-06-09'), profile, calendarTrackKey: 'st_augustine' });
  const result = await step.resolve({ structuredProtocol: { version: '2026.05', window: { month: 6 } }, trackKey: 'st_augustine', parseLines: () => [] });
  expect(result.field).toEqual({});
});

test('a missing staged protocol for the appointment month reads as no step rows (the step is withheld), not an error', async () => {
  mockLoadRows.mockRejectedValue(Object.assign(new Error('missing'), { code: 'lawn_v13_protocol_missing' }));
  const result = await stage('2026-06-09', 4, { strict: true });
  // The assigned (April) window's own step row is NOT kept: it carries another month's conditions.
  expect(idsOf(result.protocol(ASSIGNED))).toEqual(['base']);
});

test('another read error: the plan panel withholds the rows, a strict caller gets the error', async () => {
  mockLoadRows.mockRejectedValue(new Error('read failed'));
  await expect(stage('2026-06-09', 4, { strict: true })).rejects.toThrow('read failed');
  const lenient = await stage('2026-06-09', 4);
  expect(idsOf(lenient.protocol(ASSIGNED))).toEqual(['base']);
});

test('a partial load for the appointment month never falls back to the assigned window\'s step rows', async () => {
  const assigned = { ...ASSIGNED, products: [...ASSIGNED.products, { productId: 'fus', gates: { bermudaRemoval: true } }] };
  const result = await stage('2026-06-02', 4);
  expect(idsOf(result.protocol(assigned))).toEqual(['base', 'rec']);
});

test('the window month arrives as the stored number: 6 is June, so a June visit in its own window loads nothing (codex #6229 r1 P2)', async () => {
  const same = await stage('2026-06-02', 6);
  expect(mockLoadRows).not.toHaveBeenCalled();
  expect(same.protocol(ASSIGNED)).toBe(ASSIGNED);
  await stage('2026-06-02', 4);
  expect(mockLoadRows).toHaveBeenCalledTimes(1);
});

// A May window carries the ordinary Celsius weed mix, with LESCO 90/10 as its surfactant; the June
// step uses the same catalog product on its own tagged row (codex #6229 r2 P2).
describe('May window, June appointment: distinct rows for one catalog product', () => {
  const MAY_NIS = { productId: 'nis', productName: 'LESCO 90/10', defaultInPlan: true, gates: { concentration: '0.25% v/v' } };
  const MAY_CEL = { productId: 'cel', defaultInPlan: true, gates: {} };
  const JUN_NIS = { productId: 'nis', productName: 'LESCO 90/10', defaultInPlan: false, gates: { bermudaRemoval: true, morningUnderF: 85 } };
  const JUN_REC = { productId: 'rec', defaultInPlan: false, gates: { bermudaRemoval: true, morningUnderF: 85 } };
  const JUN_FUS = { productId: 'fus', defaultInPlan: false, gates: { bermudaRemoval: true, morningUnderF: 85 } };
  const MAY = { version: LAWN_V13_VERSION, window: { month: 5 }, products: [MAY_CEL, MAY_NIS] };

  beforeEach(() => { mockLoadRows.mockResolvedValue(rowsByProduct([JUN_REC, JUN_FUS, JUN_NIS])); });

  test('the effective product list keeps the ordinary surfactant row and adds the three June step rows', async () => {
    const protocol = (await stage('2026-06-09', 5)).protocol(MAY);
    expect(protocol.products).toEqual([MAY_CEL, MAY_NIS, JUN_REC, JUN_FUS, JUN_NIS]);
    expect(mockLoadRows).toHaveBeenCalledWith(expect.anything(), 'st_augustine', 'Jun', { includeBermudaRemoval: true });
  });

  test('the rows by catalog id: the ordinary line reads its May row, the step line reads its June row', async () => {
    const rows = rowsByProduct((await stage('2026-06-09', 5)).protocol(MAY).products);
    expect(rowFor(rows, 'nis')).toBe(MAY_NIS);
    expect(rowFor(rows, 'nis', true)).toBe(JUN_NIS);
    expect(rowFor(rows, 'rec', true)).toBe(JUN_REC);
    expect(rowFor(rows, 'fus', true)).toBe(JUN_FUS);
  });

  test('the same on a product list (the completion defaults and the ledger read lists)', async () => {
    const { products } = (await stage('2026-06-09', 5)).protocol(MAY);
    expect(productRowFor(products, 'nis')).toBe(MAY_NIS);
    expect(productRowFor(products, 'nis', true)).toBe(JUN_NIS);
    expect(productRowFor(products, 'rec', true)).toBe(JUN_REC);
  });

  test('a step line never reads an ordinary row: with no tagged row for the product it has none', () => {
    const rows = rowsByProduct([MAY_NIS]);
    expect(rowFor(rows, 'nis', true)).toBeNull();
    expect(productRowFor([MAY_NIS], 'nis', true)).toBeNull();
    expect(rowFor(rows, 'nis')).toBe(MAY_NIS);
  });

  test('a failed June load leaves no step row, so the step is withheld and the ordinary row stands', async () => {
    mockLoadRows.mockRejectedValue(Object.assign(new Error('missing'), { code: 'lawn_v13_protocol_missing' }));
    const { products } = (await stage('2026-06-09', 5)).protocol(MAY);
    expect(products).toEqual([MAY_CEL, MAY_NIS]);
    expect(productRowFor(products, 'nis', true)).toBeNull();
  });
});

test('no protocol resolved (a grass with no v13 program, a missing staged protocol): no step and no throw (codex #6229 r3 P1)', async () => {
  const step = await openPlanStep(fakeKnex(), { enabled: true, service: service('2026-06-02'), profile, calendarTrackKey: 'st_augustine' });
  const result = await step.resolve({ structuredProtocol: null, trackKey: 'st_augustine', parseLines: (text) => [{ raw: text }] });
  expect(result.lines).toEqual([]);
  expect(result.field).toEqual({});
  expect(mockLoadRows).not.toHaveBeenCalled();
});
