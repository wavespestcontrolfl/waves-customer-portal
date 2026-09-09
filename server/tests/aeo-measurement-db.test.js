/** PostgreSQL regression checks. Run only with an isolated Waves QA database. */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));

const knex = require('knex');
const db = require('../models/db');
const tracker = require('../services/seo/impact-tracker');
const miner = require('../services/seo/gsc-opportunity-miner');
const evidenceMigration = require('../models/migrations/20260907000060_aeo_citation_evidence');
const seedMigration = require('../models/migrations/20260907000061_seed_aeo_benchmark');
const entityMigration = require('../models/migrations/20260907000110_aeo_entity_cohort');
const entityCohort = require('../data/aeo-entity-cohort-v1.json');
const benchmark = require('../data/aeo-benchmark-v1.json');
const { etDateString, addETDays } = require('../utils/datetime-et');

const connection = process.env.AEO_TEST_DATABASE_URL;
const run = connection ? describe : describe.skip;
const target = 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/';

run('AEO PostgreSQL evidence, cohort, and feedback', () => {
  let database;
  let schema;
  beforeAll(async () => {
    if (!new URL(connection).pathname.startsWith('/waves_qa_')) throw new Error('AEO checks require an isolated waves_qa_ database');
    schema = `aeo_test_${process.pid}_${Date.now()}`;
    database = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.schema.createSchema(schema);
    await database.schema.createTable('seo_llm_mention_queries', t => {
      t.increments('id'); t.text('query').unique(); t.text('city'); t.text('service'); t.boolean('active');
    });
    await database.schema.createTable('seo_llm_mentions', t => {
      t.increments('id'); t.integer('query_id'); t.text('query'); t.date('check_date');
      t.text('llm_platform'); t.text('model_version'); t.boolean('waves_mentioned');
      t.jsonb('waves_cited_urls'); t.jsonb('competitors_mentioned');
    });
    await database.schema.createTable('content_optimization_impact', t => {
      t.increments('id'); t.text('bucket'); t.text('page_url'); t.jsonb('aeo_query_ids');
      t.timestamp('deployed_at', { useTz: true }); t.timestamp('aeo_checked_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true }); t.text('aeo_verdict'); t.boolean('aeo_now_cited');
    });
    db.mockImplementation(table => database(table));
    await evidenceMigration.up(database);
  }, 60000);
  afterAll(async () => {
    if (!database) return;
    if (schema) await database.schema.dropSchemaIfExists(schema, true);
    await database.destroy();
  });
  beforeEach(async () => {
    await database('seo_llm_mentions').del();
    await database('content_optimization_impact').del();
    await database('seo_llm_mention_queries').del();
  });

  test('migration is repeatable and seeds 40 questions without changing an owner toggle', async () => {
    await evidenceMigration.up(database);
    await database('seo_llm_mention_queries').insert({ query: benchmark.questions[0].query, city: 'Owner metadata', service: 'pest', active: false });
    await seedMigration.up(database);
    await seedMigration.up(database);
    expect(Number((await database('seo_llm_mention_queries').count('* as n').first()).n)).toBe(40);
    expect(await database('seo_llm_mention_queries').where('query', benchmark.questions[0].query).first()).toMatchObject({ city: 'Owner metadata', active: false });
    await seedMigration.down(database);
    expect(Number((await database('seo_llm_mention_queries').count('* as n').first()).n)).toBe(40);
  });

  test('entity cohort migration adds the score column, seeds 12 questions, and rolls back without touching queries', async () => {
    await seedMigration.up(database);
    await database('seo_llm_mention_queries').insert({ query: entityCohort.questions[0].query, city: null, service: 'brand', active: false });
    await entityMigration.up(database);
    await entityMigration.up(database);
    expect(await database.schema.hasColumn('seo_llm_mentions', 'entity_facts')).toBe(true);
    expect(Number((await database('seo_llm_mention_queries').count('* as n').first()).n)).toBe(52);
    expect(await database('seo_llm_mention_queries').where('query', entityCohort.questions[0].query).first()).toMatchObject({ active: false });
    await database('seo_llm_mentions').insert({ query: entityCohort.questions[1].query, check_date: etDateString(), llm_platform: 'chatgpt', model_version: 'test', waves_mentioned: true, entity_facts: JSON.stringify({ right: 1, missing: 0, wrong: 0 }) });
    await entityMigration.down(database);
    expect(await database.schema.hasColumn('seo_llm_mentions', 'entity_facts')).toBe(false);
    expect(Number((await database('seo_llm_mention_queries').count('* as n').first()).n)).toBe(52);
    expect(Number((await database('seo_llm_mentions').count('* as n').first()).n)).toBe(1);
    await entityMigration.up(database);
    expect(await database.schema.hasColumn('seo_llm_mentions', 'entity_facts')).toBe(true);
  });

  test('a citation on one engine does not hide another engine gap; disabled and legacy queries cannot create gaps', async () => {
    const [q] = await database('seo_llm_mention_queries').insert({ query: 'pest control Bradenton', city: 'Bradenton', service: 'pest control', active: true }).returning('id');
    const observations = [];
    for (let day = 1; day <= 3; day++) {
      const row = { query_id: q.id, query: 'pest control Bradenton', check_date: etDateString(addETDays(new Date(), -day)), model_version: 'test',
        waves_mentioned: true, measurement_version: 2, answer_available: true, citations_complete: true,
        competitors_mentioned: JSON.stringify([{ name: 'example operator' }]) };
      observations.push({ ...row, llm_platform: 'chatgpt', waves_cited_urls: JSON.stringify([target]) });
      observations.push({ ...row, llm_platform: 'gemini', waves_cited_urls: '[]' });
      observations.push({ ...row, llm_platform: 'perplexity', waves_cited_urls: '[]' });
      observations.push({ ...row, llm_platform: 'legacy', measurement_version: null, waves_cited_urls: '[]' });
      observations.push({ ...row, llm_platform: 'unanswered', answer_available: false, waves_cited_urls: '[]' });
    }
    await database('seo_llm_mentions').insert(observations);
    const demand = jest.spyOn(miner, '_gscDemandByServiceCity').mockResolvedValue(new Map([['pest::Bradenton', 2000]]));
    try {
      const since = etDateString(addETDays(new Date(), -10));
      const gaps = await miner.mineAeoGaps(since, new Map([['pest::Bradenton', target]]));
      expect(gaps).toHaveLength(1);
      expect(gaps[0].signal_metadata.engines.map(e => e.platform).sort()).toEqual(['gemini', 'perplexity']);
      expect(gaps[0].signal_metadata.competitors_mentioned).toEqual(['example operator']);
      await database('seo_llm_mention_queries').where('id', q.id).update({ active: false });
      expect(await miner.mineAeoGaps(since)).toEqual([]);
    } finally { demand.mockRestore(); }
  });

  test('impact needs the published page linked on attributable answer days, not a mention or another owned page', async () => {
    const now = new Date();
    const [impact] = await database('content_optimization_impact').insert({ bucket: 'aeo_gap', page_url: target,
      aeo_query_ids: '[91]', deployed_at: addETDays(now, -40), aeo_verdict: 'now_cited' }).returning('id');
    const observations = [];
    for (let day = 1; day <= 10; day++) observations.push({ query_id: 91, check_date: etDateString(addETDays(now, -day)),
      measurement_version: 2, answer_available: true, citations_complete: true, waves_mentioned: true,
      waves_cited_urls: JSON.stringify(['https://www.wavespestcontrol.com/']) });
    observations.push({ query_id: 91, check_date: etDateString(addETDays(now, -11)), measurement_version: null, waves_cited_urls: JSON.stringify([target]) });
    await database('seo_llm_mentions').insert(observations);
    expect(await tracker.checkAeoVisibility({ db: database, now })).toEqual({ checked: 1 });
    expect(await database('content_optimization_impact').where('id', impact.id).first()).toMatchObject({ aeo_verdict: 'still_absent', aeo_now_cited: false, aeo_measurement_version: 2 });
    await database('content_optimization_impact').where('id', impact.id).update({ aeo_verdict: 'insufficient_data' });
    await database('seo_llm_mentions').where('query_id', 91).where('measurement_version', 2).update({ waves_cited_urls: JSON.stringify([target]) });
    await tracker.checkAeoVisibility({ db: database, now });
    expect(await database('content_optimization_impact').where('id', impact.id).first()).toMatchObject({ aeo_verdict: 'now_cited', aeo_now_cited: true });
  });

  test('rolling evidence columns down and back up preserves query and observation rows', async () => {
    await database('seo_llm_mentions').insert({ query: 'historical question', waves_cited_urls: JSON.stringify([target]) });
    await evidenceMigration.down(database);
    await evidenceMigration.down(database);
    expect(await database.schema.hasColumn('seo_llm_mentions', 'measurement_version')).toBe(false);
    expect(await database.schema.hasColumn('content_optimization_impact', 'aeo_measurement_version')).toBe(false);
    await evidenceMigration.up(database);
    expect(await database('seo_llm_mentions').first()).toMatchObject({ query: 'historical question', measurement_version: null });
  });
});
