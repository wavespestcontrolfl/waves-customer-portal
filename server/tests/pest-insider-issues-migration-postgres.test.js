// CI's DB-gated pass runs this against PostgreSQL. The table lives in a unique schema (with a
// minimal newsletter_sends for the foreign key) dropped after the suite.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261120010000_pest_insider_issues');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('pest_insider_issues migration on PostgreSQL', () => {
  let database;
  const schema = `pi_issues_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.newsletter_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid())', [schema]);
    await migration.up(database);
  });
  afterEach(async () => {
    await database('pest_insider_issues').del();
    await database('newsletter_sends').del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const issue = (extra = {}) => database('pest_insider_issues').insert({ issue_date: '2026-12-03', status: 'shadow', ...extra }).returning('*').then(([r]) => r);

  test('a row gets its defaults', async () => {
    const row = await issue();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.diagnostics).toEqual({});
    expect(row.built_at).toBeNull();
    expect(row.send_id).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  test.each(['2026-12-03', '2026-12-17', '2026-10-01', '2026-02-19', '2027-01-21'])('%s is accepted', async (d) => {
    await expect(issue({ issue_date: d })).resolves.toBeTruthy();
  });

  test.each([
    ['a Wednesday', '2026-12-02'],
    ['the 2nd Thursday', '2026-12-10'],
    ['the 4th Thursday', '2026-12-24'],
    ['the 5th Thursday', '2026-12-31'],
  ])('%s is refused', async (_label, d) => {
    await expect(issue({ issue_date: d })).rejects.toThrow(/pest_insider_issues_issue_date_check/);
  });

  test('one row per issue date', async () => {
    await issue();
    await expect(issue()).rejects.toThrow(/unique/i);
  });

  test('every listed status is accepted and any other is refused', async () => {
    for (const status of migration._STATUSES) {
      await database('pest_insider_issues').del();
      await expect(issue({ status })).resolves.toBeTruthy();
    }
    await expect(issue({ status: 'sending' })).rejects.toThrow(/pest_insider_issues_status_check/);
  });

  test('deleting the send sets send_id to null', async () => {
    const [{ id: sendId }] = await database('newsletter_sends').insert({}).returning('id');
    await issue({ send_id: sendId });
    await database('newsletter_sends').where({ id: sendId }).del();
    const row = await database('pest_insider_issues').first();
    expect(row.send_id).toBeNull();
  });

  test('down drops the table', async () => {
    await migration.down(database);
    expect(await database.schema.hasTable('pest_insider_issues')).toBe(false);
    await migration.up(database);
  });
});
