process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({
  auditPestPressureConfigChange: jest.fn().mockResolvedValue(undefined),
  auditPestPressureScoreOverride: jest.fn().mockResolvedValue(undefined),
  ipFromReq: jest.fn(() => '127.0.0.1'),
  uaFromReq: jest.fn(() => 'jest'),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  updateActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  applyOverride: jest.fn(),
  removeOverride: jest.fn(),
  listRecentScores: jest.fn(),
  listAuditEvents: jest.fn(),
  loadHistoryForCustomer: jest.fn(),
}));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  calculateAndPersistForServiceRecord: jest.fn(),
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
const {
  loadActiveConfig,
  updateActiveConfig,
  loadScoreForServiceRecord,
  applyOverride,
  removeOverride,
  listRecentScores,
  listAuditEvents,
  loadHistoryForCustomer,
} = require('../services/pest-pressure/store');
const { calculateAndPersistForServiceRecord } = require('../services/pest-pressure/orchestrate');
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

function makeScoreRow(overrides = {}) {
  return {
    id: 'score-1',
    customer_id: 'cust-1',
    service_record_id: 'svc-1',
    service_date: '2026-05-17',
    service_line: 'pest',
    calculated_score: 2.4,
    displayed_score: 2.4,
    label_key: 'moderate',
    label_name: 'Moderate',
    trend: 'stable',
    trend_delta: 0.0,
    data_completeness: 'complete',
    is_overridden: false,
    original_calculated_score: null,
    override_reason: null,
    overridden_by: null,
    overridden_at: null,
    calculation_version: '1.0',
    calculated_at: new Date().toISOString(),
    ...overrides,
  };
}

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

describe('admin pest-pressure: PUT /scores/:id/override', () => {
  test('rejects empty reason', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayedScore: 2.0, reason: '   ' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('reason_required');
      expect(applyOverride).not.toHaveBeenCalled();
    });
  });

  test('rejects over-long reason', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayedScore: 2.0, reason: 'x'.repeat(501) }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('reason_too_long');
    });
  });

  test('rejects when overrides disabled in config', async () => {
    loadActiveConfig.mockResolvedValueOnce({ ...DEFAULT_CONFIG, allowManualOverride: false });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayedScore: 2.0, reason: 'tech disagreement' }),
      });
      expect(res.status).toBe(403);
    });
  });

  test('out-of-range displayedScore returns 400', async () => {
    applyOverride.mockRejectedValueOnce(new RangeError('out of range'));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayedScore: 7, reason: 'test' }),
      });
      expect(res.status).toBe(400);
    });
  });

  test('happy path persists override + writes audit row', async () => {
    applyOverride.mockResolvedValueOnce(makeScoreRow({
      is_overridden: true,
      displayed_score: 1.5,
      original_calculated_score: 2.4,
      override_reason: 'Customer dispute',
      overridden_by: 'admin-1',
    }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayedScore: 1.5, reason: '  Customer dispute  ' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.score.is_overridden).toBe(true);
      expect(body.score.displayed_score).toBe(1.5);

      const [, storeArgs] = applyOverride.mock.calls[0];
      expect(storeArgs.reason).toBe('Customer dispute');
      expect(storeArgs.overriddenBy).toBe('admin-1');

      expect(auditLog.auditPestPressureScoreOverride).toHaveBeenCalledTimes(1);
      const [auditArgs] = auditLog.auditPestPressureScoreOverride.mock.calls[0];
      expect(auditArgs.action_type).toBe('set');
      expect(auditArgs.override_reason).toBe('Customer dispute');
      expect(auditArgs.original_calculated_score).toBe(2.4);
    });
  });
});

describe('admin pest-pressure: DELETE /scores/:id/override', () => {
  test('404 when no score row exists', async () => {
    loadScoreForServiceRecord.mockResolvedValueOnce(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/missing/override`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(404);
    });
  });

  test('no-op + no audit when score is not overridden', async () => {
    const existing = makeScoreRow();
    loadScoreForServiceRecord.mockResolvedValueOnce(existing);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.removed).toBe(false);
      expect(removeOverride).not.toHaveBeenCalled();
      expect(auditLog.auditPestPressureScoreOverride).not.toHaveBeenCalled();
    });
  });

  test('restores calculated score + audits', async () => {
    const existing = makeScoreRow({
      is_overridden: true,
      displayed_score: 1.5,
      original_calculated_score: 2.4,
      override_reason: 'Customer dispute',
    });
    loadScoreForServiceRecord.mockResolvedValueOnce(existing);
    removeOverride.mockResolvedValueOnce(makeScoreRow({ displayed_score: 2.4 }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/override`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.removed).toBe(true);
      expect(body.score.displayed_score).toBe(2.4);
      expect(removeOverride).toHaveBeenCalledTimes(1);

      const [auditArgs] = auditLog.auditPestPressureScoreOverride.mock.calls[0];
      expect(auditArgs.action_type).toBe('remove');
      expect(auditArgs.original_calculated_score).toBe(2.4);
    });
  });
});

describe('admin pest-pressure: POST /scores/:id/recalculate', () => {
  test('preserves override by default', async () => {
    calculateAndPersistForServiceRecord.mockResolvedValueOnce({
      result: { score: 2.6, displayedScore: 2.6 },
    });
    loadScoreForServiceRecord.mockResolvedValueOnce(makeScoreRow({ calculated_score: 2.6 }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/recalculate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(calculateAndPersistForServiceRecord).toHaveBeenCalledWith('svc-1', expect.anything());
      expect(removeOverride).not.toHaveBeenCalled();
    });
  });

  test('clearOverride=true removes existing override and audits, then recalcs', async () => {
    loadScoreForServiceRecord.mockResolvedValueOnce(makeScoreRow({
      is_overridden: true,
      displayed_score: 1.5,
      original_calculated_score: 2.4,
      override_reason: 'old reason',
    }));
    removeOverride.mockResolvedValueOnce(makeScoreRow({ displayed_score: 2.4 }));
    calculateAndPersistForServiceRecord.mockResolvedValueOnce({
      result: { score: 2.6, displayedScore: 2.6 },
    });
    loadScoreForServiceRecord.mockResolvedValueOnce(makeScoreRow({ displayed_score: 2.6 }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/recalculate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearOverride: true }),
      });
      expect(res.status).toBe(200);
      expect(removeOverride).toHaveBeenCalledTimes(1);
      expect(auditLog.auditPestPressureScoreOverride).toHaveBeenCalledWith(
        expect.objectContaining({ action_type: 'remove' }),
      );
      expect(calculateAndPersistForServiceRecord).toHaveBeenCalledTimes(1);
    });
  });

  test('clearOverride audit records the latest calculated_score, not the stale original_calculated_score (codex P1)', async () => {
    // Setup: an override was set when calculated_score was 2.4, but the
    // engine has since been recalculated and the override was preserved
    // — so the current row has original_calculated_score=2.4 (stale) and
    // calculated_score=3.1 (post-recalc). Removing the override should
    // restore displayed_score to 3.1 (the latest calculation), and the
    // audit row must report 3.1 — not the stale 2.4.
    loadScoreForServiceRecord.mockResolvedValueOnce(makeScoreRow({
      is_overridden: true,
      displayed_score: 1.5,
      calculated_score: 3.1,             // latest engine output
      original_calculated_score: 2.4,    // captured when override was first set
      override_reason: 'old reason',
    }));
    removeOverride.mockResolvedValueOnce(makeScoreRow({ displayed_score: 3.1 }));
    calculateAndPersistForServiceRecord.mockResolvedValueOnce({
      result: { score: 3.3, displayedScore: 3.3 },
    });
    loadScoreForServiceRecord.mockResolvedValueOnce(makeScoreRow({ displayed_score: 3.3 }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/svc-1/recalculate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearOverride: true }),
      });
      expect(res.status).toBe(200);
      const auditArgs = auditLog.auditPestPressureScoreOverride.mock.calls[0][0];
      expect(auditArgs.action_type).toBe('remove');
      expect(auditArgs.original_calculated_score).toBe(2.4);  // captured original
      expect(auditArgs.displayed_score).toBe(3.1);            // TRUE restored value
      expect(auditArgs.displayed_score).not.toBe(2.4);        // not the stale original
    });
  });

  test('404 when orchestrator returns null (no service record)', async () => {
    calculateAndPersistForServiceRecord.mockResolvedValueOnce(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/missing/recalculate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });
});

describe('admin pest-pressure: list endpoints', () => {
  test('GET /scores/recent caps limit at 100', async () => {
    listRecentScores.mockResolvedValueOnce([makeScoreRow()]);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/scores/recent?limit=500`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const [, opts] = listRecentScores.mock.calls[0];
      expect(opts.limit).toBe(100);
    });
  });

  test('GET /customers/:id/history forwards serviceLine + limit', async () => {
    loadHistoryForCustomer.mockResolvedValueOnce([makeScoreRow()]);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/customers/cust-1/history?serviceLine=pest&limit=8`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const [, customerId, opts] = loadHistoryForCustomer.mock.calls[0];
      expect(customerId).toBe('cust-1');
      expect(opts).toEqual({ serviceLine: 'pest', limit: 8 });
    });
  });

  test('GET /audit returns events', async () => {
    listAuditEvents.mockResolvedValueOnce([
      { id: 'a-1', action: 'pest_pressure.config.update' },
    ]);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pest-pressure/audit`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events.length).toBe(1);
    });
  });
});
