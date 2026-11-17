/**
 * planVisitMoveForStaff `seriesPolicy: 'single'` (the re-service fold, GATE_RESERVICE_FOLD, owner 2026-11-17).
 *
 * With GATE_ADMIN_COLLECTIVE_MOVE on, a date move of an ungrouped recurring visit is refused until the surface
 * acknowledges the series it would move (COLLECTIVE_MOVE_ACK_REQUIRED). The fold moves ONE plan visit and leaves the plan
 * alone, so it passes seriesPolicy 'single': no acknowledgement is owed and the rebooker is told never to widen the move.
 * Every other caller (no option) keeps the acknowledgement exactly as before.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
let mockVisitRow = null;
let mockOpenMembers = [];
jest.mock('../models/db', () => {
  const chain = () => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'forUpdate', 'leftJoin', 'join', 'orderBy', 'limit', 'update', 'insert']) c[m] = () => c;
    c.select = async () => mockOpenMembers;
    c.first = async () => mockVisitRow;
    c.then = (resolve) => Promise.resolve([]).then(resolve);
    return c;
  };
  const proxy = () => chain();
  proxy.transaction = async (cb) => cb(proxy);
  proxy.raw = () => ({});
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  rescheduleSeries: jest.fn().mockResolvedValue({ success: true, rescheduledOccurrences: [] }),
  applyLiveMovePostCommitEffects: jest.fn(),
  collectiveMoveGateOn: () => process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true',
  previewSeriesMove: jest.fn().mockResolvedValue({ collective: true, movableCount: 4, occurrenceIds: ['o1', 'o2', 'o3', 'o4'], skippedCount: 0, exceptionCount: 0, conflictCount: 0 }),
}));
const SmartRebooker = require('../services/rebooker');
const { planVisitMoveForStaff } = require('../routes/admin-dispatch');
const { etDateString, addETDays } = require('../utils/datetime-et');

const VISIT_ID = '00000000-0000-4000-8000-000000000001';
const TODAY = etDateString(new Date());
const TARGET = etDateString(addETDays(new Date(), 7));
const ACTOR = { techRole: 'admin', technicianId: 'staff-1' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
  mockVisitRow = {
    id: VISIT_ID, technician_id: 'tech-1', scheduled_date: TODAY,
    window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60,
    is_recurring: true, visit_id: null, status: 'pending',
  };
  mockOpenMembers = [];
});
afterEach(() => { delete process.env.GATE_ADMIN_COLLECTIVE_MOVE; });

const plan = (extra = {}) => planVisitMoveForStaff({
  serviceId: VISIT_ID, newDate: TARGET, newWindow: { start: '10:00' }, notifyCustomer: false, body: {}, actor: ACTOR, ...extra,
});

test('default: a date move of a recurring visit still demands the series acknowledgement while the collective gate is on', async () => {
  const out = await plan();
  expect(out.plan).toBeUndefined();
  expect(out.status).toBe(409);
  expect(out.body.code).toBe('COLLECTIVE_MOVE_ACK_REQUIRED');
});

test("seriesPolicy 'single': no acknowledgement, the rebooker is told to move this visit only", async () => {
  const out = await plan({ seriesPolicy: 'single', sourceSurface: 'office_booking' });
  expect(out.plan.rescheduleOptions).toMatchObject({ seriesPolicy: 'single', sourceSurface: 'office_booking' });
  // No series scope is pinned: expectScope 'single' would be refused against a recurring row under the collective gate.
  expect(out.plan.rescheduleOptions.expectScope).toBeUndefined();
  expect(out.plan.rescheduleOptions.expectOccurrenceIds).toBeUndefined();
  expect(SmartRebooker.previewSeriesMove).not.toHaveBeenCalled();
});
