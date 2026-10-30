// The Home misting card's reader (services/misting-portal.js) against real
// PostgreSQL, synthetic records, rolled back after every test. Dark behind
// GATE_MOSQUITO_MISTING (the route owns the gate; this reader is gate-blind).
//
// The two misting tables are created here, in a private schema that this suite
// puts first on each test transaction's search_path and drops afterwards, so it
// runs both before and after the migration that owns them is applied, whatever
// extra columns that migration adds.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
const { randomUUID } = require('node:crypto');
const { getPortalMistingSystem } = require('../services/misting-portal');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');

const NOW = new Date('2026-10-30T20:00:00Z'); // 4:00 PM EDT, Fri Oct 30 2026
const TIMES = ['06:30', '19:30', '22:30'];

postgres('misting portal reader against PostgreSQL', () => {
  let database;
  let trx;
  let schema;
  let customerId;
  let planServiceId;
  let otherServiceId;
  let home; // the customer's primary customer_properties row
  let sequence;

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    schema = `misting_portal_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`
      CREATE TABLE ??.misting_calibrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
        property_id uuid NULL REFERENCES public.customer_properties(id) ON DELETE CASCADE,
        installed_on date NOT NULL,
        mist_times text[] NOT NULL,
        voided_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`, [schema]);
    await database.raw(`
      CREATE TABLE ??.misting_refills (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
        calibration_id uuid NOT NULL REFERENCES ??.misting_calibrations(id) ON DELETE CASCADE,
        property_id uuid NULL REFERENCES public.customer_properties(id) ON DELETE CASCADE,
        refilled_on date NOT NULL,
        voided_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`, [schema, schema]);
  }, 30000);

  beforeEach(async () => {
    trx = await database.transaction();
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    require('../models/db').connection = trx;
    sequence = 0;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    const existing = await trx('services').where({ service_key: 'mosquito_misting_service' }).first('id');
    planServiceId = existing ? existing.id : (await trx('services').insert({ service_key: 'mosquito_misting_service', name: 'Synthetic misting plan' }).returning('id'))[0].id;
    home = await property(true);
    otherServiceId = (await trx('services').insert({ service_key: `synthetic_other_${customerId.slice(0, 8)}`, name: 'Synthetic other service' }).returning('id'))[0].id;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => {
    if (database && schema) await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database?.destroy();
  });

  // Rows get strictly increasing created_at, so "newest" is never a tie.
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++));
  async function property(isPrimary) {
    const id = randomUUID();
    await trx('customer_properties').insert({ id, customer_id: customerId, is_primary: isPrimary, active: true, address_line1: `${100 + sequence} Test Lane`, city: 'Test City', state: 'FL', zip: '00000' });
    return { id, is_primary: isPrimary };
  }
  const scopeFor = (property) => ({ customerId, enabled: true, multi: true, scoped: true, closed: false, property });
  const OPEN_SCOPE = () => ({ customerId, enabled: true, multi: false, scoped: false, closed: false, property: null });
  async function calibration(overrides = {}) {
    const row = { id: randomUUID(), customer_id: customerId, property_id: home.id, installed_on: '2026-05-02', mist_times: TIMES, voided_at: null, created_at: stamp(), ...overrides };
    await trx('misting_calibrations').insert(row);
    return row;
  }
  async function refill(calibrationRow, overrides = {}) {
    const row = { id: randomUUID(), customer_id: customerId, calibration_id: calibrationRow.id, property_id: calibrationRow.property_id, refilled_on: '2026-10-12', voided_at: null, created_at: stamp(), ...overrides };
    await trx('misting_refills').insert(row);
    return row;
  }
  async function visit(overrides = {}) {
    const row = { id: randomUUID(), customer_id: customerId, service_id: planServiceId, scheduled_date: '2026-11-12', service_type: 'Synthetic misting plan visit', status: 'confirmed', ...overrides };
    await trx('scheduled_services').insert(row);
    return row;
  }
  const read = (scope = OPEN_SCOPE(), now = NOW) => getPortalMistingSystem({ customerId, scope, now, knex: trx });

  test('no calibration: null', async () => {
    await visit();
    expect(await read()).toBeNull();
  });

  test('a calibration but no upcoming plan visit: null (a cancelled plan drops the card)', async () => {
    await calibration();
    expect(await read()).toBeNull();
    // Not a plan visit: another service, a past plan visit, a cancelled plan visit.
    await visit({ service_id: otherServiceId, scheduled_date: '2026-11-05' });
    await visit({ scheduled_date: '2026-10-29' });
    await visit({ scheduled_date: '2026-11-06', status: 'cancelled' });
    expect(await read()).toBeNull();
  });

  test('full case: all five fields, with a fixed now', async () => {
    const cal = await calibration();
    await refill(cal, { refilled_on: '2026-09-01' });
    await refill(cal, { refilled_on: '2026-10-12' });
    await visit({ scheduled_date: '2026-11-12' });
    await visit({ scheduled_date: '2026-11-05', window_start: '09:00' });
    await visit({ service_id: otherServiceId, scheduled_date: '2026-11-01' }); // not a misting plan visit
    expect(await read()).toEqual({
      installedOn: '2026-05-02',
      lastRefillOn: '2026-10-12',
      nextCheckOn: '2026-11-05',
      nextMistAt: '2026-10-30T23:30:00.000Z', // 7:30 PM EDT today
      mistTimes: TIMES,
    });
  });

  test('no refill yet: lastRefillOn is null; a plan visit today still counts as the next check', async () => {
    await calibration();
    await visit({ scheduled_date: '2026-10-30' });
    const system = await read();
    expect(system.lastRefillOn).toBeNull();
    expect(system.nextCheckOn).toBe('2026-10-30');
  });

  test('the newest live calibration is current; a voided one is ignored and the older one takes over', async () => {
    await calibration({ mist_times: ['07:00'] });
    const newer = await calibration({ mist_times: ['08:00'] });
    await visit();
    expect((await read()).mistTimes).toEqual(['08:00']);
    await trx('misting_calibrations').where({ id: newer.id }).update({ voided_at: new Date() });
    expect((await read()).mistTimes).toEqual(['07:00']);
  });

  test('a voided refill is ignored', async () => {
    const cal = await calibration();
    await refill(cal, { refilled_on: '2026-09-01' });
    await refill(cal, { refilled_on: '2026-10-12', voided_at: new Date() });
    await visit();
    expect((await read()).lastRefillOn).toBe('2026-09-01');
  });

  test('a pending dispatch-owned follow-up visit is not the next check; a confirmed or customer-confirmed one is', async () => {
    await calibration();
    const owned = DISPATCH_OWNED_PENDING_SOURCE_ACTIONS[0];
    await visit({ scheduled_date: '2026-11-03', status: 'pending', source_action: owned, customer_confirmed: false });
    await visit({ scheduled_date: '2026-11-12' });
    expect((await read()).nextCheckOn).toBe('2026-11-12');
    await visit({ scheduled_date: '2026-11-05', status: 'pending', source_action: owned, customer_confirmed: true });
    expect((await read()).nextCheckOn).toBe('2026-11-05');
  });

  test('two properties: each scope sees only its own system; calibrations carry the primary\'s real id', async () => {
    const primary = home;
    const second = await property(false);
    const primaryCal = await calibration({ property_id: primary.id, mist_times: ['06:30'] });
    const secondCal = await calibration({ property_id: second.id, installed_on: '2026-06-10', mist_times: ['18:00'] });
    await refill(primaryCal, { refilled_on: '2026-10-01' });
    await refill(secondCal, { refilled_on: '2026-10-20' });
    await visit({ property_id: null, scheduled_date: '2026-11-12' }); // unstamped visits belong to the primary
    await visit({ property_id: second.id, scheduled_date: '2026-11-20' });

    expect(await read(scopeFor(primary))).toEqual({
      installedOn: '2026-05-02', lastRefillOn: '2026-10-01', nextCheckOn: '2026-11-12',
      nextMistAt: '2026-10-31T10:30:00.000Z', mistTimes: ['06:30'],
    });
    expect(await read(scopeFor(second))).toEqual({
      installedOn: '2026-06-10', lastRefillOn: '2026-10-20', nextCheckOn: '2026-11-20',
      nextMistAt: '2026-10-30T22:00:00.000Z', mistTimes: ['18:00'],
    });
  });

  test('a NULL-property calibration is never current: a newer NULL row is ignored under a scoped primary and an unscoped single home', async () => {
    await calibration({ property_id: home.id, mist_times: ['07:00'] });
    await calibration({ property_id: null, mist_times: ['08:00'] }); // newer, its property row was deleted
    await visit();
    expect((await read(scopeFor(home))).mistTimes).toEqual(['07:00']);
    expect((await read(OPEN_SCOPE())).mistTimes).toEqual(['07:00']);
    // Only a NULL row left: no current calibration at all, so no card.
    await trx('misting_calibrations').where({ customer_id: customerId }).whereNotNull('property_id').delete();
    expect(await read(scopeFor(home))).toBeNull();
    expect(await read(OPEN_SCOPE())).toBeNull();
  });

  test('a calibration at a retired property shows no card, scoped or not; an older live one still wins', async () => {
    const retired = await property(false);
    await trx('customer_properties').where({ id: retired.id }).update({ active: false });
    await calibration({ property_id: retired.id, mist_times: ['08:00'] });
    await visit();
    expect(await read(OPEN_SCOPE())).toBeNull();
    expect(await read(scopeFor(retired))).toBeNull();
    // A newer row at the retired property never hides the older one at the live home.
    await trx('misting_calibrations').where({ property_id: retired.id }).update({ created_at: new Date('2026-12-01T00:00:00Z') });
    await calibration({ property_id: home.id, mist_times: ['07:00'] });
    expect((await read(OPEN_SCOPE())).mistTimes).toEqual(['07:00']);
  });

  test('a refill is matched to the current calibration\'s exact property', async () => {
    const second = await property(false);
    const homeCal = await calibration({ property_id: home.id });
    const secondCal = await calibration({ property_id: second.id });
    await refill(homeCal, { refilled_on: '2026-10-01' });
    await refill(secondCal, { refilled_on: '2026-10-25' });
    await visit();
    expect((await read(scopeFor(home))).lastRefillOn).toBe('2026-10-01');
  });

  test('a house with no system of its own sees none, and a closed scope sees nothing', async () => {
    const primary = home;
    const second = await property(false);
    await calibration({ property_id: second.id });
    await visit({ property_id: second.id });
    expect(await read(scopeFor(primary))).toBeNull();
    expect(await read({ customerId, enabled: true, multi: false, scoped: true, closed: true, property: null })).toBeNull();
    expect(await read(scopeFor(second))).not.toBeNull();
  });

  test('the next mist rolls to tomorrow after the last time of the day', async () => {
    await calibration();
    await visit();
    // 11:00 PM EDT Oct 30: past 10:30 PM, so tomorrow 6:30 AM EDT.
    const system = await read(OPEN_SCOPE(), new Date('2026-10-31T03:00:00Z'));
    expect(system.nextMistAt).toBe('2026-10-31T10:30:00.000Z');
    // Exactly on a mist time is not "after now": the next one is 10:30 PM.
    const onTheMark = await read(OPEN_SCOPE(), new Date('2026-10-30T23:30:00Z'));
    expect(onTheMark.nextMistAt).toBe('2026-10-31T02:30:00.000Z');
  });

  test('DST fall-back (Sunday Nov 1, 2026 ET): instants follow the offset in force', async () => {
    await calibration();
    await visit({ scheduled_date: '2026-11-12' });
    // 11:00 PM EDT Oct 31: rolls into Nov 1, which is EST (UTC-5): 6:30 AM EST = 11:30Z.
    expect((await read(OPEN_SCOPE(), new Date('2026-11-01T03:00:00Z'))).nextMistAt).toBe('2026-11-01T11:30:00.000Z');
    // 7:00 AM EST Nov 1: the next mist is 7:30 PM EST = 00:30Z Nov 2.
    expect((await read(OPEN_SCOPE(), new Date('2026-11-01T12:00:00Z'))).nextMistAt).toBe('2026-11-02T00:30:00.000Z');
    // 10:00 PM EDT Oct 31: still today (EDT), 10:30 PM EDT = 02:30Z Nov 1.
    expect((await read(OPEN_SCOPE(), new Date('2026-11-01T02:00:00Z'))).nextMistAt).toBe('2026-11-01T02:30:00.000Z');
  });
});
