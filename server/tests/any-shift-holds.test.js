/**
 * technician-eligibility.js anyShiftHolds / loadAnyShiftHolds (GATE_TECH_SHIFT_HOURS, D4): a visit booked with no
 * technician on it is one some technician can work. Synthetic ids.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { anyShiftHolds, loadAnyShiftHolds } = require('../services/technician-eligibility');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const DAY = '2027-03-02';
const savedGate = process.env.GATE_TECH_SHIFT_HOURS;
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_TECH_SHIFT_HOURS; else process.env.GATE_TECH_SHIFT_HOURS = savedGate;
});

describe('anyShiftHolds', () => {
  const shifts = (byTech) => (id, date) => (date === DAY ? byTech[id] || null : null);

  test('one technician: the visit must start at or after the shift start and end by the shift end', () => {
    const shiftOf = shifts({ [A]: { startMin: 480, endMin: 900 } });
    expect(anyShiftHolds([A], shiftOf, DAY, 480, 540)).toBe(true);
    expect(anyShiftHolds([A], shiftOf, DAY, 840, 900)).toBe(true);
    expect(anyShiftHolds([A], shiftOf, DAY, 479, 539)).toBe(false);
    expect(anyShiftHolds([A], shiftOf, DAY, 841, 901)).toBe(false);
    expect(anyShiftHolds([A], shiftOf, DAY, 900, 960)).toBe(false);
  });

  test('two technicians: one shift that holds the visit is enough, and each shift is judged whole', () => {
    const shiftOf = shifts({ [A]: { startMin: 480, endMin: 720 }, [B]: { startMin: 720, endMin: 1020 } });
    expect(anyShiftHolds([A, B], shiftOf, DAY, 600, 660)).toBe(true);
    expect(anyShiftHolds([A, B], shiftOf, DAY, 900, 960)).toBe(true);
    // 11:30 to 12:30 is inside neither shift.
    expect(anyShiftHolds([A, B], shiftOf, DAY, 690, 750)).toBe(false);
    expect(anyShiftHolds([A], shiftOf, DAY, 900, 960)).toBe(false);
  });

  test('a technician with no set hours that day can work any hour; no technician at all: nothing to judge by', () => {
    const shiftOf = shifts({ [A]: { startMin: 480, endMin: 720 } });
    expect(anyShiftHolds([A, B], shiftOf, DAY, 900, 960)).toBe(true);
    expect(anyShiftHolds([A], shiftOf, '2027-03-03', 900, 960)).toBe(true);
    expect(anyShiftHolds([], shiftOf, DAY, 900, 960)).toBe(true);
  });
});

describe('loadAnyShiftHolds', () => {
  /** A fake knex: `technicians` answers the assignable list, then the shift rows; `time_entries` has no clock-in. */
  function fakeConn(techRows, { fail = false } = {}) {
    const calls = [];
    const conn = (table) => {
      const state = { table, wheres: [] };
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve, reject) => {
              if (fail) return Promise.reject(new Error('synthetic read failure')).then(resolve, reject);
              if (table !== 'technicians') return Promise.resolve([]).then(resolve, reject);
              const shiftRead = state.wheres.some(([method, column]) => method === 'whereNotNull' && column === 'shift_start');
              const rows = shiftRead ? techRows.filter((r) => r.shift_start && r.shift_end) : techRows.filter((r) => r.assignable !== false);
              return Promise.resolve(rows).then(resolve, reject);
            };
          }
          return (...args) => { state.wheres.push([String(prop), ...args]); calls.push([table, String(prop), ...args]); return chain; };
        },
      });
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    return { conn, calls };
  }
  const NOW = new Date('2027-03-01T15:00:00Z');

  test('gate off: nothing is read and every hour holds', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const conn = jest.fn(() => { throw new Error('no read with the gate off'); });
    const holds = await loadAnyShiftHolds(conn);
    expect(holds(DAY, 0, 1440)).toBe(true);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: only technicians a visit can be given to count (active and field-dispatchable)', async () => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    const { conn, calls } = fakeConn([{ id: A, shift_start: '08:00:00', shift_end: '15:00:00' }]);
    const holds = await loadAnyShiftHolds(conn, { now: NOW });
    expect(calls).toContainEqual(['technicians', 'where', 'technicians.employment_status', 'active']);
    expect(calls).toContainEqual(['technicians', 'where', 'technicians.field_dispatchable', true]);
    expect(calls).toContainEqual(['technicians', 'whereIn', 'id', [A]]);
    expect(holds(DAY, 840, 900)).toBe(true);
    expect(holds(DAY, 900, 960)).toBe(false);
    expect(holds(DAY, 420, 480)).toBe(false);
  });

  test('gate on, no technician a visit can be given to: every hour holds', async () => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    const { conn } = fakeConn([]);
    expect((await loadAnyShiftHolds(conn, { now: NOW }))(DAY, 900, 960)).toBe(true);
  });

  test('gate on, a failed read throws', async () => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    const { conn } = fakeConn([], { fail: true });
    await expect(loadAnyShiftHolds(conn, { now: NOW })).rejects.toThrow('synthetic read failure');
  });
});
