// CI's DB-gated pass runs this against PostgreSQL: the follow-up claim, the
// one-open-per-phone and one-call-per-slot indexes, and the full night CALL
// → time → confirmation flow (services/lead-call-text-followup.js). Fixture
// tables live in a unique schema dropped after the suite; the text send and
// the bell are mocked.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({ ...jest.requireActual('../services/admin-alert-compose'), raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })) }));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
// Every bell spec must pass the real notification rule (it throws under test).
const bellSpecs = () => raiseAdminAlert.mock.calls.map(([, spec]) => { composeAdminAlert(spec); return spec; });
const { handleLeadReply, TEXT_REPLY_BODY, NIGHT_CALL_BODY } = require('../services/lead-call-text-followup');

const REAL_SEND = { sent: true, providerMessageId: 'SM_real_sid', deliveryOutcome: 'accepted' };
// 9:30 PM EDT Oct 20, 2026, and the next morning at 7 AM EDT.
const NIGHT = new Date('2026-10-21T01:30:00Z');
const MORNING = new Date('2026-10-21T11:00:00Z');
const DAY = new Date('2026-10-20T16:00:00Z');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('lead call/text follow-up on PostgreSQL', () => {
  let database;
  const schema = `lead_cb_${randomUUID().replaceAll('-', '')}`;
  const tables = ['customers', 'leads', 'sms_log', 'lead_callback_requests'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    // CREATE TABLE ... AS copies columns only: restore what the rules use.
    const t = `"${schema}".lead_callback_requests`;
    await database.raw(`ALTER TABLE ${t} ALTER COLUMN id SET DEFAULT gen_random_uuid(), ALTER COLUMN state SET DEFAULT 'asked',
      ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN updated_at SET DEFAULT now()`);
    await database.raw(`CREATE UNIQUE INDEX ON ${t} (phone) WHERE state IN ('asked', 'scheduled')`);
    await database.raw(`CREATE UNIQUE INDEX ON ${t} (scheduled_for) WHERE state = 'scheduled'`);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    sendCustomerMessage.mockResolvedValue(REAL_SEND);
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  // A lead who got our "Reply CALL" text an hour before `when`.
  async function lead(phone, { first = 'Pat', last = 'Sample', when = NIGHT, stage = 'new_lead', intake = 'awaiting_service' } = {}) {
    const customer = { id: randomUUID(), first_name: first, last_name: last, phone, pipeline_stage: stage, lead_intake_status: intake };
    await database('customers').insert({ ...customer, created_at: when, updated_at: when });
    await database('leads').insert({ id: randomUUID(), customer_id: customer.id, created_at: when, updated_at: when });
    await database('sms_log').insert({
      id: randomUUID(), customer_id: customer.id, direction: 'outbound', from_phone: '+19412975749', to_phone: phone,
      message_body: "Hello Pat, Waves here. We got your quote request. Reply CALL and we'll call you shortly, or TEXT to handle it right here.",
      twilio_sid: `SM${randomUUID().replaceAll('-', '')}`, status: 'delivered', created_at: new Date(when.getTime() - 3600000),
    });
    return customer;
  }
  const reply = (customer, body, now) => handleLeadReply({ customer, body, fromPhone: customer.phone, smsLogId: randomUUID(), now });
  const sentBodies = () => sendCustomerMessage.mock.calls.map(([input]) => input.body);

  test('TEXT gets the service question once, and a cleared intake state comes back', async () => {
    const c = await lead('+19415550100', { intake: null });
    await expect(reply(c, 'Text', NIGHT)).resolves.toMatchObject({ action: 'text_reply_sent', outcome: 'sent' });
    expect(sentBodies()).toEqual([TEXT_REPLY_BODY]);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ audience: 'lead', entryPoint: 'lead_call_text_followup' });
    expect((await database('customers').where({ id: c.id }).first()).lead_intake_status).toBe('awaiting_service');
    await expect(reply(c, 'text', NIGHT)).resolves.toMatchObject({ action: 'none', reason: 'sent_today' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('two TEXT replies handled at once send one text', async () => {
    const c = await lead('+19415550111');
    const results = await Promise.all([reply(c, 'text', NIGHT), reply(c, 'text', NIGHT)]);
    expect(results.map((r) => r.action).sort()).toEqual(['none', 'text_reply_sent']);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('TEXT from a lead waiting on the address puts intake back on the service question', async () => {
    const c = await lead('+19415550118', { intake: 'awaiting_address' });
    await reply(c, 'text', NIGHT);
    expect((await database('customers').where({ id: c.id }).first()).lead_intake_status).toBe('awaiting_service');
  });

  test('a night CALL asks for a time; "10am" books 10:00 tomorrow and confirms it', async () => {
    const c = await lead('+19415550101');
    await expect(reply(c, 'CALL', NIGHT)).resolves.toMatchObject({ action: 'time_asked' });
    await expect(reply(c, '10am works', new Date(NIGHT.getTime() + 60000))).resolves.toMatchObject({ action: 'booked' });
    expect(sentBodies()).toEqual([NIGHT_CALL_BODY, "You're all set. We'll call you tomorrow at 10:00 AM."]);
    const row = await database('lead_callback_requests').where({ customer_id: c.id }).first();
    expect(row).toMatchObject({ state: 'scheduled', kind: 'call_request', answer_text: '10am works' });
    expect(new Date(row.scheduled_for).toISOString()).toBe('2026-10-21T14:00:00.000Z');
  });

  test('an answer after midnight says "today"', async () => {
    const c = await lead('+19415550102');
    await reply(c, 'call', NIGHT);
    await reply(c, '9', MORNING);
    expect(sentBodies()[1]).toBe("You're all set. We'll call you today at 9:00 AM.");
  });

  test('"tomorrow at 10" sent the next morning goes to the owner, not to a booking', async () => {
    const c = await lead('+19415550116');
    await reply(c, 'call', NIGHT);
    await expect(reply(c, 'tomorrow at 10', new Date('2026-10-21T12:30:00Z'))).resolves.toMatchObject({ action: 'owner_bell' });
    expect(bellSpecs()[0].why).toContain('another day');
  });

  test('an answer while our question is still settling still books', async () => {
    const c = await lead('+19415550117');
    await reply(c, 'call', NIGHT);
    await database('lead_callback_requests').where({ customer_id: c.id }).update({ send_outcome: null });
    await expect(reply(c, '10am', NIGHT)).resolves.toMatchObject({ action: 'booked' });
  });

  test('two leads asking for the same time get 10:00 and 10:15', async () => {
    const a = await lead('+19415550103', { first: 'Ann' });
    const b = await lead('+19415550104', { first: 'Bo' });
    await reply(a, 'call', NIGHT);
    await reply(b, 'call', NIGHT);
    await reply(a, '10', NIGHT);
    await reply(b, '10am', NIGHT);
    expect(sentBodies().slice(2)).toEqual([
      "You're all set. We'll call you tomorrow at 10:00 AM.",
      "You're all set. We'll call you tomorrow at 10:15 AM.",
    ]);
  });

  test('an unclear time raises one bell with their words and sends nothing', async () => {
    const c = await lead('+19415550105');
    await reply(c, 'call', NIGHT);
    await expect(reply(c, 'after work', NIGHT)).resolves.toMatchObject({ action: 'owner_bell' });
    expect(sentBodies()).toEqual([NIGHT_CALL_BODY]);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(bellSpecs()[0]).toMatchObject({ area: 'Leads', action: 'call Pat Sample back', severity: 'needs-you', who: 'person' });
    expect(bellSpecs()[0].why).toContain('“after work”');
    expect((await database('lead_callback_requests').where({ customer_id: c.id }).first()).state).toBe('needs_owner');
  });

  test('a time outside 8 AM-8 PM goes to the owner', async () => {
    const c = await lead('+19415550106');
    await reply(c, 'call', NIGHT);
    await reply(c, '6am', NIGHT);
    expect(bellSpecs()[0].why).toBe('Asked for a call at 6:00 AM, outside 8 AM to 8 PM; pick a time with them.');
  });

  test('a daytime CALL leaves the ring to call them; the open time ask stays until the ring rings', async () => {
    const c = await lead('+19415550107');
    await reply(c, 'call', NIGHT);
    // 9 AM EDT.
    await expect(reply(c, 'call', new Date('2026-10-21T13:00:00Z'))).resolves.toMatchObject({ reason: 'ring_handles_day_call' });
    expect((await database('lead_callback_requests').where({ customer_id: c.id }).first()).state).toBe('asked');
  });

  test('two answers handled at once: the first books, the second changes and raises nothing', async () => {
    const c = await lead('+19415550114');
    await reply(c, 'call', NIGHT);
    const results = await Promise.all([reply(c, '10am', NIGHT), reply(c, '11am', NIGHT)]);
    expect(results.filter((r) => r.action === 'booked')).toHaveLength(1);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(sentBodies()).toHaveLength(2);
  });

  test('hasOpenTimeAsk is true only while the question waits on an answer', async () => {
    const { hasOpenTimeAsk } = require('../services/lead-call-text-followup');
    const c = await lead('+19415550115');
    await expect(hasOpenTimeAsk({ customer: c, fromPhone: c.phone, now: NIGHT })).resolves.toBe(false);
    await reply(c, 'call', NIGHT);
    await expect(hasOpenTimeAsk({ customer: c, fromPhone: c.phone, now: NIGHT })).resolves.toBe(true);
    await reply(c, '10am', NIGHT);
    await expect(hasOpenTimeAsk({ customer: c, fromPhone: c.phone, now: NIGHT })).resolves.toBe(false);
  });

  test('a lead who became a customer after the question is not booked', async () => {
    const c = await lead('+19415550112');
    await reply(c, 'call', NIGHT);
    await expect(reply({ ...c, pipeline_stage: 'active_customer' }, '10am', NIGHT)).resolves.toMatchObject({ reason: 'existing_customer' });
    expect(sentBodies()).toEqual([NIGHT_CALL_BODY]);
    expect((await database('lead_callback_requests').where({ customer_id: c.id }).first()).state).toBe('cancelled');
  });

  test('a TEXT that cancels the ask while our question is still sending stays cancelled', async () => {
    const c = await lead('+19415550113');
    sendCustomerMessage.mockImplementationOnce(async () => {
      await database('lead_callback_requests').where({ customer_id: c.id }).update({ state: 'cancelled' });
      return REAL_SEND;
    });
    await reply(c, 'call', NIGHT);
    expect((await database('lead_callback_requests').where({ customer_id: c.id }).first())).toMatchObject({ state: 'cancelled', send_outcome: 'sent' });
  });

  test('an existing customer and a phone with no lead text are never answered', async () => {
    const customer = await lead('+19415550108', { stage: 'active_customer' });
    await expect(reply(customer, 'text', DAY)).resolves.toMatchObject({ reason: 'existing_customer' });
    const stranger = { id: randomUUID(), first_name: 'No', last_name: 'Text', phone: '+19415550109', pipeline_stage: 'new_lead' };
    await database('customers').insert(stranger);
    await expect(reply(stranger, 'text', DAY)).resolves.toMatchObject({ reason: 'no_lead_text' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a night ask that did not send closes and tells the owner', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent' });
    const c = await lead('+19415550110');
    await reply(c, 'call', NIGHT);
    expect((await database('lead_callback_requests').where({ customer_id: c.id }).first())).toMatchObject({ state: 'cancelled', send_outcome: 'not_sent' });
    expect(bellSpecs()[0].why).toBe('Replied CALL after 8 PM; our text asking for a call time did not send.');
  });
});
