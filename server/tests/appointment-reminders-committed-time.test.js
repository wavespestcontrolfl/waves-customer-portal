jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ renderTemplate: jest.fn(), getTemplate: jest.fn() }));
jest.mock('../services/estimate-card-holds', () => ({}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');

function rowReader(row, { throws } = {}) {
  const builder = {
    where: jest.fn().mockReturnThis(),
    forShare: jest.fn().mockReturnThis(),
    first: jest.fn(async () => { if (throws) throw new Error(throws); return row; }),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(async () => [{ id: 'rem-1' }]),
    update: jest.fn(async () => 1),
    pluck: jest.fn(async () => []),
    select: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereExists: jest.fn().mockReturnThis(),
    whereNotExists: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
  };
  db.mockImplementation(() => builder);
  return builder;
}

describe('resolveCommittedVisitTime — the committed row is the truth for a reminder time', () => {
  beforeEach(() => jest.clearAllMocks());

  test("the caller's in-memory copy has no window but the row landed with 11:00 → 11:00", async () => {
    // The 08-30 drift shape: series children inserted with the parent's
    // window while the spawn object never carried it; the reminder was
    // registered at the 08:00 default and the UPDATE-only sync trigger
    // never corrected it.
    rowReader({ scheduled_date: '2026-09-15', window_start: '11:00:00' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: null }))
      .resolves.toEqual({ appointmentTime: '2026-09-15T11:00', windowless: false });
  });

  test('the row wins over a caller value that disagrees', async () => {
    rowReader({ scheduled_date: '2026-09-15', window_start: '11:00:00' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-14', windowStart: '08:00' }))
      .resolves.toEqual({ appointmentTime: '2026-09-15T11:00', windowless: false });
  });

  test('a pg Date-typed scheduled_date resolves to its calendar day', async () => {
    rowReader({ scheduled_date: new Date('2026-09-15T00:00:00.000Z'), window_start: '09:30:00' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, {}))
      .resolves.toEqual({ appointmentTime: '2026-09-15T09:30', windowless: false });
  });

  test('a windowless committed row keeps the 08:00 convention (UPDATE trigger re-arms it later)', async () => {
    rowReader({ scheduled_date: '2026-09-15', window_start: null });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: null }))
      .resolves.toEqual({ appointmentTime: '2026-09-15T08:00', windowless: true });
  });

  test('a windowless committed row overrides a stale non-null caller window (08:00 convention)', async () => {
    rowReader({ scheduled_date: '2026-09-15', window_start: null });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: '13:00' }))
      .resolves.toEqual({ appointmentTime: '2026-09-15T08:00', windowless: true });
  });

  test('row not visible (not committed yet) → the caller values stand', async () => {
    rowReader(undefined);
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: '10:00' }))
      .resolves.toEqual({ appointmentTime: '2026-09-15T10:00', windowless: false });
  });

  test('read-back failure never blocks registration — caller values stand', async () => {
    rowReader(null, { throws: 'connection reset' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: '10:00' }))
      .resolves.toEqual({ appointmentTime: '2026-09-15T10:00', windowless: false });
  });

  test('lock: true share-locks the visit row for the caller\'s transaction', async () => {
    const b = rowReader({ scheduled_date: '2026-09-15', window_start: '11:00:00' });
    await AppointmentReminders.resolveCommittedVisitTime(901, {}, db, { lock: true });
    expect(b.forShare).toHaveBeenCalledTimes(1);
    const unlocked = rowReader({ scheduled_date: '2026-09-15', window_start: '11:00:00' });
    await AppointmentReminders.resolveCommittedVisitTime(901, {});
    expect(unlocked.forShare).not.toHaveBeenCalled();
  });

  test('no date from anywhere → null (nothing to register)', async () => {
    rowReader(undefined);
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, {})).resolves.toBeNull();
  });
});

describe('registerAppointment({ fromCommittedRow: true }) resolves inside its own transaction', () => {
  const { parseETDateTime } = require('../utils/datetime-et');
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    db.raw = jest.fn().mockResolvedValue();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('reads the visit under a share lock in the registration trx and keys the slot lock on the RESOLVED time', async () => {
    const b = rowReader(null); // every lookup (label, dedup) → no row; insert → rem-1
    const spy = jest.spyOn(AppointmentReminders, 'resolveCommittedVisitTime')
      .mockResolvedValue({ appointmentTime: '2099-09-15T11:00', windowless: false });

    await AppointmentReminders.registerAppointment(
      901, 5, '2099-09-15T08:00', 'Quarterly Pest Control', 'recurring_auto_extend',
      { sendConfirmation: false, closeReminderWindows: true, fromCommittedRow: true },
    );

    expect(spy).toHaveBeenCalledWith(901, { date: '2099-09-15', windowStart: '08:00' }, db, { lock: true });
    const lockCall = db.raw.mock.calls.find(([sql]) => String(sql).includes('pg_advisory_xact_lock'));
    expect(lockCall[1][0]).toBe(`appointment-reminder:5:${parseETDateTime('2099-09-15T11:00').toISOString()}`);
    // Resolved as windowed → an ARMED insert, not the pre-closed placeholder
    // the caller's fallback (closeReminderWindows: true) would have made.
    const insertArg = b.insert.mock.calls.at(-1)[0];
    expect(insertArg.reminder_72h_sent).not.toBe(true);
  });

  test('a windowless committed row flips the caller\'s armed request into a pre-closed placeholder', async () => {
    const b = rowReader(null);
    jest.spyOn(AppointmentReminders, 'resolveCommittedVisitTime')
      .mockResolvedValue({ appointmentTime: '2099-09-15T08:00', windowless: true });

    await AppointmentReminders.registerAppointment(
      902, 5, '2099-09-15T13:00', 'Quarterly Pest Control', 'recurring_auto_extend',
      { sendConfirmation: false, closeReminderWindows: false, fromCommittedRow: true },
    );

    const insertArg = b.insert.mock.calls.at(-1)[0];
    expect(insertArg.reminder_72h_sent).toBe(true);
    expect(insertArg.reminder_24h_sent).toBe(true);
    expect(insertArg.confirmation_sent).toBe(true);
  });

  test('without fromCommittedRow nothing is read back (existing callers unchanged)', async () => {
    rowReader(null);
    const spy = jest.spyOn(AppointmentReminders, 'resolveCommittedVisitTime');
    await AppointmentReminders.registerAppointment(
      903, 5, '2099-09-15T13:00', 'Quarterly Pest Control', 'booking_new', { sendConfirmation: false },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('admin-schedule registers spawned and created visits from the committed row', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

  test('registerSpawnedVisitReminder opts into fromCommittedRow with a windowless-safe fallback', () => {
    const start = src.indexOf('async function registerSpawnedVisitReminder(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('fromCommittedRow: true');
    expect(body).toContain('closeReminderWindows: !start');
  });

  test('the POST create path opts each created appointment into fromCommittedRow', () => {
    const at = src.indexOf("serviceType, 'admin_manual',\n            { sendConfirmation: !!appt.confirmation, deferConfirmation: true, closeReminderWindows: !windowStart, fromCommittedRow: true }");
    expect(at).toBeGreaterThan(0);
  });
});
