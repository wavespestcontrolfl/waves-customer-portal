jest.mock('../models/db', () => jest.fn());
const { readLinkedLeadHistory } = require('../services/lead-linked-history');
const knex = require('knex');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const row = (n, status = 'new', parent) => ({ id: id(n), status, first_name: 'Synthetic', last_name: 'Example', service_interest: 'Pest', extracted_data: parent ? { duplicate_of_lead_id: parent } : {}, deleted_at: null });
let rows, statements;
const database = knex({ client: 'pg' });
database.client.runner = builder => ({ run: async () => {
  statements.push(builder.toSQL());
  const sql = builder.toSQL();
  let result = sql.sql.includes('extracted_data->>')
    ? rows.filter(r => r.extracted_data?.duplicate_of_lead_id === sql.bindings[0] && r.id !== sql.bindings[1] && !r.deleted_at)
    : rows.filter(r => r.id === sql.bindings[0] && (!sql.sql.includes('"deleted_at" is null') || !r.deleted_at));
  if (builder._method === 'first') return result[0];
  return result.slice(0, 51);
} });
beforeEach(() => { rows = [row(1), row(2, 'duplicate', id(1))]; statements = []; });
afterAll(() => database.destroy());
test('resolves the canonical record and keeps original histories separate', async () => {
  rows.push(row(3, 'duplicate', id(2)));
  const result = await readLinkedLeadHistory(database, rows[2]);
  expect(result).toMatchObject({ original: { id: id(2) }, canonical: { id: id(1) }, unresolved: false, linked: [] });
  expect(statements.every(s => s.method === 'select' || s.method === 'first')).toBe(true);
});
test('shows explicit reverse links, not shared-phone/name candidates', async () => {
  rows.push(row(3));
  expect((await readLinkedLeadHistory(database, rows[0])).linked.map(r => r.id)).toEqual([id(2)]);
});
test('a won repeat retains its original link without being presented as a duplicate', async () => {
  rows[1].status = 'won';
  expect(await readLinkedLeadHistory(database, rows[1])).toMatchObject({ original: { id: id(1) }, canonical: null, unresolved: false });
});
test.each(['missing', 'deleted', 'cycle', 'invalid', 'no marker'])('%s links remain unresolved', async kind => {
  if (kind === 'missing') rows.shift();
  if (kind === 'deleted') rows[0].deleted_at = new Date();
  if (kind === 'cycle') { rows[0].status = 'duplicate'; rows[0].extracted_data = { duplicate_of_lead_id: id(2) }; }
  if (kind === 'invalid') rows[1].extracted_data = { duplicate_of_lead_id: 'bad uuid' };
  if (kind === 'no marker') rows[1].extracted_data = {};
  expect(await readLinkedLeadHistory(database, rows.find(r => r.id === id(2)))).toMatchObject({ canonical: null, unresolved: true });
});
test('caps reverse history and signals more records', async () => {
  rows.push(...Array.from({ length: 51 }, (_, i) => row(i + 3, 'won', id(1))));
  expect(await readLinkedLeadHistory(database, rows[0])).toMatchObject({ linked: expect.any(Array), hasMore: true });
  expect((await readLinkedLeadHistory(database, rows[0])).linked).toHaveLength(50);
});
test('does not claim a canonical record beyond the shared resolver hop limit', async () => {
  rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 'duplicate', id(i + 2)));
  rows.push(row(11));
  expect(await readLinkedLeadHistory(database, rows[0])).toMatchObject({ canonical: null, unresolved: true });
});

// Optional real query verification, restricted to a task-owned local synthetic DB.
const name = process.env.LEAD_HISTORY_TEST_DATABASE;
const pgDescribe = name ? describe : describe.skip;
pgDescribe('local PostgreSQL linked history', () => {
  let pg;
  beforeAll(async () => {
    if (!/^waves_qa_leadhistory_[a-f0-9]{8}$/.test(name)) throw new Error('Expected isolated local QA database');
    pg = knex({ client: 'pg', connection: { host: '/tmp', database: name } });
    await pg.schema.createTable('leads', t => {
      t.uuid('id').primary(); t.text('status'); t.text('first_name'); t.text('last_name');
      t.text('service_interest'); t.jsonb('extracted_data'); t.timestamp('deleted_at'); t.timestamp('created_at').defaultTo(pg.fn.now());
    });
  });
  afterAll(async () => { if (pg) { await pg.schema.dropTableIfExists('leads'); await pg.destroy(); } });
  test('executes JSON link queries, handles malformed ancestry and excludes deleted rows', async () => {
    const records = [row(1), row(2, 'duplicate', id(1)), row(3, 'won', id(1)), { ...row(4, 'duplicate', id(1)), deleted_at: new Date() }];
    await pg('leads').insert(records);
    expect((await readLinkedLeadHistory(pg, records[0])).linked.map(r => r.id).sort()).toEqual([id(2), id(3)]);
    expect((await readLinkedLeadHistory(pg, records[1])).canonical.id).toBe(id(1));
    await pg('leads').where({ id: id(1) }).update({ status: 'duplicate', extracted_data: { duplicate_of_lead_id: 'invalid' } });
    expect(await readLinkedLeadHistory(pg, records[1])).toMatchObject({ canonical: null, unresolved: true });
  });
});
