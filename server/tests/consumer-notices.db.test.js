// FDACS-13692 consumer notices (GATE_WARRANTY_13692_CHECK) through PostgreSQL: the migration (columns, FK cascade, index,
// up/down/up), the real lookup over e-signed contracts and paper records (Eastern signed day, DATE columns read as the
// exact day), and the three admin routes behind the gate. Every write runs in a transaction that is rolled back.
// Synthetic data only. Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: { region: 'us-east-1', bucket: 'test-bucket' } }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = mockAdminId; next(); },
  requireAdmin: (req, res, next) => next(),
}));
const mockSent = [];
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  return {
    S3Client: class { async send(command) { mockSent.push(command); return {}; } },
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client, command, options) => `https://storage.example.test/${command.input.Key}?expires=${options.expiresIn}`),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261024210000_consumer_notice_paper_records');
const notices = require('../services/consumer-notices');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let mockAdminId = randomUUID();
let server;
let baseUrl;
const PDF = Buffer.from('%PDF-1.4\n%fixture bytes\n', 'latin1');
const KEY = 'consumer_notice.fdacs_13692';

describeDb('FDACS-13692 consumer notices (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/customers/:customerId/consumer-notices', require('../routes/admin-consumer-notices'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    mockSent.length = 0;
    mockAdminId = randomUUID();
    await mockPg('technicians').insert({ id: mockAdminId, name: 'Fixture admin' });
    process.env.GATE_WARRANTY_13692_CHECK = 'true';
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); delete process.env.GATE_WARRANTY_13692_CHECK; });
  afterAll(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  const customer = async () => (await mockPg('customers').insert({
    first_name: 'Pat', last_name: `Fixture${randomUUID().slice(0, 8)}`, phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
  }).returning('id'))[0].id;
  const esign = async (customerId, signedAt, over = {}) => (await mockPg('customer_contracts').insert({
    customer_id: customerId, contract_type: 'document_template', document_template_key: KEY, title: 'Consumer Notice Form (FDACS-13692)', status: 'signed', signed_at: signedAt, ...over,
  }).returning('id'))[0].id;
  const paper = async (customerId, signedOn) => (await mockPg('consumer_notice_paper_records').insert({
    customer_id: customerId, signed_on: signedOn, s3_key: `consumer-notices/${customerId}/fixture`, file_name: 'scan.pdf', mime_type: 'application/pdf', file_size_bytes: 20,
  }).returning('id'))[0].id;
  const base = (customerId) => `${baseUrl}/api/admin/customers/${customerId}/consumer-notices`;
  const upload = async (customerId, { name = 'notice.pdf', type = 'application/pdf', bytes = PDF, signedOn = '09/01/2026' } = {}) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    if (signedOn !== null) form.append('signedOn', signedOn);
    const res = await fetch(`${base(customerId)}/paper`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  describe('the migration', () => {
    test('creates the planned columns, the customer cascade and the customer index; reversible and idempotent', async () => {
      const columns = await mockPg('information_schema.columns').where({ table_name: 'consumer_notice_paper_records' }).orderBy('ordinal_position').select('column_name', 'data_type', 'is_nullable');
      expect(columns.map((c) => c.column_name)).toEqual([
        'id', 'customer_id', 'signed_on', 's3_key', 'file_name', 'mime_type', 'file_size_bytes', 'recorded_by_admin_id', 'notes', 'created_at', 'updated_at',
      ]);
      const type = (name) => columns.find((c) => c.column_name === name).data_type;
      expect(type('id')).toBe('uuid');
      expect(type('signed_on')).toBe('date');
      expect(type('file_size_bytes')).toBe('integer');
      expect(type('recorded_by_admin_id')).toBe('uuid');
      expect(columns.filter((c) => c.is_nullable === 'NO').map((c) => c.column_name)).toEqual(
        ['id', 'customer_id', 'signed_on', 's3_key', 'file_name', 'mime_type', 'file_size_bytes', 'created_at', 'updated_at']);
      const index = await mockPg('pg_indexes').where({ tablename: 'consumer_notice_paper_records' }).pluck('indexdef');
      expect(index.some((def) => /\(customer_id\)/.test(def))).toBe(true);

      const customerId = await customer();
      await paper(customerId, '2026-09-01');
      await mockPg('customers').where({ id: customerId }).del();
      expect(await mockPg('consumer_notice_paper_records').where({ customer_id: customerId })).toEqual([]);

      await migration.up(mockPg); // already there: a no-op
      await migration.down(mockPg);
      expect(await mockPg.schema.hasTable('consumer_notice_paper_records')).toBe(false);
      await migration.down(mockPg);
      await migration.up(mockPg);
      expect(await mockPg.schema.hasTable('consumer_notice_paper_records')).toBe(true);
    });
  });

  describe('the lookup over real rows', () => {
    test('reads an e-signed day in Eastern time and a paper DATE as the exact day, newest on or before the limit', async () => {
      const customerId = await customer();
      const other = await customer();
      await esign(customerId, '2026-10-21T03:30:00Z'); // 11:30 PM ET on 10/20
      await esign(customerId, '2026-08-01T15:00:00Z');
      await esign(customerId, null, { status: 'sent' });
      await esign(other, '2026-10-19T15:00:00Z');
      await paper(customerId, '2026-09-15');
      expect(await notices.findConsumerNotice(mockPg, customerId, { onOrBefore: '2026-10-20' })).toMatchObject({ source: 'esign', signedOn: '10/20/2026' });
      expect(await notices.findConsumerNotice(mockPg, customerId, { onOrBefore: '2026-10-19' })).toMatchObject({ source: 'paper', signedOn: '09/15/2026' });
      expect(await notices.findConsumerNotice(mockPg, customerId, { onOrBefore: '2026-09-14' })).toMatchObject({ source: 'esign', signedOn: '08/01/2026' });
      expect(await notices.findConsumerNotice(mockPg, customerId, { onOrBefore: '2026-07-31' })).toBeNull();
      const list = await notices.listConsumerNotices(customerId, mockPg);
      expect(list.map((n) => [n.source, n.usable, n.signedOn])).toEqual([
        ['esign', true, '10/20/2026'], ['paper', true, '09/15/2026'], ['esign', true, '08/01/2026'], ['esign', false, null],
      ]);
    });
  });

  describe('the routes', () => {
    test('the whole surface answers 404 while the gate is off', async () => {
      const customerId = await customer();
      const recordId = await paper(customerId, '2026-09-01');
      delete process.env.GATE_WARRANTY_13692_CHECK;
      expect((await fetch(base(customerId))).status).toBe(404);
      expect((await upload(customerId)).status).toBe(404);
      expect((await fetch(`${base(customerId)}/paper/${recordId}/file`)).status).toBe(404);
      expect(await mockPg('consumer_notice_paper_records').where({ customer_id: customerId })).toHaveLength(1);
      expect(mockSent).toEqual([]);
    });

    test('lists, uploads a paper scan under the customer prefix, and opens it with a short signed link', async () => {
      const customerId = await customer();
      const empty = await (await fetch(base(customerId))).json();
      expect(empty).toMatchObject({ enabled: true, graceEnd: '2026-11-24', notices: [] });

      const saved = await upload(customerId, { signedOn: '09/01/2026' });
      expect(saved.status).toBe(201);
      expect(saved.body.notice).toMatchObject({ source: 'paper', signedOn: '09/01/2026', fileName: 'notice.pdf', mimeType: 'application/pdf' });
      expect(JSON.stringify(saved.body)).not.toMatch(/consumer-notices\/|s3_key/);
      const put = mockSent.find((command) => command.constructor.name === 'PutObjectCommand');
      expect(put.input.Key.startsWith(`consumer-notices/${customerId}/`)).toBe(true);
      expect(put.input.ContentType).toBe('application/pdf');
      const row = await mockPg('consumer_notice_paper_records').where({ customer_id: customerId }).first();
      expect(row).toMatchObject({ recorded_by_admin_id: mockAdminId, file_size_bytes: PDF.length, mime_type: 'application/pdf' });
      expect(await notices.findConsumerNotice(mockPg, customerId, { onOrBefore: '2026-09-01' })).toMatchObject({ source: 'paper', signedOn: '09/01/2026' });

      const listed = await (await fetch(base(customerId))).json();
      expect(listed.notices).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toMatch(/consumer-notices\/|s3_key/);

      const link = await (await fetch(`${base(customerId)}/paper/${row.id}/file`)).json();
      expect(link.url).toBe(`https://storage.example.test/${row.s3_key}?expires=300`);
    });

    test('refuses a bad type, a mismatched file, a future date, a pre-2021 date and a missing file; stores nothing', async () => {
      const customerId = await customer();
      expect((await upload(customerId, { name: 'n.gif', type: 'image/gif' })).status).toBe(400);
      expect((await upload(customerId, { bytes: Buffer.from('not a pdf at all') })).status).toBe(400);
      expect((await upload(customerId, { signedOn: '01/01/2099' })).body.error).toMatch(/future/);
      expect((await upload(customerId, { signedOn: '06/30/2021' })).body.error).toMatch(/before 07\/01\/2021/);
      expect((await upload(customerId, { signedOn: null })).status).toBe(400);
      const noFile = await fetch(`${base(customerId)}/paper`, { method: 'POST', body: new FormData() });
      expect(noFile.status).toBe(400);
      expect(await mockPg('consumer_notice_paper_records').where({ customer_id: customerId })).toEqual([]);
      expect(mockSent).toEqual([]);
    });

    test("a record opens only under its own customer; an unknown, deleted or malformed id is a 404", async () => {
      const customerId = await customer();
      const other = await customer();
      const recordId = await paper(customerId, '2026-09-01');
      expect((await fetch(`${base(other)}/paper/${recordId}/file`)).status).toBe(404);
      expect((await fetch(`${base(customerId)}/paper/${randomUUID()}/file`)).status).toBe(404);
      expect((await fetch(`${base(customerId)}/paper/not-a-uuid/file`)).status).toBe(404);
      expect((await fetch(base(randomUUID()))).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/admin/customers/not-a-uuid/consumer-notices`)).status).toBe(404);
      await mockPg('customers').where({ id: other }).update({ deleted_at: new Date() });
      expect((await fetch(base(other))).status).toBe(404);
    });

    test('removes the stored scan when the insert fails', async () => {
      const missing = randomUUID();
      await expect(notices.recordPaperNotice(missing, { originalname: 'n.pdf', mimetype: 'application/pdf', buffer: PDF }, { signedOn: '09/01/2026' })).rejects.toThrow();
      const put = mockSent.find((command) => command.constructor.name === 'PutObjectCommand');
      const del = mockSent.find((command) => command.constructor.name === 'DeleteObjectCommand');
      expect(del.input.Key).toBe(put.input.Key);
    });
  });
});
