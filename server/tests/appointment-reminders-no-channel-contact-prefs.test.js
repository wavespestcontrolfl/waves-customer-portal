'use strict';

// alertNoReachableChannel's false-positive guard (hasTextReachableApptRecipient):
// a delivered text in the last 60 days proves a recipient text-reachable only
// while that recipient can still be texted. A contact who switched their own
// texts off (contact login, GATE_CONTACT_LOGIN) no longer counts, so the
// office alert fires instead of being suppressed by last month's delivery
// (codex #6363 r3 P2).

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/recipient-optin', () => ({ filterRecipientsByOptin: jest.fn(async (contacts) => contacts) }));
jest.mock('../services/contact-notification-prefs', () => ({ filterContactsByOwnPrefs: jest.fn(async (contacts) => contacts) }));

const db = require('../models/db');
const { notifyAdmin } = require('../services/notification-service');
const { filterContactsByOwnPrefs } = require('../services/contact-notification-prefs');
const AppointmentReminders = require('../services/appointment-reminders');

const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', last_name: 'Owner', phone: '+19415550101', email: null,
  service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contacts_consent_at: '2026-07-23T00:00:00Z',
};

function wire() {
  db.mockImplementation((table) => {
    const q = {};
    for (const m of ['where', 'whereRaw', 'whereNull', 'orderBy', 'select']) q[m] = () => q;
    q.first = async () => {
      if (table === 'customers') return CUSTOMER;
      if (table === 'notification_prefs') return { customer_id: 'cust-1', sms_enabled: true, appointment_notify_primary: false };
      if (table === 'sms_log') return { id: 'sms-1' };
      return null;
    };
    q.insert = async () => [1];
    return q;
  });
  db.raw = (sql) => sql;
}

beforeEach(() => { jest.clearAllMocks(); wire(); });

test('a recent delivery to the contact suppresses the alert while they still take texts', async () => {
  await AppointmentReminders.alertNoReachableChannel({ customerId: 'cust-1', kind: '24h' });
  expect(filterContactsByOwnPrefs).toHaveBeenCalledWith(
    [expect.objectContaining({ phone: '+19415550202' })], 'cust-1', null, { channel: 'sms' },
  );
  expect(notifyAdmin).not.toHaveBeenCalled();
});

test('the same delivery proves nothing once the contact switched their texts off: the alert fires', async () => {
  filterContactsByOwnPrefs.mockResolvedValueOnce([]);
  await AppointmentReminders.alertNoReachableChannel({ customerId: 'cust-1', kind: '24h' });
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  expect(notifyAdmin.mock.calls[0][1]).toMatch(/undeliverable/i);
});
