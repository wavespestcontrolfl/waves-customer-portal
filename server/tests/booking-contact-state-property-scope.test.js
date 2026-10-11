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

const CUSTOMER = { id: 'cust-1', phone: '+19415550134', email: 'holder@example.com' };
const account = { confirmationChannel: 'sms', appointmentConfirmation: true, smsEnabled: true, emailEnabled: true, raw: { acct: true } };
let propertyPrefs; let propertyRecipients;

beforeEach(() => {
  propertyPrefs = { ...account, raw: { acct: true } };
  propertyRecipients = [{ email: 'holder@example.com' }];
  jest.spyOn(AppointmentReminders, 'getReminderPrefs').mockImplementation(async (_id, opts = {}) => (opts.propertyId ? propertyPrefs : account));
  jest.spyOn(AppointmentEmail._private, 'loadCustomer').mockResolvedValue(CUSTOMER);
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
  expect(prefsSpy).toHaveBeenCalledWith('cust-1', { propertyId: 'prop-1' });
  prefsSpy.mockClear();
  propertyRecipients = [{ email: 'tenant@example.com' }];
  expect(await Contact.currentContactKey('cust-1', { propertyId: 'prop-1' })).not.toBe(confirmation);
  prefsSpy.mockClear();
  const welcomeA = await Contact.currentContactKey('cust-1', { kind: 'welcome' });
  expect(prefsSpy).not.toHaveBeenCalledWith('cust-1', { propertyId: expect.anything() });
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
  expect(reminders).toContain('async function getReminderPrefs(customerId, { scheduledServiceId = null, propertyId = null } = {})');
  expect(reminders).toContain('prefsForProperty(prefs, customerId, propertyId)');
  const email = fs.readFileSync(require.resolve('../services/appointment-email'), 'utf8');
  expect(email).toContain('async function resolveRecipients(customer, { scheduledServiceId = null, propertyId = null } = {})');
  expect(email).toContain('Scoped.prefsForProperty(prefs, customerId, propertyId)');
  const props = fs.readFileSync(require.resolve('../services/property-notification-prefs'), 'utf8');
  expect(props).toContain('async function resolvePropertyPrefs(');
});
