/**
 * PATCH / DELETE /api/tech/services/:id/photos/:photoId — the tech sheet's
 * notes box changes a staged photo's description or removes the photo before
 * the visit is completed (GATE_NOTE_BOX_PHOTOS, owner "ok go" 2026-10-02 on
 * the Fast Complete mockup v8).
 *
 * Invariants: dark gate answers 404; same ownership rule as the photo
 * routes (the visit's technician or an admin); the visit row is locked before
 * the photo, the same lock completion holds while it promotes the staged
 * photos, and a visit with a completion record changes nothing (409
 * visit_completed); a removed photo's file is deleted only after its row is.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const VISIT = '11111111-1111-4111-8111-111111111111';
const OTHER_VISIT = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const OTHER_PHOTO = '44444444-4444-4444-8444-444444444444';

const tables = {};
const locks = [];

function matches(row, where) {
  return !where || Object.entries(where).every(([k, v]) => row[k] === v);
}

function mockChain(table) {
  const state = { where: null };
  const rows = () => (tables[table] || []).filter((r) => matches(r, state.where));
  const c = {
    where: jest.fn((w) => { state.where = w; return c; }),
    orderBy: jest.fn(() => c),
    forUpdate: jest.fn(() => { locks.push(table); return c; }),
    first: jest.fn(async () => rows()[0] || null),
    update: jest.fn((patch) => ({
      returning: jest.fn(async () => rows().map((r) => Object.assign(r, patch))),
    })),
    del: jest.fn(async () => {
      const keep = (tables[table] || []).filter((r) => !matches(r, state.where));
      const removed = (tables[table] || []).length - keep.length;
      tables[table] = keep;
      return removed;
    }),
  };
  return c;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockChain(table));
  db.transaction = jest.fn(async (handler) => handler(db));
  return db;
});
const mockS3Send = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(command) { return mockS3Send(command); } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; this.kind = 'delete'; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand };
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ enqueuePdfRenderJob: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ createAlertOnce: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
      other: { id: 'tech-2', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const router = require('../routes/tech-track');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const call = (baseUrl, method, { token = 'tech', visit = VISIT, photo = PHOTO, body } = {}) => fetch(
  `${baseUrl}/api/tech/services/${visit}/photos/${photo}`,
  {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  },
);
const stagedPhoto = () => tables.scheduled_service_photo_staging.find((p) => p.id === PHOTO);
const deletedKeys = () => mockS3Send.mock.calls.map(([command]) => command).filter((command) => command.kind === 'delete').map((command) => command.input.Key);

describe('changing a staged photo from the notes box', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    locks.length = 0;
    process.env.GATE_NOTE_BOX_PHOTOS = 'true';
    tables.scheduled_services = [
      { id: VISIT, technician_id: 'tech-1' },
      { id: OTHER_VISIT, technician_id: 'tech-1' },
    ];
    tables.service_records = [];
    tables.scheduled_service_photo_staging = [
      { id: PHOTO, scheduled_service_id: VISIT, s3_key: 'staged/visit/porch.jpg', caption: 'Ants at the porch' },
      { id: OTHER_PHOTO, scheduled_service_id: OTHER_VISIT, s3_key: 'staged/other/sink.jpg', caption: null },
    ];
  });
  afterAll(() => { delete process.env.GATE_NOTE_BOX_PHOTOS; });

  test('dark: both routes answer 404 and change nothing', async () => {
    delete process.env.GATE_NOTE_BOX_PHOTOS;
    await withServer(async (baseUrl) => {
      const patch = await call(baseUrl, 'PATCH', { body: { caption: 'New words' } });
      expect(patch.status).toBe(404);
      expect(await patch.json()).toEqual({ enabled: false });
      expect((await call(baseUrl, 'DELETE')).status).toBe(404);
    });
    expect(stagedPhoto().caption).toBe('Ants at the porch');
    expect(deletedKeys()).toEqual([]);
  });

  test('the visit\'s technician changes the description, under the visit lock first', async () => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PATCH', { body: { caption: '  Droppings under the sink  ' } });
      expect(res.status).toBe(200);
      expect((await res.json()).photo).toMatchObject({ id: PHOTO, caption: 'Droppings under the sink', staged: true });
    });
    expect(stagedPhoto().caption).toBe('Droppings under the sink');
    expect(locks).toEqual(['scheduled_services', 'scheduled_service_photo_staging']);
  });

  test('an empty description clears it; wording we cannot put on a report is refused', async () => {
    await withServer(async (baseUrl) => {
      expect((await call(baseUrl, 'PATCH', { body: { caption: '' } })).status).toBe(200);
      expect(stagedPhoto().caption).toBeNull();
      const banned = await call(baseUrl, 'PATCH', { body: { caption: 'Pests eliminated from the home' } });
      expect(banned.status).toBe(422);
      expect((await banned.json()).code).toBe('photo_caption_banned_copy');
    });
    expect(stagedPhoto().caption).toBeNull();
  });

  test('another technician is refused; an admin is allowed', async () => {
    await withServer(async (baseUrl) => {
      const refused = await call(baseUrl, 'PATCH', { token: 'other', body: { caption: 'Theirs' } });
      expect(refused.status).toBe(403);
      expect((await refused.json()).code).toBe('not_assigned');
      expect((await call(baseUrl, 'DELETE', { token: 'other' })).status).toBe(403);
      expect((await call(baseUrl, 'PATCH', { token: 'admin', body: { caption: 'Office words' } })).status).toBe(200);
    });
    expect(stagedPhoto().caption).toBe('Office words');
  });

  test('a completed visit changes nothing: its photos are on the record', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: VISIT }];
    await withServer(async (baseUrl) => {
      const patch = await call(baseUrl, 'PATCH', { body: { caption: 'Too late' } });
      expect(patch.status).toBe(409);
      expect((await patch.json()).code).toBe('visit_completed');
      expect((await call(baseUrl, 'DELETE')).status).toBe(409);
    });
    expect(stagedPhoto().caption).toBe('Ants at the porch');
    expect(deletedKeys()).toEqual([]);
  });

  test('a photo of another visit, or an id that is not one, is not found', async () => {
    await withServer(async (baseUrl) => {
      const other = await call(baseUrl, 'DELETE', { photo: OTHER_PHOTO });
      expect(other.status).toBe(404);
      expect((await other.json()).code).toBe('photo_not_found');
      expect((await call(baseUrl, 'PATCH', { photo: 'not-a-photo', body: { caption: 'x' } })).status).toBe(404);
    });
    expect(tables.scheduled_service_photo_staging).toHaveLength(2);
  });

  test('removing a photo deletes its row, then its file', async () => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'DELETE');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: PHOTO });
    });
    expect(stagedPhoto()).toBeUndefined();
    expect(tables.scheduled_service_photo_staging.map((p) => p.id)).toEqual([OTHER_PHOTO]);
    expect(deletedKeys()).toEqual(['staged/visit/porch.jpg']);
    expect(locks).toEqual(['scheduled_services', 'scheduled_service_photo_staging']);
  });
});
