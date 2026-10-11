/**
 * Round 11: the booking confirmation is scoped to the property the visits are stamped with (the real sender passes the
 * visit id, and the property's own toggles and "send these to me too" recipients decide who it reaches), while the welcome
 * stays account-level. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Contact = require('../services/booking-contact-state');
const AppointmentReminders = require('../services/appointment-reminders');
const AppointmentEmail = require('../services/appointment-email');
const CustomerContact = require('../services/customer-contact');
const Welcome = require('../services/new-recurring-welcome-sms');

const CUSTOMER = { id: 'cust-1', phone: '+19415550134', email: 'holder@example.com' };
const account = { confirmationChannel: 'sms', appointmentConfirmation: true, smsEnabled: true, emailEnabled: true, raw: { acct: true } };
let propertyPrefs; let propertyRecipients;

beforeEach(() => {
  propertyPrefs = { ...account, raw: { acct: true } };
  propertyRecipients = [{ email: 'holder@example.com' }];
  jest.spyOn(AppointmentReminders, 'getReminderPrefs').mockImplementation(async (_id, opts = {}) => (opts.propertyId ? propertyPrefs : account));
  jest.spyOn(AppointmentEmail._private, 'loadCustomer').mockResolvedValue(CUSTOMER);
  jest.spyOn(AppointmentReminders, 'getCustomerAndTech').mockResolvedValue({ customer: CUSTOMER });
  jest.spyOn(Welcome, 'loadWelcomeCustomer').mockResolvedValue(CUSTOMER);
  jest.spyOn(AppointmentEmail._private, 'resolveRecipients').mockImplementation(async (_c, opts = {}) => (opts.propertyId ? propertyRecipients : [{ email: 'holder@example.com' }]));
  jest.spyOn(CustomerContact, 'getAppointmentContacts').mockImplementation((_c, raw) => (raw && raw.extra ? [{ phone: '+19415550134' }, { phone: '+19415550199' }] : [{ phone: '+19415550134' }]));
});
afterEach(() => jest.restoreAllMocks());

test('a property override changes the confirmation key and leaves the welcome key alone', async () => {
  const base = await Contact.bookingContactState('cust-1', { propertyId: 'prop-1' });
  propertyRecipients = [{ email: 'holder@example.com' }, { email: 'tenant@example.com' }];
  const moved = await Contact.bookingContactState('cust-1', { propertyId: 'prop-1' });
  expect(Contact.confirmationKey(moved)).not.toBe(Contact.confirmationKey(base));
  expect(Contact.welcomeKey(moved)).toBe(Contact.welcomeKey(base));
});

test('a property channel or toggle override changes the confirmation key; the account-level read is unchanged', async () => {
  const base = await Contact.bookingContactState('cust-1', { propertyId: 'prop-1' });
  propertyPrefs = { ...account, confirmationChannel: 'email', raw: { acct: true } };
  const moved = await Contact.bookingContactState('cust-1', { propertyId: 'prop-1' });
  expect(Contact.confirmationKey(moved)).not.toBe(Contact.confirmationKey(base));
  expect(moved.accountToggles).toEqual(base.accountToggles);
});

test('currentContactKey reads the property for a confirmation and the account for a welcome', async () => {
  const prefsSpy = AppointmentReminders.getReminderPrefs;
  const confirmation = await Contact.currentContactKey('cust-1', { propertyId: 'prop-1' });
  expect(prefsSpy).toHaveBeenCalledWith('cust-1', expect.objectContaining({ propertyId: 'prop-1' }));
  prefsSpy.mockClear();
  propertyRecipients = [{ email: 'tenant@example.com' }];
  expect(await Contact.currentContactKey('cust-1', { propertyId: 'prop-1' })).not.toBe(confirmation);
  prefsSpy.mockClear();
  const welcomeA = await Contact.currentContactKey('cust-1', { kind: 'welcome' });
  expect(prefsSpy).not.toHaveBeenCalledWith('cust-1', expect.objectContaining({ propertyId: expect.anything() }));
  propertyRecipients = [{ email: 'other@example.com' }];
  expect(await Contact.currentContactKey('cust-1', { kind: 'welcome' })).toBe(welcomeA);
});

test('an unreadable property read leaves the whole state unavailable (the card holds)', async () => {
  propertyPrefs = { unavailable: true };
  expect((await Contact.bookingContactState('cust-1', { propertyId: 'prop-1' })).unavailable).toBe(true);
  expect(await Contact.currentContactKey('cust-1', { propertyId: 'prop-1' })).toBeNull();
});

test('the senders\' own functions take the property id: getReminderPrefs, visitPrefsRow and resolveRecipients (source contract)', () => {
  const fs = require('fs');
  const reminders = fs.readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
  expect(reminders).toContain('async function getReminderPrefs(customerId, { scheduledServiceId = null, propertyId = null, conn = db } = {})');
  expect(reminders).toContain('prefsForProperty(prefs, customerId, propertyId, conn)');
  const email = fs.readFileSync(require.resolve('../services/appointment-email'), 'utf8');
  expect(email).toContain('async function resolveRecipients(customer, { scheduledServiceId = null, propertyId = null, conn = db } = {})');
  expect(email).toContain('Scoped.prefsForProperty(prefs, customerId, propertyId, conn)');
  const props = fs.readFileSync(require.resolve('../services/property-notification-prefs'), 'utf8');
  expect(props).toContain('async function resolvePropertyPrefs(');
});

// Round 13: each pin is built from the row ITS sender reads, through the sender's own exported loader.
describe('pins come from the senders\' own rows (round 13)', () => {
  // A secondary profile with a blank phone: the account primary's phone is backfilled by the email loader (appointment-email
  // loadCustomer), but the text sender and the welcome sender read the RAW row, which has no phone.
  const SECONDARY_RAW = { id: 'cust-2', phone: '', email: '', service_contacts_consent_at: null };
  const SECONDARY_BACKFILLED = { ...SECONDARY_RAW, phone: '+19415550177', email: 'primary@example.com' };

  test('a secondary profile with a blank phone shows no text, matching the sender (not the backfilled copy)', async () => {
    AppointmentReminders.getCustomerAndTech.mockResolvedValue({ customer: SECONDARY_RAW });
    Welcome.loadWelcomeCustomer.mockResolvedValue(SECONDARY_RAW);
    AppointmentEmail._private.loadCustomer.mockResolvedValue(SECONDARY_BACKFILLED);
    CustomerContact.getAppointmentContacts.mockRestore();
    const state = await Contact.bookingContactState('cust-2', { propertyId: null });
    expect(state.textTo).toEqual([]);
    expect(state.holder).toEqual({ phone: '', email: null });
    const lines = Contact.contactCardLines(state, { sendTexts: true, welcome: true });
    expect(lines[0]).toMatch(/^No confirmation message|by email/);
    expect(lines[0]).not.toMatch(/by text/);
    expect(lines[1]).toMatch(/^No welcome message/);
  });

  test('the loaders are the senders\' own exports, called with the given handle', async () => {
    const conn = jest.fn();
    await Contact.bookingContactState('cust-1', { propertyId: 'prop-1', conn });
    expect(AppointmentReminders.getCustomerAndTech).toHaveBeenCalledWith('cust-1', null, conn);
    expect(Welcome.loadWelcomeCustomer).toHaveBeenCalledWith('cust-1', conn);
    expect(AppointmentEmail._private.loadCustomer).toHaveBeenCalledWith('cust-1', conn);
    expect(AppointmentEmail._private.resolveRecipients).toHaveBeenCalledWith(CUSTOMER, expect.objectContaining({ conn }));
    expect(AppointmentReminders.getReminderPrefs).toHaveBeenCalledWith('cust-1', expect.objectContaining({ conn }));
  });

  test('the welcome sender reads its customer through loadWelcomeCustomer (source contract)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/new-recurring-welcome-sms'), 'utf8');
    expect(src).toContain('const customer = await loadWelcomeCustomer(row.customer_id);');
  });
});

describe('the senders\' reads use the handle they are given (round 13)', () => {
  test('getReminderPrefs, resolveChannelPrefsRow and loadCustomer touch only the given handle, never the pool', async () => {
    const db = require('../models/db');
    db.mockImplementation(() => { throw new Error('the global pool must not be used'); });
    const tables = [];
    const conn = (table) => {
      tables.push(table);
      const b = { where: () => b, select: () => b, first: async () => (table === 'customers' ? { id: 'cust-1', account_id: null, is_primary_profile: true, phone: '' } : null) };
      return b;
    };
    jest.restoreAllMocks();
    const prefs = await AppointmentReminders.getReminderPrefs('cust-1', { conn });
    expect(prefs.unavailable).toBe(false);
    const customer = await AppointmentEmail._private.loadCustomer('cust-1', conn);
    expect(customer).toMatchObject({ id: 'cust-1' });
    expect(tables).toEqual(expect.arrayContaining(['notification_prefs', 'customers']));
    expect(db).not.toHaveBeenCalled();
  });
});
