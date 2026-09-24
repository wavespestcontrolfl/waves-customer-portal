// Owner ruling 2026-09-24: the before/after slider pairs photos by zone, but
// only 'front' is the same spot every visit. 'close_up' and 'trouble' are a
// different spot each time and must never pair across visits, even when both
// sides happen to record the same zone value. Legacy 'back'/'side' rows
// (recorded before this rename) still pair with each other.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
jest.mock('../services/photos', () => ({
  CUSTOMER_DWELL_TTL_SECONDS: 60,
  getViewUrl: jest.fn((s3Key) => Promise.resolve(s3Key)),
}));

const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const { buildLawnAssessmentReportData } = require('../services/service-report/report-data');

describeDb('lawn before/after photo pairing by zone', () => {
  let owned;
  let knex;
  beforeAll(async () => { owned = await createLawnHistoryDb(); knex = owned.knex; });
  afterAll(async () => { if (owned) await owned.dispose(); });

  async function addPhoto(assessmentId, customerId, zone, s3Key) {
    await knex('lawn_assessment_photos').insert({
      assessment_id: assessmentId, customer_id: customerId, s3_key: s3Key, zone, customer_visible: true,
    });
  }

  // Builds a two-visit fixture (older "before" + a linked "current" record
  // report-data resolves by service_record_id) and returns both assessments
  // plus the `service` object the report call takes.
  async function twoVisitFixture(f) {
    const before = await f.assessment(await f.visit(-10));
    const currentVisit = await f.visit(-1);
    const record = await f.record(currentVisit);
    const after = await f.assessment(currentVisit, { service_record_id: record.id });
    return { before, after, service: { ...record, service_line: 'lawn' } };
  }

  test('front zones pair across visits', async () => {
    const f = await fixture(knex);
    const { before, after, service } = await twoVisitFixture(f);
    await addPhoto(before.id, f.customerId, 'front', 'before-front');
    await addPhoto(after.id, f.customerId, 'front', 'after-front');
    const report = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    expect(report.beforeAfter.before.photoUrl).toBe('before-front');
    expect(report.beforeAfter.after.photoUrl).toBe('after-front');
  });

  test('close_up never pairs across visits, and is not used as a best-vs-best fallback either', async () => {
    const f = await fixture(knex);
    const { before, after, service } = await twoVisitFixture(f);
    await addPhoto(before.id, f.customerId, 'close_up', 'before-close-up');
    await addPhoto(after.id, f.customerId, 'close_up', 'after-close-up');
    const report = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    // Two close-ups are different spots: no comparison at all.
    expect(report.beforeAfter.before.photoUrl).toBeNull();
    expect(report.beforeAfter.after.photoUrl).toBeNull();
  });

  test('a trouble photo is never shown as the "before" of a front photo', async () => {
    const f = await fixture(knex);
    const { before, after, service } = await twoVisitFixture(f);
    await addPhoto(before.id, f.customerId, 'trouble', 'before-trouble');
    await addPhoto(after.id, f.customerId, 'front', 'after-front');
    const report = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    expect(report.beforeAfter.before.photoUrl).toBeNull();
    expect(report.beforeAfter.after.photoUrl).toBeNull();
  });

  test('unlabeled photos still fall back to best-vs-best, skipping close-ups', async () => {
    const f = await fixture(knex);
    const { before, after, service } = await twoVisitFixture(f);
    await addPhoto(before.id, f.customerId, null, 'before-unlabeled');
    await addPhoto(after.id, f.customerId, 'close_up', 'after-close-up');
    await addPhoto(after.id, f.customerId, null, 'after-unlabeled');
    const report = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    expect(report.beforeAfter.before.photoUrl).toBe('before-unlabeled');
    expect(report.beforeAfter.after.photoUrl).toBe('after-unlabeled');
  });

  test('legacy back/side rows still pair with each other from history', async () => {
    const f = await fixture(knex);
    const { before, after, service } = await twoVisitFixture(f);
    await addPhoto(before.id, f.customerId, 'back', 'before-back');
    await addPhoto(after.id, f.customerId, 'back', 'after-back');
    const report = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    expect(report.beforeAfter.before.photoUrl).toBe('before-back');
    expect(report.beforeAfter.after.photoUrl).toBe('after-back');
  });

  test('zoned but disjoint pairable zones drop the after photo rather than show a false comparison', async () => {
    const f = await fixture(knex);
    const { before, after, service } = await twoVisitFixture(f);
    await addPhoto(before.id, f.customerId, 'front', 'before-front');
    await addPhoto(after.id, f.customerId, 'back', 'after-back');
    const report = await buildLawnAssessmentReportData(service, 'lawn', knex, { propertyHistoryEnabled: false });
    expect(report.beforeAfter.before.photoUrl).toBe('before-front');
    expect(report.beforeAfter.after.photoUrl).toBeNull();
  });
});
