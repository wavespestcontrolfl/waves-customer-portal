// saveLayout / getLayoutForEstimate against a real PostgreSQL (disposable schema; skipped without
// APP_TEST_DATABASE_URL, run for real in CI): the jsonb writes, the upsert on estimate_id, and the read back.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: { bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } }));
const mockS3Send = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (...a) => mockS3Send(...a) })),
  PutObjectCommand: jest.fn((input) => ({ type: 'put', input })),
  DeleteObjectCommand: jest.fn((input) => ({ type: 'delete', input })),
  GetObjectCommand: jest.fn((input) => ({ type: 'get', input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/x.png') }));

const migration = require('../models/migrations/20261026130000_misting_layouts');
const { saveLayout, getLayoutForEstimate } = require('../services/misting-layouts');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `misting_svc_${randomUUID().replaceAll('-', '')}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 2)]);

const payload = (over = {}) => ({
  address: '500 Example Court',
  center: { lat: 26.95, lng: -82.4 },
  zoom: 20,
  mapWidth: 1280,
  mapHeight: 960,
  lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] }],
  nozzles: [{ x: 100, y: 200, kind: 'eave', lineIndex: 0 }, { x: 400, y: 200, kind: 'fence', lineIndex: 0 }],
  risers: [{ x: 50, y: 60 }],
  pump: { x: 70, y: 80 },
  zones: [{ kind: 'ac', x: 300, y: 300, radiusFt: 8 }],
  ...over,
});

postgres('misting layout service (PostgreSQL)', () => {
  let admin;
  let app;
  const estimateId = randomUUID();
  const actor = randomUUID();

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await app.schema.createTable('estimates', (t) => { t.uuid('id').primary(); });
    await app('estimates').insert({ id: estimateId });
    await migration.up(app);
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('saves with real jsonb arrays, reads back parsed, and a re-save updates the one row', async () => {
    const first = await saveLayout({ estimateId, payload: payload(), pngBuffer: PNG, actorId: null, knex: app });
    expect(first.counts).toMatchObject({ nozzles: 2, eave: 1, fence: 1, risers: 1 });
    expect(first.nozzles).toHaveLength(2);
    expect(first.pump).toEqual({ x: 70, y: 80 });
    expect(first.zones).toEqual([{ kind: 'ac', x: 300, y: 300, radiusFt: 8 }]);
    expect(first.snapshotUrl).toBe('https://signed.example/x.png');

    const second = await saveLayout({
      estimateId, payload: payload({ nozzles: [{ x: 10, y: 10, kind: 'eave', lineIndex: 0 }], pump: null, zones: [] }), pngBuffer: PNG, actorId: actor, knex: app,
    });
    expect(second.counts.nozzles).toBe(1);
    expect(second.pump).toBeNull();
    const rows = await app('misting_layouts').where({ estimate_id: estimateId });
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_by).toBe(actor);
    expect(rows[0].created_by).toBeNull();
    expect(rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(rows[0].created_at.getTime());
    expect((await getLayoutForEstimate(estimateId, { knex: app })).counts.nozzles).toBe(1);
  });

  test('refuses an estimate that does not exist and leaves no row or object behind', async () => {
    mockS3Send.mockClear();
    await expect(saveLayout({ estimateId: randomUUID(), payload: payload(), pngBuffer: PNG, knex: app })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(await app('misting_layouts')).toHaveLength(1);
  });
});
