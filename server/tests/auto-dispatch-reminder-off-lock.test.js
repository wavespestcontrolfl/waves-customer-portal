// REMINDERS-OFF LOCK (owner 2026-11-07, "lock"): the night run never moves a visit whose 24-hour reminder will
// not go out, because the move sends the customer nothing and that reminder is the only notice. This suite covers
// the lock's own reads (auto-dispatch/reminder-off.js) and its two places on the move transaction: the moving row
// (apply.js makeMoveGuard) and each grouped sibling (makeMemberGuard). The run itself (pass 1 and the pass-2 re-read)
// is in auto-dispatch-reminder-off-lock-orchestrator.test.js. Synthetic ids only.
jest.mock('../services/appointment-reminders', () => ({ loadVisitReminder24hAnswers: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
// The person-placed check reads move history this fake trx does not model; it has its own suite.
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));

const { loadVisitReminder24hAnswers } = require('../services/appointment-reminders');
const reminderOff = require('../services/auto-dispatch/reminder-off');
const { makeMoveGuard, makeMemberGuard } = require('../services/auto-dispatch/apply');
const { shiftDateStr } = require('../services/auto-dispatch/dates');
const { etDateString } = require('../utils/datetime-et');

// The answers the reader gives: visit id -> will the 24-hour reminder go out. A visit left out has no answer.
const answers = (byId) => loadVisitReminder24hAnswers.mockImplementation(async (_conn, visits) => new Map(
  visits.filter((v) => Object.prototype.hasOwnProperty.call(byId, v.id)).map((v) => [v.id, byId[v.id]]),
));
const refuse = (id, why) => Object.assign(new Error(`refused ${id}: ${why}`), { statusCode: 409, id, why });
const placed = (over = {}) => ({ id: 's1', customer_id: 'c1', property_id: null, window_start: '09:00', recurring_dispatch_due_date: null, ...over });
const unplaced = (over = {}) => placed({ window_start: null, recurring_dispatch_due_date: '2026-12-01', ...over });

// A move transaction that answers every scheduled_services read with `rows` and every other read with nothing.
function fakeTrx(rows) {
  const calls = [];
  const trx = jest.fn((table) => {
    const isSS = String(table).startsWith('scheduled_services');
    const api = {
      where: (w) => { if (typeof w === 'function') w.call(api); return api; },
      orWhere: () => api,
      whereIn: (column, values) => { if (isSS) calls.push(values); return api; },
      whereNotIn: () => api, whereNull: () => api, leftJoin: () => api, forShare: () => api,
      whereRaw: () => api, groupBy: () => api, count: () => api,
      select: async () => (isSS ? rows : []),
      first: async () => null,
    };
    return api;
  });
  trx.ssReads = calls;
  return trx;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('loadReminderOffIds: the senders\' own answer, per placed visit', () => {
  test('a visit whose reminder will not go out, or that has no answer at all, is locked; one that goes out is not', async () => {
    answers({ s1: false, s2: true });
    const off = await reminderOff.loadReminderOffIds('conn', [
      placed({ id: 's1', property_id: 'p1' }), placed({ id: 's2', customer_id: 'c2' }), placed({ id: 's3', customer_id: null }),
    ]);
    expect([...off].sort()).toEqual(['s1', 's3']);
    expect(loadVisitReminder24hAnswers).toHaveBeenCalledWith('conn', [
      { id: 's1', customer_id: 'c1', property_id: 'p1' }, { id: 's2', customer_id: 'c2', property_id: null }, { id: 's3', customer_id: null, property_id: null },
    ]);
  });

  test('an unplaced due-date visit is a first placement, not a move: it is never read or locked', async () => {
    answers({});
    expect(await reminderOff.loadReminderOffIds('conn', [unplaced()])).toEqual(new Set());
    expect(loadVisitReminder24hAnswers).not.toHaveBeenCalled();
  });

  test('a failed read throws (the callers fail closed)', async () => {
    loadVisitReminder24hAnswers.mockRejectedValue(new Error('prefs read down'));
    await expect(reminderOff.loadReminderOffIds('conn', [placed()])).rejects.toThrow('prefs read down');
  });
});

describe('pass 1 and the pass-2 re-read', () => {
  test('skipFor: locked -> REMINDER_24H_OFF; unreadable -> REMINDER_24H_UNKNOWN; reminder on or unplaced -> may move', () => {
    const offIds = new Set(['s1']);
    expect(reminderOff.skipFor(offIds, placed())).toMatchObject({ reason_code: 'REMINDER_24H_OFF', reason_description: expect.stringContaining('would not hear of a move') });
    expect(reminderOff.skipFor(offIds, placed({ id: 's2' }))).toBeNull();
    expect(reminderOff.skipFor(null, placed({ id: 's2' }))).toMatchObject({ reason_code: 'REMINDER_24H_UNKNOWN' });
    expect(reminderOff.skipFor(null, unplaced())).toBeNull();
  });

  test('loadRunOffIds: a failed read is null, never an empty set (nothing may move)', async () => {
    loadVisitReminder24hAnswers.mockRejectedValue(new Error('down'));
    expect(await reminderOff.loadRunOffIds('conn', [placed()])).toBeNull();
  });

  test('recheckFor: reads this one visit again; off -> REMINDER_24H_OFF, unreadable -> REMINDER_24H_UNKNOWN (degraded)', async () => {
    answers({ s1: false });
    expect(await reminderOff.recheckFor('conn', placed())).toMatchObject({ code: 'REMINDER_24H_OFF' });
    answers({ s1: true });
    expect(await reminderOff.recheckFor('conn', placed())).toBeNull();
    loadVisitReminder24hAnswers.mockRejectedValue(new Error('down'));
    expect(await reminderOff.recheckFor('conn', placed())).toEqual({ code: 'REMINDER_24H_UNKNOWN', description: expect.stringContaining('fail closed'), degraded: true });
    loadVisitReminder24hAnswers.mockClear();
    expect(await reminderOff.recheckFor('conn', unplaced())).toBeNull();
    expect(loadVisitReminder24hAnswers).not.toHaveBeenCalled();
  });
});

describe('assertRemindersOn: on the move transaction', () => {
  test('reads each row again on the transaction and asks with the fresh customer and property', async () => {
    answers({ s1: true });
    const trx = fakeTrx([placed({ property_id: 'p-now' })]);
    await expect(reminderOff.assertRemindersOn(trx, [placed({ property_id: 'p-then' })], refuse)).resolves.toBeUndefined();
    expect(trx.ssReads).toEqual([['s1']]);
    expect(loadVisitReminder24hAnswers).toHaveBeenCalledWith(trx, [{ id: 's1', customer_id: 'c1', property_id: 'p-now' }]);
  });

  test('refuses a row whose reminder is off, and a row that is gone', async () => {
    answers({ s1: false });
    await expect(reminderOff.assertRemindersOn(fakeTrx([placed()]), [placed()], refuse))
      .rejects.toMatchObject({ id: 's1', why: 'has its 24-hour reminder off, so the customer would not hear of the move (no move)' });
    await expect(reminderOff.assertRemindersOn(fakeTrx([]), [placed()], refuse)).rejects.toMatchObject({ id: 's1', why: 'is gone (no move)' });
  });

  test('a failed read throws, so nothing moves', async () => {
    loadVisitReminder24hAnswers.mockRejectedValue(new Error('down'));
    await expect(reminderOff.assertRemindersOn(fakeTrx([placed()]), [placed()], refuse)).rejects.toThrow('down');
  });

  test('a row still unplaced on the transaction is a first placement and passes', async () => {
    answers({});
    await expect(reminderOff.assertRemindersOn(fakeTrx([unplaced()]), [unplaced()], refuse)).resolves.toBeUndefined();
  });
});

// The move guards with every other check passing: the reminder answer alone decides.
describe('the move guards', () => {
  const FAR = shiftDateStr(etDateString(new Date()), 40);
  const service = {
    id: 's1', customer_id: 'c1', property_id: null, status: 'confirmed', scheduled_date: FAR, window_start: '09:00', window_end: '10:00',
    technician_id: 't1', service_type: 'Quarterly Pest Control', is_recurring: true, recurring_parent_id: 'p1',
  };
  // A weekday a few days later (the member guard refuses a weekend for a skip-weekends series only).
  const best = { date: shiftDateStr(FAR, 2), start_time: '08:00', end_time: '09:00', technician_id: 't1' };

  test('makeMoveGuard: the moving row with its reminder off is refused inside the move transaction (409)', async () => {
    const guard = makeMoveGuard({ service, best, config: {} });
    answers({ s1: false });
    await expect(guard({ trx: fakeTrx([service]), technicianId: 't1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD', message: expect.stringContaining('24-hour reminder off') });
    answers({ s1: true });
    await expect(guard({ trx: fakeTrx([service]), technicianId: 't1' })).resolves.toBeUndefined();
  });

  test('makeMoveGuard: a grouped member the rebooker hands over is the row checked', async () => {
    const guard = makeMoveGuard({ service, best, config: {} });
    const member = { ...service, id: 's2', customer_id: 'c2' };
    answers({ s1: true, s2: false });
    const trx = fakeTrx([member]);
    await expect(guard({ trx, technicianId: 't1', service: member })).rejects.toMatchObject({ message: expect.stringContaining('service s2 has its 24-hour reminder off') });
    expect(trx.ssReads).toEqual([['s2']]);
  });

  test('makeMemberGuard: a sibling with its reminder off holds the whole visit (409, names the sibling)', async () => {
    const sibling = {
      ...service, id: 's2', recurring_parent_id: 'p2', service_type: 'Lawn Fertilization', auto_dispatch_locked: false, auto_dispatch_excluded: false,
      customer_active: true, customer_latitude: 27.5, customer_longitude: -82.4,
    };
    const guard = makeMemberGuard({ service, best, config: {} });
    const members = [{ id: 's1', status: 'confirmed' }, { id: 's2', status: 'confirmed' }];
    answers({ s2: false });
    await expect(guard({ trx: fakeTrx([sibling]), members, targets: [] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2', message: expect.stringContaining('24-hour reminder off') });
    answers({ s2: true });
    await expect(guard({ trx: fakeTrx([sibling]), members, targets: [] })).resolves.toBeUndefined();
  });
});
