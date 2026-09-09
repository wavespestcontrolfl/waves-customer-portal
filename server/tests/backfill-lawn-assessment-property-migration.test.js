const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const migration = require('../models/migrations/20260907000020_backfill_lawn_assessment_property');

describeDb('lawn property backfill conditional writes', () => {
  let owned;
  let knex;
  beforeEach(async () => { owned = await createLawnHistoryDb(); knex = owned.knex; });
  afterEach(async () => { if (owned) await owned.dispose(); });
  const state = async () => JSON.parse((await knex('system_settings').where({ key: migration.STATE_KEY }).first()).value);

  test('copies both visit paths including unconfirmed retakes; skips contradictory evidence', async () => {
    const f = await fixture(knex);
    const other = await fixture(knex);
    const visit = await f.visit();
    const record = await f.record(visit);
    const a = await f.assessment(visit, { property_id: null, confirmed_by_tech: false });
    const b = await f.assessment(null, { service_record_id: record.id });
    const secondVisit = await f.visit(-5);
    const secondRecord = await f.record(secondVisit);
    const conflict = await f.assessment(visit, { property_id: null, service_record_id: secondRecord.id });
    const missing = await f.assessment(null, { service_id: randomUUID() });
    const cross = await f.assessment(await other.visit(), { property_id: null });
    const unproven = await f.assessment(await f.visit(-2, { property_id: null }));
    await migration.up(knex);
    expect((await state()).linked).toEqual({ [a.id]: f.property.id, [b.id]: f.property.id });
    expect((await state()).skipped).toMatchObject({ conflict: 1, noVisit: 1, crossCustomer: 1, noProperty: 1 });
    for (const row of [conflict, missing, cross, unproven]) {
      expect((await knex('lawn_assessments').where({ id: row.id }).first()).property_id).toBeNull();
    }
  });

  test.each(['record', 'visit'])('a concurrent %s relink is checked by PostgreSQL at update time', async (race) => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const record = await f.record(visit);
    const nextVisit = await f.visit(-1);
    const row = await f.assessment(null, { service_record_id: record.id });
    let fired = false;
    // The hook changes a real row on another pooled connection after the scan.
    // The migration's actual SQL, not a fake builder, must reject that write.
    const interleaved = new Proxy(knex, {
      apply(target, receiver, args) {
        const query = Reflect.apply(target, receiver, args);
        if (args[0] !== 'lawn_assessments') return query;
        const update = query.update.bind(query);
        query.update = async (patch) => {
          if (!fired) {
            fired = true;
            if (race === 'record') await knex('service_records').where({ id: record.id }).update({ scheduled_service_id: nextVisit.id });
            else await knex('scheduled_services').where({ id: visit.id }).update({ property_id: null });
          }
          return update(patch);
        };
        return query;
      },
    });
    await migration.up(interleaved);
    expect(fired).toBe(true);
    expect((await knex('lawn_assessments').where({ id: row.id }).first()).property_id).toBeNull();
    expect((await state()).skipped.changed).toBe(1);
  });

  test('second up is a no-op; down preserves values changed by an operator and new runtime stamps', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const a = await f.assessment(visit, { property_id: null });
    const b = await f.assessment(visit, { property_id: null });
    await migration.up(knex);
    const before = await state();
    const [otherProperty] = await knex('customer_properties').insert({ customer_id: f.customerId }).returning('*');
    await knex('lawn_assessments').where({ id: a.id }).update({ property_id: otherProperty.id });
    const runtime = await f.assessment(visit);
    await migration.up(knex);
    expect(await state()).toEqual(before);
    await migration.down(knex);
    expect((await knex('lawn_assessments').where({ id: a.id }).first()).property_id).toBe(otherProperty.id);
    expect((await knex('lawn_assessments').where({ id: b.id }).first()).property_id).toBeNull();
    expect((await knex('lawn_assessments').where({ id: runtime.id }).first()).property_id).toBe(f.property.id);
    expect(await knex('system_settings').where({ key: migration.STATE_KEY }).first()).toBeUndefined();
  });
});
