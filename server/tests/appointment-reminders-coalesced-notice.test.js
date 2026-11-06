/**
 * GATE_RESCHEDULE_CAP_ALL: the deferred confirmation of a coalesced reschedule
 * (handleReschedule { deferNoticeMinutes }) stands in for the reschedule notice the
 * repeat moves did not send, so a delivered one covers the reminder windows that notice
 * would cover (reminderFlagsCoveredByNotice, the rule markRescheduleNoticeSent applies).
 * Codex r2 P2 on #7661: without it the 72h reminder followed the confirmation in the same
 * checkAndSendReminders pass, two texts back to back.
 *
 * One stateful reminder row runs through the real stranded-confirmation sweep, the real
 * confirmation send and the real reminder scan; only the table reads and the message
 * send are faked.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
  cacheLineType: jest.fn(),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn((customer) => (customer?.phone
    ? [{ phone: customer.phone, name: customer.first_name, role: 'primary' }]
    : [])),
  isServiceContactRole: jest.fn(() => false),
  prefsUnavailable: jest.fn(() => false),
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
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
}));
// A visit with no live move hold of its own and an open service.
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  appointmentSendHeld: jest.fn(async () => false),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentEmail = require('../services/appointment-email');
const AppointmentReminders = require('../services/appointment-reminders');

const HOUR = 3600000;
const CUSTOMER = { id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', phone: '+19415551234', line_type: 'mobile' };

// Tuesday 2026-11-10 14:00Z = 09:00 ET: inside the 8 AM - 8 PM send window.
const NOW = new Date('2026-11-10T14:00:00.000Z');

let row;
let prefsRow = null;

// The one reminder row. Object wheres are matched against it; function wheres (the scan's
// flag and hold predicates) are not evaluated: the loop re-checks the flags itself.
function reminderTable() {
  const filters = [];
  const chain = {};
  const matches = () => filters.every(([key, value]) => row[key] === value
    || (value instanceof Date && row[key] instanceof Date && row[key].getTime() === value.getTime()));
  chain.where = (arg, ...rest) => {
    if (arg && typeof arg === 'object') filters.push(...Object.entries(arg));
    else if (typeof arg === 'string' && rest.length === 1) filters.push([arg, rest[0]]);
    return chain; // comparisons (created_at < x) and function predicates are not evaluated
  };
  for (const name of ['orWhere', 'whereNull', 'whereRaw', 'whereNotNull', 'whereNotExists', 'whereIn', 'andWhere', 'whereExists', 'from', 'leftJoin', 'orderBy']) {
    chain[name] = () => chain;
  }
  chain.select = async () => (matches() ? [row] : []);
  chain.first = async () => (matches() ? row : undefined);
  chain.update = async (patch) => {
    if (!matches()) return 0;
    Object.assign(row, patch);
    return 1;
  };
  return chain;
}

function plainTable(firstValue) {
  const chain = {};
  for (const name of ['where', 'whereNull', 'whereRaw', 'whereNotNull', 'whereNotExists', 'whereIn', 'orWhere', 'from', 'leftJoin', 'orderBy', 'andWhere']) {
    chain[name] = () => chain;
  }
  chain.select = async () => [];
  chain.first = async () => firstValue;
  chain.update = async () => 1;
  return chain;
}

function reminderRow(hoursOut, overrides = {}) {
  return {
    id: 'rem-1',
    customer_id: 'cust-1',
    scheduled_service_id: 'svc-1',
    service_type: 'Pest Control',
    appointment_time: new Date(NOW.getTime() + hoursOut * HOUR),
    created_at: new Date(NOW.getTime() - 300 * HOUR),
    cancelled: false,
    windows_preclosed: false,
    suppressed_by_sibling: false,
    // The state a burst of repeat moves leaves: the confirmation re-armed, the hold lapsed,
    // handleReschedule's sync left both windows pending.
    confirmation_sent: false,
    reminder_72h_sent: false,
    reminder_24h_sent: false,
    move_hold_until: new Date(NOW.getTime() - 60 * 1000),
    move_hold_token: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prefsRow = null;
  jest.useFakeTimers().setSystemTime(NOW);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.transaction = jest.fn(async (run) => run(db));
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return reminderTable();
    if (table === 'scheduled_services') return plainTable({ customer_id: 'cust-1', status: 'confirmed', tech_name: null, visit_id: null });
    if (table === 'customers') return plainTable(CUSTOMER);
    if (table === 'notification_prefs') return plainTable(prefsRow);
    return plainTable(null);
  });
  jest.spyOn(AppointmentReminders, 'selfHealMissingReminderRows').mockResolvedValue({ healed: 0 });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('a deferred confirmation of a coalesced reschedule', () => {
  test('a burst of moves to about 48 h out: after the hold lapses, one pass sends exactly one text', async () => {
    row = reminderRow(48);

    const results = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(results.sent72h).toBe(0);
    // The confirmation covered the window it made redundant, and the spent hold is gone.
    expect(row).toMatchObject({ confirmation_sent: true, reminder_72h_sent: true, move_hold_until: null });
  });

  test('control: an ordinary confirmation of the same visit (no coalesced hold) still leaves the 72 h reminder to follow', async () => {
    row = reminderRow(48, { move_hold_until: null });

    await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('a grouped-move hold (it carries a token) is not read as a coalesced notice', async () => {
    row = reminderRow(48, { move_hold_token: 'hold-token-1' });

    await AppointmentReminders.checkAndSendReminders();

    expect(row.move_hold_token).toBe('hold-token-1');
    expect(row.reminder_72h_sent).toBe(true); // the 72h reminder itself went out, after the confirmation
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('a visit more than 72 h out keeps its 72 h reminder for later', async () => {
    row = reminderRow(96);

    await AppointmentReminders.checkAndSendReminders();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // the deferred confirmation only
    expect(row).toMatchObject({ confirmation_sent: true, reminder_72h_sent: false, move_hold_until: null });

    // 26 hours on the visit is 70 h away: the 72 h reminder is due and goes out once.
    jest.setSystemTime(new Date(NOW.getTime() + 26 * HOUR));
    const later = await AppointmentReminders.checkAndSendReminders();
    expect(later.sent72h).toBe(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(row.reminder_72h_sent).toBe(true);
  });

  test('a visit tomorrow: the confirmation also covers the day-before window, so no 24 h text follows', async () => {
    row = reminderRow(20);

    await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ reminder_72h_sent: true, reminder_24h_sent: true });
  });

  describe('email-only customer', () => {
    const emailKeys = () => AppointmentEmail.sendAppointmentConfirmationEmail.mock.calls.map(([args]) => args.idempotencyKey);
    beforeEach(() => { prefsRow = { appointment_confirmation_channel: 'email', appointment_confirmation_channel_explicit: true }; });

    test('the deferred email has its own key: moving A, B, then back to A inside the window does not dedupe against the first A email', async () => {
      // First confirmation of slot A, sent as an ordinary one days ago: no coalesced hold on the row.
      row = reminderRow(96, { move_hold_until: null });
      await AppointmentReminders.checkAndSendReminders();
      // The customer moves to B and back to A inside the window: the burst re-arms the same slot A.
      const slotA = row.appointment_time;
      row = reminderRow(96, { appointment_time: slotA, move_hold_until: new Date(NOW.getTime() - 60 * 1000) });
      await AppointmentReminders.checkAndSendReminders();

      const [ordinary, deferred] = emailKeys();
      expect(ordinary).toBeUndefined(); // the default visit + slot key, as before the gate
      expect(deferred).toMatch(/^appointment\.confirmation:svc-1:\d+:coalesced:\d+$/);
    });

    test('a retry of the same deferred notice keeps its key, a later burst gets another', async () => {
      const hold = new Date(NOW.getTime() - 60 * 1000);
      row = reminderRow(96, { move_hold_until: hold });
      await AppointmentReminders.checkAndSendReminders();
      row = reminderRow(96, { move_hold_until: hold });
      await AppointmentReminders.checkAndSendReminders();
      row = reminderRow(96, { move_hold_until: new Date(NOW.getTime() - 2 * 60 * 1000) });
      await AppointmentReminders.checkAndSendReminders();

      const [first, retry, laterBurst] = emailKeys();
      expect(retry).toBe(first);
      expect(laterBurst).not.toBe(first);
    });
  });
});
