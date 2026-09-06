/**
 * GET /admin/dispatch/:serviceId/tech-tips — the completion screen's tip
 * picker payload (tips-from-your-tech PR 2).
 *
 *  - Gate off (GATE_TECH_TIPS unset, or anything but 1/true/on) answers
 *    { available: false } without touching the database, so the completion
 *    screen keeps today's textareas.
 *  - Gate on returns the registry grouped for the visit's line and season,
 *    the per-customer "last sent" dates, and the irrigation-on-file
 *    condition — read-only, no writes.
 *  - The handler is registered on the dispatch router behind its router-level
 *    tech-or-admin auth, and its block never touches comms or transitions.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

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

const fs = require('fs');
const path = require('path');
const router = require('../routes/admin-dispatch');
const { TIPS } = require('../services/service-report/tip-library');

const completionSource = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(params = {}, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = routeLayer('get', '/:serviceId/tech-tips');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

// A scripted db: scheduled_services → the visit; service_records → prior
// frozen tips; property_preferences → the irrigation flag.
function scriptedDb({ service, sentRows = [], prefs = null, calls }) {
  return (table) => {
    calls.push(table);
    const chain = {};
    const passthrough = ['where', 'whereRaw', 'orderBy', 'select'];
    for (const m of passthrough) chain[m] = () => chain;
    chain.first = async () => (table === 'scheduled_services' ? service : table === 'property_preferences' ? prefs : null);
    chain.then = (resolve) => Promise.resolve(table === 'service_records' ? sentRows : []).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
}

const SERVICE = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Mosquito Treatment',
  scheduled_date: '2026-08-15',
  technician_id: 'tech-7',
};

afterEach(() => {
  mockDbCurrent = null;
  delete process.env.GATE_TECH_TIPS;
});

describe('GET /:serviceId/tech-tips', () => {
  test('gate off answers available:false and never reads the database', async () => {
    const calls = [];
    mockDbCurrent = scriptedDb({ service: SERVICE, calls });
    for (const value of [undefined, '', 'false', 'off', '0', 'yes']) {
      if (value === undefined) delete process.env.GATE_TECH_TIPS;
      else process.env.GATE_TECH_TIPS = value;
      const res = await invoke({ serviceId: 'svc-1' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ available: false });
    }
    expect(calls).toEqual([]);
  });

  test('gate on: a technician reads only their own assigned visit; admins read any', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    mockDbCurrent = scriptedDb({ service: SERVICE, calls: [] });
    const other = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-9' });
    expect(other.statusCode).toBe(403);
    expect(other.body.code).toBe('service_not_assigned');
    const own = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-7' });
    expect(own.statusCode).toBe(200);
    expect(own.body.available).toBe(true);
    const admin = await invoke({ serviceId: 'svc-1' }, { techRole: 'admin', technicianId: 'admin-1' });
    expect(admin.statusCode).toBe(200);
  });

  test('gate on: unknown service is a 404', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    mockDbCurrent = scriptedDb({ service: null, calls: [] });
    const res = await invoke({ serviceId: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  test('gate on: only visit-line tips, with sent dates and conditions', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    const calls = [];
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      sentRows: [
        // pg returns DATE columns as a Date at UTC midnight — the payload
        // carries the calendar day, not that instant
        { service_date: new Date('2026-08-03T00:00:00.000Z'), tech_tips: [{ id: 'water_bromeliads', copy: 'x', source: 'library' }] },
        { service_date: '2026-07-01', tech_tips: [{ id: 'water_bromeliads' }, { id: 'light_warm_bulbs' }] },
      ],
      prefs: { irrigation_system: true, watering_days: ['mon', 'thu'], irrigation_run_minutes: null },
      calls,
    });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.line).toBe('mosquito');
    expect(res.body.season).toBe('wet');
    expect(res.body.groups.flatMap((g) => g.tips).map((tip) => tip.id).sort()).toEqual(TIPS.filter((tip) => tip.lines.includes('mosquito')).map((tip) => tip.id).sort());
    expect(res.body.groups[0].primary).toBe(true);
    // newest send wins per id
    expect(res.body.lastSent).toEqual({ water_bromeliads: '2026-08-03', light_warm_bulbs: '2026-07-01' });
    expect(res.body.conditions).toEqual({ irrigation_on_file: true });
    // read-only: three reads, no writes
    expect(calls.sort()).toEqual(['property_preferences', 'scheduled_services', 'service_records']);
  });

  test('gate on: the irrigation flag alone never counts as settings on file', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    for (const prefs of [
      { irrigation_system: true },
      { irrigation_system: true, watering_days: [], irrigation_run_minutes: null, irrigation_inches_per_week: '', irrigation_zones: null, rain_sensor: null },
      // the column default (20260401000084) is not customer-entered data
      { irrigation_system: true, rain_sensor: false, irrigation_confirmed_fields: [] },
      // turf-profile entries share the ledger but say nothing about a schedule
      { irrigation_confirmed_fields: ['turf_grass', 'turf_county'] },
      { irrigation_confirmed_fields: '["turf_county"]' },
      null,
    ]) {
      mockDbCurrent = scriptedDb({ service: SERVICE, prefs, calls: [] });
      const res = await invoke({ serviceId: 'svc-1' });
      expect(res.body.conditions).toEqual({ irrigation_on_file: false });
    }
    for (const prefs of [{ rain_sensor: true }, { irrigation_zones: 6 }, { irrigation_inches_per_week: 1 }, { irrigation_system_type: 'rotor' }, { irrigation_confirmed_fields: ['turf_grass', 'watering_days'] }, { irrigation_confirmed_fields: '["rain_sensor"]' }]) {
      mockDbCurrent = scriptedDb({ service: SERVICE, prefs, calls: [] });
      const res = await invoke({ serviceId: 'svc-1' });
      expect(res.body.conditions).toEqual({ irrigation_on_file: true });
    }
  });

  test('gate on: a service with no customer skips the per-customer reads', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    const calls = [];
    mockDbCurrent = scriptedDb({ service: { ...SERVICE, customer_id: null }, calls });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.body.available).toBe(true);
    expect(res.body.lastSent).toEqual({});
    expect(res.body.conditions).toEqual({ irrigation_on_file: false });
    expect(calls).toEqual(['scheduled_services']);
  });
});

describe('completion freeze contract', () => {
  test('the complete route freezes the picks through freezeTechTips into structured_notes.techTips', () => {
    const start = completionSource.indexOf('async function completeScheduledService(');
    expect(start).toBeGreaterThan(-1);
    const block = completionSource.slice(start);
    expect(block).toContain('freezeTechTips(completionInput.body?.techTips)');
    expect(block).toMatch(/techTips: techTipsFreeze\.tips/);
    // a rejected pick is an actionable 400 for a FRESH attempt, never a silent drop —
    // deferred past replay/conflict handling so a same-key retry keeps replaying
    // the stored completion even if the library changed (same posture as the
    // caption gate), and it marks the claimed attempt failed before returning
    const reject = block.indexOf("if (claim.action === 'proceed' && techTipsFreeze.dropped.length) {");
    expect(reject).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(block.indexOf("if (claim.action === 'replay') {"));
    const rejectBlock = block.slice(reject, reject + 2400);
    expect(rejectBlock).toMatch(/markCompletionAttemptFailed\([\s\S]*tech_tip_rejected/);
    expect(rejectBlock).toMatch(/return \(\{ status: 400, body: \{[\s\S]*TECH_TIP_UNKNOWN[\s\S]*TECH_TIP_COPY_REJECTED/);
    // …and still before the completion transaction's first write
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    // the kill switch holds on the write path too
    expect(block).toMatch(/techTipsGateOn\(\)\s*\n?\s*\? freezeTechTips/);
    // ids resolve server-side — the client's copy never reaches the freeze
    expect(block).not.toMatch(/techTips\.copy|body\.techTips\.tips/);
  });
});

describe('route wiring contracts', () => {
  test('the handler is registered after the router-level tech-or-admin auth', () => {
    const layer = routeLayer('get', '/:serviceId/tech-tips');
    expect(layer).toBeTruthy();
    // and applies the per-visit ownership rule inside
    const start = source.indexOf("router.get('/:serviceId/tech-tips'");
    expect(source.slice(start, source.indexOf('\nrouter.', start + 1))).toContain('completionOwnershipError({');
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
  });

  test('the block is read-only: no writes, comms, or transitions', () => {
    const start = source.indexOf("router.get('/:serviceId/tech-tips'");
    expect(start).toBeGreaterThan(-1);
    const closer = '} catch (err) { next(err); }\n});';
    const end = source.indexOf(closer, start);
    const block = source.slice(start, end + closer.length);
    for (const forbidden of ['.update(', '.insert(', '.del(', 'sendCustomerMessage', 'markComplete', 'transitionJobStatus', 'twilio']) {
      expect(block).not.toContain(forbidden);
    }
    // parked [Next] lines arrive as internalRecommendations: merged into the
    // internal list, never the form-provenance list the report prints verbatim
    const cstart = completionSource.indexOf('async function completeScheduledService(');
    const cblock = completionSource.slice(cstart);
    const internalMerge = cblock.indexOf('const reportRecommendations = normalizeCompletionTextArray([');
    expect(cblock.slice(internalMerge, internalMerge + 600)).toContain('internalRecommendations');
    const formBlock = cblock.slice(cblock.indexOf('const formRecommendations = normalizeCompletionTextArray('), cblock.indexOf('const formRecommendations = normalizeCompletionTextArray(') + 200);
    expect(formBlock).not.toContain('internalRecommendations');
    // "sent" = a report the customer could open: undelivered postures are excluded
    expect(block).toContain("COALESCE(structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'");
    expect(block).toContain("COALESCE(structured_notes->>'visitOutcome', '') <> 'incomplete'");
    // the 90-day window is an ET calendar day bound from the shared helpers,
    // never the session-zone CURRENT_DATE
    expect(block).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(block).toContain('etDateString(addETDays(new Date(), -90))');
  });
});
