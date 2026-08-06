// Send-once contract on handleCancellation via the atomic
// cancellation_notice_at/_state claim. The `cancelled` column is NOT the
// dedupe key — the status-sync trigger sets it during the cancel
// transition itself, before any route or post-commit hook runs
// (codex #3233 r1); crash-window claims are a reclaimable 'pending'
// lease, suppression and sent are terminal (r3).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockDbState = { updates: [], reminderRow: null, claimResult: 1 };
jest.mock('../models/db', () => {
  const chain = (table) => ({
    where: () => chain(table),
    whereNull: () => chain(table),
    whereIn: () => chain(table),
    whereNotNull: () => chain(table),
    whereRaw: () => chain(table),
    first: async () => (table === 'appointment_reminders' ? mockDbState.reminderRow : null),
    update: async (patch) => {
      mockDbState.updates.push({ table, patch });
      // The atomic claim is the update that sets state to 'pending'.
      if (patch.cancellation_notice_state === 'pending') return mockDbState.claimResult;
      return 1;
    },
  });
  const qb = (table) => chain(table);
  qb.raw = () => 'RAW';
  qb.fn = { now: () => new Date() };
  return qb;
});

const AppointmentReminders = require('../services/appointment-reminders');

beforeEach(() => {
  mockDbState.updates.length = 0;
  mockDbState.reminderRow = null;
  mockDbState.claimResult = 1;
});

describe('handleCancellation send-once (atomic notice claim)', () => {
  test('lost claim (marker already terminal) marks cancelled but does NOT re-send', async () => {
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

  test('sendNotification:false claims and finalizes as SUPPRESSED (durable decision)', async () => {
    mockDbState.reminderRow = { id: 'r2', customer_id: 'cu1', cancelled: false, appointment_time: '2026-08-05T13:00:00Z', service_type: 'X' };
    const record = await AppointmentReminders.handleCancellation('svc2', { sendNotification: false });
    expect(record).toBeTruthy();
    expect(mockDbState.updates.some((u) => u.patch.cancellation_notice_state === 'pending')).toBe(true);
    expect(mockDbState.updates.some((u) => u.patch.cancellation_notice_state === 'suppressed')).toBe(true);
  });

  test('failed attempt (customer lookup miss, no provider acceptance) RELEASES the claim', async () => {
    mockDbState.reminderRow = { id: 'r4', customer_id: 'cu-gone', cancelled: false, appointment_time: '2026-08-05T13:00:00Z', service_type: 'X' };
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc4', { outcome });
    const release = mockDbState.updates.find((u) => u.patch
      && u.patch.cancellation_notice_at === null && u.patch.cancellation_notice_state === null);
    expect(release).toBeTruthy();
    expect(outcome.notificationSent).toBe(false);
  });

  test('missing reminder row is a no-op with an explanatory outcome', async () => {
    const outcome = {};
    const record = await AppointmentReminders.handleCancellation('svc3', { outcome });
    expect(record).toBeNull();
    expect(outcome.notificationSent).toBe(false);
  });
});
