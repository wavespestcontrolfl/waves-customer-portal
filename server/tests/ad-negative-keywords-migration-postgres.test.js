const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. The table lives in a unique
// schema (with a minimal ad_campaigns for the foreign key) dropped after the suite.
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261102110000_ad_negative_keywords');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('ad_negative_keywords migration on PostgreSQL', () => {
  let database;
  const schema = `ad_neg_kw_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.ad_campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid())', [schema]);
    await migration.up(database);
  });
  afterEach(async () => {
    await database('ad_negative_keywords').del();
    await database('ad_campaigns').del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const campaign = () => database('ad_campaigns').insert({}).returning('id').then(([r]) => r.id);
  const negative = (campaignId, extra = {}) => database('ad_negative_keywords').insert({
    campaign_id: campaignId, text: 'squirrel', source: 'advisor', state: 'pending', ...extra,
  }).returning('*').then(([r]) => r);

  test('a row gets its defaults', async () => {
    const row = await negative(await campaign(), { metrics: JSON.stringify({ clicks: 6, cost: 9.5, conversions: 0 }) });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.match_type).toBe('phrase');
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(row.google_resource_name).toBeNull();
    expect(row.decided_at).toBeNull();
    expect(row.metrics).toEqual({ clicks: 6, cost: 9.5, conversions: 0 });
  });

  test('campaign + text + match type is unique; another match type or campaign is not a repeat', async () => {
    const a = await campaign();
    const b = await campaign();
    await negative(a);
    await expect(negative(a)).rejects.toMatchObject({ code: '23505' });
    await expect(negative(a, { match_type: 'exact' })).resolves.toBeTruthy();
    await expect(negative(b)).resolves.toBeTruthy();
  });

  test('source and state only take their listed values', async () => {
    const id = await campaign();
    for (const source of ['owner_list', 'advisor', 'manual']) {
      await expect(negative(id, { text: `s ${source}`, source })).resolves.toBeTruthy();
    }
    for (const state of ['pending', 'active', 'declined', 'removed', 'failed']) {
      await expect(negative(id, { text: `t ${state}`, state })).resolves.toBeTruthy();
    }
    await expect(negative(id, { text: 'bad source', source: 'robot' })).rejects.toMatchObject({ code: '23514' });
    await expect(negative(id, { text: 'bad state', state: 'maybe' })).rejects.toMatchObject({ code: '23514' });
  });

  test('text is limited to 80 characters and a campaign is required', async () => {
    const id = await campaign();
    await expect(negative(id, { text: 'a'.repeat(81) })).rejects.toMatchObject({ code: '22001' });
    await expect(negative(randomUUID())).rejects.toMatchObject({ code: '23503' });
    await expect(negative(null)).rejects.toMatchObject({ code: '23502' });
  });

  test('deleting a campaign deletes its negatives', async () => {
    const id = await campaign();
    await negative(id);
    await database('ad_campaigns').where({ id }).del();
    expect(await database('ad_negative_keywords').where({ campaign_id: id })).toHaveLength(0);
  });

  test('up is safe to run twice and down drops the table', async () => {
    await migration.up(database);
    await migration.down(database);
    expect(await database.schema.hasTable('ad_negative_keywords')).toBe(false);
    await migration.up(database);
    expect(await database.schema.hasTable('ad_negative_keywords')).toBe(true);
  });
});
