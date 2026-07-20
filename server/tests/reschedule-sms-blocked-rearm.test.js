/**
 * Reschedule-reply confirmation — covered-window re-arm on a blocked send.
 *
 * handleRescheduleReply covers the due 24h/72h reminder windows
 * (handleReschedule coverDueWindows / the rain-out route's earlier sync)
 * BEFORE the confirmation SMS goes out. sendAppointmentSms throws on a
 * blocked number, so the customer got neither the confirmation nor any
 * later reminder of the new time. The send is now wrapped: any no-send
 * outcome re-arms the windows (mirrors reschedule-public.js — "silence is
 * worse") and the original error still propagates. The 72h window only
 * re-arms while the cron can still deliver it
 * (AppointmentReminders.reminder72hStillReachable — more than 24.25h out);
 * inside that boundary only the 24h window re-arms, since a cleared 72h flag
 * there can never fire and would just re-enter every 15-minute scan.
 *
 * The pre-send snapshot read is BEST-EFFORT: it only guards the re-arm, so a
 * transient failure on that read must never abort the confirmation send (the
 * visit has already moved). Snapshot-read failure + blocked send degrades to
 * the unguarded re-arm, scoped by the static predicates only — same
 * "silence is worse" call.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../utils/datetime-et', () => ({
  // Real parser — the blocked-send fallback re-arm judges the 72h band from
  // the confirmed slot's parsed time, so the value must be a genuine ET Date.
  parseETDateTime: jest.requireActual('../utils/datetime-et').parseETDateTime,
  etDateString: jest.fn((d) => (d ? '2026-07-05' : '2026-07-04')),
  etParts: jest.fn(() => ({ hour: 13, minute: 30 })),
  addETDays: jest.fn(() => new Date('2026-07-05T12:00:00Z')),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
  // Band predicate consulted by the blocked-send re-arm. Default: still
  // reachable (both windows re-arm); the same/next-day test flips it. The
  // real boundary math is pinned by admin-dispatch-rearm-reminders.test.js,
  // which runs the unmocked helper.
  reminder72hStillReachable: jest.fn(() => true),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');
const RescheduleSMS = require('../services/reschedule-sms');

db.fn = { now: jest.fn(() => 'NOW()') };

function chain({ rows = [], ...terminal } = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    ...terminal,
  };
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

const OPTION1 = { date: '2026-07-04', window: { start: '13:00', end: '14:00', display: '1:00 PM - 3:00 PM' } };
const OPTION2 = { date: '2026-07-06', window: { start: '08:00', end: '09:00', display: '8:00 AM - 10:00 AM' } };

// The reminder-row snapshot captured before the confirmation SMS — the re-arm
// is guarded on exactly these, so a newer reschedule that re-stamps the row
// during the send is not clobbered.
const APPT = new Date('2026-07-04T17:00:00Z');
const UPD = new Date('2026-07-04T16:59:00Z');
const guardRow = () => ({ id: 'rem-1', appointment_time: APPT, updated_at: UPD });

function pendingRow() {
  return {
    id: 'log-1',
    scheduled_service_id: 'svc-1',
    reason_code: 'weather_rain',
    sms_sent_at: '2026-07-04T17:00:00Z',
    notes: JSON.stringify({ option1: OPTION1, option2: OPTION2 }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('a blocked confirmation re-arms both reminder windows (guarded on the snapshot) and still propagates the error', async () => {
  // Confirm-in-place path: the visit already sits on option 1's slot, so the
  // windows were covered by the rain-out route's earlier sync — the failed
  // confirmation is the only remaining customer notice. The snapshot is read
  // before the send; the re-arm is scoped by its id + appointment_time +
  // updated_at.
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const snapshotChain = chain({ first: jest.fn().mockResolvedValue(guardRow()) });
  const rearmChain = chain();
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    appointment_reminders: [snapshotChain, rearmChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);

  // Guarded on the pre-send snapshot: row id + the exact appointment_time and
  // updated_at captured, so a newer reschedule during the send is not stomped.
  expect(rearmChain.where).toHaveBeenCalledWith({ id: 'rem-1' });
  expect(rearmChain.where).toHaveBeenCalledWith('appointment_time', APPT);
  expect(rearmChain.where).toHaveBeenCalledWith('updated_at', UPD);
  expect(rearmChain.update).toHaveBeenCalledWith(expect.objectContaining({
    reminder_72h_sent: false,
    reminder_72h_sent_at: null,
    reminder_24h_sent: false,
    reminder_24h_sent_at: null,
  }));
  // The 72h band was judged against the ROW'S own time — the same value the
  // appointment_time predicate pins the update to.
  expect(AppointmentReminders.reminder72hStillReachable).toHaveBeenCalledWith(APPT);
});

test('a blocked confirmation for a same/next-day slot re-arms ONLY the 24h window', async () => {
  // Inside 24.25h the cron's 72h branch can never fire: clearing that flag
  // would leave a dead armed window re-selected by every 15-minute scan
  // forever. The covered flag stays; the re-armed 24h window carries the
  // fallback notice for the new time.
  AppointmentReminders.reminder72hStillReachable.mockReturnValueOnce(false);
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const snapshotChain = chain({ first: jest.fn().mockResolvedValue(guardRow()) });
  const rearmChain = chain();
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    appointment_reminders: [snapshotChain, rearmChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);

  const payload = rearmChain.update.mock.calls[0][0];
  expect(payload).toMatchObject({ reminder_24h_sent: false, reminder_24h_sent_at: null });
  expect(payload).not.toHaveProperty('reminder_72h_sent');
  expect(payload).not.toHaveProperty('reminder_72h_sent_at');
});

test('a successful confirmation reads the snapshot but never re-arms the covered windows', async () => {
  const snapshotChain = chain({ first: jest.fn().mockResolvedValue(guardRow()) });
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
      chain(), // new_date/new_window update
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    // Only the pre-send snapshot read — a re-arm UPDATE would throw here.
    appointment_reminders: [snapshotChain],
  });

  const result = await RescheduleSMS.handleRescheduleReply('cust-1', '1');
  expect(result).toMatchObject({ handled: true, action: 'rescheduled' });
  expect(snapshotChain.update).not.toHaveBeenCalled();
});

test('the blocked-confirmation re-arm skips sibling-suppressed and cancelled rows', async () => {
  // Same carve-out as the dispatch re-arm: clearing the sent flags on a
  // sibling-suppressed row would return it to the cron's send set alongside
  // the slot's owner (two texts for one window).
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const snapshotChain = chain({ first: jest.fn().mockResolvedValue(guardRow()) });
  const rearmChain = chain();
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    appointment_reminders: [snapshotChain, rearmChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);

  expect(rearmChain.where).toHaveBeenCalledWith('suppressed_by_sibling', false);
  expect(rearmChain.where).toHaveBeenCalledWith('cancelled', false);
});

test('a failed reminder-guard snapshot read never suppresses the confirmation SMS (best-effort guard)', async () => {
  // The snapshot only GUARDS the no-send re-arm. The visit has already moved
  // when the reply lands, so a transient DB failure on the snapshot read must
  // not abort before sendAppointmentSms — that would silence the one customer
  // notice this path exists to deliver. Read fails → log, null snapshot,
  // continue to the send.
  const snapshotChain = chain({ first: jest.fn().mockRejectedValue(new Error('connection reset')) });
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
      chain(), // new_date/new_window update
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    // Only the (failing) snapshot read — the success path must not re-arm.
    appointment_reminders: [snapshotChain],
  });

  const result = await RescheduleSMS.handleRescheduleReply('cust-1', '1');

  expect(result).toMatchObject({ handled: true, action: 'rescheduled', smsSent: true });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reminder-guard snapshot read failed'));
});

test('a blocked confirmation after a failed snapshot read re-arms UNGUARDED, scoped by the static predicates only', async () => {
  // No snapshot to guard on (the read failed, distinct from the row-missing
  // case below). Skipping the re-arm would risk total silence about the new
  // time; the file's own precedent ("silence is worse") prefers the re-arm
  // and accepts the narrow double-text window. Scope falls back to the
  // service id + the carve-outs that don't depend on the snapshot.
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const snapshotChain = chain({ first: jest.fn().mockRejectedValue(new Error('connection reset')) });
  const rearmChain = chain();
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    appointment_reminders: [snapshotChain, rearmChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);

  // Static scope: the service id + the sibling-suppressed/cancelled
  // carve-outs…
  expect(rearmChain.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  expect(rearmChain.where).toHaveBeenCalledWith('suppressed_by_sibling', false);
  expect(rearmChain.where).toHaveBeenCalledWith('cancelled', false);
  // …and NO snapshot fields — there was no snapshot to guard on.
  expect(rearmChain.where).not.toHaveBeenCalledWith('appointment_time', expect.anything());
  expect(rearmChain.where).not.toHaveBeenCalledWith('updated_at', expect.anything());
  expect(rearmChain.update).toHaveBeenCalledWith(expect.objectContaining({
    reminder_72h_sent: false,
    reminder_72h_sent_at: null,
    reminder_24h_sent: false,
    reminder_24h_sent_at: null,
  }));
  // With no snapshot, the 72h band is judged from the slot this reply just
  // confirmed — the same date+start string the handleReschedule sync used.
  expect(AppointmentReminders.reminder72hStillReachable).toHaveBeenCalledWith(
    jest.requireActual('../utils/datetime-et').parseETDateTime('2026-07-04T13:00'),
  );
});

test('when the reminder row vanished before the send (no snapshot), the blocked path re-arms nothing and still throws', async () => {
  // The pre-send snapshot read returns no row (reminder deleted / never
  // existed). With nothing to guard, the re-arm is skipped entirely — the
  // original blocked-send error still propagates.
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const snapshotChain = chain({ first: jest.fn().mockResolvedValue(undefined) });
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    // Only the snapshot read; no re-arm UPDATE queue — one would throw.
    appointment_reminders: [snapshotChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);
  expect(snapshotChain.update).not.toHaveBeenCalled();
});
