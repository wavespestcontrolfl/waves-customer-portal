/**
 * find_available_slots under GATE_ROUTE_CHECK_STAFF_LISTS (owner 2026-10-29,
 * "Route Check Everywhere" build 1): a new stop is checked by the dispatcher's
 * arrival-window route check (the prospective target New Appointment uses).
 * Off, or without coordinates: the gap search, as before. Only an admin
 * caller's search may buy Google road times.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => {
  const actual = jest.requireActual('../services/scheduling/find-time');
  return { ...actual, findAvailableSlots: jest.fn(async () => ({ slots: [], rejections_by_date: {} })) };
});

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

const ENV_KEYS = ['GATE_ROUTE_CHECK_STAFF_LISTS', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_PICKER_ROAD_CHECK', 'GATE_SCHEDULING_CAPACITY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
  findAvailableSlots.mockClear();
  db.mockReset().mockImplementation(() => {
    const q = {};
    for (const m of ['where', 'whereILike', 'whereIn', 'whereNotIn', 'whereBetween', 'select', 'orderBy', 'groupBy']) q[m] = () => q;
    q.first = async () => null;
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  });
  db.raw = jest.fn((sql) => sql);
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const input = { lat: 27.4, lng: -82.5, duration_minutes: 45 };
const search = (ctx) => executeScheduleTool('find_available_slots', input, ctx);
const on = () => { process.env.GATE_ROUTE_CHECK_STAFF_LISTS = 'true'; process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true'; process.env.GATE_PICKER_ROAD_CHECK = 'true'; };

test('gate off: the old search, no arrival window, no road options', async () => {
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  await search({ isAdmin: true, technicianId: 'staff-9' });
  const call = findAvailableSlots.mock.calls[0][0];
  expect(call).not.toHaveProperty('arrivalWindow');
  expect(call).not.toHaveProperty('pickerRoadCheck');
  expect(call).not.toHaveProperty('providerTravel');
});

test('gate on without arrival-window routing: the old search', async () => {
  process.env.GATE_ROUTE_CHECK_STAFF_LISTS = 'true';
  await search({ isAdmin: true, technicianId: 'staff-9' });
  expect(findAvailableSlots.mock.calls[0][0]).not.toHaveProperty('arrivalWindow');
});

test('gate on, admin: prospective target and staff Google (spender = the acting user)', async () => {
  on();
  await search({ isAdmin: true, technicianId: 'staff-9' });
  const call = findAvailableSlots.mock.calls[0][0];
  expect(call.arrivalWindow).toEqual({ prospective: { lat: 27.4, lng: -82.5, estimated_duration_minutes: 45 } });
  expect(call).toMatchObject({ pickerRoadCheck: true, roadSpender: 'staff-9', providerTravel: false, includeWeekends: true, includeBlackoutDates: true });
  expect(call.pickerBudget).toBeTruthy();
});

test.each([
  ['a technician', { isAdmin: false, technicianId: 'tech-1' }],
  ['no context', undefined],
])('gate on, %s: route check on the estimate only', async (_name, ctx) => {
  on();
  await search(ctx);
  const call = findAvailableSlots.mock.calls[0][0];
  expect(call.arrivalWindow).toEqual({ prospective: { lat: 27.4, lng: -82.5, estimated_duration_minutes: 45 } });
  expect(call.providerTravel).toBe(false);
  expect(call).not.toHaveProperty('pickerRoadCheck');
  expect(call).not.toHaveProperty('roadSpender');
  expect(call).not.toHaveProperty('pickerBudget');
});

test('gate on: the output keeps the describeSlotSearch shape and lists every searched day', async () => {
  on();
  findAvailableSlots.mockResolvedValueOnce({
    slots: [{ date: '2099-01-05', start_time: '10:00', end_time: '10:45', detour_minutes: 4, score: 4 }],
    evaluated: 3, total_feasible: 1, rejections_by_date: { '2099-01-06': { route_unverified: 2 } },
  });
  const out = await executeScheduleTool('find_available_slots',
    { ...input, date_from: '2099-01-05', date_to: '2099-01-07' }, { isAdmin: true, technicianId: 'staff-9' });
  expect(Object.keys(out)).toEqual(expect.arrayContaining(['slots', 'days']));
  expect(out.slots[0]).toMatchObject({ rank: 1, date: '2099-01-05', day_label: expect.any(String) });
  expect(out.days.map((d) => d.date)).toEqual(['2099-01-05', '2099-01-06', '2099-01-07']);
  expect(out.days[1].no_slot_reason).toContain('route_unverified x2');
});

test('gate on without coordinates the search could use: the old path (no geocode key, error as before)', async () => {
  on();
  const out = await executeScheduleTool('find_available_slots', { duration_minutes: 45 }, { isAdmin: true, technicianId: 'staff-9' });
  expect(out.error).toMatch(/Need a customer_id, address, or lat\/lng/);
  expect(findAvailableSlots).not.toHaveBeenCalled();
});
