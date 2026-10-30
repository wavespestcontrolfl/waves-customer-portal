// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// Before-and-after AI citation check: the migration (up twice, down) and
// checkAiChange / previewAiChange against real seo_llm_mentions rows.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ getPr: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ aiChangeCheckLive: jest.fn(() => true) }));

const tracker = require('../services/seo/impact-tracker');
const migration = require('../models/migrations/20261030120000_ai_change_check');

const COLUMNS = ['ai_change_pre', 'ai_change_post', 'ai_change_verdict', 'ai_change_checked_at', 'ai_change_alerted_at'];
const page = 'https://www.wavespestcontrol.com/pest-control/seasonal-pest-calendar-sarasota-fl/';
const other = 'https://www.wavespestcontrol.com/other/';
const NOW = new Date('2026-11-20T13:00:00Z');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('AI change check on PostgreSQL', () => {
  let database;
  const schema = `ai_change_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.schema.createTable('seo_llm_mentions', (t) => {
      t.increments('id'); t.date('check_date'); t.integer('measurement_version');
      t.boolean('answer_available'); t.boolean('citations_complete'); t.jsonb('waves_cited_urls');
    });
    await database.schema.createTable('content_optimization_impact', (t) => {
      t.increments('id'); t.string('bucket', 40); t.text('page_url');
      t.timestamp('deployed_at', { useTz: true }); t.timestamp('updated_at', { useTz: true });
    });
    await migration.up(database);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });
  afterEach(async () => {
    await database('seo_llm_mentions').del();
    await database('content_optimization_impact').del();
  });

  const answers = (date, n, urls) => Array.from({ length: n }, () => ({
    check_date: date, measurement_version: 2, answer_available: true, citations_complete: true,
    waves_cited_urls: JSON.stringify(urls),
  }));

  test('migration adds the five columns, is safe to run twice, and down removes exactly them', async () => {
    for (const c of COLUMNS) expect(await database.schema.hasColumn('content_optimization_impact', c)).toBe(true);
    await migration.up(database);
    await migration.down(database);
    for (const c of COLUMNS) expect(await database.schema.hasColumn('content_optimization_impact', c)).toBe(false);
    expect(await database.schema.hasColumn('content_optimization_impact', 'page_url')).toBe(true);
    await migration.down(database);
    await migration.up(database);
    for (const c of COLUMNS) expect(await database.schema.hasColumn('content_optimization_impact', c)).toBe(true);
  });

  test('the motivating case grades lost, and the next tick does not rescan it', async () => {
    const [{ id }] = await database('content_optimization_impact').insert({
      bucket: 'decay_refresh', page_url: page, deployed_at: new Date('2026-10-27T18:00:00Z'),
    }).returning('id');
    await database('seo_llm_mentions').insert([
      ...answers('2026-10-20', 11, [page]), ...answers('2026-10-21', 19, [other]), ...answers('2026-10-22', 30, []),
      ...answers('2026-11-02', 2, [page]), ...answers('2026-11-03', 28, [other]), ...answers('2026-11-04', 30, []),
      ...answers('2026-10-28', 40, [page]), // deploy + 1 day: outside both windows
    ]);
    expect(await tracker.checkAiChange({ db: database, now: NOW })).toMatchObject({ checked: 1, lost: 1 });
    const row = await database('content_optimization_impact').where({ id }).first();
    expect(row.ai_change_verdict).toBe('lost');
    expect(row.ai_change_pre).toMatchObject({ answers: 60, cites: 11, siteCites: 30 });
    expect(row.ai_change_post).toMatchObject({ answers: 60, cites: 2, siteCites: 30 });
    expect(row.ai_change_checked_at).toBeInstanceOf(Date);
    expect(row.ai_change_alerted_at).toBeNull();
    expect(await tracker.checkAiChange({ db: database, now: NOW })).toMatchObject({ checked: 0, scanned: 0 });
  });

  test('a change younger than 17 days, or with no deploy date or page, is left alone', async () => {
    await database('content_optimization_impact').insert([
      { bucket: 'a', page_url: page, deployed_at: new Date('2026-11-10T18:00:00Z') },
      { bucket: 'b', page_url: page, deployed_at: null },
      { bucket: 'c', page_url: null, deployed_at: new Date('2026-10-01T18:00:00Z') },
    ]);
    expect(await tracker.checkAiChange({ db: database, now: NOW })).toMatchObject({ checked: 0, scanned: 0 });
  });

  test('a row with no stored answers becomes no_data', async () => {
    await database('content_optimization_impact').insert({ bucket: 'new_page', page_url: page, deployed_at: new Date('2026-09-01T18:00:00Z') });
    expect(await tracker.checkAiChange({ db: database, now: NOW })).toMatchObject({ checked: 1, no_data: 1 });
  });

  test('the batch is bounded and oldest rows go first', async () => {
    await database('content_optimization_impact').insert([
      { bucket: 'a', page_url: page, deployed_at: new Date('2026-09-03T18:00:00Z') },
      { bucket: 'b', page_url: page, deployed_at: new Date('2026-09-01T18:00:00Z') },
      { bucket: 'c', page_url: page, deployed_at: new Date('2026-09-02T18:00:00Z') },
    ]);
    expect(await tracker.checkAiChange({ db: database, now: NOW, limit: 2 })).toMatchObject({ checked: 2 });
    const left = await database('content_optimization_impact').whereNull('ai_change_checked_at');
    expect(left.map((r) => r.bucket)).toEqual(['a']);
  });

  test('previewAiChange grades the same rows and writes nothing', async () => {
    await database('content_optimization_impact').insert({ bucket: 'decay_refresh', page_url: page, deployed_at: new Date('2026-10-27T18:00:00Z') });
    await database('seo_llm_mentions').insert([
      ...answers('2026-10-20', 11, [page]), ...answers('2026-11-02', 2, [page]),
      ...answers('2026-10-21', 20, [other]), ...answers('2026-11-03', 20, [other]),
    ]);
    const out = await tracker.previewAiChange({ db: database, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verdict: 'lost', deploy: '2026-10-27' });
    const row = await database('content_optimization_impact').first();
    expect(row.ai_change_verdict).toBeNull();
    expect(row.ai_change_checked_at).toBeNull();
  });
});
