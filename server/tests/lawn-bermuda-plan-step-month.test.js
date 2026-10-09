// The visit PLAN decides the bermuda removal step from the APPOINTMENT's own month (stepMonthOf), the
// rule the tank sheet, the completion actions and the completion checks use, never from the assigned
// protocol window's month. An April-window visit moved into June has the June step, one moved into
// May has none, a June-window visit moved into April has the April step. The staged step rows are the
// appointment month's, loaded when the assigned window is another month's.
const mockLoadRows = jest.fn();
jest.mock('../services/waveguard-plan-engine', () => ({ loadV13RowsForMonth: (...args) => mockLoadRows(...args) }));

const { openPlanStep, stepMonthOf, stepAddOn } = require('../services/lawn-bermuda-removal');
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
const WINDOW_ROWS = new Map([['base', { productId: 'base', gates: {} }], ['rec', { productId: 'rec', gates: { bermudaRemoval: true } }]]);

beforeEach(() => {
  process.env.GATE_LAWN_V13 = 'true';
  process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
  mockLoadRows.mockReset();
  mockLoadRows.mockResolvedValue(new Map([['base', { productId: 'base', gates: {} }], ['rec', STEP_ROW]]));
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
  const result = await stage('2026-06-09', 'Apr');
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ raw: stepAddOn('st_augustine', 'Jun').secondary, bermudaStep: true });
  expect(result.field.bermudaRemoval).toEqual({ active: true, source: 'staff', mix: stepAddOn('st_augustine', 'Jun').summary });
  expect(mockLoadRows).toHaveBeenCalledWith(expect.anything(), 'st_augustine', 'Jun', { includeBermudaRemoval: true });
  // The window's own rows stay; the June step row replaces the April one.
  expect(result.rows(WINDOW_ROWS).get('rec')).toBe(STEP_ROW);
  expect(result.rows(WINDOW_ROWS).get('base')).toBe(WINDOW_ROWS.get('base'));
});

test('an April-window visit moved into May gets no step and loads nothing', async () => {
  const result = await stage('2026-05-12', 'Apr');
  expect(result.lines).toEqual([]);
  expect(result.field).toEqual({});
  expect(mockLoadRows).not.toHaveBeenCalled();
  expect(result.rows(WINDOW_ROWS)).toBe(WINDOW_ROWS);
});

test('a June-window visit moved into April gets the April step, with the April staged rows', async () => {
  const result = await stage('2026-04-14', 'Jun');
  expect(result.field.bermudaRemoval).toEqual({ active: true, source: 'staff', mix: stepAddOn('st_augustine', 'Apr').summary });
  expect(mockLoadRows).toHaveBeenCalledWith(expect.anything(), 'st_augustine', 'Apr', { includeBermudaRemoval: true });
});

test('a visit in its own window month keeps the window rows and loads nothing', async () => {
  const result = await stage('2026-04-14', 'Apr');
  expect(result.field.bermudaRemoval.active).toBe(true);
  expect(mockLoadRows).not.toHaveBeenCalled();
  expect(result.rows(WINDOW_ROWS)).toBe(WINDOW_ROWS);
});

test('a window that is not on v13 carries no step, whatever the date', async () => {
  const step = await openPlanStep(fakeKnex(), { enabled: true, service: service('2026-06-09'), profile, calendarTrackKey: 'st_augustine' });
  const result = await step.resolve({ structuredProtocol: { version: '2026.05', window: { month: 'Jun' } }, trackKey: 'st_augustine', parseLines: () => [] });
  expect(result.field).toEqual({});
});

test('a missing staged protocol for the appointment month reads as no step rows (the step is withheld), not an error', async () => {
  mockLoadRows.mockRejectedValue(Object.assign(new Error('missing'), { code: 'lawn_v13_protocol_missing' }));
  const result = await stage('2026-06-09', 'Apr', { strict: true });
  // The assigned (April) window's own step row is NOT kept: it carries another month's conditions.
  expect(result.rows(WINDOW_ROWS).has('rec')).toBe(false);
  expect(result.rows(WINDOW_ROWS).get('base')).toBe(WINDOW_ROWS.get('base'));
});

test('another read error: the plan panel withholds the rows, a strict caller gets the error', async () => {
  mockLoadRows.mockRejectedValue(new Error('read failed'));
  await expect(stage('2026-06-09', 'Apr', { strict: true })).rejects.toThrow('read failed');
  const lenient = await stage('2026-06-09', 'Apr');
  expect(lenient.rows(WINDOW_ROWS).has('rec')).toBe(false);
});

test('a partial load for the appointment month never falls back to the assigned window\'s step rows', async () => {
  const windowRows = new Map([...WINDOW_ROWS, ['fus', { productId: 'fus', gates: { bermudaRemoval: true } }]]);
  const result = await stage('2026-06-02', 'Apr');
  const merged = result.rows(windowRows);
  expect(merged.get('rec')).toBe(STEP_ROW);
  expect(merged.has('fus')).toBe(false);
});
