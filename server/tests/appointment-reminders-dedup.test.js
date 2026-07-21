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
// Card-hold fee-policy clause (spec Phase 1): mocked so reminder tests
// control it directly; '' is the non-card-hold default the cron passes.
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));

const db = require('../models/db');
const { cardHoldReminderLine } = require('../services/estimate-card-holds');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const AppointmentReminders = require('../services/appointment-reminders');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereExists: jest.fn().mockReturnThis(),
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
    const sameTime = chain({ first: jest.fn().mockResolvedValue(null) });
    const insertRow = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'rem-1' }]),
    });
    const queue = [lookup, sameTime, insertRow];
    const conn = jest.fn(() => queue.shift());
    conn.raw = jest.fn().mockResolvedValue();

    const result = await AppointmentReminders.registerVisitReminderInTx(conn, {
      scheduledServiceId: 'svc-seed-1',
      customerId: 'cust-1',
      appointmentTime: '2099-08-01T08:00', // far future → both reminder windows still open
      serviceType: 'Quarterly Pest Control',
      source: 'annual_prepay_seed',
    });

    expect(result).toEqual({ id: 'rem-1' });
    expect(conn.raw).toHaveBeenCalled(); // serialized via advisory lock
    expect(lookup.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-seed-1' });
    // No confirmation SMS for system-seeded visits — confirmation_sent=true so the
    // 72h/24h pass still picks it up; for a far-future visit both windows are open.
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

  test('registerVisitReminderInTx suppresses a same-customer/same-time collision', async () => {
    const lookup = chain({ first: jest.fn().mockResolvedValue(null) });
    const sameTime = chain({ first: jest.fn().mockResolvedValue({ id: 'rem-primary', service_type: 'Lawn Care' }) });
    // buildMergedServiceLabel's source-row query (pristine sibling labels)
    const labelRows = chain({ select: jest.fn().mockResolvedValue([{ label: 'Lawn Care' }]) });
    const mergeUpdate = chain();
    const insertSuppressed = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'rem-suppressed' }]),
    });
    const queue = [lookup, sameTime, labelRows, mergeUpdate, insertSuppressed];
    const conn = jest.fn(() => queue.shift());
    conn.raw = jest.fn().mockResolvedValue();

    const result = await AppointmentReminders.registerVisitReminderInTx(conn, {
      scheduledServiceId: 'svc-seed-2',
      customerId: 'cust-1',
      appointmentTime: '2099-08-01T08:00',
      serviceType: 'Quarterly Pest Control',
      source: 'annual_prepay_seed',
    });

    expect(result).toEqual({ id: 'rem-suppressed' });
    // The colliding row is inserted fully suppressed so the cron sends only once.
    expect(insertSuppressed.insert).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: true,
      reminder_24h_sent: true,
      // Suppressed rows keep their pristine label — buildMergedServiceLabel
      // rebuilds from per-row names, never from a merged string.
      service_type: 'Quarterly Pest Control',
    }));
    expect(mergeUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      service_type: 'Lawn Care & Quarterly Pest Control',
    }));
  });

  test('registerVisitReminderInTx is idempotent — returns the existing row without inserting', async () => {
    const lookup = chain({ first: jest.fn().mockResolvedValue({ id: 'rem-existing' }) });
    const conn = jest.fn(() => lookup);
    conn.raw = jest.fn().mockResolvedValue();

    const result = await AppointmentReminders.registerVisitReminderInTx(conn, {
      scheduledServiceId: 'svc-seed-1',
      customerId: 'cust-1',
      appointmentTime: '2099-08-01T08:00',
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
    // buildMergedServiceLabel's source-row query (aliased table)
    const labelRows = chain({ select: jest.fn().mockResolvedValue([{ label: 'Termite Inspection' }]) });
    const updateExisting = chain();
    const insertSuppressed = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([suppressedReminder]),
    });
    const reminderQueries = [byScheduledService, byCustomerAndTime, labelRows, updateExisting, insertSuppressed];

    db.mockImplementation((table) => {
      if (String(table).startsWith('appointment_reminders')) return reminderQueries.shift();
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
      // Pristine per-row label (rebuild source), not the merged display string.
      service_type: 'WDO Inspection',
      confirmation_sent: true,
      reminder_72h_sent: true,
      reminder_24h_sent: true,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(db.mock.calls.map(([table]) => table)).not.toContain('customers');
  });

  test('closeReminderWindows inserts a suppressed pre-closed placeholder and NEVER consults the same-slot dedupe (no owner absorb, no label merge)', async () => {
    const insertedPlaceholder = {
      id: 'reminder-placeholder',
      scheduled_service_id: 'svc-untimed',
      customer_id: 'customer-1',
      suppressed_by_sibling: true,
      windows_preclosed: true,
    };
    const byScheduledService = chain({ first: jest.fn().mockResolvedValue(null) });
    const addons = chain({ pluck: jest.fn().mockResolvedValue([]) });
    const insertPlaceholder = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([insertedPlaceholder]),
    });
    const markConfirmationSkipped = chain();
    // NO same-slot dedupe read and NO owner label-merge update in this
    // queue: an existing real 8 AM owner must never absorb the date-only
    // service (merged label advertising it "at 8:00 AM") and the placeholder
    // must never land as a promotable suppressed sibling under it — the
    // placeholder path skips the dedupe entirely, inserting identically
    // whether or not an owner holds the slot. Any extra
    // appointment_reminders query would misalign this queue and fail loudly.
    const reminderQueries = [byScheduledService, insertPlaceholder, markConfirmationSkipped];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'scheduled_service_addons') return addons;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.registerAppointment(
      'svc-untimed',
      'customer-1',
      '2099-08-01T08:00',
      'Lawn Care',
      'admin_ib',
      { sendConfirmation: false, closeReminderWindows: true },
    );

    expect(result).toBe(insertedPlaceholder);
    const payload = insertPlaceholder.insert.mock.calls[0][0];
    expect(payload).toMatchObject({
      scheduled_service_id: 'svc-untimed',
      customer_id: 'customer-1',
      // Both windows pre-closed in the same insert (no armed-gap for the cron)…
      reminder_72h_sent: true,
      reminder_24h_sent: true,
      // …plus the placeholder markers: suppressed_by_sibling takes the row
      // out of slot OWNERSHIP everywhere (dedupe, trigger arrival check,
      // promotion's no-owner-remains check), and windows_preclosed keeps
      // promotion and the sync trigger from ever arming it while windowless.
      suppressed_by_sibling: true,
      windows_preclosed: true,
      // Confirmation closes IN the insert — a post-transaction mark would
      // leave a crash window where the stranded-confirmation sweep texts an
      // 08:00 confirmation for a visit with no chosen time.
      confirmation_sent: true,
    });
    expect(payload.reminder_72h_sent_at).toBeInstanceOf(Date);
    expect(payload.reminder_24h_sent_at).toBeInstanceOf(Date);
    expect(payload.confirmation_sent_at).toBeInstanceOf(Date);
    // The post-insert "not applicable" mark is skipped for placeholders —
    // the flag is already stamped, so no redundant second write.
    expect(markConfirmationSkipped.update).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a REAL timed registration dedupes only against non-suppressed owners — a pre-closed placeholder cannot own the slot, so the real visit lands ARMED', async () => {
    const insertedArmed = {
      id: 'reminder-real',
      scheduled_service_id: 'svc-real-8am',
      customer_id: 'customer-1',
      confirmation_sent: false,
    };
    const byScheduledService = chain({ first: jest.fn().mockResolvedValue(null) });
    const addons = chain({ pluck: jest.fn().mockResolvedValue([]) });
    // The dedupe query filters suppressed_by_sibling=false in SQL, so a
    // placeholder parked on the 08:00 slot resolves to NO owner here.
    const byCustomerAndTime = chain({ first: jest.fn().mockResolvedValue(null) });
    const insertReminder = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([insertedArmed]),
    });
    const markConfirmationSkipped = chain();
    const reminderQueries = [byScheduledService, byCustomerAndTime, insertReminder, markConfirmationSkipped];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'scheduled_service_addons') return addons;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.registerAppointment(
      'svc-real-8am',
      'customer-1',
      '2099-08-01T08:00',
      'Pest Control',
      'admin_manual',
      { sendConfirmation: false },
    );

    expect(result).toBe(insertedArmed);
    // The ownership filter that makes the placeholder invisible: only
    // non-cancelled, non-suppressed rows can be the slot owner.
    expect(byCustomerAndTime.where).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      cancelled: false,
      suppressed_by_sibling: false,
    }));
    // The real visit's row inserts ARMED: no pre-closed stamps, no
    // suppression markers — the cron delivers its 72h/24h reminders.
    const payload = insertReminder.insert.mock.calls[0][0];
    expect(payload).not.toHaveProperty('reminder_72h_sent');
    expect(payload).not.toHaveProperty('reminder_24h_sent');
    expect(payload).not.toHaveProperty('suppressed_by_sibling');
    expect(payload).not.toHaveProperty('windows_preclosed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
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

  test('a windowless pre-closed placeholder NEVER re-arms on reschedule — the trigger-held closed windows survive the recompute', async () => {
    // Untimed IB/health-alert visit, date-only move while still windowless.
    // The admin bulk/dispatch paths call handleReschedule AFTER their
    // service update — the DB sync trigger has already held the
    // placeholder's windows closed, so recomputing them from the new time
    // here would clear the flags and the 15-min cron would text the 08:00
    // placeholder time nobody chose.
    const { updateReminder } = mockRescheduleRecord({
      reminderOverrides: {
        suppressed_by_sibling: true,
        windows_preclosed: true,
      },
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-20T08:00',
      { sendNotification: false, coverDueWindows: true },
    );

    const payload = updateReminder.update.mock.calls[0][0];
    // The row still tracks the move…
    expect(payload).toMatchObject({ appointment_time: expect.any(Date), cancelled: false });
    // …but the reminder windows are untouched — the trigger owns them.
    expect(payload).not.toHaveProperty('reminder_72h_sent');
    expect(payload).not.toHaveProperty('reminder_72h_sent_at');
    expect(payload).not.toHaveProperty('reminder_24h_sent');
    expect(payload).not.toHaveProperty('reminder_24h_sent_at');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a sibling-suppressed row keeps its flags on reschedule — the main update carries the same carve-out as every re-arm site', async () => {
    // The slot's owner carries the messaging; recomputing a suppressed
    // row's windows from the new time would put it back in the cron's send
    // set alongside the owner (duplicate texts per window).
    const { updateReminder } = mockRescheduleRecord({
      reminderOverrides: { suppressed_by_sibling: true },
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-20T09:00',
      { sendNotification: false },
    );

    const payload = updateReminder.update.mock.calls[0][0];
    expect(payload).toMatchObject({ appointment_time: expect.any(Date) });
    expect(payload).not.toHaveProperty('reminder_72h_sent');
    expect(payload).not.toHaveProperty('reminder_24h_sent');
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

  test('notice attempt that THROWS re-arms the 72h fallback on a pre-covered row', async () => {
    // The DB sync trigger pre-covers the row (appointment_time already equals
    // the new start, 72h flag sent), so a same-start notifying reschedule
    // preserves the covered flag. If the notice attempt then throws (customer
    // lookup here), the finally block must re-arm the 72h window or the cron
    // never delivers the fallback for a 24-72h-out appointment.
    const reminder = {
      id: 'reminder-reschedule',
      scheduled_service_id: 'svc-reschedule',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-08T14:00:00.000Z'), // 10:00 AM ET, ~48h out
      service_type: 'Pest Control',
      reminder_72h_sent: true,
      reminder_24h_sent: false,
    };
    const lookupReminder = chain({ first: jest.fn().mockResolvedValue(reminder) });
    const updateReminder = chain();
    const rearmUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const reminderQueries = [lookupReminder, updateReminder, rearmUpdate];
    const throwingCustomerLookup = chain({
      first: jest.fn().mockRejectedValue(new Error('db connection reset')),
    });
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'customers') return throwingCustomerLookup;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-08T10:00', // same start the trigger already synced
    );

    // Guarded by the appointment time this invocation handled (so a stale
    // failure can't clobber a newer overlapping reschedule), by this
    // invocation's own updated_at claim (so a successful SAME-time overlap
    // isn't clobbered either), and by the sibling-suppression marker (so a
    // suppressed slot sibling stays quiet).
    expect(rearmUpdate.where).toHaveBeenCalledWith({
      id: 'reminder-reschedule',
      appointment_time: expect.any(Date),
      updated_at: expect.any(Date),
      suppressed_by_sibling: false,
    });
    const [{ appointment_time: rearmTime }] = rearmUpdate.where.mock.calls[0];
    expect(rearmTime.toISOString()).toBe('2026-05-08T14:00:00.000Z');
    expect(rearmUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: false,
      reminder_72h_sent_at: null,
    }));
    expect(result).toBeNull(); // outer catch still swallows the throw
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('failed notice within the 24h band leaves the 72h window covered (cron can never deliver it)', async () => {
    const reminder = {
      id: 'reminder-reschedule',
      scheduled_service_id: 'svc-reschedule',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-07T13:00:00.000Z'), // 9:00 AM ET tomorrow, ~23h out
      service_type: 'Pest Control',
      reminder_72h_sent: true,
      reminder_24h_sent: false,
    };
    const lookupReminder = chain({ first: jest.fn().mockResolvedValue(reminder) });
    const updateReminder = chain();
    const rearmUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const reminderQueries = [lookupReminder, updateReminder, rearmUpdate];
    const throwingCustomerLookup = chain({
      first: jest.fn().mockRejectedValue(new Error('db connection reset')),
    });
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'customers') return throwingCustomerLookup;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-07T09:00', // same start, inside 24.25h of fixedNow
    );

    // hoursUntil <= 24.25 means the cron's 72h branch can never fire for this
    // time — re-arming would only park the row in every 15-minute scan. The
    // still-armed 24h window carries the fallback.
    expect(rearmUpdate.update).not.toHaveBeenCalled();
  });

  test('notifying reschedule with no reachable customer re-arms the 72h fallback', async () => {
    const reminder = {
      id: 'reminder-reschedule',
      scheduled_service_id: 'svc-reschedule',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-08T14:00:00.000Z'), // 10:00 AM ET, ~48h out
      service_type: 'Pest Control',
      reminder_72h_sent: true,
      reminder_24h_sent: false,
    };
    const lookupReminder = chain({ first: jest.fn().mockResolvedValue(reminder) });
    const updateReminder = chain();
    const rearmUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const reminderQueries = [lookupReminder, updateReminder, rearmUpdate];
    const nullCustomerLookup = chain({ first: jest.fn().mockResolvedValue(null) });
    const techQuery = chain({ first: jest.fn().mockResolvedValue({ tech_name: 'Sam' }) });
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'customers') return nullCustomerLookup;
      if (table === 'scheduled_services') return techQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await AppointmentReminders.handleReschedule(
      'svc-reschedule',
      '2026-05-08T10:00', // same start the trigger already synced
    );

    // With no customer row nothing can send; the row must not stay covered.
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(rearmUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: false,
      reminder_72h_sent_at: null,
    }));
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
        // Non-card-hold booking: the fee-policy clause resolves to '' so
        // the {card_hold_policy_line} placeholder renders clean and the SMS
        // stays byte-identical to the pre-Phase-1 copy.
        card_hold_policy_line: '',
      }),
      expect.objectContaining({
        workflow: 'appointment_reminder_24h',
        entity_type: 'scheduled_service',
        entity_id: 'svc-soon',
      }),
    );
    expect(cardHoldReminderLine).toHaveBeenCalledWith('svc-soon');
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

  function armedReminder(overrides = {}) {
    return {
      id: 'reminder-stale',
      scheduled_service_id: 'svc-x',
      customer_id: 'customer-1',
      appointment_time: new Date('2026-05-07T13:00:00.000Z'), // 9:00 AM ET tomorrow
      created_at: new Date('2026-05-01T13:45:00.000Z'),
      service_type: 'Lawn Care Service',
      cancelled: false,
      confirmation_sent: true,
      reminder_72h_sent: true,
      reminder_24h_sent: false,
      ...overrides,
    };
  }

  test.each(['cancelled', 'completed', 'skipped', 'no_show'])(
    'skips and self-cancels a reminder whose service is terminal (%s)',
    async (svcStatus) => {
      // Armed row (cancelled=false), due tomorrow — but the underlying service
      // reached a terminal state through a path that never flipped the row's
      // cancelled flag. The guard must suppress the text and self-heal the row.
      const reminder = armedReminder({ scheduled_service_id: 'svc-terminal' });
      const strandedConfirmations = chain({ select: jest.fn().mockResolvedValue([]) });
      const reminderList = chain({ select: jest.fn().mockResolvedValue([reminder]) });
      const statusQuery = chain({ first: jest.fn().mockResolvedValue({ status: svcStatus }) });
      const markCancelled = chain();
      const appointmentReminderQueries = [strandedConfirmations, reminderList, markCancelled];

      db.mockImplementation((table) => {
        if (table === 'appointment_reminders') return appointmentReminderQueries.shift();
        if (table === 'scheduled_services') return statusQuery;
        throw new Error(`Unexpected table query: ${table}`);
      });

      const result = await AppointmentReminders.checkAndSendReminders();

      expect(result.sent24h).toBe(0);
      expect(result.skipped).toBe(1);
      expect(statusQuery.where).toHaveBeenCalledWith({ id: 'svc-terminal' });
      expect(markCancelled.where).toHaveBeenCalledWith({ id: 'reminder-stale' });
      expect(markCancelled.update).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    },
  );

  test('skips a reschedule-request reminder WITHOUT self-cancelling it (pending rebook)', async () => {
    // 'rescheduled' is a pending-rebook marker: the stale-slot text must be
    // suppressed, but the row must stay armed so the rebook (handleReschedule)
    // can resume reminders. The guard must NOT mark this row cancelled.
    const reminder = armedReminder({ scheduled_service_id: 'svc-resched' });
    const strandedConfirmations = chain({ select: jest.fn().mockResolvedValue([]) });
    const reminderList = chain({ select: jest.fn().mockResolvedValue([reminder]) });
    const statusQuery = chain({ first: jest.fn().mockResolvedValue({ status: 'rescheduled' }) });
    const mustNotUpdate = chain();
    const appointmentReminderQueries = [strandedConfirmations, reminderList, mustNotUpdate];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return appointmentReminderQueries.shift();
      if (table === 'scheduled_services') return statusQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(result.sent24h).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mustNotUpdate.update).not.toHaveBeenCalled(); // row left armed
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
