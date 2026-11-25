/**
 * visit-groups.sameDriveSiblingIds on real PostgreSQL (GATE_CALL_GIVEN_VISIT_TEXTS, a visit text recipient's tracker link).
 *
 * The en-route fan-out moves the technician's current_job_id to the last sibling it advances, so a recipient of the FIRST row would
 * lose the truck. The read admits a sibling's id only when the one query sees it in the same visit, on the same technician, at the
 * same stop, itself en route in the same drive. A row moved to another stop or tech that still holds the old visit_id is never
 * admitted. Rows are committed and removed afterwards; synthetic data only.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));

(SKIP ? describe.skip : describe)('sameDriveSiblingIds on PostgreSQL', () => {
  let db;
  let VisitGroups;
  let customerId;
  let techA;
  let techB;
  let visitId;
  let propertyId;
  const START = new Date(Date.now() - 10 * 60 * 1000);
  const DATE = '2031-03-14';

  beforeAll(() => {
    db = require('../models/db');
    VisitGroups = require('../services/visit-groups');
  });
  afterAll(async () => { await db.destroy(); });

  const key = () => `same-drive-test:${Math.random().toString(36).slice(2)}`;
  const member = async (over = {}) => {
    const [{ id }] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: DATE, window_start: '09:00', window_end: '11:00', service_type: 'Pest Control',
      status: 'en_route', track_state: 'en_route', en_route_at: START, technician_id: techA, visit_id: visitId, property_id: propertyId, ...over,
    }).returning('id');
    return id;
  };
  const row = (id) => db('scheduled_services').where({ id }).first('id', 'visit_id', 'technician_id', 'en_route_at');

  beforeEach(async () => {
    [{ id: customerId }] = await db('customers').insert({ first_name: 'Phyllis', last_name: 'Roe', phone: `+1941${String(Math.floor(1e7 + Math.random() * 8e7)).slice(0, 7)}` }).returning('id');
    [{ id: propertyId }] = await db('customer_properties').insert({ customer_id: customerId, address_line1: '1 Zz Test Way', city: 'Parrish', state: 'FL', zip: '34219' }).returning('id');
    [{ id: techA }] = await db('technicians').insert({ name: 'Pat Zztech A' }).returning('id');
    [{ id: techB }] = await db('technicians').insert({ name: 'Pat Zztech B' }).returning('id');
    [{ id: visitId }] = await db('service_visits').insert({
      customer_id: customerId, scheduled_date: DATE, window_start: '09:00', window_end: '11:00', stop_base_key: key(), technician_id: techA, property_id: propertyId,
      status: 'open', created_by: 'test',
    }).returning('id');
  });
  afterEach(async () => {
    await db('scheduled_services').where({ customer_id: customerId }).del();
    await db('service_visits').where({ id: visitId }).del();
    await db('customer_properties').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
    await db('technicians').whereIn('id', [techA, techB]).del();
  });

  test('a sibling at the same stop, same tech, en route in the same drive is admitted (by either row)', async () => {
    const a = await member();
    const b = await member({ en_route_at: new Date(START.getTime() + 4000) });
    expect(await VisitGroups.sameDriveSiblingIds(await row(a))).toEqual([b]);
    expect(await VisitGroups.sameDriveSiblingIds(await row(b))).toEqual([a]);
  });

  test.each([
    ['moved to another stop (another date) but still holding the old visit_id', () => ({ scheduled_date: '2031-03-20' })],
    ['on another technician', () => ({ technician_id: techB })],
    ['unassigned', () => ({ technician_id: null })],
    ['its window no longer chains to the stop', () => ({ window_start: '15:00', window_end: '16:00' })],
    ['not en route', () => ({ status: 'confirmed', track_state: 'scheduled', en_route_at: null })],
    ['en route in another drive an hour later', () => ({ en_route_at: new Date(START.getTime() + 60 * 60 * 1000) })],
    ['cancelled', () => ({ status: 'cancelled' })],
  ])('a sibling %s is not admitted', async (_label, over) => {
    const a = await member();
    await member(over());
    expect(await VisitGroups.sameDriveSiblingIds(await row(a))).toEqual([]);
  });

  test('a sibling at another property is not admitted', async () => {
    const [{ id: otherPropertyId }] = await db('customer_properties').insert({ customer_id: customerId, address_line1: '2 Zz Test Way', city: 'Parrish', state: 'FL', zip: '34219' }).returning('id');
    const a = await member();
    await member({ property_id: otherPropertyId });
    expect(await VisitGroups.sameDriveSiblingIds(await row(a))).toEqual([]);
  });

  test('two addresses of one customer with NO property on file (both null) never share a truck: a null property_id admits nothing', async () => {
    // visit, row and sibling all without a property: rowStillAtVisitStop alone would call them one stop
    await db('service_visits').where({ id: visitId }).update({ property_id: null });
    const a = await member({ property_id: null });
    await member({ property_id: null, service_address_line1: '9 Other Address Rd' });
    expect(await VisitGroups.sameDriveSiblingIds(await row(a))).toEqual([]);
  });

  test('a null property on only one of the two rows admits nothing either way', async () => {
    const a = await member();
    const b = await member({ property_id: null });
    expect(await VisitGroups.sameDriveSiblingIds(await row(a))).toEqual([]);
    expect(await VisitGroups.sameDriveSiblingIds(await row(b))).toEqual([]);
  });

  test('this row itself moved to another tech or stop, or a visit that is not open, admits nothing', async () => {
    const a = await member();
    await member();
    const asked = await row(a);
    await db('scheduled_services').where({ id: a }).update({ technician_id: techB });
    expect(await VisitGroups.sameDriveSiblingIds({ ...asked, technician_id: techB })).toEqual([]);
    await db('scheduled_services').where({ id: a }).update({ technician_id: techA, scheduled_date: '2031-03-20' });
    expect(await VisitGroups.sameDriveSiblingIds(asked)).toEqual([]);
    await db('scheduled_services').where({ id: a }).update({ scheduled_date: DATE });
    await db('service_visits').where({ id: visitId }).update({ status: 'dissolved' });
    expect(await VisitGroups.sameDriveSiblingIds(asked)).toEqual([]);
  });

  test('an ungrouped row asks nothing', async () => {
    expect(await VisitGroups.sameDriveSiblingIds({ id: 'x', technician_id: techA, en_route_at: START, visit_id: null })).toEqual([]);
  });
});
