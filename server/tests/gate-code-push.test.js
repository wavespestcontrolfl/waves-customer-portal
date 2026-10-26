/**
 * The Gate line on the way in (GATE_GATE_CODE_PUSH, owner 2026-10-26):
 * services/gate-code-push.js pushes the schedule's community gate line to the
 * technician's phone while they drive to an en-route visit. Near the pinned
 * gate when the neighborhood has one, else on the first en-route sample; once
 * per stop and trip; the code itself never lands in the audit row.
 * Synthetic ids, codes and coordinates only.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUser: jest.fn(async () => ({})) }));
jest.mock('../services/neighborhood-access', () => ({
  neighborhoodGateEntriesForVisits: jest.fn(async () => new Map()),
  neighborhoodGateWaypointsForVisits: jest.fn(async () => new Map()),
}));
jest.mock('../middleware/staff-maintenance', () => ({ isStaffMaintenanceEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const PushService = require('../services/push-notifications');
const neighborhoodAccess = require('../services/neighborhood-access');
const detector = require('../services/gps-arrival-detector');
const { maybePushGateCode, _test: { sentKeys } } = require('../services/gate-code-push');

const GATES = ['GATE_GATE_CODE_PUSH', 'GATE_NEIGHBORHOOD_ACCESS'];
const saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const TECH_ID = 'tech-1';
const PIN = { lat: 27.4, lng: -82.5 };
// ~0.0009 degrees of latitude is about 100 m; 0.0045 is about 500 m.
const at = (dLat) => ({ lat: PIN.lat + dLat, lng: PIN.lng });
const ENTRY = { id: 'entry-1', neighborhood_id: 'n-1', gate_label: 'Main gate', access_type: 'keypad', code: '4242', status: 'active' };

let prefsRow;
let auditRows;
function chain(table) {
  const c = {};
  c.where = () => c;
  c.whereIn = (_column, actions) => { c.actions = actions; return c; };
  c.whereRaw = (_sql, [key]) => { c.key = key; return c; };
  c.first = async () => (table === 'property_preferences' ? prefsRow : undefined);
  c.select = async () => (table === 'audit_log'
    ? auditRows.filter((row) => row.metadata.key === c.key && c.actions.includes(row.action)).map((row) => ({ action: row.action }))
    : []);
  c.insert = (row) => ({ returning: async () => { auditRows.push(row); return [{ id: auditRows.length }]; } });
  return c;
}

function sample(where, { minutesAgo = 0 } = {}) {
  const reportedAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
  return {
    techStatus: { tech_id: TECH_ID, current_job_id: 'svc-1', lat: where.lat, lng: where.lng, location_updated_at: reportedAt },
    point: { lat: where.lat, lng: where.lng, reported_at: reportedAt },
  };
}

// The push service as it behaves (push-notifications.js sendToAdminUsers):
// look up the tech's devices, ask beforeDispatch, hand off, summarize.
let devices;
let deliveredOk;
let dispatched;
function fakePushService() {
  PushService.sendToAdminUser.mockImplementation(async (_technicianId, _notification, { beforeDispatch } = {}) => {
    if (!devices) return { subscriptions: 0, sent: 0 };
    if (beforeDispatch && (await beforeDispatch()) === false) return { subscriptions: devices, sent: 0, superseded: true };
    dispatched += 1;
    return { subscriptions: devices, sent: deliveredOk ? devices : 0, failed: deliveredOk ? 0 : devices };
  });
}

let service;
beforeEach(() => {
  jest.clearAllMocks();
  sentKeys.clear();
  devices = 1;
  deliveredOk = true;
  dispatched = 0;
  fakePushService();
  process.env.GATE_GATE_CODE_PUSH = 'true';
  process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
  prefsRow = null;
  auditRows = [];
  db.mockImplementation(chain);
  db.transaction.mockImplementation(async (fn) => {
    const trx = (table) => chain(table);
    trx.raw = jest.fn(async () => ({}));
    return fn(trx);
  });
  service = {
    id: 'svc-1', customer_id: 'cust-1', technician_id: TECH_ID, property_id: 'prop-1', status: 'en_route', track_state: 'en_route',
    en_route_at: new Date(Date.now() - 10 * 60000).toISOString(), scheduled_date: '2026-10-26', visit_id: null,
  };
  jest.spyOn(detector, 'loadCurrentService').mockImplementation(async () => service);
  neighborhoodAccess.neighborhoodGateEntriesForVisits.mockImplementation(async () => new Map([['svc-1', [ENTRY]]]));
  neighborhoodAccess.neighborhoodGateWaypointsForVisits.mockImplementation(async () => new Map([['svc-1', PIN]]));
});
afterEach(() => jest.restoreAllMocks());

test('gate off: nothing is read and nothing is sent', async () => {
  delete process.env.GATE_GATE_CODE_PUSH;
  await expect(maybePushGateCode(sample(at(0)))).resolves.toEqual({ sent: false, reason: 'gate_off' });
  expect(db).not.toHaveBeenCalled();
  expect(detector.loadCurrentService).not.toHaveBeenCalled();
  expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
});

test('pinned gate: nothing farther than 300 m; one push within it, carrying the Gate line; the code stays out of the audit row', async () => {
  await expect(maybePushGateCode(sample(at(0.0045)))).resolves.toMatchObject({ sent: false, reason: 'not_near_gate' });
  expect(PushService.sendToAdminUser).not.toHaveBeenCalled();

  await expect(maybePushGateCode(sample(at(0.0009)))).resolves.toEqual({ sent: true, trigger: 'gate_pin' });
  expect(PushService.sendToAdminUser).toHaveBeenCalledWith(TECH_ID, {
    title: 'Gate: 4242 (neighborhood)', body: '', url: '/admin/today', tag: 'gate-code-svc-1', priority: 'high',
  }, { beforeDispatch: expect.any(Function) });
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]).toMatchObject({ action: 'gate_code_push.sent', resource_type: 'scheduled_service', resource_id: 'svc-1' });
  expect(JSON.stringify(auditRows[0])).not.toContain('4242');
});

test('once per stop and trip: a later sample, or another process, sends nothing; a new en-route trip sends again', async () => {
  await maybePushGateCode(sample(at(0.0009)));
  await expect(maybePushGateCode(sample(at(0.0005)))).resolves.toEqual({ sent: false, reason: 'already_sent' });
  sentKeys.clear(); // a restart or a second instance: the audit row decides
  await expect(maybePushGateCode(sample(at(0.0005)))).resolves.toEqual({ sent: false, reason: 'already_sent' });
  expect(dispatched).toBe(1);

  service = { ...service, en_route_at: new Date(Date.now() - 2 * 60000).toISOString() };
  await expect(maybePushGateCode(sample(at(0.0005)))).resolves.toEqual({ sent: true, trigger: 'gate_pin' });
  expect(dispatched).toBe(2);
});

// Codex pre-push P1: the trip is claimed only once a device is about to get
// the push, and a delivery no device accepted is not the end of it.
test('no device: nothing is claimed, and a later sample can still send', async () => {
  devices = 0;
  await expect(maybePushGateCode(sample(at(0.0009)))).resolves.toEqual({ sent: false, reason: 'no_device' });
  expect(auditRows).toEqual([]);
  devices = 1;
  await expect(maybePushGateCode(sample(at(0.0005)))).resolves.toEqual({ sent: true, trigger: 'gate_pin' });
});

test('a delivery no device accepted frees the trip for another try; after three failures it stops', async () => {
  deliveredOk = false;
  for (let i = 0; i < 3; i += 1) {
    await expect(maybePushGateCode(sample(at(0.0009)))).resolves.toEqual({ sent: false, reason: 'delivery_failed' });
  }
  expect(auditRows.map((row) => row.action)).toEqual([
    'gate_code_push.sent', 'gate_code_push.failed', 'gate_code_push.sent', 'gate_code_push.failed', 'gate_code_push.sent', 'gate_code_push.failed',
  ]);
  deliveredOk = true;
  await expect(maybePushGateCode(sample(at(0.0009)))).resolves.toEqual({ sent: false, reason: 'already_sent' });
  expect(dispatched).toBe(3);
});

test('a failed delivery, then a good one: the code arrives on the next sample', async () => {
  deliveredOk = false;
  await maybePushGateCode(sample(at(0.0009)));
  deliveredOk = true;
  await expect(maybePushGateCode(sample(at(0.0005)))).resolves.toEqual({ sent: true, trigger: 'gate_pin' });
  expect(dispatched).toBe(2);
});

test('a code but no pin: the push goes on the first en-route sample', async () => {
  neighborhoodAccess.neighborhoodGateWaypointsForVisits.mockImplementation(async () => new Map());
  await expect(maybePushGateCode(sample(at(0.05)))).resolves.toEqual({ sent: true, trigger: 'en_route' });
  expect(PushService.sendToAdminUser).toHaveBeenCalledWith(TECH_ID, expect.objectContaining({ title: 'Gate: 4242 (neighborhood)' }), expect.anything());
});

test.each([
  ["the customer's own community code wins over the directory", { neighborhood_gate_code: '1111' }, ENTRY, 'Gate: 1111'],
  ['an unconfirmed directory code is marked to confirm on site', null, { ...ENTRY, status: 'needs_confirm' }, 'Gate: 4242 (neighborhood, confirm on site)'],
])('the push says what the schedule says: %s', async (_label, prefs, entry, title) => {
  prefsRow = prefs;
  neighborhoodAccess.neighborhoodGateEntriesForVisits.mockImplementation(async () => new Map([['svc-1', [entry]]]));
  await maybePushGateCode(sample(at(0.0009)));
  expect(PushService.sendToAdminUser).toHaveBeenCalledWith(TECH_ID, expect.objectContaining({ title }), expect.anything());
});

test('no community gate code anywhere: nothing is sent', async () => {
  neighborhoodAccess.neighborhoodGateEntriesForVisits.mockImplementation(async () => new Map());
  await expect(maybePushGateCode(sample(at(0.0009)))).resolves.toEqual({ sent: false, reason: 'no_gate_code' });
  expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
});

test("directory gate off: the neighborhood is never read, and the customer's own code pushes on en route", async () => {
  delete process.env.GATE_NEIGHBORHOOD_ACCESS;
  prefsRow = { neighborhood_gate_code: '1111' };
  await expect(maybePushGateCode(sample(at(0.05)))).resolves.toEqual({ sent: true, trigger: 'en_route' });
  expect(neighborhoodAccess.neighborhoodGateEntriesForVisits).not.toHaveBeenCalled();
  expect(neighborhoodAccess.neighborhoodGateWaypointsForVisits).not.toHaveBeenCalled();
  expect(PushService.sendToAdminUser).toHaveBeenCalledWith(TECH_ID, expect.objectContaining({ title: 'Gate: 1111' }), expect.anything());
});

test.each([
  ['the visit is not en route', () => { service = { ...service, status: 'on_site', track_state: 'on_property' }; }, {}],
  ["the visit is another technician's", () => { service = { ...service, technician_id: 'tech-2' }; }, {}],
  ['the sample is stale', () => {}, { minutesAgo: 20 }],
])('nothing is sent when %s', async (_label, arrange, sampleOpts) => {
  arrange();
  const result = await maybePushGateCode(sample(at(0.0009), sampleOpts));
  expect(result.sent).toBe(false);
  expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
});

test('a failed claim sends nothing and never throws', async () => {
  db.transaction.mockImplementation(async () => { throw new Error('db down'); });
  await expect(maybePushGateCode(sample(at(0.0009)))).resolves.toEqual({ sent: false, reason: 'error' });
  expect(dispatched).toBe(0);
});
