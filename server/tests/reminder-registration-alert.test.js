jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const AppointmentReminders = require('../services/appointment-reminders');

let existingNotification;

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereExists: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    pluck: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  existingNotification = undefined;
  db.raw = jest.fn().mockResolvedValue();
  // Registration itself blows up; the notifications dedupe lookup works.
  db.transaction = jest.fn(async () => { throw new Error('db down'); });
  db.mockImplementation((table) => {
    if (table === 'notifications') {
      return chain({ first: jest.fn(async () => existingNotification) });
    }
    return chain();
  });
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-new' });
});

describe('reminder-registration failure alerting', () => {
  test('a failed registration fires a deduped admin alert instead of dying in the log', async () => {
    const out = await AppointmentReminders.registerAppointment(
      'ss-1', 'c-1', '2026-07-20T10:00', 'Pest Control', 'booking_new',
    );
    expect(out).toBeNull(); // contract unchanged: never throws into the caller

    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title).toBe('Appointment reminders not registered');
    expect(body).toContain('ss-1');
    expect(body).toContain('booking_new');
    expect(opts.metadata).toMatchObject({
      dedupeKey: 'reminder-registration-failed:ss-1',
      scheduled_service_id: 'ss-1',
      customer_id: 'c-1',
      source: 'booking_new',
    });
  });

  test('a recent alert for the same visit suppresses a duplicate', async () => {
    existingNotification = { id: 'n-existing' };
    const out = await AppointmentReminders.registerAppointment(
      'ss-1', 'c-1', '2026-07-20T10:00', 'Pest Control', 'booking_new',
    );
    expect(out).toBeNull();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an alert failure never throws back into the registration path', async () => {
    NotificationService.notifyAdmin.mockRejectedValue(new Error('notif table busy'));
    const out = await AppointmentReminders.registerAppointment(
      'ss-1', 'c-1', '2026-07-20T10:00', 'Pest Control', 'booking_new',
    );
    expect(out).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('registration-failure alert failed'));
  });

  test('alertRegistrationFailure is exported for route-level wrappers', () => {
    expect(typeof AppointmentReminders.alertRegistrationFailure).toBe('function');
  });
});
