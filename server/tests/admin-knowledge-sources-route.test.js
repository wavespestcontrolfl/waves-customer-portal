// POST /admin/knowledge/sources — admin-only, path + type confined.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/knowledge/wiki-qa', () => ({}));
jest.mock('../services/knowledge/wiki-linter', () => ({}));
jest.mock('../config/models', () => ({}));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));

const requireAdmin = jest.fn((req, res, next) => (req.headers['x-role'] === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 't1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (...a) => requireAdmin(...a),
}));

const express = require('express');
const path = require('path');
const db = require('../models/db');
const router = require('../routes/admin-knowledge');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/knowledge', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

const post = (base, body, role = 'admin') => fetch(`${base}/admin/knowledge/sources`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-role': role }, body: JSON.stringify(body),
});

describe('POST /admin/knowledge/sources', () => {
  let inserted;
  beforeEach(() => {
    inserted = [];
    db.mockImplementation(() => ({
      insert: jest.fn((row) => { inserted.push(row); return { returning: async () => [{ id: 's1', ...row }] }; }),
    }));
  });

  test('technician role is refused', async () => {
    await withServer(async (base) => {
      const res = await post(base, { file_path: 'a.md', file_type: 'md' }, 'technician');
      expect(res.status).toBe(403);
    });
    expect(inserted).toHaveLength(0);
  });

  test('rejects a path outside wiki/ with 400 and inserts nothing', async () => {
    await withServer(async (base) => {
      const res = await post(base, { filename: 'env', file_path: '/proc/self/environ', file_type: 'txt' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/wiki\/ folder/);
    });
    expect(inserted).toHaveLength(0);
  });

  test('rejects an unsupported file_type with 400', async () => {
    await withServer(async (base) => {
      const res = await post(base, { file_path: 'a.pem', file_type: 'pem' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/file_type/);
    });
    expect(inserted).toHaveLength(0);
  });

  test('stores a confined absolute path for a relative wiki/ input', async () => {
    await withServer(async (base) => {
      const res = await post(base, { file_path: 'protocols/termite.md', file_type: 'MD' });
      expect(res.status).toBe(200);
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].file_path).toBe(path.resolve(__dirname, '../../wiki/protocols/termite.md'));
    expect(inserted[0].file_type).toBe('md');
    expect(inserted[0].filename).toBe('termite.md');
  });
});
