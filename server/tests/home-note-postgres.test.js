const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. The tables live in a unique schema (minimal customers,
// customer_properties, technicians and audit_log for the foreign keys and the audit row) dropped after the suite.
const knex = require('knex');
const { randomUUID } = require('crypto');

const mockHolder = {};
jest.mock('../models/db', () => new Proxy(function db() {}, {
  apply: (_t, _this, args) => mockHolder.db(...args),
  get: (_t, prop) => mockHolder.db[prop],
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const migration = require('../models/migrations/20261127134200_home_notes');
const { readHomeNote, saveHomeNote } = require('../services/home-note');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('home notes on PostgreSQL', () => {
  let database;
  const schema = `home_note_${randomUUID().replaceAll('-', '')}`;
  let customerId;
  let techId;
  const actor = (extra = {}) => ({ type: 'technician', id: techId, ip: '127.0.0.1', userAgent: 'jest', ...extra });

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    mockHolder.db = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    await database.raw('CREATE TABLE customer_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE, active boolean NOT NULL DEFAULT true)');
    await database.raw('CREATE TABLE technicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)');
    await database.raw(`CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type varchar(32) NOT NULL, actor_id uuid, action varchar(96) NOT NULL,
      resource_type varchar(48), resource_id uuid, metadata jsonb DEFAULT '{}', ip_address varchar(64), user_agent text, created_at timestamptz DEFAULT now())`);
    await migration.up(database);
  });
  beforeEach(async () => {
    [{ id: customerId }] = await database('customers').insert({}).returning('id');
    [{ id: techId }] = await database('technicians').insert({ name: 'Ada Example' }).returning('id');
  });
  afterEach(async () => {
    await database('audit_log').del();
    await database('home_notes').del();
    await database('customer_properties').del();
    await database('customers').del();
    await database('technicians').del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const property = async (active = true) => (await database('customer_properties').insert({ customer_id: customerId, active }).returning('id'))[0].id;

  test('a first save creates the note, a read returns it with the first name, and the audit row has no body', async () => {
    const propertyId = await property();
    const visit = { customer_id: customerId, property_id: propertyId };
    expect(await readHomeNote(visit)).toEqual({ status: 200, note: null, editable: true });
    const saved = await saveHomeNote(visit, { body: '  Gate sticks; use the side door.  ', actor: actor() });
    expect(saved.status).toBe(200);
    expect(saved.note).toMatchObject({ body: 'Gate sticks; use the side door.', updatedByFirstName: 'Ada' });
    expect((await readHomeNote(visit)).note.body).toBe('Gate sticks; use the side door.');
    const audit = await database('audit_log').select('*');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'technician', action: 'home_note.create', resource_type: 'home_notes' });
    expect(JSON.stringify(audit[0])).not.toContain('side door');
  });

  test('a visit with no property uses the customer\'s only active property, and the same home from the office', async () => {
    const propertyId = await property();
    await property(false);
    await saveHomeNote({ customer_id: customerId, property_id: null }, { body: 'Dog inside.', actor: actor() });
    const row = await database('home_notes').first();
    expect(row.property_id).toBe(propertyId);
    const office = await readHomeNote({ customer_id: customerId }, { office: true });
    expect(office.note.body).toBe('Dog inside.');
  });

  test('a customer with no property has one NULL-property home; the unique index refuses a second note for it', async () => {
    await saveHomeNote({ customer_id: customerId, property_id: null }, { body: 'One', actor: actor() });
    await expect(database('home_notes').insert({ customer_id: customerId, property_id: null, body: 'Two', updated_by_type: 'admin' }))
      .rejects.toMatchObject({ code: '23505' });
  });

  test('several homes: the office is refused (422), a visit at one home is not', async () => {
    const a = await property();
    await property();
    expect((await saveHomeNote({ customer_id: customerId }, { body: 'x', actor: actor({ type: 'admin' }) }, { office: true })).status).toBe(422);
    expect((await readHomeNote({ customer_id: customerId }, { office: true })).status).toBe(422);
    expect((await saveHomeNote({ customer_id: customerId, property_id: a }, { body: 'x', actor: actor() })).status).toBe(200);
  });

  test('a stale save is 409 with the current note and writes nothing', async () => {
    const visit = { customer_id: customerId, property_id: await property() };
    const first = await saveHomeNote(visit, { body: 'v1', actor: actor() });
    const second = await saveHomeNote(visit, { body: 'v2', expectedUpdatedAt: first.note.updatedAt, actor: actor({ type: 'admin' }) });
    expect(second.status).toBe(200);
    const stale = await saveHomeNote(visit, { body: 'v3', expectedUpdatedAt: first.note.updatedAt, actor: actor() });
    expect(stale).toMatchObject({ status: 409, code: 'note_changed', note: { body: 'v2' } });
    expect((await readHomeNote(visit)).note.body).toBe('v2');
    // A second editor that thought there was no note is also stale.
    expect((await saveHomeNote(visit, { body: 'v4', expectedUpdatedAt: null, actor: actor() })).status).toBe(409);
  });

  test('two first saves at once: one wins, the other is told 409 with the winner\'s note', async () => {
    const visit = { customer_id: customerId, property_id: await property() };
    const results = await Promise.all([
      saveHomeNote(visit, { body: 'from phone A', actor: actor() }),
      saveHomeNote(visit, { body: 'from phone B', actor: actor() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('too long is 400, empty deletes the row and audits the delete, empty with no note is a quiet 200', async () => {
    const visit = { customer_id: customerId, property_id: await property() };
    expect((await saveHomeNote(visit, { body: 'x'.repeat(1001), actor: actor() })).status).toBe(400);
    expect((await saveHomeNote(visit, { body: 'x'.repeat(1000), actor: actor() })).status).toBe(200);
    const current = (await readHomeNote(visit)).note;
    const gone = await saveHomeNote(visit, { body: '   ', expectedUpdatedAt: current.updatedAt, actor: actor() });
    expect(gone).toEqual({ status: 200, note: null });
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '0' });
    expect((await database('audit_log').pluck('action')).sort()).toEqual(['home_note.create', 'home_note.delete']);
    expect(await saveHomeNote(visit, { body: '', actor: actor() })).toEqual({ status: 200, note: null });
    expect((await saveHomeNote(visit, { body: 42, actor: actor() })).status).toBe(400);
  });

  test('a visit with no customer has no home: read is not editable, save is 422', async () => {
    expect(await readHomeNote({ customer_id: null })).toEqual({ status: 200, note: null, editable: false });
    expect((await saveHomeNote({ customer_id: null }, { body: 'x', actor: actor() })).status).toBe(422);
  });

  test('the table checks refuse an empty body and an unknown role; deleting the customer deletes the note', async () => {
    const insert = (extra) => database('home_notes').insert({ customer_id: customerId, body: 'ok', updated_by_type: 'admin', ...extra });
    await expect(insert({ body: '' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ updated_by_type: 'customer' })).rejects.toMatchObject({ code: '23514' });
    await insert({});
    await database('customers').where({ id: customerId }).del();
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '0' });
  });
});
