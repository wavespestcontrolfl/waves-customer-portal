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

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    pluck: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    ...overrides,
  };
}

describe('appointment reminder registration deduplication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    db.raw = jest.fn().mockResolvedValue();
    db.transaction = jest.fn(async (callback) => callback(db));
  });

  test('merges same-customer same-time services without sending a second confirmation', async () => {
    const existingReminder = {
      id: 'reminder-1',
      scheduled_service_id: 'svc-termite',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-01T16:00:00.000Z'),
      service_type: 'Termite Inspection',
      cancelled: false,
    };
    const suppressedReminder = {
      id: 'reminder-2',
      scheduled_service_id: 'svc-wdo',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-01T16:00:00.000Z'),
      service_type: 'Termite Inspection & WDO Inspection',
      confirmation_sent: true,
      reminder_72h_sent: true,
      reminder_24h_sent: true,
    };

    const byScheduledService = chain({
      first: jest.fn().mockResolvedValue(null),
    });
    const addons = chain({
      pluck: jest.fn().mockResolvedValue([]),
    });
    const byCustomerAndTime = chain({
      first: jest.fn().mockResolvedValue(existingReminder),
    });
    const updateExisting = chain();
    const insertSuppressed = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([suppressedReminder]),
    });
    const reminderQueries = [byScheduledService, byCustomerAndTime, updateExisting, insertSuppressed];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'scheduled_service_addons') return addons;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.registerAppointment(
      'svc-wdo',
      'customer-1',
      '2026-05-01T12:00',
      'WDO Inspection',
      'admin_manual',
    );

    expect(result).toMatchObject({
      id: 'reminder-2',
      scheduled_service_id: 'svc-wdo',
      service_type: 'Termite Inspection & WDO Inspection',
      confirmation_sent: true,
      reminder_72h_sent: true,
      reminder_24h_sent: true,
    });
    expect(updateExisting.where).toHaveBeenCalledWith({ id: 'reminder-1' });
    expect(updateExisting.update).toHaveBeenCalledWith(expect.objectContaining({
      service_type: 'Termite Inspection & WDO Inspection',
    }));
    expect(byCustomerAndTime.orderBy).toHaveBeenCalledWith([
      { column: 'reminder_72h_sent', order: 'asc' },
      { column: 'reminder_24h_sent', order: 'asc' },
      { column: 'created_at', order: 'asc' },
    ]);
    expect(insertSuppressed.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_service_id: 'svc-wdo',
      customer_id: 'customer-1',
      service_type: 'Termite Inspection & WDO Inspection',
      confirmation_sent: true,
      reminder_72h_sent: true,
      reminder_24h_sent: true,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(db.mock.calls.map(([table]) => table)).not.toContain('customers');
  });

  test('does not send confirmation SMS when a past appointment is registered', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-06T20:00:00.000Z').getTime());

    const insertedReminder = {
      id: 'reminder-past',
      scheduled_service_id: 'svc-past',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-01T16:00:00.000Z'),
      service_type: 'Termite Inspection',
      source: 'admin_manual',
      confirmation_sent: false,
    };

    const byScheduledService = chain({
      first: jest.fn().mockResolvedValue(null),
    });
    const addons = chain({
      pluck: jest.fn().mockResolvedValue([]),
    });
    const byCustomerAndTime = chain({
      first: jest.fn().mockResolvedValue(null),
    });
    const insertReminder = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([insertedReminder]),
    });
    const markConfirmationSkipped = chain();
    const reminderQueries = [byScheduledService, byCustomerAndTime, insertReminder, markConfirmationSkipped];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'scheduled_service_addons') return addons;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.registerAppointment(
      'svc-past',
      'customer-1',
      '2026-05-01T12:00',
      'Termite Inspection',
      'admin_manual',
      { sendConfirmation: true },
    );

    expect(result).toBe(insertedReminder);
    expect(markConfirmationSkipped.where).toHaveBeenCalledWith({ id: 'reminder-past' });
    expect(markConfirmationSkipped.update).toHaveBeenCalledWith(expect.objectContaining({
      confirmation_sent: true,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(db.mock.calls.map(([table]) => table)).not.toContain('customers');
  });

  test('scrubs phone numbers from Twilio Lookup diagnostic helpers', () => {
    const { maskPhone, sanitizeLookupError } = AppointmentReminders._test;

    expect(maskPhone('+19415551212')).toBe('***1212');
    expect(sanitizeLookupError(
      'GET https://lookups.twilio.com/v2/PhoneNumbers/%2B19415551212 failed for +19415551212'
    )).toBe('GET https://lookups.twilio.com/v2/PhoneNumbers/[phone] failed for [phone]');
  });
});
