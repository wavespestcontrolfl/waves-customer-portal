const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), isEnabled: () => false }));
jest.mock('../services/service-report/application-conditions', () => ({
  ...jest.requireActual('../services/service-report/application-conditions'),
  fetchServiceWeekWeather: jest.fn(() => { throw new Error('No weather calls in this test'); }),
}));
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const { buildLawnAssessmentReportData, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const history = require('../services/lawn-assessment-history');
const { getLatestTurfHeight, getTurfHeightTrend } = require('../services/turf-height-service');

describeDb('report property history projections', () => {
  let owned;
  let knex;
  beforeAll(async () => { owned = await createLawnHistoryDb(); knex = owned.knex; });
  afterAll(async () => { if (owned) await owned.dispose(); });

  test('gate-on report excludes another property and retains the complete payload shape', async () => {
    const f = await fixture(knex);
    const oldVisit = await f.visit(-20);
    const old = await f.assessment(oldVisit);
    const [otherProperty] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    await f.assessment(await f.visit(-10, { property_id: otherProperty.id }));
    const currentVisit = await f.visit(-1);
    const currentRecord = await f.record(currentVisit);
    const current = await f.assessment(currentVisit, { service_record_id: currentRecord.id });
    const service = { ...currentRecord, service_line: 'lawn' };
    const enabled = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: true });
    const disabled = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    expect(Object.keys(enabled).sort()).toEqual(Object.keys(disabled).sort());
    expect(Object.keys(enabled.scores).sort()).toEqual(Object.keys(disabled.scores).sort());
    expect(enabled.trend).toHaveLength(2);
    expect(disabled.trend).toHaveLength(3);
    expect(enabled.initialScores.assessmentId).toBe(old.id);
    expect(enabled.assessmentId).toBe(current.id);
    expect(enabled.trend[0].date).not.toEqual(old.service_date);
  });

  test('a history-only reconfirm changes the canonical PDF identity; unchanged reads stay stable', async () => {
    const f = await fixture(knex);
    const earlier = await f.assessment(await f.visit(-20));
    const visit = await f.visit(-1);
    const record = await f.record(visit);
    await f.assessment(visit, { service_record_id: record.id });
    const service = { ...record, service_line: 'lawn' };
    const options = { propertyHistoryEnabled: true };
    const before = await resolveCanonicalLawnRender(service, knex, options);
    expect((await resolveCanonicalLawnRender(service, knex, options)).signature).toBe(before.signature);
    await knex('lawn_assessments').where({ id: earlier.id }).update({ confirmed_at: knex.raw('clock_timestamp()') });
    const after = await resolveCanonicalLawnRender(service, knex, options);
    expect(after.pin).toBe(before.pin);
    expect(after.signature).not.toBe(before.signature);
    expect(after.lawnHistory.identity).not.toBe(before.lawnHistory.identity);
  });

  test('mowing and water histories use the same visit inclusion, including conflicting record rejection', async () => {
    const f = await fixture(knex);
    const ownVisit = await f.visit(-5);
    const ownRecord = await f.record(ownVisit);
    const [otherProperty] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    const otherVisit = await f.visit(-1, { property_id: otherProperty.id });
    const otherRecord = await f.record(otherVisit);
    for (const [record, height] of [[ownRecord, 3], [otherRecord, 5]]) {
      await knex('turf_height_readings').insert({ customer_id: f.customerId, service_record_id: record.id, grass_type: 'st_augustine', manual_height_in: height, target_min_in: 3, target_max_in: 4, range_status: 'in_range', measured_at: new Date(), created_by: require('crypto').randomUUID() });
    }
    const scope = await history.visitEligibility({ customerId: f.customerId, propertyId: f.property.id }, knex);
    const eligibleVisitIds = await history.eligibleVisitIds(scope, knex);
    expect(Number((await getLatestTurfHeight(f.customerId, knex, { eligibleVisitIds })).manual_height_in)).toBe(3);
    expect(await getTurfHeightTrend(f.customerId, 12, knex, null, { eligibleVisitIds })).toHaveLength(1);
    // Read a real table query through the exact restriction the report uses.
    const query = history.restrictVisitHistory(knex('lawn_water_intake_snapshots').where({ customer_id: f.customerId }), 'lawn_water_intake_snapshots', eligibleVisitIds, knex);
    const base = { customer_id: f.customerId, service_date: '2026-01-01', water_gap_inches: 0.5 };
    await knex('lawn_water_intake_snapshots').insert([
      { ...base, service_id: ownVisit.id, service_record_id: ownRecord.id },
      { ...base, service_id: otherVisit.id, service_record_id: otherRecord.id },
      { ...base, service_id: ownVisit.id, service_record_id: null, service_date: '2026-01-02' },
    ]);
    expect(await query.clone()).toHaveLength(2);
    // Retarget a record: the snapshot's direct id alone no longer proves it.
    await knex('service_records').where({ id: ownRecord.id }).update({ scheduled_service_id: otherVisit.id });
    expect(await query.clone()).toHaveLength(1);
  });
});
