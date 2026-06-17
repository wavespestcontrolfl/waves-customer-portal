jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const db = require('../models/db');
const AppointmentEmail = require('../services/appointment-email');
const NotificationService = require('../services/notification-service');
const AppointmentReminders = require('../services/appointment-reminders');

// Minimal knex-style chainable query mock.
function chain({ first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereNotExists', 'whereRaw', 'orderBy', 'select'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.update = jest.fn(async () => 1);
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  // db.raw is used for the "now() - interval" reconstruction branch.
  db.raw = jest.fn((sql) => sql);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AppointmentReminders.handleUndeliveredSms', () => {
  test('confirmation 30006 bounce: learns landline + sends confirmation email', async () => {
    const auditChain = chain({
      first: {
        channel: 'sms',
        purpose: 'appointment_confirmation',
        customer_id: 'c1',
        metadata: { original_message_type: 'confirmation', scheduled_service_id: 'ss1' },
      },
    });
    const custReadChain = chain({ first: { id: 'c1', phone: '+19415551234', line_type: null } });
    const custUpdateChain = chain({});
    const reminderChain = chain({ first: { appointment_time: '2026-06-20T13:00:00.000Z', service_type: 'Quarterly Pest Control' } });

    setDbQueues({
      messaging_audit_log: [auditChain],
      customers: [custReadChain, custUpdateChain],
      appointment_reminders: [reminderChain],
    });

    await AppointmentReminders.handleUndeliveredSms({
      sid: 'SM_test', status: 'undelivered', errorCode: '30006', to: '+19415551234',
    });

    // landline learned on the customer's primary phone
    expect(custUpdateChain.update).toHaveBeenCalledWith({ line_type: 'landline' });
    // confirmation email sent with reconstructed appointment details
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'Quarterly Pest Control' }),
    );
    expect(AppointmentEmail.sendTechEnRouteEmail).not.toHaveBeenCalled();
  });

  test('en-route 30006 bounce with email on file: learns landline, does NOT send a stale en-route email or alert', async () => {
    const auditChain = chain({
      first: {
        channel: 'sms',
        purpose: 'tech_en_route',
        customer_id: 'c2',
        metadata: { original_message_type: 'tech_en_route' },
      },
    });
    const custReadChain = chain({ first: { id: 'c2', phone: '+19415559999', email: 'customer@example.com', line_type: null } });
    const custUpdateChain = chain({});

    setDbQueues({
      messaging_audit_log: [auditChain],
      customers: [custReadChain, custUpdateChain],
    });

    await AppointmentReminders.handleUndeliveredSms({
      sid: 'SM_test2', status: 'undelivered', errorCode: '30006', to: '+19415559999',
    });

    expect(custUpdateChain.update).toHaveBeenCalledWith({ line_type: 'landline' });
    expect(AppointmentEmail.sendTechEnRouteEmail).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('service-contact bounce with NO provider-accepted sibling: still emails', async () => {
    // The service contact +1941..7777 bounced; no other appointment SMS for this
    // occurrence was provider-accepted (e.g. primary was blocked synchronously).
    const auditChain = chain({
      first: {
        channel: 'sms',
        purpose: 'appointment_confirmation',
        customer_id: 'c4',
        metadata: { original_message_type: 'confirmation', scheduled_service_id: 'ss4' },
      },
    });
    const siblingChain = chain({ first: null }); // no accepted sibling
    const custReadChain = chain({ first: { id: 'c4', phone: '+19415551234', line_type: null } });
    const reminderChain = chain({ first: { appointment_time: '2026-06-22T14:00:00.000Z', service_type: 'Quarterly Pest Control' } });

    setDbQueues({
      messaging_audit_log: [auditChain, siblingChain],
      customers: [custReadChain],
      appointment_reminders: [reminderChain],
    });

    await AppointmentReminders.handleUndeliveredSms({
      sid: 'SM_test4', status: 'undelivered', errorCode: '30006', to: '+19415557777',
    });

    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
  });

  test('service-contact bounce WITH a provider-accepted sibling: skips (no duplicate email)', async () => {
    const auditChain = chain({
      first: {
        channel: 'sms',
        purpose: 'appointment_confirmation',
        customer_id: 'c5',
        metadata: { original_message_type: 'confirmation', scheduled_service_id: 'ss5' },
      },
    });
    const siblingChain = chain({ first: { id: 'accepted-row' } }); // primary was accepted
    const custReadChain = chain({ first: { id: 'c5', phone: '+19415551234', line_type: null } });

    setDbQueues({
      messaging_audit_log: [auditChain, siblingChain],
      customers: [custReadChain],
    });

    await AppointmentReminders.handleUndeliveredSms({
      sid: 'SM_test5', status: 'undelivered', errorCode: '30006', to: '+19415557777',
    });

    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    // The sibling lookup is scoped to the same notice (purpose), not just the occurrence.
    expect(siblingChain.where).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'appointment_confirmation' }));
  });

  test('email fallback blocked (suppressed) raises the no-channel admin alert', async () => {
    AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'suppressed' });
    const auditChain = chain({
      first: {
        channel: 'sms',
        purpose: 'appointment_confirmation',
        customer_id: 'c6',
        metadata: { original_message_type: 'confirmation', scheduled_service_id: 'ss6' },
      },
    });
    const custReadChain = chain({ first: { id: 'c6', phone: '+19415551234', line_type: null } });
    const custUpdateChain = chain({});
    const reminderChain = chain({ first: { appointment_time: '2026-06-22T14:00:00.000Z', service_type: 'Quarterly Pest Control' } });
    const notifExistsChain = chain({ first: null });
    const custNameChain = chain({ first: { id: 'c6', first_name: 'Pat', last_name: 'Doe' } });

    setDbQueues({
      messaging_audit_log: [auditChain],
      customers: [custReadChain, custUpdateChain, custNameChain],
      appointment_reminders: [reminderChain],
      notifications: [notifExistsChain],
    });

    await AppointmentReminders.handleUndeliveredSms({
      sid: 'SM_test6', status: 'undelivered', errorCode: '30006', to: '+19415551234',
    });

    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('non-appointment message is ignored (no landline change, no email)', async () => {
    const auditChain = chain({
      first: {
        channel: 'sms',
        purpose: 'invoice_followup',
        customer_id: 'c3',
        metadata: { original_message_type: 'invoice' },
      },
    });
    setDbQueues({ messaging_audit_log: [auditChain] });

    await AppointmentReminders.handleUndeliveredSms({
      sid: 'SM_test3', status: 'undelivered', errorCode: '30006', to: '+19415550000',
    });

    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendTechEnRouteEmail).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
