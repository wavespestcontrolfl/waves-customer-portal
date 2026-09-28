process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/seo/url-intelligence', () => ({
  getDashboard: jest.fn(),
}));
jest.mock('../services/seo/seo-pipeline-dispatcher', () => ({
  dispatchSeoPipeline: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      // The default IB_FULL_ACCESS_EMAILS allow-list (ib-access.js) is
      // real/unmocked here, so this admin's email must be the owner
      // account for the "owner reaches the service" assertion to hold.
      admin: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com', name: 'Owner' },
      // A second, non-owner admin — same role, ordinary admin login — for
      // the owner-only pipeline guard (owner ruling 2026-09-28).
      admin2: { id: 'admin-2', role: 'admin', email: 'other-admin@example.com', name: 'Other Admin' },
      tech: { id: 'tech-1', role: 'technician', email: 'tech@example.com', name: 'Tech' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const UrlIntelligence = require('../services/seo/url-intelligence');
const { dispatchSeoPipeline } = require('../services/seo/seo-pipeline-dispatcher');
const seoUrlIntelligenceRouter = require('../routes/admin-seo-url-intelligence');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/seo/url-intelligence', seoUrlIntelligenceRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('admin seo url-intelligence routes — owner-only pipeline guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('non-owner admin gets 403 on run-pipeline and the dispatcher is never called', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/seo/url-intelligence/run-pipeline`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'wavespestcontrol.com' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('This action is limited to the owner account.');
      expect(dispatchSeoPipeline).not.toHaveBeenCalled();
    });
  });

  test('owner admin reaches the pipeline dispatcher', async () => {
    dispatchSeoPipeline.mockResolvedValue({
      statusCode: 200,
      payload: { status: 'completed', domain: 'wavespestcontrol.com' },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/seo/url-intelligence/run-pipeline`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'wavespestcontrol.com' }),
      });
      expect(res.status).toBe(200);
      expect(dispatchSeoPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'wavespestcontrol.com', requestedBy: 'admin-1' }),
      );
    });
  });

  test('a read route on the same router stays open to a non-owner admin', async () => {
    UrlIntelligence.getDashboard.mockResolvedValue({ total_urls: 42 });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/seo/url-intelligence/dashboard?domain=wavespestcontrol.com`, {
        headers: { Authorization: 'Bearer admin2' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ total_urls: 42 });
    });
  });
});
