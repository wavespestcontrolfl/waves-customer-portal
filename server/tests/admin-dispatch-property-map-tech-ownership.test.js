/**
 * Audit repro r2-tech-reachable-leftovers-dispatch-protocols-5:
 * GET /api/admin/dispatch/:serviceId/property-map has no technician
 * ownership predicate. A technician NOT assigned to the visit gets the full
 * satellite/zone/station payload for another customer's property, while the
 * adjacent tech-tips route (same router, same actor) answers 403.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GATE_TECH_TIPS = 'true';
process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED = 'true';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/maps/basemap-provider', () => ({
  isSatelliteTreatmentMapEnabled: () => true,
  getBasemapProvider: () => ({
    capabilities: { canDisplayLive: true },
    getLiveMapConfig: async ({ center, width, height }) => ({
      imageUrl: 'https://maps.example/static?secret',
      center, width, height, attributionText: 'x',
    }),
  }),
}));
jest.mock('../services/termite-stations', () => ({
  MAX_ACTIVE_STATIONS: 80,
  loadStationsForPropertyMap: async () => ({
    stations: [{ id: 'st-1', number: 1, program: 'termite', x: 10, y: 10 }],
    nextStationNumber: 2,
    nextStationNumberByProgram: { termite: 2, rodent: 1, trapping: 1 },
    loaded: true,
  }),
}));

const router = require('../routes/admin-dispatch');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(routePath, params, actor) {
  const layer = routeLayer('get', routePath);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    Promise.resolve(handler({ params, ...actor }, res, (err) => (err ? reject(err) : resolve(res))))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const OTHER_CUSTOMER = 'cust-other';
const ASSIGNED_TECH = 'tech-B';
const ACTOR = { techRole: 'technician', technicianId: 'tech-A' };

// The fixture row this whole file exercises. scheduled_date is set fresh
// (today, ET) in beforeEach for the "current assignment" cases and moved
// stale (>7 days old, technicianCurrentVisitFilter's TECH_ACCESS_WINDOW_DAYS)
// for the codex round-1 P1 regression below.
let fixtureRow;

beforeEach(() => {
  fixtureRow = {
    id: 'svc-1', customer_id: OTHER_CUSTOMER, technician_id: ASSIGNED_TECH,
    service_type: 'pest', status: 'completed', scheduled_date: '2026-09-23',
    latitude: 27.3364, longitude: -82.5307,
  };
  mockDbCurrent = (table) => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit', 'offset',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.modify = (fn) => { fn(chain); return chain; };
    chain.catch = () => chain;
    if (table === 'scheduled_services as ss') {
      // The coordinate/customer read — always finds the row (no ownership
      // logic here; the canonical predicate below is the actual gate).
      chain.where = () => chain;
      chain.first = async () => ({ ...fixtureRow });
      chain.then = (resolve) => Promise.resolve([]).then(resolve);
    } else if (table === 'scheduled_services') {
      // technicianCurrentVisitFilter's own query: table-qualified
      // where/whereNotIn/where-comparison calls actually filter the fixture
      // row here, so a mock that ignored them could not tell a real fix
      // from a no-op.
      const predicate = { eq: {}, notIn: {}, cmp: [] };
      chain.where = (col, opOrVal, val) => {
        if (val !== undefined) predicate.cmp.push([col, opOrVal, val]);
        else if (typeof opOrVal === 'function') opOrVal.call(chain);
        else predicate.eq[col] = opOrVal;
        return chain;
      };
      chain.whereNotIn = (col, vals) => { predicate.notIn[col] = vals; return chain; };
      const cmp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
      chain.first = async () => {
        const row = fixtureRow;
        const eqOk = Object.entries(predicate.eq).every(([k, v]) => row[k.replace(/^scheduled_services\./, '')] === v);
        const notInOk = Object.entries(predicate.notIn).every(([k, vals]) => !vals.includes(row[k.replace(/^scheduled_services\./, '')]));
        const cmpOk = predicate.cmp.every(([k, op, v]) => cmp(row[k.replace(/^scheduled_services\./, '')], op, v));
        return (eqOk && notInOk && cmpOk) ? { ...row } : undefined;
      };
      chain.then = (resolve) => Promise.resolve([]).then(resolve);
    } else if (table === 'property_geometries') {
      chain.first = async () => ({ zoom: 20 });
    } else if (table === 'property_zones') {
      chain.first = async () => null;
      chain.then = (resolve) => Promise.resolve([
        { id: 'z-1', letter: 'A', label: 'Front bed', category: 'perimeter', service_lines: ['pest'], geometry_image: null },
      ]).then(resolve);
    } else {
      chain.first = async () => null;
      chain.then = (resolve) => Promise.resolve([]).then(resolve);
    }
    return chain;
  };
});

describe('GET /:serviceId/property-map technician ownership', () => {
  test('route has no per-route guard while the customer-scoped sibling has requireAdmin', () => {
    const svcLayer = routeLayer('get', '/:serviceId/property-map');
    const custLayer = routeLayer('get', '/customers/:customerId/property-map');
    expect(svcLayer.route.stack).toHaveLength(1);
    expect(custLayer.route.stack).toHaveLength(2);
    expect(custLayer.route.stack[0].name).toBe('requireAdmin');
  });

  test('neighbouring tech-tips route answers 403 to a technician not assigned to the visit', async () => {
    const res = await invoke('/:serviceId/tech-tips', { serviceId: 'svc-1' }, ACTOR);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  });

  test("property-map answers 404 to a technician not assigned to the visit (technicianCurrentVisitFilter's no-existence-oracle contract)", async () => {
    const res = await invoke('/:serviceId/property-map', { serviceId: 'svc-1' }, ACTOR);
    expect(res.statusCode).toBe(404);
  });

  test("codex round-1 P1 — the canonical current-assignment predicate (not a bare technician_id compare) is applied: a STALE visit (>7 days old) assigned to the SAME technician is refused too", async () => {
    fixtureRow.technician_id = 'tech-A';
    fixtureRow.status = 'completed';
    fixtureRow.scheduled_date = '2020-01-01'; // far outside TECH_ACCESS_WINDOW_DAYS
    const res = await invoke('/:serviceId/property-map', { serviceId: 'svc-1' }, ACTOR);
    expect(res.statusCode).toBe(404);
  });

  test('a dead-status visit (cancelled) assigned to the same technician is refused, even scheduled today', async () => {
    fixtureRow.technician_id = 'tech-A';
    fixtureRow.status = 'cancelled';
    fixtureRow.scheduled_date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const res = await invoke('/:serviceId/property-map', { serviceId: 'svc-1' }, ACTOR);
    expect(res.statusCode).toBe(404);
  });

  test('control: a technician CAN read the map for their own current assignment', async () => {
    fixtureRow.technician_id = 'tech-A';
    fixtureRow.status = 'confirmed';
    fixtureRow.scheduled_date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const res = await invoke('/:serviceId/property-map', { serviceId: 'svc-1' }, ACTOR);
    expect(res.statusCode).toBe(200);
  });

  test('control: an admin request is unscoped regardless of assignment/staleness', async () => {
    fixtureRow.technician_id = 'tech-B';
    fixtureRow.status = 'completed';
    fixtureRow.scheduled_date = '2020-01-01';
    const res = await invoke('/:serviceId/property-map', { serviceId: 'svc-1' }, { techRole: 'admin', technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
  });
});
