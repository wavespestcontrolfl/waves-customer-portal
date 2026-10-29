// Homes not placed + Add as unconfirmed (GATE_NEIGHBORHOOD_UNPLACED, owner
// ruling 2026-10-26), on real PostgreSQL transactions (rolled back); auth is a
// stub. All names, addresses and codes are synthetic.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => null) }));
const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-neighborhood-access');
const { runNamingPass } = require('../services/neighborhood-naming');

jest.setTimeout(30000);
postgres('homes not placed and add as unconfirmed', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const GATES = ['GATE_NEIGHBORHOOD_ACCESS', 'GATE_NEIGHBORHOOD_NAMING', 'GATE_NEIGHBORHOOD_UNPLACED'];
  const OLD = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
  // Starts with a digit, so the community name's title case leaves it as written.
  const tag = `7${randomUUID().slice(0, 7)}`;

  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const home = async ({ street = `100 Synthetic ${tag} Way`, zip = '34211', neighborhoodId = null, source = null, code = null } = {}) => {
    const customerId = randomUUID();
    const propertyId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Sample', last_name: `Owner ${tag}`, phone: '+12025550177', email: `${customerId}@example.invalid`,
      pipeline_stage: 'active_customer',
    });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: street, city: 'Lakewood Ranch', zip, latitude: 27.4, longitude: -82.45, active: true, address_key: randomUUID(),
      neighborhood_id: neighborhoodId, neighborhood_source: source,
    });
    if (code) await trx('property_preferences').insert({ customer_id: customerId, neighborhood_gate_code: code });
    return { customerId, propertyId };
  };
  // The naming state the county pass leaves, written for the home's current address.
  const stampZipOnly = (propertyId, subdivision = `HERON POINTE AT SAMPLE ${tag} PLACE PB1/1`) => trx.raw(
    `UPDATE customer_properties SET neighborhood_naming = jsonb_build_object(
       'addr', md5(coalesce(address_line1, '') || '|' || coalesce(zip, '')), 'county_answered', true,
       'zip_mismatch', jsonb_build_object('situs_zip', '34201', 'county', 'Manatee', 'subdivision', ?::text))
     WHERE id = ?`, [subdivision, propertyId],
  );
  const neighborhood = async (name) => {
    const [row] = await trx('neighborhoods')
      .insert({ name, county: 'Manatee', match_key: `manatee|${name.toLowerCase()}`, source: 'county', subdivision_names: JSON.stringify([]) })
      .returning('id');
    return row.id;
  };
  const mine = (homes) => homes.filter((h) => (h.customerName || '').endsWith(tag));

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    for (const g of GATES) process.env[g] = 'true';
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => {
    await trx.rollback();
    for (const g of GATES) {
      if (OLD[g] === undefined) delete process.env[g];
      else process.env[g] = OLD[g];
    }
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
  });

  test('the county pass keeps a lot that differs only by ZIP for the list, links nothing, and clears it on another answer', async () => {
    // Only this test's homes are due: park every other live home's county wait.
    await trx.raw(`UPDATE customer_properties SET neighborhood_naming = jsonb_build_object(
      'addr', md5(coalesce(address_line1, '') || '|' || coalesce(zip, '')), 'county_at', now(), 'county_answered', true)`);
    const zipOnly = await home();
    const otherStreet = await home({ street: `200 Synthetic ${tag} Way` });
    const lots = {
      [zipOnly.propertyId]: { county: 'Manatee', subdivision: `HERON POINTE AT SAMPLE ${tag} PLACE PB1/1`, situsAddress: `100 SYNTHETIC ${tag.toUpperCase()} WAY`, situsZip: '34201' },
      [otherStreet.propertyId]: { county: 'Manatee', subdivision: 'OTHER PB1/1', situsAddress: '900 ELSEWHERE WAY', situsZip: '34201' },
    };
    const ids = Object.keys(lots);
    const lookup = jest.fn(async () => lots[ids.shift()]);
    // The pass asks never-checked homes in a stable order; feed each its own lot.
    const order = await trx('customer_properties').whereIn('id', [zipOnly.propertyId, otherStreet.propertyId]).orderBy('id').pluck('id');
    ids.splice(0, ids.length, ...order);
    const r = await runNamingPass({ lookup, platLookup: async () => [] });
    expect(r.county).toEqual({ situs_mismatch: 2 });
    const state = async (id) => (await trx('customer_properties').where({ id }).first('neighborhood_id', 'neighborhood_naming'));
    expect(await state(zipOnly.propertyId)).toMatchObject({
      neighborhood_id: null,
      neighborhood_naming: { zip_mismatch: { situs_zip: '34201', county: 'Manatee', subdivision: `HERON POINTE AT SAMPLE ${tag} PLACE PB1/1` } },
    });
    expect((await state(otherStreet.propertyId)).neighborhood_naming.zip_mismatch).toBeNull();
  });

  test('the list: ZIP-only homes and saved codes on homes with no neighborhood; never a placed home, an office decision or an old address', async () => {
    const zipOnly = await home();
    await stampZipOnly(zipOnly.propertyId);
    const saved = await home({ street: `300 Synthetic ${tag} Way`, code: '2468' });
    const placed = await home({ street: `400 Synthetic ${tag} Way`, code: '1357', neighborhoodId: await neighborhood(`Placed ${tag}`), source: 'county' });
    const cleared = await home({ street: `500 Synthetic ${tag} Way`, code: '9753', source: 'office' });
    const moved = await home({ street: `600 Synthetic ${tag} Way` });
    await stampZipOnly(moved.propertyId);
    await trx('customer_properties').where({ id: moved.propertyId }).update({ address_line1: `601 Synthetic ${tag} Way` });

    const r = await call('GET', '/unplaced');
    expect(r.status).toBe(200);
    const homes = mine(r.body.homes);
    expect(homes.map((h) => h.propertyId)).toEqual([saved.propertyId, zipOnly.propertyId]);
    expect(homes[1]).toEqual({
      propertyId: zipOnly.propertyId, customerId: zipOnly.customerId, customerName: `Sample Owner ${tag}`,
      address: `100 Synthetic ${tag} Way, Lakewood Ranch`, zip: '34211', savedCode: false,
      countyLot: { zip: '34201', county: 'Manatee', community: `Heron Pointe at Sample ${tag} Place` },
    });
    expect(homes[0]).toMatchObject({ savedCode: true, countyLot: null });
    // No gate code leaks. Random ids and this file's random tag can hold those digits by chance
    // (#7016 CI: a customerId contained 1357), so blank them before matching.
    const visible = JSON.stringify(r.body)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .split(tag).join('<tag>');
    expect(visible).not.toMatch(/2468|1357|9753/);
    expect(homes.map((h) => h.propertyId)).not.toContain(placed.propertyId);
    expect(homes.map((h) => h.propertyId)).not.toContain(cleared.propertyId);

    // The office link (the existing picker route) places it: it leaves the list.
    const link = await call('PUT', `/properties/${zipOnly.propertyId}/neighborhood`, { create: { name: homes[1].countyLot.community, county: 'Manatee' } });
    expect(link.status).toBe(200);
    expect(mine((await call('GET', '/unplaced')).body.homes).map((h) => h.propertyId)).toEqual([saved.propertyId]);

    delete process.env.GATE_NEIGHBORHOOD_UNPLACED;
    expect(await call('GET', '/unplaced')).toEqual({ status: 404, body: { enabled: false } });
    expect((await call('GET', '/')).body.unplacedEnabled).toBe(false);
  });

  test('add as unconfirmed: needs confirm, no date, the live code stays live; ignored with the switch off; not a boolean = 400', async () => {
    const hood = await neighborhood(`Unconfirmed ${tag}`);
    const live = await call('POST', `/${hood}/entries`, { access_type: 'keypad', code: '1111' });
    expect(live.body.status).toBe('active');
    const old = await call('POST', `/${hood}/entries`, { access_type: 'keypad', code: '2222', unconfirmed: true });
    expect(old).toMatchObject({ status: 201, body: { status: 'needs_confirm' } });
    const rows = await trx('neighborhood_access').where({ neighborhood_id: hood }).orderBy('code').select('code', 'status', 'last_confirmed_at');
    expect(rows).toEqual([
      { code: '1111', status: 'active', last_confirmed_at: expect.any(Date) },
      { code: '2222', status: 'needs_confirm', last_confirmed_at: null },
    ]);
    expect((await call('POST', `/${hood}/entries`, { access_type: 'keypad', code: '3333', unconfirmed: 'yes' })).status).toBe(400);
    expect((await call('GET', '/')).body.unplacedEnabled).toBe(true);

    delete process.env.GATE_NEIGHBORHOOD_UNPLACED;
    const ignored = await call('POST', `/${hood}/entries`, { access_type: 'keypad', code: '4444', unconfirmed: true });
    expect(ignored.body.status).toBe('active');
  });
});
