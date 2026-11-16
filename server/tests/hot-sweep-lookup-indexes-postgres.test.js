// 20261104233000_hot_sweep_lookup_indexes.js on PostgreSQL: up() builds both indexes and
// down() drops them, each safe to run twice; and the sweeps' own SQL can reach each index.
// A few synthetic rows never outweigh a full scan on real costs, so every EXPLAIN runs
// with enable_seqscan off inside its own transaction, and the test asks for an index
// LOOKUP: a scan of the index with an Index Cond. (With seq scans off the planner will
// also read a whole table through any index, so the index name alone proves nothing.)
// A lookup needs the index expression to match the query's, which is the drift this
// guards: an edited emailOwnerSql or join expression would silently orphan its index.
// CI's DATABASE_URL pass runs this; the tables are copied from public into a unique
// schema that is removed after the suite. Synthetic data only.
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

const migration = require('../models/migrations/20261104233000_hot_sweep_lookup_indexes');
const { gates } = require('../config/feature-gates');
const { retireCalledBackMissedCalls } = require('../services/missed-call-bell');
const { EMAIL_HASH_SQL } = require('../services/access-code-capture');

const INDEXES = ['call_log_id_text_idx', 'customers_live_email_key_idx'];

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('hot sweep lookup indexes on PostgreSQL', () => {
  let database;
  const schema = `hot_sweep_idx_${randomUUID().replaceAll('-', '')}`;
  const tables = ['customers', 'emails', 'bid_opportunity_emails', 'call_log', 'notifications'];
  const gateNames = ['callbackNeedsAnswer', 'missedCallVisitUnderway'];
  const savedGates = Object.fromEntries(gateNames.map((key) => [key, gates[key]]));

  const indexesPresent = async () => (await database.raw(
    'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY(?) ORDER BY 1',
    [INDEXES],
  )).rows.map((row) => row.indexname);
  const planOf = (sql, bindings = []) => database.transaction(async (trx) => {
    await trx.raw('SET LOCAL enable_seqscan = off');
    const plan = await trx.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings);
    return plan.rows[0]['QUERY PLAN'][0].Plan;
  });
  // Every plan node, subplans included, that looks rows up in `indexName` by a condition.
  const lookupsIn = (node, indexName) => [
    ...(node['Index Name'] === indexName && node['Index Cond'] ? [node['Index Cond']] : []),
    ...(node.Plans || []).flatMap((child) => lookupsIn(child, indexName)),
  ];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  afterAll(async () => {
    Object.assign(gates, savedGates);
    if (database) {
      await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await database.destroy();
    }
  });

  test('up() builds both indexes and down() drops them, each safe to run twice', async () => {
    await migration.up(database);
    await migration.up(database);
    expect(await indexesPresent()).toEqual(INDEXES);
    await migration.down(database);
    await migration.down(database);
    expect(await indexesPresent()).toEqual([]);
    await migration.up(database);
    expect(await indexesPresent()).toEqual(INDEXES);
  });

  test("EMAIL_HASH_SQL's owner lookups reach customers_live_email_key_idx", async () => {
    await migration.up(database);
    const live = randomUUID();
    await database('customers').insert([
      { id: live, email: 'Pat.Synthetic@example.com' },
      { id: randomUUID(), email: 'gone.synthetic@example.com', deleted_at: new Date('2026-10-01T12:00:00Z') },
      { id: randomUUID(), email: null },
    ]);
    await database('emails').insert([
      { id: randomUUID(), from_address: ' pat.synthetic@example.com ', subject: 'Gate code', body_text: 'Synthetic body', received_at: new Date('2026-11-03T14:00:00Z') },
      { id: randomUUID(), from_address: 'nobody@example.com', subject: 'Hello', body_text: 'Synthetic body', received_at: new Date('2026-11-03T15:00:00Z') },
    ]);
    await database.raw('ANALYZE customers');
    await database.raw('ANALYZE emails');
    const plan = await planOf(`SELECT ${EMAIL_HASH_SQL} AS source_hash FROM emails e`);
    const lookups = lookupsIn(plan, 'customers_live_email_key_idx');
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((cond) => cond.includes('lower(btrim('))).toBe(true);
  });

  test('the missed-call retire query joins call_log through call_log_id_text_idx', async () => {
    await migration.up(database);
    Object.assign(gates, { callbackNeedsAnswer: true, missedCallVisitUnderway: false });
    const callId = randomUUID();
    await database('call_log').insert([
      { id: callId, direction: 'inbound', from_phone: '+19415550100', created_at: new Date('2026-11-03T14:00:00Z') },
      { id: randomUUID(), direction: 'inbound', from_phone: '+19415550199', created_at: new Date('2026-11-03T15:00:00Z') },
    ]);
    await database('notifications').insert({
      id: randomUUID(), recipient_type: 'admin', category: 'missed_call', created_at: new Date(),
      metadata: JSON.stringify({ triggerKey: 'customer_missed_call', payload: { callLogId: callId } }),
    });
    await database.raw('ANALYZE call_log');
    await database.raw('ANALYZE notifications');

    // Capture the retire pass's own SQL (the bell is open and nobody called back, so it retires nothing).
    const seen = [];
    const capture = (query) => seen.push(query);
    database.on('query', capture);
    try {
      await expect(retireCalledBackMissedCalls()).resolves.toBe(0);
    } finally {
      database.removeListener('query', capture);
    }
    const retire = seen.find((query) => query.sql.includes("call_log.id::text = notifications.metadata->'payload'->>'callLogId'"));
    expect(retire).toBeDefined();
    const plan = await planOf(retire.sql.replace(/\$\d+/g, '?'), retire.bindings);
    const lookups = lookupsIn(plan, 'call_log_id_text_idx');
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((cond) => cond.includes('(id)::text'))).toBe(true);
  });
});
