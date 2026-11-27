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
const { readHomeNote, saveHomeNote: saveWithoutCustomer } = require('../services/home-note');
const { mergeHomeNotes } = require('../services/customer-dedupe')._test;

// Every save names the customer its editor was opened for (the route passes the browser's value).
const saveHomeNote = (row, input, opts) => saveWithoutCustomer(row, { expectedCustomerId: row.customer_id, ...input }, opts);

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
    await database.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz)');
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

  const visit = () => ({ customer_id: customerId });

  test('a first save creates the note, a read returns it with the first name, and the audit row has no body', async () => {
    expect(await readHomeNote(visit())).toEqual({ status: 200, note: null, editable: true, customerId });
    const saved = await saveHomeNote(visit(), { body: '  Gate sticks; use the side door.  ', actor: actor() });
    expect(saved.status).toBe(200);
    expect(saved.note).toMatchObject({ body: 'Gate sticks; use the side door.', updatedByFirstName: 'Ada' });
    expect((await readHomeNote(visit())).note.body).toBe('Gate sticks; use the side door.');
    const audit = await database('audit_log').select('*');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'technician', action: 'home_note.create', resource_type: 'home_notes' });
    expect(JSON.stringify(audit[0])).not.toContain('side door');
  });

  test('a customer with several homes has ONE note, shared by every visit and the office', async () => {
    await database('customer_properties').insert([{ customer_id: customerId }, { customer_id: customerId }]);
    await saveHomeNote({ customer_id: customerId, property_id: null }, { body: 'Dog inside.', actor: actor() });
    expect((await readHomeNote({ customer_id: customerId, property_id: randomUUID() })).note.body).toBe('Dog inside.');
    expect((await readHomeNote({ customer_id: customerId })).note.body).toBe('Dog inside.');
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('the unique key refuses a second row for a customer', async () => {
    await saveHomeNote(visit(), { body: 'One', actor: actor() });
    await expect(database('home_notes').insert({ customer_id: customerId, body: 'Two', updated_by_type: 'admin' }))
      .rejects.toMatchObject({ code: '23505' });
  });

  test('a stale save is 409 with the current note and writes nothing', async () => {
    const first = await saveHomeNote(visit(), { body: 'v1', actor: actor() });
    const second = await saveHomeNote(visit(), { body: 'v2', expectedNoteId: first.note.id, expectedRevision: first.note.revision, actor: actor({ type: 'admin' }) });
    expect(second.status).toBe(200);
    const stale = await saveHomeNote(visit(), { body: 'v3', expectedNoteId: first.note.id, expectedRevision: first.note.revision, actor: actor() });
    expect(stale).toMatchObject({ status: 409, code: 'note_changed', note: { body: 'v2', revision: 2 } });
    expect((await readHomeNote(visit())).note.body).toBe('v2');
    // A second editor that thought there was no note is also stale.
    expect((await saveHomeNote(visit(), { body: 'v4', expectedRevision: null, actor: actor() })).status).toBe(409);
    expect((await saveHomeNote(visit(), { body: 'v4', expectedRevision: 0, actor: actor() })).status).toBe(409);
    // The revision moves on every save, whatever the clock says: two saves in one millisecond are still told apart.
    const rows = await database('home_notes').select('revision');
    expect(rows).toEqual([{ revision: 2 }]);
    const fixed = new Date('2026-11-26T15:00:00.000Z');
    const RealDate = Date;
    global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } };
    try {
      const a = await saveHomeNote(visit(), { body: 'v5', expectedNoteId: first.note.id, expectedRevision: 2, actor: actor() });
      const b = await saveHomeNote(visit(), { body: 'v6', expectedNoteId: first.note.id, expectedRevision: 2, actor: actor() });
      expect([a.status, b.status]).toEqual([200, 409]);
      expect(a.note.revision).toBe(3);
    } finally { global.Date = RealDate; }
  });

  test('delete then recreate: an editor holding the OLD note (id A, revision 1) is refused on save and on delete', async () => {
    const a = await saveHomeNote(visit(), { body: 'old note', actor: actor() });
    expect(a.note.revision).toBe(1);
    await saveHomeNote(visit(), { body: '', expectedNoteId: a.note.id, expectedRevision: 1, actor: actor() });
    const b = await saveHomeNote(visit(), { body: 'replacement', actor: actor() });
    expect(b.note.revision).toBe(1);
    expect(b.note.id).not.toBe(a.note.id);
    const staleSave = await saveHomeNote(visit(), { body: 'overwrite', expectedNoteId: a.note.id, expectedRevision: 1, actor: actor() });
    expect(staleSave).toMatchObject({ status: 409, code: 'note_changed', note: { id: b.note.id, body: 'replacement' } });
    const staleDelete = await saveHomeNote(visit(), { body: '', expectedNoteId: a.note.id, expectedRevision: 1, actor: actor() });
    expect(staleDelete.status).toBe(409);
    expect((await readHomeNote(visit())).note.body).toBe('replacement');
    // The right id with a wrong revision, and the right revision with no id, are refused too.
    expect((await saveHomeNote(visit(), { body: 'x', expectedNoteId: b.note.id, expectedRevision: 9, actor: actor() })).status).toBe(409);
    expect((await saveHomeNote(visit(), { body: 'x', expectedNoteId: null, expectedRevision: 1, actor: actor() })).status).toBe(409);
    expect((await saveHomeNote(visit(), { body: 'ok', expectedNoteId: b.note.id, expectedRevision: 1, actor: actor() })).status).toBe(200);
  });

  test('two first saves at once: one wins, the other is told 409 with the winner\'s note', async () => {
    const results = await Promise.all([
      saveHomeNote(visit(), { body: 'from phone A', actor: actor() }),
      saveHomeNote(visit(), { body: 'from phone B', actor: actor() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('too long is 400, empty deletes the row and audits the delete, empty with no note is a quiet 200', async () => {
    expect((await saveHomeNote(visit(), { body: 'x'.repeat(1001), actor: actor() })).status).toBe(400);
    expect((await saveHomeNote(visit(), { body: 'x'.repeat(1000), actor: actor() })).status).toBe(200);
    const current = (await readHomeNote(visit())).note;
    const gone = await saveHomeNote(visit(), { body: '   ', expectedNoteId: current.id, expectedRevision: current.revision, actor: actor() });
    expect(gone).toEqual({ status: 200, note: null });
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '0' });
    expect((await database('audit_log').pluck('action')).sort()).toEqual(['home_note.create', 'home_note.delete']);
    expect(await saveHomeNote(visit(), { body: '', actor: actor() })).toEqual({ status: 200, note: null });
    expect((await saveHomeNote(visit(), { body: 42, actor: actor() })).status).toBe(400);
  });

  test('a visit with no customer has no home: read is not editable, save is 422', async () => {
    expect(await readHomeNote({ customer_id: null })).toEqual({ status: 200, note: null, editable: false });
    expect((await saveHomeNote({ customer_id: null }, { body: 'x', actor: actor() })).status).toBe(422);
  });

  test('a customer merge joins two notes into the kept row (real SQL), and moves a note only the archived customer had', async () => {
    const [{ id: loserId }] = await database('customers').insert({}).returning('id');
    await saveHomeNote({ customer_id: customerId }, { body: 'Gate sticks.', actor: actor() });
    await saveHomeNote({ customer_id: loserId }, { body: 'Dog inside.', actor: actor() });
    await database.transaction((trx) => mergeHomeNotes(trx, 'home_notes', 'customer_id', customerId, loserId));
    const rows = await database('home_notes').select('customer_id', 'body');
    expect(rows).toEqual([{ customer_id: customerId, body: 'Gate sticks.\n(merged) Dog inside.' }]);
    await database('home_notes').del();
    await saveHomeNote({ customer_id: loserId }, { body: 'Only theirs.', actor: actor() });
    await database.transaction((trx) => mergeHomeNotes(trx, 'home_notes', 'customer_id', customerId, loserId));
    expect(await database('home_notes').select('customer_id', 'body')).toEqual([{ customer_id: customerId, body: 'Only theirs.' }]);
  });

  test('a save for the customer the editor was NOT opened for is refused, even when both have no note', async () => {
    const [{ id: other }] = await database('customers').insert({}).returning('id');
    const moved = await saveWithoutCustomer(visit(), { body: 'A\'s home details', expectedCustomerId: other, actor: actor() });
    expect(moved).toMatchObject({ status: 409, code: 'customer_changed' });
    expect((await saveWithoutCustomer(visit(), { body: 'x', actor: actor() })).code).toBe('customer_changed');
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '0' });
  });

  test('a merged-away (archived) customer takes no note', async () => {
    await database('customers').where({ id: customerId }).update({ deleted_at: new Date() });
    expect(await saveHomeNote(visit(), { body: 'Late save.', actor: actor() })).toMatchObject({ status: 404 });
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '0' });
  });

  test('a database error reaches the caller with the operation and code only, never the note text', async () => {
    const err = await saveHomeNote(visit(), { body: 'private text\u0000here', actor: actor() }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^home note save failed \(/);
    expect(err.message).not.toContain('private');
  });

  test('the table checks refuse an empty body and an unknown role; deleting the customer deletes the note', async () => {
    const insert = (extra) => database('home_notes').insert({ customer_id: customerId, body: 'ok', updated_by_type: 'admin', ...extra });
    await expect(insert({ body: '' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ updated_by_type: 'customer' })).rejects.toMatchObject({ code: '23514' });
    // The table holds a joined merge note (2 x 1000 + the joint) but nothing longer.
    await expect(insert({ body: 'z'.repeat(2101) })).rejects.toMatchObject({ code: '23514' });
    await insert({ body: 'z'.repeat(2010) });
    await database('customers').where({ id: customerId }).del();
    expect(await database('home_notes').count('* as n').first()).toMatchObject({ n: '0' });
  });
});
