jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');

function mockDb({ customer = null, prefs = null }) {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: () => ({ select: () => ({ first: async () => customer }) }) };
    }
    if (table === 'notification_prefs') {
      return { where: () => ({ first: async () => prefs }) };
    }
    if (table === 'customer_interactions') {
      return { insert: async () => [1] };
    }
    throw new Error(`unexpected db table ${table}`);
  });
}

beforeEach(() => jest.clearAllMocks());

describe('appointment email recipient resolution (fan-out to appointment contacts)', () => {
  test('routes to the service-contact email when the primary is not an appointment recipient', async () => {
    mockDb({
      customer: {
        id: 'c1', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: 'sue@service.com',
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c1', scheduledServiceId: 'ss1', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'sue@service.com' }));
  });

  test('falls back to the primary email when the service contact has no email', async () => {
    mockDb({
      customer: {
        id: 'c2', first_name: 'Pat', email: 'primary@example.com', phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: null,
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentReminderEmail({
      customerId: 'c2', scheduledServiceId: 'ss2', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control', kind: '24h',
    });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'primary@example.com' }));
  });

  test('email-only customer (no phone contacts) still gets the email at the primary address', async () => {
    mockDb({
      customer: { id: 'c3', first_name: 'Pat', email: 'primary@example.com', phone: null },
      prefs: null,
    });

    const res = await AppointmentEmail.sendTechEnRouteEmail({ customerId: 'c3', techName: 'Adam', etaMinutes: 20 });

    expect(res.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'primary@example.com' }));
  });

  test('no email anywhere returns missing_email and does not call the email provider', async () => {
    mockDb({
      customer: {
        id: 'c4', first_name: 'Pat', email: null, phone: '+19415551234',
        service_contact_name: 'Sue', service_contact_phone: '+19415557777', service_contact_email: null,
      },
      prefs: { appointment_notify_primary: false },
    });

    const res = await AppointmentEmail.sendAppointmentConfirmationEmail({
      customerId: 'c4', scheduledServiceId: 'ss4', appointmentTime: '2026-06-22T14:00:00.000Z', serviceLabel: 'Quarterly Pest Control',
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_email');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
