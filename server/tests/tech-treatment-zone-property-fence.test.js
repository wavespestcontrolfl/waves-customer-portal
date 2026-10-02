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
const mockDelete = jest.fn();

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
  deleteTreatmentZoneMap: (...args) => mockDelete(...args),
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

  test('a move that commits after the route read is refused at the write (the lock answers 409)', async () => {
    mockSave.mockRejectedValue(Object.assign(new Error('This visit moved to another property. Close it and reopen it from the schedule.'), { code: 'visit_property_changed', statusCode: 409 }));
    await withServer(async (baseUrl) => {
      const res = await saveTrace(baseUrl, { expectedPropertyId: 'prop-2' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('visit_property_changed');
    });
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ expectedPropertyId: 'prop-2' }));
  });

  test('a completed visit refuses a bound save at the write (409 visit_completed)', async () => {
    mockSave.mockRejectedValue(Object.assign(new Error('This visit is complete, so its trace stays on the report.'), { code: 'visit_completed', statusCode: 409 }));
    await withServer(async (baseUrl) => {
      const res = await saveTrace(baseUrl, { expectedPropertyId: 'prop-2' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'This visit is complete, so its trace stays on the report.', code: 'visit_completed' });
    });
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

describe('Remove the trace (DELETE, the report flow)', () => {
  const remove = (baseUrl, query = '?expectedPropertyId=prop-2') => fetch(`${baseUrl}/api/tech/services/svc-1/treatment-zone${query}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer tech' },
  });
  beforeEach(() => {
    mockDelete.mockReset();
    mockDelete.mockResolvedValue({ snapshot_s3_key: 'snap.png' });
  });

  test('the tech removes it as themselves, bound to the property the sheet loaded', async () => {
    await withServer(async (baseUrl) => {
      const res = await remove(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: true });
    });
    expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({
      scheduledServiceId: 'svc-1',
      expectedPropertyId: 'prop-2',
      actor: expect.objectContaining({ techRole: 'technician', technicianId: 'tech-1' }),
    }));
  });

  test('a visit with no property sends an empty binding', async () => {
    await withServer(async (baseUrl) => {
      expect((await remove(baseUrl, '?expectedPropertyId=')).status).toBe(200);
    });
    expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ expectedPropertyId: null }));
  });

  test('each refusal on the locked row answers with its status and reason', async () => {
    for (const [code, status] of [['visit_completed', 409], ['visit_property_changed', 409], ['service_not_assigned', 403], ['not_found', 404]]) {
      mockDelete.mockRejectedValueOnce(Object.assign(new Error(`refused: ${code}`), { code }));
      await withServer(async (baseUrl) => {
        const res = await remove(baseUrl);
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: `refused: ${code}`, code });
      });
    }
  });
});

// The completion re-checks the trace the report flow judged, under the visit
// row lock every save also takes (pinned by source: the completion function
// is too large for a unit harness, like the tip and blog freezes).
describe('the completion re-checks the trace the report was judged against (Codex #5538)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const block = source.slice(source.indexOf('async function completeScheduledService('));

  test('traceSeen is compared under the locked visit row, before any record write, while the map gate is on', () => {
    const lock = block.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    const check = block.indexOf("if (traceSeen !== undefined && lockedSvcRow && isEnabled('treatmentZoneMap')) {");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    const body = block.slice(check, check + 700);
    expect(body).toMatch(/sp\('treatment_zone_maps'\)[\s\S]*\.where\(\{ scheduled_service_id: svc\.id \}\)/);
    expect(body).toMatch(/code: 'trace_changed'/);
  });

  test('the record freezes the trace it was judged against, and the report shows only that trace', () => {
    expect(block).toContain('...(traceSeen !== undefined ? { traceJudged: { seen: traceSeen ?? null } } : {}),');
    const report = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(report).toMatch(/if \(tracedRow\?\.snapshot_s3_key && PhotoService\s*\n\s*&& require\('\.\.\/treatment-zone-maps'\)\.traceJudgedAllows\(structured, tracedRow\)\) \{/);
  });

  test('a changed trace answers 409 trace_changed and marks the attempt failed', () => {
    const at = block.indexOf("if (err && err.code === 'trace_changed') {");
    expect(at).toBeGreaterThan(0);
    const mapped = block.slice(at, at + 500);
    expect(mapped).toMatch(/markCompletionAttemptFailed\(completionAttempt, err, db\)/);
    expect(mapped).toMatch(/status: 409[\s\S]*code: 'trace_changed'/);
  });
});
