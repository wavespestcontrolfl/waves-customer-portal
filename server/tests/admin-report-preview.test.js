// Admin report preview: the customer report for a visit that is NOT completed
// yet. Synthetic data only.
//
// Pins: the preview runs the REAL report builder (buildReportV1Data) over an
// in-memory record (null id, null token) and issues NO write of any kind (no
// insert/update/delete/upsert/transaction, no write raw), while the same
// fixture rendered as a normal record does write (so the recorder is proven to
// see writes); the confirmed assessment linked by scheduled-service id is the
// one shown; the lawn v6 copy is built but not frozen; the stand-in loader
// refuses a completed, cancelled or already-reported visit.

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));
jest.mock('../services/service-report/application-conditions', () => {
  const actual = jest.requireActual('../services/service-report/application-conditions');
  return { ...actual, fetchServiceWeekWeather: jest.fn() };
});
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn().mockResolvedValue({ ok: false, reason: 'no_key' }) };
});

const history = require('../services/lawn-assessment-history');
const conditions = require('../services/service-report/application-conditions');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { loadPreviewService } = require('../services/service-report/report-preview');

const WRITE_METHODS = ['insert', 'update', 'del', 'delete', 'truncate', 'increment', 'decrement', 'upsert'];

// A recording knex: reads come from fixtures (same shape as the lawn report
// suites), every write call is LOGGED and answered with a harmless result.
function makeRecordingKnex(fixtures) {
  const writes = [];
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {};
    const writeChain = (op) => {
      writes.push({ table, op });
      const w = {};
      ['onConflict', 'merge', 'ignore', 'returning', 'where', 'whereRaw', 'whereNull', 'whereNot'].forEach((m) => { w[m] = () => w; });
      w.catch = () => Promise.resolve(1);
      w.then = (resolve) => Promise.resolve(1).then(resolve);
      return w;
    };
    WRITE_METHODS.forEach((op) => { q[op] = () => writeChain(op); });
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (arguments.length === 2) rows = rows.filter((r) => r[a] === b);
        return q;
      },
      andWhere(a, b, c) { return typeof a === 'function' ? q : q.where(a, b, c); },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) { rows = rows.filter((r) => r[a] !== b); return q; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      whereRaw: () => q,
      orderBy: () => q,
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql, bindings) => {
    if (/^\s*(insert|update|delete|truncate)\b/i.test(String(sql))) writes.push({ table: null, op: 'raw-write' });
    return { __raw: sql, bindings };
  };
  knex.fn = { now: () => 'NOW' };
  knex.transaction = () => { writes.push({ table: null, op: 'transaction' }); throw new Error('no transactions in a preview'); };
  return { knex, writes };
}

const CUSTOMER = 'cust-preview';
const SS_ID = 'ss-open';
const ASSESSMENT = {
  id: 'la-open', customer_id: CUSTOMER, service_id: SS_ID, service_record_id: null, confirmed_by_tech: true,
  service_date: '2026-10-23', visit_date: '2026-10-23', created_at: '2026-10-23T14:00:00Z', history_record_id: null,
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
};
const fixtures = () => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: [], lawn_water_intake_snapshots: [], customer_documents: [],
  scheduled_services: [{ id: SS_ID, customer_id: CUSTOMER, scheduled_date: '2026-10-23', status: 'confirmed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [],
  lawn_assessments: [ASSESSMENT],
});
// The in-memory stand-in loadPreviewService builds (no row, no token).
const previewService = () => ({
  id: null, report_view_token: null, report_template_version: 'service_report_v1',
  scheduled_service_id: SS_ID, customer_id: CUSTOMER, technician_id: null,
  service_date: '2026-10-23', service_type: 'Lawn Care Treatment Program', service_line: 'lawn', status: 'completed',
  structured_notes: {}, service_data: {}, technician_notes: '', first_name: 'Test', last_name: 'Customer',
  customer_latitude: 27.5, customer_longitude: -82.5,
});
const OPTS = {
  mode: 'live', composeOffers: true, planSummary: true, upcomingVisitsCard: true, nearYou: true, lawnPhotoFindings: true,
  lawnLighting: true, lawnWateringCloseOut: true, lawnRainfastWatch: true, lawnWaterInRain: true,
};
const WEEK = { rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high', rainSource: 'test', windowClosed: true };

describe('admin report preview: the builder issues no write', () => {
  const ENV = ['GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_RAINFAST_WATCH', 'GATE_REPORT_PLAN_RESCHEDULE', 'GATE_REPORT_UPCOMING_VISITS'];
  const saved = {};
  beforeEach(() => {
    ENV.forEach((k) => { saved[k] = process.env[k]; });
    // Every gate whose branch owns a write is on, so the skips are what keep the log empty.
    process.env.GATE_LAWN_VISIT_MEMORY = 'true';
    process.env.GATE_LAWN_RAINFAST_WATCH = 'true';
    process.env.GATE_REPORT_PLAN_RESCHEDULE = 'true';
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    jest.clearAllMocks();
    conditions.fetchServiceWeekWeather.mockResolvedValue(WEEK);
    history.installedForVisit.mockResolvedValue(ASSESSMENT);
    history.historyForReport.mockResolvedValue({ current: ASSESSMENT, rows: [ASSESSMENT], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: ASSESSMENT, rows: [ASSESSMENT], identity: 'h', eligibleVisitIds: [], isBaseline: true });
  });
  afterEach(() => {
    ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  // Both resolvers: the property-history one (installedForVisit) and the plain one (lawn_assessments.service_id).
  test.each(['true', 'false'])('preview render (GATE_LAWN_PROPERTY_HISTORY=%s): no write, and the visit-linked confirmed assessment is shown', async (historyGate) => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = historyGate;
    const { knex, writes } = makeRecordingKnex(fixtures());
    const data = await buildReportV1Data(previewService(), null, knex, { ...OPTS, preview: true });

    expect(writes).toEqual([]);
    // The lookup reached the week-weather freeze branch (the write it must skip).
    expect(conditions.fetchServiceWeekWeather).toHaveBeenCalled();
    if (historyGate === 'true') {
      // Found by the scheduled visit, with no record id to key on.
      expect(history.installedForVisit).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: CUSTOMER, serviceRecordId: null, serviceId: SS_ID }),
        expect.anything(),
      );
    }
    expect(data.serviceRecordId).toBeNull();
    expect(data.token).toBeNull();
    expect(data.serviceLine).toBe('lawn');
    expect(data.lawnAssessment).toBeTruthy();
    expect(data.lawnAssessment.assessmentId).toBe(ASSESSMENT.id);
    expect(data.reportV2).toBeTruthy();
  });

  test('the lawn v6 copy is built for the preview but never frozen', async () => {
    const { knex, writes } = makeRecordingKnex(fixtures());
    const data = await buildReportV1Data(previewService(), null, knex, { ...OPTS, preview: true });
    expect(writes).toEqual([]);
    expect(data.reportV2.copyV6).toBeTruthy();
    expect(data.reportV2.copyV6.headline).toBe(data.reportV2.snapshot.statusHeadline);
    expect(data.lawnAssessment.weekWeatherUncacheable).not.toBe(true);
  });

  test('control: the same visit rendered as a REAL record does write (the recorder sees writes)', async () => {
    const { knex, writes } = makeRecordingKnex(fixtures());
    await buildReportV1Data({ ...previewService(), id: 'svc-real' }, 'token-real', knex, OPTS);
    expect(writes.length).toBeGreaterThan(0);
    // The record freezes (week weather, visit memory, v6 copy) and the water-snapshot upsert.
    expect(writes.filter((w) => w.table === 'service_records' && w.op === 'update').length).toBeGreaterThanOrEqual(3);
    expect(writes).toContainEqual({ table: 'lawn_water_intake_snapshots', op: 'insert' });
  });
});

describe('loadPreviewService', () => {
  const ROW = {
    ss_id: SS_ID, ss_customer_id: CUSTOMER, ss_technician_id: 'tech-1', scheduled_date: '2026-10-23',
    service_type: 'Lawn Care Treatment Program', ss_status: 'confirmed', is_callback: false,
    first_name: 'Test', last_name: 'Customer', address_line1: '100 Test Palm Way', city: 'Bradenton', state: 'FL', zip: '34201',
    technician_name: 'Test Tech',
  };
  const fakeKnex = ({ row = ROW, existingRecord = null } = {}) => {
    const knex = (table) => {
      const q = {
        where: () => q, leftJoin: () => q, select: () => q,
        first: () => Promise.resolve(table === 'service_records' ? existingRecord : row),
      };
      return q;
    };
    knex.raw = (sql) => sql;
    return knex;
  };
  const UUID = '11111111-2222-4333-8444-555555555555';

  test('builds an in-memory stand-in: null id and token, the visit date, the line completion would stamp', async () => {
    const { service, error } = await loadPreviewService(UUID, fakeKnex());
    expect(error).toBeUndefined();
    expect(service).toMatchObject({
      id: null, report_view_token: null, report_template_version: 'service_report_v1',
      scheduled_service_id: SS_ID, customer_id: CUSTOMER, technician_id: 'tech-1',
      service_date: '2026-10-23', service_line: 'lawn', structured_notes: {},
      first_name: 'Test', technician_name: 'Test Tech',
    });
    expect(service.ss_status).toBeUndefined();
  });

  test.each([
    ['not-a-uuid', null, 'invalid_id'],
    [UUID, 'none', 'not_found'],
    [UUID, { ...ROW, ss_status: 'completed' }, 'completed'],
    [UUID, { ...ROW, ss_status: 'cancelled' }, 'cancelled'],
  ])('refuses %s (%#)', async (id, row, expected) => {
    const knex = fakeKnex({ row: row === 'none' ? null : (row || ROW) });
    expect((await loadPreviewService(id, knex)).error).toBe(expected);
  });

  test('refuses a visit that already has a record (a real report exists)', async () => {
    const result = await loadPreviewService(UUID, fakeKnex({ existingRecord: { id: 'svc-1' } }));
    expect(result.error).toBe('has_report');
  });
});
