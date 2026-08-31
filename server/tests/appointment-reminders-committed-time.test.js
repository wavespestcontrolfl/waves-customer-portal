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
    first: jest.fn(async () => { if (throws) throw new Error(throws); return row; }),
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
      .resolves.toBe('2026-09-15T11:00');
  });

  test('the row wins over a caller value that disagrees', async () => {
    rowReader({ scheduled_date: '2026-09-15', window_start: '11:00:00' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-14', windowStart: '08:00' }))
      .resolves.toBe('2026-09-15T11:00');
  });

  test('a pg Date-typed scheduled_date resolves to its calendar day', async () => {
    rowReader({ scheduled_date: new Date('2026-09-15T00:00:00.000Z'), window_start: '09:30:00' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, {}))
      .resolves.toBe('2026-09-15T09:30');
  });

  test('a windowless committed row keeps the 08:00 convention (UPDATE trigger re-arms it later)', async () => {
    rowReader({ scheduled_date: '2026-09-15', window_start: null });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: null }))
      .resolves.toBe('2026-09-15T08:00');
  });

  test('a windowless committed row overrides a stale non-null caller window (08:00 convention)', async () => {
    rowReader({ scheduled_date: '2026-09-15', window_start: null });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: '13:00' }))
      .resolves.toBe('2026-09-15T08:00');
  });

  test('row not visible (not committed yet) → the caller values stand', async () => {
    rowReader(undefined);
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: '10:00' }))
      .resolves.toBe('2026-09-15T10:00');
  });

  test('read-back failure never blocks registration — caller values stand', async () => {
    rowReader(null, { throws: 'connection reset' });
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, { date: '2026-09-15', windowStart: '10:00' }))
      .resolves.toBe('2026-09-15T10:00');
  });

  test('no date from anywhere → null (nothing to register)', async () => {
    rowReader(undefined);
    await expect(AppointmentReminders.resolveCommittedVisitTime(901, {})).resolves.toBeNull();
  });
});

describe('admin-schedule registers spawned and created visits from the committed row', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

  test('registerSpawnedVisitReminder resolves its time through the committed row, never a raw 08:00 default', () => {
    const start = src.indexOf('async function registerSpawnedVisitReminder(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('resolveCommittedVisitTime(');
    expect(body).not.toMatch(/T\$\{normalizeHHMM\(windowStart\) \|\| '08:00'\}/);
  });

  test('the POST create path resolves each created appointment through the committed row', () => {
    const at = src.indexOf("serviceType, 'admin_manual',\n            { sendConfirmation: !!appt.confirmation, deferConfirmation: true }");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at - 600, at)).toContain('resolveCommittedVisitTime(');
  });
});
