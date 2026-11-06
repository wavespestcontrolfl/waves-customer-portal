// GATE_DAY_ONLY_PROMISE part B1 (owner 2026-11-05 "D2 a", 2026-11-06 "office"): the booking confirmation and the
// 72-hour reminder promise only the DAY when the decision says so, record DAY_PROMISE_META, and fall back to today's
// window copy otherwise. The senders run for real (the stranded-confirmation sweep and the reminder scan, like
// appointment-reminders-coalesced-notice.test.js and reminder-72h-no-reply.test.js); the time-promise DECISION is stubbed
// here (its rules are pinned in day-only-promise-b1-eligibility.test.js) and the outbound layer is stubbed, so nothing is
// sent. Synthetic data only.
process.env.GATE_SMS_SEND_WINDOW = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
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
  getTemplate: jest.fn(),
  REQUIRED_TEMPLATE_PLACEHOLDERS: {
    reminder_72h_no_reply_v1: ['date', 'window'],
    appointment_confirmation_day_v2: ['date', 'day'],
    appointment_confirmation_day_v1: ['date', 'day'],
    reminder_72h_day_v1: ['date', 'day'],
    reminder_72h_no_reply_day_v1: ['date', 'day'],
  },
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
  cardHoldReminderNote: jest.fn(async () => ''),
}));
jest.mock('../services/reschedule-link', () => ({
  ...jest.requireActual('../services/reschedule-link'),
  buildRescheduleLink: jest.fn(),
}));
jest.mock('../services/appointment-link', () => ({
  buildAppointmentLink: jest.fn(async () => ({ line: 'See your visit: portal.example.test/a/abc123' })),
}));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  claimVisitNotification: jest.fn(),
  finalizeVisitNotification: jest.fn(async () => ({ ok: true })),
  renewNotificationLease: jest.fn(async () => true),
  notificationLeaseLive: jest.fn(async () => true),
  windowedMembersConnected: jest.fn(() => true),
  appointmentSendHeld: jest.fn(async () => false),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/time-promise', () => ({
  ...jest.requireActual('../services/time-promise'),
  dayOnlySendDecision: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');
const { buildRescheduleLink, dayOnlyLineFor } = require('../services/reschedule-link');
const AppointmentEmail = require('../services/appointment-email');
const AppointmentReminders = require('../services/appointment-reminders');
const timePromise = require('../services/time-promise');
const detector = require('../services/no-show-detector');
const { persistAudit } = require('../services/messaging/audit');

const { DAY_PROMISE_META } = timePromise;
const { render72hReminder } = AppointmentReminders._test;
const HOUR = 3600000;
const LINK = 'https://portal.wavespestcontrol.com/l/k3j9m2x7qp';
const CUSTOMER = { id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', phone: '+19415551234', line_type: 'mobile' };
const DAY_YES = { dayOnly: true, level: 'none', eligible: true };
const DAY_NO = { dayOnly: false, level: 'none', eligible: false };

let enabled;
let prefsRow;
const OLD_GATE = process.env.GATE_DAY_ONLY_PROMISE;
const OLD_PAGE = process.env.GATE_APPOINTMENT_PAGE;

function restoreEnv(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

beforeEach(() => {
  jest.clearAllMocks();
  prefsRow = null;
  enabled = new Set();
  smsTemplates.getTemplate.mockImplementation(async (key) => (enabled.has(key) ? `rendered:${key}` : null));
  buildRescheduleLink.mockResolvedValue({ url: LINK, line: `Reschedule here: ${LINK}\n\n` });
  timePromise.dayOnlySendDecision.mockResolvedValue(DAY_YES);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.transaction = jest.fn(async (run) => run(db));
  process.env.GATE_DAY_ONLY_PROMISE = 'true';
  delete process.env.GATE_APPOINTMENT_PAGE;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  restoreEnv('GATE_DAY_ONLY_PROMISE', OLD_GATE);
  restoreEnv('GATE_APPOINTMENT_PAGE', OLD_PAGE);
});

const templateCall = (key) => smsTemplates.getTemplate.mock.calls.find(([k]) => k === key);
const rendered = () => smsTemplates.getTemplate.mock.calls.map(([key]) => key);
const sends = () => sendCustomerMessage.mock.calls.map(([input]) => input);

// ── the booking confirmation ────────────────────────────────────────────────
describe('the booking confirmation', () => {
  const NOW = new Date('2026-11-10T14:00:00.000Z'); // 09:00 ET Tuesday, inside the send window
  let row;

  function reminderTable() {
    const filters = [];
    const chain = {};
    const matches = () => filters.every(([key, value]) => row[key] === value
      || (value instanceof Date && row[key] instanceof Date && row[key].getTime() === value.getTime()));
    chain.where = (arg, ...rest) => {
      if (arg && typeof arg === 'object') filters.push(...Object.entries(arg));
      else if (typeof arg === 'string' && rest.length === 1) filters.push([arg, rest[0]]);
      return chain;
    };
    for (const name of ['orWhere', 'whereNull', 'whereRaw', 'whereNotNull', 'whereNotExists', 'whereIn', 'andWhere', 'whereExists', 'from', 'leftJoin', 'orderBy']) {
      chain[name] = () => chain;
    }
    chain.select = async () => (matches() ? [row] : []);
    chain.first = async () => (matches() ? row : undefined);
    chain.update = async (patch) => { if (!matches()) return 0; Object.assign(row, patch); return 1; };
    return chain;
  }
  function plainTable(firstValue) {
    const chain = {};
    for (const name of ['where', 'whereNull', 'whereRaw', 'whereNotNull', 'whereNotExists', 'whereIn', 'orWhere', 'from', 'leftJoin', 'orderBy', 'andWhere']) chain[name] = () => chain;
    chain.select = async () => [];
    chain.first = async () => firstValue;
    chain.update = async () => 1;
    return chain;
  }
  const visit = (hoursOut, over = {}) => ({
    id: 'rem-1', customer_id: 'cust-1', scheduled_service_id: 'svc-1', service_type: 'Pest Control',
    appointment_time: new Date(NOW.getTime() + hoursOut * HOUR), created_at: new Date(NOW.getTime() - 300 * HOUR),
    cancelled: false, windows_preclosed: false, suppressed_by_sibling: false,
    confirmation_sent: false, reminder_72h_sent: false, reminder_24h_sent: false, move_hold_until: null, move_hold_token: null, ...over,
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    enabled = new Set(['appointment_confirmation', 'appointment_confirmation_v2', 'appointment_confirmation_day_v1', 'appointment_confirmation_day_v2']);
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderTable();
      if (table === 'scheduled_services') return plainTable({ customer_id: 'cust-1', status: 'confirmed', tech_name: null, visit_id: null });
      if (table === 'customers') return plainTable(CUSTOMER);
      if (table === 'notification_prefs') return plainTable(prefsRow);
      return plainTable(null);
    });
    jest.spyOn(AppointmentReminders, 'selfHealMissingReminderRows').mockResolvedValue({ healed: 0 });
  });

  const run = async (hoursOut, over) => {
    row = visit(hoursOut, over);
    await AppointmentReminders.checkAndSendReminders();
    return sends()[0];
  };

  test('gate on, decision day-only: the day row renders (base ladder), with the day line and no hour var', async () => {
    const send = await run(150);
    expect(sends()).toHaveLength(1);
    expect(rendered()).toEqual(['appointment_confirmation_day_v1']);
    const [, vars, context, opts] = templateCall('appointment_confirmation_day_v1');
    expect(vars).toEqual({
      first_name: 'Ada', service_type: 'Pest Control', day: 'Monday', date: 'November 16',
      reschedule_line: dayOnlyLineFor(LINK),
    });
    expect(vars).not.toHaveProperty('window');
    expect(vars).not.toHaveProperty('time');
    expect(context).toMatchObject({ workflow: 'appointment_confirmation', entity_id: 'svc-1' });
    expect(opts).toEqual({ requiredVars: ['date', 'day'] });
    expect(send.body).toBe('rendered:appointment_confirmation_day_v1');
    expect(row.confirmation_sent).toBe(true);
  });

  test('the send records DAY_PROMISE_META and the day row\'s key, and no rendered_slot_ms', async () => {
    const send = await run(150);
    expect(send.metadata).toEqual({
      original_message_type: 'confirmation', templateKey: 'appointment_confirmation_day_v1', scheduled_service_id: 'svc-1',
      ...DAY_PROMISE_META, guard_slot_ms: NOW.getTime() + 150 * HOUR, promised_date: '2026-11-16', useCustomerChannel: true,
    });
    // The canonical sender keeps the slot to guard the send but is told the body quoted no window, so the audit drops it.
    expect(send.renderedSlotMs).toBe(NOW.getTime() + 150 * HOUR);
    expect(send.promisedWindowUnknown).toBe(true);
    expect(send.purpose).toBe('appointment_confirmation');
  });

  test('the appointment-page ladder uses appointment_confirmation_day_v2 with the appointment line and no window', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    await run(150);
    expect(rendered()).toEqual(['appointment_confirmation_day_v2']);
    const [, vars] = templateCall('appointment_confirmation_day_v2');
    expect(vars).toEqual({
      first_name: 'Ada', service_type: 'Pest Control', day: 'Monday', date: 'November 16',
      appointment_line: 'See your visit: portal.example.test/a/abc123',
    });
  });

  test('through the real audit row builder, the stored row keeps the marker and drops the slot, and the reader reads level day', async () => {
    const send = await run(150);
    const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'a1' }]) }));
    db.mockImplementationOnce(() => ({ insert }));
    await persistAudit({
      input: { ...send, to: CUSTOMER.phone, audience: 'customer', channel: 'sms', appointmentId: 'svc-1' },
      validatorsPassed: [], validatorsFailed: [], blockedBy: null, providerOutcome: null,
    });
    const stored = insert.mock.calls[0][0].metadata;
    expect(stored).toMatchObject({ promise_level: 'day', window_unknown: true });
    expect(stored).not.toHaveProperty('rendered_slot_ms');
    const conn = (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere', 'whereIn']) chain[m] = () => chain;
      chain.select = async () => (table === 'messaging_audit_log as a'
        ? [{ id: 1, appointment_id: 'svc-1', purpose: 'appointment_confirmation', sent_at: '2026-11-10T14:00:01Z', metadata: stored }] : []);
      return chain;
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    const events = await detector.loadPromiseEvents(conn, ['svc-1'], { now: new Date('2026-11-10T15:00:00Z') });
    expect(events[0]).toMatchObject({ visit_id: 'svc-1', start_at: null, level: 'day' });
  });

  test('the decision is asked with the visit, its start and the customer\'s 24-hour preference', async () => {
    prefsRow = { sms_enabled: true, service_reminder_24h: false };
    await run(150);
    expect(timePromise.dayOnlySendDecision).toHaveBeenCalledTimes(1);
    const [conn, arg] = timePromise.dayOnlySendDecision.mock.calls[0];
    expect(conn).toBe(db);
    expect(arg).toMatchObject({ id: 'svc-1', reminder24hEnabled: false });
    expect(arg.startAt.getTime()).toBe(NOW.getTime() + 150 * HOUR);
  });

  test('decision says no (a customer pick, or ineligible): today\'s row and today\'s metadata', async () => {
    timePromise.dayOnlySendDecision.mockResolvedValue(DAY_NO);
    const send = await run(150);
    expect(rendered()).toEqual(['appointment_confirmation']);
    expect(send.metadata).toEqual({
      original_message_type: 'confirmation', templateKey: 'appointment_confirmation', scheduled_service_id: 'svc-1',
      rendered_slot_ms: NOW.getTime() + 150 * HOUR, useCustomerChannel: true,
    });
    expect(send).not.toHaveProperty('promisedWindowUnknown');
  });

  test('the day row missing or disabled: today\'s window copy goes out, with today\'s metadata, and a warning is logged', async () => {
    enabled.delete('appointment_confirmation_day_v1');
    const send = await run(150);
    expect(rendered()).toEqual(['appointment_confirmation_day_v1', 'appointment_confirmation']);
    expect(send.body).toBe('rendered:appointment_confirmation');
    expect(send.metadata).toMatchObject({ templateKey: 'appointment_confirmation', rendered_slot_ms: NOW.getTime() + 150 * HOUR });
    expect(send.metadata).not.toHaveProperty('promise_level');
    expect(send.metadata).not.toHaveProperty('window_unknown');
    expect(send).not.toHaveProperty('promisedWindowUnknown');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('appointment_confirmation_day_v1'));
    expect(row.confirmation_sent).toBe(true);
  });

  test('gate off: the decision is never asked, and the text is byte-for-byte today\'s', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const send = await run(150);
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
    expect(rendered()).toEqual(['appointment_confirmation']);
    const [, vars] = templateCall('appointment_confirmation');
    expect(vars).toEqual({
      first_name: 'Ada', service_type: 'Pest Control', date: 'November 16', time: '3:00 PM', day: 'Monday',
      reschedule_line: `Reschedule here: ${LINK}\n\n`,
    });
    expect(send.body).toBe('rendered:appointment_confirmation');
    expect(send.metadata).toEqual({
      original_message_type: 'confirmation', templateKey: 'appointment_confirmation', scheduled_service_id: 'svc-1',
      rendered_slot_ms: NOW.getTime() + 150 * HOUR, useCustomerChannel: true,
    });
    expect(Object.keys(send).sort()).not.toContain('promisedWindowUnknown');
  });

  describe('the 24-hour reminder must really be sendable (Codex P1-3)', () => {
    const asked = () => timePromise.dayOnlySendDecision.mock.calls[0][1].reminder24hEnabled;

    test('texts off + the 24-hour channel is text: the decision is told the reminder will NOT go (window copy follows)', async () => {
      prefsRow = { sms_enabled: false, service_reminder_24h: true, service_reminder_24h_channel: 'sms' };
      await run(150);
      expect(asked()).toBe(false);
    });

    test('an email-only customer (texts off, 24-hour channel email): the reminder will go, so the day is allowed', async () => {
      prefsRow = { sms_enabled: false, email_enabled: true, service_reminder_24h: true, service_reminder_24h_channel: 'email' };
      await run(150);
      expect(asked()).toBe(true);
    });

    test('texts on and the default channel: allowed', async () => {
      await run(150);
      expect(asked()).toBe(true);
    });

    test('the service-contact replay asks with the same predicate, and unreadable preferences are false without asking', async () => {
      const apptTime = new Date(NOW.getTime() + 150 * HOUR);
      prefsRow = { sms_enabled: false, service_reminder_24h: true, service_reminder_24h_channel: 'sms' };
      await AppointmentReminders._test.dayOnlyNow({ customerId: 'cust-1', scheduledServiceId: 'svc-1', apptTime });
      expect(asked()).toBe(false);
      jest.clearAllMocks();
      timePromise.dayOnlySendDecision.mockResolvedValue(DAY_YES);
      prefsRow = { sms_enabled: false, email_enabled: true, service_reminder_24h: true, service_reminder_24h_channel: 'email' };
      expect(await AppointmentReminders._test.dayOnlyNow({ customerId: 'cust-1', scheduledServiceId: 'svc-1', apptTime })).toBe(true);
      expect(asked()).toBe(true);
    });
  });

  describe('with the real decision', () => {
    beforeEach(() => {
      timePromise.dayOnlySendDecision.mockImplementation(jest.requireActual('../services/time-promise').dayOnlySendDecision);
    });

    test('a visit booked for tomorrow (inside the cutoff) gets today\'s window confirmation, and it still covers the 24-hour text', async () => {
      const send = await run(20);
      expect(rendered()).toEqual(['appointment_confirmation']);
      expect(send.metadata).not.toHaveProperty('promise_level');
      expect(row).toMatchObject({ confirmation_sent: true, reminder_24h_sent: true });
    });

    test('the customer turned the 24-hour reminder off: the window confirmation', async () => {
      prefsRow = { sms_enabled: true, service_reminder_24h: false };
      await run(150);
      expect(rendered()).toEqual(['appointment_confirmation']);
    });
  });

  test('a day-only confirmation for a visit that is tomorrow by the calendar does NOT close its 24-hour text', async () => {
    // 30 h out is Wednesday afternoon ET; "tomorrow" by date, so a window confirmation would close the 24-hour reminder.
    // The day-only text gave no window, so that reminder still owes it.
    await run(30);
    expect(rendered()[0]).toBe('appointment_confirmation_day_v1');
    expect(row).toMatchObject({ confirmation_sent: true, reminder_24h_sent: false });
  });

  test('a day-only confirmation tells the email the same story; a window fallback turns the email window too', async () => {
    prefsRow = { sms_enabled: true, email_enabled: true, appointment_confirmation_channel: 'both' };
    await run(150);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail.mock.calls[0][0]).toMatchObject({ dayOnly: true });

    jest.clearAllMocks();
    enabled.delete('appointment_confirmation_day_v1');
    await run(150);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail.mock.calls[0][0]).not.toHaveProperty('dayOnly');
  });

  test('the stranded-confirmation sweep goes through the same decision (a resend is day-only too)', async () => {
    row = visit(150, { confirmation_sent: false });
    await AppointmentReminders.checkAndSendReminders();
    expect(timePromise.dayOnlySendDecision).toHaveBeenCalledTimes(1);
    expect(rendered()).toEqual(['appointment_confirmation_day_v1']);
  });

  test('a windowless placeholder (its reminder windows are pre-closed) is never day-only', async () => {
    const res = await AppointmentReminders._test.deliverConfirmation(
      visit(150, { windows_preclosed: true }), { scheduledServiceId: 'svc-1', customerId: 'cust-1', apptTime: new Date(NOW.getTime() + 150 * HOUR), serviceLabel: 'Pest Control' },
    ).catch(() => false);
    expect(res).toBe(true);
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
    expect(rendered()).toEqual(['appointment_confirmation']);
  });

  test('a decision that throws sends the window copy (the safe side)', async () => {
    timePromise.dayOnlySendDecision.mockRejectedValue(new Error('read failed'));
    await run(150);
    expect(rendered()).toEqual(['appointment_confirmation']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('day-only decision failed'));
  });
});

// ── the 72-hour reminder ────────────────────────────────────────────────────
describe('the 72-hour reminder', () => {
  const fixedNow = new Date('2026-05-06T14:00:00.000Z'); // 10:00 AM ET
  const reminderRow = () => ({
    id: 'rem-1', scheduled_service_id: 'svc-1', customer_id: 'customer-1',
    appointment_time: new Date('2026-05-08T13:00:00.000Z'), // 47 h out: inside the 72h band
    created_at: new Date('2026-05-01T13:00:00.000Z'), service_type: 'Quarterly Pest Control',
    cancelled: false, confirmation_sent: true, reminder_72h_sent: false, reminder_24h_sent: false,
  });
  const stamped = {
    status: 'confirmed', visit_id: null, tech_name: 'Sam', window_start: '09:00:00',
    customer_pick_by: new Date('2026-05-04T00:00:00Z'), last_auto_dispatch_at: new Date('2026-05-04T13:00:00Z'),
  };
  const plain = { ...stamped, customer_pick_by: null, last_auto_dispatch_at: null };

  function installDb({ svcRow }) {
    let arCalls = 0;
    const genericChain = (firstValue = null) => {
      const c = {
        where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(), whereNotNull: jest.fn().mockReturnThis(), whereExists: jest.fn().mockReturnThis(),
        whereNotExists: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
        join: jest.fn().mockReturnThis(), leftJoin: jest.fn().mockReturnThis(),
        modify: jest.fn((fn) => { fn(c); return c; }), whereRaw: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]), pluck: jest.fn().mockResolvedValue([]),
        first: jest.fn().mockResolvedValue(firstValue), update: jest.fn().mockResolvedValue(1),
        insert: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([]),
      };
      return c;
    };
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') {
        arCalls += 1;
        if (arCalls === 1) return genericChain();
        if (arCalls === 2) { const c = genericChain(); c.select = jest.fn().mockResolvedValue([reminderRow()]); return c; }
        const c = genericChain(null);
        c.first = jest.fn(async (...cols) => (cols[0] === 'id' ? reminderRow() : null));
        return c;
      }
      if (String(table).startsWith('scheduled_services')) { const c = genericChain(); c.first = jest.fn(async () => svcRow); return c; }
      if (table === 'notification_prefs') return genericChain(prefsRow || { sms_enabled: true, service_reminder_24h: true, service_reminder_72h: true });
      if (String(table).startsWith('customers')) return genericChain({ id: 'customer-1', first_name: 'Maria', phone: '+19415551212' });
      return genericChain();
    });
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    enabled = new Set(['reminder_72h', 'reminder_72h_no_reply_v1', 'reminder_72h_day_v1', 'reminder_72h_no_reply_day_v1']);
  });

  async function run(svcRow) {
    installDb({ svcRow });
    const result = await AppointmentReminders.checkAndSendReminders();
    return { result, send: sends()[0] };
  }

  test('decision day-only: the day row renders with the day line, no hour var, and DAY_PROMISE_META is recorded', async () => {
    const { result, send } = await run(plain);
    expect(result.sent72h).toBe(1);
    expect(rendered()).toEqual(['reminder_72h_day_v1']);
    const [, vars, , opts] = templateCall('reminder_72h_day_v1');
    expect(vars).toMatchObject({ first_name: 'Maria', service_type: 'Quarterly Pest Control', day: 'Friday', date: 'May 8', reschedule_line: dayOnlyLineFor(LINK), card_hold_policy_line: '' });
    expect(vars).not.toHaveProperty('window');
    expect(vars).not.toHaveProperty('time');
    expect(opts).toEqual({ requiredVars: ['date', 'day'] });
    expect(send.body).toBe('rendered:reminder_72h_day_v1');
    expect(send.purpose).toBe('appointment_reminder_72h');
    expect(send.metadata).toMatchObject({ original_message_type: 'reminder_72h', templateKey: 'reminder_72h_day_v1', ...DAY_PROMISE_META });
    expect(send.promisedWindowUnknown).toBe(true);
    expect(send.renderedSlotMs).toBe(reminderRow().appointment_time.getTime());
    // The occurrence guard (a bounced grouped text, a move since) rides beside the marker, never as a promise.
    expect(send.metadata).toMatchObject({ guard_slot_ms: reminderRow().appointment_time.getTime(), promised_date: '2026-05-08' });
    expect(send.metadata).not.toHaveProperty('rendered_slot_ms');
  });

  test('the 72-hour decision uses the 24-hour reminder\'s own predicate: texts off + text channel is false; an email-only customer is true', async () => {
    prefsRow = { sms_enabled: false, service_reminder_24h: true, service_reminder_72h: true, service_reminder_24h_channel: 'sms', service_reminder_72h_channel: 'email', email_enabled: true };
    await run(plain);
    expect(timePromise.dayOnlySendDecision.mock.calls[0][1].reminder24hEnabled).toBe(false);
    jest.clearAllMocks();
    smsTemplates.getTemplate.mockImplementation(async (key) => (enabled.has(key) ? `rendered:${key}` : null));
    buildRescheduleLink.mockResolvedValue({ url: LINK, line: `Reschedule here: ${LINK}\n\n` });
    timePromise.dayOnlySendDecision.mockResolvedValue(DAY_YES);
    prefsRow = { sms_enabled: false, service_reminder_24h: true, service_reminder_72h: true, service_reminder_24h_channel: 'email', service_reminder_72h_channel: 'email', email_enabled: true };
    await run(plain);
    expect(timePromise.dayOnlySendDecision.mock.calls[0][1].reminder24hEnabled).toBe(true);
  });

  test('the decision is asked with the visit, its start and the 24-hour preference', async () => {
    await run(plain);
    const [conn, arg] = timePromise.dayOnlySendDecision.mock.calls[0];
    expect(conn).toBe(db);
    expect(arg).toMatchObject({ id: 'svc-1', reminder24hEnabled: true });
    expect(arg.startAt.getTime()).toBe(reminderRow().appointment_time.getTime());
  });

  test('the no-pick case: the no-reply day row, without "Want a different time?" in front of the link', async () => {
    const { send } = await run(stamped);
    expect(rendered()).toEqual(['reminder_72h_no_reply_day_v1']);
    const [, vars] = templateCall('reminder_72h_no_reply_day_v1');
    expect(vars.reschedule_line).toBe(dayOnlyLineFor(LINK));
    expect(vars.reschedule_line).not.toMatch(/Want a different time/);
    expect(send.metadata).toMatchObject({ templateKey: 'reminder_72h_no_reply_day_v1', ...DAY_PROMISE_META });
  });

  test('no-pick with its day row missing: the base day row; both day rows missing: today\'s window rows', async () => {
    enabled.delete('reminder_72h_no_reply_day_v1');
    await run(stamped);
    expect(rendered()).toEqual(['reminder_72h_no_reply_day_v1', 'reminder_72h_day_v1']);
    expect(sends()[0].metadata).toMatchObject({ templateKey: 'reminder_72h_day_v1', ...DAY_PROMISE_META });

    jest.clearAllMocks();
    smsTemplates.getTemplate.mockImplementation(async (key) => (enabled.has(key) ? `rendered:${key}` : null));
    buildRescheduleLink.mockResolvedValue({ url: LINK, line: `Reschedule here: ${LINK}\n\n` });
    enabled.delete('reminder_72h_day_v1');
    await run(stamped);
    expect(rendered()).toEqual(['reminder_72h_no_reply_day_v1', 'reminder_72h_day_v1', 'reminder_72h_no_reply_v1']);
    const send = sends()[0];
    expect(send.body).toBe('rendered:reminder_72h_no_reply_v1');
    expect(send.metadata).toMatchObject({ templateKey: 'reminder_72h_no_reply_v1' });
    expect(send.metadata).not.toHaveProperty('promise_level');
    expect(send.metadata).not.toHaveProperty('window_unknown');
    expect(send.metadata).not.toHaveProperty('guard_slot_ms');
    expect(send.metadata).not.toHaveProperty('promised_date');
    expect(send.metadata.rendered_slot_ms).toBe(reminderRow().appointment_time.getTime());
    expect(send).not.toHaveProperty('promisedWindowUnknown');
  });

  test('the base day row missing: today\'s base window row, with a warning', async () => {
    enabled.delete('reminder_72h_day_v1');
    const { send } = await run(plain);
    expect(rendered()).toEqual(['reminder_72h_day_v1', 'reminder_72h']);
    expect(send.body).toBe('rendered:reminder_72h');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reminder_72h_day_v1'));
  });

  test('decision says no (a customer pick, an hour already told, a grouped stop with an ineligible member): window copy, today\'s metadata', async () => {
    timePromise.dayOnlySendDecision.mockResolvedValue(DAY_NO);
    const { send } = await run(plain);
    expect(rendered()).toEqual(['reminder_72h']);
    const [, vars] = templateCall('reminder_72h');
    expect(vars).toMatchObject({ window: expect.stringContaining('between'), time: expect.any(String), reschedule_line: `Reschedule here: ${LINK}\n\n` });
    expect(send.metadata).toEqual({
      original_message_type: 'reminder_72h', templateKey: 'reminder_72h', scheduled_service_id: 'svc-1', visit_id: null,
      rendered_slot_ms: reminderRow().appointment_time.getTime(), useCustomerChannel: true,
    });
  });

  test('gate off: byte-for-byte today (the decision is never asked; the no-pick row keeps its prefix)', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const { send } = await run(stamped);
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
    expect(rendered()).toEqual(['reminder_72h_no_reply_v1']);
    const [, vars, , opts] = templateCall('reminder_72h_no_reply_v1');
    expect(vars.reschedule_line).toBe(`Want a different time? Reschedule here: ${LINK}\n\n`);
    expect(opts).toEqual({ requiredVars: ['date', 'window'] });
    expect(send.metadata).toEqual({
      original_message_type: 'reminder_72h', templateKey: 'reminder_72h_no_reply_v1', scheduled_service_id: 'svc-1', visit_id: null,
      rendered_slot_ms: reminderRow().appointment_time.getTime(), useCustomerChannel: true,
    });
  });

  test('the app notification and the text are one render: the push row carries the same marker, and the reader reads level day', async () => {
    const { send } = await run(plain);
    // sendCustomerMessage routes the same body and metadata to the app (push) or the text; both write the audit row below.
    const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'a2' }]) }));
    db.mockImplementationOnce(() => ({ insert }));
    await persistAudit({
      input: { ...send, to: '+19415551212', audience: 'customer', channel: 'sms', appointmentId: 'svc-1' },
      validatorsPassed: [], validatorsFailed: [], blockedBy: null,
      providerOutcome: { provider: 'push', providerMessageId: 'push-1', sentAt: '2026-05-06T14:00:01Z', deliveryOutcome: 'accepted' },
    });
    const row = insert.mock.calls[0][0];
    expect(row.provider).toBe('push');
    expect(row.metadata).toMatchObject({ promise_level: 'day', window_unknown: true });
    expect(row.metadata).not.toHaveProperty('rendered_slot_ms');
    const conn = (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere', 'whereIn']) chain[m] = () => chain;
      chain.select = async () => (table === 'messaging_audit_log as a'
        ? [{ id: 2, appointment_id: 'svc-1', purpose: 'appointment_reminder_72h', sent_at: '2026-05-06T14:00:01Z', metadata: row.metadata }] : []);
      return chain;
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    const events = await detector.loadPromiseEvents(conn, ['svc-1'], { now: new Date('2026-05-06T15:00:00Z') });
    expect(events[0]).toMatchObject({ start_at: null, level: 'day' });
  });

  test('a day text and its email tell the same story; a text that fell back to the window copy turns the email window too', async () => {
    prefsRow = { sms_enabled: true, email_enabled: true, service_reminder_24h: true, service_reminder_72h: true, service_reminder_72h_channel: 'both' };
    await run(plain);
    expect(AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0]).toMatchObject({ kind: '72h', dayOnly: true });

    jest.clearAllMocks();
    smsTemplates.getTemplate.mockImplementation(async (key) => (enabled.has(key) ? `rendered:${key}` : null));
    buildRescheduleLink.mockResolvedValue({ url: LINK, line: `Reschedule here: ${LINK}\n\n` });
    timePromise.dayOnlySendDecision.mockResolvedValue(DAY_YES);
    enabled.delete('reminder_72h_day_v1');
    await run(plain);
    expect(AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0]).not.toHaveProperty('dayOnly');
  });
});

describe('render72hReminder', () => {
  const vars = {
    first_name: 'Maria', service_type: 'Pest Control', day: 'Friday', date: 'May 8', time: '9:00 AM',
    window: 'between 9:00 AM and 11:00 AM', reschedule_line: `Reschedule here: ${LINK}\n\n`, card_hold_policy_line: '',
  };
  const context = { workflow: 'appointment_reminder_72h' };
  beforeEach(() => { enabled = new Set(['reminder_72h', 'reminder_72h_no_reply_v1', 'reminder_72h_day_v1', 'reminder_72h_no_reply_day_v1']); });

  test('window result keeps its exact shape (no dayOnly key)', async () => {
    expect(await render72hReminder({ vars, rescheduleUrl: LINK, context })).toEqual({ body: 'rendered:reminder_72h', templateKey: 'reminder_72h' });
  });

  test('a day result carries dayOnly: true', async () => {
    expect(await render72hReminder({ vars, rescheduleUrl: LINK, context, dayOnly: true }))
      .toEqual({ body: 'rendered:reminder_72h_day_v1', templateKey: 'reminder_72h_day_v1', dayOnly: true });
  });

  test('a link-less visit still gets the day line (how to reach someone)', async () => {
    await render72hReminder({ vars: { ...vars, reschedule_line: '' }, rescheduleUrl: null, context, dayOnly: true });
    expect(templateCall('reminder_72h_day_v1')[1].reschedule_line).toBe('Need a different day or a set time? Reply here or call.\n\n');
  });
});

describe('reminder24hWillSend: the 24-hour branch\'s own skip-and-close predicate', () => {
  const { reminder24hWillSend } = AppointmentReminders._test;
  const prefs = (over) => ({ unavailable: false, serviceReminder24h: true, reminder24hChannel: 'sms', smsEnabled: true, ...over });

  test.each([
    ['reminder on, texts on, text channel', {}, true],
    ['reminder off', { serviceReminder24h: false }, false],
    ['texts off + text channel (the branch skips and closes)', { smsEnabled: false }, false],
    ['texts off + email channel (it still sends by email)', { smsEnabled: false, reminder24hChannel: 'email' }, true],
    ['texts off + both channel', { smsEnabled: false, reminder24hChannel: 'both' }, true],
    ['texts off + app channel', { smsEnabled: false, reminder24hChannel: 'push' }, true],
    ['unreadable preferences', { unavailable: true }, false],
  ])('%s', (_label, over, expected) => {
    expect(reminder24hWillSend(prefs(over))).toBe(expected);
  });

  test('missing preferences: false', () => {
    expect(reminder24hWillSend(null)).toBe(false);
    expect(reminder24hWillSend(undefined)).toBe(false);
  });

  test('the 24-hour branch itself calls this function (one predicate, so they cannot drift)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
    expect(src).toContain('if (!reminder24hWillSend(prefs)) {');
    expect(src).not.toMatch(/!prefs\.serviceReminder24h \|\|/);
  });
});
