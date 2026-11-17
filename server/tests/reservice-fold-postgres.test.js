/**
 * findFoldTarget (services/reservice-fold.js, GATE_RESERVICE_FOLD, owner 2026-11-17) on a real migrated PostgreSQL: which
 * plan visit a re-service on a date folds into. Every case runs in a transaction that is rolled back; synthetic records only.
 * Dates are fixed, never the clock: the re-service is on 2099-03-02 and a plan visit N days later is on 2099-03-(2+N).
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const RESERVICE_DAY = '2099-03-02';
const later = (days) => {
  const d = new Date(Date.UTC(2099, 2, 2 + days, 12));
  return d.toISOString().slice(0, 10);
};

describeOrSkip('findFoldTarget', () => {
  let db; let findFoldTarget; let trx; let customerId; let primaryId; let rentalId; let pestServiceId; let lawnServiceId;

  beforeAll(async () => {
    db = require('../models/db');
    ({ findFoldTarget } = require('../services/reservice-fold'));
    pestServiceId = (await db('services').where({ name: 'Quarterly Pest Control Service' }).first('id')).id;
    lawnServiceId = (await db('services').where({ service_key: 'lawn_fertilization' }).first('id')).id;
  });
  afterAll(async () => { await db.destroy(); });

  beforeEach(async () => {
    trx = await db.transaction();
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'FoldTest', phone: `+1555${customerId.slice(0, 7)}`, active: true });
    [{ id: primaryId }] = await trx('customer_properties').insert({ customer_id: customerId, is_primary: true, active: true, address_line1: '1 Fold Primary Way', city: 'Bradenton', zip: '34201' }).returning('id');
    [{ id: rentalId }] = await trx('customer_properties').insert({ customer_id: customerId, is_primary: false, active: true, address_line1: '2 Fold Rental Way', city: 'Bradenton', zip: '34201' }).returning('id');
  });
  afterEach(async () => { await trx.rollback(); });

  async function plan(day, extra = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: later(day), status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control Service', service_id: pestServiceId, window_start: '09:00', window_end: '10:00', ...extra,
    });
    return id;
  }
  const find = (extra = {}) => findFoldTarget(trx, { customerId, lane: 'pest', date: RESERVICE_DAY, propertyId: null, ...extra });

  test('a plan visit 5 days later folds; the answer carries what the move and the notice need', async () => {
    const id = await plan(5, { technician_id: null, customer_request: 'x', notes: 'Dog in yard' });
    expect(await find()).toEqual({
      id, customer_id: customerId, property_id: null, service_id: pestServiceId, is_callback: false,
      scheduled_date: later(5), window_start: '09:00:00', window_end: '10:00:00', service_type: 'Quarterly Pest Control Service',
      technician_id: null, status: 'pending', customer_request: 'x', notes: 'Dog in yard',
    });
  });

  test('the window is inclusive: 14 days later folds, 15 days later does not', async () => {
    const id = await plan(14);
    expect((await find()).id).toBe(id);
    await trx('scheduled_services').where({ id }).update({ scheduled_date: later(15) });
    expect(await find()).toBeNull();
  });

  test('a plan visit on the same day folds; one the day before does not', async () => {
    const id = await plan(0);
    expect((await find()).id).toBe(id);
    await trx('scheduled_services').where({ id }).update({ scheduled_date: later(-1) });
    expect(await find()).toBeNull();
  });

  test('the earliest plan visit in range wins, then the earliest start', async () => {
    await plan(9);
    const early = await plan(6, { window_start: '13:00', window_end: '14:00' });
    const earlier = await plan(6, { window_start: '08:00', window_end: '09:00' });
    expect((await find()).id).toBe(earlier);
    await trx('scheduled_services').where({ id: earlier }).update({ status: 'cancelled' });
    expect((await find()).id).toBe(early);
  });

  test('the other line does not match: a lawn plan visit is not a pest fold, and the lawn lane finds it', async () => {
    const id = await plan(5, { service_type: 'Lawn Fertilization & Weed Control Service', service_id: lawnServiceId });
    expect(await find()).toBeNull();
    expect((await find({ lane: 'lawn' })).id).toBe(id);
  });

  test('a cancelled, completed, skipped or no-show visit does not fold', async () => {
    for (const status of ['cancelled', 'completed', 'skipped', 'no_show', 'en_route']) {
      const id = await plan(5, { status });
      expect(await find()).toBeNull();
      await trx('scheduled_services').where({ id }).del();
    }
    const confirmed = await plan(5, { status: 'confirmed' });
    expect((await find()).id).toBe(confirmed);
  });

  test('a one-time visit, a callback and a visit mid Quick Move hand-off do not fold', async () => {
    await plan(5, { is_recurring: false });
    await plan(6, { is_callback: true });
    await plan(7, { customer_pick_by: new Date('2099-03-01T12:00:00Z') });
    expect(await find()).toBeNull();
  });

  test('another customer\'s plan visit does not fold', async () => {
    const other = randomUUID();
    await trx('customers').insert({ id: other, first_name: 'Synthetic', last_name: 'FoldOther', phone: `+1555${other.slice(0, 7)}`, active: true });
    await plan(5, { customer_id: other });
    expect(await find()).toBeNull();
  });

  test('a visit on a shared stop does not fold, even when its partner is finished; the answer carries the status the move pins', async () => {
    const [{ id: visitId }] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: later(5), stop_base_key: `fold-${randomUUID()}`, created_by: 'test' }).returning('id');
    const id = await plan(5, { visit_id: visitId });
    const partner = await plan(5, { visit_id: visitId, service_type: 'Lawn Fertilization & Weed Control Service', service_id: lawnServiceId });
    expect(await find()).toBeNull();
    await trx('scheduled_services').where({ id: partner }).update({ status: 'completed' });
    expect(await find()).toBeNull();
    await trx('scheduled_services').where({ id }).update({ visit_id: null, status: 'confirmed' });
    expect(await find()).toMatchObject({ id, status: 'confirmed' });
  });

  describe('premise', () => {
    test('a re-service on the primary premise matches a plan visit with no property and one on the primary property', async () => {
      const unlinked = await plan(8, { property_id: null });
      expect((await find({ propertyId: null })).id).toBe(unlinked);
      await trx('scheduled_services').where({ id: unlinked }).update({ property_id: primaryId });
      expect((await find({ propertyId: null })).id).toBe(unlinked);
      expect((await find({ propertyId: primaryId })).id).toBe(unlinked);
    });

    test('a re-service on the primary premise does not match a plan visit at another property', async () => {
      await plan(8, { property_id: rentalId });
      expect(await find({ propertyId: null })).toBeNull();
      expect(await find({ propertyId: primaryId })).toBeNull();
    });

    test('a re-service at a non-primary property matches only plan visits on exactly that property', async () => {
      await plan(5, { property_id: null });
      await plan(6, { property_id: primaryId });
      expect(await find({ propertyId: rentalId })).toBeNull();
      const rental = await plan(9, { property_id: rentalId });
      expect((await find({ propertyId: rentalId })).id).toBe(rental);
    });
  });

  test('a missing customer, lane or a malformed date finds nothing', async () => {
    await plan(5);
    expect(await find({ customerId: null })).toBeNull();
    expect(await find({ lane: null })).toBeNull();
    expect(await find({ date: 'soon' })).toBeNull();
  });
});
