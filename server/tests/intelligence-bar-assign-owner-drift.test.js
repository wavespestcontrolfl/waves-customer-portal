/**
 * assign_technician: a stop re-pointed to another customer between the card's preview and
 * the commit is drift (Codex #6369 r16). Covers both executor checks: the pre-lock compare
 * against `_verified_stops` and the final re-read of the locked rows.
 * Harness copied from ib-assign-swap-terminal-status-guard.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/stamped-address', () => ({ stampedDivergesSql: () => 'FALSE', stampedLine2Sql: () => 'NULL' }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/technician-eligibility', () => ({
  assertAssignableTechnician: jest.fn(async (id) => ({ id, name: 'Luis' })),
  applyAssignable: (q) => q,
}));
jest.mock('../services/visit-groups', () => ({
  handleChildStopChanged: jest.fn().mockResolvedValue(undefined),
  handleChildTerminal: jest.fn().mockResolvedValue(undefined),
  maybeGroupRow: jest.fn().mockResolvedValue(undefined),
  dateOnly: (v) => String(v).slice(0, 10),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: jest.fn().mockReturnValue(null),
  notifyVisitCancelled: jest.fn(),
  notifyVisitRescheduled: jest.fn(),
}));

const db = require('../models/db');

const LUIS = { id: 'tech-luis', name: 'Luis' };
const ADAM = { id: 'tech-adam', name: 'Adam' };
const OPEN_ROW = {
  id: 'svc-1', customer_id: 'cust-a', first_name: 'Pat', last_name: 'Example', service_type: 'Quarterly Pest',
  scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00',
  current_tech_id: ADAM.id, visit_id: null, scheduled_date_str: '2026-09-21', current_tech_name: ADAM.name, status: 'scheduled',
};
const approved = (customer_id) => [{ id: 'svc-1', current_tech: ADAM.name, scheduled_date: '2026-09-21', customer_id }];

function chain(overrides = {}) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'orWhereNotIn', 'whereRaw', 'whereILike', 'leftJoin', 'forUpdate', 'modify', 'forShare']) {
    b[m] = jest.fn(() => b);
  }
  b.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(b, b); return b; });
  Object.assign(b, {
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue([{ count: '0' }]),
    update: jest.fn(() => b),
    returning: jest.fn().mockResolvedValue([]),
    ...overrides,
  });
  return b;
}

let selectedColumns;
function setup(liveRow) {
  const techChain = chain({ first: jest.fn().mockResolvedValue(LUIS) });
  const svcChain = chain({ select: jest.fn().mockResolvedValue([OPEN_ROW]) });
  db.mockImplementation((table) => (table === 'technicians' ? techChain : svcChain));
  const trxServices = chain({
    select: jest.fn((...columns) => { selectedColumns = columns; return Promise.resolve([liveRow]); }),
    returning: jest.fn().mockResolvedValue([{ id: 'svc-1', scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00' }]),
  });
  const trx = jest.fn((table) => (table === 'scheduled_services' ? trxServices : chain()));
  trx.raw = jest.fn((sql) => sql);
  trx.fn = { now: () => new Date() };
  db.transaction = jest.fn(async (fn) => fn(trx));
  return trxServices;
}

const run = (verifiedStops) => {
  const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
  return executeScheduleTool('assign_technician',
    { service_ids: ['svc-1'], technician_name: 'Luis', confirmed: true, _verified_stops: verifiedStops }, { confirmed: true });
};

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => new Date() };
  selectedColumns = null;
});

const liveRow = (customer_id) => ({ id: 'svc-1', status: 'scheduled', technician_id: ADAM.id, visit_id: null, customer_id, scheduled_date_str: '2026-09-21' });

describe('assign_technician owner drift', () => {
  test('pre-lock compare: a customer_id that changed since the approved preview refuses before any transaction', async () => {
    setup(liveRow('cust-a'));
    const result = await run(approved('cust-b'));
    expect(result.preview_changed).toBe(true);
    expect(result.error).toMatch(/changed after the card was shown/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('locked re-read: a customer_id that changed under the lock refuses and writes nothing', async () => {
    const trxServices = setup(liveRow('cust-b'));
    const result = await run(approved('cust-a'));
    expect(selectedColumns).toContain('customer_id');
    expect(result.preview_changed).toBe(true);
    expect(trxServices.update).not.toHaveBeenCalled();
  });

  test('an unchanged customer_id passes both checks; a snapshot without customer_id (gate off) is not compared', async () => {
    const same = setup(liveRow('cust-a'));
    const ok = await run(approved('cust-a'));
    expect(ok.preview_changed).toBeUndefined();
    expect(same.update).toHaveBeenCalled();
    const off = setup(liveRow('cust-z'));
    const offResult = await run([{ id: 'svc-1', current_tech: ADAM.name, scheduled_date: '2026-09-21' }]);
    expect(offResult.preview_changed).toBeUndefined();
    expect(off.update).toHaveBeenCalled();
  });
});
