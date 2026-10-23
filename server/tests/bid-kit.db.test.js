// Bid kit (GATE_BID_KIT) through PostgreSQL: the migration (columns, check, index, up/down/up, credential link), the real
// store behind the routes (create, fenced patch, sign-off clearing, file replace, archive, facts sheet), the daily
// expiry job, and the public credentials feed staying unchanged. Every write runs in a transaction that is rolled back.
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
// The bell service is a stand-in here (its SQL runs in alert-episodes-db.test.js); the kit's own SQL is real.
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(), openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn(),
}));
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
const migration = require('../models/migrations/20261023120000_bid_kit_items');
const episodes = require('../services/admin-alert-episodes');
const { runBidKitExpiryCheck } = require('../services/bid-kit-expiry');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let mockAdminId = randomUUID();
let server;
let baseUrl;
const PDF = Buffer.from('%PDF-1.4\n%fixture bytes\n', 'latin1');
const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describeDb('Bid kit (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    process.env.GATE_BID_KIT = 'true';
    const app = express();
    app.use(express.json());
    app.use('/api/admin/bid-kit', require('../routes/admin-bid-kit'));
    app.use('/api/public/credentials', require('../routes/public-credentials'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    mockSent.length = 0;
    for (const fn of Object.values(episodes)) fn.mockReset();
    episodes.raiseAdminAlertWithReopen.mockImplementation(async () => ({ id: randomUUID(), deduped: false, rang: true }));
    episodes.openAdminAlertKeys.mockResolvedValue([]);
    episodes.closeAdminAlertKeys.mockResolvedValue(0);
    mockAdminId = randomUUID();
    await mockPg('technicians').insert({ id: mockAdminId, name: 'Fixture admin' });
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_BID_KIT;
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}/api/admin/bid-kit${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const create = async (over = {}) => (await call('POST', '', { kind: 'document', item_key: 'business_license_copy', ...over })).body.item;
  // The upload carries the version the page loaded: the row's current one unless a test says otherwise.
  const upload = async (id, name = 'license.pdf', version) => {
    const form = new FormData();
    const sent = version === undefined ? (await rowOf(id)).updated_at.toISOString() : version;
    if (sent !== null) form.append('expected_updated_at', sent);
    form.append('file', new Blob([PDF], { type: 'application/pdf' }), name);
    const res = await fetch(`${baseUrl}/api/admin/bid-kit/${id}/file`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  // Archive as the page does: with the version it loaded (the row's current one unless a test says otherwise).
  const archive = async (id, version) => {
    const sent = version === undefined ? (await rowOf(id)).updated_at.toISOString() : version;
    return call('DELETE', `/${id}${sent === null ? '' : `?expected_updated_at=${encodeURIComponent(sent)}`}`);
  };
  const rowOf = (id) => mockPg('bid_kit_items').where({ id }).first();
  const credential = (over = {}) => mockPg('business_credentials').insert({
    slug: `fixture-${randomUUID()}`, display_name: 'Fixture license', credential_type: 'license', credential_number: 'FX000000', expiration_date: '2999-03-03', ...over,
  }).returning('*').then(([row]) => row);

  describe('the migration', () => {
    test('creates the table with exactly the planned columns, the kind check and the partial index', async () => {
      const columns = await mockPg('information_schema.columns').where({ table_name: 'bid_kit_items' }).orderBy('ordinal_position').select('column_name', 'data_type', 'is_nullable', 'column_default');
      expect(columns.map((c) => c.column_name)).toEqual([
        'id', 'kind', 'item_key', 'label', 'value', 'file_s3_key', 'file_name', 'file_content_type', 'file_size', 'limits', 'details',
        'source_document', 'checked_on', 'expires_on', 'permission_on', 'attested_by', 'attested_at', 'notes', 'archived_at', 'created_at', 'updated_at',
      ]);
      const type = (name) => columns.find((c) => c.column_name === name).data_type;
      expect(type('id')).toBe('uuid');
      expect(type('limits')).toBe('jsonb');
      expect(type('details')).toBe('jsonb');
      expect(type('checked_on')).toBe('date');
      expect(type('expires_on')).toBe('date');
      expect(type('permission_on')).toBe('date');
      expect(type('attested_by')).toBe('uuid');
      expect(type('attested_at')).toBe('timestamp with time zone');
      expect(type('file_size')).toBe('integer');
      expect(columns.filter((c) => c.is_nullable === 'NO').map((c) => c.column_name)).toEqual(['id', 'kind', 'item_key', 'label', 'created_at', 'updated_at']);
      const index = await mockPg('pg_indexes').where({ tablename: 'bid_kit_items', indexname: 'bid_kit_items_kind_key' }).first('indexdef');
      expect(index.indexdef).toMatch(/\(kind, item_key\)/);
      expect(index.indexdef).toMatch(/WHERE \(archived_at IS NULL\)/);
      expect(await mockPg('bid_kit_items').count('* as n').first()).toMatchObject({ n: '0' }); // no seed rows
      await expect(mockPg('bid_kit_items').insert({ kind: 'spreadsheet', item_key: 'x', label: 'x' })).rejects.toThrow(/bid_kit_items_kind_check/);
    });

    test('is reversible and idempotent, and leaves business_credentials alone', async () => {
      const before = await mockPg('information_schema.columns').where({ table_name: 'business_credentials' }).orderBy('ordinal_position').pluck('column_name');
      await migration.up(mockPg); // already there: a no-op
      await migration.down(mockPg);
      expect(await mockPg.schema.hasTable('bid_kit_items')).toBe(false);
      await migration.down(mockPg); // already gone: a no-op
      await migration.up(mockPg);
      expect(await mockPg.schema.hasTable('bid_kit_items')).toBe(true);
      const after = await mockPg('information_schema.columns').where({ table_name: 'business_credentials' }).orderBy('ordinal_position').pluck('column_name');
      expect(after).toEqual(before);
      expect(after.some((name) => /bid|kit|attest/.test(name))).toBe(false);
    });

    test('has no link to business_credentials: no column, no foreign key', async () => {
      const links = await mockPg.raw(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'bid_kit_items'::regclass AND contype = 'f'`);
      expect(links.rows).toEqual([]);
      expect(await mockPg.schema.hasColumn('bid_kit_items', 'credential_id')).toBe(false);
    });
  });

  describe('through the routes and the real store', () => {
    test('a row keeps dates as calendar days, jsonb as objects, and never returns the stored key', async () => {
      const item = await create({
        item_key: 'insurance_certificate', value: 'POL-0001', source_document: 'Certificate dated Sep 1', checked_on: '2026-09-01', expires_on: '2999-12-31',
        limits: { glEachOccurrence: 1000000, workersComp: 'statutory' },
      });
      expect(item).toMatchObject({ checked_on: '2026-09-01', expires_on: '2999-12-31', limits: { glEachOccurrence: 1000000, workersComp: 'statutory' }, status: 'unattested' });
      expect(await rowOf(item.id)).toMatchObject({ limits: { glEachOccurrence: 1000000, workersComp: 'statutory' } });
      const uploaded = await upload(item.id);
      expect(uploaded.status).toBe(200);
      expect(typeof (await rowOf(item.id)).file_s3_key).toBe('string');
      expect(JSON.stringify((await call('GET', '')).body)).not.toMatch(/bid-kit\/|file_s3_key|https?:/);
    });

    test('the version the page loaded is accepted exactly, and an older one is refused', async () => {
      const created = await create({ item_key: 'w9' });
      const loaded = (await call('GET', '')).body.items.find((item) => item.id === created.id);
      const first = await call('PATCH', `/${created.id}`, { value: 'On file', expected_updated_at: loaded.updated_at });
      expect(first.status).toBe(200);
      expect((await call('PATCH', `/${created.id}`, { value: 'Other', expected_updated_at: loaded.updated_at })).status).toBe(409);
      expect((await rowOf(created.id)).value).toBe('On file');
      const second = await call('PATCH', `/${created.id}`, { value: 'Newer', expected_updated_at: first.body.item.updated_at });
      expect(second.status).toBe(200);
    });

    test('sign-off: recorded with the admin and time, cleared in the same update by an edit, a replaced file and a relink', async () => {
      const created = await create({ item_key: 'business_license_copy', value: 'JB000000', expires_on: '2999-06-30' });
      const attested = await call('POST', `/${created.id}/attest`, { expected_updated_at: created.updated_at });
      expect(attested.status).toBe(200);
      expect(await rowOf(created.id)).toMatchObject({ attested_by: mockAdminId });
      expect((await rowOf(created.id)).attested_at).toBeInstanceOf(Date);

      const edited = await call('PATCH', `/${created.id}`, { expires_on: '2999-01-01', expected_updated_at: attested.body.item.updated_at });
      expect(edited.body.item).toMatchObject({ attested_at: null, attested_by: null });
      expect(await rowOf(created.id)).toMatchObject({ attested_at: null, attested_by: null });

      const again = await call('POST', `/${created.id}/attest`, { expected_updated_at: edited.body.item.updated_at });
      expect((await rowOf(created.id)).attested_at).not.toBeNull();
      expect(again.status).toBe(200);
      await upload(created.id);
      expect(await rowOf(created.id)).toMatchObject({ attested_at: null, attested_by: null });
    });

    test('a sign-off is refused for a missing item, an expired one and one with no expiry date, and the row is left alone', async () => {
      const missing = await create({ item_key: 'w9' });
      expect((await call('POST', `/${missing.id}/attest`, { expected_updated_at: missing.updated_at })).status).toBe(400);
      const old = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: '2000-01-01' });
      expect((await call('POST', `/${old.id}/attest`, { expected_updated_at: old.updated_at })).status).toBe(400);
      expect((await rowOf(old.id)).attested_at).toBeNull();
      const undated = await create({ item_key: 'business_license_copy', value: 'JB000000' });
      expect(undated.status).toBe('needs_expiry');
      const refused = await call('POST', `/${undated.id}/attest`, { expected_updated_at: undated.updated_at });
      expect(refused).toMatchObject({ status: 400, body: { error: 'Add the expiry date first.' } });
      expect((await rowOf(undated.id)).attested_at).toBeNull();
      // A stale version is still a 409.
      const plan = await create({ item_key: 'ipm_plan', value: 'On file' });
      await call('PATCH', `/${plan.id}`, { value: 'Replaced', expected_updated_at: plan.updated_at });
      expect((await call('POST', `/${plan.id}/attest`, { expected_updated_at: plan.updated_at })).status).toBe(409);
    });

    test('a file replace points the row at the new private key, removes the old object and clears the sign-off', async () => {
      const created = await create({ item_key: 'business_license_copy' });
      await upload(created.id, 'first.pdf');
      const firstKey = (await rowOf(created.id)).file_s3_key;
      expect(firstKey).toMatch(new RegExp(`^bid-kit/${created.id}/[0-9a-f]{16}\\.pdf$`));
      expect(firstKey).not.toContain('first');
      await upload(created.id, 'second.pdf');
      const row = await rowOf(created.id);
      expect(row.file_s3_key).toMatch(/\.pdf$/);
      expect(row.file_s3_key).not.toContain('second');
      expect(row).toMatchObject({ file_name: 'second.pdf', file_content_type: 'application/pdf', file_size: PDF.length });
      expect(mockSent.filter((c) => c.constructor.name === 'DeleteObjectCommand').map((c) => c.input.Key)).toEqual([firstKey]);
      expect(mockSent.filter((c) => c.constructor.name === 'PutObjectCommand').every((c) => !('ACL' in c.input))).toBe(true);
      const link = await call('GET', `/${created.id}/file`);
      expect(link.status).toBe(200);
      expect(link.body.url).toContain(row.file_s3_key);
      expect(link.body.url).toMatch(/expires=300$/);
    });

    test('a file name with a tax ID is refused: nothing is stored, no row or key holds it', async () => {
      const created = await create({ item_key: 'business_license_copy' });
      for (const name of ['W9-123-45-6789.pdf', 'W9 12-3456789.pdf', 'EIN 123456789.pdf', 'W9 123456789.pdf', 'w-9_123456789.pdf']) {
        expect((await upload(created.id, name)).status).toBe(400);
      }
      expect(mockSent).toHaveLength(0);
      expect(await rowOf(created.id)).toMatchObject({ file_s3_key: null, file_name: null });
      expect(JSON.stringify((await call('GET', '')).body)).not.toMatch(/123-45-6789|12-3456789|123456789/);
      expect((await upload(created.id, 'FDACS license 2026.pdf')).status).toBe(200);
      expect((await rowOf(created.id)).file_name).toBe('FDACS license 2026.pdf');
    });

    test('a file replacement is fenced on the version the page loaded: stale or missing is refused and nothing is written', async () => {
      const created = await create({ item_key: 'business_license_copy', value: 'JB000000', expires_on: '2999-06-30' });
      const stale = created.updated_at;
      await call('PATCH', `/${created.id}`, { source_document: 'Typed by someone else', expected_updated_at: stale });
      expect((await upload(created.id, 'late.pdf', stale)).status).toBe(409);
      expect((await upload(created.id, 'none.pdf', null)).status).toBe(400);
      expect(mockSent.filter((c) => c.constructor.name === 'PutObjectCommand')).toHaveLength(0);
      expect(await rowOf(created.id)).toMatchObject({ file_s3_key: null, source_document: 'Typed by someone else' });
      // The version read from the database now is accepted (millisecond precision, as the page sends it).
      expect((await upload(created.id, 'fresh.pdf')).status).toBe(200);
      expect((await rowOf(created.id)).file_name).toBe('fresh.pdf');
      // Under the row lock the same fence holds: a version that moved between the early check and the write is a conflict.
      const store = require('../services/bid-kit-store');
      const before = await rowOf(created.id);
      const conflict = await store.replaceFile(created.id, { key: 'bid-kit/x/y.pdf', fileName: 'y.pdf', contentType: 'application/pdf', size: 1 }, new Date(before.updated_at.getTime() - 1000).toISOString());
      expect(conflict).toEqual({ conflict: true });
      expect((await rowOf(created.id)).file_s3_key).toBe(before.file_s3_key);
    });

    test('archive is fenced on the version the page loaded: stale is 409 and leaves the row and its bell, current works, missing is 400', async () => {
      const created = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: addDays(5) });
      const stale = created.updated_at;
      const renewed = await call('PATCH', `/${created.id}`, { expires_on: addDays(300), expected_updated_at: stale });
      expect(renewed.status).toBe(200);
      episodes.closeAdminAlertKeys.mockClear();
      expect((await archive(created.id, stale)).status).toBe(409);
      expect((await archive(created.id, null)).status).toBe(400);
      expect((await archive(created.id, 'yesterday')).status).toBe(400);
      expect(await rowOf(created.id)).toMatchObject({ archived_at: null, expires_on: expect.anything() });
      expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
      // The version read from the database now (millisecond precision, as the page sends it) archives it atomically.
      expect((await archive(created.id)).status).toBe(200);
      expect((await rowOf(created.id)).archived_at).toBeInstanceOf(Date);
      expect(episodes.closeAdminAlertKeys.mock.calls.at(-1).slice(1, 3)).toEqual([[`bid-kit:expiry:${created.id}`], 'archived']);
      expect((await archive(created.id, renewed.body.item.updated_at)).status).toBe(404); // already archived
      // The store's own single UPDATE: a version that does not match writes nothing.
      const store = require('../services/bid-kit-store');
      const live = await create({ item_key: 'w9', value: 'On file' });
      expect(await store.archiveItem(live.id, '2000-01-01T00:00:00.000Z')).toEqual({ conflict: true });
      expect((await rowOf(live.id)).archived_at).toBeNull();
    });

    test('one live row per catalog item (references repeat); archive keeps the row and frees the slot', async () => {
      await create({ item_key: 'w9' });
      expect((await call('POST', '', { kind: 'document', item_key: 'w9' })).status).toBe(409);
      for (const entity of ['Sample District', 'Sample HOA']) expect((await call('POST', '', { kind: 'reference', item_key: 'reference', details: { entity } })).status).toBe(201);
      const w9 = (await call('GET', '')).body.items.find((item) => item.item_key === 'w9');
      expect((await archive(w9.id)).status).toBe(200);
      expect(await rowOf(w9.id)).toMatchObject({ archived_at: expect.any(Date) });
      expect((await call('POST', '', { kind: 'document', item_key: 'w9' })).status).toBe(201);
      const live = (await call('GET', '')).body;
      expect(live.items.filter((item) => item.item_key === 'w9')).toHaveLength(1);
      expect((await call('GET', '?all=1')).body.items.filter((item) => item.item_key === 'w9')).toHaveLength(2);
    });

    test('the facts sheet shows typed values, leaves archived rows out and carries no key or link', async () => {
      await create({ kind: 'fact', item_key: 'fdacs_license_number', value: 'FX123456' });
      await create({ kind: 'fact', item_key: 'legal_name', value: 'Example Pest Services LLC' });
      const gone = await create({ kind: 'fact', item_key: 'phone', value: '941-555-0199' });
      await archive(gone.id);
      const license = await create({ item_key: 'business_license_copy', value: 'JB000000', expires_on: '2999-01-01' });
      await upload(license.id);
      const res = await call('GET', '/facts-sheet');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.facts.map((fact) => [fact.key, fact]));
      expect(byKey.fdacs_license_number.value).toBe('FX123456'); // typed by the owner
      expect(byKey.legal_name.value).toBe('Example Pest Services LLC');
      expect(byKey.phone.value).toBeNull();
      expect(res.body.documents).toEqual([expect.objectContaining({ key: 'business_license_copy', number: 'JB000000', expiresOn: '2999-01-01' })]);
      expect(JSON.stringify(res.body)).not.toMatch(/941-555-0199|bid-kit\/|s3_key|https?:/);
    });

    test('editing a business_credentials row changes nothing the kit returns, and a signed-off fact stays signed off', async () => {
      const cred = await credential({ credential_number: 'FX000000', expiration_date: '2999-03-03' });
      const fact = await create({ kind: 'fact', item_key: 'fdacs_license_number', value: 'FX000000' });
      expect((await call('POST', `/${fact.id}/attest`, { expected_updated_at: fact.updated_at })).status).toBe(200);
      const read = async () => ({ list: (await call('GET', '')).body, sheet: (await call('GET', '/facts-sheet')).body });
      const before = await read();
      await mockPg('business_credentials').where({ id: cred.id }).update({ credential_number: 'FX999999', expiration_date: '2000-01-01', updated_at: new Date() });
      await mockPg('business_credentials').where({ id: cred.id }).del();
      const after = await read();
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toContain('FX999999');
      expect(after.sheet.facts.find((entry) => entry.key === 'fdacs_license_number')).toMatchObject({ value: 'FX000000', signedOff: true, status: 'ready' });
      expect(await rowOf(fact.id)).toMatchObject({ value: 'FX000000', attested_by: mockAdminId });
    });

    test('a failed activity insert logs a fixed message and the error code, never the label the database error quotes', async () => {
      const logger = require('../services/logger');
      logger.warn.mockClear();
      mockAdminId = randomUUID(); // not a technician: the activity_log foreign key refuses the insert
      const label = 'Sample HOA board, board.sample@example.test, 100 Fixture Way';
      const res = await call('POST', '', { kind: 'reference', item_key: 'reference', details: { entity: label } });
      expect(res.status).toBe(201); // the save stands; only the activity row failed
      const lines = logger.warn.mock.calls.map(([line]) => String(line));
      expect(lines.filter((line) => line.includes('activity_log write failed'))).toEqual(['[bid-kit] activity_log write failed: 23503 constraint=activity_log_admin_user_id_foreign']);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/Sample HOA|board\.sample|Fixture Way|insert into/);
    });

    test('the activity log records who did what, with field names and no values', async () => {
      const created = await create({ item_key: 'w9' });
      await call('PATCH', `/${created.id}`, { value: 'On file with the office', expected_updated_at: created.updated_at });
      const rows = await mockPg('activity_log').where({ admin_user_id: mockAdminId }).orderBy('created_at').select('action', 'description', 'metadata');
      expect(rows.map((row) => row.action)).toEqual(['bid_kit_created', 'bid_kit_updated']);
      expect(rows[1].metadata).toMatchObject({ bid_kit_item_id: created.id, item_key: 'w9', fields: ['value'] });
      expect(JSON.stringify(rows)).not.toContain('On file with the office');
    });
  });

  describe('the daily expiry job', () => {
    test('rings once for each expired or soon-expiring item, with a spec the notification rules accept, and not for the rest', async () => {
      const expired = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: '2000-01-01' });
      const soon = await create({ item_key: 'insurance_certificate', value: 'POL-0001', expires_on: addDays(5) });
      await create({ item_key: 'w9', value: 'On file', expires_on: addDays(200) });
      await create({ item_key: 'ipm_plan', value: 'On file' });
      const gone = await create({ item_key: 'drug_free_policy', value: 'On file', expires_on: '2000-01-01' });
      await archive(gone.id);
      const result = await runBidKitExpiryCheck();
      expect(result).toEqual({ scanned: 2, rang: 2, closed: 0 });
      const rung = episodes.raiseAdminAlertWithReopen.mock.calls.map(([category, , , opts]) => ({ category, id: opts.metadata.subject.id, key: opts.dedupeKey, window: opts.dedupeWindowMs }));
      expect(rung).toEqual(expect.arrayContaining([
        { category: 'system', id: expired.id, key: `bid-kit:expiry:${expired.id}`, window: 7 * 86400000 },
        { category: 'system', id: soon.id, key: `bid-kit:expiry:${soon.id}`, window: 7 * 86400000 },
      ]));
    });

    test('a renewal, an archive and a vanished item close their bells; an item still inside the window keeps its bell', async () => {
      const kept = await create({ item_key: 'insurance_certificate', value: 'POL-0001', expires_on: addDays(5) });
      const renewed = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: addDays(5) });
      const archived = await create({ item_key: 'drug_free_policy', value: 'On file', expires_on: addDays(5) });
      episodes.closeAdminAlertKeys.mockClear();
      // A save that moves the date out of the window closes that bell at once.
      expect((await call('PATCH', `/${renewed.id}`, { expires_on: addDays(300), expected_updated_at: renewed.updated_at })).status).toBe(200);
      expect(episodes.closeAdminAlertKeys.mock.calls.map(([, keys, reason]) => [keys, reason])).toEqual([[[`bid-kit:expiry:${renewed.id}`], 'renewed']]);
      // So does an archive.
      await archive(archived.id);
      expect(episodes.closeAdminAlertKeys.mock.calls.at(-1).slice(1, 3)).toEqual([[`bid-kit:expiry:${archived.id}`], 'archived']);
      // The daily job closes every open bell that no longer qualifies, and only those.
      episodes.closeAdminAlertKeys.mockClear();
      episodes.openAdminAlertKeys.mockResolvedValue([kept, renewed, archived, { id: randomUUID() }].map((row) => `bid-kit:expiry:${row.id}`));
      const result = await runBidKitExpiryCheck();
      expect(result.scanned).toBe(1);
      // One locked close per stale bell.
      const keys = episodes.closeAdminAlertKeys.mock.calls.flatMap(([, closing]) => closing);
      expect(episodes.closeAdminAlertKeys.mock.calls.every(([, , reason]) => reason === 'no_longer_qualifies')).toBe(true);
      expect(keys).toEqual(expect.arrayContaining([`bid-kit:expiry:${renewed.id}`, `bid-kit:expiry:${archived.id}`]));
      expect(keys).not.toContain(`bid-kit:expiry:${kept.id}`);
    });

    test('a renewal or an archive that lands after the list was read but before the raise leaves no bell', async () => {
      const store = require('../services/bid-kit-store');
      const renewed = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: addDays(5) });
      const archived = await create({ item_key: 'drug_free_policy', value: 'On file', expires_on: addDays(5) });
      const kept = await create({ item_key: 'insurance_certificate', value: 'POL-0001', expires_on: addDays(6) });
      const realList = store.listItems;
      const spy = jest.spyOn(store, 'listItems').mockImplementationOnce(async (...args) => {
        const snapshot = await realList(...args);
        // The snapshot is taken; now two admins change items before the job raises.
        await mockPg('bid_kit_items').where({ id: renewed.id }).update({ expires_on: addDays(300), updated_at: mockPg.raw('clock_timestamp()') });
        await mockPg('bid_kit_items').where({ id: archived.id }).update({ archived_at: mockPg.fn.now(), updated_at: mockPg.raw('clock_timestamp()') });
        return snapshot;
      });
      try {
        const result = await runBidKitExpiryCheck();
        expect(result).toMatchObject({ scanned: 3, rang: 1 });
      } finally {
        spy.mockRestore();
      }
      const keys = episodes.raiseAdminAlertWithReopen.mock.calls.map(([, , , opts]) => opts.dedupeKey);
      expect(keys).toEqual([`bid-kit:expiry:${kept.id}`]);
    });

    test('with the gate off it reads nothing', async () => {
      await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: '2000-01-01' });
      process.env.GATE_BID_KIT = 'false';
      try {
        expect(await runBidKitExpiryCheck()).toEqual({ skipped: 'gate_off' });
        expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
      } finally {
        process.env.GATE_BID_KIT = 'true';
      }
    });
  });

  describe('the public credentials feed', () => {
    test('is identical with and without bid-kit rows, and never names a bid-kit field', async () => {
      const cred = await credential({ slug: `fixture-feed-${randomUUID()}`, display_name: 'Fixture feed license' });
      const read = async () => {
        const res = await fetch(`${baseUrl}/api/public/credentials`);
        const body = await res.json();
        return { status: res.status, credentials: body.credentials, keys: Object.keys(body).sort() };
      };
      const before = await read();
      expect(before.credentials.some((c) => c.slug === cred.slug)).toBe(true);
      const item = await create({ kind: 'fact', item_key: 'fdacs_license_number', value: 'Bid kit only value' });
      await upload((await create({ item_key: 'business_license_copy', value: 'JB000000' })).id);
      await call('POST', `/${item.id}/attest`, { expected_updated_at: item.updated_at });
      const after = await read();
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toMatch(/bid.kit|Bid kit only value|attested|file_s3_key/i);
    });
  });
});
