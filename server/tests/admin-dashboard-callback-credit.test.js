/**
 * GATE_CALLBACK_SOURCE_TECH (census M9, second technician): the dashboard
 * leaderboard (computeCoreKpis) moves each callback to the technician whose
 * visit it corrects. Jobs and revenue stay with the technician who did the
 * work. Gate off: no credit read, today's counts.
 */
jest.mock('../models/db', () => {
  // The leaderboard query (an awaited service_records chain with leftJoin) gets
  // the rows below; technicians (the credited-name read) gets the names;
  // every other computeCoreKpis query degrades to empty values, as in
  // admin-dashboard-core-kpis-range.test.js.
  const state = { leaderboardRows: [], technicians: [] };
  function makeChain(table) {
    let joined = false;
    const chain = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'first') {
          return () => Promise.resolve(table === 'scheduled_services' ? { total: '10', completed: '5', cancelled: '0' } : {});
        }
        if (prop === 'then') {
          const rows = table === 'service_records' && joined ? state.leaderboardRows
            : (table === 'technicians' ? state.technicians : []);
          return (resolve) => Promise.resolve(rows.map((r) => ({ ...r }))).then(resolve);
        }
        if (prop === 'leftJoin') return () => { joined = true; return chain; };
        return () => chain;
      },
    });
    return chain;
  }
  const db = jest.fn((table) => makeChain(table));
  db.raw = (sql) => sql;
  db.__state = state;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/callback-credit', () => ({ callbackCreditByTechnician: jest.fn() }));

const { computeCoreKpis } = require('../routes/admin-dashboard');
const fakeDb = require('../models/db');
const { callbackCreditByTechnician } = require('../services/callback-credit');

const OWNER = '11111111-0000-4000-8000-000000000001';
const HIRE = '22222222-0000-4000-8000-000000000002';
const GONE = '33333333-0000-4000-8000-000000000003';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_CALLBACK_SOURCE_TECH;
  // Today's counts: the owner did both callbacks, the hire did none.
  fakeDb.__state.leaderboardRows = [
    { tech_id: OWNER, tech_name: 'Synthetic Owner', jobs: '10', revenue: '1000', rpmh: '50', margin: '40', callbacks: '2' },
    { tech_id: HIRE, tech_name: 'Synthetic Hire', jobs: '8', revenue: '800', rpmh: '45', margin: '38', callbacks: '0' },
  ];
  fakeDb.__state.technicians = [{ id: OWNER, name: 'Synthetic Owner' }, { id: HIRE, name: 'Synthetic Hire' }];
});

afterAll(() => { delete process.env.GATE_CALLBACK_SOURCE_TECH; });

const row = (kpis, techId) => kpis.leaderboard.find((r) => r.techId === techId);

test('gate off: the callbacks stay with the technician who did them, and no credit read runs', async () => {
  const kpis = await computeCoreKpis('mtd');

  expect(row(kpis, OWNER)).toMatchObject({ jobs: 10, callbacks: 2, callbackRate: 20 });
  expect(row(kpis, HIRE)).toMatchObject({ jobs: 8, callbacks: 0, callbackRate: 0 });
  expect(callbackCreditByTechnician).not.toHaveBeenCalled();
});

test('gate on: the callbacks move to the technician whose visits they correct; jobs and revenue do not move', async () => {
  process.env.GATE_CALLBACK_SOURCE_TECH = 'true';
  callbackCreditByTechnician.mockResolvedValue(new Map([[HIRE, 2]]));

  const kpis = await computeCoreKpis('mtd');

  expect(row(kpis, OWNER)).toMatchObject({ jobs: 10, revenue: 1000, callbacks: 0, callbackRate: 0 });
  expect(row(kpis, HIRE)).toMatchObject({ jobs: 8, revenue: 800, callbacks: 2, callbackRate: 25 });
  expect(callbackCreditByTechnician).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ start: expect.any(String), endDate: expect.any(String) }));
});

test('gate on: a credited technician with no job in the window gets a row; an id with no technicians row joins Unassigned', async () => {
  process.env.GATE_CALLBACK_SOURCE_TECH = 'true';
  fakeDb.__state.leaderboardRows = [
    { tech_id: OWNER, tech_name: 'Synthetic Owner', jobs: '10', revenue: '1000', rpmh: '50', margin: '40', callbacks: '3' },
  ];
  callbackCreditByTechnician.mockResolvedValue(new Map([[HIRE, 1], [GONE, 1], [null, 1]]));

  const kpis = await computeCoreKpis('mtd');

  expect(row(kpis, OWNER)).toMatchObject({ callbacks: 0 });
  expect(row(kpis, HIRE)).toMatchObject({ name: 'Synthetic Hire', unassigned: false, jobs: 0, revenue: 0, callbacks: 1, callbackRate: 0 });
  const unassigned = kpis.leaderboard.filter((r) => r.techId == null);
  expect(unassigned).toHaveLength(1);
  expect(unassigned[0]).toMatchObject({ name: 'Unassigned', unassigned: true, callbacks: 2 });
  expect(row(kpis, GONE)).toBeUndefined();
});
