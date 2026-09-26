/** Real PostgreSQL: private QA database only, synthetic schema rolled back per test. */
jest.setTimeout(15000);

jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  frozenVisitVerdict: jest.fn(async () => ({ frozen: false, reason: null })),
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const {
  prelockVisitContext,
  lockVisitContext,
  updatePrimaryVisits,
  clearMatchingPins,
} = require('../services/customer-geocode-review-visits');
const { recurringServiceAddress } = require('../services/booking/visit-financial-stamps');
const { frozenVisitVerdict } = require('../services/visit-groups');
const {
  CUSTOMER_ID,
  PRIMARY_ID,
  ACTOR_ID,
  ADDRESS,
  CORRECTED,
  createSchema,
  seedLocation,
  visitRow,
} = require('./fixtures/customer-geocode-review-visits-postgres');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const OLD_PIN = { latitude: 27.4981235, longitude: -82.5748125 };
const NEW_PIN = { latitude: 27.5000001, longitude: -82.5000001 };

postgres('customer geocode review visit propagation in PostgreSQL', () => {
  let database;
  let trx;
  let customer;
  let primary;

  beforeAll(() => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('A private QA database is required');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });

  afterAll(async () => database?.destroy());

  beforeEach(async () => {
    frozenVisitVerdict.mockResolvedValue({ frozen: false, reason: null });
    trx = await database.transaction();
    const schema = `geocode_visits_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    await createSchema(trx);
    ({ customer, primary } = await seedLocation(trx, {
      customerPin: OLD_PIN, propertyAddress: CORRECTED, propertyPin: NEW_PIN,
    }));
  });

  afterEach(async () => trx?.rollback());

  async function context(options = { verifyPin: true }) {
    const prelocked = await prelockVisitContext(trx, CUSTOMER_ID, {
      includeProtected: options.includeProtected,
    });
    return lockVisitContext(trx, CUSTOMER_ID, prelocked, {
      ...options, customer, primary,
    });
  }

  test('moves every child and its null-property visit parent through the canonical address writer', async () => {
    const visitId = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    await trx('service_visits').insert({
      id: visitId, customer_id: CUSTOMER_ID, property_id: null,
      scheduled_date: '2099-10-01', stop_base_key: `${CUSTOMER_ID}:2099-10-01`,
      stop_seq: 1, status: 'open',
    });
    await trx('scheduled_services').insert(ids.map(id => visitRow(id, { visit_id: visitId })));

    const locked = await context();
    const updated = await updatePrimaryVisits(
      trx, customer, primary, { ...CORRECTED }, NEW_PIN.latitude, NEW_PIN.longitude, locked, ACTOR_ID,
    );

    expect(updated.sort()).toEqual(ids.sort());
    const rows = await trx('scheduled_services').whereIn('id', ids).orderBy('id');
    for (const row of rows) {
      expect(row).toMatchObject({
        property_id: PRIMARY_ID, service_address_line1: CORRECTED.address_line1,
        zone: null, route_order: null,
      });
      expect(Number(row.lat)).toBe(Number(NEW_PIN.latitude.toFixed(6)));
    }
    expect(await trx('service_visits').where({ id: visitId }).first()).toMatchObject({
      property_id: PRIMARY_ID, stop_base_key: `${PRIMARY_ID}:2099-10-01`,
    });
    expect(await trx('audit_log').where({ action: 'appointment_address_changed' }).count('* as count').first())
      .toMatchObject({ count: '1' });
  });

  test('rejects an incomplete live group and a frozen group before address state can diverge', async () => {
    const visitId = randomUUID();
    const eligible = randomUUID();
    const ineligible = randomUUID();
    await trx('service_visits').insert({
      id: visitId, customer_id: CUSTOMER_ID, property_id: null,
      scheduled_date: '2099-10-01', stop_base_key: `${CUSTOMER_ID}:2099-10-01`, stop_seq: 1, status: 'open',
    });
    await trx('scheduled_services').insert([
      visitRow(eligible, { visit_id: visitId }),
      visitRow(ineligible, { visit_id: visitId, status: 'en_route' }),
    ]);
    await expect(context()).rejects.toMatchObject({ statusCode: 409, code: 'visit_changed', isOperational: true });
    expect((await trx('scheduled_services').where({ id: eligible }).first()).property_id).toBeNull();

    await trx('scheduled_services').where({ id: ineligible }).update({ status: 'confirmed' });
    frozenVisitVerdict.mockResolvedValue({ frozen: true, reason: 'issued_link' });
    const locked = await context();
    await expect(updatePrimaryVisits(
      trx, customer, primary, CORRECTED, NEW_PIN.latitude, NEW_PIN.longitude, locked, ACTOR_ID,
    )).rejects.toMatchObject({ statusCode: 409, reason: 'issued_link', isOperational: true });
    expect((await trx('scheduled_services').where({ id: eligible }).first()).property_id).toBeNull();
    expect((await trx('service_visits').where({ id: visitId }).first()).property_id).toBeNull();
    expect(await trx('audit_log')).toHaveLength(0);
  });

  test('uses database-scale pin matching while updating eligible rows and recurring defaults', async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    const independentId = randomUUID();
    await trx('scheduled_services').insert([
      visitRow(parentId, {
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { visit_count: 3, appointment_address: {
          property_id: null, service_address_line1: ADDRESS.address_line1,
          service_address_line2: null, service_address_city: ADDRESS.city,
          service_address_state: ADDRESS.state, service_address_zip: ADDRESS.zip,
          lat: 27.498124, lng: -82.574813, zone: 'legacy',
        } },
      }),
      visitRow(childId, { recurring_parent_id: parentId, lat: 27.498124, lng: -82.574813 }),
      visitRow(independentId, { lat: 27.4, lng: -82.4, route_order: 8 }),
    ]);

    const locked = await context();
    expect(await updatePrimaryVisits(
      trx, customer, primary, CORRECTED, NEW_PIN.latitude, NEW_PIN.longitude, locked, ACTOR_ID,
    )).toEqual([childId]);

    expect(await trx('scheduled_services').where({ id: childId }).first()).toMatchObject({
      property_id: PRIMARY_ID, service_address_line1: CORRECTED.address_line1,
      lat: '27.500000', lng: '-82.500000',
    });
    expect(await trx('scheduled_services').where({ id: independentId }).first()).toMatchObject({
      property_id: null, lat: '27.400000', lng: '-82.400000', route_order: 8,
    });
    const parent = await trx('scheduled_services').where({ id: parentId }).first();
    expect(parent.recurring_template_overrides.visit_count).toBe(3);
    expect(recurringServiceAddress(parent)).toMatchObject({
      property_id: PRIMARY_ID, service_address_line1: CORRECTED.address_line1,
      lat: NEW_PIN.latitude, lng: NEW_PIN.longitude, zone: null,
    });
  });

  test('skips an entirely unrelated group while still moving an eligible primary group', async () => {
    const eligibleVisitId = randomUUID();
    const unrelatedVisitId = randomUUID();
    const eligibleIds = [randomUUID(), randomUUID()];
    const unrelatedIds = [randomUUID(), randomUUID()];
    await trx('service_visits').insert([
      { id: eligibleVisitId, customer_id: CUSTOMER_ID, property_id: null,
        scheduled_date: '2099-10-01', stop_base_key: `${CUSTOMER_ID}:2099-10-01`, stop_seq: 1, status: 'open' },
      { id: unrelatedVisitId, customer_id: CUSTOMER_ID, property_id: randomUUID(),
        scheduled_date: '2099-10-01', stop_base_key: `secondary:${CUSTOMER_ID}:2099-10-01`, stop_seq: 1, status: 'open' },
    ]);
    await trx('scheduled_services').insert([
      ...eligibleIds.map(id => visitRow(id, { visit_id: eligibleVisitId })),
      ...unrelatedIds.map(id => visitRow(id, {
        visit_id: unrelatedVisitId, property_id: randomUUID(),
        service_address_line1: '900 Other Avenue', lat: 27.4, lng: -82.4,
      })),
    ]);

    const locked = await context();
    await updatePrimaryVisits(
      trx, customer, primary, CORRECTED, NEW_PIN.latitude, NEW_PIN.longitude, locked, ACTOR_ID,
    );

    expect((await trx('scheduled_services').whereIn('id', eligibleIds)).every(row => row.property_id === PRIMARY_ID)).toBe(true);
    expect((await trx('scheduled_services').whereIn('id', unrelatedIds))
      .every(row => row.service_address_line1 === '900 Other Avenue' && Number(row.lat) === 27.4)).toBe(true);
    expect(await trx('audit_log').where({ action: 'appointment_address_changed' })).toHaveLength(1);
  });

  test('rejected pins clear route position and matching templates while preserving independent coordinates', async () => {
    const parentId = randomUUID();
    const matchingId = randomUUID();
    const protectedId = randomUUID();
    const independentId = randomUUID();
    const template = {
      property_id: null, service_address_line1: ADDRESS.address_line1,
      service_address_line2: null, service_address_city: ADDRESS.city,
      service_address_state: ADDRESS.state, service_address_zip: ADDRESS.zip,
      lat: OLD_PIN.latitude, lng: OLD_PIN.longitude, zone: 'legacy',
    };
    await trx('scheduled_services').insert([
      visitRow(parentId, {
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { appointment_address: template },
      }),
      visitRow(matchingId, { lat: 27.498124, lng: -82.574813, route_order: 4 }),
      visitRow(protectedId, {
        lat: 27.498124, lng: -82.574813, route_order: 5, auto_dispatch_locked: true,
      }),
      visitRow(independentId, { lat: 27.4, lng: -82.4, route_order: 6 }),
    ]);

    const locked = await context({ includeProtected: true, verifyPin: false });
    await expect(clearMatchingPins(trx, customer, primary, OLD_PIN, locked)).resolves.toEqual({
      customer: 1, property: 0, visits: 2, templates: 1,
    });
    for (const id of [matchingId, protectedId]) {
      expect(await trx('scheduled_services').where({ id }).first()).toMatchObject({
        lat: null, lng: null, route_order: null,
      });
    }
    expect(await trx('scheduled_services').where({ id: independentId }).first()).toMatchObject({
      lat: '27.400000', lng: '-82.400000', route_order: 6,
    });
    expect(recurringServiceAddress(await trx('scheduled_services').where({ id: parentId }).first()))
      .toMatchObject({ lat: null, lng: null });
  });

  test('visit membership changes are part of the post-lock fence', async () => {
    const rowId = randomUUID();
    const visitId = randomUUID();
    await trx('scheduled_services').insert(visitRow(rowId));
    const prelocked = await prelockVisitContext(trx, CUSTOMER_ID);
    await trx('service_visits').insert({
      id: visitId, customer_id: CUSTOMER_ID, property_id: null,
      scheduled_date: '2099-10-01', stop_base_key: `${CUSTOMER_ID}:2099-10-01`, stop_seq: 1, status: 'open',
    });
    await trx('scheduled_services').where({ id: rowId }).update({ visit_id: visitId });

    await expect(lockVisitContext(trx, CUSTOMER_ID, prelocked, {
      customer, primary, verifyPin: true,
    })).rejects.toMatchObject({ statusCode: 409, code: 'visit_changed' });
  });

  test('a grouped row that becomes eligible after planning retries instead of taking the direct update path', async () => {
    const visitId = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    await trx('service_visits').insert({
      id: visitId, customer_id: CUSTOMER_ID, property_id: null,
      scheduled_date: '2099-10-01', stop_base_key: `${CUSTOMER_ID}:2099-10-01`, stop_seq: 1, status: 'open',
    });
    await trx('scheduled_services').insert(ids.map(id => visitRow(id, {
      visit_id: visitId, lat: 27.4, lng: -82.4,
    })));
    const prelocked = await prelockVisitContext(trx, CUSTOMER_ID);
    await trx('scheduled_services').where({ id: ids[0] }).update({ lat: null, lng: null });

    await expect(lockVisitContext(trx, CUSTOMER_ID, prelocked, {
      customer, primary, verifyPin: true,
    })).rejects.toMatchObject({ statusCode: 409, code: 'visit_changed', isOperational: true });
    expect((await trx('scheduled_services').whereIn('id', ids)).every(row => row.property_id == null)).toBe(true);
    expect(await trx('audit_log')).toHaveLength(0);
  });
});
