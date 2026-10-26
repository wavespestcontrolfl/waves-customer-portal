// Saved misting layouts (GATE_MISTING_LAYOUT_DESIGNER, step 3): the admin routes and the service behind them,
// with an in-memory table, S3 and signer mocked. Covers auth, both gates, validation, upsert, picture
// replacement and the document block (present, absent, gate off).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const EST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (...a) => mockS3Send(...a) })),
  PutObjectCommand: jest.fn((input) => ({ type: 'put', input })),
  DeleteObjectCommand: jest.fn((input) => ({ type: 'delete', input })),
  GetObjectCommand: jest.fn((input) => ({ type: 'get', input })),
}));
const mockSign = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: (...a) => mockSign(...a) }));
jest.mock('../config', () => ({ s3: { bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// In-memory estimates + misting_layouts.
let mockEstimates;
let mockLayouts;
let mockFailUpsert;
jest.mock('../models/db', () => {
  const table = (name) => {
    const rows = () => (name === 'estimates' ? mockEstimates : mockLayouts);
    let filter = {};
    const match = () => rows().filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
    const b = {
      where(f) { filter = f; return b; },
      forUpdate() { return b; },
      async first() { return match()[0] || undefined; },
      insert(record) {
        return {
          onConflict() {
            return {
              async merge(update) {
                if (mockFailUpsert) throw new Error('upsert failed');
                const hit = mockLayouts.find((r) => r.estimate_id === record.estimate_id);
                if (hit) Object.assign(hit, update, { updated_at: 'T2' });
                else mockLayouts.push({ id: `lay-${mockLayouts.length + 1}`, created_at: 'T1', updated_at: 'T1', ...record });
              },
            };
          },
        };
      },
    };
    return b;
  };
  const db = jest.fn((name) => table(name));
  db.fn = { now: () => 'NOW' };
  db.transaction = async (fn) => fn(db);
  return db;
});

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.techRole = req.headers['x-test-role'] || 'technician';
    req.technicianId = '33333333-3333-4333-8333-333333333333';
    next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const router = require('../routes/admin-estimate-misting-layout');
const { mistingLayoutDocBlock, layoutEnabled } = require('../services/misting-layouts');

const GATES = ['GATE_MOSQUITO_MISTING', 'GATE_MISTING_LAYOUT_DESIGNER'];
const savedEnv = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
const gatesOn = () => { process.env.GATE_MOSQUITO_MISTING = 'true'; process.env.GATE_MISTING_LAYOUT_DESIGNER = 'true'; };

let server;
let baseUrl;
beforeAll(() => {
  const app = express();
  app.use('/api/admin/estimates', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(() => {
  gatesOn();
  mockEstimates = [{ id: EST, estimate_data: JSON.stringify({ engineInputs: { services: { mosquitoMisting: { nozzles: 20 } } } }) }];
  mockLayouts = [];
  mockFailUpsert = false;
  mockS3Send.mockReset().mockResolvedValue({});
  mockSign.mockReset().mockResolvedValue('https://signed.example/layout.png');
});
afterEach(() => {
  GATES.forEach((g) => { if (savedEnv[g] === undefined) delete process.env[g]; else process.env[g] = savedEnv[g]; });
});

const payload = (over = {}) => ({
  address: '500 Example Court, Venice, FL',
  center: { lat: 26.95, lng: -82.4 },
  zoom: 20,
  mapWidth: 1280,
  mapHeight: 960,
  lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] }],
  nozzles: [{ x: 100, y: 200, kind: 'eave', lineIndex: 0 }, { x: 400, y: 200, kind: 'eave', lineIndex: 0 }],
  risers: [{ x: 50, y: 60 }],
  pump: { x: 70, y: 80 },
  zones: [{ kind: 'pool', x: 300, y: 300, radiusFt: 15 }],
  ...over,
});

async function put(id, { role = 'admin', body = payload(), png = PNG, mimetype = 'image/png', rawPayload } = {}) {
  const form = new FormData();
  if (png) form.append('snapshot', new Blob([png], { type: mimetype }), 'misting-layout.png');
  form.append('payload', rawPayload !== undefined ? rawPayload : JSON.stringify(body));
  const res = await fetch(`${baseUrl}/api/admin/estimates/${id}/misting-layout`, { method: 'PUT', headers: { 'x-test-role': role }, body: form });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(id, role = 'admin') {
  const res = await fetch(`${baseUrl}/api/admin/estimates/${id}/misting-layout`, { headers: { 'x-test-role': role } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('gates', () => {
  test.each([
    ['GATE_MISTING_LAYOUT_DESIGNER', undefined],
    ['GATE_MISTING_LAYOUT_DESIGNER', 'false'],
    ['GATE_MISTING_LAYOUT_DESIGNER', '1'],
    ['GATE_MOSQUITO_MISTING', undefined],
    ['GATE_MOSQUITO_MISTING', 'false'],
  ])('%s = %s: every route answers 404 and nothing is stored or uploaded', async (gate, value) => {
    if (value === undefined) delete process.env[gate]; else process.env[gate] = value;
    expect(layoutEnabled()).toBe(false);
    expect((await get(EST)).status).toBe(404);
    expect((await put(EST)).status).toBe(404);
    expect(mockLayouts).toHaveLength(0);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  test('staff who are not admin are refused on read and write', async () => {
    expect((await get(EST, 'technician')).status).toBe(403);
    expect((await put(EST, { role: 'technician' })).status).toBe(403);
    expect(mockLayouts).toHaveLength(0);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  test('answers null when nothing is saved, 404 for an unknown or malformed estimate', async () => {
    expect(await get(EST)).toEqual({ status: 200, json: { layout: null } });
    expect((await get(OTHER)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
  });

  test('returns the saved layout with a signed picture link', async () => {
    await put(EST);
    const { status, json } = await get(EST);
    expect(status).toBe(200);
    expect(json.layout).toMatchObject({
      estimateId: EST, zoom: 20, address: '500 Example Court, Venice, FL',
      center: { lat: 26.95, lng: -82.4 }, counts: { nozzles: 2, eave: 2, fence: 0, risers: 1 },
      snapshotUrl: 'https://signed.example/layout.png',
    });
    expect(json.layout.nozzles).toHaveLength(2);
    expect(json.layout.pump).toEqual({ x: 70, y: 80 });
    expect(mockSign.mock.calls[0][1].input.Key).toBe(mockLayouts[0].snapshot_s3_key);
  });
});

describe('PUT', () => {
  test('validates, uploads the PNG under the new prefix, stores the row and returns the layout', async () => {
    const { status, json } = await put(EST);
    expect(status).toBe(200);
    expect(json.layout.counts).toMatchObject({ nozzles: 2, risers: 1 });
    expect(mockLayouts).toHaveLength(1);
    const row = mockLayouts[0];
    expect(row.snapshot_s3_key).toMatch(new RegExp(`^service-photos/misting-layouts/${EST}/\\d+-[0-9a-f]{8}-layout\\.png$`));
    expect(row).toMatchObject({ estimate_id: EST, nozzle_count: 2, riser_count: 1, created_by: '33333333-3333-4333-8333-333333333333' });
    // jsonb values go in as JSON text (a bare JS array would become a Postgres array literal).
    expect(typeof row.nozzles).toBe('string');
    expect(JSON.parse(row.nozzles)).toHaveLength(2);
    const puts = mockS3Send.mock.calls.map(([c]) => c).filter((c) => c.type === 'put');
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toMatchObject({ Bucket: 'test-bucket', Key: row.snapshot_s3_key, ContentType: 'image/png' });
    expect(Buffer.compare(puts[0].input.Body, PNG)).toBe(0);
  });

  test('a second save replaces the one row and deletes the old picture only after the row is written', async () => {
    await put(EST);
    const firstKey = mockLayouts[0].snapshot_s3_key;
    mockS3Send.mockClear();
    const { status } = await put(EST, { body: payload({ nozzles: [{ x: 10, y: 10, kind: 'fence', lineIndex: 0 }] }) });
    expect(status).toBe(200);
    expect(mockLayouts).toHaveLength(1);
    expect(mockLayouts[0]).toMatchObject({ nozzle_count: 1, fence_count: 1, eave_count: 0 });
    expect(mockLayouts[0].snapshot_s3_key).not.toBe(firstKey);
    const commands = mockS3Send.mock.calls.map(([c]) => c);
    expect(commands.map((c) => c.type)).toEqual(['put', 'delete']);
    expect(commands[1].input.Key).toBe(firstKey);
  });

  test('a failed row write deletes the picture it just uploaded and keeps the old layout', async () => {
    await put(EST);
    const before = { ...mockLayouts[0] };
    mockS3Send.mockClear();
    mockFailUpsert = true;
    expect((await put(EST)).status).toBe(500);
    const commands = mockS3Send.mock.calls.map(([c]) => c);
    expect(commands.map((c) => c.type)).toEqual(['put', 'delete']);
    expect(commands[1].input.Key).toBe(commands[0].input.Key);
    expect(mockLayouts[0].snapshot_s3_key).toBe(before.snapshot_s3_key);
  });

  test('a storage hiccup on the old picture does not fail the save', async () => {
    await put(EST);
    mockS3Send.mockImplementation(async (c) => { if (c.type === 'delete') throw new Error('denied'); return {}; });
    expect((await put(EST)).status).toBe(200);
  });

  test('refuses a bad payload before touching S3', async () => {
    for (const body of [
      payload({ nozzles: [] }),
      payload({ zoom: 99 }),
      payload({ mapWidth: 10 }),
      payload({ nozzles: [{ x: 'a', y: 1, kind: 'eave' }] }),
      payload({ nozzles: [{ x: 1, y: 1, kind: 'roof' }] }),
      payload({ zones: [{ kind: 'pool', x: 1, y: 1, radiusFt: 9999 }] }),
    ]) {
      const { status, json } = await put(EST, { body });
      expect(status).toBe(400);
      expect(json.error).toBeTruthy();
    }
    expect((await put(EST, { rawPayload: '{nope' })).json).toEqual({ error: 'payload must be valid JSON' });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockLayouts).toHaveLength(0);
  });

  test('refuses a missing or non-PNG picture, by bytes as well as by type', async () => {
    expect((await put(EST, { png: null })).status).toBe(400);
    expect((await put(EST, { png: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), mimetype: 'image/png' })).status).toBe(400);
    expect((await put(EST, { png: PNG, mimetype: 'image/jpeg' })).status).toBe(400);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('refuses a picture over 8MB with 413, before it is stored', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
    expect((await put(EST, { png: big })).status).toBe(413);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('404 for an estimate that does not exist, and for a malformed id', async () => {
    expect((await put(OTHER)).status).toBe(404);
    expect((await put('nope')).status).toBe(404);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('document block (the estimate PDF section)', () => {
  const estimate = () => mockEstimates[0];

  test('absent with the gates off, so the document is unchanged', async () => {
    await put(EST);
    delete process.env.GATE_MISTING_LAYOUT_DESIGNER;
    expect(await mistingLayoutDocBlock(estimate())).toEqual({});
    gatesOn();
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(await mistingLayoutDocBlock(estimate())).toEqual({});
  });

  test('absent when no layout is saved or the estimate has no misting system', async () => {
    expect(await mistingLayoutDocBlock(estimate())).toEqual({});
    await put(EST);
    expect(await mistingLayoutDocBlock({ id: EST, estimate_data: JSON.stringify({ engineInputs: { services: { pest: true } } }) })).toEqual({});
    expect(await mistingLayoutDocBlock({ id: EST, estimate_data: null })).toEqual({});
  });

  test('a layout saved for another address is not printed (the estimate moved to a different property)', async () => {
    await put(EST); // saved at 500 Example Court, Venice, FL
    const doc = (address) => mistingLayoutDocBlock({ ...estimate(), address });
    expect(await doc('900 Other Road, Venice, FL 34285')).toEqual({});
    expect(await doc('501 Example Court, Venice, FL')).toEqual({});
    // The same property, typed differently or with a ZIP code, still prints; so does an estimate with no address.
    expect(await doc('500 example court venice fl')).toHaveProperty('mistingLayout');
    expect(await doc('500 Example Court, Venice, FL 34285')).toHaveProperty('mistingLayout');
    expect(await doc(null)).toHaveProperty('mistingLayout');
  });

  test('uses the authoritative misting reader: a selected input counts (any shape of it), a stale mention does not', async () => {
    await put(EST);
    const block = async (data) => mistingLayoutDocBlock({ id: EST, estimate_data: data });
    expect(await block({ engineInputs: { services: { mosquitoMisting: true } } })).toHaveProperty('mistingLayout');
    expect(await block({ engineInputs: { services: { mosquito_misting: { risers: 2 } } } })).toHaveProperty('mistingLayout');
    // The selection is off or a bare mention: not a misting estimate.
    expect(await block({ engineInputs: { services: { mosquitoMisting: false } } })).toEqual({});
    expect(await block({ note: 'was mosquito_misting before it was removed' })).toEqual({});
    // An authored itemized proposal that does not sell the system wins over inputs left behind.
    expect(await block({
      engineInputs: { services: { mosquitoMisting: true } },
      proposal: { enabled: true, buildings: [{ lineItems: [{ description: 'Recurring pest service' }] }] },
    })).toEqual({});
  });

  test('present with a signed image link and the counts when saved, gates on and misting in the estimate', async () => {
    await put(EST);
    mockSign.mockClear();
    const block = await mistingLayoutDocBlock(estimate());
    expect(block).toEqual({
      mistingLayout: {
        imageUrl: 'https://signed.example/layout.png',
        revision: expect.stringMatching(/^[0-9a-f]{16}$/),
        address: '500 Example Court, Venice, FL',
        counts: { nozzles: 2, eave: 2, fence: 0, risers: 1, linearFt: expect.any(Number), zones: 1, pump: true },
      },
    });
    expect(mockSign.mock.calls[0][2]).toEqual({ expiresIn: 20 * 60 });
  });

  test('a storage failure omits the section instead of failing the document', async () => {
    await put(EST);
    mockSign.mockRejectedValue(new Error('no signer'));
    expect(await mistingLayoutDocBlock(estimate())).toEqual({});
  });
});
