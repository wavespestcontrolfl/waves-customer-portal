process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Fake knex: db('kpi_targets') returns a builder whose select() resolves to
// primed rows and whose insert/onConflict/merge chain records mockUpserts.
let mockPrimedRows = [];
const mockUpserts = [];
jest.mock('../models/db', () => {
  const builder = () => ({
    select: () => Promise.resolve(mockPrimedRows),
    insert: (row) => ({
      onConflict: () => ({
        merge: () => {
          mockUpserts.push(row);
          return Promise.resolve(1);
        },
      }),
    }),
  });
  return jest.fn(() => builder());
});
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
const kpiTargetsRouter = require('../routes/admin-kpi-targets');
const { SNAPSHOT_METRICS } = require('../services/kpi-snapshot');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/kpi-targets', kpiTargetsRouter);
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

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('admin kpi-targets route', () => {
  beforeEach(() => {
    mockPrimedRows = [];
    mockUpserts.length = 0;
  });

  test('GET returns camelCased rows with numeric coercion', async () => {
    mockPrimedRows = [{
      metric: 'completion_rate',
      target: '85.0000',
      amber_band_pct: '10.00',
      lower_is_better: false,
      updated_by: null,
      updated_at: '2026-07-02T00:00:00Z',
    }];
    await withServer(async (base) => {
      const r = await fetch(`${base}/admin/kpi-targets`, { headers: auth('admin') });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.targets).toEqual([expect.objectContaining({
        metric: 'completion_rate',
        target: 85,
        amberBandPct: 10,
        lowerIsBetter: false,
      })]);
    });
  });

  test('PUT upserts valid rows and stamps updated_by from the admin', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/admin/kpi-targets`, {
        method: 'PUT',
        headers: { ...auth('admin'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [
          { metric: 'ar_days', target: 25, lowerIsBetter: true },
          { metric: 'gross_margin', target: 45, amberBandPct: 5 },
        ] }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ updated: 2 });
      expect(mockUpserts).toHaveLength(2);
      expect(mockUpserts[0]).toMatchObject({
        metric: 'ar_days', target: 25, lower_is_better: true, updated_by: 'Owner',
      });
      expect(mockUpserts[1]).toMatchObject({
        metric: 'gross_margin', target: 45, amber_band_pct: 5, lower_is_better: false,
      });
    });
  });

  test('PUT rejects unknown metrics, bad targets, and out-of-range amber bands atomically', async () => {
    await withServer(async (base) => {
      const put = (targets) => fetch(`${base}/admin/kpi-targets`, {
        method: 'PUT',
        headers: { ...auth('admin'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets }),
      });

      expect((await put([{ metric: 'not_a_metric', target: 5 }])).status).toBe(400);
      expect((await put([{ metric: 'ar_days', target: 'soon' }])).status).toBe(400);
      expect((await put([{ metric: 'ar_days', target: 30, amberBandPct: 150 }])).status).toBe(400);
      // A bad row anywhere in the batch blocks the whole batch.
      expect((await put([
        { metric: 'ar_days', target: 30 },
        { metric: 'nope', target: 1 },
      ])).status).toBe(400);
      expect((await put([])).status).toBe(400);
      expect(mockUpserts).toHaveLength(0);
    });
  });

  test('PUT is admin-only; GET allows any authenticated admin-portal user', async () => {
    await withServer(async (base) => {
      const asTech = await fetch(`${base}/admin/kpi-targets`, {
        method: 'PUT',
        headers: { ...auth('tech'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [{ metric: 'ar_days', target: 30 }] }),
      });
      expect(asTech.status).toBe(403);

      const read = await fetch(`${base}/admin/kpi-targets`, { headers: auth('tech') });
      expect(read.status).toBe(200);

      const anon = await fetch(`${base}/admin/kpi-targets`);
      expect(anon.status).toBe(401);
    });
  });

  test('every seeded/validated key is a real SNAPSHOT_METRICS key', () => {
    const keys = new Set(SNAPSHOT_METRICS.map(([k]) => k));
    for (const k of ['completion_rate', 'callback_rate', 'lead_conversion', 'response_speed_min',
      'gross_margin', 'revenue_per_man_hour', 'retention_pct', 'csat_avg', 'collection_rate', 'ar_days']) {
      expect(keys.has(k)).toBe(true);
    }
  });
});
