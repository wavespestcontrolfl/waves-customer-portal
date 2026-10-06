// update_property_access against a migrated QA database (opt-in, rolled back).
// 2026-10-05: a bar write replaced a customer's access notes and saved a
// community gate code as the property gate. Synthetic data only.
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { executeTool } = require('../services/intelligence-bar/tools');

const connection = process.env.IB_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockDb;
let database;
jest.setTimeout(60000);

postgres('update_property_access keeps history and keeps community codes off the property gate', () => {
  let customerId;
  beforeAll(() => {
    if (!/^\/(waves_qa_[a-f0-9]+|waves_test)$/.test(new URL(connection).pathname)) {
      throw new Error('Use a dedicated, migrated Waves QA database');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  });
  beforeEach(async () => {
    mockDb = await database.transaction();
    customerId = randomUUID();
    await mockDb('customers').insert({ id: customerId, first_name: 'Avery', last_name: 'Fixture', phone: `+1555${Date.now().toString().slice(-7)}` });
    await mockDb('property_preferences').insert({
      customer_id: customerId, neighborhood_gate_code: '5550',
      access_notes: 'Example Glen gate: punch in 5550. Cell 202-555-0101 if problems (email 10/1).',
    });
  });
  afterEach(async () => { await mockDb.rollback(); });
  afterAll(async () => { await database.destroy(); });

  const prefs = () => mockDb('property_preferences').where({ customer_id: customerId }).first();
  const run = (input) => executeTool('update_property_access', { customer_id: customerId, ...input, confirmed: true });

  test('access notes gain a dated line; the earlier notes stay', async () => {
    await run({ access_notes: 'Gate code 5550 at the gate.' });
    const notes = (await prefs()).access_notes.split('\n');
    expect(notes[0]).toBe('Example Glen gate: punch in 5550. Cell 202-555-0101 if problems (email 10/1).');
    expect(notes[1]).toMatch(/^\[bar \d{4}-\d{2}-\d{2}\] Gate code 5550 at the gate\.$/);
  });

  test('a note already on file is not added twice', async () => {
    const out = await run({ access_notes: 'punch in 5550' });
    expect(out.updated_fields).toEqual([]);
    expect((await prefs()).access_notes.split('\n')).toHaveLength(1);
  });

  test('the community gate code is never saved as the property gate code', async () => {
    const preview = await executeTool('update_property_access', { customer_id: customerId, property_gate_code: '5550' });
    expect(preview.would_update).toEqual({});
    expect(preview.kept.join(' ')).toMatch(/community gate code/);
    await run({ property_gate_code: '5550' });
    expect((await prefs()).property_gate_code).toBeNull();
    await run({ property_gate_code: '7777' });
    expect((await prefs()).property_gate_code).toBe('7777');
  });

  test('an empty field is simply filled', async () => {
    await run({ parking_notes: 'Park on the street' });
    expect((await prefs()).parking_notes).toBe('Park on the street');
  });
});
