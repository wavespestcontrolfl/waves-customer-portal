/**
 * Fast Complete report flow (Codex #5538): a trace saved from the sheet is
 * bound to the property the sheet loaded the visit at. A visit the office
 * moved to another property since is refused (409 visit_property_changed),
 * so a map of the old home never lands on the new one. A caller that sends
 * no expectedPropertyId (every other tracer) is unchanged.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockFirst = jest.fn();
const mockSave = jest.fn();

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
  saveTreatmentZoneMap: (...args) => mockSave(...args),
  getTreatmentZoneMapForScheduledService: jest.fn(),
  treatmentZonePdfSignature: jest.fn(),
}));
jest.mock('../services/service-report/pdf-storage', () => ({ invalidateServiceReportPdfCache: jest.fn() }));
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
const traceEligibility = require('../services/service-report/trace-eligibility');
const router = require('../routes/tech-track');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

function saveTrace(baseUrl, extra = {}) {
  const form = new FormData();
  form.append('payload', JSON.stringify({
    pathPoints: [{ px: { x: 10, y: 10 } }, { px: { x: 200, y: 10 } }],
    closedLoop: false,
    linearFt: 120,
    lat: 27.4,
    lng: -82.5,
    zoom: 20,
    address: '1234 Example Ln',
    captureMode: 'perimeter',
    ...extra,
  }));
  return fetch(`${baseUrl}/api/tech/services/svc-1/treatment-zone`, {
    method: 'POST', headers: { Authorization: 'Bearer tech' }, body: form,
  });
}

describe('treatment-zone save bound to the loaded property', () => {
  beforeEach(() => {
    mockFirst.mockReset();
    mockSave.mockReset();
    jest.spyOn(traceEligibility, 'traceCaptureBlockPayload').mockResolvedValue(null);
    mockFirst.mockImplementation(async () => ({
      id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', service_id: 'cat-1', service_type: 'Quarterly Pest Control', property_id: 'prop-2',
    }));
    mockSave.mockResolvedValue({ id: 'zone-1', linear_ft: 120 });
  });
  afterEach(() => jest.restoreAllMocks());

  test('a visit moved to another property since the sheet loaded is refused, and nothing is saved', async () => {
    await withServer(async (baseUrl) => {
      const res = await saveTrace(baseUrl, { expectedPropertyId: 'prop-1' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('visit_property_changed');
    });
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('the same property saves, and a caller that sends none is unchanged', async () => {
    await withServer(async (baseUrl) => {
      expect((await saveTrace(baseUrl, { expectedPropertyId: 'prop-2' })).status).toBe(200);
      expect((await saveTrace(baseUrl)).status).toBe(200);
    });
    expect(mockSave).toHaveBeenCalledTimes(2);
  });

  test('a visit with no property matches a sheet that loaded none', async () => {
    mockFirst.mockImplementation(async () => ({
      id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', service_id: 'cat-1', service_type: 'Quarterly Pest Control', property_id: null,
    }));
    await withServer(async (baseUrl) => {
      expect((await saveTrace(baseUrl, { expectedPropertyId: null })).status).toBe(200);
      expect((await saveTrace(baseUrl, { expectedPropertyId: 'prop-1' })).status).toBe(409);
    });
  });
});
