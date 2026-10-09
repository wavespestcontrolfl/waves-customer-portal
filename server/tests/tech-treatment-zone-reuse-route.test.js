/**
 * GET .../treatment-zone/last and POST .../treatment-zone/reuse
 * (GATE_TRACE_REUSE, dark): gate, ownership, the save route's property fence,
 * and the refusals the copy answers. The lookup and the copy are covered in
 * treatment-zone-reuse.test.js; here they are mocked.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockFirst = jest.fn();
const mockDescribe = jest.fn();
const mockReuse = jest.fn();
const mockInvalidate = jest.fn();

jest.mock('../models/db', () => {
  const chain = {
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: (...a) => mockFirst(...a),
  };
  return jest.fn(() => chain);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/treatment-zone-maps', () => ({
  saveTreatmentZoneMap: jest.fn(),
  deleteTreatmentZoneMap: jest.fn(),
  getTreatmentZoneMapForScheduledService: jest.fn(),
  treatmentZonePdfSignature: jest.fn(),
  describeReusableTreatmentZone: (...a) => mockDescribe(...a),
  reuseLastTreatmentZone: (...a) => mockReuse(...a),
}));
jest.mock('../services/service-report/pdf-storage', () => ({ invalidateServiceReportPdfCache: (...a) => mockInvalidate(...a) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technician = { id: 'tech-1', role: 'technician' };
    req.technicianId = 'tech-1';
    req.techRole = 'technician';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const express = require('express');
const featureGates = require('../config/feature-gates');
const router = require('../routes/tech-track');

// The map gate is fixed at load (on outside production), so a test turns it off here.
function setGate(name, on) {
  if (name === 'GATE_TRACE_REUSE') { process.env[name] = on ? 'true' : 'false'; return; }
  jest.spyOn(featureGates, 'isEnabled').mockImplementation((key) => (key === 'treatmentZoneMap' ? on : true));
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const TODAY_ET = require('../utils/datetime-et').etDateString();
const VISIT = {
  id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY_ET,
  service_id: 'cat-1', service_type: 'Quarterly Pest Control', property_id: 'prop-1',
};

const getLast = (baseUrl) => fetch(`${baseUrl}/api/tech/services/svc-1/treatment-zone/last`, { headers: { Authorization: 'Bearer tech' } });
const postReuse = (baseUrl, body = {}) => fetch(`${baseUrl}/api/tech/services/svc-1/treatment-zone/reuse`, {
  method: 'POST', headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('treatment-zone reuse routes', () => {
  beforeEach(() => {
    process.env.GATE_TRACE_REUSE = 'true';
    process.env.GATE_TREATMENT_ZONE_MAP = 'true';
    [mockFirst, mockDescribe, mockReuse, mockInvalidate].forEach((m) => m.mockReset());
    mockFirst.mockImplementation(async () => ({ ...VISIT }));
    mockDescribe.mockResolvedValue({ available: true, linearFt: 220, capturedOn: '2026-07-01', captureMode: 'perimeter' });
    mockReuse.mockResolvedValue({ id: 'zone-new', linear_ft: 220 });
  });
  afterAll(() => {
    delete process.env.GATE_TRACE_REUSE;
    delete process.env.GATE_TREATMENT_ZONE_MAP;
  });
  afterEach(() => jest.restoreAllMocks());

  describe('GET /last', () => {
    test('answers the size, the day and the mode', async () => {
      await withServer(async (baseUrl) => {
        const res = await getLast(baseUrl);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ available: true, linearFt: 220, capturedOn: '2026-07-01', captureMode: 'perimeter' });
      });
      expect(mockDescribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-1', customer_id: 'cust-1', property_id: 'prop-1' }));
    });

    test.each(['GATE_TRACE_REUSE', 'GATE_TREATMENT_ZONE_MAP'])('answers { available: false } with %s off, and looks nothing up', async (name) => {
      setGate(name, false);
      await withServer(async (baseUrl) => {
        expect(await (await getLast(baseUrl)).json()).toEqual({ available: false });
      });
      expect(mockFirst).not.toHaveBeenCalled();
      expect(mockDescribe).not.toHaveBeenCalled();
    });

    test('the gate is strict: only the exact word true turns it on', async () => {
      process.env.GATE_TRACE_REUSE = '1';
      await withServer(async (baseUrl) => {
        expect(await (await getLast(baseUrl)).json()).toEqual({ available: false });
      });
    });

    test('a visit assigned to another technician is refused', async () => {
      mockFirst.mockImplementation(async () => ({ ...VISIT, technician_id: 'tech-2' }));
      await withServer(async (baseUrl) => {
        expect((await getLast(baseUrl)).status).toBe(403);
      });
      expect(mockDescribe).not.toHaveBeenCalled();
    });

    test('an unknown visit is a 404', async () => {
      mockFirst.mockImplementation(async () => undefined);
      await withServer(async (baseUrl) => {
        expect((await getLast(baseUrl)).status).toBe(404);
      });
    });
  });

  describe('POST /reuse', () => {
    test('saves a copy onto the visit and returns the row like the save route', async () => {
      await withServer(async (baseUrl) => {
        const res = await postReuse(baseUrl, { expectedPropertyId: 'prop-1', openVisitOnly: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ treatmentZone: { id: 'zone-new', linear_ft: 220 } });
      });
      expect(mockReuse).toHaveBeenCalledWith(expect.objectContaining({
        visit: expect.objectContaining({ id: 'svc-1' }), technicianId: 'tech-1', expectedPropertyId: 'prop-1', openVisitOnly: true,
      }));
    });

    test('never accepts a client-named source', async () => {
      await withServer(async (baseUrl) => {
        await postReuse(baseUrl, { zoneId: 'zone-other', sourceServiceId: 'svc-other', scheduledServiceId: 'svc-other', pathPoints: [] });
      });
      const args = mockReuse.mock.calls[0][0];
      expect(Object.keys(args).sort()).toEqual(['openVisitOnly', 'technicianId', 'visit']);
      expect(args.visit.id).toBe('svc-1');
    });

    test('a caller that sends no expectedPropertyId sends none to the write', async () => {
      await withServer(async (baseUrl) => { await postReuse(baseUrl); });
      const args = mockReuse.mock.calls[0][0];
      expect(Object.prototype.hasOwnProperty.call(args, 'expectedPropertyId')).toBe(false);
      expect(args.openVisitOnly).toBe(false);
    });

    test('a visit moved to another property since the sheet loaded is refused before any copy', async () => {
      await withServer(async (baseUrl) => {
        const res = await postReuse(baseUrl, { expectedPropertyId: 'prop-9' });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('visit_property_changed');
      });
      expect(mockReuse).not.toHaveBeenCalled();
    });

    test('a visit with no property matches a sheet that loaded none', async () => {
      mockFirst.mockImplementation(async () => ({ ...VISIT, property_id: null }));
      await withServer(async (baseUrl) => {
        expect((await postReuse(baseUrl, { expectedPropertyId: null })).status).toBe(200);
        expect((await postReuse(baseUrl, { expectedPropertyId: 'prop-1' })).status).toBe(409);
      });
    });

    test.each([
      ['visit_completed', 409], ['visit_property_changed', 409], ['trace_exists', 409],
      ['no_reusable_trace', 409], ['trace_image_copy_failed', 502],
    ])('a %s refusal answers %i with the message and code', async (code, status) => {
      mockReuse.mockRejectedValue(Object.assign(new Error(`refused: ${code}`), { code }));
      await withServer(async (baseUrl) => {
        const res = await postReuse(baseUrl, { expectedPropertyId: 'prop-1', openVisitOnly: true });
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: `refused: ${code}`, code });
      });
      expect(mockInvalidate).not.toHaveBeenCalled();
    });

    test('an unexpected failure is not swallowed', async () => {
      mockReuse.mockRejectedValue(new Error('db down'));
      await withServer(async (baseUrl) => {
        expect((await postReuse(baseUrl)).status).toBe(500);
      });
    });

    test('a completed visit record has its cached report PDF dropped', async () => {
      mockFirst.mockImplementation(async (...cols) => (cols[0] === 'id' && cols.length === 1 ? { id: 'rec-1' } : { ...VISIT }));
      await withServer(async (baseUrl) => { await postReuse(baseUrl); });
      expect(mockInvalidate).toHaveBeenCalledWith('rec-1');
    });

    test.each(['GATE_TRACE_REUSE', 'GATE_TREATMENT_ZONE_MAP'])('answers 404 with %s off, like the save route', async (name) => {
      setGate(name, false);
      await withServer(async (baseUrl) => {
        const res = await postReuse(baseUrl, { expectedPropertyId: 'prop-1' });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not enabled' });
      });
      expect(mockReuse).not.toHaveBeenCalled();
      expect(mockFirst).not.toHaveBeenCalled();
    });

    test('a visit assigned to another technician is refused', async () => {
      mockFirst.mockImplementation(async () => ({ ...VISIT, technician_id: 'tech-2' }));
      await withServer(async (baseUrl) => {
        expect((await postReuse(baseUrl)).status).toBe(403);
      });
      expect(mockReuse).not.toHaveBeenCalled();
    });
  });
});
