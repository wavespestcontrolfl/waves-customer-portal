// GATE_DAY_ONLY_PROMISE part B1: the day-only booking confirmation and 72-hour reminder EMAILS. No hour anywhere, the
// day in the idempotency key's slot segment, the day marker (and no slot) on the interaction row, the event type the
// no-show detector reads, and today's window email when the day template is missing. Also the migration's template rows.
// Synthetic data only; the email library is stubbed, nothing is sent.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  appointmentSendHeld: jest.fn(async () => false), // no grouped move in flight: the slot guard is not under test here
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');
const detector = require('../services/no-show-detector');
const { DAY_PROMISE_META } = require('../services/time-promise');
const migration = require('../models/migrations/20261106120000_day_only_promise_templates');

const WHEN = '2026-11-15T14:00:00.000Z'; // 09:00 ET on a Sunday
const customerRow = {
  id: 'cust-1', account_id: 'acct-1', is_primary_profile: true, first_name: 'Rowan', last_name: 'Testcase',
  email: 'rowan@example.com', phone: '+19415550100', address_line1: '4410 Synthetic Palm Way', city: 'Bradenton', state: 'FL', zip: '34205',
};

let interactions;
function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const qb = { where: () => qb, select: () => qb, whereNull: () => qb, first: async () => customerRow };
      return qb;
    }
    if (table === 'notification_prefs') return { where: () => ({ first: async () => null }) };
    if (table === 'customer_interactions') return { insert: async (row) => { interactions.push(row); return [1]; } };
    if (table === 'appointment_reminders') return { where: () => ({ first: async () => null }) };
    if (table === 'scheduled_services') return { where: () => ({ first: async () => ({ scheduled_date: '2026-11-15', window_start: '09:00' }), leftJoin: () => ({ first: async () => ({ tech_name: 'Sam' }) }) }) };
    throw new Error(`unexpected db table ${table}`);
  });
}
const sent = () => EmailTemplates.sendTemplate.mock.calls.map(([arg]) => arg);
const logged = () => interactions.map((row) => JSON.parse(row.metadata));
const HOUR_WORDS = /scheduled start|\b\d{1,2}:\d{2}\b|\b(?:AM|PM)\b|two-hour/i;

beforeEach(() => {
  jest.clearAllMocks();
  interactions = [];
  mockDb();
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'em-1', provider_message_id: 'sg-1', sent_at: '2026-11-10T14:00:00.000Z' } });
});

describe('the day-only confirmation email', () => {
  const send = (extra = {}) => AppointmentEmail.sendAppointmentConfirmationEmail({
    customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Pest Control', ...extra,
  });

  test('uses the day template, keeps the event type, carries no hour in the payload', async () => {
    await send({ dayOnly: true });
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.confirmation_day');
    expect(logged()[0].event_type).toBe('appointment.confirmation');
    expect(call.payload).not.toHaveProperty('appointment_time');
    expect(call.payload.appointment_day).toBe('Sunday');
    expect(call.payload.appointment_date).toBe('November 15');
    expect(JSON.stringify(call.payload)).not.toMatch(/9:00|09:00/);
  });

  test('the idempotency key has the ET day in the slot segment, never the slot epoch', async () => {
    await send({ dayOnly: true });
    const key = sent()[0].idempotencyKey;
    expect(key).toMatch(/^appointment\.confirmation:ss1:day-2026-11-15:[0-9a-f]{16}$/); // + the recipient token
    expect(key).not.toContain(String(Date.parse(WHEN)));
    // The detector recovers a slot from the third segment only when it is numeric.
    expect(key.split(':')[2]).not.toMatch(/^[0-9]+$/);
    // A later time the same day is the same send; the next day is a new one.
    const again = await send({ dayOnly: true, appointmentTime: '2026-11-15T19:00:00.000Z' });
    expect(again.ok).toBe(true);
    expect(sent()[1].idempotencyKey).toBe(key);
    await send({ dayOnly: true, appointmentTime: '2026-11-16T14:00:00.000Z' });
    expect(sent()[2].idempotencyKey).toMatch(/^appointment\.confirmation:ss1:day-2026-11-16:/);
  });

  test('records the day marker and no slot on the interaction row; the move-hold guard still gets the slot', async () => {
    await send({ dayOnly: true });
    const [meta] = logged();
    expect(meta).toMatchObject({ event_type: 'appointment.confirmation', template_key: 'appointment.confirmation_day', promise_level: 'day', window_unknown: true });
    expect(meta).not.toHaveProperty('rendered_slot_ms');
  });

  test('the no-show reader turns that interaction row into level day with no slot', async () => {
    await send({ dayOnly: true });
    const [meta] = logged();
    const conn = fakeReaderConn({ emails: [{ id: 7, metadata: meta, created_at: '2026-11-10T14:00:00Z' }] });
    const events = await detector.loadPromiseEvents(conn, ['ss1'], { now: new Date('2026-11-11T00:00:00Z') });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visit_id: 'ss1', start_at: null, level: 'day', source: 'email' });
  });

  test('without dayOnly the window email is exactly as before (key, payload, metadata)', async () => {
    await send();
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.confirmation');
    expect(call.payload.appointment_time).toBe('9:00 AM');
    expect(call.idempotencyKey).toMatch(new RegExp(`^appointment\\.confirmation:ss1:${Date.parse(WHEN)}:`));
    expect(logged()[0]).toMatchObject({ event_type: 'appointment.confirmation', scheduled_service_id: 'ss1', rendered_slot_ms: Date.parse(WHEN) });
    expect(logged()[0]).not.toHaveProperty('promise_level');
  });

  test('a caller-supplied key (coalesced or grouped) is kept as given', async () => {
    await send({ dayOnly: true, idempotencyKey: 'appointment.confirmation:visit:v1:x' });
    expect(sent()[0].idempotencyKey).toMatch(/^appointment\.confirmation:visit:v1:x:/);
  });

  test.each([
    ['missing', Object.assign(new Error('active template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' })],
    ['disabled', Object.assign(new Error('email template is disabled'), { code: 'EMAIL_TEMPLATE_DISABLED' })],
  ])('a %s day template sends today\'s window email instead', async (_label, error) => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(error);
    const result = await send({ dayOnly: true });
    expect(result.ok).toBe(true);
    const calls = sent();
    expect(calls.map((c) => c.templateKey)).toEqual(['appointment.confirmation_day', 'appointment.confirmation']);
    expect(calls[1].payload.appointment_time).toBe('9:00 AM');
    expect(calls[1].idempotencyKey).toMatch(new RegExp(`^appointment\\.confirmation:ss1:${Date.parse(WHEN)}:`));
    expect(logger().warn).toHaveBeenCalledWith(expect.stringContaining('appointment.confirmation_day'));
  });

  test('any other failure is returned, not retried as a window email', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('provider down'), { code: 'PROVIDER_DOWN' }));
    const result = await send({ dayOnly: true });
    expect(result.ok).toBe(false);
    expect(sent()).toHaveLength(1);
  });
});

describe('the day-only 72-hour reminder email', () => {
  const send = (extra = {}) => AppointmentEmail.sendAppointmentReminderEmail({
    customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Pest Control', kind: '72h', ...extra,
  });

  test('uses the day template with the 72h event type, no hour, the card-hold note and the day key', async () => {
    await send({ dayOnly: true, cardHoldPolicyNote: 'A fee may apply.' });
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.reminder_72h_day');
    expect(call.payload).not.toHaveProperty('appointment_time');
    expect(call.payload.card_hold_policy_note).toBe('A fee may apply.');
    expect(call.idempotencyKey).toMatch(/^appointment\.reminder_72h:ss1:day-2026-11-15:/);
    expect(call.triggerEventId).toBe('appointment.reminder_72h:ss1');
    expect(logged()[0]).toMatchObject({ event_type: 'appointment.reminder_72h', ...DAY_PROMISE_META });
    expect(logged()[0]).not.toHaveProperty('rendered_slot_ms');
  });

  test('the window reminder is unchanged', async () => {
    await send();
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.reminder_72h');
    expect(call.payload.appointment_time).toBe('9:00 AM');
    expect(call.idempotencyKey).toMatch(new RegExp(`^appointment\\.reminder_72h:ss1:${Date.parse(WHEN)}:`));
    expect(logged()[0]).toMatchObject({ event_type: 'appointment.reminder_72h', rendered_slot_ms: Date.parse(WHEN) });
    expect(logged()[0]).not.toHaveProperty('promise_level');
  });

  test('the 24-hour reminder never goes day-only, even if asked', async () => {
    await send({ kind: '24h', dayOnly: true });
    expect(sent()[0].templateKey).toBe('appointment.reminder_24h');
    expect(logged()[0]).not.toHaveProperty('promise_level');
  });

  test('a missing day template sends today\'s window reminder', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('active template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' }));
    await send({ dayOnly: true });
    expect(sent().map((c) => c.templateKey)).toEqual(['appointment.reminder_72h_day', 'appointment.reminder_72h']);
    expect(sent()[1].payload.appointment_time).toBe('9:00 AM');
  });
});

describe('both channels: the email that lands after the text does not win with a known slot', () => {
  const NOW = new Date('2026-11-11T00:00:00Z');
  const SLOT = Date.parse(WHEN);

  test('a day text then a day email: the latest promise is the day', async () => {
    await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Pest Control', dayOnly: true });
    const [meta] = logged();
    const sms = { id: 1, appointment_id: 'ss1', purpose: 'appointment_confirmation', sent_at: '2026-11-10T14:00:00Z', metadata: { promise_level: 'day', window_unknown: true } };
    const email = { id: 2, metadata: { ...meta, sent_at: '2026-11-10T14:00:05Z' }, created_at: '2026-11-10T14:00:05Z' };
    const events = await detector.loadPromiseEvents(fakeReaderConn({ messages: [sms], emails: [email] }), ['ss1'], { now: NOW });
    const latest = detector.latestPromises(events, NOW).get('ss1');
    expect(latest).toMatchObject({ source: 'email', start_at: null, level: 'day' });
  });

  test('the reader side: a NEWER day email supersedes an older known slot, so the sender keeps text and email one story', () => {
    // The text and the email of one send are decided together (appointment-reminders.js dayState): a text that fell back
    // to the window copy turns the email leg window too, so a known slot is never followed by a day email. Pinned in
    // day-only-promise-b1-senders.test.js; here, only the reader side: a NEWER day email does supersede an older slot.
    const known = { visit_id: 'ss1', start_at: new Date(SLOT).toISOString(), communicated_at: '2026-11-10T14:00:00Z', source: 'message' };
    const day = { visit_id: 'ss1', start_at: null, level: 'day', communicated_at: '2026-11-10T14:00:05Z', source: 'email' };
    expect(detector.latestPromises([known, day], NOW).get('ss1')).toBe(day);
  });
});

describe('the migration\'s email rows', () => {
  const { validationFor } = require('../services/email-template-library');
  const { EMAIL_TEMPLATES, emailTemplateRow } = migration._test;

  test.each(EMAIL_TEMPLATES.map((t) => [t.key, t]))('%s: no hour anywhere, valid variables, plain Waves copy', (_key, t) => {
    const text = JSON.stringify([t.subject, t.preview, t.blocks]);
    expect(text).not.toMatch(HOUR_WORDS);
    expect(text).not.toMatch(/Waves Pest Control/);
    const row = emailTemplateRow(t);
    const validation = validationFor({
      ...row,
      allowed_variables: JSON.parse(row.allowed_variables),
      required_variables: JSON.parse(row.required_variables),
      optional_variables: JSON.parse(row.optional_variables),
    }, { subject: t.subject, preview_text: t.preview, blocks: t.blocks });
    expect(validation.disallowed_variables).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test('both promise the window the day before', () => {
    for (const t of EMAIL_TEMPLATES) {
      expect(JSON.stringify(t.blocks)).toContain("We'll send your arrival window the day before.");
    }
  });
});

function logger() { return require('../services/logger'); }

// A knex-shaped fake for the no-show reader: messaging rows and email interaction rows; every other read is empty.
function fakeReaderConn({ messages = [], emails = [] } = {}) {
  const conn = (table) => {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere', 'whereIn']) chain[m] = () => chain;
    chain.select = async () => {
      if (table === 'messaging_audit_log as a') return messages;
      if (table === 'customer_interactions as ci') return emails;
      return [];
    };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  return conn;
}
