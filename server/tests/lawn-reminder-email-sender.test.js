// GATE_LAWN_PREVISIT_LINE in the 24-hour reminder EMAIL (appointment-email.sendReminderVariant): the sender always supplies
// {{lawn_prep_line}} ('' when there is no line), reads nothing while the gate is off, and a failure sends today's email. The email
// library is stubbed, nothing is sent. Synthetic data only.
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
const lawnLine = require('../services/lawn-previsit-line');

const WHEN = '2026-11-15T14:00:00.000Z'; // 09:00 ET on a Sunday: never a watering day
const customerRow = {
  id: 'cust-1', account_id: 'acct-1', is_primary_profile: true, first_name: 'Rowan', last_name: 'Testcase',
  email: 'rowan@example.com', phone: '+19415550100', address_line1: '4410 Synthetic Palm Way', city: 'Bradenton', state: 'FL', zip: '34205',
};
const NORMAL = (who) => `Please keep sprinklers off tonight and tomorrow morning, unlock the gate, and keep ${who} inside while we treat.`;
const HTTPS_LINK = 'https://portal.wavespestcontrol.com/?tab=property#pets';

let reads;
let visit;
let prefs;
function mockDb({ lawnVisitThrows = false } = {}) {
  db.mockImplementation((table) => {
    reads.push(table);
    if (table === 'scheduled_services as ss' && lawnVisitThrows) throw new Error('db down');
    if (table === 'customers') {
      const qb = { where: () => qb, select: () => qb, whereNull: () => qb, first: async () => customerRow };
      return qb;
    }
    if (table === 'notification_prefs') return { where: () => ({ first: async () => null }) };
    if (table === 'customer_interactions') return { insert: async () => [1] };
    if (table === 'appointment_reminders') return { where: () => ({ first: async () => null }) };
    if (table === 'scheduled_services') return { where: () => ({ first: async () => ({ scheduled_date: '2026-11-15', window_start: '09:00' }), leftJoin: () => ({ first: async () => ({ tech_name: 'Sam' }) }) }) };
    if (table === 'scheduled_services as ss') {
      const qb = { join: () => qb, where: () => qb, first: async () => visit };
      return qb;
    }
    if (table === 'property_preferences') return { where: () => ({ first: async () => prefs }) };
    if (table === 'customer_turf_profiles') return { where: () => ({ first: async () => ({ county: 'Manatee' }) }) };
    throw new Error(`unexpected db table ${table}`);
  });
}
const sent = () => EmailTemplates.sendTemplate.mock.calls.map(([arg]) => arg);
const LAWN_TABLES = ['scheduled_services as ss', 'property_preferences', 'customer_turf_profiles'];
const send = (kind = '24h', extra = {}) => AppointmentEmail.sendAppointmentReminderEmail({
  customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Lawn Care', kind, ...extra,
});

const OLD_GATE = process.env.GATE_LAWN_PREVISIT_LINE;
beforeEach(() => {
  jest.clearAllMocks();
  reads = [];
  visit = { service_type: 'Every 6 Weeks Lawn Care Service', visit_id: null, address_line1: '4410 Synthetic Palm Way', city: 'Bradenton', zip: '34205' };
  prefs = { pets_structured: [{ name: 'Biscuit', type: 'dog' }] };
  process.env.GATE_LAWN_PREVISIT_LINE = 'true';
  mockDb();
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'em-1', provider_message_id: 'sg-1', sent_at: '2026-11-10T14:00:00.000Z' } });
});
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env.GATE_LAWN_PREVISIT_LINE; else process.env.GATE_LAWN_PREVISIT_LINE = OLD_GATE;
});

describe('the 24-hour reminder email', () => {
  test('gate on, a lawn visit: the line goes in the payload, with the pet name and no link while a pet is on file', async () => {
    await send();
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.reminder_24h');
    expect(call.payload.lawn_prep_line).toBe(NORMAL('Biscuit'));
    expect(call.payload.lawn_prep_line).not.toContain('Have pets?');
  });

  test('gate on, no pet on file: the pets link keeps its full https address', async () => {
    prefs = { pets_structured: [] };
    await send();
    expect(sent()[0].payload.lawn_prep_line).toBe(`${NORMAL('pets')}\n\nHave pets? Add them here: ${HTTPS_LINK}`);
  });

  test('a visit that is not a lawn treatment: an empty line', async () => {
    visit = { ...visit, service_type: 'Pest Control' };
    await send();
    expect(sent()[0].payload.lawn_prep_line).toBe('');
  });

  test('gate off: an empty line and no lawn read', async () => {
    process.env.GATE_LAWN_PREVISIT_LINE = 'false';
    await send();
    expect(sent()[0].payload.lawn_prep_line).toBe('');
    expect(reads.filter((t) => LAWN_TABLES.includes(t))).toEqual([]);
  });

  test('gate unset: the same as off', async () => {
    delete process.env.GATE_LAWN_PREVISIT_LINE;
    await send();
    expect(sent()[0].payload.lawn_prep_line).toBe('');
    expect(reads.filter((t) => LAWN_TABLES.includes(t))).toEqual([]);
  });

  test('the builder fails: today\'s email, still sent', async () => {
    const spy = jest.spyOn(lawnLine, 'lawnPrevisitLineForVisit').mockRejectedValueOnce(new Error('boom'));
    const res = await send();
    spy.mockRestore();
    expect(res).toBeTruthy();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].payload.lawn_prep_line).toBe('');
  });

  test('a read that fails inside the builder: today\'s email, still sent', async () => {
    mockDb({ lawnVisitThrows: true });
    const res = await send();
    expect(res).toBeTruthy();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].payload.lawn_prep_line).toBe('');
  });

  test('the other payload fields are the same with the gate on or off', async () => {
    await send();
    process.env.GATE_LAWN_PREVISIT_LINE = 'false';
    await send();
    const [on, off] = sent();
    const { lawn_prep_line: onLine, ...onRest } = on.payload;
    const { lawn_prep_line: offLine, ...offRest } = off.payload;
    expect(onLine).not.toBe('');
    expect(offLine).toBe('');
    expect(onRest).toEqual(offRest);
    expect({ ...on, payload: undefined, onQueued: undefined }).toEqual({ ...off, payload: undefined, onQueued: undefined });
  });

  test('a call with no appointment time (a fallback that cannot rebuild it): an empty line, no lawn read', async () => {
    await AppointmentEmail.sendAppointmentReminderEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', serviceLabel: 'Lawn Care', kind: '24h' });
    expect(sent()[0].payload.lawn_prep_line).toBe('');
    expect(reads.filter((t) => LAWN_TABLES.includes(t))).toEqual([]);
  });
});

describe('the 72-hour reminder email and the other emails', () => {
  test('the 72-hour payload has no lawn variable and no lawn read happens', async () => {
    await send('72h');
    const [call] = sent();
    expect(call.templateKey).toBe('appointment.reminder_72h');
    expect(call.payload).not.toHaveProperty('lawn_prep_line');
    expect(reads.filter((t) => LAWN_TABLES.includes(t))).toEqual([]);
  });

  test('the 72-hour day-only reminder is unchanged too', async () => {
    await send('72h', { dayOnly: true });
    expect(sent()[0].payload).not.toHaveProperty('lawn_prep_line');
    expect(reads.filter((t) => LAWN_TABLES.includes(t))).toEqual([]);
  });

  test('the confirmation email has no lawn variable', async () => {
    await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: WHEN, serviceLabel: 'Lawn Care' });
    expect(sent()[0].payload).not.toHaveProperty('lawn_prep_line');
    expect(reads.filter((t) => LAWN_TABLES.includes(t))).toEqual([]);
  });
});
