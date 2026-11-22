/**
 * POST /admin/dispatch/:serviceId/pest-recap/report-note (GATE_REPORT_OWN_NOTE, report speed plan step 2): the pest
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

const REPORT_NOTE = '/:serviceId/pest-recap/report-note';
const TECHNICIAN = { techRole: 'technician', technicianId: 'tech-1' };

function invoke(body, actor = TECHNICIAN) {
  const layer = router.stack.find((l) => l.route && l.route.path === REPORT_NOTE && l.route.methods.post);
  const { handle } = layer.route.stack[layer.route.stack.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handle({
      params: { serviceId: 'visit-1' }, body, query: {}, ...actor,
    }, res, reject).then(() => resolve(res)).catch(reject);
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
const PEST_VISIT = { ok: true, eligible: true, svc: { id: 'visit-1', customer_id: 'customer-1', service_type: 'Quarterly Pest Control' } };

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
  test('the clean-up call gets the note, the visit\'s service and the visit\'s customer; the answer is its text', async () => {
    const res = await invoke({ note: 'treated shed', areasServiced: ['Shed'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, text: 'I treated the shed. — Sam', source: 'cleaned' });
    expect(PestRecap.resolveEligibility).toHaveBeenCalledWith('visit-1');
    expect(cleanReportNote.mock.calls).toEqual([[{
      note: 'treated shed', serviceType: 'Quarterly Pest Control', areasServiced: ['Shed'], db, customerId: 'customer-1',
    }]]);
  });

  test('the fixed sentence comes with its reason, and a body with no note or no list of areas is read as none', async () => {
    cleanReportNote.mockResolvedValue({ text: 'We completed your pest control service.', source: 'fixed', reason: 'stored_code', words: ['x'] });
    const res = await invoke({ note: 12, areasServiced: 'Shed' });
    expect(res.body).toEqual({
      ok: true, text: 'We completed your pest control service.', source: 'fixed', reason: 'stored_code',
    });
    expect(cleanReportNote.mock.calls[0][0]).toMatchObject({ note: '', areasServiced: [] });
    await invoke(undefined);
    expect(cleanReportNote.mock.calls[1][0]).toMatchObject({ note: '', areasServiced: [] });
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

  test('another technician\'s visit is refused before the visit or the note is read; the office reads any visit', async () => {
    mockDbCurrent = visitOf('tech-2');
    const other = await invoke({ note: 'treated shed' });
    expect(other.statusCode).toBe(403);
    expect(PestRecap.resolveEligibility).not.toHaveBeenCalled();
    expect(cleanReportNote).not.toHaveBeenCalled();
    const office = await invoke({ note: 'treated shed' }, { techRole: 'admin', technicianId: 'admin-1' });
    expect(office.statusCode).toBe(200);
  });

  test('a visit that is gone, is no pest visit, or has no customer gets no model call', async () => {
    const refused = async (visit) => {
      PestRecap.resolveEligibility.mockResolvedValue(visit);
      const res = await invoke({ note: 'treated shed' });
      return [res.statusCode, res.body];
    };
    expect(await refused({ ok: false, reason: 'not_found' })).toEqual([404, { error: 'not_found', code: 'not_found' }]);
    expect(await refused({ ...PEST_VISIT, eligible: false })).toEqual([409, { error: 'not_pest_control', code: 'not_pest_control' }]);
    expect(await refused({ ...PEST_VISIT, svc: { ...PEST_VISIT.svc, customer_id: null } }))
      .toEqual([409, { error: VISIT_NO_CUSTOMER_CODE, code: VISIT_NO_CUSTOMER_CODE }]);
    expect(cleanReportNote).not.toHaveBeenCalled();
  });
});
