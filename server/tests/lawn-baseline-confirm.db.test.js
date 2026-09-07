const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const history = require('../services/lawn-assessment-history');
const { installConfirmedBaseline, resetBaseline, assessInsertFields, linkAssessmentServiceRecord } = require('../services/lawn-assessment');

describeDb('confirmed lawn baseline transactions', () => {
  let owned;
  let knex;
  beforeAll(async () => { owned = await createLawnHistoryDb(); knex = owned.knex; });
  afterAll(async () => { if (owned) await owned.dispose(); });
  const confirm = (row, updateData = {}) => installConfirmedBaseline({ assessmentId: row.id, updateData }, { knex });

  test('concurrent confirms leave one flag on the canonical installed row', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const a = await f.assessment(visit, { confirmed_by_tech: false });
    const b = await f.assessment(visit, { confirmed_by_tech: false });
    await Promise.all([confirm(a, { confirmed_at: new Date('2030-01-01T00:00:00Z') }), confirm(b, { confirmed_at: new Date('2000-01-01T00:00:00Z') })]);
    const installed = await history.installedForVisit({ customerId: f.customerId, serviceId: visit.id }, knex);
    const flags = await knex('lawn_assessments').where({ customer_id: f.customerId, is_baseline: true });
    expect(flags.map((row) => row.id)).toEqual([installed.id]);
    const latestTimestamp = await knex('lawn_assessments').where({ customer_id: f.customerId }).orderBy('confirmed_at', 'desc').first();
    expect(installed.id).toBe(latestTimestamp.id);
    expect(new Date(installed.confirmed_at).getTime()).toBeLessThan(Date.now() + 1000);
    expect(new Date(installed.confirmed_at).getTime()).toBeGreaterThan(Date.now() - 10000);
  });

  test('out-of-order first-visit confirmation takes baseline from the later visit', async () => {
    const f = await fixture(knex);
    const later = await f.assessment(await f.visit(-5), { confirmed_by_tech: false });
    const earlier = await f.assessment(await f.visit(-20), { confirmed_by_tech: false });
    expect((await confirm(later)).is_baseline).toBe(true);
    expect((await confirm(earlier)).is_baseline).toBe(true);
    expect((await knex('lawn_assessments').where({ id: later.id }).first()).is_baseline).toBe(false);
  });

  test('unlinked retake does not take the flag from the record-linked installed row', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const record = await f.record(visit);
    const a = await f.assessment(visit, { service_record_id: record.id });
    await confirm(a);
    const b = await f.assessment(visit, { confirmed_by_tech: false });
    expect((await confirm(b)).is_baseline).toBe(false);
    expect((await knex('lawn_assessments').where({ id: a.id }).first()).is_baseline).toBe(true);
    // The existing post-confirm backlink installs B into the record group.
    // Its baseline must change in the same commit as that priority change.
    const linked = await linkAssessmentServiceRecord({ assessment: b, serviceRecordId: record.id }, { knex });
    expect(linked.is_baseline).toBe(true);
    expect((await history.installedForVisit({ customerId: f.customerId, serviceId: visit.id }, knex)).id).toBe(b.id);
    expect((await knex('lawn_assessments').where({ id: a.id }).first()).is_baseline).toBe(false);
  });

  test('reset and confirmation serialize; reconfirming an old visit preserves the active reset', async () => {
    const f = await fixture(knex);
    const earlier = await f.assessment(await f.visit(-20), { confirmed_by_tech: false });
    const later = await f.assessment(await f.visit(-5), { confirmed_by_tech: false });
    await confirm(earlier);
    await Promise.all([
      resetBaseline(f.customerId, 'fixture', 'Fixture reset', { knex, propertyId: f.property.id, propertyHistoryEnabled: true }),
      confirm(later),
    ]);
    const reset = await knex('lawn_baseline_resets').where({ customer_id: f.customerId }).first();
    expect(reset).toBeTruthy();
    // If reset won, no replacement existed, so its new window starts today.
    const expected = reset.new_baseline_id ? later.id : null;
    await confirm(earlier);
    const flags = await knex('lawn_assessments').where({ customer_id: f.customerId, is_baseline: true });
    expect(flags.map((row) => row.id)).toEqual(expected ? [expected] : []);
    expect((await history.historyForAssessment(later, { knex })).rows.map((row) => row.id)).toEqual([earlier.id, later.id]);
  });

  test('reset with no replacement assigns the next confirmed visit as baseline', async () => {
    const f = await fixture(knex);
    const old = await f.assessment(await f.visit(-20));
    await confirm(old);
    await resetBaseline(f.customerId, 'fixture', 'Fixture reset', { knex, propertyId: f.property.id, propertyHistoryEnabled: true });
    const next = await f.assessment(await f.visit(0), { confirmed_by_tech: false });
    expect((await confirm(next)).is_baseline).toBe(true);
    expect((await knex('lawn_assessments').where({ id: old.id }).first()).is_baseline).toBe(false);
  });

  test('a move during assessment invalidates a sole-property fallback at confirmation', async () => {
    const f = await fixture(knex);
    const visit = await f.visit(-1, { property_id: null });
    const assessment = await f.assessment(visit, { property_id: f.property.id, confirmed_by_tech: false });
    await knex('property_preferences').insert({ customer_id: f.customerId, irrigation_home_changed_at: new Date() });
    const confirmed = await confirm(assessment);
    expect(confirmed.property_id).toBeNull();
    expect(confirmed.is_baseline).toBe(false);
    const fields = await assessInsertFields({ customerId: f.customerId, scheduledService: visit, preAnalysisMoveStamp: null, premiseProven: true }, knex);
    expect(fields.property_id).toBeNull();
  });

  test('explicit visit property survives a move, while another customer property is refused', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const assessment = await f.assessment(visit, { property_id: null, confirmed_by_tech: false });
    await knex('property_preferences').insert({ customer_id: f.customerId, irrigation_home_changed_at: new Date() });
    expect((await confirm(assessment)).property_id).toBe(f.property.id);
    const other = await fixture(knex);
    await expect(resetBaseline(f.customerId, 'fixture', 'Fixture reset', { knex, propertyId: other.property.id, propertyHistoryEnabled: true })).rejects.toThrow('Property does not belong');
  });

  test('sole-property fallback requires compatible premise evidence', async () => {
    const f = await fixture(knex);
    const visit = await f.visit(-1, { property_id: null });
    expect((await assessInsertFields({ customerId: f.customerId, scheduledService: visit, premiseProven: true }, knex)).property_id).toBe(f.property.id);
    expect((await assessInsertFields({ customerId: f.customerId, scheduledService: { ...visit, service_address_line1: '999 Different Street' }, premiseProven: true }, knex)).property_id).toBeNull();
    expect((await assessInsertFields({ customerId: f.customerId, premiseProven: false }, knex)).property_id).toBeNull();
  });

  test('prior context refuses an incompatible visit and a standalone multi-property scope', async () => {
    const f = await fixture(knex);
    const previous = await f.assessment(await f.visit(-20));
    const visit = await f.visit(-1, { property_id: null });
    const args = { customerId: f.customerId, scheduledService: visit, throughVisitDate: require('../utils/datetime-et').etCalendarDayOf(visit.scheduled_date) };
    expect((await history.historyBeforeVisit(args, knex)).previous.id).toBe(previous.id);
    expect((await history.historyBeforeVisit({ ...args, scheduledService: { ...visit, service_address_line1: '999 Different Street' } }, knex)).previous).toBeNull();
    await knex('customer_properties').insert({ customer_id: f.customerId });
    expect((await history.historyBeforeVisit({ ...args, scheduledService: null }, knex)).previous).toBeNull();
  });
});
