// Real PostgreSQL transactions (rolled back): the capture sweep with a stubbed
// model read, the office's accept / dismiss / retire / add, and the admin
// routes. All names, addresses, phones and codes are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = req.headers['x-test-admin'] || null; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const { randomUUID } = require('node:crypto');
const express = require('express');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const numbers = require('../config/twilio-numbers');
const { etDateString, addETDays } = require('../utils/datetime-et');
const access = require('../services/access-code-capture');
const router = require('../routes/admin-access-codes');

jest.setTimeout(30000);
postgres('access codes section', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_ENV = { gate: process.env.GATE_ACCESS_CODES_SECTION, since: process.env.GATE_ACCESS_CODES_SECTION_SINCE };
  const SINCE = '2040-01-01T00:00:00Z';
  const OUR_NUMBER = numbers.locations.parrish.number;
  const ADMIN_ID = randomUUID();
  const NOW = new Date('2040-03-10T16:00:00Z');
  const day = (n) => etDateString(addETDays(NOW, n));

  const customer = async ({ properties = 1, house = '4455', zip = '34202', prefs = null } = {}) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Owner', phone: '+19415550142', email: `${id}@example.invalid` });
    const propertyIds = [];
    for (let i = 0; i < properties; i += 1) {
      const propertyId = randomUUID();
      propertyIds.push(propertyId);
      await trx('customer_properties').insert({
        id: propertyId, customer_id: id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: i === 0,
        address_line1: i === 0 ? `${house} Example Lane` : `${700 + i} Other Court`, city: 'Lakewood Ranch', zip,
        active: true, address_key: randomUUID(),
      });
    }
    if (prefs) await trx('property_preferences').insert({ customer_id: id, ...prefs });
    return { id, propertyIds };
  };
  const text = async (customerId, body, { at = '2040-03-10T15:00:00Z', direction = 'inbound', to = OUR_NUMBER, from = '+19415550142', status = null } = {}) => {
    const id = randomUUID();
    await trx('sms_log').insert({
      id, customer_id: customerId, direction, from_phone: direction === 'inbound' ? from : to,
      to_phone: direction === 'inbound' ? to : from, message_body: body, created_at: new Date(at), status: status || (direction === 'inbound' ? 'received' : 'sent'),
      message_type: direction === 'inbound' ? 'inbound' : 'manual',
    });
    return id;
  };
  const gateItem = (extra = {}) => ({ kind: 'neighborhood_gate', code: '#4821', instructions: null, life: 'standing', quote: 'The gate code is #4821', ...extra });
  const stub = (items) => jest.fn(async () => ({ items }));
  const sweep = (read) => access.runAccessCodeNet({ now: NOW, conn: trx, read });
  const rows = (customerId) => trx('customer_access_codes').where({ customer_id: customerId }).orderBy('created_at').orderBy('id');
  const receipts = (messageId) => trx('data_hygiene_source_extractions').where({ source_id: messageId, extractor_version: 'access-net-v1' });
  const visit = async (customerId, date, status = 'confirmed') => {
    const id = randomUUID();
    await trx('scheduled_services').insert({ id, customer_id: customerId, scheduled_date: date, service_type: 'Pest Control', status });
    return id;
  };
  const found = async (customerId, extra = {}) => {
    const value = { kind: 'neighborhood_gate', code: '#4821', instructions: null, life: 'standing', ...extra };
    // Filed like the sweep files it: tied to the customer's home when there is exactly one.
    const homes = await trx('customer_properties').where({ customer_id: customerId, active: true }).pluck('id');
    const [row] = await trx('customer_access_codes').insert({
      property_id: homes.length === 1 ? homes[0] : null,
      customer_id: customerId, kind: value.kind, code: value.code, instructions: value.instructions, life: value.life,
      status: 'found', source_type: 'sms', source_id: randomUUID(), source_quote: 'q', source_at: NOW,
      value_hash: access.valueHash(value.code, value.instructions),
    }).returning('*');
    return row;
  };
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json().catch(() => ({})) };
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/access-codes', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/access-codes`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_ACCESS_CODES_SECTION = 'true';
    process.env.GATE_ACCESS_CODES_SECTION_SINCE = SINCE;
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => {
    await trx.rollback();
    for (const [key, value] of [['GATE_ACCESS_CODES_SECTION', OLD_ENV.gate], ['GATE_ACCESS_CODES_SECTION_SINCE', OLD_ENV.since]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  afterAll(async () => {
    await new Promise((resolve) => { server.close(resolve); });
    await database.destroy();
  });

  describe('gate', () => {
    test('off: the sweep reads nothing and every route answers 404 with no-store', async () => {
      process.env.GATE_ACCESS_CODES_SECTION = 'false';
      const c = await customer();
      await text(c.id, 'The gate code is #4821');
      const read = stub([gateItem()]);
      expect(await sweep(read)).toEqual({ skipped: 'gate_off', movedRetired: 0 });
      expect(read).not.toHaveBeenCalled();
      const probes = [
        ['GET', `/?customerId=${c.id}`], ['GET', '/found'], ['POST', '/', {}],
        ['POST', `/${randomUUID()}/accept`, {}], ['POST', `/${randomUUID()}/link`, {}], ['POST', `/${randomUUID()}/dismiss`], ['POST', `/${randomUUID()}/retire`],
      ];
      for (const [method, path, body] of probes) {
        const res = await call(method, path, body);
        expect([res.status, res.body, res.cache]).toEqual([404, { enabled: false }, 'no-store']);
      }
    });

    test('on without a valid SINCE instant: the sweep waits for an activation time', async () => {
      const read = stub([gateItem()]);
      for (const bad of [undefined, '', '2040-01-01', '2040-01-01T00:00:00', 'soon']) {
        if (bad === undefined) delete process.env.GATE_ACCESS_CODES_SECTION_SINCE; else process.env.GATE_ACCESS_CODES_SECTION_SINCE = bad;
        expect(await sweep(read)).toMatchObject({ skipped: 'activation_time_required', movedRetired: 0, mirror: { failed: 0 } });
      }
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('sweep', () => {
    test('files a found row from a text, idempotently', async () => {
      const c = await customer();
      const messageId = await text(c.id, 'The gate code is #4821');
      const read = stub([gateItem()]);
      expect(await sweep(read)).toMatchObject({ scanned: 1, read: 1, found: 1, failed: 0 });
      const [row, ...rest] = await rows(c.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        kind: 'neighborhood_gate', code: '#4821', instructions: null, life: 'standing', status: 'found', source_type: 'sms',
        source_id: messageId, source_quote: 'The gate code is #4821', property_id: c.propertyIds[0], decided_by: null,
        value_hash: access.valueHash('#4821', null),
      });
      expect(new Date(row.source_at).toISOString()).toBe('2040-03-10T15:00:00.000Z');
      expect((await receipts(messageId))[0]).toMatchObject({ status: 'ok', proposal_count: 1 });
      // A second pass has nothing left to read.
      expect(await sweep(read)).toMatchObject({ scanned: 0, found: 0 });
      expect(read).toHaveBeenCalledTimes(1);
      // Even with the receipt gone, the same text files nothing twice.
      await trx('data_hygiene_source_extractions').where({ source_id: messageId }).del();
      expect(await sweep(read)).toMatchObject({ scanned: 1, found: 0, failed: 0 });
      expect(await rows(c.id)).toHaveLength(1);
    });

    test('the unique index is the backstop for one text, one kind, one value', async () => {
      const c = await customer();
      const base = await found(c.id);
      await expect(trx.transaction((sp) => sp('customer_access_codes').insert({
        customer_id: c.id, kind: base.kind, code: base.code, life: 'standing', status: 'found', source_type: 'sms',
        source_id: base.source_id, value_hash: base.value_hash,
      }))).rejects.toMatchObject({ code: '23505' });
      // Staff rows (no source) are not constrained.
      const staffInsert = () => trx('customer_access_codes').insert({
        customer_id: c.id, kind: 'door', code: '1', life: 'standing', status: 'active', source_type: 'staff', value_hash: access.valueHash('1'),
      });
      await staffInsert();
      await staffInsert();
    });

    test('a visit-only code is kept even when the profile holds the same value', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await text(c.id, 'The garage code is 2468 for today only');
      const read = stub([gateItem({ kind: 'garage', code: '2468', life: 'visit', quote: 'The garage code is 2468 for today only' })]);
      expect(await sweep(read)).toMatchObject({ found: 1 });
    });

    test('a corrected text that adds directions to the same code replaces its waiting row', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      expect(await sweep(stub([gateItem()]))).toMatchObject({ found: 1 });
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #4821, press 2 first' });
      const read = stub([gateItem({ instructions: 'press 2 first', quote: 'The gate code is #4821, press 2 first' })]);
      expect(await sweep(read)).toMatchObject({ found: 1 });
      const list = (await rows(c.id)).map((r) => [r.status, r.instructions]).sort();
      expect(list).toEqual([['found', 'press 2 first']]);
    });

    test('a corrected text that changes the code, or drops it, removes what it filed', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      expect(await sweep(stub([gateItem()]))).toMatchObject({ found: 1 });
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #9876' });
      expect(await sweep(stub([gateItem({ code: '#9876', quote: 'The gate code is #9876' })]))).toMatchObject({ found: 1 });
      expect((await rows(c.id)).map((r) => [r.code, r.status]).sort()).toEqual([['#9876', 'found']]);
      await trx('sms_log').where({ id }).update({ message_body: 'See you Tuesday' });
      expect(await sweep(stub([]))).toMatchObject({ found: 0 });
      expect(await rows(c.id)).toEqual([]);
    });

    test('a corrected text that changes the life of the same code updates the waiting row both ways', async () => {
      const c = await customer();
      const id = await text(c.id, 'The door code is 4821');
      await sweep(stub([gateItem({ kind: 'door', code: '4821', quote: 'The door code is 4821' })]));
      await trx('sms_log').where({ id }).update({ message_body: 'The door code is 4821 for today only' });
      await sweep(stub([gateItem({ kind: 'door', code: '4821', life: 'visit', quote: 'The door code is 4821 for today only' })]));
      let list = await rows(c.id);
      expect(list.map((r) => [r.life, r.status, r.source_quote])).toEqual([['visit', 'found', 'The door code is 4821 for today only']]);
      await trx('sms_log').where({ id }).update({ message_body: 'The door code is 4821 from now on' });
      await sweep(stub([gateItem({ kind: 'door', code: '4821', quote: 'The door code is 4821 from now on' })]));
      list = await rows(c.id);
      expect(list.map((r) => [r.life, r.status])).toEqual([['standing', 'found']]);
    });

    test('a text corrected to be too long, or emptied, removes what it filed', async () => {
      const long = await customer();
      const a = await text(long.id, 'The gate code is #4821');
      const empty = await customer();
      const b = await text(empty.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      await trx('sms_log').where({ id: a }).update({ message_body: `The gate code is #4821. ${'x'.repeat(700)}` });
      await trx('sms_log').where({ id: b }).update({ message_body: '' });
      await sweep(stub([gateItem()]));
      expect(await rows(long.id)).toEqual([]);
      expect(await rows(empty.id)).toEqual([]);
    });

    test('a text corrected back to an earlier code, in new or the exact old words, files it again', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      const a = stub([gateItem()]);
      await sweep(a);
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #9876' });
      await trx('data_hygiene_source_extractions').update({ last_attempted_at: trx.raw("last_attempted_at - interval '1 minute'") });
      await sweep(stub([gateItem({ code: '#9876', quote: 'The gate code is #9876' })]));
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #4821' });
      expect(await sweep(a)).toMatchObject({ read: 1, found: 1 });
      expect((await rows(c.id)).map((r) => [r.code, r.status])).toEqual([['#4821', 'found']]);
    });

    test('a corrected text whose read keeps failing clears what the old version filed', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #9876 now' });
      const fail = jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'ECONN' }); });
      for (let i = 0; i < 3; i += 1) await expect(sweep(fail)).rejects.toMatchObject({ code: 'ACCESS_NET_FAILURES' });
      expect(await rows(c.id)).toEqual([]);
    });

    test('a corrected text never touches a row the office already decided', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      const [row] = await rows(c.id);
      await access.accept(trx, row.id, {});
      await trx('sms_log').where({ id }).update({ message_body: 'See you Tuesday' });
      await sweep(stub([]));
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('active');
    });

    test('a house number added during the model call is refused at filing', async () => {
      const c = await customer({ properties: 1 });
      await text(c.id, 'The gate code is #7788');
      const read = jest.fn(async () => {
        await trx('customer_properties').where({ customer_id: c.id }).update({ address_line1: '7788 Example Way' });
        return { items: [gateItem({ code: '#7788', quote: 'The gate code is #7788' })] };
      });
      expect(await sweep(read)).toMatchObject({ found: 0 });
      expect(await rows(c.id)).toHaveLength(0);
    });

    test('a text corrected after its receipt is read again', async () => {
      const c = await customer();
      const id = await text(c.id, 'See you Tuesday');
      const read = stub([gateItem()]);
      expect(await sweep(read)).toMatchObject({ scanned: 1, read: 0 });
      expect(await sweep(read)).toMatchObject({ scanned: 0 });
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #4821' });
      expect(await sweep(read)).toMatchObject({ scanned: 1, read: 1, found: 1 });
    });

    test('respects the SINCE instant and skips older texts', async () => {
      const c = await customer();
      await text(c.id, 'The gate code is #4821', { at: '2039-12-31T23:59:00Z' });
      const read = stub([gateItem()]);
      expect(await sweep(read)).toMatchObject({ scanned: 0, found: 0 });
      expect(read).not.toHaveBeenCalled();
      expect(await rows(c.id)).toEqual([]);
    });

    test('a text with no access words is receipted without a model call', async () => {
      const c = await customer();
      const messageId = await text(c.id, 'See you Tuesday, thanks!');
      const read = stub([]);
      expect(await sweep(read)).toMatchObject({ scanned: 1, read: 0, skipped: 1, found: 0 });
      expect(read).not.toHaveBeenCalled();
      expect((await receipts(messageId))[0]).toMatchObject({ status: 'no_fields' });
    });

    test('a code question that never reached the customer does not make a bare number a reply', async () => {
      const c = await customer();
      await text(c.id, 'What is the gate code?', { at: '2040-03-10T14:00:00Z', direction: 'outbound', status: 'failed' });
      await text(c.id, '4821');
      const read = stub([gateItem({ code: '4821', quote: '4821' })]);
      expect(await sweep(read)).toMatchObject({ read: 0, found: 0 });
      expect(read).not.toHaveBeenCalled();
    });

    test('a statement that names a code, or an old question, does not make a bare number a reply', async () => {
      const c = await customer();
      await text(c.id, 'Your gate code was updated on file.', { at: '2040-03-10T14:00:00Z', direction: 'outbound' });
      await text(c.id, '4821');
      const old = await customer();
      await text(old.id, 'What is the gate code?', { at: '2040-03-07T14:00:00Z', direction: 'outbound' });
      await text(old.id, '4821');
      const read = stub([gateItem({ code: '4821', quote: '4821' })]);
      expect(await sweep(read)).toMatchObject({ read: 0 });
      expect(read).not.toHaveBeenCalled();
    });

    test('a property added during the model call makes the code account-wide', async () => {
      const c = await customer({ properties: 1 });
      await text(c.id, 'The gate code is #4821');
      const [first] = await trx('customer_properties').where({ customer_id: c.id }).select('*');
      const read = jest.fn(async () => {
        await trx('customer_properties').insert({ ...first, id: randomUUID(), address_line1: '9 Example Ct', is_primary: false, address_key: null });
        return { items: [gateItem()] };
      });
      expect(await sweep(read)).toMatchObject({ found: 1 });
      expect((await rows(c.id))[0].property_id).toBeNull();
    });

    test('a text that names a gate but asks for no code does not make a bare number a reply', async () => {
      const c = await customer();
      await text(c.id, 'We need to reschedule because the gate is broken.', { at: '2040-03-10T14:00:00Z', direction: 'outbound' });
      await text(c.id, '4821');
      const read = stub([gateItem({ code: '4821', quote: '4821' })]);
      expect(await sweep(read)).toMatchObject({ read: 0 });
    });

    test('a bare number is read only after our last text asked for a code', async () => {
      const asked = await customer();
      await text(asked.id, 'What is the gate code?', { at: '2040-03-10T14:50:00Z', direction: 'outbound' });
      const answer = await text(asked.id, '4821', { at: '2040-03-10T14:55:00Z' });
      const cold = await customer();
      await text(cold.id, 'Is the tech coming at 3?', { at: '2040-03-10T14:50:00Z', direction: 'outbound' });
      const bare = await text(cold.id, '4821', { at: '2040-03-10T14:55:00Z' });
      const read = jest.fn(async (context) => ({
        items: context.message.customer_id === asked.id ? [gateItem({ code: '4821', quote: '4821' })] : [],
      }));
      expect(await sweep(read)).toMatchObject({ scanned: 2, read: 1, found: 1 });
      expect(read).toHaveBeenCalledTimes(1);
      expect((await rows(asked.id))[0]).toMatchObject({ code: '4821', status: 'found' });
      expect(await rows(cold.id)).toEqual([]);
      expect((await receipts(answer))[0].status).toBe('ok');
      expect((await receipts(bare))[0].status).toBe('no_fields');
    });

    test('drops what the verifier rejects: a quote that is not in the text, a house number, outbound texts', async () => {
      const c = await customer({ house: '4455' });
      const messageId = await text(c.id, 'The gate code is 4455');
      const read = stub([
        gateItem({ code: '4455', quote: 'The gate code is 4455' }),
        gateItem({ code: '9999', quote: 'The gate code is 9999' }),
      ]);
      expect(await sweep(read)).toMatchObject({ read: 1, found: 0, failed: 0 });
      expect(await rows(c.id)).toEqual([]);
      expect((await receipts(messageId))[0]).toMatchObject({ status: 'no_fields' });
      // An outbound text is never a candidate.
      await text(c.id, 'The gate code is #4821', { direction: 'outbound' });
      const again = stub([gateItem()]);
      expect(await sweep(again)).toMatchObject({ scanned: 0 });
    });

    test('skips a value already on the profile, but files a different value for the same field', async () => {
      const c = await customer({ prefs: { neighborhood_gate_code: '# 4821', garage_code: '1357' } });
      await text(c.id, 'The gate code is #4821 and the garage code is 2468');
      const read = stub([
        gateItem({ quote: 'The gate code is #4821' }),
        gateItem({ kind: 'garage', code: '2468', quote: 'the garage code is 2468' }),
        gateItem({ kind: 'door', code: '#4821', quote: 'The gate code is #4821' }),
      ]);
      expect(await sweep(read)).toMatchObject({ found: 2 });
      // (the profile's own two codes are mirrored as `profile` rows, not read from the text)
      const filed = (await rows(c.id)).filter((r) => r.source_type === 'sms').map((r) => [r.kind, r.code]).sort();
      expect(filed).toEqual([['door', '#4821'], ['garage', '2468']]);
    });

    test('skips a value with an active standing row, but a waiting or dismissed row does not block it', async () => {
      const c = await customer();
      const existing = await found(c.id);
      await access.accept(trx, existing.id, {});
      await text(c.id, 'The gate code is #4821');
      const read = stub([gateItem()]);
      expect(await sweep(read)).toMatchObject({ found: 0 });
      await trx('customer_access_codes').where({ id: existing.id }).update({ status: 'dismissed' });
      // accept also filled the profile field, which on its own covers the value
      await trx('property_preferences').where({ customer_id: c.id }).update({ neighborhood_gate_code: null });
      await trx('data_hygiene_source_extractions').where({ extractor_version: 'access-net-v1' }).del();
      expect(await sweep(read)).toMatchObject({ found: 1 });
      expect((await rows(c.id)).map((r) => r.status).sort()).toEqual(['dismissed', 'found']);
    });

    test('a "today only" text with an active standing code still reaches the office', async () => {
      const c = await customer();
      const existing = await found(c.id);
      await access.accept(trx, existing.id, {});
      await text(c.id, 'The gate code is #4821 today only');
      expect(await sweep(stub([gateItem({ life: 'visit', quote: 'The gate code is #4821 today only' })]))).toMatchObject({ found: 1 });
    });

    test('each text keeps its own waiting row, so correcting one away leaves the other', async () => {
      const c = await customer();
      const a = await text(c.id, 'The gate code is #4821', { at: '2040-03-10T14:00:00Z' });
      await text(c.id, 'The gate code is #4821');
      expect(await sweep(stub([gateItem()]))).toMatchObject({ found: 2 });
      await trx('sms_log').where({ id: a }).update({ message_body: 'See you Tuesday' });
      await sweep(stub([]));
      expect((await rows(c.id)).map((r) => r.status)).toEqual(['found']);
    });

    test('a live visit code does not hide the same code sent later as a standing code', async () => {
      const c = await customer();
      const soon = await visit(c.id, day(2));
      const visitRow = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      await access.accept(trx, visitRow.id, { scheduledServiceId: soon, now: NOW });
      await text(c.id, 'The door code is always #9090');
      const read = stub([gateItem({ kind: 'door', code: '#9090', life: 'standing', quote: 'The door code is always #9090' })]);
      expect(await sweep(read)).toMatchObject({ found: 1 });
      expect((await rows(c.id)).map((r) => [r.life, r.status]).sort()).toEqual([['standing', 'found'], ['visit', 'active']]);
    });

    test('new directions with a known code reach the office', async () => {
      const c = await customer({ prefs: { neighborhood_gate_code: '#4821' } });
      await text(c.id, 'The gate code is #4821, press 2 first');
      const read = stub([gateItem({ instructions: 'press 2 first', quote: 'The gate code is #4821, press 2 first' })]);
      expect(await sweep(read)).toMatchObject({ found: 1 });
      // (the profile's own #4821 is mirrored as an active `profile` row beside it)
      expect((await rows(c.id)).filter((r) => r.source_type === 'sms')).toMatchObject([{ code: '#4821', instructions: 'press 2 first', status: 'found' }]);
    });

    test('a gate turned off during the model call files nothing and leaves no receipt', async () => {
      const c = await customer();
      await text(c.id, 'The gate code is #4821');
      const read = jest.fn(async () => { delete process.env.GATE_ACCESS_CODES_SECTION; return { items: [gateItem()] }; });
      expect(await sweep(read)).toMatchObject({ found: 0 });
      expect(await rows(c.id)).toHaveLength(0);
      expect(await trx('data_hygiene_source_extractions').where({ extractor_version: 'access-net-v1' })).toHaveLength(0);
    });

    test('a text moved to another customer during the model call files nothing for the old owner', async () => {
      const c = await customer();
      const other = await customer();
      await text(c.id, 'The gate code is #4821');
      const read = jest.fn(async () => {
        await trx('sms_log').where({ customer_id: c.id }).update({ customer_id: other.id });
        return { items: [gateItem()] };
      });
      expect(await sweep(read)).toMatchObject({ found: 0 });
      expect(await rows(c.id)).toHaveLength(0);
      expect(await rows(other.id)).toHaveLength(0);
    });

    test('a retired value the customer sends again comes back as found', async () => {
      const c = await customer();
      const existing = await found(c.id);
      await trx('customer_access_codes').where({ id: existing.id }).update({ status: 'retired' });
      await text(c.id, 'The gate code is #4821');
      expect(await sweep(stub([gateItem()]))).toMatchObject({ found: 1 });
      expect((await rows(c.id)).map((r) => r.status).sort()).toEqual(['found', 'retired']);
    });

    test('property_id is set only for a customer with one active property', async () => {
      const one = await customer({ properties: 1 });
      const two = await customer({ properties: 2 });
      await text(one.id, 'The gate code is #4821');
      await text(two.id, 'The gate code is #4821');
      expect(await sweep(stub([gateItem()]))).toMatchObject({ found: 2 });
      expect((await rows(one.id))[0].property_id).toBe(one.propertyIds[0]);
      expect((await rows(two.id))[0].property_id).toBeNull();
    });

    test('a failed read is receipted failed, retried, and never logs the text or the code', async () => {
      const c = await customer();
      const messageId = await text(c.id, 'The gate code is #4821');
      const read = jest.fn(async () => { throw Object.assign(new Error('provider said #4821'), { code: 'ECONN' }); });
      // A pass with a failure throws, so the cron lock records a failed run in job health.
      await expect(sweep(read)).rejects.toMatchObject({ code: 'ACCESS_NET_FAILURES', tally: { read: 1, found: 0, failed: 1 } });
      expect((await receipts(messageId))[0]).toMatchObject({ status: 'failed', attempt_count: 1 });
      expect(await rows(c.id)).toEqual([]);
      const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
      expect(logged).toContain(messageId);
      expect(logged).not.toContain('4821');
      expect(logged).not.toContain('gate code');
      // The next pass retries it (failed is not terminal), up to the retry cap.
      await expect(sweep(read)).rejects.toMatchObject({ tally: { scanned: 1, failed: 1 } });
      await expect(sweep(read)).rejects.toMatchObject({ tally: { scanned: 1, failed: 1 } });
      expect((await receipts(messageId))[0].status).toBe('failed_max_retries');
      expect(await sweep(read)).toMatchObject({ scanned: 0 });
    });

    test('never rings a bell', async () => {
      const c = await customer();
      await text(c.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
      const bells = await trx('notifications').where({ recipient_type: 'admin' }).whereRaw("created_at > now() - interval '1 minute'");
      expect(bells).toEqual([]);
    });

    test('a text over 600 characters is receipted without a read', async () => {
      const c = await customer();
      const messageId = await text(c.id, `The gate code is #4821 ${'x'.repeat(600)}`);
      const read = stub([gateItem()]);
      expect(await sweep(read)).toMatchObject({ read: 0, skipped: 1 });
      expect((await receipts(messageId))[0].status).toBe('no_fields');
    });
  });

  describe('accept', () => {
    const profile = (customerId) => trx('property_preferences').where({ customer_id: customerId }).first();

    test('fills an empty profile field, creating the preferences row when there is none', async () => {
      const c = await customer();
      const row = await found(c.id, { kind: 'lockbox', code: '5-5-5' });
      const out = await access.accept(trx, row.id, { adminUserId: ADMIN_ID });
      expect(out).toMatchObject({ ok: true, profileField: 'lockbox_code' });
      expect(out.row).toMatchObject({ status: 'active', code: '5-5-5', decidedBy: ADMIN_ID });
      expect((await profile(c.id)).lockbox_code).toBe('5-5-5');
    });

    test('on a one-home account the accepted code replaces an older profile value (one list)', async () => {
      const c = await customer({ prefs: { neighborhood_gate_code: '#1111' } });
      const row = await found(c.id);
      const out = await access.accept(trx, row.id, { adminUserId: ADMIN_ID });
      expect(out).toMatchObject({ ok: true, profileField: 'neighborhood_gate_code' });
      expect(out.row.status).toBe('active');
      expect((await profile(c.id)).neighborhood_gate_code).toBe('#4821');
    });

    test('the same value already on the profile is not rewritten', async () => {
      const c = await customer({ prefs: { neighborhood_gate_code: '# 4821' } });
      const row = await found(c.id);
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: true, profileField: null });
      expect((await profile(c.id)).neighborhood_gate_code).toBe('# 4821');
    });

    test('an empty string in the field counts as empty, a space-only value too', async () => {
      const c = await customer({ prefs: { garage_code: '  ' } });
      const row = await found(c.id, { kind: 'garage', code: '2468' });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: true, profileField: 'garage_code' });
      expect((await profile(c.id)).garage_code).toBe('2468');
    });

    test('a door code and a visit code never touch the profile', async () => {
      const c = await customer();
      const door = await found(c.id, { kind: 'door', code: '7716' });
      const visitOnly = await found(c.id, { kind: 'lockbox', code: '1212', life: 'visit' });
      await access.accept(trx, door.id, {});
      await access.accept(trx, visitOnly.id, {});
      expect(await profile(c.id)).toBeUndefined();
    });

    test('office edits are re-validated and the hash is recomputed', async () => {
      const c = await customer();
      const row = await found(c.id);
      const out = await access.accept(trx, row.id, { kind: 'property_gate', code: ' *99 12 ', instructions: 'Press 2 first' });
      expect(out.row).toMatchObject({ kind: 'property_gate', code: '*99 12', instructions: 'Press 2 first' });
      const stored = await trx('customer_access_codes').where({ id: row.id }).first();
      expect(stored.value_hash).toBe(access.valueHash('*99 12', null));
      expect((await profile(c.id)).property_gate_code).toBe('*99 12');
    });

    test.each([
      ['an unknown kind', { kind: 'window' }, 'invalid_kind'],
      ['an unknown life', { life: 'forever' }, 'invalid_life'],
      ['a code over 40 characters', { code: 'x'.repeat(41) }, 'invalid_code'],
      ['a non-text code', { code: 1234 }, 'invalid_code'],
      ['instructions over 600 characters', { instructions: 'x'.repeat(601) }, 'invalid_instructions'],
      ['no value left', { code: null, instructions: null }, 'value_required'],
    ])('rejects %s without changing the row', async (_name, edit, code) => {
      const c = await customer();
      const row = await found(c.id);
      expect(await access.accept(trx, row.id, edit)).toEqual({ ok: false, status: 400, code });
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('found');
    });

    test('only a found row can be accepted', async () => {
      const c = await customer();
      const row = await found(c.id);
      expect((await access.accept(trx, row.id, {})).ok).toBe(true);
      expect(await access.accept(trx, row.id, {})).toEqual({ ok: false, status: 409, code: 'not_pending' });
      const dismissed = await found(c.id, { code: '2222' });
      await access.dismiss(trx, dismissed.id, {});
      expect(await access.accept(trx, dismissed.id, {})).toEqual({ ok: false, status: 409, code: 'not_pending' });
      expect(await access.accept(trx, randomUUID(), {})).toEqual({ ok: false, status: 404, code: 'not_found' });
      expect(await access.accept(trx, 'nope', {})).toEqual({ ok: false, status: 404, code: 'not_found' });
    });

    test('refuses a second active standing row with the same value, and an edit that collides with a sibling', async () => {
      const c = await customer();
      const first = await found(c.id);
      const second = await found(c.id);
      await access.accept(trx, first.id, {});
      expect(await access.accept(trx, second.id, {})).toEqual({ ok: false, status: 409, code: 'duplicate_active' });
      // Same text, two found rows; editing one to the other's value hits the unique index.
      const sourceId = randomUUID();
      const [home] = await trx('customer_properties').where({ customer_id: c.id }).pluck('id');
      const a = await trx('customer_access_codes').insert({
        customer_id: c.id, property_id: home, kind: 'door', code: '3000', life: 'standing', status: 'found', source_type: 'sms', source_id: sourceId, value_hash: access.valueHash('3000'),
      }).returning('*');
      const b = await trx('customer_access_codes').insert({
        customer_id: c.id, property_id: home, kind: 'door', code: '3001', life: 'standing', status: 'found', source_type: 'sms', source_id: sourceId, value_hash: access.valueHash('3001'),
      }).returning('*');
      expect(await access.accept(trx, b[0].id, { code: '3000' })).toEqual({ ok: false, status: 409, code: 'duplicate' });
      expect((await trx('customer_access_codes').where({ id: b[0].id }).first()).status).toBe('found');
      expect((await trx('customer_access_codes').where({ id: a[0].id }).first()).status).toBe('found');
    });

    test('the same code with new directions replaces the active row; the profile code stays', async () => {
      const c = await customer();
      const first = await found(c.id);
      await access.accept(trx, first.id, {});
      await text(c.id, 'The gate code is #4821, press 2 first');
      const read = stub([gateItem({ instructions: 'press 2 first', quote: 'The gate code is #4821, press 2 first' })]);
      expect(await sweep(read)).toMatchObject({ found: 1 });
      const second = (await rows(c.id)).find((r) => r.status === 'found');
      const out = await access.accept(trx, second.id, { adminUserId: ADMIN_ID });
      expect(out).toMatchObject({ ok: true, row: { status: 'active', instructions: 'press 2 first' } });
      expect((await trx('customer_access_codes').where({ id: first.id }).first()).status).toBe('retired');
      expect((await trx('property_preferences').where({ customer_id: c.id }).first()).neighborhood_gate_code).toBe('#4821');
      expect((await access.listForCustomer(trx, c.id)).active.map((r) => r.id)).toEqual([second.id]);
    });

    test('writes an audit event that carries no code, quote or instructions', async () => {
      const c = await customer();
      const row = await found(c.id, { code: '#6543', instructions: 'press two' });
      await access.accept(trx, row.id, { adminUserId: ADMIN_ID });
      const events = await trx('audit_log').where({ resource_id: row.id, action: 'access_code.accepted' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, resource_type: 'customer_access_codes' });
      expect(JSON.stringify(events[0])).not.toMatch(/6543|press two/);
      expect(events[0].metadata).toMatchObject({ customer_id: c.id, kind: 'neighborhood_gate', profile_field: 'neighborhood_gate_code', edited: false });
    });
  });

  describe('visit-life codes', () => {
    test('attach to the visit the office names and leave the live list once it is completed', async () => {
      const c = await customer();
      const cancelled = await visit(c.id, day(1), 'cancelled');
      const next = await visit(c.id, day(3));
      const later = await visit(c.id, day(5));
      const tooFar = await visit(c.id, day(30));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      expect(await access.accept(trx, row.id, { scheduledServiceId: cancelled, now: NOW })).toMatchObject({ ok: false, code: 'invalid_visit' });
      const out = await access.accept(trx, row.id, { scheduledServiceId: next, now: NOW });
      expect(out.row.scheduledServiceId).toBe(next);
      expect([later, tooFar]).not.toContain(out.row.scheduledServiceId);
      let list = await access.listForCustomer(trx, c.id);
      expect(list.active.map((r) => r.id)).toEqual([row.id]);
      expect(list.active[0].scheduledDate).toBe(day(3));
      await trx('scheduled_services').where({ id: next }).update({ status: 'completed' });
      list = await access.listForCustomer(trx, c.id);
      expect(list.active).toEqual([]);
      // The row itself stays active in the table (history), only the live list drops it.
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('active');
    });

    test('a cancelled visit also drops its code, and a standing code is unaffected by visits', async () => {
      const c = await customer();
      const next = await visit(c.id, day(2));
      const visitRow = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      const standing = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, visitRow.id, { scheduledServiceId: next, now: NOW });
      await access.accept(trx, standing.id, { now: NOW });
      await trx('scheduled_services').where({ id: next }).update({ status: 'cancelled' });
      const list = await access.listForCustomer(trx, c.id);
      expect(list.active.map((r) => r.id)).toEqual([standing.id]);
    });

    test('a rescheduled visit counts as ended, and a named visit must sit inside the window', async () => {
      const c = await customer();
      const moved = await visit(c.id, day(2), 'rescheduled');
      const far = await visit(c.id, day(40));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      expect(await access.accept(trx, row.id, { scheduledServiceId: moved, now: NOW })).toMatchObject({ ok: false, code: 'invalid_visit' });
      expect(await access.accept(trx, row.id, { scheduledServiceId: far, now: NOW })).toMatchObject({ ok: false, code: 'invalid_visit' });
      expect((await access.accept(trx, row.id, { now: NOW })).row.scheduledServiceId).toBeNull();
    });

    test('a named visit gives the code its property', async () => {
      const c = await customer({ properties: 2 });
      const next = await visit(c.id, day(2));
      const [home] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      await trx('scheduled_services').where({ id: next }).update({ property_id: home.id });
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      expect(row.property_id).toBeNull();
      await access.accept(trx, row.id, { scheduledServiceId: next, now: NOW });
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).property_id).toBe(home.id);
    });

    test('the office must name the visit while the customer has a live one in the window; it is never guessed', async () => {
      const c = await customer();
      const sameDay = await visit(c.id, day(0), 'completed');
      const later = await visit(c.id, day(5));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      expect(await access.accept(trx, row.id, { now: NOW })).toMatchObject({ ok: false, status: 400, code: 'visit_required' });
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('found');
      expect(await access.accept(trx, row.id, { scheduledServiceId: sameDay, now: NOW })).toMatchObject({ ok: false, code: 'invalid_visit' });
      expect((await access.accept(trx, row.id, { scheduledServiceId: later, now: NOW })).row.scheduledServiceId).toBe(later);
    });

    test('a visit day already past is not offered: yesterday\'s open visit does not require a choice', async () => {
      const c = await customer();
      const now = new Date();
      await visit(c.id, etDateString(addETDays(now, -1)));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      await trx('customer_access_codes').where({ id: row.id }).update({ source_at: new Date(now.getTime() - 2 * 86400000) });
      expect(await access.accept(trx, row.id, { now })).toMatchObject({ ok: true, row: { scheduledServiceId: null } });
    });

    test('a visit code with no visit inside 14 days of the day it was sent binds to nothing', async () => {
      const c = await customer();
      await visit(c.id, day(30));
      const row = await found(c.id, { kind: 'door', code: '#8080', life: 'visit' });
      expect((await access.accept(trx, row.id, { now: NOW })).row.scheduledServiceId).toBeNull();
    });

    test('the office can name the visit; a visit of another customer or an ended visit is refused', async () => {
      const c = await customer();
      const other = await customer();
      const mine = await visit(c.id, day(9));
      const theirs = await visit(other.id, day(2));
      const done = await visit(c.id, day(1), 'completed');
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      expect(await access.accept(trx, row.id, { scheduledServiceId: theirs, now: NOW })).toMatchObject({ ok: false, code: 'invalid_visit' });
      expect(await access.accept(trx, row.id, { scheduledServiceId: done, now: NOW })).toMatchObject({ ok: false, code: 'invalid_visit' });
      expect((await access.accept(trx, row.id, { scheduledServiceId: mine, now: NOW })).row.scheduledServiceId).toBe(mine);
    });

    test('a one-visit candidate older than 14 days leaves the review list and cannot be accepted', async () => {
      const c = await customer();
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      await trx('customer_access_codes').where({ id: row.id }).update({ source_at: new Date(Date.now() - 20 * 86400000) });
      expect((await access.listFound(trx, {})).items.map((r) => r.id)).not.toContain(row.id);
      expect((await access.listForCustomer(trx, c.id)).found).toHaveLength(0);
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, status: 409, code: 'expired' });
    });

    test('an expired one-visit candidate is refused even when a visit in its old window is named', async () => {
      const c = await customer();
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      const sent = new Date(Date.now() - 20 * 86400000);
      await trx('customer_access_codes').where({ id: row.id }).update({ source_at: sent });
      const v = await visit(c.id, etDateString(addETDays(sent, 2)));
      expect(await access.accept(trx, row.id, { scheduledServiceId: v })).toMatchObject({ ok: false, code: 'expired' });
    });

    test('a code from a text that moved to another customer is hidden and cannot be accepted', async () => {
      const winner = await customer();
      const loser = await customer();
      const id = await text(winner.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      const [row] = await rows(winner.id);
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      expect((await access.listForCustomer(trx, winner.id)).found).toHaveLength(0);
      expect((await access.listFound(trx, {})).items.map((r) => r.id)).not.toContain(row.id);
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, status: 409, code: 'source_moved' });
    });

    test('a text moved to another customer after its read is read again for its new owner', async () => {
      const first = await customer();
      const second = await customer();
      const id = await text(first.id, 'The gate code is #4821');
      expect(await sweep(stub([gateItem()]))).toMatchObject({ found: 1 });
      await trx('sms_log').where({ id }).update({ customer_id: second.id });
      expect(await sweep(stub([gateItem()]))).toMatchObject({ read: 1, found: 1 });
      expect((await rows(second.id)).map((r) => r.status)).toEqual(['found']);
    });

    test('a hidden code whose text moved away never blocks a new find or a staff add', async () => {
      const winner = await customer();
      const loser = await customer();
      const id = await text(winner.id, 'The door code is 2468');
      await sweep(stub([gateItem({ kind: 'door', code: '2468', quote: 'The door code is 2468' })]));
      await access.accept(trx, (await rows(winner.id))[0].id, {});
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      await text(winner.id, 'Door code 2468', { at: '2040-03-10T15:30:00Z' });
      await sweep(stub([gateItem({ kind: 'door', code: '2468', quote: 'Door code 2468' })]));
      expect((await rows(winner.id)).filter((r) => r.status === 'found')).toHaveLength(1);
      expect(await access.addByStaff(trx, { customerId: winner.id, kind: 'door', life: 'standing', code: '2468' })).toMatchObject({ ok: true });
    });

    test('after a merge undo the next sweep retires the moved code and clears its profile copy', async () => {
      const winner = await customer();
      const loser = await customer();
      const id = await text(winner.id, 'The garage code is 1357');
      await sweep(stub([gateItem({ kind: 'garage', code: '1357', quote: 'The garage code is 1357' })]));
      const [row] = await rows(winner.id);
      await access.accept(trx, row.id, {});
      expect((await trx('property_preferences').where({ customer_id: winner.id }).first()).garage_code).toBe('1357');
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      const out = await sweep(stub([]));
      expect(out.movedRetired).toBe(1);
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('retired');
      expect((await trx('property_preferences').where({ customer_id: winner.id }).first()).garage_code).toBeNull();
    });

    test('a text changed after filing cannot be accepted from a stale page', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      const [row] = await rows(c.id);
      await trx('sms_log').where({ id }).update({ message_body: 'See you Tuesday' });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, status: 409, code: 'source_changed' });
      expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('found');
    });

    test('an accept needs the text\'s current words to have been read', async () => {
      const c = await customer();
      const id = await text(c.id, 'I set up a visitor pass for you, check your email');
      await sweep(stub([gateItem({ kind: 'pass', code: null, instructions: 'check your email', quote: 'I set up a visitor pass for you' })]));
      const [row] = await rows(c.id);
      await trx('sms_log').where({ id }).update({ message_body: 'I set up a visitor pass for you' });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, code: 'source_changed' });
    });

    test('an accept needs the NEWEST read: words restored to an older read do not count', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #1111');
      await sweep(stub([gateItem({ code: '#1111', quote: 'The gate code is #1111' })]));
      await trx('data_hygiene_source_extractions').update({ last_attempted_at: trx.raw("last_attempted_at - interval '1 minute'") });
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #2222' });
      await sweep(stub([gateItem({ code: '#2222', quote: 'The gate code is #2222' })]));
      const row = (await rows(c.id)).find((r) => r.code === '#2222');
      await trx('sms_log').where({ id }).update({ message_body: 'The gate code is #1111' });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, code: 'source_changed' });
    });

    test('the same one-visit code for the same visit is a duplicate; for another visit it is not', async () => {
      const c = await customer();
      const one = await visit(c.id, day(1));
      const two = await visit(c.id, day(3));
      const add = (v) => access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'visit', code: '#9090', scheduledServiceId: v, now: NOW });
      expect(await add(one)).toMatchObject({ ok: true });
      expect(await add(one)).toMatchObject({ ok: false, status: 409, code: 'duplicate_active' });
      expect(await add(two)).toMatchObject({ ok: true });
    });

    test('a sweep retirement is recorded as a system action', async () => {
      const winner = await customer();
      const loser = await customer();
      const id = await text(winner.id, 'The garage code is 1357');
      await sweep(stub([gateItem({ kind: 'garage', code: '1357', quote: 'The garage code is 1357' })]));
      const [row] = await rows(winner.id);
      await access.accept(trx, row.id, { adminUserId: ADMIN_ID });
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      await sweep(stub([]));
      const ev = await trx('audit_log').where({ action: 'access_code.source_moved', resource_id: row.id }).first('actor_type', 'actor_id');
      expect(ev).toMatchObject({ actor_type: 'system', actor_id: null });
    });

    test('with the gate off the sweep still retires a code whose text moved', async () => {
      const winner = await customer();
      const loser = await customer();
      const id = await text(winner.id, 'The garage code is 1357');
      await sweep(stub([gateItem({ kind: 'garage', code: '1357', quote: 'The garage code is 1357' })]));
      const [row] = await rows(winner.id);
      await access.accept(trx, row.id, {});
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      process.env.GATE_ACCESS_CODES_SECTION = 'false';
      const read = stub([]);
      expect(await sweep(read)).toEqual({ skipped: 'gate_off', movedRetired: 1 });
      expect(read).not.toHaveBeenCalled();
      expect((await trx('property_preferences').where({ customer_id: winner.id }).first()).garage_code).toBeNull();
    });

    test('a text that is no longer an inbound text cannot be accepted', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      const [row] = await rows(c.id);
      await trx('sms_log').where({ id }).update({ direction: 'outbound' });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, code: 'source_changed' });
    });

    test('moved codes of deleted customers never hold up the cleanup of live ones', async () => {
      const live = await customer();
      const gone = await customer();
      const other = await customer();
      const mk = async (c, body, code) => {
        const id = await text(c.id, body);
        await sweep(stub([gateItem({ kind: 'garage', code, quote: body })]));
        const [row] = (await rows(c.id)).filter((r) => r.code === code);
        await access.accept(trx, row.id, {});
        await trx('sms_log').where({ id }).update({ customer_id: other.id });
        return row;
      };
      await mk(gone, 'The garage code is 1357', '1357');
      await trx('customers').where({ id: gone.id }).update({ deleted_at: new Date() });
      const keep = await mk(live, 'The garage code is 2468', '2468');
      await sweep(stub([]));
      expect((await trx('customer_access_codes').where({ id: keep.id }).first()).status).toBe('retired');
    });

    test('a text reclassified as not readable clears what it filed', async () => {
      const c = await customer();
      const id = await text(c.id, 'The gate code is #4821');
      await sweep(stub([gateItem()]));
      expect(await rows(c.id)).toHaveLength(1);
      await trx('sms_log').where({ id }).update({ message_type: 'opt_out' });
      await sweep(stub([gateItem()]));
      expect(await rows(c.id)).toEqual([]);
    });

    test('a refused accept leaves the active twin untouched', async () => {
      const winner = await customer();
      const loser = await customer();
      const first = await found(winner.id);
      await access.accept(trx, first.id, {});
      const id = await text(winner.id, 'The gate code is #4821, press 2 first');
      await sweep(stub([gateItem({ instructions: 'press 2 first', quote: 'The gate code is #4821, press 2 first' })]));
      const candidate = (await rows(winner.id)).find((r) => r.status === 'found');
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      expect(await access.accept(trx, candidate.id, {})).toMatchObject({ ok: false, code: 'source_moved' });
      expect((await trx('customer_access_codes').where({ id: first.id }).first()).status).toBe('active');
    });

    test('a code whose text moved away is never promoted into the profile', async () => {
      const winner = await customer();
      const loser = await customer();
      const id = await text(winner.id, 'The garage code is 1357');
      await sweep(stub([gateItem({ kind: 'garage', code: '1357', quote: 'The garage code is 1357' })]));
      const moved = (await rows(winner.id))[0];
      const keep = await found(winner.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, moved.id, {});
      await access.accept(trx, keep.id, {});
      await trx('sms_log').where({ id }).update({ customer_id: loser.id });
      const out = await access.retire(trx, keep.id, {});
      expect(out).toMatchObject({ ok: true, promoted: false });
      expect((await trx('property_preferences').where({ customer_id: winner.id }).first()).garage_code).toBeNull();
    });

    test('a visit code bound to no visit leaves the live list 14 days after it was sent', async () => {
      const c = await customer();
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      await access.accept(trx, row.id, { now: NOW });
      expect((await access.listForCustomer(trx, c.id)).active).toHaveLength(1);
      await trx('customer_access_codes').where({ id: row.id }).update({ source_at: new Date(Date.now() - 15 * 86400000) });
      expect((await access.listForCustomer(trx, c.id)).active).toHaveLength(0);
    });

    test('the same door code sent for a second appointment is found again, while the first is still open', async () => {
      const c = await customer();
      const first = await visit(c.id, day(2));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      await access.accept(trx, row.id, { scheduledServiceId: first, now: NOW });
      await text(c.id, 'The door code is #9090');
      const read = stub([gateItem({ kind: 'door', code: '#9090', life: 'visit', quote: 'The door code is #9090' })]);
      expect(await sweep(read)).toMatchObject({ found: 1 });
      // The same text read twice still yields one row.
      await trx('data_hygiene_source_extractions').where({ extractor_version: 'access-net-v1' }).del();
      expect(await sweep(read)).toMatchObject({ found: 0 });
      expect((await rows(c.id)).map((r) => r.status).sort()).toEqual(['active', 'found']);
    });

    test('with no visit in the window the code stays attached to nothing and stays listed', async () => {
      const c = await customer();
      await visit(c.id, day(40));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      const out = await access.accept(trx, row.id, { now: NOW });
      expect(out.row.scheduledServiceId).toBeNull();
      expect((await access.listForCustomer(trx, c.id)).active.map((r) => r.id)).toEqual([row.id]);
    });

    test('an office edit to visit life attaches the visit at accept time', async () => {
      const c = await customer();
      const next = await visit(c.id, day(2));
      const row = await found(c.id, { kind: 'door', code: '#9090', life: 'standing' });
      const out = await access.accept(trx, row.id, { life: 'visit', scheduledServiceId: next, now: NOW });
      expect(out.row).toMatchObject({ life: 'visit', scheduledServiceId: next });
    });
  });

  describe('listing', () => {
    test('listForCustomer groups active and found, and listFound spans customers newest first', async () => {
      const a = await customer();
      const b = await customer();
      const old = await found(a.id, { code: '1111' });
      await trx('customer_access_codes').where({ id: old.id }).update({ created_at: new Date('2040-01-01T00:00:00Z') });
      const mid = await found(b.id, { code: '2222' });
      await trx('customer_access_codes').where({ id: mid.id }).update({ created_at: new Date('2040-02-01T00:00:00Z') });
      const mine = await found(a.id, { code: '3333' });
      await access.accept(trx, mine.id, {});
      const forA = await access.listForCustomer(trx, a.id);
      expect(forA.active.map((r) => r.code)).toEqual(['3333']);
      expect(forA.found.map((r) => r.code)).toEqual(['1111']);
      const all = await access.listFound(trx, { limit: 10, offset: 0 });
      expect(all.items.map((r) => r.code)).toEqual(['2222', '1111']);
      expect(all.total).toBe(2);
      expect(all.items[0].customerName).toBe('Sample Owner');
      const paged = await access.listFound(trx, { limit: 1, offset: 1 });
      expect(paged.items.map((r) => r.code)).toEqual(['1111']);
    });

    test('a deleted customer is not listed for review', async () => {
      const c = await customer();
      await found(c.id);
      await trx('customers').where({ id: c.id }).update({ deleted_at: new Date() });
      expect((await access.listFound(trx, {})).total).toBe(0);
    });
  });

  describe('technician visit read', () => {
    const profile = (customerId) => trx('property_preferences').where({ customer_id: customerId }).first();
    const tech = async () => {
      const id = randomUUID();
      await trx('technicians').insert({ id, name: 'Sample Tech' });
      return id;
    };

    test('a standing code tied to one home is not shown at a visit to another home', async () => {
      const c = await customer({ properties: 2 });
      const [a, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const atB = await visit(c.id, day(1));
      await trx('scheduled_services').where({ id: atB }).update({ property_id: b.id });
      const row = await found(c.id, { kind: 'door', code: '2468' });
      await access.accept(trx, row.id, { propertyId: a.id });
      const atHomeB = await found(c.id, { kind: 'garage', code: '1357' });
      await access.accept(trx, atHomeB.id, { propertyId: b.id });
      const out = await access.listForVisit(trx, { techRole: 'admin' }, atB);
      expect(out.codes.map((r) => r.code)).toEqual(['1357']);
    });

    test('an unstamped visit of a two-home customer shows no home-bound code', async () => {
      const c = await customer({ properties: 2 });
      const [a] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const v = await visit(c.id, day(1));
      const row = await found(c.id, { kind: 'door', code: '2468' });
      await access.accept(trx, row.id, {});
      await trx('customer_access_codes').where({ id: row.id }).update({ property_id: a.id });
      expect((await access.listForVisit(trx, { techRole: 'admin' }, v)).codes).toEqual([]);
    });

    test('on a multi-home account a code with no home is shown at no visit', async () => {
      const c = await customer({ properties: 2 });
      const [, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const v = await visit(c.id, day(1));
      await trx('scheduled_services').where({ id: v }).update({ property_id: b.id });
      const row = await found(c.id, { kind: 'door', code: '2468' });
      await access.accept(trx, row.id, { propertyId: b.id });
      await trx('customer_access_codes').where({ id: row.id }).update({ property_id: null });
      expect((await access.listForVisit(trx, { techRole: 'admin' }, v)).codes).toEqual([]);
    });

    test('a code with no home shows nowhere, even after the customer is down to one home', async () => {
      const c = await customer({ properties: 1 });
      const [a] = await trx('customer_properties').where({ customer_id: c.id }).select('id');
      const v = await visit(c.id, day(1));
      const row = await found(c.id, { kind: 'door', code: '2468' });
      await access.accept(trx, row.id, {});
      expect((await access.listForVisit(trx, { techRole: 'admin' }, v)).codes.map((r) => r.code)).toEqual(['2468']);
      await trx('customer_access_codes').where({ id: row.id }).update({ property_id: null });
      expect((await access.listForVisit(trx, { techRole: 'admin' }, v)).codes).toEqual([]);
      expect(a).toBeTruthy();
    });

    test('a one-visit code takes the visit\'s home; an unstamped visit of a two-home customer is refused', async () => {
      const c = await customer({ properties: 2 });
      const [, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const stamped = await visit(c.id, day(1));
      const unstamped = await visit(c.id, day(2));
      await trx('scheduled_services').where({ id: stamped }).update({ property_id: b.id });
      const one = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      expect(await access.accept(trx, one.id, { scheduledServiceId: unstamped, now: NOW })).toMatchObject({ ok: false, code: 'visit_home_unknown' });
      expect((await access.accept(trx, one.id, { scheduledServiceId: stamped, now: NOW })).row.propertyId).toBe(b.id);
      await trx('scheduled_services').where({ id: stamped }).update({ property_id: null });
      expect((await access.listForVisit(trx, { techRole: 'admin' }, stamped)).codes).toEqual([]);
    });

    test('on a one-home account an older home-less code still counts as a duplicate', async () => {
      const c = await customer({ properties: 1 });
      const old = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, old.id, {});
      await trx('customer_access_codes').where({ id: old.id }).update({ property_id: null });
      expect(await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468' })).toMatchObject({ ok: false, code: 'duplicate_active' });
    });

    test('retiring on a multi-home account clears the shared field instead of promoting another home\'s code', async () => {
      const c = await customer({ properties: 1 });
      const first = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, first.id, {});
      expect((await trx('property_preferences').where({ customer_id: c.id }).first()).garage_code).toBe('2468');
      const [p1] = await trx('customer_properties').where({ customer_id: c.id }).select('*');
      const p2 = randomUUID();
      await trx('customer_properties').insert({ ...p1, id: p2, address_line1: '9 Example Ct', is_primary: false, address_key: null });
      await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '1357', propertyId: p2 });
      expect(await access.retire(trx, first.id, {})).toMatchObject({ ok: true, promoted: false, clearedField: 'garage_code' });
      expect((await trx('property_preferences').where({ customer_id: c.id }).first()).garage_code).toBeNull();
    });

    test('the customer list carries visits with their home', async () => {
      const c = await customer({ properties: 2 });
      const [, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const v = await visit(c.id, etDateString(addETDays(new Date(), 2)));
      await trx('scheduled_services').where({ id: v }).update({ property_id: b.id });
      expect((await access.listForCustomer(trx, c.id)).visits).toEqual([expect.objectContaining({ id: v, property_id: b.id })]);
    });

    test('on a multi-home account a texted code already on file for one home still reaches the office', async () => {
      const c = await customer({ properties: 2 });
      const [a] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'standing', code: '1234', propertyId: a.id });
      await text(c.id, 'The door code is 1234');
      expect(await sweep(stub([gateItem({ kind: 'door', code: '1234', quote: 'The door code is 1234' })]))).toMatchObject({ found: 1 });
    });

    test('back to one home, retire promotes only a code of that home', async () => {
      const c = await customer({ properties: 2 });
      const [a, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const first = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', propertyId: a.id });
      await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '1357', propertyId: b.id });
      await trx('customer_properties').where({ id: b.id }).update({ active: false });
      await trx('property_preferences').insert({ customer_id: c.id, garage_code: '2468' }).onConflict('customer_id').merge();
      expect(await access.retire(trx, first.row.id, {})).toMatchObject({ ok: true, promoted: false });
      expect((await trx('property_preferences').where({ customer_id: c.id }).first()).garage_code).toBeNull();
    });

    test('a found code that lost its home is not moved to the home that is left', async () => {
      const c = await customer({ properties: 2 });
      const [a, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      const row = await found(c.id, { kind: 'door', code: '2468' });
      await trx('customer_properties').where({ id: a.id }).update({ active: false });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, code: 'property_required' });
      expect((await access.accept(trx, row.id, { propertyId: b.id })).row.propertyId).toBe(b.id);
    });

    test('on a one-home account, a code on file for a home no longer active does not hide a new find', async () => {
      const c = await customer({ properties: 2 });
      const [a] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'standing', code: '1234', propertyId: a.id });
      await trx('customer_properties').where({ id: a.id }).update({ active: false });
      await text(c.id, 'The door code is 1234');
      expect(await sweep(stub([gateItem({ kind: 'door', code: '1234', quote: 'The door code is 1234' })]))).toMatchObject({ found: 1 });
    });

    test('an office save of a new code on a one-home account retires the old code of that kind at once', async () => {
      const c = await customer();
      const first = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468' });
      const second = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '1357' });
      expect(second).toMatchObject({ ok: true });
      expect((await trx('customer_access_codes').where({ id: first.row.id }).first()).status).toBe('retired');
      expect((await trx('property_preferences').where({ customer_id: c.id }).first()).garage_code).toBe('1357');
      expect((await access.listForCustomer(trx, c.id)).active.map((r) => r.code)).toEqual(['1357']);
    });

    test('an office save also retires an older home-less code of that kind on a one-home account', async () => {
      const c = await customer();
      const old = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468' });
      await trx('customer_access_codes').where({ id: old.row.id }).update({ property_id: null });
      await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '1357' });
      expect((await trx('customer_access_codes').where({ id: old.row.id }).first()).status).toBe('retired');
    });

    test('with no active home an office save never replaces the profile code', async () => {
      const c = await customer();
      await trx('property_preferences').insert({ customer_id: c.id, garage_code: '2468' }).onConflict('customer_id').merge();
      await trx('customer_properties').where({ customer_id: c.id }).update({ active: false });
      await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '1357' });
      expect((await trx('property_preferences').where({ customer_id: c.id }).first()).garage_code).toBe('2468');
    });

    test('home choices name the unit and the property label', async () => {
      const c = await customer({ properties: 2 });
      const [a, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      await trx('customer_properties').where({ id: a.id }).update({ address_line1: '10 Example Way', address_line2: 'Unit 1', label: null });
      await trx('customer_properties').where({ id: b.id }).update({ address_line1: '10 Example Way', address_line2: 'Unit 2', label: 'Rental' });
      const labels = (await access.listForCustomer(trx, c.id)).properties.map((h) => h.label).sort();
      expect(labels).toEqual(['10 Example Way · Unit 1', '10 Example Way · Unit 2 · Rental']);
    });

    test('the found list carries each row\'s visit choices', async () => {
      const c = await customer();
      const soon = await visit(c.id, etDateString(addETDays(new Date(), 2)));
      await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      await trx('customer_access_codes').where({ customer_id: c.id }).update({ source_at: new Date() });
      const { items } = await access.listFound(trx, {});
      expect(items.find((r) => r.customerId === c.id).visitChoices.map((v) => v.id)).toEqual([soon]);
    });

    test('a standing code of a multi-home customer must name its home', async () => {
      const c = await customer({ properties: 2 });
      const [a] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      expect(await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'standing', code: '2468' })).toMatchObject({ ok: false, code: 'property_required' });
      expect(await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'standing', code: '2468', propertyId: randomUUID() })).toMatchObject({ ok: false, code: 'invalid_property' });
      const ok = await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'standing', code: '2468', propertyId: a.id });
      expect(ok).toMatchObject({ ok: true, row: { propertyId: a.id } });
      const row = await found(c.id, { kind: 'garage', code: '1357' });
      expect(await access.accept(trx, row.id, {})).toMatchObject({ ok: false, code: 'property_required' });
      expect((await access.accept(trx, row.id, { propertyId: a.id })).row.propertyId).toBe(a.id);
      expect((await access.listForCustomer(trx, c.id)).properties).toHaveLength(2);
    });

    test('a multi-home code never fills the customer-wide profile, and the same code at another home is not a duplicate', async () => {
      const c = await customer({ properties: 2 });
      const [a, b] = await trx('customer_properties').where({ customer_id: c.id }).orderBy('id').select('id');
      expect(await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', propertyId: a.id })).toMatchObject({ ok: true, profileField: null });
      expect(await profile(c.id)).toBeUndefined();
      expect(await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', propertyId: b.id })).toMatchObject({ ok: true });
      expect(await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', propertyId: b.id })).toMatchObject({ ok: false, code: 'duplicate_active' });
    });

    test('a technician sees only what a stop needs, and only around the visit day', async () => {
      const c = await customer();
      const techId = randomUUID();
      await trx('technicians').insert({ id: techId, name: 'Sample Tech' });
      const today = await visit(c.id, etDateString(new Date()));
      const later = await visit(c.id, etDateString(addETDays(new Date(), 5)));
      const done = await visit(c.id, etDateString(new Date()), 'completed');
      await trx('scheduled_services').whereIn('id', [today, later, done]).update({ technician_id: techId });
      const row = await found(c.id, { kind: 'door', code: '2468' });
      await access.accept(trx, row.id, {});
      const asTech = { techRole: 'technician', technicianId: techId };
      const out = await access.listForVisit(trx, asTech, today);
      expect(Object.keys(out.codes[0]).sort()).toEqual(['code', 'id', 'instructions', 'kind', 'life', 'scheduledServiceId']);
      expect(await access.listForVisit(trx, asTech, later)).toMatchObject({ ok: false, status: 403 });
      expect(await access.listForVisit(trx, asTech, done)).toMatchObject({ ok: false, status: 403 });
    });

    test('a technician reads the codes of a visit assigned to them, and only those', async () => {
      const c = await customer();
      const techId = await tech();
      const other = await tech();
      // Around the real visit day: a technician reads codes only yesterday through tomorrow.
      const mine = await visit(c.id, etDateString(new Date()));
      const theirs = await visit(c.id, etDateString(addETDays(new Date(), 1)));
      await trx('scheduled_services').where({ id: mine }).update({ technician_id: techId });
      await trx('scheduled_services').where({ id: theirs }).update({ technician_id: other });
      const standing = await found(c.id, { kind: 'door', code: '2468' });
      await access.accept(trx, standing.id, {});
      const forMine = await found(c.id, { kind: 'door', code: '#9090', life: 'visit' });
      const forTheirs = await found(c.id, { kind: 'door', code: '#8080', life: 'visit' });
      await trx('customer_access_codes').whereIn('id', [forMine.id, forTheirs.id]).update({ source_at: new Date() });
      await access.accept(trx, forMine.id, { scheduledServiceId: mine });
      await access.accept(trx, forTheirs.id, { scheduledServiceId: theirs });
      const asTech = { techRole: 'technician', technicianId: techId };
      const out = await access.listForVisit(trx, asTech, mine);
      expect(out.ok).toBe(true);
      expect(out.codes.map((r) => r.code).sort()).toEqual(['#9090', '2468']);
      expect(await access.listForVisit(trx, asTech, theirs)).toMatchObject({ ok: false, status: 403, code: 'service_not_assigned' });
      expect(await access.listForVisit(trx, asTech, randomUUID())).toMatchObject({ ok: false, status: 404 });
      expect((await access.listForVisit(trx, { techRole: 'admin' }, theirs)).codes.map((r) => r.code).sort()).toEqual(['#8080', '2468']);
    });
  });

  describe('dismiss, retire, add', () => {
    const profile = (customerId) => trx('property_preferences').where({ customer_id: customerId }).first();

    test('retire clears the same value from the profile field, and its replacement can then fill it', async () => {
      const c = await customer();
      const first = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, first.id, {});
      expect((await profile(c.id)).garage_code).toBe('2468');
      const out = await access.retire(trx, first.id, { adminUserId: ADMIN_ID });
      expect(out).toMatchObject({ ok: true, clearedField: 'garage_code' });
      expect((await profile(c.id)).garage_code).toBeNull();
      const second = await found(c.id, { kind: 'garage', code: '1357' });
      await access.accept(trx, second.id, {});
      expect((await profile(c.id)).garage_code).toBe('1357');
    });

    test('on a one-home account a newer save replaces the older code, so retiring it leaves the field empty', async () => {
      const c = await customer();
      const first = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, first.id, {});
      const second = await found(c.id, { kind: 'garage', code: '1357' });
      await access.accept(trx, second.id, {});
      // One source: the newer save retired the older code in the same transaction.
      expect((await trx('customer_access_codes').where({ id: first.id }).first()).status).toBe('retired');
      expect((await profile(c.id)).garage_code).toBe('1357');
      expect(await access.retire(trx, second.id, { adminUserId: ADMIN_ID })).toMatchObject({ ok: true, clearedField: 'garage_code', promoted: false });
      expect((await profile(c.id)).garage_code).toBeNull();
    });

    test('retire leaves a profile field that holds a different value', async () => {
      const c = await customer();
      const row = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, row.id, {});
      await trx('property_preferences').where({ customer_id: c.id }).update({ garage_code: '9999' });
      const out = await access.retire(trx, row.id, { adminUserId: ADMIN_ID });
      expect(out.clearedField).toBeNull();
      expect((await profile(c.id)).garage_code).toBe('9999');
    });

    test('dismiss moves found to dismissed and retire moves active to retired, each audited', async () => {
      const c = await customer();
      const toDismiss = await found(c.id);
      const toRetire = await found(c.id, { code: '2222' });
      expect((await access.dismiss(trx, toDismiss.id, { adminUserId: ADMIN_ID })).row).toMatchObject({ status: 'dismissed', decidedBy: ADMIN_ID });
      await access.accept(trx, toRetire.id, {});
      expect((await access.retire(trx, toRetire.id, { adminUserId: ADMIN_ID })).row.status).toBe('retired');
      const actions = (await trx('audit_log').whereIn('resource_id', [toDismiss.id, toRetire.id]).select('action', 'metadata'))
        .map((e) => e.action).sort();
      expect(actions).toEqual(['access_code.accepted', 'access_code.dismissed', 'access_code.retired']);
    });

    test('the wrong state answers a typed conflict', async () => {
      const c = await customer();
      const row = await found(c.id);
      expect(await access.retire(trx, row.id, {})).toEqual({ ok: false, status: 409, code: 'not_active' });
      await access.accept(trx, row.id, {});
      expect(await access.dismiss(trx, row.id, {})).toEqual({ ok: false, status: 409, code: 'not_pending' });
      expect(await access.dismiss(trx, randomUUID(), {})).toEqual({ ok: false, status: 404, code: 'not_found' });
    });

    test('addByStaff creates an active staff row, fills an empty profile field and attaches a visit', async () => {
      const c = await customer();
      const next = await visit(c.id, day(2));
      const gate = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', adminUserId: ADMIN_ID, now: NOW });
      expect(gate.row).toMatchObject({ status: 'active', sourceType: 'staff', sourceId: null, decidedBy: ADMIN_ID, propertyId: c.propertyIds[0] });
      expect(gate.profileField).toBe('garage_code');
      const door = await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'visit', code: '#9090', instructions: 'Back door', scheduledServiceId: next, now: NOW });
      expect(door.row.scheduledServiceId).toBe(next);
      const dupe = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '24 68' });
      expect(dupe).toEqual({ ok: false, status: 409, code: 'duplicate_active' });
      const pass = await access.addByStaff(trx, { customerId: c.id, kind: 'pass', life: 'standing', instructions: 'Show the QR from the HOA email' });
      expect(pass.row).toMatchObject({ kind: 'pass', code: null });
      const events = await trx('audit_log').where({ action: 'access_code.added' }).whereIn('resource_id', [gate.row.id, door.row.id]);
      expect(JSON.stringify(events)).not.toMatch(/2468|9090|Back door/);
    });

    test.each([
      ['no kind', { life: 'standing', code: '1' }, 400, 'invalid_kind'],
      ['no life', { kind: 'door', code: '1' }, 400, 'invalid_life'],
      ['no value', { kind: 'door', life: 'standing' }, 400, 'value_required'],
      ['a bad customer id', { customerId: 'nope', kind: 'door', life: 'standing', code: '1' }, 400, 'invalid_customer'],
      ['an unknown customer', { customerId: randomUUID(), kind: 'door', life: 'standing', code: '1' }, 404, 'customer_not_found'],
    ])('addByStaff rejects %s', async (_name, input, status, code) => {
      const c = await customer();
      expect(await access.addByStaff(trx, { customerId: c.id, ...input })).toEqual({ ok: false, status, code });
      expect(await rows(c.id)).toEqual([]);
    });
  });

  describe('routes', () => {
    test('the full office flow over HTTP, with no-store on every answer and the admin id on the decision', async () => {
      const c = await customer();
      const row = await found(c.id, { code: '#8080' });
      let res = await call('GET', `/?customerId=${c.id}`);
      expect([res.status, res.cache]).toEqual([200, 'no-store']);
      expect(res.body.found.map((r) => r.id)).toEqual([row.id]);
      res = await call('GET', '/found?limit=5');
      expect(res.body).toMatchObject({ total: 1 });
      expect(res.body.items[0]).toMatchObject({ id: row.id, customerName: 'Sample Owner' });
      res = await call('POST', `/${row.id}/accept`, { instructions: 'Press 1' }, { 'x-test-admin': ADMIN_ID });
      expect([res.status, res.cache]).toEqual([200, 'no-store']);
      expect(res.body.accessCode).toMatchObject({ status: 'active', instructions: 'Press 1', decidedBy: ADMIN_ID });
      expect(res.body.profileField).toBe('neighborhood_gate_code');
      res = await call('POST', `/${row.id}/accept`, {});
      expect([res.status, res.body.code]).toEqual([409, 'not_pending']);
      res = await call('POST', `/${row.id}/retire`);
      expect([res.status, res.body.accessCode.status]).toEqual([200, 'retired']);
      res = await call('POST', '/', { customerId: c.id, kind: 'door', life: 'standing', code: '#4040' });
      expect([res.status, res.body.accessCode.sourceType]).toEqual([200, 'staff']);
      const added = res.body.accessCode.id;
      res = await call('POST', `/${added}/dismiss`);
      expect([res.status, res.body.code]).toEqual([409, 'not_pending']);
    });

    test('dismiss over HTTP', async () => {
      const c = await customer();
      const row = await found(c.id);
      const res = await call('POST', `/${row.id}/dismiss`);
      expect([res.status, res.body.accessCode.status]).toEqual([200, 'dismissed']);
    });

    test('validation errors are typed and never echo the submitted code', async () => {
      const c = await customer();
      const secret = 'x'.repeat(41);
      let res = await call('POST', '/', { customerId: c.id, kind: 'door', life: 'standing', code: secret });
      expect([res.status, res.body.code]).toEqual([400, 'invalid_code']);
      expect(JSON.stringify(res.body)).not.toContain(secret);
      res = await call('GET', '/?customerId=nope');
      expect([res.status, res.body.code]).toEqual([400, 'invalid_customer']);
      res = await call('GET', '/');
      expect(res.status).toBe(400);
      res = await call('POST', `/${randomUUID()}/accept`, {});
      expect([res.status, res.body.code]).toEqual([404, 'not_found']);
      res = await call('POST', '/not-a-uuid/accept', {});
      expect([res.status, res.body.code]).toEqual([404, 'not_found']);
      res = await call('POST', '/', ['not', 'an', 'object']);
      expect([res.status, res.body.code]).toEqual([400, 'invalid_body']);
    });

    test('a failure is logged by error code only', async () => {
      const spy = jest.spyOn(access, 'listFound').mockRejectedValue(Object.assign(new Error('secret #4821 binding'), { code: 'XX000' }));
      const res = await call('GET', '/found');
      spy.mockRestore();
      expect([res.status, res.body.code]).toEqual([500, 'server_error']);
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).toContain('XX000');
      expect(logged).not.toContain('4821');
    });
  });

  describe('profile mirror (one list)', () => {
    const mirror = () => access.mirrorProfileCodes(trx);
    const profile = (customerId) => trx('property_preferences').where({ customer_id: customerId }).first();
    // A later profile edit gets its own updated_at (a test transaction's now() never moves).
    let tick = 0;
    const edit = (customerId, fields) => trx('property_preferences').where({ customer_id: customerId })
      .update({ ...fields, updated_at: new Date(Date.parse('2040-03-10T16:00:00Z') + (tick += 1) * 60000) });
    const live = (customerId, kind) => trx('customer_access_codes')
      .where({ customer_id: customerId, status: 'active', ...(kind ? { kind } : {}) }).orderBy('created_at').orderBy('id');
    const tech = async () => {
      const id = randomUUID();
      await trx('technicians').insert({ id, name: 'Sample Tech' });
      return id;
    };
    const staffRow = async (customerId, extra = {}) => {
      const row = await found(customerId, extra);
      await trx('customer_access_codes').where({ id: row.id }).update({ status: 'active', source_type: 'staff', source_id: null });
      return row;
    };
    const atVisit = async (customerId, propertyId) => {
      const id = await visit(customerId, etDateString(new Date()));
      await trx('scheduled_services').where({ id }).update({ property_id: propertyId });
      return id;
    };

    test('a one-home profile code becomes one active profile row bound to the home, and a re-run changes nothing', async () => {
      const c = await customer({ prefs: { neighborhood_gate_code: '# 4821', garage_code: '2468' } });
      expect(await mirror()).toMatchObject({ checked: 1, created: 2, retired: 0, failed: 0 });
      const filed = await live(c.id);
      expect(filed.map((r) => [r.kind, r.code]).sort()).toEqual([['garage', '2468'], ['neighborhood_gate', '# 4821']]);
      for (const r of filed) {
        expect(r).toMatchObject({ source_type: 'profile', source_id: null, life: 'standing', property_id: c.propertyIds[0], decided_by: null });
      }
      expect(filed.find((r) => r.kind === 'neighborhood_gate').value_hash).toBe(access.valueHash('#4821', null));
      // the profile fields are never written by the mirror
      expect(await profile(c.id)).toMatchObject({ neighborhood_gate_code: '# 4821', garage_code: '2468' });
      expect(await mirror()).toMatchObject({ checked: 0, created: 0 });
      expect(await live(c.id)).toHaveLength(2);
      const events = await trx('audit_log').where({ action: 'access_code.profile_mirrored' }).whereIn('resource_id', filed.map((r) => r.id));
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.actor_type === 'system')).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/4821|2468/);
    });

    test('an edit of the field retires the old row and adds the new one', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      await edit(c.id, { garage_code: '1357' });
      expect(await mirror()).toMatchObject({ checked: 1, created: 1, retired: 1 });
      expect((await live(c.id)).map((r) => r.code)).toEqual(['1357']);
      const old = await trx('customer_access_codes').where({ customer_id: c.id, code: '2468' }).first();
      expect(old).toMatchObject({ status: 'retired', decided_by: null });
      expect((await profile(c.id)).garage_code).toBe('1357');
      const ev = await trx('audit_log').where({ action: 'access_code.profile_superseded', resource_id: old.id }).first('actor_type', 'metadata');
      expect(ev.actor_type).toBe('system');
      expect(JSON.stringify(ev.metadata)).not.toContain('2468');
    });

    test('clearing the field retires the mirrored row only', async () => {
      const c = await customer({ prefs: { garage_code: '2468', lockbox_code: '1212' } });
      const door = await staffRow(c.id, { kind: 'door', code: '7716' });
      await mirror();
      await edit(c.id, { garage_code: null });
      expect(await mirror()).toMatchObject({ retired: 1, created: 0 });
      expect((await live(c.id)).map((r) => [r.kind, r.code]).sort()).toEqual([['door', '7716'], ['lockbox', '1212']]);
      expect((await trx('customer_access_codes').where({ id: door.id }).first()).status).toBe('active');
    });

    test('a profile change on a one-home account retires the office rows of that kind too (one source)', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      const staff = await staffRow(c.id, { kind: 'garage', code: '1357' });
      const staffSameValue = await staffRow(c.id, { kind: 'garage', code: '2468' });
      const directionsOnly = await staffRow(c.id, { kind: 'garage', code: null, instructions: 'Side door of the garage' });
      await mirror();
      const status = async (r) => (await trx('customer_access_codes').where({ id: r.id }).first()).status;
      expect(await status(staff)).toBe('retired');
      // a row that already holds the profile's value is the row: no second copy
      expect(await status(staffSameValue)).toBe('active');
      expect(await status(directionsOnly)).toBe('active');
      expect((await live(c.id, 'garage')).filter((r) => r.code)).toHaveLength(1);
      expect((await profile(c.id)).garage_code).toBe('2468');
    });

    test('a field the editor empties takes the office rows of its kind with it, once the sweep had mirrored a value', async () => {
      const c = await customer({ prefs: { lockbox_code: '1212' } });
      await mirror();
      const staff = await staffRow(c.id, { kind: 'lockbox', code: '3434' });
      await edit(c.id, { lockbox_code: null });
      await mirror();
      expect((await trx('customer_access_codes').where({ id: staff.id }).first()).status).toBe('retired');
      expect(await live(c.id, 'lockbox')).toEqual([]);
    });

    test('a field that never held a mirrored value leaves older office rows alone', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      const staff = await staffRow(c.id, { kind: 'lockbox', code: '3434' });
      await mirror();
      expect((await trx('customer_access_codes').where({ id: staff.id }).first()).status).toBe('active');
    });

    test('retiring the mirrored row in the office clears the same value from the profile, and the mirror leaves it cleared', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      const [row] = await live(c.id, 'garage');
      expect(await access.retire(trx, row.id, { adminUserId: ADMIN_ID })).toMatchObject({ ok: true, clearedField: 'garage_code' });
      expect((await profile(c.id)).garage_code).toBeNull();
      await mirror();
      expect(await live(c.id, 'garage')).toEqual([]);
    });

    test('an office accept replaces the profile value and the mirror keeps it (the accept is not undone)', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      const row = await found(c.id, { kind: 'garage', code: '1357' });
      await access.accept(trx, row.id, { adminUserId: ADMIN_ID });
      await edit(c.id, {});
      await mirror();
      expect((await live(c.id, 'garage')).map((r) => [r.code, r.source_type])).toEqual([['1357', 'sms']]);
      expect((await profile(c.id)).garage_code).toBe('1357');
    });

    test('a customer with several homes is skipped, and a value the table cannot hold is left out', async () => {
      const multi = await customer({ properties: 2, prefs: { garage_code: '2468' } });
      const odd = await customer({ prefs: { lockbox_code: 'x'.repeat(41), garage_code: '1357' } });
      expect(await mirror()).toMatchObject({ checked: 2, created: 1, failed: 0 });
      expect(await live(multi.id)).toEqual([]);
      expect((await live(odd.id)).map((r) => r.code)).toEqual(['1357']);
    });

    test('gate off: the tick mirrors nothing', async () => {
      process.env.GATE_ACCESS_CODES_SECTION = 'false';
      const c = await customer({ prefs: { garage_code: '2468' } });
      expect(await sweep(stub([]))).toMatchObject({ skipped: 'gate_off' });
      expect(await live(c.id)).toEqual([]);
      expect(await trx('access_code_profile_mirror').where({ subject_id: c.id })).toEqual([]);
    });

    test('the tick mirrors with the gate on, and a failure fails the job', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      expect(await sweep(stub([]))).toMatchObject({ mirror: { checked: 1, created: 1, failed: 0 } });
      expect((await live(c.id)).map((r) => r.source_type)).toEqual(['profile']);
      delete process.env.GATE_ACCESS_CODES_SECTION_SINCE;
      const d = await customer({ prefs: { lockbox_code: '1212' } });
      expect(await sweep(stub([]))).toMatchObject({ skipped: 'activation_time_required', mirror: { created: 1 } });
      expect((await live(d.id)).map((r) => r.kind)).toEqual(['lockbox']);
    });

    test('a deleted customer is not mirrored', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await trx('customers').where({ id: c.id }).update({ deleted_at: new Date() });
      expect(await mirror()).toMatchObject({ checked: 0 });
      expect(await live(c.id)).toEqual([]);
    });

    test('the visit read marks the profile-backed kinds profileBacked on a one-home account and drops nothing', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      await staffRow(c.id, { kind: 'door', code: '7716' });
      await staffRow(c.id, { kind: 'call_box', code: '55' });
      const v = await atVisit(c.id, c.propertyIds[0]);
      const out = await access.listForVisit(trx, { techRole: 'admin' }, v);
      expect(out.codes.map((r) => [r.kind, r.code, r.profileBacked === true]).sort())
        .toEqual([['call_box', '55', false], ['door', '7716', false], ['garage', '2468', true]]);
      // the office list still has the mirrored row
      expect((await access.listForCustomer(trx, c.id)).active.map((r) => r.sourceType)).toContain('profile');
    });

    test('the visit read marks standing code rows of a profile-backed kind, not directions-only or visit-life rows', async () => {
      const c = await customer();
      const bare = await staffRow(c.id, { kind: 'lockbox', code: '1212' });
      const directions = await staffRow(c.id, { kind: 'lockbox', code: null, instructions: 'Behind the water meter' });
      const v = await atVisit(c.id, c.propertyIds[0]);
      const out = await access.listForVisit(trx, { techRole: 'admin' }, v);
      expect(out.codes.find((r) => r.id === bare.id)).toMatchObject({ profileBacked: true });
      expect(out.codes.find((r) => r.id === directions.id)).not.toHaveProperty('profileBacked');
      expect(Object.keys(out.codes.find((r) => r.id === bare.id)).sort())
        .toEqual(['code', 'id', 'instructions', 'kind', 'life', 'profileBacked', 'scheduledServiceId']);
    });

    test('the visit read keeps every kind for a multi-home account', async () => {
      const c = await customer({ properties: 2, prefs: { garage_code: '2468' } });
      const [a, b] = c.propertyIds;
      const row = await found(c.id, { kind: 'garage', code: '2468' });
      await access.accept(trx, row.id, { propertyId: a });
      const atA = await atVisit(c.id, a);
      const atB = await atVisit(c.id, b);
      const out = await access.listForVisit(trx, { techRole: 'admin' }, atA);
      expect(out.codes.map((r) => r.code)).toEqual(['2468']);
      expect(out.codes[0]).not.toHaveProperty('profileBacked');
      expect((await access.listForVisit(trx, { techRole: 'admin' }, atB)).codes).toEqual([]);
    });

    test('a home added after the mirror: the customer is skipped and no row moves', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      const [row] = await live(c.id, 'garage');
      expect(row.property_id).toBe(c.propertyIds[0]);
      const second = randomUUID();
      await trx('customer_properties').insert({
        id: second, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '810 Other Court', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      // the profile changes too: a multi-home account is not mirrored, so the old row stays on its own home
      await edit(c.id, { garage_code: '1357' });
      expect(await mirror()).toMatchObject({ checked: 1, created: 0, retired: 0 });
      const after = await live(c.id, 'garage');
      expect(after.map((r) => [r.id, r.code, r.property_id])).toEqual([[row.id, '2468', c.propertyIds[0]]]);
      // strict home rule: shown at the first home only
      const atFirst = await atVisit(c.id, c.propertyIds[0]);
      const atSecond = await atVisit(c.id, second);
      expect((await access.listForVisit(trx, { techRole: 'admin' }, atFirst)).codes.map((r) => r.code)).toEqual(['2468']);
      expect((await access.listForVisit(trx, { techRole: 'admin' }, atSecond)).codes).toEqual([]);
    });

    test('a customer who drops back to one home is mirrored again', async () => {
      const c = await customer({ properties: 2, prefs: { garage_code: '2468' } });
      await mirror();
      expect(await live(c.id)).toEqual([]);
      await trx('customer_properties').where({ id: c.propertyIds[1] }).update({ active: false });
      expect(await mirror()).toMatchObject({ checked: 1, created: 1 });
      expect((await live(c.id)).map((r) => [r.code, r.property_id])).toEqual([['2468', c.propertyIds[0]]]);
    });

    test('a technician reads a one-home visit with the mirrored code marked profileBacked', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      const techId = await tech();
      const v = await visit(c.id, etDateString(new Date()));
      await trx('scheduled_services').where({ id: v }).update({ technician_id: techId });
      const out = await access.listForVisit(trx, { techRole: 'technician', technicianId: techId }, v);
      expect(out).toMatchObject({ ok: true, codes: [{ kind: 'garage', code: '2468', profileBacked: true }] });
    });

    test('a field edited to a value the table cannot hold retires the mirrored row, keeping the profile', async () => {
      const c = await customer({ prefs: { garage_code: '2468', lockbox_code: '1212' } });
      await mirror();
      const long = 'x'.repeat(41);
      await edit(c.id, { garage_code: long });
      expect(await mirror()).toMatchObject({ retired: 1, created: 0 });
      expect((await live(c.id)).map((r) => [r.kind, r.code])).toEqual([['lockbox', '1212']]);
      expect((await profile(c.id)).garage_code).toBe(long);
      // control characters too, and an adopted office row of the old value goes with it
      const staff = await staffRow(c.id, { kind: 'lockbox', code: '1212' });
      await edit(c.id, { lockbox_code: '12\n12' });
      await mirror();
      expect(await live(c.id)).toEqual([]);
      expect((await trx('customer_access_codes').where({ id: staff.id }).first()).status).toBe('retired');
    });

    test('mirror-only path (no activation time): a failed mirror fails the job with the tally', async () => {
      delete process.env.GATE_ACCESS_CODES_SECTION_SINCE;
      await customer({ prefs: { garage_code: '2468' } });
      const failing = new Proxy((...args) => trx(...args), {
        get(_t, key) {
          if (key === 'transaction') return () => Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' }));
          const value = trx[key];
          return typeof value === 'function' ? value.bind(trx) : value;
        },
      });
      await expect(access.runAccessCodeNet({ now: NOW, conn: failing, read: stub([]) })).rejects
        .toMatchObject({ code: 'ACCESS_NET_FAILURES', tally: { skipped: 'activation_time_required', mirror: { failed: 1 } } });
    });

    test('the only home changes: the former home\'s profile rows retire at once and the new home gets them', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      const [a] = c.propertyIds;
      const b = randomUUID();
      await trx('customer_properties').insert({
        id: b, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '810 Other Court', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      await mirror();
      expect((await live(c.id)).map((r) => r.property_id)).toEqual([a]);
      await trx('customer_properties').where({ id: a }).update({ active: false });
      // no profile edit, no day passed: the changed sole home alone makes it due
      expect(await mirror()).toMatchObject({ checked: 1, created: 1, retired: 1 });
      expect((await live(c.id)).map((r) => [r.code, r.property_id])).toEqual([['2468', b]]);
      const old = await trx('customer_access_codes').where({ customer_id: c.id, property_id: a }).first();
      expect(old.status).toBe('retired');
      expect(await mirror()).toMatchObject({ checked: 0 });
    });

    test('a profile code that differs only by letter case adopts the office row and keeps its directions', async () => {
      const c = await customer({ prefs: { garage_code: 'AB12' } });
      const [a] = c.propertyIds;
      const office = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: 'ab12', instructions: 'Side keypad', propertyId: a });
      await trx('property_preferences').where({ customer_id: c.id }).update({ garage_code: 'AB12', updated_at: trx.fn.now() });
      await mirror();
      expect((await trx('customer_access_codes').where({ id: office.row.id }).first()).status).toBe('active');
    });

    test('the receipt table is invisible to the customer merge (no customer_id column, no foreign key)', async () => {
      const cols = await trx('information_schema.columns').where({ table_name: 'access_code_profile_mirror' }).pluck('column_name');
      expect(cols).toContain('subject_id');
      expect(cols).not.toContain('customer_id');
      const fks = await trx.raw("SELECT 1 FROM pg_constraint WHERE conrelid = 'access_code_profile_mirror'::regclass AND contype = 'f'");
      expect(fks.rows).toHaveLength(0);
    });

    test('rows that differ only by case collapse to one, and the receipt keeps the adopted row\'s hash', async () => {
      const c = await customer({ prefs: { garage_code: 'AB12' } });
      const [a] = c.propertyIds;
      const one = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: 'ab12', propertyId: a });
      const [two] = await trx('customer_access_codes').insert({ customer_id: c.id, property_id: a, kind: 'garage', code: 'Ab12', life: 'standing',
        status: 'active', source_type: 'staff', value_hash: access.valueHash('Ab12'), created_at: new Date(Date.now() + 1000) }).returning('*');
      await trx('property_preferences').where({ customer_id: c.id }).update({ garage_code: 'AB12', updated_at: trx.fn.now() });
      await mirror();
      expect((await live(c.id)).map((r) => r.id)).toEqual([one.row.id]);
      expect((await trx('customer_access_codes').where({ id: two.id }).first()).status).toBe('retired');
      expect((await trx('access_code_profile_mirror').where({ subject_id: c.id }).first()).hashes.garage).toBe(access.valueHash('ab12'));
    });

    test('a mirrored row stays in view after its hashes were cleared, so an emptied field still retires it', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      await mirror();
      const b = randomUUID();
      await trx('customer_properties').insert({
        id: b, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '810 Other Court', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      await mirror();
      await trx('customer_properties').where({ id: b }).update({ active: false });
      await trx('property_preferences').where({ customer_id: c.id }).update({ garage_code: null, updated_at: trx.fn.now() });
      await mirror();
      expect(await live(c.id)).toEqual([]);
    });

    test('an adopted older row with no home is bound to the sole home', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      const [a] = c.propertyIds;
      const old = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', propertyId: a });
      await trx('customer_access_codes').where({ id: old.row.id }).update({ property_id: null });
      await mirror();
      expect((await trx('customer_access_codes').where({ id: old.row.id }).first()).property_id).toBe(a);
    });

    test('a multi-home pass forgets the per-kind hashes, so a later return to one home starts fresh', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      const [a] = c.propertyIds;
      await mirror();
      const b = randomUUID();
      await trx('customer_properties').insert({
        id: b, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '810 Other Court', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      await mirror();
      expect((await trx('access_code_profile_mirror').where({ subject_id: c.id }).first()).hashes).toEqual({});
      expect(a).toBeTruthy();
    });

    test('the only home changes: a door code equal to the mirrored garage code is not retired', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      const [a] = c.propertyIds;
      await mirror();
      const door = await access.addByStaff(trx, { customerId: c.id, kind: 'door', life: 'standing', code: '2468', propertyId: a });
      const b = randomUUID();
      await trx('customer_properties').insert({
        id: b, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '810 Other Court', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      await trx('customer_properties').where({ id: a }).update({ active: false });
      await mirror();
      expect((await trx('customer_access_codes').where({ id: door.row.id }).first()).status).toBe('active');
    });

    test('the only home changes: an office row the mirror adopted by value retires too', async () => {
      const c = await customer({ prefs: { garage_code: '2468' } });
      const [a] = c.propertyIds;
      const staff = await access.addByStaff(trx, { customerId: c.id, kind: 'garage', life: 'standing', code: '2468', propertyId: a });
      await mirror();
      expect((await live(c.id)).map((r) => r.id)).toEqual([staff.row.id]);
      const b = randomUUID();
      await trx('customer_properties').insert({
        id: b, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '810 Other Court', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      await trx('customer_properties').where({ id: a }).update({ active: false });
      await mirror();
      expect((await trx('customer_access_codes').where({ id: staff.row.id }).first()).status).toBe('retired');
      expect((await live(c.id)).map((r) => [r.code, r.property_id])).toEqual([['2468', b]]);
    });
  });

  describe('texts from a number with no customer, and passes shared with the neighborhood', () => {
    const SENDER = '+19415550188';
    const PASS_TEXT = 'Gate Systems shared with you a Visitor Pass to visit 4455 Example Lane, Lakewood Ranch, FL 34202. View your pass: https://pass.example.com/v/abc123';
    const LINK = 'https://pass.example.com/v/abc123';
    const passItem = (extra = {}) => ({ kind: 'pass', code: null, instructions: `View your pass: ${LINK}`, life: 'standing', quote: PASS_TEXT, ...extra });
    const hood = async (name = 'Example Glen') => {
      const id = randomUUID();
      await trx('neighborhoods').insert({ id, name, county: 'Manatee', match_key: `manatee|${name.toLowerCase()}|${id}`, source: 'office' });
      return id;
    };
    const unlinked = (extra = {}) => trx('customer_access_codes').whereNull('customer_id').where(extra).orderBy('created_at');
    const OLD_HOOD_GATE = process.env.GATE_NEIGHBORHOOD_ACCESS;
    afterEach(() => { if (OLD_HOOD_GATE === undefined) delete process.env.GATE_NEIGHBORHOOD_ACCESS; else process.env.GATE_NEIGHBORHOOD_ACCESS = OLD_HOOD_GATE; });

    test('a pass link texted from a number with no customer is filed unlinked, with the one home it names suggested', async () => {
      const home = await customer();
      await customer({ house: '9001' });
      const messageId = await text(null, PASS_TEXT, { from: SENDER });
      const read = stub([passItem()]);
      expect(await sweep(read)).toMatchObject({ scanned: 1, read: 1, found: 1, failed: 0 });
      const [row, ...rest] = await unlinked();
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        customer_id: null, sender_phone: SENDER, suggested_customer_id: home.id, kind: 'pass', code: null,
        instructions: `View your pass: ${LINK}`, status: 'found', source_type: 'sms', source_id: messageId,
        // the home the text named, kept so the card shows its address
        property_id: home.propertyIds[0],
      });
      expect((await receipts(messageId))[0]).toMatchObject({ status: 'ok', proposal_count: 1 });
      expect(await sweep(read)).toMatchObject({ scanned: 0, found: 0 });
      // Receipt gone: the same text files nothing twice.
      await trx('data_hygiene_source_extractions').where({ source_id: messageId }).del();
      expect(await sweep(read)).toMatchObject({ scanned: 1, found: 0, failed: 0 });
      expect(await unlinked()).toHaveLength(1);
    });

    test('two homes at the named address suggest nobody; the office picks', async () => {
      await customer();
      await customer();
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      expect((await unlinked())[0]).toMatchObject({ sender_phone: SENDER, suggested_customer_id: null });
    });

    test('a different ZIP in the text rules the home out', async () => {
      await customer({ zip: '34219' });
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      expect((await unlinked())[0].suggested_customer_id).toBeNull();
    });

    test('the unlinked read refuses the house number and ZIP the text itself names, and a bare direction', async () => {
      const body = 'Visit 4455 Example Lane, Lakewood Ranch, FL 34202. Gate code 4455 and the guard house list is on the desk';
      await text(null, body, { from: SENDER });
      const read = stub([
        { kind: 'neighborhood_gate', code: '4455', instructions: null, life: 'standing', quote: 'Gate code 4455' },
        { kind: 'neighborhood_gate', code: '34202', instructions: null, life: 'standing', quote: 'FL 34202' },
        { kind: 'other', code: null, instructions: 'the guard house list is on the desk', life: 'standing', quote: 'the guard house list is on the desk' },
      ]);
      expect(await sweep(read)).toMatchObject({ read: 1, found: 0 });
      expect(await unlinked()).toEqual([]);
    });

    test('a link cropped part-way is refused; the whole link is kept', async () => {
      await text(null, PASS_TEXT, { from: SENDER });
      expect(await sweep(stub([passItem({ instructions: 'View your pass: https://pass.example.com/v/abc' })]))).toMatchObject({ found: 0 });
      expect(await unlinked()).toEqual([]);
    });

    test('a text with no customer is eligible only inbound, from a number, to one of ours', async () => {
      await text(null, PASS_TEXT, { from: SENDER, to: '+19415550001' });
      await text(null, PASS_TEXT, { direction: 'outbound', from: SENDER });
      const read = stub([passItem()]);
      expect(await sweep(read)).toMatchObject({ found: 0 });
      expect(await unlinked()).toEqual([]);
    });

    test('accept before a link is refused; dismiss works on an unlinked row', async () => {
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      const [row] = await unlinked();
      let res = await call('POST', `/${row.id}/accept`, {});
      expect([res.status, res.body.code]).toEqual([409, 'link_required']);
      res = await call('POST', `/${row.id}/dismiss`);
      expect([res.status, res.body.accessCode.status, res.body.accessCode.customerId]).toEqual([200, 'dismissed', null]);
      // A dismissed text is not filed again.
      expect(await sweep(stub([passItem()]))).toMatchObject({ found: 0 });
    });

    test('the found list shows the sender and the suggested home, then the link makes it an ordinary found row', async () => {
      const home = await customer();
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      let res = await call('GET', '/found');
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        customerId: null, customerName: null, senderPhone: SENDER,
        suggestedCustomer: { id: home.id, name: 'Sample Owner', address: '4455 Example Lane, Lakewood Ranch' },
      });
      const id = res.body.items[0].id;
      res = await call('POST', `/${id}/link`, { customerId: home.id }, { 'x-test-admin': ADMIN_ID });
      expect([res.status, res.body.accessCode.customerId, res.body.accessCode.senderPhone, res.body.accessCode.propertyId])
        .toEqual([200, home.id, null, home.propertyIds[0]]);
      const audits = JSON.stringify(await trx('audit_log').where({ action: 'access_code.linked', resource_id: id }).select('metadata'));
      expect(audits).toContain(home.id);
      expect(audits).not.toContain(LINK);
      res = await call('GET', '/found');
      expect(res.body.items[0]).toMatchObject({ customerId: home.id, customerName: 'Sample Owner', suggestedCustomer: null });
      res = await call('POST', `/${id}/link`, { customerId: home.id });
      expect([res.status, res.body.code]).toEqual([409, 'not_unlinked']);
      res = await call('POST', `/${id}/accept`, {}, { 'x-test-admin': ADMIN_ID });
      expect([res.status, res.body.accessCode.status]).toEqual([200, 'active']);
      expect((await call('GET', `/?customerId=${home.id}`)).body.active.map((r) => r.instructions)).toEqual([`View your pass: ${LINK}`]);
    });

    test('the suggested home shows its unit; a suggested home that is gone is never swapped for the home left', async () => {
      const home = await customer({ properties: 2 });
      await trx('customer_properties').where({ id: home.propertyIds[0] }).update({ address_line2: 'Apt 4' });
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      let res = await call('GET', '/found');
      expect(res.body.items[0].suggestedCustomer).toMatchObject({ id: home.id, address: '4455 Example Lane, Apt 4, Lakewood Ranch' });
      const id = res.body.items[0].id;
      await trx('customer_properties').where({ id: home.propertyIds[0] }).update({ active: false });
      res = await call('POST', `/${id}/link`, { customerId: home.id });
      expect([res.status, res.body.accessCode.propertyId]).toEqual([200, null]);
      res = await call('POST', `/${id}/accept`, {});
      expect([res.status, res.body.code]).toEqual([400, 'property_required']);
      res = await call('POST', `/${id}/accept`, { propertyId: home.propertyIds[1] });
      expect([res.status, res.body.accessCode.propertyId]).toEqual([200, home.propertyIds[1]]);
    });

    test('link refuses a missing customer, a bad id and a row that is not waiting', async () => {
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      const [row] = await unlinked();
      const home = await customer();
      let res = await call('POST', `/${row.id}/link`, { customerId: randomUUID() });
      expect([res.status, res.body.code]).toEqual([404, 'customer_not_found']);
      res = await call('POST', `/${row.id}/link`, { customerId: 'nope' });
      expect([res.status, res.body.code]).toEqual([400, 'invalid_customer']);
      res = await call('POST', `/${row.id}/link`, ['x']);
      expect([res.status, res.body.code]).toEqual([400, 'invalid_body']);
      res = await call('POST', `/${randomUUID()}/link`, { customerId: home.id });
      expect([res.status, res.body.code]).toEqual([404, 'not_found']);
      await call('POST', `/${row.id}/dismiss`);
      res = await call('POST', `/${row.id}/link`, { customerId: home.id });
      expect([res.status, res.body.code]).toEqual([409, 'not_pending']);
    });

    test('a text that later gets a customer drops its unlinked rows and files for that customer', async () => {
      const home = await customer();
      const messageId = await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      await trx('sms_log').where({ id: messageId }).update({ customer_id: home.id });
      // Hidden at once (its text has an owner), then read again for that owner.
      expect((await call('GET', '/found')).body.items).toEqual([]);
      expect(await sweep(stub([passItem()]))).toMatchObject({ found: 1 });
      expect(await unlinked()).toEqual([]);
      expect((await rows(home.id)).map((r) => r.status)).toEqual(['found']);
    });

    test('a text corrected to say nothing clears its unlinked row, and the one the office linked', async () => {
      const home = await customer();
      const messageId = await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      const [row] = await unlinked();
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      expect(await unlinked()).toHaveLength(2);
      await call('POST', `/${row.id}/link`, { customerId: home.id });
      await trx('sms_log').where({ id: messageId }).update({ message_body: 'Thanks, see you Tuesday' });
      await sweep(stub([]));
      expect(await rows(home.id)).toEqual([]);
      expect(await unlinked()).toHaveLength(1);
    });

    // A pass is shared at READ time: the visit read adds the active standing
    // passes of other live customers in the same neighborhood. Nothing is copied
    // into the neighborhood directory.
    const inHood = (c, hoodId, index = 0) => trx('customer_properties').where({ id: c.propertyIds[index] }).update({ neighborhood_id: hoodId });
    const visitAtHome = async (c, index = 0) => {
      const id = await visit(c.id, day(0));
      await trx('scheduled_services').where({ id }).update({ property_id: c.propertyIds[index] });
      return id;
    };
    const readVisit = (id) => access.listForVisit(trx, { techRole: 'admin' }, id);
    const addPass = (c, extra = {}) => call('POST', '/', { customerId: c.id, kind: 'pass', life: 'standing', instructions: `View your pass: ${LINK}`, ...extra });
    const directoryRows = () => trx('neighborhood_access');

    test('a switched-off neighborhood shares no pass, and more than twenty passes all come back', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const neighbor = await customer({ house: '4460' });
      const hoodId = await hood();
      await inHood(neighbor, hoodId);
      for (let i = 0; i < 22; i += 1) {
        const owner = await customer({ house: String(5000 + i) });
        await inHood(owner, hoodId);
        expect((await addPass(owner, { instructions: `View your pass: ${LINK}?p=${i}` })).status).toBe(200);
      }
      const atNeighbor = await visitAtHome(neighbor);
      expect((await readVisit(atNeighbor)).codes).toHaveLength(22);
      await trx('neighborhoods').where({ id: hoodId }).update({ active: false });
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
    });

    test('a pass is shared with the neighbors at read time, never copied into the directory', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const owner = await customer();
      const neighbor = await customer({ house: '4460' });
      const hoodId = await hood();
      await inHood(owner, hoodId);
      await inHood(neighbor, hoodId);
      const res = await addPass(owner);
      expect(res.status).toBe(200);
      expect(res.body.accessCode).not.toHaveProperty('inNeighborhoodDirectory');
      const passId = res.body.accessCode.id;
      const atNeighbor = await visitAtHome(neighbor);
      const out = await readVisit(atNeighbor);
      expect(out.codes).toEqual([{ id: passId, kind: 'pass', code: null, instructions: `View your pass: ${LINK}`, life: 'standing', scheduledServiceId: null, shared: true }]);
      // Nothing of the owner leaks into the projection.
      expect(JSON.stringify(out)).not.toContain(owner.id);
      // The owner sees its own pass (not marked shared); nothing is in the directory.
      expect((await readVisit(await visitAtHome(owner))).codes.map((r) => [r.id, r.shared])).toEqual([[passId, undefined]]);
      expect(await directoryRows()).toEqual([]);
      expect(await trx('information_schema.columns').where({ table_name: 'customer_access_codes', column_name: 'neighborhood_access_id' })).toEqual([]);
      // The directory gate off: the pass is the owner's alone.
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'false';
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      // Retired by its owner: gone for the neighbor at once.
      await call('POST', `/${passId}/retire`);
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
    });

    test('a shared pass follows the home\'s current neighborhood', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const owner = await customer();
      const neighbor = await customer({ house: '4460' });
      const hoodA = await hood('Alpha Glen');
      const hoodB = await hood('Beta Glen');
      await inHood(owner, hoodA);
      await inHood(neighbor, hoodA);
      await addPass(owner);
      const atNeighbor = await visitAtHome(neighbor);
      expect((await readVisit(atNeighbor)).codes).toHaveLength(1);
      // The owner's home moves to another neighborhood: the old one stops showing it.
      await inHood(owner, hoodB);
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
      // The neighbor's home joins the new one: it shows again; with no neighborhood it never does.
      await inHood(neighbor, hoodB);
      expect((await readVisit(atNeighbor)).codes).toHaveLength(1);
      await trx('customer_properties').where({ id: neighbor.propertyIds[0] }).update({ neighborhood_id: null });
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
    });

    test('only an active standing pass with no keypad code, of a live customer with an active home, is shared', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const hoodId = await hood();
      const neighbor = await customer({ house: '4460' });
      await inHood(neighbor, hoodId);
      const atNeighbor = await visitAtHome(neighbor);
      const owner = await customer();
      await inHood(owner, hoodId);
      await addPass(owner, { code: '4821', instructions: 'Guest code at the visitor lane' });
      await addPass(owner, { life: 'visit', instructions: 'Show the QR pass today' });
      // A waiting (found) pass is not shared until the office accepts it.
      await found(owner.id, { kind: 'pass', code: null, instructions: 'Waiting pass text', life: 'standing' });
      await addPass(owner, { instructions: 'Scan the guest QR at the guard house' });
      expect((await readVisit(atNeighbor)).codes.map((r) => r.instructions)).toEqual(['Scan the guest QR at the guard house']);
      await trx('customers').where({ id: owner.id }).update({ deleted_at: new Date() });
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
      await trx('customers').where({ id: owner.id }).update({ deleted_at: null });
      await trx('customer_properties').where({ id: owner.propertyIds[0] }).update({ active: false });
      expect((await readVisit(atNeighbor)).codes).toEqual([]);
    });

    test('the same pass from two neighbors, or already the customer\'s own, is listed once', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const hoodId = await hood();
      const [one, two, me] = [await customer(), await customer({ house: '4460' }), await customer({ house: '4470' })];
      for (const c of [one, two, me]) await inHood(c, hoodId);
      await addPass(one);
      await addPass(two);
      await addPass(one, { instructions: 'Scan the guest QR at the guard house' });
      const atMe = await visitAtHome(me);
      expect((await readVisit(atMe)).codes.map((r) => r.instructions).sort())
        .toEqual(['Scan the guest QR at the guard house', `View your pass: ${LINK}`]);
      await addPass(me);
      const out = (await readVisit(atMe)).codes;
      expect(out.filter((r) => r.instructions === `View your pass: ${LINK}`).map((r) => r.shared)).toEqual([undefined]);
    });

    test('a pass in the neighborhood is not shown when the visit moves to another neighborhood while it is read', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const hoodA = await hood('Alpha Glen');
      const hoodB = await hood('Beta Glen');
      const owner = await customer();
      const neighbor = await customer({ house: '4460' });
      await inHood(owner, hoodA);
      await inHood(neighbor, hoodA);
      await addPass(owner);
      const atNeighbor = await visitAtHome(neighbor);
      // The neighbor's home changes neighborhood once the neighbors' passes are read.
      let calls = 0;
      const conn = new Proxy(trx, {
        apply(target, self, args) {
          const builder = target(...args);
          // The second read of the code table is the neighbors' passes (the first is the customer's own).
          if (args[0] !== 'customer_access_codes as a' || (calls += 1) !== 2) return builder;
          const origThen = builder.then.bind(builder);
          builder.then = (resolve, reject) => origThen(async (rows) => {
            await trx('customer_properties').where({ id: neighbor.propertyIds[0] }).update({ neighborhood_id: hoodB });
            return rows;
          }).then(resolve, reject);
          return builder;
        },
      });
      const out = await access.listForVisit(conn, { techRole: 'admin' }, atNeighbor);
      expect([out.ok, out.status, out.code]).toEqual([false, 409, 'visit_changed']);
    });

    test('a multi-home pass needs its home and shows at that home\'s visit only', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const c = await customer({ properties: 2 });
      const [a, b] = c.propertyIds;
      const hoodA = await hood('Alpha Glen');
      const hoodB = await hood('Beta Glen');
      await trx('customer_properties').where({ id: a }).update({ neighborhood_id: hoodA });
      await trx('customer_properties').where({ id: b }).update({ neighborhood_id: hoodB });
      await text(null, PASS_TEXT, { from: SENDER });
      await sweep(stub([passItem()]));
      const [row] = await unlinked();
      // Linked, the row keeps the home the text named (home a); the office can name another.
      let res = await call('POST', `/${row.id}/link`, { customerId: c.id });
      expect([res.status, res.body.accessCode.propertyId]).toEqual([200, a]);
      res = await call('POST', `/${row.id}/accept`, { propertyId: b }, { 'x-test-admin': ADMIN_ID });
      expect([res.status, res.body.accessCode.propertyId]).toEqual([200, b]);
      expect(await directoryRows()).toEqual([]);
      expect((await readVisit(await visitAtHome(c, 0))).codes).toEqual([]);
      expect((await readVisit(await visitAtHome(c, 1))).codes.map((r) => r.instructions)).toEqual([`View your pass: ${LINK}`]);
      // A neighbor of the first home does not get the second home's pass.
      const other = await customer({ house: '4490' });
      await inHood(other, hoodA);
      expect((await readVisit(await visitAtHome(other))).codes).toEqual([]);
    });

    test('a newer pass with the same code replaces the older one, and the older leaves the shared read', async () => {
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const hoodId = await hood();
      const owner = await customer();
      const neighbor = await customer({ house: '4460' });
      await inHood(owner, hoodId);
      await inHood(neighbor, hoodId);
      await addPass(owner, { instructions: 'Scan the guest QR at the guard house' });
      const atNeighbor = await visitAtHome(neighbor);
      expect((await readVisit(atNeighbor)).codes).toHaveLength(1);
      await call('POST', `/${(await rows(owner.id))[0].id}/retire`);
      await addPass(owner, { instructions: 'Scan the new guest QR at the guard house' });
      expect((await readVisit(atNeighbor)).codes.map((r) => r.instructions)).toEqual(['Scan the new guest QR at the guard house']);
    });

    describe('the suggested customer is a full address match', () => {
      const BODY = 'Visitor pass for 100 Main St N, Apt 5, Lakewood Ranch, FL 34202. View your pass: https://pass.example.com/v/zz1';
      const home = async (line1, line2) => {
        const c = await customer({ properties: 0 });
        await trx('customer_properties').insert({
          id: randomUUID(), customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
          address_line1: line1, address_line2: line2, city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
        });
        return c.id;
      };
      test('the street, directional and unit all match: that customer is suggested', async () => {
        const north5 = await home('100 Main St N', 'Apt 5');
        await home('100 Main St S', 'Apt 4');
        expect(await access.suggestCustomer(trx, BODY)).toBe(north5);
      });
      test('a ZIP qualifies only the address it follows', async () => {
        await home('100 Main St N', 'Apt 5');
        const two = 'Pass for 100 Main St N, Apt 5, FL 34231 and 200 Oak St, FL 34202';
        expect(await access.suggestCustomer(trx, two)).toBeNull();
      });
      test('the suggestion keeps the home that matched, and the found list shows its address', async () => {
        const c = await customer({ properties: 0 });
        const main = randomUUID();
        const second = randomUUID();
        await trx('customer_properties').insert([
          { id: main, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true, address_line1: '9 Other Way', city: 'Bradenton', zip: '34202', active: true, address_key: randomUUID() },
          { id: second, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false, address_line1: '100 Main St N', address_line2: 'Apt 5', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID() },
        ]);
        expect(await access.suggestedHome(trx, BODY)).toEqual({ customerId: c.id, propertyId: second });
      });
      test('two units at one street number: the unit the text names is the home kept', async () => {
        const c = await customer({ properties: 0 });
        const unit4 = randomUUID();
        const unit5 = randomUUID();
        await trx('customer_properties').insert([
          { id: unit4, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true, address_line1: '100 Main St N', address_line2: 'Apt 4', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID() },
          { id: unit5, customer_id: c.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false, address_line1: '100 Main St N', address_line2: 'Apt 5', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID() },
        ]);
        expect(await access.suggestedHome(trx, BODY)).toEqual({ customerId: c.id, propertyId: unit5 });
      });
      test('a different directional or unit suggests nobody', async () => {
        await home('100 Main St S', 'Apt 4');
        expect(await access.suggestCustomer(trx, BODY)).toBeNull();
        await home('100 Main St N', 'Apt 4');
        expect(await access.suggestCustomer(trx, BODY)).toBeNull();
        await home('100 Main St', 'Apt 5');
        expect(await access.suggestCustomer(trx, BODY)).toBeNull();
      });
      test('long and short spellings of the same street match; a text that names no unit matches the home', async () => {
        const id = await home('100 Main Street North #5', null);
        expect(await access.suggestCustomer(trx, BODY)).toBe(id);
        expect(await access.suggestCustomer(trx, 'Visitor pass for 100 Main St North, FL 34202. https://pass.example.com/v/zz1')).toBe(id);
      });
    });

    describe('a numeric code that is the customer\'s house number or ZIP is refused at link and at accept', () => {
      const unlinkedGateCode = async (code) => {
        await text(null, `Our community gate code is ${code}, call if it fails`, { from: SENDER });
        await sweep(stub([gateItem({ code, quote: `community gate code is ${code}` })]));
        return (await unlinked())[0];
      };
      test('link refuses a code equal to a house number or ZIP of the chosen customer', async () => {
        const row = await unlinkedGateCode('4455');
        const home = await customer({ house: '4455' });
        let res = await call('POST', `/${row.id}/link`, { customerId: home.id });
        expect([res.status, res.body.code]).toEqual([409, 'code_is_address']);
        expect((await trx('customer_access_codes').where({ id: row.id }).first()).customer_id).toBeNull();
        const other = await customer({ house: '4460' });
        res = await call('POST', `/${row.id}/link`, { customerId: other.id });
        expect(res.status).toBe(200);
      });
      test('link refuses a ZIP, and a house number written with its symbol', async () => {
        const zipRow = await unlinkedGateCode('34202');
        const home = await customer({ house: '4460' });
        let res = await call('POST', `/${zipRow.id}/link`, { customerId: home.id });
        expect([res.status, res.body.code]).toEqual([409, 'code_is_address']);
        await text(null, 'The side gate code is #4455', { from: SENDER, at: '2040-03-10T15:30:00Z' });
        await sweep(stub([gateItem({ code: '#4455', quote: 'The side gate code is #4455' })]));
        const [, symbolRow] = await unlinked();
        const same = await customer({ house: '4455' });
        res = await call('POST', `/${symbolRow.id}/link`, { customerId: same.id });
        expect([res.status, res.body.code]).toEqual([409, 'code_is_address']);
      });
      test('accept refuses the text\'s own code when the customer\'s home has since become that number', async () => {
        const row = await unlinkedGateCode('4455');
        const home = await customer({ house: '4460' });
        expect((await call('POST', `/${row.id}/link`, { customerId: home.id })).status).toBe(200);
        await trx('customer_properties').where({ id: home.propertyIds[0] }).update({ address_line1: '4455 Example Lane' });
        const res = await call('POST', `/${row.id}/accept`, {}, { 'x-test-admin': ADMIN_ID });
        expect([res.status, res.body.code]).toEqual([409, 'code_is_address']);
        expect((await trx('customer_access_codes').where({ id: row.id }).first()).status).toBe('found');
        // A code the office typed over it is the office's own.
        const typed = await call('POST', `/${row.id}/accept`, { code: '9911' }, { 'x-test-admin': ADMIN_ID });
        expect([typed.status, typed.body.accessCode?.status]).toEqual([200, 'active']);
      });
    });
  });

});
