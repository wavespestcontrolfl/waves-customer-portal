// Staff documents: archived list + restore (daily-work audit 2026-11-06).
// GET /documents?archived=only lists the archived documents; POST
// /documents/:id/restore clears only the archive flag, so the stored file and
// the metadata stay as they were. Mirrors the mock style of
// admin-timetracking-start-point.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => undefined) }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { recordAuditEvent } = require('../services/audit-log');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const router = require('../routes/admin-timetracking');

const DOC_ID = '11111111-2222-4333-8444-555555555555';
const ARCHIVED = {
  id: DOC_ID, title: 'Synthetic policy', category: 'policy', s3_key: 'company-documents/1-synthetic.pdf',
  file_name: 'synthetic.pdf', technician_id: null, expiration_date: null, is_archived: true,
};

function routeHandler(method, routePath) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function invoke(method, routePath, req) {
  const res = response();
  let error;
  await routeHandler(method, routePath)({ params: {}, query: {}, body: {}, ...req }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

// A knex-like chain: every builder method records its arguments and returns
// the chain; awaiting it (or calling first/returning) yields the given rows.
function chain({ rows = [], first } = {}) {
  const c = { calls: [] };
  for (const m of ['leftJoin', 'where', 'whereNull', 'select', 'orderBy', 'update']) {
    c[m] = jest.fn((...args) => { c.calls.push([m, ...args]); return c; });
  }
  c.returning = jest.fn(async () => rows);
  c.first = jest.fn(async () => first);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.schema = { hasTable: jest.fn(async () => true) };
});

describe('GET /documents', () => {
  test('lists active documents by default', async () => {
    const list = chain({ rows: [{ id: 'a' }] });
    db.mockReturnValueOnce(list);
    const res = await invoke('get', '/documents', { query: { category: 'all' } });
    expect(res.body).toEqual({ documents: [{ id: 'a' }] });
    expect(list.where).toHaveBeenCalledWith('company_documents.is_archived', false);
  });

  test('archived=only lists the archived documents instead', async () => {
    const list = chain({ rows: [ARCHIVED] });
    db.mockReturnValueOnce(list);
    const res = await invoke('get', '/documents', { query: { category: 'all', archived: 'only' } });
    expect(res.body).toEqual({ documents: [ARCHIVED] });
    expect(list.where).toHaveBeenCalledWith('company_documents.is_archived', true);
    expect(list.where).not.toHaveBeenCalledWith('company_documents.is_archived', false);
  });
});

describe('POST /documents/:id/restore', () => {
  test('clears only the archive flag and returns the row', async () => {
    const restored = { ...ARCHIVED, is_archived: false };
    const write = chain({ rows: [restored] });
    db.mockReturnValueOnce(write);
    const res = await invoke('post', '/documents/:id/restore', { params: { id: DOC_ID } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(restored);
    expect(write.where).toHaveBeenCalledWith({ id: DOC_ID, is_archived: true });
    expect(write.update).toHaveBeenCalledTimes(1);
    const [patch] = write.update.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual(['is_archived', 'updated_at']);
    expect(patch.is_archived).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(`[docs] Restored document: ${DOC_ID}`);
  });

  test('a document that is not archived comes back unchanged', async () => {
    const active = { ...ARCHIVED, is_archived: false };
    db.mockReturnValueOnce(chain({ rows: [] })).mockReturnValueOnce(chain({ first: active }));
    const res = await invoke('post', '/documents/:id/restore', { params: { id: DOC_ID } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(active);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('an unknown document is a 404', async () => {
    db.mockReturnValueOnce(chain({ rows: [] })).mockReturnValueOnce(chain({ first: undefined }));
    const res = await invoke('post', '/documents/:id/restore', { params: { id: DOC_ID } });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Document not found' });
  });
});

describe('GET /documents/:id/download', () => {
  test('returns presigned URL and writes an audit row with structural metadata only', async () => {
    const active = { ...ARCHIVED, is_archived: false, file_name: 'Jane_Doe_W4.pdf', technician_id: 'tech-1' };
    db.mockReturnValueOnce(chain({ first: active }));
    getSignedUrl.mockResolvedValueOnce('https://s3.example.test/signed');

    const res = await invoke('get', '/documents/:id/download', {
      params: { id: DOC_ID },
      technicianId: 'admin-1',
      ip: '203.0.113.9',
      get: (h) => (h.toLowerCase() === 'user-agent' ? 'WavesTest/1.0' : undefined),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ url: 'https://s3.example.test/signed', fileName: 'Jane_Doe_W4.pdf' });
    expect(recordAuditEvent).toHaveBeenCalledWith({
      actor_type: 'admin',
      actor_id: 'admin-1',
      action: 'hr_document.download_url_issued',
      resource_type: 'company_document',
      resource_id: DOC_ID,
      ip_address: '203.0.113.9',
      user_agent: 'WavesTest/1.0',
      metadata: {
        category: 'policy',
        technician_id: 'tech-1',
      },
      critical: true,
    });
  });

  test('fails the request and does not return a presigned URL if the audit write fails', async () => {
    const active = { ...ARCHIVED, is_archived: false, file_name: 'Jane_Doe_W4.pdf', technician_id: 'tech-1' };
    db.mockReturnValueOnce(chain({ first: active }));
    getSignedUrl.mockResolvedValueOnce('https://s3.example.test/signed');
    recordAuditEvent.mockRejectedValueOnce(new Error('audit_log write failed'));

    await expect(invoke('get', '/documents/:id/download', {
      params: { id: DOC_ID },
      technicianId: 'admin-1',
      ip: '203.0.113.9',
      get: () => undefined,
    })).rejects.toThrow('audit_log write failed');
  });
});
