/**
 * Audit repro r2-ib-write-executors-parity-2 (ADMIN-BUG-R56), expectations
 * FLIPPED to the fixed behaviour per the brief's fix sketch: IB
 * assign_technician used to rewrite technician_id on a COMPLETED row (no
 * status predicate on the read, the card, or the UPDATE), and
 * swap_tech_assignments used to swap no_show/skipped rows (its exclusion
 * list was ['cancelled','completed','rescheduled'] only, omitting
 * 'skipped'/'no_show'). Contrast: assignDispatchJob (the REST reassign path)
 * already refuses every TERMINAL_STATUSES row with 409 — assign/swap now
 * apply the same TERMINAL_APPOINTMENT_STATUSES fence.
 * Harness copied from r2-ib-write-executors-parity-1 / tech-visit-notifications-hooks.
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
const mockNotify = jest.fn().mockReturnValue(null);
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: (...a) => mockNotify(...a),
  notifyVisitCancelled: jest.fn(),
  notifyVisitRescheduled: jest.fn(),
}));

const db = require('../models/db');

const LUIS = { id: 'tech-luis', name: 'Luis' };
const ADAM = { id: 'tech-adam', name: 'Adam' };

function chain(overrides = {}) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'whereILike', 'leftJoin', 'forUpdate', 'modify', 'forShare']) {
    b[m] = jest.fn(() => b);
  }
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

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => new Date() };
});

describe('assign_technician on a completed visit — terminal rows are refused', () => {
  // The row as the executor's pre-lock read returns it, now WITH status
  // selected (schedule-tools.js:781-782).
  const COMPLETED_ROW = {
    id: 'svc-1', first_name: 'Jane', last_name: 'Doe', service_type: 'Quarterly Pest',
    scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00',
    current_tech_id: ADAM.id, visit_id: null, scheduled_date_str: '2026-09-21',
    current_tech_name: ADAM.name,
    status: 'completed', // what the DB row actually holds
  };

  let trxServices;
  beforeEach(() => {
    const techChain = chain({ first: jest.fn().mockResolvedValue(LUIS) });
    const svcChain = chain({ select: jest.fn().mockResolvedValue([COMPLETED_ROW]) });
    db.mockImplementation((table) => (table === 'technicians' ? techChain : svcChain));

    trxServices = chain({
      count: jest.fn().mockResolvedValue([{ count: '0' }]),
      returning: jest.fn().mockResolvedValue([{ id: 'svc-1', scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00' }]),
    });
    const trx = jest.fn((table) => (table === 'scheduled_services' ? trxServices : chain()));
    trx.raw = jest.fn((sql) => sql);
    trx.fn = { now: () => new Date() };
    db.transaction = jest.fn(async (fn) => fn(trx));
  });

  test('preview refuses outright when every matching stop is terminal', async () => {
    const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
    const preview = await executeScheduleTool('assign_technician', { service_ids: ['svc-1'], technician_name: 'Luis' }, {});
    expect(preview.proposal).toBeUndefined();
    expect(preview.error).toMatch(/terminal status/);
    expect(preview.error).toMatch(/completed.*cancelled.*skipped.*no_show/);
  });

  test('confirmed run does NOT reassign the completed row — no write, no tech notice', async () => {
    const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
    const result = await executeScheduleTool('assign_technician',
      { service_ids: ['svc-1'], technician_name: 'Luis', confirmed: true }, { confirmed: true });

    expect(result.error).toMatch(/terminal status/);
    expect(trxServices.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    // No tech notice fires for a visit that already happened.
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('assign_technician on a mixed set — terminal rows are dropped and disclosed, live rows still assign', () => {
  const COMPLETED_ROW = {
    id: 'svc-done', first_name: 'Jane', last_name: 'Doe', service_type: 'Quarterly Pest',
    scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00',
    current_tech_id: ADAM.id, visit_id: null, scheduled_date_str: '2026-09-21',
    current_tech_name: ADAM.name, status: 'completed',
  };
  const OPEN_ROW = {
    id: 'svc-open', first_name: 'Bob', last_name: 'Roe', service_type: 'Lawn',
    scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00',
    current_tech_id: ADAM.id, visit_id: null, scheduled_date_str: '2026-09-21',
    current_tech_name: ADAM.name, status: 'confirmed',
  };

  let trxServices;
  beforeEach(() => {
    const techChain = chain({ first: jest.fn().mockResolvedValue(LUIS) });
    const svcChain = chain({ select: jest.fn().mockResolvedValue([COMPLETED_ROW, OPEN_ROW]) });
    db.mockImplementation((table) => (table === 'technicians' ? techChain : svcChain));

    trxServices = chain({
      count: jest.fn().mockResolvedValue([{ count: '0' }]),
      returning: jest.fn().mockResolvedValue([{ id: 'svc-open', scheduled_date: '2026-09-21', window_start: '09:00', window_end: '11:00' }]),
    });
    const trx = jest.fn((table) => (table === 'scheduled_services' ? trxServices : chain()));
    trx.raw = jest.fn((sql) => sql);
    trx.fn = { now: () => new Date() };
    db.transaction = jest.fn(async (fn) => fn(trx));
  });

  test('preview discloses the completed stop as skipped_terminal and only offers the open one', async () => {
    const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
    const preview = await executeScheduleTool('assign_technician', { service_ids: ['svc-done', 'svc-open'], technician_name: 'Luis' }, {});
    expect(preview.proposal).toBe(true);
    expect(preview.stops.map((s) => s.id)).toEqual(['svc-open']);
    expect(preview.skipped_terminal).toEqual([{ id: 'svc-done', status: 'completed' }]);
  });

  test('confirmed run reassigns only the open stop, with a belt-and-braces status fence on the UPDATE', async () => {
    const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
    const result = await executeScheduleTool('assign_technician',
      { service_ids: ['svc-done', 'svc-open'], technician_name: 'Luis', confirmed: true }, { confirmed: true });

    expect(trxServices.whereIn).toHaveBeenCalledWith('id', ['svc-open']);
    expect(trxServices.whereNotIn).toHaveBeenCalledWith('status', expect.arrayContaining(['completed', 'cancelled', 'skipped', 'no_show']));
    expect(result).toMatchObject({ success: true, assigned_count: 1 });
    expect(result.skipped_terminal).toEqual([{ id: 'svc-done', status: 'completed' }]);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ visitId: 'svc-open', toTechId: LUIS.id }));
    expect(mockNotify).not.toHaveBeenCalledWith(expect.objectContaining({ visitId: 'svc-done' }));
  });
});

describe('swap_tech_assignments with a no_show row — terminal rows never swap', () => {
  // Fixture rows; the mock applies the executor's own whereNotIn list so the
  // test proves what the predicate lets through, not what the mock chooses.
  const ROWS = [
    { id: 'a-noshow', scheduled_date: '2026-09-21', technician_id: ADAM.id, status: 'no_show', service_type: 'Quarterly', time_window: null, visit_id: null },
    { id: 'a-skipped', scheduled_date: '2026-09-21', technician_id: ADAM.id, status: 'skipped', service_type: 'Quarterly', time_window: null, visit_id: null },
    { id: 'a-done', scheduled_date: '2026-09-21', technician_id: ADAM.id, status: 'completed', service_type: 'Quarterly', time_window: null, visit_id: null },
    { id: 'b-open', scheduled_date: '2026-09-21', technician_id: LUIS.id, status: 'confirmed', service_type: 'Lawn', time_window: null, visit_id: null },
  ];

  function servicesChain() {
    let techId = null;
    let excluded = [];
    const filtered = () => ROWS.filter((r) => r.technician_id === techId && !excluded.includes(r.status));
    const b = chain();
    b.where = jest.fn((arg) => { if (arg && typeof arg === 'object' && arg.technician_id) techId = arg.technician_id; return b; });
    b.whereNotIn = jest.fn((col, list) => { excluded = list; const p = Promise.resolve(filtered()); Object.assign(p, b); return p; });
    b.select = jest.fn(async () => filtered().map((r) => ({ id: r.id, visit_id: r.visit_id })));
    return b;
  }

  test('preview no longer exposes the no_show/skipped rows as swappable — only the open stop moves', async () => {
    const techChain = chain({ first: jest.fn(async () => undefined) });
    techChain.whereILike = jest.fn((col, pat) => { techChain.first = jest.fn(async () => (/adam/i.test(pat) ? ADAM : LUIS)); return techChain; });
    db.mockImplementation((table) => (table === 'technicians' ? techChain : servicesChain()));

    const updates = [];
    const trxServices = () => {
      const b = servicesChain();
      const orig = b.whereIn;
      let ids = null;
      b.whereIn = jest.fn((col, list) => { ids = list; return orig(col, list); });
      b.update = jest.fn((patch) => { updates.push({ ids, patch }); return b; });
      b.returning = jest.fn(async () => (ids || []).map((id) => ({ id, scheduled_date: '2026-09-21', window_start: null, window_end: null })));
      return b;
    };
    const trx = jest.fn((table) => (table === 'scheduled_services' ? trxServices() : chain()));
    trx.raw = jest.fn((sql) => sql);
    trx.fn = { now: () => new Date() };
    db.transaction = jest.fn(async (fn) => fn(trx));

    const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
    const preview = await executeScheduleTool('swap_tech_assignments', { date: '2026-09-21', tech_a_name: 'Adam', tech_b_name: 'Luis' }, {});
    expect(preview.proposal).toBe(true);
    const aIds = preview.stops[ADAM.name].map((s) => s.id).sort();
    // FIXED: no_show / skipped (and completed) are all excluded from Adam's
    // swappable set — Adam has nothing left to swap.
    expect(aIds).toEqual([]);
    const bIds = preview.stops[LUIS.name].map((s) => s.id).sort();
    expect(bIds).toEqual(['b-open']);

    const result = await executeScheduleTool('swap_tech_assignments',
      { date: '2026-09-21', tech_a_name: 'Adam', tech_b_name: 'Luis', confirmed: true }, { confirmed: true });
    expect(result.error).toBeUndefined();
    // Only b-open (Luis's live stop) moves — to Adam. Adam's terminal rows
    // are never touched.
    const toAdam = updates.find((u) => u.patch.technician_id === ADAM.id);
    expect(toAdam.ids.sort()).toEqual(['b-open']);
    expect(updates.some((u) => u.patch.technician_id === null)).toBe(false);
    expect(updates.some((u) => (u.ids || []).includes('a-noshow') || (u.ids || []).includes('a-skipped'))).toBe(false);
  });
});

describe('contrast: the REST reassign path refuses the same row', () => {
  test('assignDispatchJob throws 409 for completed / no_show / skipped', async () => {
    const { assignDispatchJob } = require('../services/dispatch-assignment');
    for (const status of ['completed', 'no_show', 'skipped']) {
      const jobChain = chain({ first: jest.fn().mockResolvedValue({ id: 'svc-1', status, technician_id: ADAM.id, scheduled_date: '2026-09-21' }) });
      db.mockImplementation(() => jobChain);
      await expect(assignDispatchJob({ jobId: 'svc-1', technicianId: LUIS.id }))
        .rejects.toMatchObject({ status: 409, message: `Cannot reassign a ${status} job` });
    }
  });
});
