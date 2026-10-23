// Bid kit routes (GATE_BID_KIT): gate off = 404, create / patch / attest / archive, the sign-off clearing rule, file
// upload checks with S3 mocked, signed links, the facts sheet, and the public credentials feed staying unchanged.
// The store is an in-memory stand-in (the SQL runs in bid-kit.db.test.js, CI only); synthetic data only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockDb = jest.fn();
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.transaction = (...args) => mockDb(...args);
  db.raw = (...args) => mockDb(...args);
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = req.headers.authorization === 'Bearer admin' ? 'admin'
      : req.headers.authorization === 'Bearer tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = role;
    req.technicianId = role === 'admin' ? '0a0a0a0a-1111-4222-8333-444444444444' : 'tech-1';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/visual-service-notes', () => ({
  VISUAL_SERVICE_NOTES_FLAG: 'visual_service_notes',
  getVisualServiceNotesSettings: jest.fn(),
  isVisualServiceNotesEnabled: jest.fn(async () => false),
  setVisualServiceNotesSettings: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: { region: 'us-east-1', bucket: 'test-bucket' } }));

const mockSent = [];
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  return {
    S3Client: class { async send(command) { mockSent.push(command); if (mockSent.failNext) { mockSent.failNext = false; throw new Error('storage down'); } return {}; } },
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client, command, options) => `https://storage.example.test/${command.input.Key}?expires=${options.expiresIn}`),
}));

// An in-memory bid_kit_items: the same functions the route calls, the same row shape the real store returns.
jest.mock('../services/bid-kit-store', () => {
  const { randomUUID } = require('crypto');
  const rows = new Map();
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 23, 12, 0, 0, ++tick));
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  const view = (row) => {
    const { file_s3_key: key, ...rest } = row;
    return { ...rest, has_file: !!key };
  };
  const activity = [];
  const store = {
    rows, activity,
    reset() { rows.clear(); activity.length = 0; tick = 0; },
    touch(id, patch) { Object.assign(rows.get(id), patch); },
    keyOf: (id) => rows.get(id).file_s3_key,
    listItems: jest.fn(async ({ all = false } = {}) => [...rows.values()].filter((row) => all || !row.archived_at).map(view)),
    getItem: jest.fn(async (id) => (rows.has(id) ? view(rows.get(id)) : undefined)),
    fileInfo: jest.fn(async (id) => {
      const row = rows.get(id);
      return row && !row.archived_at ? { key: row.file_s3_key || null, fileName: row.file_name, contentType: row.file_content_type } : null;
    }),
    createItem: jest.fn(async (input, { unique = false } = {}) => {
      if (unique && [...rows.values()].some((row) => !row.archived_at && row.kind === input.kind && row.item_key === input.item_key)) return { duplicate: true };
      const id = randomUUID();
      const row = {
        id, value: null, file_s3_key: null, file_name: null, file_content_type: null, file_size: null, limits: null, details: null,
        source_document: null, checked_on: null, expires_on: null, permission_on: null, attested_by: null, attested_at: null, notes: null, archived_at: null,
        created_at: stamp(), updated_at: stamp(), ...input,
      };
      row.limits = parse(input.limits ?? null);
      row.details = parse(input.details ?? null);
      rows.set(id, row);
      return { item: view(row) };
    }),
    updateItem: jest.fn(async (id, compute) => {
      const row = rows.get(id);
      if (!row || row.archived_at) return { notFound: true };
      const decision = compute(view(row));
      if (decision.error) return { error: decision.error };
      const patch = { ...decision.patch };
      if ('limits' in patch) patch.limits = parse(patch.limits);
      if ('details' in patch) patch.details = parse(patch.details);
      if (Object.keys(patch).length) Object.assign(row, patch, { updated_at: stamp() });
      return { item: view(row) };
    }),
    replaceFile: jest.fn(async (id, file) => {
      const row = rows.get(id);
      if (!row || row.archived_at) return { notFound: true };
      const oldKey = row.file_s3_key || null;
      Object.assign(row, { file_s3_key: file.key, file_name: file.fileName, file_content_type: file.contentType, file_size: file.size, attested_by: null, attested_at: null, updated_at: stamp() });
      return { item: view(row), oldKey };
    }),
    archiveItem: jest.fn(async (id) => {
      const row = rows.get(id);
      if (!row || row.archived_at) return null;
      Object.assign(row, { archived_at: new Date(), updated_at: stamp() });
      return view(row);
    }),
    logActivity: jest.fn(async (adminUserId, action, description, metadata) => { activity.push({ adminUserId, action, description, metadata }); }),
  };
  return store;
});

const express = require('express');
const store = require('../services/bid-kit-store');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ADMIN = '0a0a0a0a-1111-4222-8333-444444444444';
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const PDF = Buffer.from('%PDF-1.4\n%fixture bytes\n', 'latin1');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml....', 'latin1')]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let server;
let baseUrl;
let mockCredentialRows = [];

async function call(method, url, body, headers = admin) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}
async function upload(id, { name = 'license.pdf', type = 'application/pdf', bytes = PDF, field = 'file' } = {}) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), name);
  const res = await fetch(`${baseUrl}/api/admin/bid-kit/${id}/file`, { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const create = async (over = {}) => (await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'business_license_copy', ...over })).body.item;
// Fill a row (a value and, for a paper that expires, an expiry date) so it can be signed off, then sign it off.
async function signed(over = {}) {
  const item = await create(over);
  const withValue = (await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'JB000000', expires_on: '2999-01-01', expected_updated_at: item.updated_at })).body.item;
  return (await call('POST', `/api/admin/bid-kit/${item.id}/attest`, { expected_updated_at: withValue.updated_at })).body.item;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/bid-kit', require('../routes/admin-bid-kit'));
  app.use('/api/admin/feature-flags', require('../routes/admin-feature-flags'));
  app.use('/api/public/credentials', require('../routes/public-credentials'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  store.reset();
  mockSent.length = 0;
  getSignedUrl.mockClear();
  jest.clearAllMocks();
  process.env.GATE_BID_KIT = 'true';
  mockDb.mockReset();
  mockDb.mockImplementation(() => {
    const chain = {
      where: () => chain, whereNull: () => chain, orderBy: () => chain, first: async () => mockCredentialRows[0],
      then: (resolve, reject) => Promise.resolve(mockCredentialRows).then(resolve, reject),
    };
    return chain;
  });
  mockCredentialRows = [];
});
afterEach(() => { delete process.env.GATE_BID_KIT; });

describe('gate off', () => {
  test.each(['', 'false', 'TRUE', '1', 'true '])('only the exact string "true" turns it on (%j)', async (value) => {
    process.env.GATE_BID_KIT = value;
    expect((await call('GET', '/api/admin/bid-kit')).status).toBe(404);
  });

  test('every route answers 404 for an admin, touches no data, and still refuses everyone else first', async () => {
    delete process.env.GATE_BID_KIT;
    const id = '11111111-2222-4333-8444-555555555555';
    for (const [method, url, body] of [
      ['GET', '/api/admin/bid-kit'], ['GET', '/api/admin/bid-kit/facts-sheet'], ['POST', '/api/admin/bid-kit', { kind: 'fact', item_key: 'phone' }],
      ['PATCH', `/api/admin/bid-kit/${id}`, { value: 'x', expected_updated_at: '2026-10-23T12:00:00.000Z' }],
      ['POST', `/api/admin/bid-kit/${id}/attest`, { expected_updated_at: '2026-10-23T12:00:00.000Z' }],
      ['GET', `/api/admin/bid-kit/${id}/file`], ['DELETE', `/api/admin/bid-kit/${id}`],
    ]) {
      expect((await call(method, url, body)).status).toBe(404);
      expect((await call(method, url, body, { 'Content-Type': 'application/json' })).status).toBe(401);
      expect((await call(method, url, body, { Authorization: 'Bearer tech', 'Content-Type': 'application/json' })).status).toBe(403);
    }
    const res = await fetch(`${baseUrl}/api/admin/bid-kit/${id}/file`, { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: new FormData() });
    expect(res.status).toBe(404);
    for (const name of ['listItems', 'getItem', 'createItem', 'updateItem', 'replaceFile', 'archiveItem', 'fileInfo']) expect(store[name]).not.toHaveBeenCalled();
    expect(mockSent).toHaveLength(0);
  });

  test('the nav flag is on only while the gate is on', async () => {
    mockDb.mockImplementation(() => ({ where: () => ({ select: async () => [{ flag_key: 'bid_kit', enabled: true }] }) }));
    expect((await call('GET', '/api/admin/feature-flags')).body.flags.bid_kit).toBe(true);
    delete process.env.GATE_BID_KIT;
    expect((await call('GET', '/api/admin/feature-flags')).body.flags.bid_kit).toBeUndefined(); // even a stray per-user row cannot show it
  });

  test('the daily job does nothing', async () => {
    delete process.env.GATE_BID_KIT;
    expect(await require('../services/bid-kit-expiry').runBidKitExpiryCheck()).toEqual({ skipped: 'gate_off' });
    expect(store.listItems).not.toHaveBeenCalled();
  });
});

describe('create and list', () => {
  test('a catalog item is created with its catalog label, shows missing until it has a file or value, and is never cached', async () => {
    const res = await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'cpco_certificate' });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ kind: 'document', item_key: 'cpco_certificate', label: 'Certified operator certificate and current renewal', status: 'missing', file: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(store.activity.map((entry) => entry.action)).toEqual(['bid_kit_created']);
    expect(store.activity[0]).toMatchObject({ adminUserId: ADMIN });
    // Field names go in the log, never values.
    const patched = await call('PATCH', `/api/admin/bid-kit/${res.body.item.id}`, { value: 'JB000000', expected_updated_at: res.body.item.updated_at });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(store.activity[1])).not.toContain('JB000000');
    expect(store.activity[1].metadata.fields).toEqual(['value']);
  });

  test('kind and item_key are checked against the catalog; custom needs a label', async () => {
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'not_a_real_item' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'fact', item_key: 'business_license_copy' })).status).toBe(400); // wrong kind for that key
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'spreadsheet', item_key: 'w9' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'custom' })).status).toBe(400);
    const custom = await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'custom', label: 'County vendor letter', value: 'Letter 7' });
    expect(custom.status).toBe(201);
    expect(custom.body.item.label).toBe('County vendor letter');
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'w9', surprise: true })).status).toBe(400); // unknown field
  });

  test('a single item cannot be created twice; references and custom rows can repeat', async () => {
    await create({ item_key: 'w9' });
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'w9' })).status).toBe(409);
    for (const entity of ['Sample District', 'Sample HOA']) {
      expect((await call('POST', '/api/admin/bid-kit', { kind: 'reference', item_key: 'reference', details: { entity } })).status).toBe(201);
    }
    const list = await call('GET', '/api/admin/bid-kit');
    expect(list.body.items.filter((item) => item.kind === 'reference')).toHaveLength(2);
  });

  test('a reference keeps its details; details belong to references only', async () => {
    const details = { entity: 'Sample District', contactRole: 'Facilities lead', phone: '941-555-0100', email: 'facilities@example.test', contractPeriod: '2024 to 2026', scope: 'Quarterly pest control', annualValue: '24000', publicOrPrivate: 'public' };
    const reference = await call('POST', '/api/admin/bid-kit', { kind: 'reference', item_key: 'reference', details });
    expect(reference.status).toBe(201);
    expect(reference.body.item.details).toEqual(details);
    expect(reference.body.item.status).toBe('needs_permission');
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'w9', details: { entity: 'x' } })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'reference', item_key: 'reference', details: { entity: 'x', favorite_color: 'blue' } })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'reference', item_key: 'reference', details: { publicOrPrivate: 'maybe' } })).status).toBe(400);
  });

  test('a date must be a real calendar day', async () => {
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'w9', expires_on: '2026-02-30' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'w9', expires_on: 'next spring' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'w9', expires_on: '2027-02-28' })).status).toBe(201);
  });

  test('GET / returns the catalog, every item with its status, and the summary; archived rows only with ?all=1', async () => {
    const license = await create();
    await create({ kind: 'fact', item_key: 'phone', value: '941-555-0100' });
    const gone = await create({ item_key: 'ipm_plan' });
    await call('DELETE', `/api/admin/bid-kit/${gone.id}`);
    const res = await call('GET', '/api/admin/bid-kit');
    expect(res.status).toBe(200);
    expect(res.body.catalog.map((section) => section.key)).toEqual(['sank_bids', 'insurance', 'registration_tax', 'plans_company', 'references', 'facts']);
    expect(res.body.items.map((item) => item.item_key).sort()).toEqual(['business_license_copy', 'phone']);
    expect(res.body.items.find((item) => item.id === license.id).status).toBe('missing');
    expect(res.body.items.find((item) => item.item_key === 'phone').status).toBe('unattested');
    expect(res.body.summary.overall).toMatchObject({ unattested: 1, ready: 0 });
    expect(res.body.summary.overall.total).toBe(res.body.catalog.reduce((sum, section) => sum + section.items.length, 0));
    expect(res.body.summary.sections.facts.total).toBe(15);
    const all = await call('GET', '/api/admin/bid-kit?all=1');
    expect(all.body.items.map((item) => item.item_key).sort()).toEqual(['business_license_copy', 'ipm_plan', 'phone']);
    expect(all.body.summary.overall.total).toBe(res.body.summary.overall.total); // archived rows never count
  });

  test.each([
    ['a hyphenated EIN', { value: 'EIN 12-3456789' }],
    ['an SSN', { notes: '123-45-6789' }],
    ['a labelled nine-digit tax ID', { source_document: 'Tax ID: 123456789' }],
    ['a label', { label: 'W-9 for 12-3456789' }],
    ['reference details', { details: { entity: '123-45-6789' } }],
  ])('%s is refused without repeating it', async (_name, over) => {
    const kind = over.details ? 'reference' : 'document';
    const res = await call('POST', '/api/admin/bid-kit', { kind, item_key: kind === 'reference' ? 'reference' : 'custom', label: 'Letter', ...over });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/\d{2}-\d{7}|\d{3}-\d{2}-\d{4}|\d{9}/);
    expect(res.body.error).toMatch(/tax ID/);
    const item = await create({ item_key: 'w9' });
    const patch = await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'EIN 12-3456789', expected_updated_at: item.updated_at });
    expect(patch.status).toBe(400);
    expect(store.rows.get(item.id).value).toBeNull();
  });

  test('a nine-digit policy number with no tax label is accepted; the same digits after a tax label are not', async () => {
    const ok = await call('POST', '/api/admin/bid-kit', { kind: 'document', item_key: 'insurance_certificate', value: '123456789', source_document: 'Certificate, policy 987654321' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.value).toBe('123456789');
    const bad = await call('PATCH', `/api/admin/bid-kit/${ok.body.item.id}`, { value: 'FEIN 123456789', expected_updated_at: ok.body.item.updated_at });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/tax ID/);
    expect(JSON.stringify(bad.body)).not.toContain('123456789');
  });
});

describe('patch', () => {
  test('limits are whole non-negative dollars, with workersComp a word', async () => {
    const item = await create({ item_key: 'insurance_certificate' });
    const url = `/api/admin/bid-kit/${item.id}`;
    const patch = (limits) => call('PATCH', url, { limits, expected_updated_at: store.rows.get(item.id).updated_at.toISOString() });
    for (const bad of [{ glEachOccurrence: -1 }, { glEachOccurrence: 1000000.5 }, { glEachOccurrence: '1000000' }, { glAggregate: 1e12 }, { workersComp: 'maybe' }, { workersComp: 5 }, { surprise: 1 }]) {
      expect((await patch(bad)).status).toBe(400);
    }
    const ok = await patch({ glEachOccurrence: 1000000, glAggregate: 2000000, productsCompletedOps: 2000000, autoCombinedSingle: 1000000, workersComp: 'statutory', employersLiability: 500000, umbrella: 0, pollution: 1000000 });
    expect(ok.status).toBe(200);
    expect(ok.body.item.limits).toMatchObject({ glEachOccurrence: 1000000, workersComp: 'statutory', umbrella: 0 });
    expect((await patch({ workersComp: 'exempt' })).body.item.limits).toEqual({ workersComp: 'exempt' });
    expect((await patch(null)).body.item.limits).toBeNull();
  });

  test('a save made against an older version is refused, and so is a save with no version', async () => {
    const item = await create({ item_key: 'w9' });
    const first = await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'Filed Oct 3', expected_updated_at: item.updated_at });
    expect(first.status).toBe(200);
    const stale = await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'Other', expected_updated_at: item.updated_at });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed since you opened/);
    expect(store.rows.get(item.id).value).toBe('Filed Oct 3');
    expect((await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'Other' })).status).toBe(400);
    expect((await call('PATCH', `/api/admin/bid-kit/${item.id}`, { expected_updated_at: first.body.item.updated_at })).status).toBe(400); // nothing to change
  });

  test('an unknown id, an archived item and a malformed id are all 404', async () => {
    const body = { value: 'x', expected_updated_at: '2026-10-23T12:00:00.000Z' };
    expect((await call('PATCH', '/api/admin/bid-kit/11111111-2222-4333-8444-555555555555', body)).status).toBe(404);
    expect((await call('PATCH', '/api/admin/bid-kit/not-an-id', body)).status).toBe(404);
    const item = await create({ item_key: 'w9' });
    await call('DELETE', `/api/admin/bid-kit/${item.id}`);
    expect((await call('PATCH', `/api/admin/bid-kit/${item.id}`, { ...body, expected_updated_at: store.rows.get(item.id).updated_at.toISOString() })).status).toBe(404);
  });

  describe('a change to what the sign-off covered clears it in the same update', () => {
    const CASES = [
      ['value', { value: 'JB999999' }],
      ['limits', { limits: { glEachOccurrence: 2000000 } }],
      ['source_document', { source_document: 'Certificate dated Oct 1' }],
      ['checked_on', { checked_on: '2026-10-01' }],
      ['expires_on', { expires_on: '2998-01-01' }],
      ['permission_on', { permission_on: '2026-10-03' }],
    ];
    test.each(CASES)('%s', async (_field, change) => {
      const item = await signed({ item_key: 'insurance_certificate' });
      expect(item.attested_at).not.toBeNull();
      expect(item.attested_by).toBe(ADMIN);
      const res = await call('PATCH', `/api/admin/bid-kit/${item.id}`, { ...change, expected_updated_at: item.updated_at });
      expect(res.status).toBe(200);
      expect(res.body.item.attested_at).toBeNull();
      expect(res.body.item.attested_by).toBeNull();
      expect(res.body.item.status).not.toBe('ready');
    });

    test('details', async () => {
      const reference = await call('POST', '/api/admin/bid-kit', { kind: 'reference', item_key: 'reference', details: { entity: 'Sample District' }, permission_on: '2026-10-01' });
      const attested = await call('POST', `/api/admin/bid-kit/${reference.body.item.id}/attest`, { expected_updated_at: reference.body.item.updated_at });
      expect(attested.body.item.status).toBe('ready');
      const res = await call('PATCH', `/api/admin/bid-kit/${reference.body.item.id}`, { details: { entity: 'Sample District', phone: '941-555-0100' }, expected_updated_at: attested.body.item.updated_at });
      expect(res.body.item).toMatchObject({ attested_at: null, attested_by: null, status: 'unattested' });
    });

    test('a label, a note or the same values again do not clear it', async () => {
      const item = await signed({ item_key: 'insurance_certificate' });
      const renamed = await call('PATCH', `/api/admin/bid-kit/${item.id}`, { label: 'COI (renewal Mar 1)', notes: 'Agent: call in February', expected_updated_at: item.updated_at });
      expect(renamed.body.item.attested_at).not.toBeNull();
      const same = await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'JB000000', limits: null, expected_updated_at: renamed.body.item.updated_at });
      expect(same.body.item.attested_at).not.toBeNull();
    });
  });
});

describe('attest', () => {
  test('the sign-off records the admin and the time and makes a current item ready', async () => {
    const item = await create({ item_key: 'w9', value: 'On file with the office manager', expires_on: '2999-01-01' });
    const res = await call('POST', `/api/admin/bid-kit/${item.id}/attest`, { expected_updated_at: item.updated_at });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ attested_by: ADMIN, status: 'ready' });
    expect(new Date(res.body.item.attested_at).getTime()).toBeGreaterThan(0);
    expect(store.activity.at(-1)).toMatchObject({ action: 'bid_kit_attested', adminUserId: ADMIN });
  });

  test('it is refused (400, in plain words) for a missing item, an expired one and one with no expiry date', async () => {
    const empty = await create({ item_key: 'w9' });
    const missing = await call('POST', `/api/admin/bid-kit/${empty.id}/attest`, { expected_updated_at: empty.updated_at });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Add the file or value/);
    const old = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: '2000-01-01' });
    const expired = await call('POST', `/api/admin/bid-kit/${old.id}/attest`, { expected_updated_at: old.updated_at });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toMatch(/expired/);
    const license = await create({ item_key: 'business_license_copy', value: 'JB000000' });
    expect(license.status).toBe('needs_expiry');
    const noExpiry = await call('POST', `/api/admin/bid-kit/${license.id}/attest`, { expected_updated_at: license.updated_at });
    expect(noExpiry.status).toBe(400);
    expect(noExpiry.body.error).toBe('Add the expiry date first.');
    expect(store.rows.get(empty.id).attested_at).toBeNull();
    expect(store.rows.get(old.id).attested_at).toBeNull();
    expect(store.rows.get(license.id).attested_at).toBeNull();
    // With the date added, the same item can be signed off.
    const dated = await call('PATCH', `/api/admin/bid-kit/${license.id}`, { expires_on: '2999-01-01', expected_updated_at: license.updated_at });
    expect(dated.body.item.status).toBe('unattested');
    expect((await call('POST', `/api/admin/bid-kit/${license.id}/attest`, { expected_updated_at: dated.body.item.updated_at })).status).toBe(200);
  });

  test('an item that does not expire needs no expiry date, and a custom item is not held to one', async () => {
    const w9 = await create({ item_key: 'w9', value: 'On file' });
    expect(w9.status).toBe('unattested');
    expect((await call('POST', `/api/admin/bid-kit/${w9.id}/attest`, { expected_updated_at: w9.updated_at })).body.item.status).toBe('ready');
    const custom = await create({ item_key: 'custom', label: 'County vendor letter', value: 'Letter 7' });
    expect(custom.status).toBe('unattested');
  });

  test('it signs the version the owner looked at: a change in between makes it a 409, and the version is required', async () => {
    const item = await create({ item_key: 'w9', value: 'On file' });
    await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'Replaced', expected_updated_at: item.updated_at });
    expect((await call('POST', `/api/admin/bid-kit/${item.id}/attest`, { expected_updated_at: item.updated_at })).status).toBe(409);
    expect(store.rows.get(item.id).attested_at).toBeNull();
    expect((await call('POST', `/api/admin/bid-kit/${item.id}/attest`, {})).status).toBe(400);
  });

  test('an item that expires within 30 days can be signed off; it then reads "expiring" and counts as ready, with its own count', async () => {
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const item = await create({ item_key: 'business_tax_receipt', value: 'BTR-0001', expires_on: soon });
    expect(item.status).toBe('unattested');
    const res = await call('POST', `/api/admin/bid-kit/${item.id}/attest`, { expected_updated_at: item.updated_at });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('expiring');
    const list = await call('GET', '/api/admin/bid-kit');
    expect(list.body.summary.overall).toMatchObject({ ready: 1, expiring: 1 });
    expect(list.body.summary.sections.registration_tax).toMatchObject({ ready: 1, expiring: 1 });
  });
});

describe('archive', () => {
  test('DELETE archives the row (it stays), drops it from the list and the summary, and logs it', async () => {
    const item = await create({ item_key: 'w9', value: 'On file' });
    const res = await call('DELETE', `/api/admin/bid-kit/${item.id}`);
    expect(res.status).toBe(200);
    expect(res.body.item.archived_at).not.toBeNull();
    expect(store.rows.has(item.id)).toBe(true);
    expect((await call('GET', '/api/admin/bid-kit')).body.items).toHaveLength(0);
    expect((await call('DELETE', `/api/admin/bid-kit/${item.id}`)).status).toBe(404);
    expect(store.activity.at(-1).action).toBe('bid_kit_archived');
  });
});

describe('files', () => {
  test('a PDF is stored under a private key with no ACL, and the response never carries the key', async () => {
    const item = await create();
    const res = await upload(item.id, { name: 'FDACS license 2026.pdf' });
    expect(res.status).toBe(200);
    expect(res.body.item.file).toEqual({ name: 'FDACS license 2026.pdf', contentType: 'application/pdf', size: PDF.length });
    expect(JSON.stringify(res.body)).not.toMatch(/bid-kit\/|file_s3_key|https?:/);
    const put = mockSent.find((command) => command.constructor.name === 'PutObjectCommand');
    expect(put.input).toMatchObject({ Bucket: 'test-bucket', ContentType: 'application/pdf' });
    // The key is a random token and a whitelisted extension: the original name is never part of it.
    expect(put.input.Key).toMatch(new RegExp(`^bid-kit/${item.id}/[0-9a-f]{16}\\.pdf$`));
    expect(put.input).not.toHaveProperty('ACL');
    expect(Object.keys(put.input).sort()).toEqual(['Body', 'Bucket', 'ContentType', 'Key']);
    expect(store.activity.at(-1)).toMatchObject({ action: 'bid_kit_file_uploaded' });
  });

  test.each([
    ['a hyphenated SSN', 'W9-123-45-6789.pdf'],
    ['a hyphenated EIN', 'W9 12-3456789.pdf'],
    ['a labelled nine-digit EIN', 'EIN 123456789.pdf'],
    ['a labelled TIN with a separator', 'W9_TIN_123456789.pdf'],
  ])('a file name with %s is refused with the tax-ID message, and never reaches storage, the row or any response', async (_name, fileName) => {
    const item = await create();
    const res = await upload(item.id, { name: fileName });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax ID/);
    expect(JSON.stringify(res.body)).not.toMatch(/\d{2}-\d{7}|\d{3}-\d{2}-\d{4}|\d{9}/);
    expect(mockSent).toHaveLength(0); // nothing was stored, so there is no key or object to carry the name
    expect(store.rows.get(item.id)).toMatchObject({ file_s3_key: null, file_name: null });
    const everything = JSON.stringify([
      (await call('GET', '/api/admin/bid-kit')).body, (await call('GET', '/api/admin/bid-kit?all=1')).body, (await call('GET', '/api/admin/bid-kit/facts-sheet')).body,
      (await call('GET', `/api/admin/bid-kit/${item.id}/file`)).body, [...store.rows.values()],
    ]);
    expect(everything).not.toMatch(/123-45-6789|12-3456789|123456789/);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('an ordinary name still works; it is kept for display and offered by the signed link, but is never in the storage key', async () => {
    const item = await create();
    const res = await upload(item.id, { name: 'Policy 2026 renewal (final).pdf' });
    expect(res.status).toBe(200);
    expect(res.body.item.file.name).toBe('Policy 2026 renewal _final_.pdf');
    const key = store.keyOf(item.id);
    expect(key).toMatch(new RegExp(`^bid-kit/${item.id}/[0-9a-f]{16}\\.pdf$`));
    expect(key).not.toMatch(/Policy|renewal/);
    await call('GET', `/api/admin/bid-kit/${item.id}/file`);
    expect(getSignedUrl.mock.calls[0][1].input.ResponseContentDisposition).toBe('inline; filename="Policy 2026 renewal _final_.pdf"');
    expect(getSignedUrl.mock.calls[0][1].input.Key).toBe(key);
  });

  test('every accepted type gets a whitelisted extension in its key', async () => {
    for (const [name, type, bytes, ext] of [['scan.PNG', 'image/png', PNG, 'png'], ['photo.jpeg', 'image/jpeg', JPEG, 'jpg'], ['plan.docx', DOCX_TYPE, DOCX, 'docx']]) {
      const item = await create({ item_key: `${ext}` === 'docx' ? 'ipm_plan' : ext === 'png' ? 'capability_sheet' : 'service_center_proof' });
      expect((await upload(item.id, { name, type, bytes })).status).toBe(200);
      expect(store.keyOf(item.id)).toMatch(new RegExp(`^bid-kit/${item.id}/[0-9a-f]{16}\\.${ext}$`));
    }
  });

  test('a stored name that somehow holds a tax ID is never offered by a signed link', async () => {
    const files = require('../services/bid-kit-files');
    await files.signedUrl({ key: 'bid-kit/x/abc.pdf', fileName: 'W9-123-45-6789.pdf', contentType: 'application/pdf' });
    expect(getSignedUrl.mock.calls[0][1].input.ResponseContentDisposition).toBe('inline; filename="file.pdf"');
  });

  test.each([
    ['PNG', 'scan.png', 'image/png', PNG],
    ['JPEG', 'photo.jpg', 'image/jpeg', JPEG],
    ['JPEG with the .jpeg spelling', 'photo.jpeg', 'image/jpeg', JPEG],
    ['DOCX', 'plan.docx', DOCX_TYPE, DOCX],
  ])('a %s is accepted', async (_name, name, type, bytes) => {
    const item = await create({ item_key: 'ipm_plan' });
    const res = await upload(item.id, { name, type, bytes });
    expect(res.status).toBe(200);
    expect(res.body.item.file.contentType).toBe(type);
  });

  test.each([
    ['a text file', 'notes.txt', 'text/plain', Buffer.from('hello world, not a paper')],
    ['an executable', 'setup.exe', 'application/octet-stream', Buffer.from('MZ\x90\x00\x03\x00\x00\x00')],
    ['a GIF', 'pic.gif', 'image/gif', Buffer.from('GIF89a......')],
    ['a PDF name on text bytes', 'license.pdf', 'application/pdf', Buffer.from('this is not a pdf at all')],
    ['a PNG type on JPEG bytes', 'scan.png', 'image/png', JPEG],
    ['a .zip named .docx', 'plan.docx', DOCX_TYPE, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....xl/workbook.xml....')])],
    ['a mismatched extension', 'license.exe', 'application/pdf', PDF],
    ['an empty file', 'empty.pdf', 'application/pdf', Buffer.alloc(0)],
  ])('%s is refused', async (_name, name, type, bytes) => {
    const item = await create();
    const res = await upload(item.id, { name, type, bytes });
    expect(res.status).toBe(400);
    expect(mockSent.filter((command) => command.constructor.name === 'PutObjectCommand')).toHaveLength(0);
    expect(store.rows.get(item.id).file_s3_key).toBeNull();
  });

  test('a file over 15 MB is refused; one at exactly 15 MB is accepted', async () => {
    const item = await create();
    const tooBig = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024)]);
    expect((await upload(item.id, { bytes: tooBig })).status).toBe(413);
    expect(mockSent).toHaveLength(0);
    const exact = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024 - 9)]);
    expect(exact.length).toBe(15 * 1024 * 1024);
    expect((await upload(item.id, { bytes: exact })).status).toBe(200);
  });

  test('no file, a wrongly named field and an unknown item are refused', async () => {
    const item = await create();
    expect((await upload(item.id, { field: 'attachment' })).status).toBe(400);
    const res = await fetch(`${baseUrl}/api/admin/bid-kit/${item.id}/file`, { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: new FormData() });
    expect(res.status).toBe(400);
    expect((await upload('11111111-2222-4333-8444-555555555555')).status).toBe(404);
    expect(mockSent).toHaveLength(0);
  });

  test('replacing a file clears the sign-off, and the old object is deleted', async () => {
    const item = await signed({ item_key: 'business_license_copy' });
    expect(item.attested_at).not.toBeNull();
    const first = await upload(item.id, { name: 'first.pdf' });
    expect(first.body.item.attested_at).toBeNull();
    const firstKey = store.keyOf(item.id);
    store.touch(item.id, { attested_at: new Date(), attested_by: ADMIN }); // sign it off again
    const second = await upload(item.id, { name: 'second.pdf' });
    expect(second.body.item).toMatchObject({ attested_at: null, attested_by: null, file: { name: 'second.pdf' } });
    expect(store.keyOf(item.id)).not.toBe(firstKey);
    const deleted = mockSent.filter((command) => command.constructor.name === 'DeleteObjectCommand').map((command) => command.input.Key);
    expect(deleted).toEqual([firstKey]);
  });

  test('a storage failure leaves the item as it was and is not reported as saved', async () => {
    const item = await create();
    mockSent.failNext = true;
    const res = await upload(item.id);
    expect(res.status).toBe(500);
    expect(store.rows.get(item.id).file_s3_key).toBeNull();
  });

  test('a row that was archived while the file was storing leaves no orphan object', async () => {
    const item = await create();
    store.replaceFile.mockResolvedValueOnce({ notFound: true });
    const res = await upload(item.id);
    expect(res.status).toBe(404);
    const put = mockSent.find((command) => command.constructor.name === 'PutObjectCommand');
    const deleted = mockSent.find((command) => command.constructor.name === 'DeleteObjectCommand');
    expect(deleted.input.Key).toBe(put.input.Key);
  });

  test('GET /:id/file returns a signed link good for at most 5 minutes, and only for a row that has a file', async () => {
    const item = await create();
    expect((await call('GET', `/api/admin/bid-kit/${item.id}/file`)).status).toBe(404);
    await upload(item.id, { name: 'license.pdf' });
    const res = await call('GET', `/api/admin/bid-kit/${item.id}/file`);
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(300);
    expect(res.body.url).toContain(`bid-kit/${item.id}/`);
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = getSignedUrl.mock.calls[0];
    expect(options.expiresIn).toBeLessThanOrEqual(300);
    expect(command.input).toMatchObject({ Bucket: 'test-bucket', ResponseContentDisposition: 'inline; filename="license.pdf"' });
    await call('DELETE', `/api/admin/bid-kit/${item.id}`);
    expect((await call('GET', `/api/admin/bid-kit/${item.id}/file`)).status).toBe(404);
  });
});

describe('facts sheet', () => {
  test('it returns fact values and paper numbers and dates, leaves archived rows out, and never returns a key, a file or a link', async () => {
    await create({ kind: 'fact', item_key: 'legal_name', value: 'Example Pest Services LLC' });
    const gone = await create({ kind: 'fact', item_key: 'phone', value: '941-555-0199' });
    await call('DELETE', `/api/admin/bid-kit/${gone.id}`);
    const license = await create({ item_key: 'business_license_copy', value: 'JB000000', expires_on: '2999-01-01' });
    await upload(license.id, { name: 'license.pdf' });
    const retired = await create({ item_key: 'business_tax_receipt', value: 'BTR-ARCHIVED', expires_on: '2999-02-02' });
    await call('DELETE', `/api/admin/bid-kit/${retired.id}`);
    await create({ kind: 'fact', item_key: 'fdacs_license_number', value: 'JB123456' });

    const res = await call('GET', '/api/admin/bid-kit/facts-sheet');
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.facts.map((fact) => [fact.key, fact]));
    expect(res.body.facts).toHaveLength(15);
    expect(byKey.legal_name).toMatchObject({ value: 'Example Pest Services LLC', signedOff: false });
    expect(byKey.phone).toMatchObject({ value: null, status: 'missing' }); // archived value is gone
    expect(byKey.fdacs_license_number.value).toBe('JB123456'); // typed by the owner like any other fact
    expect(res.body.documents).toEqual([{ key: 'business_license_copy', label: 'FDACS business license copy', number: 'JB000000', expiresOn: '2999-01-01', status: 'unattested', signedOff: false }]);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/BTR-ARCHIVED|941-555-0199/);
    expect(text).not.toMatch(/bid-kit\/|file_s3_key|s3_key|storage\.example|https?:|"file"|file_name|license\.pdf/i);
  });

  test('the same holds for every other response: no key, no stored address', async () => {
    const item = await create();
    const bodies = [
      (await upload(item.id)).body,
      (await call('GET', '/api/admin/bid-kit')).body,
      (await call('GET', '/api/admin/bid-kit?all=1')).body,
      (await call('GET', '/api/admin/bid-kit/facts-sheet')).body,
      (await call('PATCH', `/api/admin/bid-kit/${item.id}`, { value: 'x', expected_updated_at: store.rows.get(item.id).updated_at.toISOString() })).body,
      (await call('DELETE', `/api/admin/bid-kit/${item.id}`)).body,
    ];
    for (const body of bodies) expect(JSON.stringify(body)).not.toMatch(/bid-kit\/|file_s3_key|https?:/);
  });
});

describe('no link to business_credentials', () => {
  test('editing a credential changes nothing the kit returns, and the sign-off on the FDACS license number stands', async () => {
    mockCredentialRows = [{ slug: 'fdacs-license', display_name: 'FDACS pest control license', credential_type: 'license', credential_number: 'JB000000', status: 'active', sort_order: 1, is_public: true }];
    const fact = await create({ kind: 'fact', item_key: 'fdacs_license_number', value: 'JB000000' });
    const attested = await call('POST', `/api/admin/bid-kit/${fact.id}/attest`, { expected_updated_at: fact.updated_at });
    expect(attested.body.item.status).toBe('ready');
    const read = async () => ({ list: (await call('GET', '/api/admin/bid-kit')).body, sheet: (await call('GET', '/api/admin/bid-kit/facts-sheet')).body });
    const before = await read();
    mockCredentialRows[0].credential_number = 'JB999999';
    mockDb.mockClear();
    const after = await read();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('JB999999');
    expect(after.sheet.facts.find((entry) => entry.key === 'fdacs_license_number')).toMatchObject({ value: 'JB000000', signedOff: true, status: 'ready' });
    expect(mockDb).not.toHaveBeenCalled(); // the kit reads no other table
  });

  test('no kit module names business_credentials, and the row has no credential field', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['routes/admin-bid-kit.js', 'services/bid-kit-store.js', 'services/bid-kit-expiry.js', 'services/bid-kit-files.js', '../shared/bid-kit-catalog.cjs']) {
      const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(code).not.toMatch(/business_credentials|credential_id|credential_number/);
    }
  });
});

describe('the public credentials feed', () => {
  const credential = { slug: 'fdacs-license', display_name: 'FDACS pest control license', credential_type: 'license', issuing_authority: 'FDACS', credential_number: 'JB000000', display_format_short: 'FDACS JB000000', display_format_long: 'FDACS license JB000000', display_format_legal: 'Licensed by FDACS, JB000000', status: 'active', sort_order: 1, is_public: true };

  test('it returns only the documented credential fields, and no bid-kit data, whatever the kit holds', async () => {
    mockCredentialRows = [{ ...credential, bid_kit_value: 'leak', notes: 'private' }];
    await create({ kind: 'fact', item_key: 'legal_name', value: 'Example Pest Services LLC' });
    const license = await create({ item_key: 'business_license_copy', value: 'JB000000' });
    await upload(license.id);
    const res = await call('GET', '/api/public/credentials', undefined, {});
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['cache_ttl_seconds', 'credentials', 'generated_at']);
    expect(res.body.credentials).toEqual([{
      slug: 'fdacs-license', display_name: 'FDACS pest control license', credential_type: 'license', issuing_authority: 'FDACS', credential_number: 'JB000000',
      display_format_short: 'FDACS JB000000', display_format_long: 'FDACS license JB000000', display_format_legal: 'Licensed by FDACS, JB000000', status: 'active', sort_order: 1,
    }]);
    expect(JSON.stringify(res.body)).not.toMatch(/bid.kit|Example Pest Services|leak|private/i);
    const one = await call('GET', '/api/public/credentials/fdacs-license', undefined, {});
    expect(Object.keys(one.body).sort()).toEqual(['credential_number', 'credential_type', 'display_format_legal', 'display_format_long', 'display_format_short', 'display_name', 'issuing_authority', 'slug', 'sort_order', 'status']);
  });

  test('the migration adds a new table and never alters business_credentials', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../models/migrations/20261023120000_bid_kit_items.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/createTable\(TABLE/);
    expect(code).not.toMatch(/alterTable|ALTER TABLE business_credentials|table\('business_credentials'/);
    expect(code).not.toMatch(/business_credentials|credential_id/); // no link to it at all
  });
});
