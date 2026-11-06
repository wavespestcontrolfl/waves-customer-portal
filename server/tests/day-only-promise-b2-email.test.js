// GATE_DAY_ONLY_PROMISE part B2: the day-only RESCHEDULE email. No hour anywhere, the day in the idempotency key's slot
// segment, the day marker (and no slot) on the interaction row, the event type the no-show detector reads, and today's
// window email when the day template is missing. Synthetic data only; the email library is stubbed, nothing is sent.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  appointmentSendHeld: jest.fn(async () => false),
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');
const detector = require('../services/no-show-detector');

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
const STOP_KEY = `appointment.rescheduled:ss1:${Date.parse(WHEN)}:1783000000000:stop`;

beforeEach(() => {
  jest.clearAllMocks();
  interactions = [];
  mockDb();
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'em-1', provider_message_id: 'sg-1', sent_at: '2026-11-10T14:00:00.000Z' } });
});

const send = (extra = {}) => AppointmentEmail.sendAppointmentRescheduledEmail({
  customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Pest Control',
  arrivalWindow: 'between 9:00 AM and 11:00 AM', idempotencyKey: `appointment.rescheduled:ss1:${Date.parse(WHEN)}:1783000000000`, ...extra,
});

describe('the day-only reschedule email', () => {
  test('uses the day template, keeps the event type, carries no hour in the payload', async () => {
    await send({ dayOnly: true });
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.rescheduled_day');
    expect(call.payload).not.toHaveProperty('arrival_window');
    expect(call.payload.appointment_day).toBe('Sunday');
    expect(call.payload.appointment_date).toBe('November 15');
    expect(JSON.stringify(call.payload)).not.toMatch(/9:00|09:00|between/);
    expect(logged()[0].event_type).toBe('appointment.rescheduled');
  });

  test('the key has the ET day in the slot segment (never the slot epoch) and keeps the notice stamp and the :stop mark', async () => {
    await send({ dayOnly: true });
    // (The sender appends the recipient token to every key.)
    expect(sent()[0].idempotencyKey).toMatch(/^appointment\.rescheduled:ss1:day-2026-11-15:1783000000000:[0-9a-f]{16}$/);
    await send({ dayOnly: true, idempotencyKey: STOP_KEY });
    const key = sent()[1].idempotencyKey;
    expect(key).toMatch(/^appointment\.rescheduled:ss1:day-2026-11-15:1783000000000:stop:/);
    expect(key.split(':')[2]).not.toMatch(/^[0-9]+$/);
  });

  test('records the day marker and no slot on the interaction row', async () => {
    await send({ dayOnly: true });
    const [meta] = logged();
    expect(meta).toMatchObject({ event_type: 'appointment.rescheduled', template_key: 'appointment.rescheduled_day', promise_level: 'day', window_unknown: true });
    expect(meta).not.toHaveProperty('rendered_slot_ms');
  });

  test('the no-show reader turns that interaction row into level day with no slot', async () => {
    await send({ dayOnly: true });
    const conn = (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere', 'whereIn']) chain[m] = () => chain;
      chain.select = async () => (table === 'customer_interactions as ci' ? [{ id: 7, metadata: logged()[0], created_at: '2026-11-10T14:00:00Z' }] : []);
      return chain;
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    const events = await detector.loadPromiseEvents(conn, ['ss1'], { now: new Date('2026-11-11T00:00:00Z') });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visit_id: 'ss1', start_at: null, level: 'day', source: 'email' });
  });

  test('without dayOnly the window email is exactly as before (template, key, payload, metadata)', async () => {
    await send();
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.rescheduled');
    expect(call.payload.arrival_window).toBe('between 9:00 AM and 11:00 AM');
    expect(call.idempotencyKey).toMatch(new RegExp(`^appointment\\.rescheduled:ss1:${Date.parse(WHEN)}:1783000000000:[0-9a-f]{16}$`));
    expect(logged()[0]).toMatchObject({ event_type: 'appointment.rescheduled', scheduled_service_id: 'ss1', rendered_slot_ms: Date.parse(WHEN) });
    expect(logged()[0]).not.toHaveProperty('promise_level');
  });

  test('a missing or disabled day template sends today\'s window email (a customer always gets the notice)', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('active template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' }));
    const result = await send({ dayOnly: true });
    expect(result.ok).toBe(true);
    expect(sent().map((c) => c.templateKey)).toEqual(['appointment.rescheduled_day', 'appointment.rescheduled']);
    expect(sent()[1].payload.arrival_window).toBe('between 9:00 AM and 11:00 AM');
    expect(sent()[1].idempotencyKey).toMatch(new RegExp(`^appointment\\.rescheduled:ss1:${Date.parse(WHEN)}:1783000000000:`));
  });
});
