/**
 * Reminder cron — flag-update race guard + preference-skip window close.
 *
 * Two coupled bugs in checkAndSendReminders:
 *   1. After sending, the 72h/24h flags were marked sent unconditionally by
 *      row id. A concurrent move re-arms the row (DB sync trigger /
 *      handleReschedule) for its NEW time — the unguarded update stomped
 *      that re-arm and silently closed the new slot's reminder. The updates
 *      are now guarded on appointment_time; 0 rows matched = the row moved,
 *      so the "sent" bookkeeping is skipped.
 *   2. A customer-preference skip `continue`d without closing the window
 *      (unlike the neighboring skip branches), so the row re-entered every
 *      15-minute scan forever. Preference skips now mark the flag sent —
 *      with the SAME appointment_time guard as (1): an unguarded close by
 *      id would stomp a concurrent move's re-arm and silently close the
 *      NEW appointment's reminder. 0 rows matched = skip the bookkeeping.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
  cacheLineType: jest.fn(),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn((customer) => (customer?.phone
    ? [{ phone: customer.phone, name: customer.first_name, role: 'primary' }]
    : [])),
  isServiceContactRole: jest.fn(() => false),
  firstNameFrom: jest.fn((n) => n),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'REMINDER BODY'),
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(async () => ({ url: null, line: '' })),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const AppointmentReminders = require('../services/appointment-reminders');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder);
      return builder;
    }),
    orWhere: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNotExists: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  });
  return builder;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

// Reminder row due for the 72h leg (48h out, booked long ago).
function row72(overrides = {}) {
  return {
    id: 'rem-1',
    customer_id: 'cust-1',
    scheduled_service_id: 'svc-1',
    service_type: 'Pest Control',
    appointment_time: new Date(Date.now() + 48 * 3600000),
    created_at: new Date(Date.now() - 200 * 3600000),
    reminder_72h_sent: false,
    reminder_24h_sent: true,
    ...overrides,
  };
}

// Reminder row due for the 24h leg (exactly 24h out = tomorrow in ET).
function row24(overrides = {}) {
  return {
    id: 'rem-1',
    customer_id: 'cust-1',
    scheduled_service_id: 'svc-1',
    service_type: 'Pest Control',
    appointment_time: new Date(Date.now() + 24 * 3600000),
    created_at: new Date(Date.now() - 200 * 3600000),
    reminder_72h_sent: true,
    reminder_24h_sent: false,
    ...overrides,
  };
}

const CUSTOMER = { id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', phone: '+19415551234', line_type: 'mobile' };

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  jest.spyOn(AppointmentReminders, 'selfHealMissingReminderRows').mockResolvedValue({ healed: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('scan marker exclusion', () => {
  test('the reminder scan excludes windows_preclosed placeholder rows outright (belt-and-braces)', async () => {
    // A windowless pre-closed placeholder is normally hidden from the scan
    // by its closed flags alone — the explicit marker predicate means any
    // future writer that mistakenly clears those flags still can't put the
    // 08:00 placeholder time into the send set. A real window arrival
    // clears windows_preclosed (DB sync trigger) and re-admits the row.
    const scanQuery = chain({ select: jest.fn().mockResolvedValue([]) });
    wireDb({
      appointment_reminders: [
        chain(), // stranded-confirmation sweep → []
        scanQuery,
      ],
    });

    await AppointmentReminders.checkAndSendReminders();

    expect(scanQuery.where).toHaveBeenCalledWith({ windows_preclosed: false });
  });
});

describe('preference-skip closes the window', () => {
  test('72h preference skip marks reminder_72h_sent (guarded on appointment_time) so the row stops rescanning', async () => {
    const reminderRow = row72();
    const flagUpdate = chain();
    wireDb({
      appointment_reminders: [
        chain(), // stranded-confirmation sweep → []
        chain({ select: jest.fn().mockResolvedValue([reminderRow]) }),
        flagUpdate,
      ],
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ status: 'confirmed' }) })],
      notification_prefs: [chain({ first: jest.fn().mockResolvedValue({ service_reminder_72h: false }) })],
      customers: [chain()], // resolveChannelPrefsRow lookup → undefined
    });

    const results = await AppointmentReminders.checkAndSendReminders();

    expect(results.skipped).toBe(1);
    expect(results.sent72h).toBe(0);
    expect(flagUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ reminder_72h_sent: true }),
    );
    // Same appointment_time guard as the post-send flag update — an
    // unguarded close by id would stomp a concurrent move's re-arm.
    expect(flagUpdate.where).toHaveBeenCalledWith('appointment_time', reminderRow.appointment_time);
  });

  test('24h preference skip marks reminder_24h_sent (guarded on appointment_time) so the row stops rescanning', async () => {
    const reminderRow = row24();
    const flagUpdate = chain();
    wireDb({
      appointment_reminders: [
        chain(),
        chain({ select: jest.fn().mockResolvedValue([reminderRow]) }),
        flagUpdate,
      ],
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ status: 'confirmed' }) })],
      notification_prefs: [chain({ first: jest.fn().mockResolvedValue({ service_reminder_24h: false }) })],
      customers: [chain()],
    });

    const results = await AppointmentReminders.checkAndSendReminders();

    expect(results.skipped).toBe(1);
    expect(results.sent24h).toBe(0);
    expect(flagUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ reminder_24h_sent: true }),
    );
    expect(flagUpdate.where).toHaveBeenCalledWith('appointment_time', reminderRow.appointment_time);
  });

  test('72h preference-skip close that matches 0 rows (raced move) skips the bookkeeping and leaves the re-armed row', async () => {
    const flagUpdate = chain({ update: jest.fn().mockResolvedValue(0) }); // row moved concurrently
    wireDb({
      appointment_reminders: [
        chain(),
        chain({ select: jest.fn().mockResolvedValue([row72()]) }),
        flagUpdate,
      ],
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ status: 'confirmed' }) })],
      notification_prefs: [chain({ first: jest.fn().mockResolvedValue({ service_reminder_72h: false }) })],
      customers: [chain()],
    });

    const results = await AppointmentReminders.checkAndSendReminders();

    // The re-armed row owns the new state — nothing counted as skipped.
    expect(results.skipped).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('72h preference-skip close skipped'),
    );
  });

  test('24h preference-skip close that matches 0 rows (raced move) skips the bookkeeping and leaves the re-armed row', async () => {
    const flagUpdate = chain({ update: jest.fn().mockResolvedValue(0) });
    wireDb({
      appointment_reminders: [
        chain(),
        chain({ select: jest.fn().mockResolvedValue([row24()]) }),
        flagUpdate,
      ],
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ status: 'confirmed' }) })],
      notification_prefs: [chain({ first: jest.fn().mockResolvedValue({ service_reminder_24h: false }) })],
      customers: [chain()],
    });

    const results = await AppointmentReminders.checkAndSendReminders();

    expect(results.skipped).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('24h preference-skip close skipped'),
    );
  });
});

describe('appointment_time-guarded flag updates', () => {
  function wireSendPath(reminderRow, flagUpdate) {
    wireDb({
      appointment_reminders: [
        chain(), // stranded sweep
        chain({ select: jest.fn().mockResolvedValue([reminderRow]) }),
        flagUpdate,
      ],
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue({ status: 'confirmed' }) }), // live-status guard
        chain({ first: jest.fn().mockResolvedValue({ tech_name: null }) }), // getCustomerAndTech join
      ],
      notification_prefs: [chain({ first: jest.fn().mockResolvedValue(null) })],
      customers: [
        chain(), // resolveChannelPrefsRow
        chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // getCustomerAndTech
        chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // isLandline
      ],
    });
  }

  test('72h flag update is guarded on appointment_time and a raced move skips sent bookkeeping', async () => {
    const reminderRow = row72();
    const flagUpdate = chain({ update: jest.fn().mockResolvedValue(0) }); // row moved concurrently
    wireSendPath(reminderRow, flagUpdate);

    const results = await AppointmentReminders.checkAndSendReminders();

    // The guarded update carried the appointment_time predicate…
    expect(flagUpdate.where).toHaveBeenCalledWith('appointment_time', reminderRow.appointment_time);
    // …and 0 matched rows means the sent counter is NOT bumped.
    expect(results.sent72h).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('moved during send'));
  });

  test('24h flag update matching 1 row keeps normal bookkeeping', async () => {
    const reminderRow = row24();
    const flagUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    wireSendPath(reminderRow, flagUpdate);

    const results = await AppointmentReminders.checkAndSendReminders();

    expect(flagUpdate.where).toHaveBeenCalledWith('appointment_time', reminderRow.appointment_time);
    expect(results.sent24h).toBe(1);
  });
});
