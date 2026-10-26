/**
 * GATE_SECOND_TECH_LOWS (census L3): the four Intelligence Bar schedule-tool
 * sites that picked a technician by name text with an unordered first() match
 * (optimize_tech_route, assign_technician, swap_tech_assignments x2,
 * find_available_slots).
 *
 * Gate on: resolveTechnicianByName - assignable technicians only, and a name
 * that fits two of them is an error that lists them, with nothing read or
 * written afterwards. Gate off: today's first() match, byte for byte.
 * The technicians table is an in-memory fake that honors whereILike and the
 * employment_status / field_dispatchable filters applyAssignable adds.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/stamped-address', () => ({ stampedDivergesSql: () => 'FALSE', stampedLine2Sql: () => 'NULL' }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn(async () => ({ slots: [] })) }));
jest.mock('../services/route-optimizer', () => ({}));
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(async () => []),
  guardedCoordSelects: jest.fn(() => []),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

const ROSTER = [
  { id: 't-office', name: 'Casey Office', employment_status: 'active', field_dispatchable: false },
  { id: 't-river', name: 'Riley River', employment_status: 'active', field_dispatchable: true },
  { id: 't-rock', name: 'Riley Rock', employment_status: 'active', field_dispatchable: true },
  { id: 't-sole', name: 'Sam Solo', employment_status: 'active', field_dispatchable: true },
  { id: 't-gone', name: 'Pat Past', employment_status: 'inactive', field_dispatchable: true },
];

let scheduledWhereCalls;
let scheduledReads;

function techniciansQuery() {
  let rows = ROSTER;
  const q = {
    whereILike: (_col, pattern) => {
      const needle = String(pattern).replace(/%/g, '').toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
      return q;
    },
    where: (col, val) => {
      const key = String(col).replace('technicians.', '');
      rows = rows.filter((r) => r[key] === val);
      return q;
    },
    limit: async (n) => rows.slice(0, n),
    first: async () => rows[0],
  };
  return q;
}

function scheduledQuery() {
  const q = {};
  q.whereIn = () => { scheduledReads.push('read'); return q; };
  for (const m of ['whereNotIn', 'whereNull', 'whereRaw', 'leftJoin', 'forUpdate', 'select', 'orderBy']) q[m] = () => q;
  q.where = (...args) => { scheduledWhereCalls.push(args); return q; };
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

beforeEach(() => {
  scheduledWhereCalls = [];
  scheduledReads = [];
  findAvailableSlots.mockClear();
  dayStopsQuery.mockClear();
  db.mockReset().mockImplementation((table) => (table === 'technicians' ? techniciansQuery() : scheduledQuery()));
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => new Date() };
  db.transaction = jest.fn(async () => { throw new Error('nothing may be written'); });
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
});

afterEach(() => { delete process.env.GATE_SECOND_TECH_LOWS; });

const AMBIGUOUS = /Multiple technicians match that name/;

const SITES = {
  optimize_tech_route: {
    call: (name) => executeScheduleTool('optimize_tech_route', { date: '2026-11-02', technician_name: name }),
    bound: () => dayStopsQuery.mock.calls.map(([, opts]) => opts.technicianId),
    notFound: (name) => `Technician "${name}" not found`,
  },
  assign_technician: {
    call: (name) => executeScheduleTool('assign_technician', { service_ids: ['svc-1'], technician_name: name }),
    // After the technician binds, the executor reads the visits (none here).
    bound: () => scheduledReads,
    boundOutcome: { error: 'No services found for the given IDs' },
    notFound: (name) => `Technician "${name}" not found`,
  },
  swap_tech_assignments: {
    call: (nameA, nameB = 'Sam') => executeScheduleTool('swap_tech_assignments', { date: '2026-11-02', tech_a_name: nameA, tech_b_name: nameB }),
    bound: () => scheduledWhereCalls.map(([cond]) => cond.technician_id),
    notFound: (name) => `Tech "${name}" not found`,
  },
  find_available_slots: {
    call: (name) => executeScheduleTool('find_available_slots', { lat: 27.5, lng: -82.5, duration_minutes: 60, technician_name: name }),
    bound: () => findAvailableSlots.mock.calls.map(([opts]) => opts.technicianId),
    notFound: (name) => `Technician "${name}" not found`,
  },
};

describe.each(Object.entries(SITES))('%s with GATE_SECOND_TECH_LOWS on', (_tool, site) => {
  beforeEach(() => { process.env.GATE_SECOND_TECH_LOWS = 'true'; });

  it('two assignable technicians match the text: an ambiguity error with both candidates, nothing bound or written', async () => {
    const result = await site.call('Riley');
    expect(result.error).toMatch(AMBIGUOUS);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((c) => c.id).sort()).toEqual(['t-river', 't-rock']);
    expect(site.bound()).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('an office-only row that matches is not bound', async () => {
    const result = await site.call('Casey');
    expect(result.error).toBe(site.notFound('Casey'));
    expect(site.bound()).toEqual([]);
  });

  it('an inactive technician that matches is not bound', async () => {
    const result = await site.call('Pat');
    expect(result.error).toBe(site.notFound('Pat'));
    expect(site.bound()).toEqual([]);
  });

  it('a unique match is bound', async () => {
    const result = await site.call('Solo');
    expect(result.ambiguous).toBeUndefined();
    if (site.boundOutcome) expect(result).toEqual(site.boundOutcome);
    expect(site.bound()).not.toEqual([]);
    if (site.bound()[0] !== 'read') expect(site.bound()).toContain('t-sole');
  });
});

describe.each(Object.entries(SITES))('%s with GATE_SECOND_TECH_LOWS off (today)', (_tool, site) => {
  it('the unordered first() match still binds the first matching row, even an office row', async () => {
    const result = await site.call('Riley');
    expect(result.ambiguous).toBeUndefined();
    expect(site.bound()).not.toEqual([]);
    if (site.bound()[0] !== 'read') expect(site.bound()).toContain('t-river');
    const office = await site.call('Casey');
    expect(office.error).not.toBe(site.notFound('Casey'));
  });
});

describe('swap_tech_assignments, second name', () => {
  it('gate on: an ambiguous second name refuses before any visit is read', async () => {
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    const result = await SITES.swap_tech_assignments.call('Sam', 'Riley');
    expect(result.error).toMatch(AMBIGUOUS);
    expect(scheduledWhereCalls).toEqual([]);
  });

  it('gate on: an office-only second name is not found', async () => {
    process.env.GATE_SECOND_TECH_LOWS = 'true';
    const result = await SITES.swap_tech_assignments.call('Sam', 'Casey');
    expect(result.error).toBe('Tech "Casey" not found');
  });
});
