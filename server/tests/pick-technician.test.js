// Technician pick for a fixed-time visit (owner 2026-10-03: closest route that
// day among the technicians who are free; no territories; no new-hire guard).
const mockState = { active: true, techs: [], absent: new Set(), off: [], clashes: {}, slots: [], last: null, findTimeThrows: false, stops: {}, blocked: new Set() };

jest.mock('../services/tech-out-auto-move', () => ({
  blockedBySchedule: jest.fn(async (techId) => mockState.blocked.has(techId)),
}));
jest.mock('../services/stops-ahead', () => ({ NOT_A_ROUTE_STOP_STATUSES: ['cancelled'] }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: (q) => q,
  absentTechDays: jest.fn(async () => mockState.absent),
}));
jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(async () => mockState.off),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  techScopedConfirmActive: () => mockState.active,
  findConflictingVisits: jest.fn(async ({ technicianId }) => mockState.clashes[technicianId] || []),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => {
    if (mockState.findTimeThrows) throw new Error('route model down');
    return { slots: mockState.slots };
  }),
}));

const { pickTechnicianForVisit, TIE_MINUTES, _internals } = require('../services/scheduling/pick-technician');
const occupancy = require('../services/scheduling/occupancy');
const findTime = require('../services/scheduling/find-time');

// conn('technicians').select(...) → techs; conn('scheduled_services')…first() → last visit.
function makeConn() {
  const conn = jest.fn((table) => {
    const chain = {};
    ['where', 'whereNotNull', 'orderBy', 'whereIn', 'whereNotIn', 'groupBy'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.select = jest.fn(() => (table === 'technicians' ? Promise.resolve(mockState.techs) : chain));
    chain.count = jest.fn(async () => Object.entries(mockState.stops).map(([technician_id, stops]) => ({ technician_id, stops })));
    chain.first = jest.fn(async () => (mockState.last ? { technician_id: mockState.last } : undefined));
    return chain;
  });
  conn.fn = { now: () => 'now()' };
  return conn;
}

const A = { id: 'tech-a', name: 'Tech A' };
const B = { id: 'tech-b', name: 'Tech B' };
const base = { date: '2099-01-05', windowStart: '10:00', windowEnd: '11:00', lat: 27.4, lng: -82.5, serviceType: 'General Pest', customerId: 'cust-1' };
const slot = (tech, detour, start = '10:00') => ({
  date: base.date, start_time: start, technician: { id: tech.id, name: tech.name }, detour_minutes: detour,
});

beforeEach(() => {
  Object.assign(mockState, { active: true, techs: [A, B], absent: new Set(), off: [], clashes: {}, slots: [], last: null, findTimeThrows: false, stops: {}, blocked: new Set() });
  jest.clearAllMocks();
});

describe('pickTechnicianForVisit', () => {
  test('gate off: inactive, no reads — the caller keeps its own default', async () => {
    mockState.active = false;
    const conn = makeConn();
    const pick = await pickTechnicianForVisit({ conn, ...base });
    expect(pick).toMatchObject({ active: false, technician: null });
    expect(conn).not.toHaveBeenCalled();
    expect(occupancy.findConflictingVisits).not.toHaveBeenCalled();
  });

  test('the free technician wins when the other has a stop at that time', async () => {
    mockState.clashes = { 'tech-a': [{ id: 'visit-1' }] };
    mockState.slots = [slot(B, 25)];
    const pick = await pickTechnicianForVisit({ conn: makeConn(), ...base });
    expect(pick.technician).toEqual({ id: 'tech-b', name: 'Tech B' });
  });

  test('both free: the closest route that day wins', async () => {
    mockState.slots = [slot(A, 22), slot(B, 6)];
    const pick = await pickTechnicianForVisit({ conn: makeConn(), ...base });
    expect(pick).toMatchObject({ technician: { id: 'tech-b' }, reason: 'closest_route' });
  });

  test('availability uses the save probe, scoped to each technician', async () => {
    await pickTechnicianForVisit({ conn: makeConn(), ...base, excludeServiceIds: ['row-1'] });
    const calls = occupancy.findConflictingVisits.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.technicianId)).toEqual(['tech-a', 'tech-b']);
    for (const c of calls) {
      expect(c).toMatchObject({ date: base.date, windowStart: '10:00', windowEnd: '11:00', excludeCustomerId: 'cust-1', excludeServiceIds: ['row-1'] });
    }
  });

  test('assigning an existing row: only that row is excluded, the customer\'s other visits still count', async () => {
    await pickTechnicianForVisit({ conn: makeConn(), ...base, excludeServiceIds: ['row-1'], excludeCustomerId: null });
    for (const [arg] of occupancy.findConflictingVisits.mock.calls) {
      expect(arg).toMatchObject({ excludeCustomerId: null, excludeServiceIds: ['row-1'] });
    }
  });

  test('a tie goes to the customer\'s last technician, then the lighter day', async () => {
    mockState.slots = [slot(A, 10), slot(B, 10 + TIE_MINUTES)];
    mockState.stops = { 'tech-a': 2, 'tech-b': 6 };
    mockState.last = 'tech-b';
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-b');
    mockState.last = null;
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-a');
  });

  test('the last technician does not beat a clearly closer route', async () => {
    mockState.slots = [slot(A, 4), slot(B, 4 + TIE_MINUTES + 1)];
    mockState.last = 'tech-b';
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-a');
  });

  test('nobody free: unassigned', async () => {
    mockState.clashes = { 'tech-a': [{ id: 'v1' }], 'tech-b': [{ id: 'v2' }] };
    const pick = await pickTechnicianForVisit({ conn: makeConn(), ...base });
    expect(pick).toMatchObject({ active: true, technician: null, reason: 'none_free' });
    expect(findTime.findAvailableSlots).not.toHaveBeenCalled();
  });

  test('a technician out that day, or with the skill switched off, is not a candidate', async () => {
    mockState.absent = new Set([`tech-a:${base.date}`]);
    mockState.slots = [slot(A, 1), slot(B, 30)];
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-b');
    mockState.absent = new Set();
    mockState.off = [{ technician_id: 'tech-b' }];
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-a');
    mockState.off = [{ technician_id: 'tech-a' }, { technician_id: 'tech-b' }];
    expect(await pickTechnicianForVisit({ conn: makeConn(), ...base })).toMatchObject({ technician: null, reason: 'none_assignable' });
  });

  test('no coordinates or a failed route estimate: availability alone decides', async () => {
    mockState.clashes = { 'tech-a': [{ id: 'v1' }] };
    const noGeo = await pickTechnicianForVisit({ conn: makeConn(), ...base, lat: null, lng: null });
    expect(noGeo).toMatchObject({ technician: { id: 'tech-b' }, reason: 'availability_only' });
    expect(findTime.findAvailableSlots).not.toHaveBeenCalled();
    mockState.findTimeThrows = true;
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-b');
  });

  test('only slots at this exact start count; the estimate spends no Google allowance', async () => {
    mockState.slots = [slot(A, 1, '11:00'), slot(A, 40), slot(B, 12)];
    expect((await pickTechnicianForVisit({ conn: makeConn(), ...base })).technician.id).toBe('tech-b');
    expect(findTime.findAvailableSlots.mock.calls[0][0]).toMatchObject({
      dateFrom: base.date, dateTo: base.date, earliestStartMin: 600, providerTravel: false, includeWeekends: true,
    });
  });

  test('no route estimate, no last technician: the lighter day wins, not the name', async () => {
    mockState.stops = { 'tech-a': 7 };
    const pick = await pickTechnicianForVisit({ conn: makeConn(), ...base, lat: null, lng: null });
    expect(pick).toMatchObject({ technician: { id: 'tech-b' }, reason: 'availability_only' });
  });

  test('a schedule block over the window removes the technician, even with no route estimate', async () => {
    mockState.blocked = new Set(['tech-a']);
    const pick = await pickTechnicianForVisit({ conn: makeConn(), ...base, lat: null, lng: null });
    expect(pick.technician.id).toBe('tech-b');
    expect(require('../services/tech-out-auto-move').blockedBySchedule).toHaveBeenCalledWith('tech-a', base.date, 600, 660, expect.anything());
    mockState.blocked = new Set(['tech-a', 'tech-b']);
    expect(await pickTechnicianForVisit({ conn: makeConn(), ...base })).toMatchObject({ technician: null, reason: 'none_free' });
  });

  test('a measured technician ranks ahead of an unmeasured one', () => {
    const winner = _internals.rankCandidates([
      { id: 'tech-a', name: 'Tech A', detourMinutes: null, stopsThatDay: 0 },
      { id: 'tech-b', name: 'Tech B', detourMinutes: 30, stopsThatDay: 5 },
    ], 'tech-a');
    expect(winner.id).toBe('tech-b');
  });
});
