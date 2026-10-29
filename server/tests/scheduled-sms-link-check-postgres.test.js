/**
 * The scheduled-text dispatcher re-runs the writer's customer-link check right before it sends an operator text
 * (scheduled-sms-delivery.js scheduledLinkRefusal). A row queued before the writer's guard shipped, or whose
 * customer's phone changed after queueing, can still carry another customer's bearer link. These tests run the real
 * cron tick against a dedicated, migrated PostgreSQL database (its rows removed after each test) with only the provider
 * send mocked. Synthetic names and 555 numbers only.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const mockSendCustomerMessage = jest.fn();
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  gateEnvTimestamp: () => null, gateEnvValue: () => false, isEnabled: (name) => name === 'cronJobs', logGateStatus: jest.fn(),
}));
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(), isScheduledTick: () => false, runAsScheduledTick: (fn) => fn(),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (_name, fn) => fn(),
  recordMissedTick: jest.fn(),
  recordLeaseFreeJobEnd: jest.fn(async () => {}),
  settleDeadRunningJobs: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
}));

const HOST = 'https://portal.wavespestcontrol.com';
jest.setTimeout(60000);

postgres('scheduled text link check at send time (real PostgreSQL)', () => {
  let database;
  const customerIds = [];
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const ownedQA = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!ownedQA && !ci) throw new Error('A dedicated waves_qa_<32 hex> database is required');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const ids = (await database('sms_log').whereIn('customer_id', customerIds).select('id')).map((r) => String(r.id));
    await database('notifications').whereIn(database.raw("metadata->>'dedupeKey'"), ids.map((id) => `scheduled-sms-link-refused:${id}`)).del();
    await database('sms_log').whereIn('customer_id', customerIds).del();
    await database('invoices').whereIn('customer_id', customerIds).del();
    await database('customers').whereIn('id', customerIds).del();
    customerIds.length = 0;
  });
  afterAll(async () => { await database?.destroy(); });

  const tag = () => randomUUID().replace(/-/g, '').slice(0, 20);
  async function customer(over = {}) {
    const id = randomUUID();
    const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;
    await database('customers').insert({ id, first_name: 'Fixture', last_name: 'Scheduled', phone, email: `${id}@example.invalid`, property_type: 'residential', ...over });
    customerIds.push(id);
    return { id, phone };
  }
  // The customer's own pay link: an invoice token owned by that customer.
  async function payLink(c) {
    const token = randomUUID();
    await database('invoices').insert({ customer_id: c.id, token, invoice_number: `INV-${tag()}`, status: 'sent', total: '150.00' });
    return `${HOST}/pay/${token}`;
  }
  // A row in the shape the writer queues: no entry_point, operator-authored, due now.
  async function queue(c, body, metadata = { human_authored: true }) {
    const [row] = await database('sms_log').insert({
      customer_id: c.id, direction: 'outbound', from_phone: '+19415550199', to_phone: c.phone, message_body: body,
      status: 'scheduled', message_type: 'manual', scheduled_for: new Date(0), metadata: JSON.stringify(metadata),
    }).returning('id');
    return row.id || row;
  }
  async function tick() {
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    require('../services/scheduler').initScheduledJobs();
    const job = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    await job();
  }
  const rowOf = (id) => database('sms_log').where({ id }).first();
  const alertsFor = (id) => database('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`scheduled-sms-link-refused:${id}`]);

  test('another customer\'s link: not sent, blocked with the refusal code, one alert that carries no text or number', async () => {
    const t = tag();
    const mine = await customer({ reservice_token: `own${t}` });
    await customer({ reservice_token: `oth${t}` });
    const body = `Synthetic booking note ${HOST}/reservice/oth${t}`;
    const id = await queue(mine, body);

    await tick();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    const row = await rowOf(id);
    expect(row.status).toBe('blocked');
    expect(row.metadata).toMatchObject({ blocked_code: 'CUSTOMER_LINK_REFUSED', blocked_reason: 'customer_link_owner_mismatch' });
    const alerts = await alertsFor(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe('Comms — rewrite the scheduled text to Fixture S');
    expect(alerts[0].body).toBe('A link in the text belongs to another customer, so it was not sent.');
    expect(alerts[0].link).toBe(`/admin/communications?thread=${mine.id}`);
    const written = JSON.stringify(alerts[0]);
    expect(written).not.toContain(body);
    expect(written).not.toContain(`oth${t}`);
    expect(written).not.toContain(mine.phone);
    expect(written).not.toContain(mine.phone.slice(-7));

    // A re-run of the same row (a recovered claim) raises no second alert.
    await database('sms_log').where({ id }).update({ status: 'scheduled', scheduled_for: new Date(0) });
    await tick();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(await alertsFor(id)).toHaveLength(1);
  });

  test('the recipient\'s own links (reservice, pay), and a text with no link, are sent unchanged with no alert', async () => {
    const t = tag();
    const mine = await customer({ reservice_token: `own${t}` });
    const bodies = [`Synthetic booking note ${HOST}/reservice/own${t}`, `Synthetic balance note ${await payLink(mine)}`, 'Synthetic note with no link.'];
    const ids = [];
    for (const body of bodies) ids.push(await queue(mine, body));

    await tick();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(3);
    expect(mockSendCustomerMessage.mock.calls.map(([input]) => input.body).sort()).toEqual([...bodies].sort());
    for (const id of ids) {
      expect((await rowOf(id)).status).toBe('sent');
      expect(await alertsFor(id)).toHaveLength(0);
    }
  });

  test('the customer\'s phone changed after queueing: their own pay link is not sent to the old number; a text with no link still is', async () => {
    const mine = await customer();
    const oldPhone = mine.phone;
    const linkBody = `Synthetic balance note ${await payLink(mine)}`;
    const linkId = await queue(mine, linkBody);
    const plainId = await queue(mine, 'Synthetic note with no link.');
    await database('customers').where({ id: mine.id }).update({ phone: '+12025550142' });

    await tick();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage.mock.calls[0][0]).toMatchObject({ body: 'Synthetic note with no link.', to: oldPhone });
    expect((await rowOf(plainId)).status).toBe('sent');
    const row = await rowOf(linkId);
    expect(row.status).toBe('blocked');
    expect(row.metadata).toMatchObject({ blocked_code: 'CUSTOMER_LINK_REFUSED', blocked_reason: 'customer_link_phone_changed' });
    const alerts = await alertsFor(linkId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toBe('The customer\'s phone no longer matches the number this text was queued for, so it was not sent.');
    expect(JSON.stringify(alerts[0])).not.toContain(oldPhone.slice(-7));
    expect(JSON.stringify(alerts[0])).not.toContain('5550142');
  });

  test('a check that cannot be read: back on the retry rail, not sent, no alert; the last attempt ends blocked with one alert', async () => {
    const t = tag();
    const mine = await customer({ reservice_token: `own${t}` });
    const body = `Synthetic booking note ${HOST}/reservice/own${t}`;
    const links = require('../services/composer-customer-links');
    jest.spyOn(links, 'linkOwnersInBody').mockRejectedValue(new Error('synthetic read failure'));
    const id = await queue(mine, body);

    await tick();

    const retried = await rowOf(id);
    expect(retried.status).toBe('scheduled');
    expect(new Date(retried.scheduled_for).getTime()).toBeGreaterThan(Date.now());
    expect(retried.metadata).toMatchObject({ scheduled_sms_attempts: 1, provider_retry_code: 'CUSTOMER_LINK_REFUSED' });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(await alertsFor(id)).toHaveLength(0);

    // The check reads again on the next pass: the text goes out.
    links.linkOwnersInBody.mockRestore();
    await database('sms_log').where({ id }).update({ scheduled_for: new Date(0) });
    await tick();
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect((await rowOf(id)).status).toBe('sent');

    // Still unreadable on the third and last attempt: blocked, and the office is told once.
    jest.spyOn(links, 'linkOwnersInBody').mockRejectedValue(new Error('synthetic read failure'));
    mockSendCustomerMessage.mockClear();
    const lastId = await queue(mine, body, { human_authored: true, scheduled_sms_attempts: 2 });
    await tick();
    const last = await rowOf(lastId);
    expect(last.status).toBe('blocked');
    expect(last.metadata).toMatchObject({ blocked_code: 'CUSTOMER_LINK_REFUSED', blocked_reason: 'customer_link_unverified' });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    const alerts = await alertsFor(lastId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toBe('A link in the text could not be checked, so it was not sent.');
  });

  test('a system deferral (it has an entry_point) is not link-checked: its own links are its own', async () => {
    const t = tag();
    const mine = await customer({ reservice_token: `own${t}` });
    await customer({ reservice_token: `oth${t}` });
    const body = `Synthetic system note ${HOST}/reservice/oth${t}`;
    const id = await queue(mine, body, { entry_point: 'notification_dispatcher_deferred', replay_purpose: 'appointment' });
    const check = jest.spyOn(require('../services/intelligence-bar/comms-tools'), 'customerLinkSendRefusal');

    await tick();

    expect(check).not.toHaveBeenCalled();
    expect(await alertsFor(id)).toHaveLength(0);
  });
});
