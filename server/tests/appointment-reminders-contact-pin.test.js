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

let pinRow; let reminder; let touched; let inserts; let updates; let failCloseWrites; let customerRow;

function builder(table) {
  touched.push(table);
  const q = {
    where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNull: jest.fn(() => q), whereNotNull: jest.fn(() => q),
    whereIn: jest.fn(() => q), select: jest.fn(() => q), orderBy: jest.fn(() => q), limit: jest.fn(() => q),
    first: jest.fn(async () => {
      if (table === 'activity_log') return pinRow;
      if (table === 'appointment_reminders') return reminder;
      if (table === 'customers' && customerRow) return customerRow;
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
  touched = []; inserts = []; updates = []; failCloseWrites = false; customerRow = null;
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

  test('the send-time check compares the PROPERTY-scoped confirmation key the pin stored (round 11)', async () => {
    pinRow = { metadata: { scheduled_service_id: 'visit-1', contact_key: 'key-a', property_id: 'prop-2' } };
    const spy = jest.spyOn(Contact, 'currentContactKey').mockImplementation(async (_id, opts = {}) => (opts.propertyId === 'prop-2' ? 'key-a' : 'key-account'));
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(spy).toHaveBeenCalledWith('cust-1', { propertyId: 'prop-2' });
    expect(deliveryStarted()).toBe(true);
    // The property's own override moved: the account-level key would still match, the property-scoped one does not.
    touched = []; inserts = [];
    spy.mockImplementation(async (_id, opts = {}) => (opts.propertyId === 'prop-2' ? 'key-moved' : 'key-a'));
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    expect(deliveryStarted()).toBe(false);
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

// Round 18: the card check in sendConfirmation reads one snapshot and deliverConfirmation loads its own prefs and customer
// row afterwards. The pinned key is checked again, against the rows deliverConfirmation loaded, right before the send.
describe('the send-time check runs on the rows the send loaded (round 18)', () => {
  beforeEach(() => {
    customerRow = { id: 'cust-1', first_name: 'Dana', last_name: 'Example', phone: '9415550134', email: 'dana@example.com' };
  });

  test('a phone change between the card check and the send: nothing is sent, the row is closed and audited as recipient_changed', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
    const loaded = jest.spyOn(Contact, 'confirmationKeyFromLoaded').mockResolvedValue('key-after-phone-change');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    // It was compared against the very rows the send loaded: the customer row and the prefs this call read.
    expect(loaded).toHaveBeenCalledWith('cust-1', expect.objectContaining({ textCustomer: customerRow, prefs: expect.objectContaining({ raw: expect.any(Object) }), propertyId: null }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(inserts).toEqual([expect.objectContaining({ table: 'activity_log', row: expect.objectContaining({
      action: 'confirmation_suppressed_contact_drift', description: expect.stringContaining('recipient_changed'),
      metadata: expect.stringContaining('"reason":"recipient_changed"'),
    }) })]);
    expect(updates).toEqual([expect.objectContaining({ table: 'appointment_reminders', patch: expect.objectContaining({ confirmation_sent: true }) })]);
  });

  test('an unreadable state at the send holds the row unsent; a matching key goes on without an audit', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
    const loaded = jest.spyOn(Contact, 'confirmationKeyFromLoaded').mockResolvedValue(null);
    expect(await AppointmentReminders.sendConfirmation('visit-1')).toBe(false);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    loaded.mockResolvedValue('key-a');
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(loaded).toHaveBeenCalledTimes(2);
    expect(inserts.filter((i) => i.row.action === 'confirmation_suppressed_contact_drift')).toEqual([]);
  });

  test('the property id the pin stored scopes the loaded-rows check, and an unpinned visit never runs it', async () => {
    pinRow = { metadata: { scheduled_service_id: 'visit-1', contact_key: 'key-a', property_id: 'prop-2' } };
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
    const loaded = jest.spyOn(Contact, 'confirmationKeyFromLoaded').mockResolvedValue('key-a');
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(loaded).toHaveBeenCalledWith('cust-1', expect.objectContaining({ propertyId: 'prop-2' }));
    loaded.mockClear();
    pinRow = undefined;
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(loaded).not.toHaveBeenCalled();
  });

  test('the email leg is limited to the address set that was checked, and an address added after the check is audited, not sent (round 20)', async () => {
    jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
    jest.spyOn(Contact, 'confirmationKeyFromLoaded').mockImplementation(async (_id, opts) => { opts.out.emailTo = ['pinned@example.com']; return 'key-a'; });
    const Email = require('../services/appointment-email');
    const send = jest.spyOn(Email, 'sendAppointmentConfirmationEmail').mockResolvedValue({ ok: true });
    await AppointmentReminders.sendConfirmation('visit-1');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ recipientFilter: ['pinned@example.com'], onRecipientsDropped: expect.any(Function) }));
    // The email sender reports an address it resolved that is outside the checked set.
    await send.mock.calls[0][0].onRecipientsDropped(['added-later@example.com']);
    expect(inserts).toEqual([expect.objectContaining({ table: 'activity_log', row: expect.objectContaining({
      action: 'confirmation_email_recipient_skipped', metadata: expect.stringContaining('"reason":"recipient_changed"'),
    }) })]);
    expect(JSON.stringify(inserts)).not.toContain('added-later@example.com');
  });

  test('the key from loaded rows hashes the same recipients as the card key', async () => {
    const AppointmentEmail = require('../services/appointment-email')._private;
    const Customer = require('../services/customer-contact');
    jest.spyOn(AppointmentEmail, 'loadCustomer').mockResolvedValue({ id: 'cust-1' });
    jest.spyOn(AppointmentEmail, 'resolveRecipients').mockResolvedValue([{ email: 'Dana@Example.com' }]);
    jest.spyOn(Customer, 'getAppointmentContacts').mockReturnValue([{ phone: '(941) 555-0134' }]);
    const prefs = { unavailable: false, raw: {}, confirmationChannel: 'sms', appointmentConfirmation: true, smsEnabled: true, emailEnabled: true };
    const key = await Contact.confirmationKeyFromLoaded('cust-1', { prefs, textCustomer: customerRow });
    expect(key).toBe(Contact.confirmationKey({ textTo: ['9415550134'], emailTo: ['dana@example.com'], toggles: { channel: 'sms', confirmation: true, sms: true, email: true } }));
    // A changed phone changes the key; unreadable prefs or a missing customer give null.
    Customer.getAppointmentContacts.mockReturnValue([{ phone: '9415550199' }]);
    expect(await Contact.confirmationKeyFromLoaded('cust-1', { prefs, textCustomer: customerRow })).not.toBe(key);
    expect(await Contact.confirmationKeyFromLoaded('cust-1', { prefs: { ...prefs, unavailable: true }, textCustomer: customerRow })).toBeNull();
    expect(await Contact.confirmationKeyFromLoaded('cust-1', { prefs, textCustomer: null })).toBeNull();
  });
});
