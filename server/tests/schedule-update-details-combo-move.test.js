/**
 * update-details on a stop shared by two or more services (owner rulings
 * 2026-10-03): `comboMove` 'together' plans the whole-stop move before any
 * write, takes the date / window / technician off the body and runs the move
 * after the edit; 'separate' splits the service first. No comboMove, a row
 * that is not on a shared stop, or no date / time / technician change leaves
 * the handler exactly as it was.
 *
 * The planner is driven directly with a scripted db and mocked collaborators;
 * source guards pin where the handler calls it.
 */
let mockRow = null;
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'orderBy', 'select']) chain[m] = () => chain;
    chain.first = async () => mockRow;
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return chain;
  });
  db.raw = () => ({});
  db.fn = { now: () => new Date() };
  db.transaction = async (cb) => cb(db);
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockVisitGroups = {
  openMembers: jest.fn(),
  splitChild: jest.fn(),
  visitSummaryForService: jest.fn(),
};
jest.mock('../services/visit-groups', () => ({ ...jest.requireActual('../services/visit-groups'), ...mockVisitGroups }));
const mockDispatch = { planVisitMoveForStaff: jest.fn(), runPlannedVisitMove: jest.fn() };
jest.mock('../routes/admin-dispatch', () => mockDispatch);

const fs = require('fs');
const path = require('path');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { planComboEditMove, commitComboEditMove, comboEditChanges, comboLengthChange } = require('../routes/admin-schedule')._test;

const FUTURE = etDateString(addETDays(new Date(), 10));
const TARGET = etDateString(addETDays(new Date(), 12));
const ROW = { id: 'svc-a', visit_id: 'v1', scheduled_date: FUTURE, window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, technician_id: 'tech-1' };
const SUMMARY = { id: 'v1', memberIds: ['svc-a', 'svc-b'], liveCount: 2, liveMemberIds: ['svc-a', 'svc-b'] };
const request = (body) => ({ params: { id: 'svc-a' }, body, techRole: 'admin', technicianId: 'staff-1' });

beforeEach(() => {
  jest.clearAllMocks();
  mockRow = { ...ROW };
  mockVisitGroups.openMembers.mockResolvedValue([{ id: 'svc-a' }, { id: 'svc-b' }]);
  mockVisitGroups.visitSummaryForService.mockResolvedValue(SUMMARY);
  mockVisitGroups.splitChild.mockResolvedValue({});
  mockDispatch.planVisitMoveForStaff.mockResolvedValue({ plan: { effectiveWindow: '09:00-10:00', rescheduleOptions: {} } });
  mockDispatch.runPlannedVisitMove.mockResolvedValue({ status: 200, body: { success: true, notificationSent: true } });
});

describe('when the planner stays out of the way', () => {
  test('no comboMove, a row off any shared stop, or one live service left: null and nothing is read or written past that', async () => {
    expect(await planComboEditMove(request({ scheduledDate: TARGET }))).toBe(null);
    mockRow = { ...ROW, visit_id: null };
    expect(await planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'together' }))).toBe(null);
    mockRow = { ...ROW };
    mockVisitGroups.openMembers.mockResolvedValue([{ id: 'svc-a' }]);
    const req = request({ scheduledDate: TARGET, comboMove: 'separate' });
    expect(await planComboEditMove(req)).toBe(null);
    expect(req.body.scheduledDate).toBe(TARGET);
    expect(mockVisitGroups.splitChild).not.toHaveBeenCalled();
    expect(mockDispatch.planVisitMoveForStaff).not.toHaveBeenCalled();
  });

  test('a same-slot echo (the form posts the stored date, window and technician) is an ordinary edit', async () => {
    const req = request({ scheduledDate: FUTURE, windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-1', notes: 'x', comboMove: 'together' });
    expect(await planComboEditMove(req)).toBe(null);
    expect(req.body.windowStart).toBe('09:00');
  });

  test('an unknown choice is a 400', async () => {
    await expect(planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'both' }))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("comboMove 'together'", () => {
  test('plans the same staff move against the live stop, strips the move from the edit, and runs it on commit', async () => {
    const req = request({ scheduledDate: TARGET, windowStart: '11:00', windowEnd: '12:00', technicianId: 'tech-2', assignmentScope: 'following', notifyCustomer: true, notes: 'gate code', comboMove: 'together' });
    const plan = await planComboEditMove(req);
    expect(mockDispatch.planVisitMoveForStaff).toHaveBeenCalledWith({
      serviceId: 'svc-a',
      newDate: TARGET,
      newWindow: { start: '11:00', end: '12:00' },
      notifyCustomer: true,
      body: { technicianId: 'tech-2', expectVisit: SUMMARY },
      actor: { techRole: 'admin', technicianId: 'staff-1' },
      sourceSurface: 'edit_modal',
    });
    // The per-row edit keeps the other fields and nothing that moves, reassigns or texts.
    expect(req.body).toEqual({ notes: 'gate code', comboMove: 'together' });
    expect(mockDispatch.runPlannedVisitMove).not.toHaveBeenCalled();
    await plan.commit();
    expect(mockDispatch.runPlannedVisitMove).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'svc-a', newDate: TARGET, notifyCustomer: true, actor: { techRole: 'admin', technicianId: 'staff-1' } }));
  });

  test('a technician-only change reassigns the whole stop on its stored date and window, and texts nobody', async () => {
    const req = request({ scheduledDate: FUTURE, windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-2', notifyCustomer: true, comboMove: 'together' });
    await planComboEditMove(req);
    expect(mockDispatch.planVisitMoveForStaff).toHaveBeenCalledWith(expect.objectContaining({
      newDate: FUTURE, newWindow: undefined, notifyCustomer: false,
      body: { technicianId: 'tech-2', expectVisit: SUMMARY },
    }));
  });

  test('a stop with no stored time takes the start only', async () => {
    mockRow = { ...ROW, window_start: null, window_end: null };
    await planComboEditMove(request({ windowStart: '10:00', windowEnd: '11:00', comboMove: 'together' }));
    expect(mockDispatch.planVisitMoveForStaff).toHaveBeenCalledWith(expect.objectContaining({ newDate: FUTURE, newWindow: { start: '10:00' } }));
  });

  test('every refusal comes before any write: length change, address change, cleared time, and a refused plan', async () => {
    const stays = async (body, match) => {
      const req = request(body);
      const before = { ...body };
      await expect(planComboEditMove(req)).rejects.toMatchObject(match);
      expect(req.body).toEqual(before);
    };
    await stays({ scheduledDate: TARGET, estimatedDuration: '90', comboMove: 'together' }, { statusCode: 422, code: 'COMBO_LENGTH_CHANGE' });
    await stays({ scheduledDate: TARGET, windowStart: '09:00', windowEnd: '11:00', comboMove: 'together' }, { statusCode: 422, code: 'COMBO_LENGTH_CHANGE' });
    await stays({ scheduledDate: TARGET, propertyId: 'p2', comboMove: 'together' }, { statusCode: 422, code: 'COMBO_ADDRESS_CHANGE' });
    await stays({ windowStart: '', windowEnd: '', comboMove: 'together' }, { statusCode: 422, code: 'INVALID_APPOINTMENT_WINDOW' });
    expect(mockDispatch.planVisitMoveForStaff).not.toHaveBeenCalled();
    mockDispatch.planVisitMoveForStaff.mockResolvedValue({ status: 409, body: { error: 'This stop changed since it was opened.', code: 'VISIT_MEMBERSHIP_CHANGED' } });
    await stays({ scheduledDate: TARGET, comboMove: 'together' }, { statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED', message: 'This stop changed since it was opened. Nothing was changed.' });
    expect(mockDispatch.runPlannedVisitMove).not.toHaveBeenCalled();
  });
});

describe('the stop the operator was shown', () => {
  test('a stop whose live services differ from the shown ones is refused before anything is saved, for either choice', async () => {
    const shown = { id: 'v1', memberIds: ['svc-a', 'svc-b'], liveCount: 2, liveMemberIds: ['svc-a', 'svc-b'] };
    mockVisitGroups.visitSummaryForService.mockResolvedValue({ id: 'v1', memberIds: ['svc-a', 'svc-b', 'svc-c'], liveCount: 3, liveMemberIds: ['svc-a', 'svc-b', 'svc-c'] });
    for (const comboMove of ['together', 'separate']) {
      const req = request({ scheduledDate: TARGET, comboMove, comboVisit: shown });
      await expect(planComboEditMove(req)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED' });
      expect(req.body.scheduledDate).toBe(TARGET);
    }
    // Same count, a different live service.
    mockVisitGroups.visitSummaryForService.mockResolvedValue({ id: 'v1', memberIds: ['svc-a', 'svc-b', 'svc-c'], liveCount: 2, liveMemberIds: ['svc-a', 'svc-c'] });
    await expect(planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'together', comboVisit: shown }))).rejects.toMatchObject({ code: 'VISIT_MEMBERSHIP_CHANGED' });
    expect(mockVisitGroups.splitChild).not.toHaveBeenCalled();
    expect(mockDispatch.planVisitMoveForStaff).not.toHaveBeenCalled();
    // The same stop: the move is planned on it.
    mockVisitGroups.visitSummaryForService.mockResolvedValue(SUMMARY);
    await planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'together', comboVisit: shown }));
    expect(mockDispatch.planVisitMoveForStaff).toHaveBeenCalledTimes(1);
  });
});

describe('a retried save whose move already committed', () => {
  test("'together' with nothing left to change and a text requested still goes through the move, so an unsent text is recovered", async () => {
    const req = request({ scheduledDate: FUTURE, windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-1', notifyCustomer: true, comboMove: 'together' });
    const plan = await planComboEditMove(req);
    expect(mockDispatch.planVisitMoveForStaff).toHaveBeenCalledWith(expect.objectContaining({ newDate: FUTURE, newWindow: undefined, notifyCustomer: true }));
    expect(typeof plan.commit).toBe('function');
    // No text requested: an ordinary edit.
    jest.clearAllMocks();
    expect(await planComboEditMove(request({ scheduledDate: FUTURE, windowStart: '09:00', notifyCustomer: false, comboMove: 'together' }))).toBe(null);
    expect(mockDispatch.planVisitMoveForStaff).not.toHaveBeenCalled();
  });
});

describe("comboMove 'separate'", () => {
  test('a length-only change (duration or window end) is split off too', async () => {
    for (const change of [{ estimatedDuration: '90' }, { windowStart: '09:00', windowEnd: '11:00' }]) {
      mockVisitGroups.splitChild.mockClear();
      expect(await planComboEditMove(request({ ...change, comboMove: 'separate' }))).toEqual({ separated: true });
      expect(mockVisitGroups.splitChild).toHaveBeenCalledTimes(1);
    }
  });

  test('splits the service off its stop and leaves the body for the ordinary edit', async () => {
    const req = request({ scheduledDate: TARGET, notifyCustomer: true, comboMove: 'separate' });
    expect(await planComboEditMove(req)).toEqual({ separated: true });
    expect(mockVisitGroups.splitChild).toHaveBeenCalledWith({ visitId: 'v1', scheduledServiceId: 'svc-a', createdBy: 'admin:staff-1' });
    expect(req.body).toEqual({ scheduledDate: TARGET, notifyCustomer: true, comboMove: 'separate' });
    expect(mockDispatch.planVisitMoveForStaff).not.toHaveBeenCalled();
  });

  test('a refused split saves nothing', async () => {
    mockVisitGroups.splitChild.mockRejectedValue(Object.assign(new Error('frozen'), { code: 'VISIT_SPLIT_REFUSED' }));
    await expect(planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'separate' }))).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SPLIT_REFUSED', message: 'frozen Nothing was changed.' });
    mockVisitGroups.splitChild.mockRejectedValue(new Error('row is not a member of this visit'));
    await expect(planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'separate' }))).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_CHANGED_RETRY' });
    mockVisitGroups.splitChild.mockRejectedValue(new Error('connection reset'));
    await expect(planComboEditMove(request({ scheduledDate: TARGET, comboMove: 'separate' }))).rejects.toThrow('connection reset');
  });
});

describe('commitComboEditMove: the move outcome is part of the saved answer', () => {
  test('moved, partly moved, refused, and unknown', async () => {
    expect(await commitComboEditMove({ commit: async () => ({ status: 200, body: { success: true, warnings: ['w'] } }) }, 'svc-a'))
      .toEqual({ success: true, warnings: ['w'], moved: true });
    expect(await commitComboEditMove({ commit: async () => ({ status: 200, body: { needsAttention: { message: 'part' } } }) }, 'svc-a'))
      .toMatchObject({ moved: false, needsAttention: { message: 'part' } });
    expect(await commitComboEditMove({ commit: async () => { throw Object.assign(new Error('past the workday'), { statusCode: 422, code: 'INVALID_APPOINTMENT_WINDOW' }); } }, 'svc-a'))
      .toEqual({ moved: false, error: 'past the workday', code: 'INVALID_APPOINTMENT_WINDOW' });
    expect(await commitComboEditMove({ commit: async () => { throw new Error('connection reset'); } }, 'svc-a'))
      .toEqual({ moved: null, error: 'connection reset' });
  });
});

describe('what counts as a change', () => {
  test('date, start and technician are each compared with the stored row', () => {
    expect(comboEditChanges({ scheduledDate: FUTURE, windowStart: '09:00', technicianId: 'tech-1' }, ROW)).toMatchObject({ date: false, start: false, technician: false });
    expect(comboEditChanges({ scheduledDate: TARGET }, ROW)).toMatchObject({ date: true, start: false, technician: false });
    expect(comboEditChanges({ windowStart: '10:00' }, ROW)).toMatchObject({ start: true });
    expect(comboEditChanges({ technicianId: '' }, ROW)).toMatchObject({ technician: true });
    expect(comboEditChanges({ technicianId: null }, { ...ROW, technician_id: null })).toMatchObject({ technician: false });
    expect(comboLengthChange({ estimatedDuration: '60' }, ROW, { windowStart: '11:00', windowEnd: '12:00' })).toBe(false);
    expect(comboEditChanges({ estimatedDuration: '90' }, ROW)).toMatchObject({ length: true, date: false, start: false });
  });
});

describe('handler wiring (source guards)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const handler = src.indexOf("router.put('/:id/update-details'");
  test('the combo plan runs before the series planner and before the body is destructured; the move runs after the edit, before the notice', () => {
    const plan = src.indexOf('const comboMovePlan = await planComboEditMove(req);', handler);
    const series = src.indexOf('const seriesMovePlan = await planCollectiveEditDateMove(req);', handler);
    const commit = src.indexOf('await commitComboEditMove(comboMovePlan, req.params.id)', handler);
    const notice = src.indexOf('// Immediate reschedule text', handler);
    expect(plan).toBeGreaterThan(handler);
    expect(series).toBeGreaterThan(plan);
    expect(src.indexOf('} = req.body;', handler)).toBeGreaterThan(series);
    expect(commit).toBeGreaterThan(src.indexOf('seriesMove = await seriesMovePlan.commit();', handler));
    expect(commit).toBeLessThan(notice);
    expect(src.slice(notice, src.indexOf("router.post('/:id/update-details/preview'", handler))).toContain('...(comboMove ? { comboMove } : {}),');
  });
});
