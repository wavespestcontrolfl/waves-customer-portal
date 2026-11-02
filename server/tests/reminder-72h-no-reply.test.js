/**
 * The 72-hour reminder for a visit Auto-Dispatch booked after the customer did
 * not pick a day (Quick Move "let the customer pick a day",
 * GATE_QUICKMOVE_CUSTOMER_PICK, owner 2026-11-01).
 *
 * Pins: the migration row (GSM-7, placeholders, segment cap, insert-if-absent),
 * the selection rule (customer_pick_by set AND last_auto_dispatch_at later AND
 * a window), the silent fallback to the base row, and that the message type,
 * purpose and dedupe key of the send do not change. The cron runs for real
 * against a table-dispatching db mock, like appointment-reminders-visit-dedupe.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: jest.fn(async () => ({ id: 'audit-test' })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
  REQUIRED_TEMPLATE_PLACEHOLDERS: { reminder_72h_no_reply_v1: ['date', 'window'] },
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
  cardHoldReminderNote: jest.fn(async () => ''),
}));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(),
  smsLineFor: (url) => (url ? `Reschedule here: ${url}\n\n` : ''),
}));
jest.mock('../services/visit-groups', () => ({
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

const db = require('../models/db');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { buildRescheduleLink } = require('../services/reschedule-link');
const AppointmentReminders = require('../services/appointment-reminders');
const migration = require('../models/migrations/20261102020000_reminder_72h_no_reply');
const { _test: { BODY, VARIABLES } } = migration;
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { isBookedAfterNoPick, render72hReminder, NO_PICK_REMINDER_KEY } = AppointmentReminders._test;

const BASE_BODY = 'Hi {first_name}, your Waves {service_type} is {day}, {date}, {window}.\n\n{reschedule_line}{card_hold_policy_line}';
const LINK = 'https://portal.wavespestcontrol.com/l/k3j9m2x7qp';
const placeholders = (body) => [...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

// Same substitution + send-time normalization the sender applies.
const render = (body, vars) => normalizeGsmPunctuation(stripSmsUrlScheme(
  body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? ''),
)).replace(/\n{3,}/g, '\n\n').trim();

const REFERENCE_VARS = {
  first_name: 'Maria',
  service_type: 'Quarterly Pest Control Service',
  day: 'Monday',
  date: 'November 9',
  window: 'between 9:00 AM and 11:00 AM',
  reschedule_line: `Want a different time? Reschedule here: ${LINK}\n\n`,
  card_hold_policy_line: '',
};

describe('migration 20261102020000 row', () => {
  test('renders the owner-approved wording', () => {
    expect(render(BODY, REFERENCE_VARS)).toBe(
      "Hi Maria, we didn't hear back, so we scheduled your Waves Quarterly Pest Control Service for Monday, November 9, between 9:00 AM and 11:00 AM.\n\nWant a different time? Reschedule here: portal.wavespestcontrol.com/l/k3j9m2x7qp",
    );
  });

  test('is GSM-7 and stays within the two-segment Quick Move cap (a held booking adds the fee line)', () => {
    expect(detectEncoding(BODY).encoding).toBe('GSM_7');
    expect(BODY).not.toMatch(/[–—‘’“”]/);
    expect(countSegments(render(BODY, REFERENCE_VARS))).toMatchObject({ encoding: 'GSM_7', segmentCount: 2 });
  });

  test('uses the base row placeholders in the same order, ending with the base row policy placeholders', () => {
    expect(placeholders(BODY)).toEqual(placeholders(BASE_BODY));
    // The declared list is the base row's (it adds {time} for admin edits; the sender passes it).
    expect(VARIABLES).toEqual(['first_name', 'service_type', 'day', 'date', 'time', 'window', 'reschedule_line', 'card_hold_policy_line']);
    expect(placeholders(BODY).every((name) => VARIABLES.includes(name))).toBe(true);
    expect(BODY.endsWith('{reschedule_line}{card_hold_policy_line}')).toBe(true);
    expect(BASE_BODY.endsWith('{reschedule_line}{card_hold_policy_line}')).toBe(true);
  });

  function fakeKnex(existingRows) {
    const inserted = [];
    const deleted = [];
    const k = (table) => {
      const q = { table, filter: {} };
      q.where = (f) => { q.filter = f; return q; };
      q.first = async () => existingRows.find((r) => Object.entries(q.filter).every(([c, v]) => r[c] === v));
      q.insert = async (row) => { inserted.push(row); };
      q.del = async () => { deleted.push(q.filter); };
      return q;
    };
    k.schema = { hasTable: async () => true };
    return { k, inserted, deleted };
  }

  test('inserts an active row in the base row category beside its sort order', async () => {
    const { k, inserted } = fakeKnex([{ template_key: 'reminder_72h', category: 'service', sort_order: 2 }]);
    await migration.up(k);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      template_key: 'reminder_72h_no_reply_v1',
      name: 'Reminder 72h - We Booked It (No Pick)',
      category: 'service',
      body: BODY,
      sort_order: 3,
      is_active: true,
    });
    expect(JSON.parse(inserted[0].variables)).toEqual(VARIABLES);
  });

  test('insert-if-absent: an existing (possibly edited or disabled) row is left alone; down deletes it', async () => {
    const { k, inserted, deleted } = fakeKnex([{ template_key: 'reminder_72h_no_reply_v1', body: 'edited', is_active: false }]);
    await migration.up(k);
    expect(inserted).toEqual([]);
    await migration.down(k);
    expect(deleted).toEqual([{ template_key: 'reminder_72h_no_reply_v1' }]);
  });

  test('the template registry requires the booked date and window', () => {
    const { REQUIRED_TEMPLATE_PLACEHOLDERS } = jest.requireActual('../routes/admin-sms-templates');
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.reminder_72h_no_reply_v1).toEqual(['date', 'window']);
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.reminder_72h_no_reply_v1.every((name) => BODY.includes(`{${name}}`))).toBe(true);
  });
});

describe('isBookedAfterNoPick', () => {
  const base = {
    customer_pick_by: new Date('2026-11-04T01:00:00Z'),
    last_auto_dispatch_at: new Date('2026-11-04T14:00:00Z'),
    window_start: '09:00:00',
  };
  test('true only for marker set + Auto-Dispatch stamp after it + a window', () => {
    expect(isBookedAfterNoPick(base)).toBe(true);
    expect(isBookedAfterNoPick({ ...base, customer_pick_by: '2026-11-04T01:00:00Z', last_auto_dispatch_at: '2026-11-04T01:00:01Z' })).toBe(true);
  });
  test.each([
    ['no marker', { customer_pick_by: null }],
    ['marker cleared (customer or staff moved it)', { customer_pick_by: undefined }],
    ['marker but no Auto-Dispatch stamp', { last_auto_dispatch_at: null }],
    ['stamp before the marker', { last_auto_dispatch_at: new Date('2026-11-03T20:00:00Z') }],
    ['stamp equal to the marker', { last_auto_dispatch_at: new Date('2026-11-04T01:00:00Z') }],
    ['no window', { window_start: null }],
    ['unreadable date', { last_auto_dispatch_at: 'not a date' }],
  ])('false: %s', (_label, patch) => {
    expect(isBookedAfterNoPick({ ...base, ...patch })).toBe(false);
  });
  test('false for a missing row', () => {
    expect(isBookedAfterNoPick(null)).toBe(false);
    expect(isBookedAfterNoPick(undefined)).toBe(false);
  });
});

describe('render72hReminder', () => {
  const vars = { ...REFERENCE_VARS, reschedule_line: `Reschedule here: ${LINK}\n\n` };
  const context = { workflow: 'appointment_reminder_72h' };
  beforeEach(() => {
    jest.clearAllMocks();
    smsTemplatesRouter.getTemplate.mockImplementation(async (key) => (key === 'reminder_72h_no_reply_v1' ? 'NO-PICK' : 'BASE'));
  });

  test('base visit: base row only, base vars untouched', async () => {
    const out = await render72hReminder({ noPick: false, vars, rescheduleUrl: LINK, context });
    expect(out).toEqual({ body: 'BASE', templateKey: 'reminder_72h' });
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledTimes(1);
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith('reminder_72h', vars, context);
  });

  test('no-pick visit: new row, required vars passed, "Want a different time?" in front of the link', async () => {
    const out = await render72hReminder({ noPick: true, vars, rescheduleUrl: LINK, context });
    expect(out).toEqual({ body: 'NO-PICK', templateKey: NO_PICK_REMINDER_KEY });
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledTimes(1);
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'reminder_72h_no_reply_v1',
      { ...vars, reschedule_line: `Want a different time? Reschedule here: ${LINK}\n\n` },
      context,
      { requiredVars: ['date', 'window'] },
    );
  });

  test('no-pick visit with no reschedule link: no dangling question', async () => {
    await render72hReminder({ noPick: true, vars: { ...vars, reschedule_line: '' }, rescheduleUrl: null, context });
    expect(smsTemplatesRouter.getTemplate.mock.calls[0][1].reschedule_line).toBe('');
  });

  test.each([
    ['missing or disabled (null)', async (key) => (key === 'reminder_72h_no_reply_v1' ? null : 'BASE')],
    ['render throws', async (key) => { if (key === 'reminder_72h_no_reply_v1') throw new Error('boom'); return 'BASE'; }],
  ])('new row %s: falls back to the base row with the original vars and warns', async (_label, impl) => {
    smsTemplatesRouter.getTemplate.mockImplementation(impl);
    const out = await render72hReminder({ noPick: true, vars, rescheduleUrl: LINK, context });
    expect(out).toEqual({ body: 'BASE', templateKey: 'reminder_72h' });
    expect(smsTemplatesRouter.getTemplate).toHaveBeenLastCalledWith('reminder_72h', vars, context);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reminder_72h_no_reply_v1'));
  });
});

// ── cron wiring ─────────────────────────────────────────────────────────────
const fixedNow = new Date('2026-05-06T14:00:00.000Z'); // 10:00 AM ET

const reminderRow = () => ({
  id: 'rem-1',
  scheduled_service_id: 'svc-1',
  customer_id: 'customer-1',
  appointment_time: new Date('2026-05-08T13:00:00.000Z'), // 47h out: inside the 72h band
  created_at: new Date('2026-05-01T13:00:00.000Z'),
  service_type: 'Quarterly Pest Control',
  cancelled: false,
  confirmation_sent: true,
  reminder_72h_sent: false,
  reminder_24h_sent: false,
});

function installDb({ svcRow }) {
  let arCalls = 0;
  const genericChain = (firstValue = null) => {
    const c = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      whereExists: jest.fn().mockReturnThis(),
      whereNotExists: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      join: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      modify: jest.fn((fn) => { fn(c); return c; }),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([]),
      pluck: jest.fn().mockResolvedValue([]),
      first: jest.fn().mockResolvedValue(firstValue),
      update: jest.fn().mockResolvedValue(1),
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
    };
    return c;
  };
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') {
      arCalls += 1;
      if (arCalls === 1) return genericChain();
      if (arCalls === 2) { const c = genericChain(); c.select = jest.fn().mockResolvedValue([reminderRow()]); return c; }
      // Move-hold read (null) and the send fence's current-row read (first('id')).
      const c = genericChain(null);
      c.first = jest.fn(async (...cols) => (cols[0] === 'id' ? reminderRow() : null));
      return c;
    }
    if (String(table).startsWith('scheduled_services')) {
      const c = genericChain();
      c.first = jest.fn(async () => svcRow);
      return c;
    }
    if (table === 'notification_prefs') {
      return genericChain({ sms_enabled: true, service_reminder_24h: true, service_reminder_72h: true });
    }
    if (String(table).startsWith('customers')) {
      return genericChain({ id: 'customer-1', first_name: 'Maria', phone: '+19415551212' });
    }
    return genericChain();
  });
  db.raw = jest.fn().mockResolvedValue();
  db.transaction = jest.fn(async (cb) => cb(db));
}

describe('72h cron selection', () => {
  const stamped = {
    status: 'confirmed', visit_id: null, tech_name: 'Sam', window_start: '09:00:00',
    customer_pick_by: new Date('2026-05-04T00:00:00Z'),
    last_auto_dispatch_at: new Date('2026-05-04T13:00:00Z'),
  };
  let enabled;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(fixedNow);
    enabled = { reminder_72h: true, reminder_72h_no_reply_v1: true };
    smsTemplatesRouter.getTemplate.mockImplementation(async (key) => (enabled[key] ? `rendered:${key}` : null));
    buildRescheduleLink.mockResolvedValue({ url: LINK, line: `Reschedule here: ${LINK}\n\n` });
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });
  afterEach(() => jest.useRealTimers());

  async function run(svcRow) {
    installDb({ svcRow });
    const result = await AppointmentReminders.checkAndSendReminders();
    const rendered = smsTemplatesRouter.getTemplate.mock.calls
      .filter(([key]) => String(key).startsWith('reminder_72h')).map(([key]) => key);
    return { result, rendered, sends: sendCustomerMessage.mock.calls.map(([input]) => input) };
  }

  test('marker set, Auto-Dispatch booked it after the deadline, window set: the new row renders and sends', async () => {
    const { result, rendered, sends } = await run(stamped);
    expect(result.sent72h).toBe(1);
    expect(rendered).toEqual(['reminder_72h_no_reply_v1']);
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toBe('rendered:reminder_72h_no_reply_v1');
    // Message type, purpose and dedupe are the base reminder's.
    expect(sends[0].metadata.original_message_type).toBe('reminder_72h');
    expect(sends[0].purpose).toBe('appointment_reminder_72h');
    expect(sends[0].metadata.templateKey).toBe('reminder_72h_no_reply_v1');
  });

  test.each([
    ['no marker', { customer_pick_by: null }],
    ['marker but no Auto-Dispatch stamp', { last_auto_dispatch_at: null }],
    ['stamp before the marker', { last_auto_dispatch_at: new Date('2026-05-03T13:00:00Z') }],
    ['marker cleared after a move', { customer_pick_by: null, last_auto_dispatch_at: new Date('2026-05-04T13:00:00Z') }],
    ['no window', { window_start: null }],
  ])('%s: the base row renders', async (_label, patch) => {
    const { result, rendered, sends } = await run({ ...stamped, ...patch });
    expect(result.sent72h).toBe(1);
    expect(rendered).toEqual(['reminder_72h']);
    expect(sends[0].body).toBe('rendered:reminder_72h');
    expect(sends[0].metadata.original_message_type).toBe('reminder_72h');
    expect(sends[0].purpose).toBe('appointment_reminder_72h');
    expect(sends[0].metadata.templateKey).toBe('reminder_72h');
  });

  test('new row disabled or missing: the base row sends instead, and nothing is skipped', async () => {
    enabled.reminder_72h_no_reply_v1 = false;
    const { result, rendered, sends } = await run(stamped);
    expect(result.sent72h).toBe(1);
    expect(rendered).toEqual(['reminder_72h_no_reply_v1', 'reminder_72h']);
    expect(sends[0].body).toBe('rendered:reminder_72h');
    expect(sends[0].metadata.templateKey).toBe('reminder_72h');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reminder_72h_no_reply_v1'));
  });
});
