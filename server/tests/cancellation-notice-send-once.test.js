// Send-once contract on handleCancellation via the atomic
// cancellation_notice_at claim. The `cancelled` column is NOT the dedupe
// key — the status-sync trigger sets it during the cancel transition
// itself, before any route or post-commit hook runs (codex #3233 r1).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockDbState = { updates: [], reminderRow: null, claimResult: 1 };
jest.mock('../models/db', () => {
  const chain = (table, ctx = {}) => ({
    where: () => chain(table, ctx),
    whereNull: (col) => chain(table, { ...ctx, whereNull: col }),
    first: async () => (table === 'appointment_reminders' ? mockDbState.reminderRow : null),
    update: async (patch) => {
      mockDbState.updates.push({ table, patch, whereNull: ctx.whereNull || null });
      // The claim update is the one guarded by WHERE cancellation_notice_at IS NULL.
      if (ctx.whereNull === 'cancellation_notice_at') return mockDbState.claimResult;
      return 1;
    },
  });
  const qb = (table) => chain(table);
  qb.raw = () => { throw new Error('unexpected db.raw'); };
  qb.fn = { now: () => new Date() };
  return qb;
});

const AppointmentReminders = require('../services/appointment-reminders');

beforeEach(() => {
  mockDbState.updates.length = 0;
  mockDbState.reminderRow = null;
  mockDbState.claimResult = 1;
});

describe('handleCancellation send-once (atomic notice marker)', () => {
  test('lost claim (marker already taken) marks cancelled but does NOT re-send', async () => {
    mockDbState.reminderRow = {
      id: 'r1',
      customer_id: 'cu1',
      cancelled: true, // trigger already flipped it — must NOT gate the notice
      appointment_time: '2026-08-05T13:00:00Z',
      service_type: 'Monthly Pest Control Service',
    };
    mockDbState.claimResult = 0;
    const outcome = {};
    const record = await AppointmentReminders.handleCancellation('svc1', { outcome });
    expect(record).toBeTruthy();
    expect(mockDbState.updates.some((u) => u.patch.cancelled === true)).toBe(true);
    expect(outcome.notificationSent).toBe(false);
    expect(outcome.notificationError).toMatch(/already handled/i);
  });

  test('sendNotification:false still CLAIMS the marker (suppression blocks a later auto-send)', async () => {
    mockDbState.reminderRow = { id: 'r2', customer_id: 'cu1', cancelled: false, appointment_time: '2026-08-05T13:00:00Z', service_type: 'X' };
    const record = await AppointmentReminders.handleCancellation('svc2', { sendNotification: false });
    expect(record).toBeTruthy();
    const claim = mockDbState.updates.find((u) => u.whereNull === 'cancellation_notice_at');
    expect(claim).toBeTruthy();
    expect(claim.patch.cancellation_notice_at).toBeInstanceOf(Date);
  });

  test('missing reminder row is a no-op with an explanatory outcome', async () => {
    const outcome = {};
    const record = await AppointmentReminders.handleCancellation('svc3', { outcome });
    expect(record).toBeNull();
    expect(outcome.notificationSent).toBe(false);
  });
});
