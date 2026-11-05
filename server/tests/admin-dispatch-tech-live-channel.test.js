/**
 * Technician visibility pack 1 (GATE_TECH_LOGIN_PRIVACY), the two routes in admin-dispatch.js:
 *  - GET /weather/tomorrow lists every visit booked tomorrow with name, phone and tier (audit A1).
 *    Gate on: office only. Gate off: today's open route.
 *  - POST /slot-check with a body serviceId / technicianId runs an arrival check on any route (audit A12).
 *    Gate on, technician caller: only the caller's own visit and the caller's own id. Admin and gate off: unchanged.
 * Synthetic ids only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'select', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.first = async () => null;
  chain.then = (resolve) => Promise.resolve([]).then(resolve);
  chain.catch = () => chain;
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : chain);
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
jest.mock('../services/forecast-analyzer', () => ({ analyzeTomorrow: jest.fn() }));
jest.mock('../services/rain-out', () => ({ checkSlots: jest.fn() }));

const router = require('../routes/admin-dispatch');
const ForecastAnalyzer = require('../services/forecast-analyzer');
const RainOut = require('../services/rain-out');
const { etDateString } = require('../utils/datetime-et');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

// Runs every handler of the route in order (the way express does), stopping at the first that answers.
async function invoke(method, routePath, { body, actor }) {
  const layer = routeLayer(method, routePath);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.sent = true; return this; },
  };
  const req = { params: {}, body, query: {}, ...actor };
  let failure = null;
  for (const entry of layer.route.stack) {
    let advanced = false;
    await new Promise((resolve) => {
      const out = entry.handle(req, res, (err) => { failure = err || null; advanced = true; resolve(); });
      Promise.resolve(out).then(() => resolve(), (err) => { failure = err; resolve(); });
    });
    if (failure) throw failure;
    if (res.sent || !advanced) break;
  }
  return res;
}

const TECH = { techRole: 'technician', technicianId: '00000000-0000-4000-8000-0000000000b1' };
const OTHER_TECH = '00000000-0000-4000-8000-0000000000b2';
const ADMIN = { techRole: 'admin', technicianId: '00000000-0000-4000-8000-0000000000a0' };
const OWN_VISIT = '00000000-0000-4000-8000-0000000000c1';
const FOREIGN_VISIT = '00000000-0000-4000-8000-0000000000c2';
const ANALYSIS = { date: '2026-11-05', appointments: [{ customerName: 'Pat Example', customerPhone: '+15555550123', tier: 'Gold' }] };
const SLOT_TARGET = { date: '2026-11-05', window: { start: '09:00', end: '10:00' } };

const savedGate = process.env.GATE_TECH_LOGIN_PRIVACY;
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_TECH_LOGIN_PRIVACY; else process.env.GATE_TECH_LOGIN_PRIVACY = savedGate;
  mockDbCurrent = null;
  jest.clearAllMocks();
});

describe('GET /weather/tomorrow', () => {
  beforeEach(() => ForecastAnalyzer.analyzeTomorrow.mockResolvedValue(ANALYSIS));

  test('gate on: a technician gets the router\'s admin-only refusal and no analysis is read', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const res = await invoke('get', '/weather/tomorrow', { actor: TECH });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
    expect(ForecastAnalyzer.analyzeTomorrow).not.toHaveBeenCalled();
  });

  test('gate on: an admin still gets the whole analysis', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const res = await invoke('get', '/weather/tomorrow', { actor: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(ANALYSIS);
  });

  test('gate off: a technician gets what it gets today', async () => {
    delete process.env.GATE_TECH_LOGIN_PRIVACY;
    const res = await invoke('get', '/weather/tomorrow', { actor: TECH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(ANALYSIS);
  });
});

describe('POST /slot-check', () => {
  const today = etDateString(new Date());
  // visits: the caller's own, and one on another route.
  const visits = {
    [OWN_VISIT]: { id: OWN_VISIT, technician_id: TECH.technicianId, status: 'confirmed', scheduled_date: today },
    [FOREIGN_VISIT]: { id: FOREIGN_VISIT, technician_id: OTHER_TECH, status: 'confirmed', scheduled_date: today },
  };
  const dbWithVisits = (reads = []) => (table) => {
    const q = {};
    q.whereIn = (_col, ids) => { reads.push({ table, ids }); q.ids = ids; return q; };
    q.select = () => q;
    q.then = (resolve, reject) => Promise.resolve((q.ids || []).map((id) => visits[id]).filter(Boolean)).then(resolve, reject);
    return q;
  };

  beforeEach(() => RainOut.checkSlots.mockResolvedValue({ ok: true, results: [{ conflicts: [] }] }));

  test('gate on: a technician naming another route\'s technician is refused and nothing is probed', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, technicianId: OTHER_TECH }] } });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
    expect(RainOut.checkSlots).not.toHaveBeenCalled();
  });

  test('gate on: a technician naming another route\'s visit is refused', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    mockDbCurrent = dbWithVisits();
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, serviceId: FOREIGN_VISIT, technicianId: TECH.technicianId }] } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('service_not_assigned');
    expect(RainOut.checkSlots).not.toHaveBeenCalled();
  });

  const OTHER_ID = FOREIGN_VISIT;
  const formsOf = (id) => [`{${id}}`, id.replace(/-/g, ''), id.toUpperCase(), `{${id.replace(/-/g, '')}}`.toUpperCase()];

  test.each(formsOf(OTHER_ID))('gate on: another visit\'s id as %s, with no technicianId, is refused for a technician and never probed', async (form) => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    mockDbCurrent = dbWithVisits();
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, serviceId: form }] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'serviceId and technicianId must be plain UUIDs' });
    expect(RainOut.checkSlots).not.toHaveBeenCalled();
  });

  test.each(formsOf(TECH.technicianId))('gate on: a technicianId as %s is refused, not skipped', async (form) => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, technicianId: form }] } });
    expect(res.statusCode).toBe(400);
    expect(RainOut.checkSlots).not.toHaveBeenCalled();
  });

  test('gate on: one odd id in a later target refuses the whole batch, and a non-string id is refused', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    mockDbCurrent = dbWithVisits();
    const batch = { targets: [{ ...SLOT_TARGET, serviceId: OWN_VISIT }, { ...SLOT_TARGET, serviceId: `{${OTHER_ID}}` }] };
    expect((await invoke('post', '/slot-check', { actor: TECH, body: batch })).statusCode).toBe(400);
    expect((await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, serviceId: 12 }] } })).statusCode).toBe(400);
    expect(RainOut.checkSlots).not.toHaveBeenCalled();
  });

  test('gate on: an admin may still pass the odd forms (the admin path is unchanged)', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    for (const form of formsOf(OTHER_ID)) {
      const res = await invoke('post', '/slot-check', { actor: ADMIN, body: { targets: [{ ...SLOT_TARGET, serviceId: form }] } });
      expect(res.statusCode).toBe(200);
    }
    expect(RainOut.checkSlots).toHaveBeenCalledTimes(4);
  });

  test('gate off: a technician passing the odd forms is probed as today', async () => {
    delete process.env.GATE_TECH_LOGIN_PRIVACY;
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, serviceId: `{${OTHER_ID}}` }] } });
    expect(res.statusCode).toBe(200);
  });

  test('gate on: a visit that does not exist is the router\'s 404', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    mockDbCurrent = dbWithVisits();
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, serviceId: '00000000-0000-4000-8000-0000000000c9' }] } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Service not found' });
  });

  test('gate on: a technician checking its own visit with its own id (or none) still gets the probe', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    mockDbCurrent = dbWithVisits();
    const body = { targets: [{ ...SLOT_TARGET, serviceId: OWN_VISIT, technicianId: TECH.technicianId }, { ...SLOT_TARGET, serviceId: OWN_VISIT }] };
    const res = await invoke('post', '/slot-check', { actor: TECH, body });
    expect(res.statusCode).toBe(200);
    expect(RainOut.checkSlots).toHaveBeenCalledWith(expect.objectContaining({ targets: body.targets }));
  });

  test('gate on: window-only occupancy with no ids stays open to a technician and reads no visit', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const reads = [];
    mockDbCurrent = dbWithVisits(reads);
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [SLOT_TARGET] } });
    expect(res.statusCode).toBe(200);
    expect(reads).toEqual([]);
  });

  test('gate on: an admin may check any visit and any technician', async () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const res = await invoke('post', '/slot-check', { actor: ADMIN, body: { targets: [{ ...SLOT_TARGET, serviceId: FOREIGN_VISIT, technicianId: OTHER_TECH }] } });
    expect(res.statusCode).toBe(200);
    expect(RainOut.checkSlots).toHaveBeenCalledTimes(1);
  });

  test('gate off: a technician naming another route is probed as today', async () => {
    delete process.env.GATE_TECH_LOGIN_PRIVACY;
    const res = await invoke('post', '/slot-check', { actor: TECH, body: { targets: [{ ...SLOT_TARGET, serviceId: FOREIGN_VISIT, technicianId: OTHER_TECH }] } });
    expect(res.statusCode).toBe(200);
    expect(RainOut.checkSlots).toHaveBeenCalledTimes(1);
  });
});
