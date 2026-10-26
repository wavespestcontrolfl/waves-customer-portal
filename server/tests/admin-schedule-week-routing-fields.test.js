/**
 * Real migrated PostgreSQL, synthetic records, rolled back after every test.
 *
 * Admin Dispatch opens a one-screen Fast Complete sheet only for a schedule row
 * that carries `propertyId` (client/src/lib/dispatchCompletionRouting.js: the
 * sheet checks the routed premise against the live visit). The mobile week list
 * serves rows from GET /week, which used to leave the premise fields off, so a
 * visit opened from the week list always fell back to the long full form. This
 * pins that the week feed's rows carry the same routing fields as the day
 * feed's for the same visit, for a pest, a lawn and a tree and shrub visit.
 */
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'),
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));

// The day route also fetches current weather directly. Keep these database
// contracts independent of the network as well as the mocked rain forecast.
let weatherFetch;
beforeEach(() => {
  weatherFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ current: { temperature_2m: 75, wind_speed_10m: 5, precipitation_probability: 0 } }),
  });
});
afterEach(() => { weatherFetch?.mockRestore(); });

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');


// Every row field the Fast Complete eligibility rules and sheets read
// (lib/dispatchCompletionRouting.js, pest/lawn/tree-shrub-fast-complete.js and
// the sheet props in DispatchPageV2.jsx).
const ROUTING_FIELDS = [
  'status', 'scheduledDate', 'customerId', 'customerName', 'customerPhone',
  'propertyId', 'address', 'city', 'state', 'lat', 'lng', 'checkInTime',
  'serviceType', 'serviceTypeRaw',
  'completionProfile', 'completionProfileLookupFailed', 'findingsSchema',
  'linkedProject', 'linkedProjectLookupFailed',
  'fastCompleteReportEnabled', 'laneVoiceFillEnabled', 'typedReportFlowEnabled', 'typedVoiceFillEnabled',
  'treeShrubFastCompleteEnabled', 'lawnFastCompleteEnabled', 'lawnReserviceFastCompleteEnabled',
  'fastCompleteVoiceFillEnabled', 'fastCompleteRecapEnabled', 'noteBoxPhotosEnabled',
  'traceVariant', 'traceEligible',
  'visitId', 'visitCloseoutEnabled', 'visitCloseoutPacket',
  'checkoutInvoiceId', 'inspectionCreditAvailable',
];

postgres('GET /week rows carry the Fast Complete routing fields the day rows carry', () => {
  let database;
  let trx;
  let customerId;
  let propertyId;
  const DATE = '2040-02-01';
  const GATES = ['GATE_FAST_COMPLETE_REPORT', 'GATE_LAWN_FAST_COMPLETE', 'GATE_TS_FAST_COMPLETE'];
  const savedGates = {};

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    for (const gate of GATES) { savedGates[gate] = process.env[gate]; process.env[gate] = 'true'; }
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    propertyId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer',
    });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied',
      is_primary: true, address_line1: '100 Test Lane', address_line2: 'Unit 4', city: 'Test City', state: 'FL', zip: '00000',
      active: true, address_key: randomUUID(),
    });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => {
    for (const gate of GATES) {
      if (savedGates[gate] === undefined) delete process.env[gate]; else process.env[gate] = savedGates[gate];
    }
    await database?.destroy();
  });

  async function visit(overrides = {}) {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, property_id: propertyId, status: 'confirmed',
      scheduled_date: DATE, window_start: '08:00', window_end: '10:00', estimated_price: 111, ...overrides,
    }).returning('*');
    return row;
  }

  const router = require('../routes/admin-schedule');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function get(path, query) {
    const handler = findHandler('get', path);
    let payload = null;
    let nextErr = null;
    const res = { status() { return this; }, json(p) { payload = p; return this; } };
    await handler({ query, params: {}, headers: {} }, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
    return payload;
  }

  const VISITS = {
    pest: { service_type: 'Quarterly Pest Control', service_key_snapshot: 'pest_general_quarterly' },
    lawn: { service_type: 'Lawn Care', service_key_snapshot: 'lawn_care_recurring' },
    treeShrub: { service_type: 'Tree & Shrub Care', service_key_snapshot: 'tree_shrub_quarterly' },
    // A project-backed visit: it stays on the full form from either view.
    wdo: { service_type: 'WDO Inspection', service_key_snapshot: 'wdo_inspection' },
  };

  test.each(Object.keys(VISITS))('a %s visit: the week row equals the day row on every routing field', async (kind) => {
    const row = await visit(VISITS[kind]);
    const day = (await get('/', { date: DATE })).services.find((s) => s.id === row.id);
    const weekPayload = await get('/week', { start: DATE });
    const week = weekPayload.days.find((d) => d.date === DATE).services.find((s) => s.id === row.id);
    expect(day).toBeTruthy();
    expect(week).toBeTruthy();
    // The premise: the key must exist (the client rule tests `"propertyId" in row`).
    expect('propertyId' in week).toBe(true);
    expect(week.propertyId).toBe(propertyId);
    expect(week.address).toBe('100 Test Lane, Test City, FL 00000');
    for (const field of ROUTING_FIELDS) {
      expect({ field, value: week[field] }).toEqual({ field, value: day[field] });
    }
  });

  test('a visit never stamped with a property still carries the key, as null', async () => {
    const row = await visit({ ...VISITS.pest, property_id: null });
    const weekPayload = await get('/week', { start: DATE });
    const week = weekPayload.days.find((d) => d.date === DATE).services.find((s) => s.id === row.id);
    expect('propertyId' in week).toBe(true);
    expect(week.propertyId).toBeNull();
  });

  test('a stamped service address wins over the customer address, as on the day row', async () => {
    const row = await visit({ ...VISITS.pest, service_address_line1: '9 Example Ct', service_address_city: 'Other City', service_address_state: 'FL', service_address_zip: '11111' });
    const day = (await get('/', { date: DATE })).services.find((s) => s.id === row.id);
    const week = (await get('/week', { start: DATE })).days.find((d) => d.date === DATE).services.find((s) => s.id === row.id);
    expect(week.address).toBe(day.address);
    expect(week.address).toContain('9 Example Ct');
  });

  // The neighborhood's pinned gate (#6653): the mobile dispatch list and
  // appointment sheet build Directions from the week row's gateWaypoint, so
  // it must be on the week row exactly when it is on the day row.
  describe("the neighborhood's pinned gate", () => {
    const PIN = { lat: 27.4321, lng: -82.4567 };
    let savedAccess;
    beforeEach(async () => {
      savedAccess = process.env.GATE_NEIGHBORHOOD_ACCESS;
      process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
      const [{ id: neighborhoodId }] = await trx('neighborhoods').insert({
        name: 'Synthetic Week Gate', county: 'Manatee', match_key: `manatee|synthetic week gate ${randomUUID()}`,
        source: 'office', subdivision_names: JSON.stringify([]),
      }).returning('id');
      await trx('neighborhood_access').insert({
        neighborhood_id: neighborhoodId, access_type: 'keypad', code: '4242', status: 'active', source: 'office',
        gate_lat: PIN.lat, gate_lng: PIN.lng,
      });
      await trx('customer_properties').where({ id: propertyId }).update({ neighborhood_id: neighborhoodId, neighborhood_source: 'office' });
    });
    afterEach(() => {
      if (savedAccess === undefined) delete process.env.GATE_NEIGHBORHOOD_ACCESS; else process.env.GATE_NEIGHBORHOOD_ACCESS = savedAccess;
    });
    const dayRow = async (id) => (await get('/', { date: DATE })).services.find((s) => s.id === id);
    const weekRow = async (id) => (await get('/week', { start: DATE })).days.find((d) => d.date === DATE).services.find((s) => s.id === id);

    test('reaches the week row as on the day row; no key with the directory gate off', async () => {
      const row = await visit(VISITS.pest);
      expect((await dayRow(row.id)).gateWaypoint).toEqual(PIN);
      expect((await weekRow(row.id)).gateWaypoint).toEqual(PIN);
      delete process.env.GATE_NEIGHBORHOOD_ACCESS;
      expect(await weekRow(row.id)).not.toHaveProperty('gateWaypoint');
    });

    test.each([
      ['unstamped (the customer\'s one property)', {}, true],
      ['stamped at another address', { service_address_line1: '9 Example Ct', service_address_city: 'Other City', service_address_state: 'FL', service_address_zip: '11111' }, false],
    ])('a visit with no property link, %s: the week row agrees with the day row', async (_label, stamp, routed) => {
      const row = await visit({ ...VISITS.pest, property_id: null, ...stamp });
      const day = await dayRow(row.id);
      const week = await weekRow(row.id);
      expect('gateWaypoint' in day).toBe(routed);
      expect('gateWaypoint' in week).toBe(routed);
      expect(week.gateWaypoint).toEqual(day.gateWaypoint);
      // The stamped-premise aliases feed the lookup only; they never reach the row.
      expect(week).not.toHaveProperty('stamped_address_line1');
      expect(week).not.toHaveProperty('stampedAddressLine1');
    });
  });
});
