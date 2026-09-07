const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const history = require('../services/lawn-assessment-history');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

describeDb('property lawn history through PostgreSQL', () => {
  let owned;
  let knex;
  beforeAll(async () => { owned = await createLawnHistoryDb(); knex = owned.knex; });
  afterAll(async () => { if (owned) await owned.dispose(); });

  test('record-only and service-linked attempts share the appointment date and winner', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const record = await f.record(visit);
    const installed = await f.assessment(null, { service_record_id: record.id, confirmed_at: new Date('2026-01-01T12:00:00Z') });
    const retake = await f.assessment(visit, { confirmed_at: new Date('2026-01-02T12:00:00Z') });
    await f.assessment(visit, { service_record_id: record.id, confirmed_by_tech: false });
    const chosen = await history.installedForVisit({ customerId: f.customerId, serviceId: visit.id, serviceRecordId: record.id }, knex);
    expect(chosen.id).toBe(installed.id);
    const resolved = await history.historyForAssessment(retake, { knex });
    expect(resolved.rows.map((row) => row.id)).toEqual([installed.id]);
    expect(resolved.current.visit_date).toBe(etDateString(addETDays(new Date(), -10)));
    const pinned = await history.historyForAssessment(retake, { knex, pinned: true });
    expect(pinned.current.id).toBe(retake.id);
    expect((await history.installedForVisit({ customerId: f.customerId, serviceId: visit.id }, knex)).id).toBe(installed.id);
  });

  test('NULL timestamps sort last, retaining database microseconds', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const first = await f.assessment(visit, { confirmed_at: '2026-01-01T12:00:00.000001Z' });
    const second = await f.assessment(visit, { confirmed_at: '2026-01-01T12:00:00.000002Z' });
    await f.assessment(visit, { confirmed_at: null });
    const result = await history.installedForVisit({ customerId: f.customerId, serviceId: visit.id }, knex);
    expect(result.id).toBe(second.id);
    expect(result.id).not.toBe(first.id);
  });

  test('other properties, conflicting links, and other customers never join the history', async () => {
    const f = await fixture(knex);
    const other = await fixture(knex);
    const visit = await f.visit(-20);
    const currentVisit = await f.visit(-5);
    const first = await f.assessment(visit);
    const current = await f.assessment(currentVisit);
    const foreignVisit = await other.visit(-15);
    await f.assessment(foreignVisit, { property_id: null });
    const foreignRecord = await other.record(foreignVisit);
    await f.assessment(visit, { service_record_id: foreignRecord.id });
    const [secondProperty] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    await f.assessment(await f.visit(-15, { property_id: secondProperty.id }));
    const mismatchedRecord = await f.record(currentVisit);
    await f.assessment(visit, { service_record_id: mismatchedRecord.id });
    await f.assessment(await f.visit(3));
    const result = await history.historyForAssessment(current, { knex });
    expect(result.rows.map((row) => row.id)).toEqual([first.id, current.id]);
    expect(result.previous.id).toBe(first.id);
  });

  test('legacy eligibility requires the sole unmoved property and compatible address', async () => {
    const f = await fixture(knex);
    const legacyVisit = await f.visit(-20, { property_id: null });
    const legacy = await f.assessment(legacyVisit);
    const current = await f.assessment(await f.visit(-2));
    await f.assessment(await f.visit(-15, { property_id: null, service_address_line1: '999 Different Street' }));
    expect((await history.historyForAssessment(current, { knex })).rows.map((row) => row.id)).toEqual([legacy.id, current.id]);
    await knex('property_preferences').insert({ customer_id: f.customerId, irrigation_home_changed_at: new Date() });
    expect((await history.historyForAssessment(current, { knex })).rows.map((row) => row.id)).toEqual([current.id]);
    const scope = await history.visitEligibility({ customerId: f.customerId }, knex);
    expect(await history.eligibleVisitIds(scope, knex)).toEqual([current.service_id]);
  });

  test('standalone records keep their service date; ambiguous properties have no delta', async () => {
    const f = await fixture(knex);
    const record = await f.record(null, { service_date: '2026-01-04' });
    const assessment = await f.assessment(null, { service_record_id: record.id });
    const resolved = await history.historyForAssessment(assessment, { knex });
    expect(resolved.current.visit_identity).toBe(`record:${record.id}`);
    expect(resolved.current.visit_date).toBe('2026-01-04');
    await knex('customer_properties').insert({ customer_id: f.customerId });
    const ambiguous = await history.historyForAssessment(assessment, { knex });
    expect(ambiguous.rows.map((row) => row.id)).toEqual([assessment.id]);
    expect(ambiguous.previous).toBeNull();
  });

  test.each([false, true])('a normally stamped legacy visit retains its current-only report when scope is ambiguous (pinned=%s)', async (pinned) => {
    const f = await fixture(knex);
    await f.assessment(await f.visit(-20));
    const visit = await f.visit(-1, {
      property_id: null, service_address_line1: f.property.address_line1,
      service_address_city: f.property.city, service_address_zip: f.property.zip,
    });
    const record = await f.record(visit);
    const installed = await f.assessment(visit, { service_record_id: record.id });
    const retake = await f.assessment(visit);
    await knex('customer_properties').insert({ customer_id: f.customerId });
    const resolved = await history.historyForAssessment(retake, { knex, pinned });
    expect(resolved.scope.propertyId).toBeNull();
    expect(resolved.rows.map((row) => row.id)).toEqual([pinned ? retake.id : installed.id]);
    expect(resolved.current.id).toBe(pinned ? retake.id : installed.id);
    expect(resolved.previous).toBeNull();
    expect(resolved.progress.previousDelta).toBeNull();
    expect(resolved.eligibleVisitIds).toEqual([]);
  });

  test('confirmed fallback stamps survive an additional property without broadening unstamped visit history', async () => {
    const f = await fixture(knex);
    const visit = await f.visit(-1, {
      property_id: null, service_address_line1: f.property.address_line1,
      service_address_city: f.property.city, service_address_zip: f.property.zip,
    });
    const assessment = await f.assessment(visit, { property_id: f.property.id });
    expect((await history.latestForCustomer(f.customerId, {}, knex)).map((row) => row.id)).toEqual([assessment.id]);
    await knex('customer_properties').insert({ customer_id: f.customerId });
    expect((await history.latestForCustomer(f.customerId, {}, knex)).map((row) => row.id)).toEqual([assessment.id]);
    const resolved = await history.historyForAssessment(assessment, { knex });
    expect(resolved.current.id).toBe(assessment.id);
    expect(resolved.scope.propertyId).toBe(f.property.id);
    expect(resolved.eligibleVisitIds).toEqual([]);
    await knex('scheduled_services').where({ id: visit.id }).update({ service_address_line1: '999 Different Street' });
    expect((await history.historyForAssessment(assessment, { knex })).current).toBeNull();
  });

  test.each([false, true])('a property reassignment refuses the original assessment, including signed pins (pinned=%s)', async (pinned) => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const assessment = await f.assessment(visit);
    const [otherProperty] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    await knex('scheduled_services').where({ id: visit.id }).update({ property_id: otherProperty.id });
    const resolved = await history.historyForAssessment(assessment, { knex, pinned });
    expect(resolved.scope.propertyId).toBeNull();
    expect(resolved.rows).toEqual([]);
    expect(resolved.current).toBeNull();
    expect(resolved.previous).toBeNull();
    expect(resolved.baseline).toBeNull();
    expect(resolved.progress.score).toBeNull();
  });

  test('an incompatible stamped address cannot use the unknown-property fallback', async () => {
    const f = await fixture(knex);
    const visit = await f.visit(-1, { property_id: null, service_address_line1: '999 Different Street' });
    const assessment = await f.assessment(visit);
    const resolved = await history.historyForAssessment(assessment, { knex });
    expect(resolved.rows).toEqual([]);
    expect(resolved.current).toBeNull();
  });

  test('a conflicting record-linked assessment cannot outrank the replacement property assessment', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const record = await f.record(visit);
    await f.assessment(visit, { service_record_id: record.id });
    const [otherProperty] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    const [movedVisit] = await knex('scheduled_services').where({ id: visit.id }).update({ property_id: otherProperty.id }).returning('*');
    const replacement = await f.assessment(movedVisit);
    const installed = await history.installedForVisit({ customerId: f.customerId, serviceId: visit.id, serviceRecordId: record.id }, knex);
    expect(installed.id).toBe(replacement.id);
    expect((await history.historyForAssessment(replacement, { knex })).current.id).toBe(replacement.id);
  });

  test('later reset leaves old reports alone and changes the current history identity', async () => {
    const f = await fixture(knex);
    const first = await f.assessment(await f.visit(-20));
    const second = await f.assessment(await f.visit(-10));
    const current = await f.assessment(await f.visit(0));
    const oldBefore = await history.historyForAssessment(second, { knex });
    const before = await history.historyForAssessment(current, { knex });
    await knex('lawn_baseline_resets').insert({
      customer_id: f.customerId, property_id: f.property.id, reset_by: 'fixture', reason: 'Fixture reset',
      new_baseline_id: second.id, created_at: parseETDateTime(`${etDateString(addETDays(new Date(), -5))}T12:00:00`),
    });
    const oldAfter = await history.historyForAssessment(second, { knex });
    expect(oldAfter.rows.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(oldAfter.identity).toBe(oldBefore.identity);
    const after = await history.historyForAssessment(current, { knex });
    expect(after.rows.map((row) => row.id)).toEqual([second.id, current.id]);
    expect(after.identity).not.toBe(before.identity);
    expect((await history.historyForAssessment(current, { knex })).identity).toBe(after.identity);
  });

  test('reset without a replacement uses its Eastern day and reconfirms re-key history', async () => {
    const f = await fixture(knex);
    const previous = await f.assessment(await f.visit(-5));
    const current = await f.assessment(await f.visit());
    const scope = await history.visitEligibility({ customerId: f.customerId }, knex);
    await knex('lawn_baseline_resets').insert({
      customer_id: f.customerId, reset_by: 'fixture', reason: 'Fixture reset', created_at: '2026-01-02T02:00:00Z',
    });
    expect((await history.applicableReset({ customerId: f.customerId, propertyId: scope.propertyId, throughVisitDate: '2026-01-02' }, knex)).boundary).toBe('2026-01-01');
    const latest = await history.historyForAssessment(previous, { knex });
    await knex('lawn_assessments').where({ id: current.id }).update({ confirmed_at: knex.raw('clock_timestamp()') });
    expect((await history.historyForAssessment(previous, { knex })).identity).not.toBe(latest.identity);
  });

  test('portal selects the primary property when there are multiple active properties', async () => {
    const f = await fixture(knex);
    const expected = await f.assessment(await f.visit());
    const [secondary] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    await f.assessment(await f.visit(-1, { property_id: secondary.id }));
    expect((await history.latestForCustomer(f.customerId, {}, knex)).map((row) => row.id)).toEqual([expected.id]);
  });

  test('live history excludes a confirmed assessment whose appointment moved into the future', async () => {
    const f = await fixture(knex);
    const earlier = await f.assessment(await f.visit(-5));
    const current = await f.assessment(await f.visit(0));
    await f.assessment(await f.visit(2));
    expect((await history.latestForCustomer(f.customerId, {}, knex)).map((row) => row.id)).toEqual([earlier.id, current.id]);
    expect((await history.latestForCustomer(f.customerId, { limit: 1 }, knex)).map((row) => row.id)).toEqual([current.id]);
  });
});
