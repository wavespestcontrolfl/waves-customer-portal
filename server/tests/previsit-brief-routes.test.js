/**
 * Visit-brief read + regenerate routes (routes/admin-schedule.js):
 *  - GET /:id/visit-brief returns the stored brief TYPED; /:id/wdo-brief is
 *    a behavior-identical alias; tech-ownership scoping preserved (404 on
 *    an unowned visit).
 *  - POST /:id/regenerate-brief routes by brief type: WDO visits replay
 *    the tagger hook (unchanged behavior); others regenerate the visit
 *    brief ONLY when GATE_PREVISIT_BRIEF is on — 409 and no side effects
 *    otherwise.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  // Role switchable per request so the tech-scoping path is testable.
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockOnServiceScheduled = jest.fn(async () => {});
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: (serviceType) => (
    /wdo|wood destroying/i.test(String(serviceType || ''))
      ? { tag: 'wdo_inspection', label: 'WDO Inspection' }
      : { tag: 'pest_general', label: 'Pest Control' }
  ),
  onServiceScheduled: (...args) => mockOnServiceScheduled(...args),
}));
const mockGateEnabled = jest.fn(() => false);
const mockGenerateVisitBrief = jest.fn(async () => ({ generated: true }));
jest.mock('../services/previsit-brief', () => ({
  briefGateEnabled: (...args) => mockGateEnabled(...args),
  generateVisitBrief: (...args) => mockGenerateVisitBrief(...args),
  WDO_BRIEF_TYPE: 'wdo_inspection',
  VISIT_BRIEF_TYPE: 'visit_brief_v1',
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

function stubTables(rows, { ownsVisit = true } = {}) {
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    // The tech-ownership probe selects exactly 'scheduled_services.id';
    // the data reads select plain column lists — distinguish so a test
    // can present a visit that EXISTS but is not the tech's.
    q.first = jest.fn(async (...cols) => (
      cols[0] === 'scheduled_services.id'
        ? (ownsVisit ? { id: 'svc-1' } : undefined)
        : rows[table]
    ));
    return q;
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VISIT_BRIEF_ROW = {
  id: 'svc-1',
  service_type: 'Pest Control Service',
  pre_service_brief: JSON.stringify({ version: 'visit_brief_v1', priorities: ['Check garage'] }),
  pre_service_brief_type: 'visit_brief_v1',
  pre_service_brief_generated_at: '2026-08-13T09:15:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGateEnabled.mockReturnValue(false);
  mockGenerateVisitBrief.mockResolvedValue({ generated: true });
});

describe('GET /:id/visit-brief (+ /wdo-brief alias)', () => {
  test('returns the stored brief typed on both paths (gate on)', async () => {
    mockGateEnabled.mockReturnValue(true);
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    await withServer(async (base) => {
      for (const path of ['visit-brief', 'wdo-brief']) {
        const res = await fetch(`${base}/admin/schedule/svc-1/${path}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.type).toBe('visit_brief_v1');
        expect(body.brief.priorities).toEqual(['Check garage']);
        expect(body.generatedAt).toBe('2026-08-13T09:15:00.000Z');
      }
    });
  });

  test('gate OFF withdraws a cached generic visit brief (kill switch outranks persisted state)', async () => {
    mockGateEnabled.mockReturnValue(false);
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    await withServer(async (base) => {
      for (const path of ['visit-brief', 'wdo-brief']) {
        const res = await fetch(`${base}/admin/schedule/svc-1/${path}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.brief).toBeNull();
        // Nothing about the withheld brief leaks.
        expect(body.type).toBeUndefined();
        expect(body.generatedAt).toBeUndefined();
      }
    });
  });

  test('gate OFF still serves the legacy WDO brief exactly as before', async () => {
    mockGateEnabled.mockReturnValue(false);
    stubTables({
      scheduled_services: {
        ...VISIT_BRIEF_ROW,
        pre_service_brief: JSON.stringify({ risk_score: 'High' }),
        pre_service_brief_type: 'wdo_inspection',
      },
    });
    await withServer(async (base) => {
      for (const path of ['visit-brief', 'wdo-brief']) {
        const res = await fetch(`${base}/admin/schedule/svc-1/${path}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.brief).toEqual({ risk_score: 'High' });
        expect(body.type).toBe('wdo_inspection');
      }
    });
  });

  test('gate OFF still serves an untyped legacy brief (only this lane\'s type is withdrawn)', async () => {
    mockGateEnabled.mockReturnValue(false);
    stubTables({
      scheduled_services: {
        ...VISIT_BRIEF_ROW,
        pre_service_brief: JSON.stringify({ note: 'pre-lane brief' }),
        pre_service_brief_type: null,
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/visit-brief`);
      expect(res.status).toBe(200);
      expect((await res.json()).brief).toEqual({ note: 'pre-lane brief' });
    });
  });

  test('no stored brief → { brief: null }', async () => {
    stubTables({ scheduled_services: { ...VISIT_BRIEF_ROW, pre_service_brief: null, pre_service_brief_type: null } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/visit-brief`);
      expect(res.status).toBe(200);
      expect((await res.json()).brief).toBeNull();
    });
  });

  test('tech who does not own the visit gets 404 (both paths)', async () => {
    stubTables({ scheduled_services: VISIT_BRIEF_ROW }, { ownsVisit: false });
    await withServer(async (base) => {
      for (const path of ['visit-brief', 'wdo-brief']) {
        const res = await fetch(`${base}/admin/schedule/svc-1/${path}`, {
          headers: { 'x-test-role': 'technician' },
        });
        expect(res.status).toBe(404);
      }
    });
  });
});

describe('POST /:id/regenerate-brief', () => {
  test('WDO visit replays the tagger hook regardless of the gate (unchanged behavior)', async () => {
    stubTables({
      scheduled_services: {
        id: 'svc-1',
        service_type: 'WDO Inspection',
        pre_service_brief: JSON.stringify({ risk_score: 'High' }),
        pre_service_brief_type: 'wdo_inspection',
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.brief.risk_score).toBe('High');
      expect(mockOnServiceScheduled).toHaveBeenCalledWith('svc-1', { suppressWelcome: true });
      expect(mockGenerateVisitBrief).not.toHaveBeenCalled();
    });
  });

  test('a visit already carrying a WDO brief routes to the WDO path even with a generic service type', async () => {
    stubTables({
      scheduled_services: {
        id: 'svc-1',
        service_type: 'Termite Monitoring',
        pre_service_brief: JSON.stringify({ risk_score: 'Low' }),
        pre_service_brief_type: 'wdo_inspection',
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(mockOnServiceScheduled).toHaveBeenCalled();
      expect(mockGenerateVisitBrief).not.toHaveBeenCalled();
    });
  });

  test('non-WDO visit with the gate OFF → 409, nothing invoked', async () => {
    mockGateEnabled.mockReturnValue(false);
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('GATE_PREVISIT_BRIEF');
      expect(mockOnServiceScheduled).not.toHaveBeenCalled();
      expect(mockGenerateVisitBrief).not.toHaveBeenCalled();
    });
  });

  test('non-WDO visit with the gate ON regenerates the visit brief', async () => {
    mockGateEnabled.mockReturnValue(true);
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.unchanged).toBe(false);
      expect(body.brief.version).toBe('visit_brief_v1');
      expect(mockGenerateVisitBrief).toHaveBeenCalledWith('svc-1');
      // The tagger replay is the operator retry for a failed booking-time
      // run (idempotent per appointment-tagger) — it rides non-WDO
      // regeneration too.
      expect(mockOnServiceScheduled).toHaveBeenCalledWith('svc-1', { suppressWelcome: true });
    });
  });

  test('skip reasons are not success: terminal/WDO-conflict -> 409 with reason', async () => {
    mockGateEnabled.mockReturnValue(true);
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    for (const reason of ['terminal_status', 'wdo_brief_present']) {
      mockGenerateVisitBrief.mockResolvedValueOnce({ skipped: true, reason });
      await withServer(async (base) => {
        const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.reason).toBe(reason);
        expect(body.success).toBeUndefined();
        expect(body.error).toContain(reason);
      });
    }
  });

  test('skip reasons are not success: not_found/no_customer -> 404', async () => {
    mockGateEnabled.mockReturnValue(true);
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    for (const reason of ['not_found', 'no_customer']) {
      mockGenerateVisitBrief.mockResolvedValueOnce({ skipped: true, reason });
      await withServer(async (base) => {
        const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
        expect(res.status).toBe(404);
        expect((await res.json()).reason).toBe(reason);
      });
    }
  });

  test('unchanged-hash regeneration reports unchanged: true', async () => {
    mockGateEnabled.mockReturnValue(true);
    mockGenerateVisitBrief.mockResolvedValue({ skipped: true, reason: 'unchanged' });
    stubTables({ scheduled_services: VISIT_BRIEF_ROW });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).unchanged).toBe(true);
    });
  });

  test('jsonb-object pre_service_brief (node-postgres) does not 500 the regenerate response — visit branch', async () => {
    mockGateEnabled.mockReturnValue(true);
    stubTables({
      scheduled_services: {
        ...VISIT_BRIEF_ROW,
        // node-postgres returns jsonb columns as OBJECTS, not strings.
        pre_service_brief: { version: 'visit_brief_v1', priorities: ['Check garage'] },
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.brief.priorities).toEqual(['Check garage']);
    });
  });

  test('jsonb-object pre_service_brief does not 500 the regenerate response — WDO branch', async () => {
    stubTables({
      scheduled_services: {
        id: 'svc-1',
        service_type: 'WDO Inspection',
        pre_service_brief: { risk_score: 'High' },
        pre_service_brief_type: 'wdo_inspection',
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.brief.risk_score).toBe('High');
    });
  });

  test('tech who does not own the visit gets 404', async () => {
    stubTables({ scheduled_services: VISIT_BRIEF_ROW }, { ownsVisit: false });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/schedule/svc-1/regenerate-brief`, {
        method: 'POST',
        headers: { 'x-test-role': 'technician' },
      });
      expect(res.status).toBe(404);
      expect(mockOnServiceScheduled).not.toHaveBeenCalled();
      expect(mockGenerateVisitBrief).not.toHaveBeenCalled();
    });
  });
});
