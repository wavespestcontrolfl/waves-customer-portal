process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({
  auditPestPressureConfigChange: jest.fn().mockResolvedValue(undefined),
  ipFromReq: jest.fn(() => '127.0.0.1'),
  uaFromReq: jest.fn(() => 'jest'),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  updateActiveConfig: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin', email: 'owner@example.com', name: 'Owner' },
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
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { loadActiveConfig, updateActiveConfig } = require('../services/pest-pressure/store');
const auditLog = require('../services/audit-log');
const pestPressureRouter = require('../routes/admin-pest-pressure');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/pest-pressure', pestPressureRouter);
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

beforeEach(() => {
  jest.clearAllMocks();
  loadActiveConfig.mockResolvedValue({ ...DEFAULT_CONFIG, id: 'cfg-1', _source: 'db' });
  updateActiveConfig.mockImplementation(async (_db, { config }) => ({
    id: 'cfg-1', ...config,
  }));
});

describe('admin pest-pressure: auth gating', () => {
  test('GET /config requires authentication', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`);
      expect(res.status).toBe(401);
    });
  });

  test('GET /config rejects technicians (admin-only)', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`, {
        headers: { Authorization: 'Bearer tech' },
      });
      expect(res.status).toBe(403);
    });
  });

  test('GET /config returns config + defaults for admin', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.enabled).toBe(true);
      expect(body.defaults).toEqual(DEFAULT_CONFIG);
      expect(body.editableFields).toContain('weights');
    });
  });
});

describe('admin pest-pressure: PUT /config validation', () => {
  test('rejects weights that do not sum to 100', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights: { client: 10, technician: 30, reService: 20, recurring: 15, risk: 10 } }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe('invalid_config');
      expect(body.errors.some((e) => e.field === 'weights')).toBe(true);
      expect(updateActiveConfig).not.toHaveBeenCalled();
      expect(auditLog.auditPestPressureConfigChange).not.toHaveBeenCalled();
    });
  });

  test('rejects overlapping label ranges', async () => {
    await withServer(async (baseUrl) => {
      const badLabels = DEFAULT_CONFIG.labels.map((l, i) => (i === 1 ? { ...l, min: 0.5 } : l));
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: badLabels }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.errors.some((e) => e.message.includes('overlap'))).toBe(true);
    });
  });

  test('writes config + audit row on success', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.enabled).toBe(false);
      expect(body.changedFields).toContain('enabled');

      expect(updateActiveConfig).toHaveBeenCalledTimes(1);
      const [, payload] = updateActiveConfig.mock.calls[0];
      expect(payload.config.enabled).toBe(false);
      expect(payload.updatedBy).toBe('admin-1');

      expect(auditLog.auditPestPressureConfigChange).toHaveBeenCalledTimes(1);
      const [auditArgs] = auditLog.auditPestPressureConfigChange.mock.calls[0];
      expect(auditArgs.changed_fields).toContain('enabled');
      expect(auditArgs.tech_user_id).toBe('admin-1');
      expect(auditArgs.before.enabled).toBe(true);
      expect(auditArgs.after.enabled).toBe(false);
    });
  });

  test('skips audit when nothing actually changed', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/config`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.changedFields).toEqual([]);
      expect(auditLog.auditPestPressureConfigChange).not.toHaveBeenCalled();
    });
  });
});

describe('admin pest-pressure: POST /preview', () => {
  test('returns engine result for valid inputs', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: {
            clientRating: 2,
            technicianRating: 3,
            reServiceImpact: 1,
            recurringIssueRating: 0,
            riskFactorRating: 1,
            previousScore: 1.0,
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.score).toBeGreaterThan(0);
      expect(body.result.label).toBeTruthy();
      expect(body.result.trend).toBeTruthy();
      expect(body.configUsed.calculationVersion).toBe('1.0');
    });
  });

  test('rejects out-of-range rating with 400', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: { clientRating: 7 } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_input');
    });
  });

  test('rejects preview with overlaid invalid config', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: { clientRating: 2 },
          config: { weights: { client: 10, technician: 10, reService: 10, recurring: 10, risk: 10 } },
        }),
      });
      expect(res.status).toBe(422);
    });
  });
});
