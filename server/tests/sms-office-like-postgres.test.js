/**
 * The office like's SQL (services/sms-office-like.js) on real PostgreSQL:
 * the address projection that names the liked text's phone and line, the
 * "nothing after it" thread check over messages and legacy-only log rows, and
 * the one-click-wins claim on messages.metadata. Hand-built tables in a
 * private schema carry only the columns that SQL reads.
 */

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const officeLike = require('../services/sms-office-like');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('office like SQL on PostgreSQL', () => {
  const schema = `office_like_${randomUUID().replaceAll('-', '')}`;
  const OUR_LINE = '+19413187612';
  const PHONE = '+15551234567';
  let database;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY, phone text, deleted_at timestamptz)', [schema]);
    await database.raw('CREATE TABLE ??.conversations (id uuid PRIMARY KEY, customer_id uuid, contact_phone text, our_endpoint_id text)', [schema]);
    await database.raw(`CREATE TABLE ??.messages (id uuid PRIMARY KEY, conversation_id uuid NOT NULL, channel text NOT NULL,
      direction text NOT NULL, body text, twilio_sid text, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL)`, [schema]);
    await database.raw(`CREATE TABLE ??.sms_log (id uuid PRIMARY KEY, direction text, from_phone text, to_phone text,
      message_body text, twilio_sid text, customer_id uuid, message_type text, status text, metadata jsonb, created_at timestamptz NOT NULL)`, [schema]);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  beforeEach(async () => {
    for (const table of ['messages', 'conversations', 'customers', 'sms_log']) await database(table).del();
  });

  const at = (minute) => new Date(Date.UTC(2026, 10, 2, 16, minute));
  async function thread({ customerPhone = PHONE, contactPhone = PHONE, ourLine = OUR_LINE, customerId = randomUUID() } = {}) {
    if (customerId && !(await database('customers').where({ id: customerId }).first())) {
      await database('customers').insert({ id: customerId, phone: customerPhone });
    }
    const id = randomUUID();
    await database('conversations').insert({ id, customer_id: customerId, contact_phone: contactPhone, our_endpoint_id: ourLine });
    return { id, customerId };
  }
  async function text(conversationId, { direction = 'inbound', body = 'Thanks, see you Tuesday!', minute = 15, sid = `SM${randomUUID()}`, metadata = {} } = {}) {
    const id = randomUUID();
    await database('messages').insert({
      id, conversation_id: conversationId, channel: 'sms', direction, body, twilio_sid: sid, metadata: JSON.stringify(metadata), created_at: at(minute),
    });
    return id;
  }
  async function logRow({ direction = 'outbound', minute = 16, sid = `SM${randomUUID()}`, phone = PHONE } = {}) {
    await database('sms_log').insert({
      id: randomUUID(), direction, twilio_sid: sid, message_body: 'Hi', created_at: at(minute),
      from_phone: direction === 'inbound' ? phone : OUR_LINE, to_phone: direction === 'inbound' ? OUR_LINE : phone,
    });
  }
  const load = (id) => officeLike.loadLikeTarget(database, id);

  test('loads the liked text with the customer phone, our line, and the customer who owns that phone', async () => {
    const convo = await thread();
    const id = await text(convo.id);

    expect(await load(id)).toMatchObject({
      id, direction: 'inbound', contactPhone: PHONE, ourEndpoint: OUR_LINE, peer: '5551234567', recipientCustomerId: convo.customerId,
    });
  });

  test('a text from a number that is not the customer\'s primary phone names no customer', async () => {
    const convo = await thread({ customerPhone: '+15550000000' });
    const id = await text(convo.id);

    expect(await load(id)).toMatchObject({ contactPhone: PHONE, recipientCustomerId: null });
  });

  test('the legacy log twin\'s phones win over the thread fields, as in the Messages log', async () => {
    const convo = await thread();
    const id = await text(convo.id, { sid: 'SM-twin' });
    await database('sms_log').insert({
      id: randomUUID(), direction: 'inbound', twilio_sid: 'SM-twin', message_body: 'Thanks, see you Tuesday!',
      from_phone: '+15557654321', to_phone: '+19415550000', created_at: at(15),
    });

    expect(await load(id)).toMatchObject({ contactPhone: '+15557654321', ourEndpoint: '+19415550000', peer: '5557654321' });
  });

  test('an earlier text does not block the like; any later text does, and only a customer text counts at the provider boundary', async () => {
    const convo = await thread();
    await text(convo.id, { direction: 'outbound', body: 'Your technician arrives Tuesday.', minute: 2 });
    const target = await load(await text(convo.id));
    expect(await officeLike.newerThreadMessageExists(database, target)).toBe(false);

    await text(convo.id, { direction: 'outbound', body: 'Anything else?', minute: 16 });
    expect(await officeLike.newerThreadMessageExists(database, target)).toBe(true);
    expect(await officeLike.newerThreadMessageExists(database, target, { inboundOnly: true })).toBe(false);

    await text(convo.id, { minute: 17, body: 'Actually, can you check the garage?' });
    expect(await officeLike.newerThreadMessageExists(database, target, { inboundOnly: true })).toBe(true);
  });

  test('a later text with the same phone on another of our lines counts', async () => {
    const convo = await thread();
    const target = await load(await text(convo.id));
    const otherLine = await thread({ ourLine: '+19415550000', customerId: convo.customerId });
    await text(otherLine.id, { direction: 'outbound', minute: 20 });

    expect(await officeLike.newerThreadMessageExists(database, target)).toBe(true);
  });

  test('a legacy-only log row after the text counts; the liked text\'s own log twin does not', async () => {
    const convo = await thread();
    const target = await load(await text(convo.id, { sid: 'SM-liked' }));
    await logRow({ direction: 'inbound', sid: 'SM-liked', minute: 15 });
    expect(await officeLike.newerThreadMessageExists(database, target)).toBe(false);

    await logRow({ direction: 'outbound', minute: 16 });
    expect(await officeLike.newerThreadMessageExists(database, target)).toBe(true);
    expect(await officeLike.newerThreadMessageExists(database, target, { inboundOnly: true })).toBe(false);
    await logRow({ direction: 'inbound', minute: 18, phone: '9415551234' });
    expect(await officeLike.newerThreadMessageExists(database, target, { inboundOnly: true })).toBe(false);
  });

  test('one click wins the claim, other metadata keys survive, and finishing touches only its own claim', async () => {
    const convo = await thread();
    const id = await text(convo.id, { metadata: { sms_contact_phone: PHONE } });
    const metadata = async () => (await database('messages').where({ id }).first('metadata')).metadata;

    const claim = await officeLike.claimOfficeLike(database, id, { technicianId: 'tech-1', name: 'Adam' });
    expect(claim).toMatchObject({ status: 'sending', by_id: 'tech-1', by_name: 'Adam' });
    expect(await officeLike.claimOfficeLike(database, id, { technicianId: 'tech-2', name: 'Virginia' })).toBeNull();
    expect(await metadata()).toMatchObject({ sms_contact_phone: PHONE, office_like: { token: claim.token, status: 'sending' } });

    await officeLike.finishOfficeLike(database, id, 'not-the-claim', 'sent');
    expect((await metadata()).office_like.status).toBe('sending');
    await officeLike.finishOfficeLike(database, id, claim.token, 'uncertain');
    expect((await metadata()).office_like).toMatchObject({ status: 'uncertain', token: claim.token, settled_at: expect.any(String) });
    expect(officeLike.officeLikeForClient(await metadata())).toEqual({ status: 'unconfirmed', by: 'Adam', at: claim.at });
    await officeLike.finishOfficeLike(database, id, claim.token, 'sent');
    expect(officeLike.officeLikeForClient(await metadata())).toEqual({ status: 'sent', by: 'Adam', at: claim.at });

    await officeLike.finishOfficeLike(database, id, 'not-the-claim', 'not_sent');
    expect((await metadata()).office_like).toBeDefined();
    await officeLike.finishOfficeLike(database, id, claim.token, 'not_sent');
    expect(await metadata()).toEqual({ sms_contact_phone: PHONE });
    expect(await officeLike.claimOfficeLike(database, id, { name: 'Virginia' })).toMatchObject({ by_name: 'Virginia' });
  });

  test('our own text cannot be claimed', async () => {
    const convo = await thread();
    const id = await text(convo.id, { direction: 'outbound' });

    expect(await officeLike.claimOfficeLike(database, id, { name: 'Adam' })).toBeNull();
  });
});
