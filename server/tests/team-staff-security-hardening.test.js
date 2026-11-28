/**
 * Commit 1 security, privacy, RBAC, S3 upload, Google-only lockout, and
 * technician sign-off regression tests for Team > Staff.
 * Uses in-process Express dispatch (no TCP socket required) so all tests run
 * deterministically inside the sandbox.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({
  getEntries: jest.fn(),
  getDailySummaries: jest.fn(),
  getWeeklySummaries: jest.fn(),
  startJob: jest.fn(),
  adminEditEntry: jest.fn(),
}));
jest.mock('../services/timesheet-approval', () => ({
  getWeekDetail: jest.fn(),
  signWeek: jest.fn(),
}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (k, f) => (k ? `https://signed/${k}` : f)) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers['x-test-auth']) return res.status(401).json({ error: 'Unauthorized' });
    req.techRole = req.headers['x-test-role'] || 'admin';
    req.technicianId = req.headers['x-test-id'] || '11111111-1111-4111-8111-111111111111';
    req.technician = {
      id: req.technicianId,
      role: req.techRole,
      email: req.headers['x-test-email'] ?? 'contact@wavespestcontrol.com',
    };
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin required' })),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn(async () => ({})) })),
  PutObjectCommand: jest.fn((args) => ({ _type: 'PutObjectCommand', ...args })),
  GetObjectCommand: jest.fn((args) => ({ _type: 'GetObjectCommand', ...args })),
  DeleteObjectCommand: jest.fn((args) => ({ _type: 'DeleteObjectCommand', ...args })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://s3.test/presigned'),
}));

const { EventEmitter } = require('events');
const db = require('../models/db');
const timesheetApproval = require('../services/timesheet-approval');
const timeTracking = require('../services/time-tracking');
const googleSignin = require('../services/staff-google-signin');
const {
  validateStaffPhotoUpload,
  validateCompanyDocumentUpload,
  safeDownloadFilename,
} = require('../utils/staff-upload-validation');
const adminPayrollRouter = require('../routes/admin-payroll');
const techDocsRouter = require('../routes/tech-staff-documents');
const techTimeRouter = require('../routes/tech-timetracking');
const adminTimeRouter = require('../routes/admin-timetracking');
const scope = require('../middleware/technician-scope');

function dispatchRouter(router, { method = 'GET', url = '/', headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), {
      method: method.toUpperCase(),
      url,
      originalUrl: url,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      body,
      query: {},
      params: {},
      ip: '127.0.0.1',
      get(h) { return this.headers[h.toLowerCase()]; },
    });
    const resHeaders = {};
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      body: undefined,
      headersSent: false,
      set(k, v) { resHeaders[String(k).toLowerCase()] = v; return this; },
      setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; return this; },
      getHeader(k) { return resHeaders[String(k).toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      type(ct) { resHeaders['content-type'] = ct; return this; },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload, headers: resHeaders });
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload, headers: resHeaders });
        return this;
      },
      end() {
        if (!this.headersSent) {
          this.headersSent = true;
          resolve({ status: this.statusCode, body: this.body, headers: resHeaders });
        }
        return this;
      },
    });
    router.handle(req, res, (err) => {
      if (err) reject(err);
      else if (!res.headersSent) resolve({ status: 404, body: { error: 'Not found' }, headers: resHeaders });
    });
  });
}

describe('staff-upload-validation (S3 stored-XSS & magic-byte defense)', () => {
  test('photo validation accepts real JPEG/PNG/WebP/HEIC magic bytes and rejects HTML/SVG/spoofed MIME', () => {
    const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(16)]);
    expect(validateStaffPhotoUpload({ originalname: 'avatar.jpeg', mimetype: 'application/octet-stream', buffer: jpeg }))
      .toEqual({ ext: 'jpg', contentType: 'image/jpeg' });

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
    expect(validateStaffPhotoUpload({ originalname: 'pic.png', mimetype: 'image/png', buffer: png }))
      .toEqual({ ext: 'png', contentType: 'image/png' });

    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect(validateStaffPhotoUpload({ originalname: 'evil.html', mimetype: 'text/html', buffer: html }).error).toMatch(/JPEG/);
    expect(validateStaffPhotoUpload({ originalname: 'evil.jpg', mimetype: 'image/jpeg', buffer: html }).error).toMatch(/JPEG/);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(validateStaffPhotoUpload({ originalname: 'evil.svg', mimetype: 'image/svg+xml', buffer: svg }).error).toMatch(/JPEG/);
  });

  test('company document validation accepts PDF/DOCX/CSV and rejects HTML/SVG/JS/spoofed PDFs', () => {
    expect(validateCompanyDocumentUpload({ originalname: 'w4.pdf', buffer: Buffer.from('%PDF-1.7\n...') }))
      .toEqual({ ext: 'pdf', contentType: 'application/pdf' });
    expect(validateCompanyDocumentUpload({ originalname: 'sheet.csv', buffer: Buffer.from('name,hours\nAlex,40\n') }))
      .toEqual({ ext: 'csv', contentType: 'text/csv; charset=utf-8' });
    expect(validateCompanyDocumentUpload({ originalname: 'evil.html', buffer: Buffer.from('<html><script>x</script></html>') }).error)
      .toMatch(/Unsupported/);
    expect(validateCompanyDocumentUpload({ originalname: 'spoof.pdf', buffer: Buffer.from('<html>not a pdf</html>') }).error)
      .toMatch(/do not match/);
    expect(validateCompanyDocumentUpload({ originalname: 'sneaky.txt', buffer: Buffer.from('<!DOCTYPE html><script>alert(1)</script>') }).error)
      .toMatch(/do not match/);
    expect(safeDownloadFilename('bad"\r\nname.pdf')).toBe('bad___name.pdf');
  });
});

describe('owner-only RBAC on payroll and controlled staff documents', () => {
  const ENV_KEYS = ['GATE_PAYROLL', 'GATE_PAYROLL_TIME_OFF', 'GATE_PAYROLL_PAY_LINES', 'GATE_PAYROLL_MERCURY_STATUS', 'GATE_PAYROLL_MERCURY_PAY', 'GATE_CONTROLLED_STAFF_DOCUMENTS'];
  const OLD_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const TECH_ID = '22222222-2222-4222-8222-222222222222';
  const NON_OWNER = { 'x-test-auth': '1', 'x-test-role': 'admin', 'x-test-email': 'office-manager@wavespestcontrol.com' };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) process.env[k] = 'true';
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (OLD_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = OLD_ENV[k];
    }
  });

  test.each([
    [adminPayrollRouter, 'POST', '/runs', { weekStart: '2026-11-16' }],
    [adminPayrollRouter, 'POST', `/runs/${TECH_ID}/finalize`, { token: 'abc' }],
    [adminPayrollRouter, 'POST', `/runs/${TECH_ID}/send`, {}],
    [adminPayrollRouter, 'POST', `/technicians/${TECH_ID}/w4`, {}],
    [adminPayrollRouter, 'POST', '/pay-lines', {}],
    [adminPayrollRouter, 'POST', '/time-off', {}],
    [adminPayrollRouter, 'PUT', `/technicians/${TECH_ID}/pay-method`, {}],
    [techDocsRouter, 'POST', '/policy-values', {}],
    [techDocsRouter, 'POST', `/${TECH_ID}/issue`, {}],
  ])('non-owner admin is refused 403 on %s %s', async (_router, method, url, body) => {
    const res = await dispatchRouter(_router, { method, url, headers: NON_OWNER, body });
    expect(res.status).toBe(403);
  });

  test('malformed UUID on /api/admin/timetracking/:id routes returns 400 instead of 500', async () => {
    const OWNER = { ...NON_OWNER, 'x-test-email': 'contact@wavespestcontrol.com' };
    const res = await dispatchRouter(adminTimeRouter, { method: 'GET', url: '/entries/not-a-uuid', headers: OWNER });
    expect(res.status).toBe(400);
    const res2 = await dispatchRouter(adminTimeRouter, { method: 'GET', url: '/documents/not-a-uuid/download', headers: OWNER });
    expect(res2.status).toBe(400);
  });
});

describe('technician-scope narrows /api/admin/timetracking allowlist', () => {
  test('only dashboard, roster, and photo upload match for technicians', () => {
    expect(scope.technicianMayReach('GET', '/api/admin/timetracking')).toBe(true);
    expect(scope.technicianMayReach('GET', '/api/admin/timetracking/technicians')).toBe(true);
    expect(scope.technicianMayReach('POST', '/api/admin/timetracking/technicians/11111111-1111-4111-8111-111111111111/photo')).toBe(true);
    expect(scope.technicianMayReach('GET', '/api/admin/timetracking/entries')).toBe(false);
    expect(scope.technicianMayReach('GET', '/api/admin/timetracking/documents')).toBe(false);
    expect(scope.technicianMayReach('GET', '/api/admin/timetracking/analytics')).toBe(false);
    expect(scope.technicianMayReach('PUT', '/api/admin/timetracking/technicians/11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});

describe('Google-only lockout trap fixed when clearing googleEmail', () => {
  test('putTechnicianGoogleSignin clears google_only_login_at when googleEmail is cleared', async () => {
    const gateSpy = jest.spyOn(googleSignin, 'staffGoogleSigninLive').mockReturnValue(true);
    const target = { id: 'tech-1', email: 'tech@wavespestcontrol.com', google_email: 'tech@wavespestcontrol.com', google_only_login_at: new Date(), auth_token_version: 2 };
    const updatedRow = { ...target, google_email: null, google_only_login_at: null, auth_token_version: 3 };
    const updateSpy = jest.fn(() => Promise.resolve(1));
    let callIdx = 0;
    const trx = jest.fn(() => {
      callIdx += 1;
      const chain = {
        where: jest.fn(() => chain),
        forUpdate: jest.fn(() => chain),
        first: jest.fn(async () => (callIdx === 1 ? target : updatedRow)),
        update: updateSpy,
      };
      return chain;
    });
    trx.raw = jest.fn(async () => undefined);
    db.transaction = jest.fn(async (cb) => cb(trx));

    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const next = jest.fn();
    await adminTimeRouter._handlers.putTechnicianGoogleSignin(
      { params: { id: 'tech-1' }, body: { googleEmail: '' }, techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } },
      res,
      next,
    );
    gateSpy.mockRestore();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      google_email: null,
      google_sub: null,
      google_only_login_at: null,
    }));
  });
});

describe('tech-timetracking pending-signoff privacy & starvation fix', () => {
  beforeEach(() => jest.clearAllMocks());

  test('skips an older disputed week to surface a newer signable week and strips owner revenue/notes', async () => {
    db.mockImplementation((table) => {
      const chain = {
        where: jest.fn(() => chain),
        whereNull: jest.fn(() => chain),
        whereRaw: jest.fn(() => chain),
        orderBy: jest.fn(() => chain),
        select: jest.fn(async () => []),
        then: (resolve, reject) => Promise.resolve(
          table === 'time_weekly_summary'
            ? [{ week_start: '2026-11-02' }, { week_start: '2026-11-09' }]
            : [],
        ).then(resolve, reject),
      };
      return chain;
    });
    timesheetApproval.getWeekDetail
      .mockResolvedValueOnce({
        weekly: {
          week_start: '2026-11-02', status: 'pending', total_shift_minutes: '2400',
          total_revenue: '5500.00', avg_rpmh: '137.50', utilization_pct: '80', approval_notes: 'secret note',
        },
        entries: [{ approval_status: 'disputed' }],
        dailies: [{ status: 'disputed' }],
        reviewToken: 'tok-old',
      })
      .mockResolvedValueOnce({
        weekly: {
          week_start: '2026-11-09', status: 'pending', total_shift_minutes: '2400',
          total_revenue: '6200.00', avg_rpmh: '155.00', utilization_pct: '85', approval_notes: 'internal only',
        },
        entries: [{ approval_status: 'pending' }],
        dailies: [{ status: 'pending' }],
        reviewToken: 'tok-new',
      });

    const res = await dispatchRouter(techTimeRouter, {
      method: 'GET',
      url: '/pending-signoff',
      headers: { 'x-test-auth': '1', 'x-test-role': 'technician' },
    });
    expect(res.status).toBe(200);
    expect(res.body.weekStart).toBe('2026-11-09');
    expect(res.body.pending).toBe(true);
    expect(res.body.weekly.total_revenue).toBeUndefined();
    expect(res.body.weekly.avg_rpmh).toBeUndefined();
    expect(res.body.weekly.utilization_pct).toBeUndefined();
    expect(res.body.weekly.approval_notes).toBeUndefined();
  });

  test('start-job returns 409 for job_already_completed instead of 500', async () => {
    timeTracking.startJob.mockRejectedValueOnce(
      Object.assign(new Error('This visit is already completed.'), { status: 409, statusCode: 409, code: 'job_already_completed' }),
    );
    const res = await dispatchRouter(techTimeRouter, {
      method: 'POST',
      url: '/start-job/33333333-3333-4333-8333-333333333333',
      headers: { 'x-test-auth': '1', 'x-test-role': 'technician' },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'job_already_completed' });
  });
});
