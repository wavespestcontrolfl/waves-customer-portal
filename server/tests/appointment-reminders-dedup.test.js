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
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const AppointmentReminders = require('../services/appointment-reminders');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotExists: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
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

  test('registerVisitReminderInTx inserts a durable, confirmation-skipped row on the caller conn', async () => {
    const lookup = chain({ first: jest.fn().mockResolvedValue(null) });
    const insertRow = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'rem-1' }]),
    });
    const queue = [lookup, insertRow];
    const conn = jest.fn(() => queue.shift());

    const result = await AppointmentReminders.registerVisitReminderInTx(conn, {
      scheduledServiceId: 'svc-seed-1',
      customerId: 'cust-1',
      appointmentTime: '2026-08-01T08:00',
      serviceType: 'Quarterly Pest Control',
      source: 'annual_prepay_seed',
    });

    expect(result).toEqual({ id: 'rem-1' });
    expect(lookup.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-seed-1' });
    // No confirmation SMS for system-seeded visits — confirmation_sent=true so the
    // 72h/24h pass still picks it up; reminder flags start false.
    expect(insertRow.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_service_id: 'svc-seed-1',
      customer_id: 'cust-1',
      source: 'annual_prepay_seed',
      confirmation_sent: true,
      reminder_72h_sent: false,
      reminder_24h_sent: false,
      cancelled: false,
    }));
  });

  test('registerVisitReminderInTx is idempotent — returns the existing row without inserting', async () => {
    const lookup = chain({ first: jest.fn().mockResolvedValue({ id: 'rem-existing' }) });
    const conn = jest.fn(() => lookup);

    const result = await AppointmentReminders.registerVisitReminderInTx(conn, {
      scheduledServiceId: 'svc-seed-1',
      customerId: 'cust-1',
      appointmentTime: '2026-08-01T08:00',
      serviceType: 'Quarterly Pest Control',
    });

    expect(result).toEqual({ id: 'rem-existing' });
    expect(lookup.insert).not.toHaveBeenCalled();
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

describe('appointment reminder reschedule windows', () => {
  const fixedNow = new Date('2026-05-06T14:00:00.000Z'); // 10:00 AM ET

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.useFakeTimers().setSystemTime(fixedNow);
    db.raw = jest.fn().mockResolvedValue();
    db.transaction = jest.fn(async (callback) => callback(db));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockRescheduleRecord({ customer, sendResult, reminderOverrides } = {}) {
    const reminder = {
      id: 'reminder-reschedule',
      scheduled_service_id: 'svc-reschedule',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-12T14:00:00.000Z'),
      service_type: 'Pest Control',
      reminder_72h_sent: true,
      reminder_24h_sent: true,
      ...reminderOverrides,
    };
    const lookupReminder = chain({
      first: jest.fn().mockResolvedValue(reminder),
    });
    const updateReminder = chain();
    const finalReminderLookup = chain({
      select: jest.fn().mockResolvedValue([{
        id: reminder.id,
        appointment_time: new Date('2026-05-07T13:00:00.000Z'),
      }]),
    });
    const finalReminderUpdate = chain();
    const reminderQueries = [lookupReminder, updateReminder, finalReminderLookup, finalReminderUpdate];

    const customerQuery = chain({
      first: jest.fn().mockResolvedValue(customer || null),
    });
    const techQuery = chain({
      first: jest.fn().mockResolvedValue({ tech_name: 'Sam' }),
    });
    const prefsQuery = chain({
      first: jest.fn().mockResolvedValue({}),
    });
    const landlineQuery = chain({
      first: jest.fn().mockResolvedValue(customer || null),
    });
    const customerQueries = [customerQuery, landlineQuery];
    const scheduledServiceQueries = [techQuery];
    const notificationPrefsQueries = [prefsQuery];

    if (sendResult) {
      sendCustomerMessage.mockResolvedValue(sendResult);
      smsTemplatesRouter.getTemplate.mockResolvedValue('Rescheduled appointment');
    }

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'customers') return customerQueries.shift();
      if (table === 'scheduled_services') return scheduledServiceQueries.shift();
      if (table === 'notification_prefs') return notificationPrefsQueries.shift();
      throw new Error(`Unexpected table query: ${table}`);
    });

    return { reminder, updateReminder, finalReminderUpdate };
  }

  test('silent reschedule inside the 24h window leaves the day-before reminder pending', async () => {
    const { updateReminder } = mockRescheduleRecord();

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-07T09:00',
      { sendNotification: false },
    );

    // The 72h window is due for the new time and firing it now would just echo
    // unchanged details, so it stays covered. The 24h window is deliberately
    // left pending: a silent move (e.g. a dispatch-board reshuffle) must not
    // strand the customer with no message at all — the next cron tick still
    // sends the normal day-before reminder.
    expect(updateReminder.where).toHaveBeenCalledWith({ id: 'reminder-reschedule' });
    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_72h_sent_at: expect.any(Date),
      reminder_24h_sent: false,
      reminder_24h_sent_at: null,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('reschedule that notifies (coverDueWindows) covers the due 24h window so cron cannot race the notice', async () => {
    const { updateReminder } = mockRescheduleRecord();

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-07T09:00',
      { sendNotification: false, coverDueWindows: true },
    );

    // The dispatch route sends its own reschedule SMS after this sync and only
    // then marks the windows covered. coverDueWindows keeps the due 24h flag
    // covered now so the 15-min cron can't fire a duplicate reminder in the gap.
    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_72h_sent_at: expect.any(Date),
      reminder_24h_sent: true,
      reminder_24h_sent_at: expect.any(Date),
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('same-start edit that notifies still covers a not-yet-sent due window', async () => {
    // Same start (2026-05-12T14:00Z = 10:00 AM ET — but inside the 24h window
    // relative to fixedNow via the move below) with the 24h reminder NOT yet
    // sent. A notifying same-start edit must cover the due window so the cron
    // can't fire in the gap before the route's SMS + markRescheduleNoticeSent.
    const { updateReminder } = mockRescheduleRecord({
      reminderOverrides: {
        appointment_time: new Date('2026-05-07T13:00:00.000Z'), // 9:00 AM ET tomorrow
        reminder_72h_sent: false,
        reminder_24h_sent: false,
      },
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-07T09:00', // same start as the record above
      { sendNotification: false, coverDueWindows: true },
    );

    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_72h_sent_at: expect.any(Date),
      reminder_24h_sent: true,
      reminder_24h_sent_at: expect.any(Date),
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('resize that keeps the same start time preserves already-sent reminder flags', async () => {
    const { updateReminder } = mockRescheduleRecord();

    // Same start (2026-05-12T14:00Z = 10:00 AM ET) as the existing record —
    // a duration-only resize. The already-sent flags must be preserved so the
    // cron does not re-send a duplicate reminder.
    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-12T10:00',
      { sendNotification: false },
    );

    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_24h_sent: true,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('silent reschedule about 48h out covers only the due 72h window', async () => {
    const { updateReminder } = mockRescheduleRecord();

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-08T10:00',
      { sendNotification: false },
    );

    // The 72h window is already due (would fire immediately); the 24h
    // reminder stays pending so the customer is still reminded the day
    // before the new appointment.
    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_72h_sent_at: expect.any(Date),
      reminder_24h_sent: false,
      reminder_24h_sent_at: null,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('silent reschedule outside 72h resets both reminder windows', async () => {
    const { updateReminder } = mockRescheduleRecord();

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-10T10:00',
      { sendNotification: false },
    );

    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: false,
      reminder_72h_sent_at: null,
      reminder_24h_sent: false,
      reminder_24h_sent_at: null,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('sent reschedule notice inside the 24h window marks both reminder windows sent', async () => {
    const { finalReminderUpdate } = mockRescheduleRecord({
      customer: {
        id: 'customer-1',
        first_name: 'Ada',
        phone: '+19415551212',
      },
      sendResult: { sent: true },
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-07T09:00',
    );

    expect(finalReminderUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_72h_sent_at: expect.any(Date),
      reminder_24h_sent: true,
      reminder_24h_sent_at: expect.any(Date),
    }));
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('failed reschedule notice leaves reminder windows pending', async () => {
    const { updateReminder, finalReminderUpdate } = mockRescheduleRecord({
      customer: {
        id: 'customer-1',
        first_name: 'Ada',
        phone: '+19415551212',
      },
      sendResult: { sent: false, code: 'blocked' },
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-07T09:00',
    );

    expect(updateReminder.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: false,
      reminder_72h_sent_at: null,
      reminder_24h_sent: false,
      reminder_24h_sent_at: null,
    }));
    expect(finalReminderUpdate.update).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalled();
  });
});

describe('appointment reminder cron delivery windows', () => {
  const fixedNow = new Date('2026-05-06T14:00:00.000Z'); // 10:00 AM ET

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.useFakeTimers().setSystemTime(fixedNow);
    smsTemplatesRouter.getTemplate.mockResolvedValue('24-hour appointment reminder');
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('sends tomorrow reminder even when appointment was booked less than 24 hours out', async () => {
    const reminder = {
      id: 'reminder-soon',
      scheduled_service_id: 'svc-soon',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-07T13:00:00.000Z'), // 9:00 AM ET tomorrow
      created_at: new Date('2026-05-06T13:45:00.000Z'),
      service_type: 'Pest Control',
      cancelled: false,
      confirmation_sent: true,
      reminder_72h_sent: true,
      reminder_24h_sent: false,
    };

    const reminderList = chain({
      select: jest.fn().mockResolvedValue([reminder]),
    });
    const prefsQuery = chain({
      first: jest.fn().mockResolvedValue({ sms_enabled: true, service_reminder_24h: true }),
    });
    const customer = {
      id: 'customer-1',
      first_name: 'Ada',
      phone: '+19415551212',
    };
    const customerQuery = chain({
      first: jest.fn().mockResolvedValue(customer),
    });
    const techQuery = chain({
      first: jest.fn().mockResolvedValue({ tech_name: 'Sam' }),
    });
    const landlineQuery = chain({
      first: jest.fn().mockResolvedValue(customer),
    });
    const markSent = chain();

    // checkAndSendReminders first runs a recovery sweep for stranded deferred
    // confirmations (confirmation_sent=false) before the main reminder pass.
    const strandedConfirmations = chain({
      select: jest.fn().mockResolvedValue([]),
    });
    const appointmentReminderQueries = [strandedConfirmations, reminderList, markSent];
    const customerQueries = [customerQuery, landlineQuery];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return appointmentReminderQueries.shift();
      if (table === 'notification_prefs') return prefsQuery;
      if (table === 'customers') return customerQueries.shift();
      if (table === 'scheduled_services') return techQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(result.sent24h).toBe(1);
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'reminder_24h',
      expect.objectContaining({
        first_name: 'Ada',
        service_type: 'Pest Control',
        time: '9:00 AM',
      }),
      expect.objectContaining({
        workflow: 'appointment_reminder_24h',
        entity_type: 'scheduled_service',
        entity_id: 'svc-soon',
      }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415551212',
      body: '24-hour appointment reminder',
      purpose: 'appointment_reminder_24h',
      customerId: 'customer-1',
    }));
    expect(markSent.where).toHaveBeenCalledWith({ id: 'reminder-soon' });
    expect(markSent.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_24h_sent: true,
      reminder_24h_sent_at: expect.any(Date),
    }));
  });
});
