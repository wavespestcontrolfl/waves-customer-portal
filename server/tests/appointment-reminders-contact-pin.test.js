/**
 * Round 10: a visit booked from a start_program card carries the recipient key the card pinned
 * (activity_log, written in the booking transaction). sendConfirmation, which the deferred send AND the stranded
 * confirmation sweep both call, re-checks it against the live customer, so a failed post-commit suppression write
 * cannot let the sweep send to recipients the card did not show.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldReminderLine: jest.fn(async () => '') }));

const db = require('../models/db');
const Contact = require('../services/booking-contact-state');
const AppointmentReminders = require('../services/appointment-reminders');

let pinRow; let reminder; let touched; let inserts; let updates; let failCloseWrites;

function builder(table) {
  touched.push(table);
  const q = {
    where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNull: jest.fn(() => q), whereNotNull: jest.fn(() => q),
    whereIn: jest.fn(() => q), select: jest.fn(() => q), orderBy: jest.fn(() => q), limit: jest.fn(() => q),
    first: jest.fn(async () => {
      if (table === 'activity_log') return pinRow;
      if (table === 'appointment_reminders') return reminder;
      return null;
    }),
    insert: jest.fn(async (row) => {
      if (failCloseWrites) throw new Error('transient write failure');
      inserts.push({ table, row });
      return [1];
    }),
    update: jest.fn(async (patch) => {
      if (failCloseWrites) throw new Error('transient write failure');
      updates.push({ table, patch });
      return 1;
    }),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  touched = []; inserts = []; updates = []; failCloseWrites = false;
  reminder = {
    id: 'rem-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', cancelled: false, confirmation_sent: false,
    windows_preclosed: false, appointment_time: new Date(Date.now() + 5 * 86400000).toISOString(), service_type: 'Lawn Care',
  };
  pinRow = { metadata: { scheduled_service_id: 'visit-1', contact_key: 'key-a' } };
  db.mockImplementation(builder);
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
});
afterEach(() => jest.restoreAllMocks());

const deliveryStarted = () => touched.some((t) => !['appointment_reminders', 'activity_log'].includes(t));

describe('sendConfirmation re-checks the card recipient key (round 10)', () => {
  test('a mismatched key skips the send, audits, and closes the row', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-b');
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    expect(deliveryStarted()).toBe(false);
    expect(inserts).toEqual([expect.objectContaining({ table: 'activity_log', row: expect.objectContaining({ customer_id: 'cust-1', action: 'confirmation_suppressed_contact_drift' }) })]);
    expect(updates).toEqual([expect.objectContaining({ table: 'appointment_reminders', patch: expect.objectContaining({ confirmation_sent: true }) })]);
  });

  test('the close and audit writes failing still sends nothing, and the next run skips again', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-b');
    failCloseWrites = true;
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    expect(deliveryStarted()).toBe(false);
    expect(inserts).toEqual([]);
  });

  test('an unreadable recipient state sends nothing and leaves the row unsent for the next run', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue(null);
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    expect(deliveryStarted()).toBe(false);
    expect(updates).toEqual([]);
  });

  test('a matching key goes on to the normal send', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(deliveryStarted()).toBe(true);
    expect(inserts).toEqual([]);
  });

  test('a visit with no pin sends as before and reads no recipient state', async () => {
    pinRow = undefined;
    const spy = jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-b');
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(spy).not.toHaveBeenCalled();
    expect(deliveryStarted()).toBe(true);
  });

  test('the sweep reaches it: a stranded row the sweep filter selects is held by the pin', async () => {
    const selected = (row) => Object.entries(AppointmentReminders.STRANDED_CONFIRMATION_FILTER).every(([k, v]) => row[k] === v);
    expect(selected(reminder)).toBe(true);
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-b');
    await AppointmentReminders.sendConfirmation(reminder.scheduled_service_id);
    expect(deliveryStarted()).toBe(false);
    const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
    expect(src).toContain('await AppointmentReminders.sendConfirmation(r.scheduled_service_id)');
  });
});
