// GATE_LAWN_RAINFAST_WATCH (P31) consumer: the lawn Fast Complete context shows
// the technician one fixed line when the PRIOR lawn visit at this property
// recorded a rainfast retreat-check, so the report's "we will re-check it at
// your next visit" is kept. Advisory, property-scoped, fail closed. Synthetic data.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lawn-assessment-history', () => ({ historyBeforeVisit: jest.fn() }));

const history = require('../services/lawn-assessment-history');
const { buildLawnFastContext } = require('../services/lawn-fast-complete');
const { reCheckLine } = require('../services/service-report/lawn-rainfast-watch');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const CATALOG = uuid(3);
const CUSTOMER = uuid(30);
const PRIOR_RECORD = uuid(40);
const PRIOR_ASSESSMENT = uuid(41);
const PROPERTY = uuid(50);

const ITEM = {
  v: 1, kind: 'rainfast_breach', source: 'open_meteo', windowFrom: '2026-09-10T14:00:00.000Z',
  breaches: [
    { minutes: 60, inches: 0.4, windowTo: '2026-09-10T15:00:00.000Z', products: ['Test Iron', 'Test Herbicide A'] },
    { minutes: 180, inches: 0.3, windowTo: '2026-09-10T17:00:00.000Z', products: ['Test Herbicide A'] },
  ],
  recordedAt: '2026-09-10T20:00:00.000Z',
};
const memoryNotes = (item, assessmentId = PRIOR_ASSESSMENT) => ({
  lawnVisitMemory: { [assessmentId]: { v: 1, assessmentId, serviceDate: '2026-09-10', applied: [], checks: [], sinceLast: null, ...(item ? { retreatCheck: item } : {}) } },
});

function fakeKnex(tables, onServiceRecordsWhere) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['whereIn', 'whereNot', 'leftJoin', 'join', 'orderBy', 'select']) chain[m] = () => chain;
    chain.where = (cond) => { if (table === 'service_records' && onServiceRecordsWhere) onServiceRecordsWhere(cond); return chain; };
    chain.first = async () => { if (data instanceof Error) throw data; return Array.isArray(data) ? data[0] : data; };
    const settle = () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  knex.schema = { hasTable: async () => true };
  return knex;
}
const visit = {
  id: VISIT, customer_id: CUSTOMER, property_id: PROPERTY, service_type: 'Lawn Care', service_id: CATALOG,
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null, technician_id: null,
};
const world = ({ notes, records } = {}, onWhere) => fakeKnex({
  scheduled_services: visit,
  services: { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' },
  service_completion_profiles: {
    service_key: 'lawn_care_monthly', category: 'lawn_care', billing_type: 'recurring', completion_mode: 'service_report',
    project_type: null, companion_types: null, active: true,
  },
  customers: { billing_mode: null },
  service_records: records !== undefined ? records : { id: PRIOR_RECORD, structured_notes: JSON.stringify(notes) },
}, onWhere);
const priorVisit = (over = {}) => ({
  scope: { propertyId: PROPERTY },
  previous: { id: PRIOR_ASSESSMENT, history_record_id: PRIOR_RECORD },
  rows: [], ...over,
});

const ENV = ['GATE_LAWN_RAINFAST_WATCH', 'GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_PROPERTY_HISTORY'];
const saved = {};
beforeEach(() => {
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  jest.clearAllMocks();
  history.historyBeforeVisit.mockResolvedValue(priorVisit());
});
afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
const live = () => { ENV.forEach((k) => { process.env[k] = 'true'; }); };
const context = (options, onWhere) => buildLawnFastContext(VISIT, { knex: world(options, onWhere) });

describe('the fixed line', () => {
  test('names the products inside their interval, once each, at most three, from the stored item only', () => {
    expect(reCheckLine(ITEM)).toBe("Re-check last visit's treatment: weather data showed rain soon after it (Test Iron, Test Herbicide A).");
    const many = { ...ITEM, breaches: [{ minutes: 60, inches: 0.4, windowTo: 'x', products: ['A', 'B', 'C', 'D'] }] };
    expect(reCheckLine(many)).toBe("Re-check last visit's treatment: weather data showed rain soon after it (A, B, C).");
    expect(reCheckLine({ ...ITEM, breaches: [{ minutes: 60, inches: 0.4, windowTo: 'x', products: [] }] })).toBe("Re-check last visit's treatment: weather data showed rain soon after it.");
    expect(reCheckLine({ v: 2, kind: 'other' })).toBeNull();
    expect(reCheckLine({ ...ITEM, breaches: [{ minutes: 60, inches: 0.1, products: ['A'] }] })).toBeNull();
    expect(reCheckLine(null)).toBeNull();
  });
});

describe('the Fast Complete context', () => {
  test('gate on: the prior visit\'s retreat-check at this property becomes the line, read from THAT record for THIS customer', async () => {
    live();
    const where = [];
    const ctx = await context({ notes: memoryNotes(ITEM) }, (cond) => where.push(cond));
    expect(ctx.reCheck).toEqual({ line: reCheckLine(ITEM) });
    expect(history.historyBeforeVisit).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER, throughVisitDate: '2026-10-05' }), expect.anything(),
    );
    expect(where).toEqual([{ id: PRIOR_RECORD, customer_id: CUSTOMER }]);
  });

  test('gate off, memory off, or property history off: the key is absent and nothing is read', async () => {
    for (const off of ENV) {
      live();
      delete process.env[off];
      const ctx = await context({ notes: memoryNotes(ITEM) });
      expect(ctx).not.toHaveProperty('reCheck');
    }
    expect(history.historyBeforeVisit).not.toHaveBeenCalled();
  });

  test.each([
    ['no prior visit at this property', () => history.historyBeforeVisit.mockResolvedValue(priorVisit({ previous: null })), { notes: memoryNotes(ITEM) }],
    ['the property is not proven', () => history.historyBeforeVisit.mockResolvedValue(priorVisit({ scope: { propertyId: null } })), { notes: memoryNotes(ITEM) }],
    ['the prior visit has no linked record', () => history.historyBeforeVisit.mockResolvedValue(priorVisit({ previous: { id: PRIOR_ASSESSMENT } })), { notes: memoryNotes(ITEM) }],
    ['the prior record is another customer\'s (no row for this customer)', () => {}, { records: null }],
    ['the prior has memory but no retreat-check', () => {}, { notes: memoryNotes(null) }],
    ['the stored item is of an unknown shape', () => {}, { notes: memoryNotes({ v: 2, kind: 'other' }) }],
    ['the memory belongs to a different assessment', () => {}, { notes: memoryNotes(ITEM, uuid(99)) }],
    ['the history read fails', () => history.historyBeforeVisit.mockRejectedValue(new Error('boom')), { notes: memoryNotes(ITEM) }],
    ['the record read fails', () => {}, { records: new Error('boom') }],
  ])('fail closed, no line: %s', async (_label, arrange, options) => {
    live();
    arrange();
    const ctx = await context(options);
    expect(ctx.ok).toBe(true);
    expect(ctx.eligible).toBe(true);
    expect(ctx.reCheck).toBeNull();
    // advisory: never a read failure the sheet has to report
    expect(ctx.readFailures).not.toContain('re_check');
  });

  test('the rest of the context is the same with the gate on and off', async () => {
    const off = JSON.parse(JSON.stringify(await context({ notes: memoryNotes(ITEM) })));
    live();
    const on = JSON.parse(JSON.stringify(await context({ notes: memoryNotes(ITEM) })));
    delete on.reCheck;
    expect(on).toEqual(off);
  });
});
