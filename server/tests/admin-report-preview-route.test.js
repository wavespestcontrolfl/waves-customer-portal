// GET /api/admin/report-preview/:scheduledServiceId/data — admin only, read-only.
// Auth, the loader and the shared builder are doubles: this pins the route's own
// contract (409 for a visit with a real report, preview flag threaded, customer
// view not staff view, view tracking never reached).
const mockAuth = jest.fn((req, _res, next) => { req.techRole = 'admin'; next(); });
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => mockAuth(req, res, next),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/report-preview', () => ({ loadPreviewService: jest.fn() }));
jest.mock('../routes/reports-public', () => ({
  buildServiceReportV1ResponseData: jest.fn(),
  trackServiceReportView: jest.fn(),
}));

const express = require('express');
const { loadPreviewService } = require('../services/service-report/report-preview');
const reportsPublic = require('../routes/reports-public');
const router = require('../routes/admin-report-preview');

async function get(path) {
  const app = express();
  app.use('/api/admin/report-preview', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/report-preview${path}`);
    return { status: res.status, body: await res.json(), headers: res.headers };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('admin report preview route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockImplementation((req, _res, next) => { req.techRole = 'admin'; next(); });
  });

  test('a technician is refused', async () => {
    mockAuth.mockImplementation((req, _res, next) => { req.techRole = 'technician'; next(); });
    expect((await get('/abc/data')).status).toBe(403);
    expect(loadPreviewService).not.toHaveBeenCalled();
  });

  test.each([
    ['completed', 409], ['closed', 409], ['unsupported_line', 409], ['has_report', 409], ['not_found', 404], ['invalid_id', 404],
  ])('%s -> %i, no render', async (error, status) => {
    loadPreviewService.mockResolvedValue({ error });
    expect((await get('/abc/data')).status).toBe(status);
    expect(reportsPublic.buildServiceReportV1ResponseData).not.toHaveBeenCalled();
  });

  test('renders the stand-in through the shared builder as a customer view with preview: true', async () => {
    const service = { id: null, report_view_token: null };
    loadPreviewService.mockResolvedValue({ service });
    reportsPublic.buildServiceReportV1ResponseData.mockResolvedValue({ serviceLine: 'lawn', token: null });
    const res = await get('/abc/data');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ serviceLine: 'lawn', preview: true, glassDefault: true });
    const [passedService, token, opts] = reportsPublic.buildServiceReportV1ResponseData.mock.calls[0];
    expect(passedService).toBe(service);
    expect(token).toBeNull();
    expect(opts).toMatchObject({ mode: 'live', preview: true, staffViewer: false, planSummary: false });
    expect(reportsPublic.trackServiceReportView).not.toHaveBeenCalled();
  });
});
