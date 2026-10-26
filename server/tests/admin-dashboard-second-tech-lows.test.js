/**
 * GATE_SECOND_TECH_LOWS (census L1): computeCoreKpis tech utilization.
 *
 * Off: available hours = active technicians rows x 8 x every day (today's
 * number). On: only assignable field staff (active and field-dispatchable)
 * count, and each counts only the days of the labor-hours window (start
 * through the end date, each date once) that are in their work_days (null =
 * every day), at 8 hours a work day. A failed read keeps the fail-loud
 * behavior (null utilization, logged).
 */
jest.mock('../models/db', () => {
  const mockState = { technicians: [], failTechnicians: false };

  function techniciansChain() {
    let rows = mockState.technicians;
    const chain = {
      where: (a, b) => {
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else {
          const key = String(a).replace('technicians.', '');
          rows = rows.filter((r) => r[key] === b);
        }
        return chain;
      },
      count: () => chain,
      first: async () => { if (mockState.failTechnicians) throw new Error('boom'); return { c: String(rows.length) }; },
      select: () => chain,
      then: (resolve, reject) => (mockState.failTechnicians
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(rows)).then(resolve, reject),
    };
    return chain;
  }

  function makeChain(table) {
    const firstRowByTable = {
      scheduled_services: { total: '10', completed: '5', cancelled: '0' },
      service_records: {
        total: '10', completed: '2', callbacks: '1',
        rev_total: '1000', hours_total: '20', avg_rev: '100', avg_rpmh: '50',
        avg_margin: '40', weighted_margin: '42', jobs: '10',
      },
    };
    const chain = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'first') return () => Promise.resolve(firstRowByTable[table] || {});
        if (prop === 'then') return (resolve) => Promise.resolve([]).then(resolve);
        return () => chain;
      },
    });
    return chain;
  }

  const db = jest.fn((table) => (table === 'technicians' ? techniciansChain() : makeChain(table)));
  db.raw = (sql) => sql;
  db.__mockState = mockState;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { computeCoreKpis } = require('../routes/admin-dashboard');
const fakeDb = require('../models/db');
const logger = require('../services/logger');

// Wed 2026-10-28 12:00 ET. With range.from Thu 2026-10-22 the old count
// rounds the period to 8 days; the labor-hours window is 7 dates (Thu Oct 22
// .. Wed Oct 28): Thu, Fri, Sat, Sun, Mon, Tue, Wed.
const NOW = new Date('2026-10-28T16:00:00Z');
const RANGE = { from: '2026-10-22' };
const PEOPLE = [
  { id: 't1', name: 'Tech One', active: true, employment_status: 'active', field_dispatchable: true, work_days: [1, 2, 3, 4] },
  { id: 't2', name: 'Tech Two', active: true, employment_status: 'active', field_dispatchable: true, work_days: null },
  { id: 't3', name: 'Tech Three', active: true, employment_status: 'active', field_dispatchable: true, work_days: [0, 6] },
  { id: 'o1', name: 'Office Only', active: true, employment_status: 'active', field_dispatchable: false, work_days: null },
  { id: 'x1', name: 'Former Tech', active: false, employment_status: 'inactive', field_dispatchable: true, work_days: null },
];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] }).setSystemTime(NOW);
  fakeDb.__mockState.technicians = PEOPLE;
  fakeDb.__mockState.failTechnicians = false;
  logger.error.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_SECOND_TECH_LOWS;
});

describe('computeCoreKpis tech utilization', () => {
  it('gate off: counts every active row on every day (today\'s number)', async () => {
    // 4 rows with active = true x 8 hours x 8 days = 256 hours; 20 / 256 = 8%.
    const kpis = await computeCoreKpis('last_7', RANGE);
    expect(kpis.financial.utilization).toBe(8);
  });

  it('gate on: assignable staff only, on their work days only', async () => {
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    // Tech One Mon-Thu: Thu Oct 22, Mon Oct 26, Tue Oct 27, Wed Oct 28 = 4 days.
    // Tech Two every day = 7. Tech Three Sat/Sun = 2. Office and inactive rows = 0.
    // 13 work days x 8 hours = 104; 20 / 104 = 19%.
    const kpis = await computeCoreKpis('last_7', RANGE);
    expect(kpis.financial.utilization).toBe(19);
  });

  it('gate on, no work_days list anywhere: only the office and inactive rows drop out', async () => {
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    fakeDb.__mockState.technicians = PEOPLE.map((p) => ({ ...p, work_days: null }));
    // 3 assignable x 7 days x 8 hours = 168; 20 / 168 = 12%.
    const kpis = await computeCoreKpis('last_7', RANGE);
    expect(kpis.financial.utilization).toBe(12);
  });

  it('gate on, a window that ends before today (range.to): only its own dates count', async () => {
    // Mon Oct 19 .. Sun Oct 25, the window the labor hours use. Tech One Mon-Thu = 4,
    // Tech Two = 7, Tech Three Sat/Sun = 2: 13 x 8 = 104; 20 / 104 = 19%. Off, the old
    // count runs to today: 4 rows x 8 hours x 11 days = 352; 20 / 352 = 6%.
    const window = { from: '2026-10-19', to: '2026-10-25' };
    expect((await computeCoreKpis('last_7', window)).financial.utilization).toBe(6);
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    expect((await computeCoreKpis('last_7', window)).financial.utilization).toBe(19);
  });

  it('gate on, no assignable technician: utilization is null, not a divide by zero', async () => {
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    fakeDb.__mockState.technicians = PEOPLE.filter((p) => p.id === 'o1' || p.id === 'x1');
    const kpis = await computeCoreKpis('last_7', RANGE);
    expect(kpis.financial.utilization).toBeNull();
  });

  it('gate on, a failed read stays fail-loud: null utilization and a logged error', async () => {
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    fakeDb.__mockState.failTechnicians = true;
    const kpis = await computeCoreKpis('last_7', RANGE);
    expect(kpis.financial.utilization).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('active techs count failed'));
  });
});
