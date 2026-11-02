// Auto-dispatch keeps the visit's status inside the move transaction
// (keepStatus), and post_status reports what is persisted. Only a rewound
// live lifecycle lands a pending visit on 'confirmed'; then the fenced
// restore runs, and 'pending' is reported only if that restore wrote the row.
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({ id: 'r1', confirmation_sent: true }),
  REMINDER_BLOCKING_STATUSES: new Set(['cancelled', 'canceled', 'completed', 'skipped', 'no_show', 'rescheduled']),
  reminderRowCanSend: (row) => !!row && row.cancelled !== true && row.suppressed_by_sibling !== true && row.windows_preclosed !== true,
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }),
  _private: { doneColumns: jest.fn(({ by, resolution, at }) => ({ done_at: at, done_by: by, resolution })) },
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn().mockResolvedValue({ failed: false, frozen: new Set() }),
  loadAnchorMap: jest.fn().mockResolvedValue(new Map()),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { applyAutoDispatchMove } = require('../services/auto-dispatch/apply');

const SERVICE = {
  id: 's1', status: 'pending', scheduled_date: '2026-08-04',
  window_start: '09:00', window_end: '11:00', technician_id: 't1', auto_dispatch_change_count: 0,
};
const BEST = { date: '2026-08-11', start_time: '08:00', end_time: '10:00', technician_id: 't1' };
const LANDED = { scheduled_date: '2026-08-11', window_start: '08:00', window_end: '10:00' };

// scheduled_services: the first call is apply's fresh read, every later call
// a post-move stamp (`stamps` answers them in order). Each stamp's where and
// patch are recorded; job_status_history inserts land in `history`.
function wire({ status = 'pending', stamps = [] } = {}) {
  const writes = [];
  const history = [];
  let ssCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'scheduled_services' && ssCalls++ === 0) {
      return { where() { return this; }, first: async () => ({ ...SERVICE, status, auto_dispatch_locked: false, auto_dispatch_excluded: false, customer_confirmed: false }) };
    }
    if (table === 'scheduled_services') {
      const write = { where: null, patch: null };
      writes.push(write);
      const answer = stamps.shift();
      return {
        where(pred) { write.where = pred; return this; },
        update: async (patch) => { write.patch = patch; if (answer instanceof Error) throw answer; return answer === undefined ? 1 : answer; },
      };
    }
    if (table === 'job_status_history') return { insert: async (row) => { history.push(row); } };
    return { where() { return this; }, whereNot() { return this; }, whereRaw() { return this; }, update: async () => 0 };
  });
  return { writes, history };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((s) => ({ raw: s }));
  db.fn = { now: jest.fn(() => 'now()') };
});

test('the move asks the rebooker to keep the visit\'s status', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({ success: true, landedStatus: 'pending' });
  wire();
  await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(SmartRebooker.reschedule.mock.calls[0][5]).toMatchObject({ keepStatus: true, expect: expect.objectContaining({ status: 'pending' }) });
});

test('a pending visit that landed pending gets its stamp only: no status write, no history row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({ success: true, landedStatus: 'pending' });
  const { writes, history } = wire();
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(res).toMatchObject({ pre_status: 'pending', post_status: 'pending' });
  expect(writes).toHaveLength(1);
  expect(writes[0].where).toEqual({ id: 's1', status: 'pending', ...LANDED });
  expect(writes[0].patch.status).toBeUndefined();
  expect(writes[0].patch.last_auto_dispatch_run_id).toBe('run1');
  expect(history).toEqual([]);
});

test('a rewound pending visit (landed confirmed) is restored to pending and logs the compensating transition', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({ success: true, landedStatus: 'confirmed' });
  const { writes, history } = wire();
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(res.post_status).toBe('pending');
  expect(writes[0].where).toEqual({ id: 's1', status: 'confirmed', ...LANDED, customer_confirmed: false });
  expect(writes[0].patch.status).toBe('pending');
  expect(history).toEqual([{ job_id: 's1', from_status: 'confirmed', to_status: 'pending', transitioned_by: null }]);
});

test.each([
  ['the restore write fails', new Error('synthetic post-commit write failure')],
  ['the restore fence misses (a confirm landed after the move)', 0],
])('a rewound pending visit reports confirmed when %s, and logs no history row', async (_label, answer) => {
  SmartRebooker.reschedule.mockResolvedValueOnce({ success: true, landedStatus: 'confirmed' });
  const { history } = wire({ stamps: [answer] });
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(res.post_status).toBe('confirmed');
  expect(history).toEqual([]);
});

test('a failed stamp on a visit that landed pending still reports pending (the move persisted it)', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({ success: true, landedStatus: 'pending' });
  wire({ stamps: [new Error('synthetic post-commit write failure')] });
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(res.post_status).toBe('pending');
});

test('a move that reports no landed status gets no bookkeeping and claims no status', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({ success: true });
  const { writes } = wire();
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(res.post_status).toBeNull();
  expect(writes.filter((w) => w.patch)).toEqual([]);
});

describe('a grouped sibling follows the same rules from its own landed status', () => {
  const unit = (sib) => ({
    success: true, landedStatus: 'confirmed',
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed', landedStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'pending', landed: LANDED, ...sib },
    ] },
  });

  test('landed pending: stamp only, fenced on pending', async () => {
    SmartRebooker.reschedule.mockResolvedValueOnce(unit({ landedStatus: 'pending' }));
    const { writes, history } = wire({ status: 'confirmed' });
    await applyAutoDispatchMove({ ...SERVICE, status: 'confirmed' }, BEST, 'run1', {});
    expect(writes[1].where).toEqual({ id: 's2', status: 'pending', ...LANDED });
    expect(writes[1].patch.status).toBeUndefined();
    expect(history).toEqual([]);
  });

  test('rewound to confirmed: restored, with a history row', async () => {
    SmartRebooker.reschedule.mockResolvedValueOnce(unit({ landedStatus: 'confirmed' }));
    const { writes, history } = wire({ status: 'confirmed' });
    await applyAutoDispatchMove({ ...SERVICE, status: 'confirmed' }, BEST, 'run1', {});
    expect(writes[1].where).toEqual({ id: 's2', status: 'confirmed', ...LANDED, customer_confirmed: false });
    expect(writes[1].patch.status).toBe('pending');
    expect(history).toEqual([{ job_id: 's2', from_status: 'confirmed', to_status: 'pending', transitioned_by: null }]);
  });

  test('rewound and the restore fails: no history row', async () => {
    SmartRebooker.reschedule.mockResolvedValueOnce(unit({ landedStatus: 'confirmed' }));
    const { history } = wire({ status: 'confirmed', stamps: [1, new Error('synthetic post-commit write failure')] });
    await expect(applyAutoDispatchMove({ ...SERVICE, status: 'confirmed' }, BEST, 'run1', {})).resolves.toMatchObject({ ok: true, post_status: 'confirmed' });
    expect(history).toEqual([]);
  });

  test('no landed status: no bookkeeping for the sibling', async () => {
    SmartRebooker.reschedule.mockResolvedValueOnce(unit({}));
    const { writes } = wire({ status: 'confirmed' });
    await applyAutoDispatchMove({ ...SERVICE, status: 'confirmed' }, BEST, 'run1', {});
    // (The sibling's later reminder check reads the row; only patches are stamps.)
    expect(writes.filter((w) => w.patch).map((w) => w.where.id)).toEqual(['s1']);
  });
});
