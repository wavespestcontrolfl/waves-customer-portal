/**
 * POST /admin/dispatch/:reportNoteServiceId/pest-recap/report-note (GATE_REPORT_OWN_NOTE, report speed plan step 2): the pest
 * Fast Complete sheet asks for the technician's own note as the customer's report will show it. The route names the
 * visit's customer to the clean-up call (the codes on that customer's file are read before any model reads the
 * note), answers only for the visit's own technician or the office, and reads nothing while the gate is off.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockDbCurrent(...args);
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pest-recap', () => ({ ...jest.requireActual('../services/pest-recap'), resolveEligibility: jest.fn() }));
jest.mock('../services/service-report/report-own-note-writer', () => ({ cleanReportNote: jest.fn() }));

const router = require('../routes/admin-dispatch');
const db = require('../models/db');
const PestRecap = require('../services/pest-recap');
const { cleanReportNote } = require('../services/service-report/report-own-note-writer');
const { VISIT_NO_CUSTOMER_CODE } = require('../services/invoice-helpers');
const { etDateString } = require('../utils/datetime-et');

const REPORT_NOTE = '/:reportNoteServiceId/pest-recap/report-note';
const VISIT_ID = '0b9f4c1e-2a3d-4e5f-8a6b-7c8d9e0f1a2b';
const TECHNICIAN = { techRole: 'technician', technicianId: 'tech-1' };

const routeStack = () => router.stack.find((l) => l.route && l.route.path === REPORT_NOTE && l.route.methods.post).route.stack;
// The gate, then the handler (the staff limiter between them is checked on its own below).
function invoke(body, actor = TECHNICIAN, id = VISIT_ID) {
  const stack = routeStack();
  const gate = stack[0].handle;
  const { handle } = stack[stack.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const req = {
    params: { reportNoteServiceId: id }, body, query: {}, ...actor,
  };
  return new Promise((resolve, reject) => {
    let passed = false;
    gate(req, res, () => { passed = true; });
    if (!passed) { resolve(res); return; }
    handle(req, res, reject).then(() => resolve(res)).catch(reject);
  });
}

// The visit row the ownership check reads: today's visit of one technician.
const visitOf = (technician_id) => jest.fn(() => {
  const read = {
    where: () => read,
    first: async () => ({ technician_id, status: 'confirmed', scheduled_date: etDateString(new Date()) }),
  };
  return read;
});
const PEST_VISIT = { ok: true, eligible: true, profile: { serviceLine: 'pest' }, svc: {
  id: VISIT_ID, customer_id: 'customer-1', service_type: 'Quarterly Pest Control', technician_id: 'tech-1', status: 'confirmed', scheduled_date: etDateString(new Date()),
} };

beforeEach(() => {
  process.env.GATE_REPORT_OWN_NOTE = 'true';
  mockDbCurrent = visitOf('tech-1');
  PestRecap.resolveEligibility.mockReset().mockResolvedValue(PEST_VISIT);
  cleanReportNote.mockReset().mockResolvedValue({ text: 'I treated the shed. — Sam', source: 'cleaned' });
});
afterEach(() => {
  delete process.env.GATE_REPORT_OWN_NOTE;
});

describe('POST pest-recap/report-note', () => {
  test('the clean-up call gets the note, the visit\'s service and the visit\'s customer, never the body\'s areas; the answer is its text', async () => {
    const res = await invoke({ note: 'treated shed', areasServiced: ['Borlux room'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, text: 'I treated the shed. — Sam', source: 'cleaned' });
    expect(PestRecap.resolveEligibility).toHaveBeenCalledWith(VISIT_ID, db, { strict: true });
    expect(cleanReportNote.mock.calls).toEqual([[{
      note: 'treated shed', serviceType: 'Quarterly Pest Control', db, customerId: 'customer-1',
    }]]);
  });

  test('the fixed sentence comes with its reason, and a body with no note is read as none', async () => {
    cleanReportNote.mockResolvedValue({ text: 'We completed your pest control service.', source: 'fixed', reason: 'stored_code', words: ['x'] });
    const res = await invoke({ note: 12 });
    expect(res.body).toEqual({
      ok: true, text: 'We completed your pest control service.', source: 'fixed', reason: 'stored_code',
    });
    expect(cleanReportNote.mock.calls[0][0]).toMatchObject({ note: '' });
    await invoke(undefined);
    expect(cleanReportNote.mock.calls[1][0]).toMatchObject({ note: '' });
  });

  test('while the gate is off the route answers 404 and reads nothing', async () => {
    delete process.env.GATE_REPORT_OWN_NOTE;
    const res = await invoke({ note: 'treated shed' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    process.env.GATE_REPORT_OWN_NOTE = '1';
    expect((await invoke({ note: 'treated shed' })).statusCode).toBe(404);
    expect(mockDbCurrent).not.toHaveBeenCalled();
    expect(PestRecap.resolveEligibility).not.toHaveBeenCalled();
    expect(cleanReportNote).not.toHaveBeenCalled();
  });

  test('the visit is not read before the gate: the path skips the serviceId lookup, and a malformed id reads nothing', async () => {
    expect(REPORT_NOTE).not.toMatch(/:serviceId\b/);
    const res = await invoke({ note: 'treated shed' }, TECHNICIAN, 'not-a-uuid');
    expect([res.statusCode, res.body]).toEqual([404, { error: 'Service not found', code: 'not_found' }]);
    expect(mockDbCurrent).not.toHaveBeenCalled();
    expect(cleanReportNote).not.toHaveBeenCalled();
  });

  test('another technician\'s visit is refused before the visit or the note is read; the office reads any visit', async () => {
    mockDbCurrent = visitOf('tech-2');
    const other = await invoke({ note: 'treated shed' });
    expect(other.statusCode).toBe(403);
    expect(PestRecap.resolveEligibility).not.toHaveBeenCalled();
    expect(cleanReportNote).not.toHaveBeenCalled();
    const office = await invoke({ note: 'treated shed' }, { techRole: 'admin', technicianId: 'admin-1' });
    expect(office.statusCode).toBe(200);
  });

  test('a visit reassigned between the two reads is refused before the writer', async () => {
    PestRecap.resolveEligibility.mockResolvedValue({ ...PEST_VISIT, svc: { ...PEST_VISIT.svc, technician_id: 'tech-2' } });
    const res = await invoke({ note: 'treated shed' });
    expect([res.statusCode, res.body.code]).toEqual([403, 'service_not_assigned']);
    // Refused before the visit's own refusals can name it (no customer, not a pest visit).
    PestRecap.resolveEligibility.mockResolvedValue({ ...PEST_VISIT, eligible: false, svc: { ...PEST_VISIT.svc, technician_id: 'tech-2', customer_id: null } });
    expect((await invoke({ note: 'treated shed' })).statusCode).toBe(403);
    expect(cleanReportNote).not.toHaveBeenCalled();
  });

  test('the gate runs first, then a staff limiter, then the handler', () => {
    const stack = routeStack();
    expect(stack).toHaveLength(3);
    expect(stack[0].name).toBe('reportOwnNoteGate');
  });

  test('a visit that is gone, is no pest visit, or has no customer gets no model call', async () => {
    const refused = async (visit) => {
      PestRecap.resolveEligibility.mockResolvedValue(visit);
      const res = await invoke({ note: 'treated shed' });
      return [res.statusCode, res.body];
    };
    expect(await refused({ ok: false, reason: 'not_found' })).toEqual([404, { error: 'not_found', code: 'not_found' }]);
    expect(await refused({ ...PEST_VISIT, eligible: false })).toEqual([409, { error: 'not_pest_control', code: 'not_pest_control' }]);
    expect(await refused({ ...PEST_VISIT, profile: null, eligible: false }))
      .toEqual([503, { error: 'profile_unavailable', code: 'profile_unavailable' }]);
    expect(await refused({ ...PEST_VISIT, svc: { ...PEST_VISIT.svc, customer_id: null } }))
      .toEqual([409, { error: VISIT_NO_CUSTOMER_CODE, code: VISIT_NO_CUSTOMER_CODE }]);
    expect(cleanReportNote).not.toHaveBeenCalled();
  });
});
