/**
 * GATE_ROUTE_CHECK_ASSIGN_SAVES (owner 2026-10-29, "ok go", Route Check
 * Everywhere follow-up item 1): the office board's assign numbers the visit on
 * its new technician's day, in the assign's own transaction. Pins: gate off
 * touches nothing; gate on = one placement on the assign transaction with
 * source 'dispatch_assign', after the tech-day fences; only a caller that
 * passes place:true places (the Edit modal, visit-group moves and every other
 * service never do); an unassign is not placed; a throwing placement never
 * fails the assign.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stamped-address', () => ({ stampedDivergesSql: () => 'FALSE', stampedLine2Sql: () => 'NULL' }));
jest.mock('../services/technician-eligibility', () => ({
  assertAssignableTechnician: jest.fn(async (id) => ({ id, name: 'Tech Two' })),
  offDayWarningFor: jest.fn(async () => null),
  capabilityOffWarningsFor: jest.fn(async () => []),
}));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => []) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyAssignmentChange: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const logger = require('../services/logger');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const arrivalRoute = require('../services/scheduling/arrival-route');
const { assignDispatchJob } = require('../services/dispatch-assignment');

const JOB = { id: 'job-1', status: 'scheduled', technician_id: 't-old', scheduled_date: '2099-01-15' };
const UPDATED = { ...JOB, technician_id: 't-new', route_order: null };
const calls = [];
let placeSpy;
let trx;

function buildTrx() {
  const chain = {};
  for (const name of ['where', 'whereNotIn', 'whereRaw', 'modify', 'whereNull', 'update']) chain[name] = jest.fn(() => chain);
  // first(raw): the day read inside the assign; first(): the job read (when a caller hands in its trx).
  chain.first = jest.fn(async (...args) => (args.length ? { day: '2099-01-15' } : JOB));
  chain.select = jest.fn(async () => []);
  chain.returning = jest.fn(async () => [UPDATED]);
  const t = jest.fn(() => chain);
  t.isTransaction = true;
  t.raw = jest.fn(() => 'raw');
  t.fn = { now: jest.fn(() => 'now') };
  return t;
}

const gateOn = () => {
  process.env.GATE_ROUTE_CHECK_ASSIGN_SAVES = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
};

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  trx = buildTrx();
  const jobChain = { where: jest.fn(() => jobChain), first: jest.fn(async () => JOB) };
  db.mockImplementation(() => jobChain);
  db.transaction = jest.fn(async (fn) => fn(trx));
  lockTechDays.mockImplementation(async () => { calls.push('lock'); return []; });
  placeSpy = jest.spyOn(arrivalRoute, 'placeMovedVisit').mockImplementation(async () => { calls.push('place'); return [1]; });
});
afterEach(() => {
  delete process.env.GATE_ROUTE_CHECK_ASSIGN_SAVES;
  delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  placeSpy.mockRestore();
});

const assign = (extra = {}) => assignDispatchJob({
  jobId: 'job-1', technicianId: 't-new', actorId: 'admin', emit: false, skipVisitSeam: true, ...extra,
});

describe('the gate readers (call time)', () => {
  test('unset reads off; on needs the arrival-window route check; the sibling gates do not turn it on', () => {
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    expect(arrivalRoute.routeCheckAssignSavesLive()).toBe(false);
    process.env.GATE_ROUTE_CHECK_AUTO_SAVES = 'true';
    process.env.GATE_ROUTE_CHECK_ACCEPT_SAVES = 'true';
    expect(arrivalRoute.routeCheckAssignSavesLive()).toBe(false);
    process.env.GATE_ROUTE_CHECK_ASSIGN_SAVES = 'true';
    expect(arrivalRoute.routeCheckAssignSavesLive()).toBe(true);
    delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    expect(arrivalRoute.routeCheckAssignSavesLive()).toBe(false);
    delete process.env.GATE_ROUTE_CHECK_AUTO_SAVES;
    delete process.env.GATE_ROUTE_CHECK_ACCEPT_SAVES;
  });
});

describe('assignDispatchJob place option', () => {
  test('gate off: place:true touches nothing, and the result is the same', async () => {
    const out = await assign({ place: true });
    expect(placeSpy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ changed: true, technicianName: 'Tech Two', job: UPDATED });
  });

  test('gate on: one placement on the assign transaction, source dispatch_assign, after the tech-day fence', async () => {
    gateOn();
    const out = await assign({ place: true });
    expect(placeSpy).toHaveBeenCalledTimes(1);
    expect(placeSpy).toHaveBeenCalledWith(trx, { serviceId: 'job-1', staffSave: true, source: 'dispatch_assign' });
    expect(calls).toEqual(['lock', 'place']);
    expect(out).toMatchObject({ changed: true, technicianName: 'Tech Two', job: UPDATED });
  });

  test('gate on, a caller transaction: the placement rides that transaction', async () => {
    gateOn();
    await assign({ place: true, trx });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(placeSpy).toHaveBeenCalledWith(trx, expect.objectContaining({ serviceId: 'job-1', source: 'dispatch_assign' }));
  });

  test.each([
    ['no place option (the Edit modal, visit-group moves, every other caller)', {}],
    ['place:false', { place: false }],
    ['a truthy non-true value', { place: 'yes' }],
  ])('gate on, %s: never places', async (_label, extra) => {
    gateOn();
    const out = await assign(extra);
    expect(placeSpy).not.toHaveBeenCalled();
    expect(out.changed).toBe(true);
  });

  test('gate on: an unassign (no technician) is not placed', async () => {
    gateOn();
    await assign({ technicianId: null, place: true });
    expect(placeSpy).not.toHaveBeenCalled();
  });

  test('gate on: an assign that changes nothing is not placed', async () => {
    gateOn();
    const out = await assign({ technicianId: 't-old', place: true });
    expect(out.changed).toBe(false);
    expect(placeSpy).not.toHaveBeenCalled();
  });

  test('gate on: a throwing placement is one warning line and the assign still commits', async () => {
    gateOn();
    placeSpy.mockRejectedValueOnce(new Error('route boom'));
    const out = await assign({ place: true });
    expect(out).toMatchObject({ changed: true, job: UPDATED });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('route boom'));
  });
});

describe('who opts in (source pattern)', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const callsWithPlace = (file) => (read(file).match(/assignDispatchJob\(\{[^}]*?\bplace: true/gs) || []).length;

  test('only the office board assign route passes place:true', () => {
    expect(callsWithPlace('../routes/admin-dispatch.js')).toBe(1);
    expect(read('../routes/admin-dispatch.js')).toMatch(/router\.put\('\/jobs\/:id\/assign'[\s\S]*?place: true/);
    for (const file of ['../routes/admin-schedule.js', '../services/visit-groups.js']) {
      expect(callsWithPlace(file)).toBe(0);
    }
  });
});
