// #1995 A/D: a secondary-property appointment whose customers row has no
// email must reach the account primary's address instead of skipping as
// missing_email (the silent SMS-fallback bug the issue describes).

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');

// customers is read twice on a secondary row: the property row (where →
// select → first) then the account primary (where → whereNull → first).
function mockDb({ propertyRow, primaryRow, prefs = null }) {
  const customerReads = [];
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const qb = {
        where: (arg) => { customerReads.push(arg); return qb; },
        select: () => qb,
        whereNull: () => qb,
        first: async () => (customerReads.length === 1 ? propertyRow : primaryRow),
      };
      return qb;
    }
    if (table === 'notification_prefs') return { where: () => ({ first: async () => prefs }) };
    if (table === 'customer_interactions') return { insert: async () => [1] };
    if (table === 'appointment_reminders') return { where: () => ({ first: async () => null }) };
    if (table === 'scheduled_services') return { where: () => ({ first: async () => ({ scheduled_date: '2026-06-22', window_start: '10:00' }) }) };
    throw new Error(`unexpected db table ${table}`);
  });
  return customerReads;
}

beforeEach(() => jest.clearAllMocks());

const secondary = {
  id: 'prop-2', account_id: 'acct-1', is_primary_profile: false,
  first_name: 'Lana', last_name: 'Owner', email: '', phone: '+19415551234',
  address_line1: '77 Rental Way', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: 'Additional property',
};

test('secondary property with no email → account primary email, greeted by the primary name', async () => {
  const reads = mockDb({
    propertyRow: secondary,
    primaryRow: { id: 'prop-1', first_name: 'Lana', phone: '+19415551234', email: 'lana@example.com' },
  });
  const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
    customerId: 'prop-2', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
  });
  expect(res.ok).toBe(true);
  expect(reads).toEqual([{ id: 'prop-2' }, { account_id: 'acct-1', is_primary_profile: true }]);
  expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
  expect(EmailTemplates.sendTemplate.mock.calls[0][0].to).toBe('lana@example.com');
});

test('secondary property WITH its own email keeps it (primary never overrides)', async () => {
  const reads = mockDb({
    propertyRow: { ...secondary, email: 'tenant@example.com' },
    primaryRow: { id: 'prop-1', first_name: 'Lana', phone: '+19415551234', email: 'lana@example.com' },
  });
  const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
    customerId: 'prop-2', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
  });
  expect(res.ok).toBe(true);
  expect(EmailTemplates.sendTemplate.mock.calls[0][0].to).toBe('tenant@example.com');
  expect(reads).toHaveLength(2);
});

test('secondary property whose account primary ALSO has no email still skips as missing_email', async () => {
  mockDb({ propertyRow: secondary, primaryRow: { id: 'prop-1', first_name: 'Lana', phone: '+19415551234', email: null } });
  const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
    customerId: 'prop-2', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
  });
  expect(res).toMatchObject({ ok: false, skipped: true, reason: 'missing_email' });
  expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
});
