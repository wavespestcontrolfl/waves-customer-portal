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

  test('access notes gain a new first line; the earlier notes stay below it', async () => {
    await run({ access_notes: 'Gate code 5550 at the gate.' });
    const notes = (await prefs()).access_notes.split('\n');
    // First, because the job card shows only the start of the note.
    expect(notes[0]).toBe('[bar] Gate code 5550 at the gate.');
    expect(notes[1]).toBe('Example Glen gate: punch in 5550. Cell 202-555-0101 if problems (email 10/1).');
  });

  test('a note already on file is not added twice', async () => {
    const out = await run({ access_notes: 'example glen gate: punch in 5550. cell 202-555-0101 if problems (email 10/1)' });
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

  test('a shorter code is not hidden inside a longer one already on file', async () => {
    await run({ access_notes: 'punch in 555' });
    expect((await prefs()).access_notes.split('\n')).toHaveLength(2);
  });

  test('the plan is the same before and after midnight, so a card confirmed late still matches', async () => {
    const preview = () => executeTool('update_property_access', { customer_id: customerId, access_notes: 'Side door sticks' });
    jest.useFakeTimers({ now: new Date('2026-10-06T03:59:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    let before;
    let after;
    try {
      before = await preview();
      jest.setSystemTime(new Date('2026-10-06T04:01:00Z'));
      after = await preview();
    } finally { jest.useRealTimers(); }
    expect(after.would_update).toEqual(before.would_update);
  });

  test('a side gate note that would pass its 200 characters is not saved, and the result says so', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ side_gate_access: 'x'.repeat(150) });
    const out = await run({ side_gate_access: 'Latch on the left side of the gate, lift and push hard' });
    expect(out.updated_fields).toEqual([]);
    expect(out.kept.join(' ')).toMatch(/200 characters/);
    expect((await prefs()).side_gate_access).toBe('x'.repeat(150));
  });

  test('a community code set in the same call stays off the property gate; a directory code is saved', async () => {
    const out = await run({ neighborhood_gate_code: '8080', property_gate_code: '8080' });
    expect(out.updated_fields).toEqual(['neighborhood_gate_code']);
    expect(out.kept.join(' ')).toMatch(/community gate code/);
    expect((await prefs()).property_gate_code).toBeNull();
    // A directory code reaches a stop only for some visits, so it is never
    // taken as already shown: the property gate code is saved.
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: null });
    const hoodId = randomUUID();
    await mockDb('neighborhoods').insert({ id: hoodId, name: 'Example Glen', match_key: `example-glen-${hoodId}`, source: 'office' });
    await mockDb('neighborhood_access').insert({ neighborhood_id: hoodId, access_type: 'keypad', code: '#4321', status: 'active', source: 'office' });
    await mockDb('customer_properties').insert({
      id: randomUUID(), customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: '4455 Example Lane', city: 'Lakewood Ranch', zip: '34202', active: true, neighborhood_id: hoodId,
    });
    await run({ property_gate_code: '#4321' });
    expect((await prefs()).property_gate_code).toBe('#4321');
  });

  test('pet details are replaced, not added to', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ pet_details: '2 dogs' });
    await run({ pet_details: 'No pets' });
    expect((await prefs()).pet_details).toBe('No pets');
  });

  test('a note that is part of a longer line, even its opposite, is new', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ parking_notes: 'Do not park on street' });
    await run({ parking_notes: 'Park on street' });
    expect((await prefs()).parking_notes).toBe('[bar] Park on street\nDo not park on street');
  });

  test('a property code on file that is the community code is cleared, and the result says so', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ property_gate_code: '5550' });
    const preview = await executeTool('update_property_access', { customer_id: customerId, parking_notes: 'Driveway' });
    expect(preview.would_update).toMatchObject({ property_gate_code: null });
    const out = await run({ parking_notes: 'Driveway' });
    expect(out.kept.join(' ')).toMatch(/cleared/);
    expect((await prefs()).property_gate_code).toBeNull();
  });

  test('a plan that changed after the card was shown is refused', async () => {
    const preview = await executeTool('update_property_access', { customer_id: customerId, access_notes: 'Ring twice' });
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ access_notes: 'Ring twice' });
    const out = await run({ access_notes: 'Ring twice', _ib_property_plan_hash: preview.plan_hash });
    expect(out).toMatchObject({ preview_changed: true });
    expect((await prefs()).access_notes).toBe('Ring twice');
  });

  test('an empty value clears a note field', async () => {
    await run({ access_notes: '' });
    expect((await prefs()).access_notes).toBe('');
  });

  test('the preview shows the new line only, never the stored note', async () => {
    const preview = await executeTool('update_property_access', { customer_id: customerId, access_notes: 'Ring twice' });
    expect(preview.would_update).toEqual({ access_notes: '(new first line) Ring twice' });
    expect(JSON.stringify(preview)).not.toMatch(/202-555-0101|punch in/);
    expect(preview.plan_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an older line that becomes current again goes back on top', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ access_notes: '[bar] Use front door\n[bar] Use rear gate' });
    await run({ access_notes: 'Use rear gate' });
    expect((await prefs()).access_notes.split('\n')[0]).toBe('[bar] Use rear gate');
  });

  test('a replaced field another writer changed after the card is refused', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ pet_details: '2 dogs' });
    const preview = await executeTool('update_property_access', { customer_id: customerId, pet_details: 'No pets' });
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ pet_details: 'Aggressive dog in yard' });
    const out = await run({ pet_details: 'No pets', _ib_property_plan_hash: preview.plan_hash });
    expect(out).toMatchObject({ preview_changed: true });
    expect((await prefs()).pet_details).toBe('Aggressive dog in yard');
  });

  test('a bracketed qualifier on the stored note is part of its words', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ parking_notes: '[DO NOT] Park on street' });
    await run({ parking_notes: 'Park on street' });
    expect((await prefs()).parking_notes.split('\n')[0]).toBe('[bar] Park on street');
  });

  test('changing the community code clears the old one from the property gate field', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ property_gate_code: '5550' });
    await run({ neighborhood_gate_code: '6661' });
    const after = await prefs();
    expect([after.neighborhood_gate_code, after.property_gate_code]).toEqual(['6661', null]);
  });

  test('clearing only the community code keeps the same code in the property gate field', async () => {
    await mockDb('property_preferences').where({ customer_id: customerId }).update({ property_gate_code: '5550' });
    await run({ neighborhood_gate_code: '' });
    const after = await prefs();
    expect([after.neighborhood_gate_code, after.property_gate_code]).toEqual(['', '5550']);
  });

  test('an empty field is simply filled', async () => {
    await run({ parking_notes: 'Park on the street' });
    expect((await prefs()).parking_notes).toBe('Park on the street');
  });
});
