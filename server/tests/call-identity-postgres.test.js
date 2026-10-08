const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ isInternalNumber: () => false, isOwnedNumber: () => false }));
const { _test: { findReusableCallLead, extractedNameMatchesCustomer } } = require('../services/call-recording-processor');
const { spokenFirstNameSoundKey, spokenFirstNameSoundKeySql } = require('../utils/name-match');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('caller identity lookup on PostgreSQL', () => {
  let database; let trx;
  const phone = '+19415550101';
  beforeAll(() => { database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  beforeEach(async () => {
    trx = await database.transaction();
    await trx.raw('CREATE TEMP TABLE leads ON COMMIT DROP AS SELECT * FROM public.leads WITH NO DATA');
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });
  const lead = (first_name, minutesAgo, extra = {}) => ({ id: randomUUID(), first_name, last_name: 'Example', phone,
    status: 'new', created_at: new Date(Date.now() - minutesAgo * 60000), ...extra });
  const lookup = (firstName, extra = {}) => findReusableCallLead(trx, { phone, firstName, lastName: 'Example', workableUnnamedLead: true, ...extra });

  test('a matching older spelling is eligible behind a conflicting newest lead', async () => {
    const older = lead('Jason', 10);
    await trx('leads').insert([older, lead('Aisha', 1)]);
    const result = await lookup('Jayson');
    expect(result.lead?.id).toBe(older.id);
    expect(extractedNameMatchesCustomer({ first_name: 'Jayson', last_name: 'Example' }, result.lead)).toBe(true);
  });
  test('an internal insertion leaves distinct shared-phone callers separate', async () => {
    const other = lead('Alisha', 1);
    await trx('leads').insert(other);
    expect(await lookup('Aisha')).toMatchObject({ lead: null, phoneNameConflictLeadId: other.id });
    expect(extractedNameMatchesCustomer({ first_name: 'Aisha', last_name: 'Example' }, other)).toBe(false);
  });
  test('a sound-alike spelling with the same surname reuses the lead', async () => {
    const voicemail = lead('Erik', 10);
    await trx('leads').insert([voicemail, lead('Aisha', 1)]);
    const result = await lookup('Eric');
    expect(result).toMatchObject({ matchedVia: 'phone' });
    expect(result.lead?.id).toBe(voicemail.id);
    expect(extractedNameMatchesCustomer({ first_name: 'Eric', last_name: 'Example' }, result.lead)).toBe(true);
  });
  test('a sound-alike spelling needs the surname on both sides', async () => {
    const otherSurname = lead('Erik', 5, { last_name: 'Different' });
    const noSurname = lead('Erik', 1, { last_name: null });
    await trx('leads').insert([otherSurname, noSurname]);
    expect(await lookup('Eric')).toMatchObject({ lead: null, phoneNameConflictLeadId: noSurname.id });
    expect(await findReusableCallLead(trx, { phone, firstName: 'Eric', lastName: null, workableUnnamedLead: true }))
      .toMatchObject({ lead: null, phoneNameConflictLeadId: noSurname.id });
    for (const row of [otherSurname, noSurname]) {
      expect(extractedNameMatchesCustomer({ first_name: 'Eric', last_name: 'Example' }, row)).toBe(false);
    }
    expect(extractedNameMatchesCustomer({ first_name: 'Eric', last_name: null }, lead('Erik', 1))).toBe(false);
  });
  test('a different sound on one phone and one surname stays a separate lead', async () => {
    const other = lead('Dario', 1);
    await trx('leads').insert(other);
    expect(await lookup('Daria')).toMatchObject({ lead: null, phoneNameConflictLeadId: other.id });
  });
  test('the SQL sound key is the twin of the JS sound key', async () => {
    const names = ['Erik', 'Eric', 'Sarah', 'Sara', 'Sahar', 'John', 'Jon', 'Phillip', 'Philip', 'Chris', 'Kris',
      'Rocco', 'Hannah', 'Cecil', 'Chad', 'Zach', 'Zack', 'Nick', 'Thomas', 'Rhonda', 'Ahhmed', 'Mc-Coy', "D'Arcy",
      'Aaron', 'Lynnn', 'Cc', 'H', 'Ch', 'Ckck', 'Michhael', 'Schuyler', 'Whitney', 'Jacques'];
    const NORM = "LOWER(REGEXP_REPLACE(n, '[^a-zA-Z0-9]', '', 'g'))";
    const { rows } = await trx.raw(
      `SELECT n, ${spokenFirstNameSoundKeySql(NORM)} AS key FROM unnest(?::text[]) AS t(n)`,
      [names],
    );
    expect(rows).toHaveLength(names.length);
    for (const row of rows) expect({ n: row.n, key: row.key }).toEqual({ n: row.n, key: spokenFirstNameSoundKey(row.n) });
  });
  test('spelling support cannot override surname or ownership conflicts', async () => {
    await trx('leads').insert([lead('Jason', 1, { last_name: 'Different' }), lead('Jason', 5, { customer_id: randomUUID() })]);
    expect((await lookup('Jayson', { unclaimedOnly: true })).lead).toBeNull();
  });
});
