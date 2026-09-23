/**
 * AUDIT REPRO r1-authz-4 — GET /api/admin/dispatch/:date? (legacy day feed)
 *
 * Claim: the day feed is reachable by a technician token (router-level
 * requireTechOrAdmin) but never applies technicianCurrentVisitFilter /
 * scopeToAssignedTech, so a technician receives EVERY technician's visits
 * for the day, with customer phone/address, monthly_rate, estimatedPrice,
 * prepaid amounts and checkout-invoice totals.
 *
 * The assertions state the EXPECTED behaviour (the twin feed
 * admin-schedule.js GET / applies scopeToAssignedTech), so they FAIL on
 * current code if the bug is real.
 *
 * Pattern copied from server/tests/admin-dispatch-tech-tips.test.js:
 * mock ../models/db, pull the route layer off the router, and invoke the
 * handler with an actor object standing in for adminAuthenticate output.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'orderByRaw', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore', 'modify',
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
// Per-row enrichment helpers that would otherwise wander into deeper DB
// paths — none of them is the subject of the finding.
jest.mock('../utils/last-line-service', () => ({
  loadLastServices: jest.fn(async () => ({ lastService: null, lastLineService: null })),
  loadRecentLineServices: jest.fn(async () => []),
}));
jest.mock('../services/autopay-eligibility', () => ({
  ...jest.requireActual('../services/autopay-eligibility'),
  customerOnAutopay: jest.fn(async () => false),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => null),
}));

const router = require('../routes/admin-dispatch');
const { etDateString } = require('../utils/datetime-et');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(params, actor) {
  const layer = routeLayer('get', '/:date?');
  expect(layer).toBeTruthy();
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, query: {}, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

// Two visits on the same day assigned to DIFFERENT technicians. The caller
// is tech-7; svc-other belongs to tech-9 and must never reach tech-7.
// Real "today" (ET) — the real technicianCurrentVisitFilter this test
// exercises reads a rolling 7-day cutoff off the actual clock, so a fixed
// calendar date would eventually fall outside the window and fail.
const DATE = etDateString(new Date());
const ROWS = [
  {
    id: 'svc-mine', customer_id: 'cust-1', technician_id: 'tech-7', tech_name: 'Tech Seven',
    first_name: 'Alice', last_name: 'Mine', customer_phone: '941-555-0001',
    address_line1: '1 Mine St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34231',
    service_type: 'Quarterly Pest', scheduled_date: DATE, window_start: '09:00', window_end: '11:00',
    status: 'confirmed', notes: '', route_order: 1, monthly_rate: '45.00', estimated_price: '120.00',
    prepaid_amount: null, autopay_enabled: false,
  },
  {
    id: 'svc-other', customer_id: 'cust-2', technician_id: 'tech-9', tech_name: 'Tech Nine',
    first_name: 'Bob', last_name: 'Other', customer_phone: '941-555-0002',
    address_line1: '2 Other Ave', address_line2: null, city: 'Venice', state: 'FL', zip: '34285',
    service_type: 'Termite Annual', scheduled_date: DATE, window_start: '13:00', window_end: '15:00',
    status: 'confirmed', notes: '', route_order: 2, monthly_rate: '89.00', estimated_price: '650.00',
    prepaid_amount: null, autopay_enabled: false,
  },
];

// Scripted knex-ish stub. Applies where()/whereNotIn() predicates against the
// scripted ROWS for real (equality + '>=' / '<='), and invokes .modify(fn)
// with itself — a naive no-op modify() would silently swallow any fix built
// on .modify((q) => technicianCurrentVisitFilter(req, q)), the exact pattern
// admin-schedule.js's twin feed already uses.
function scriptedDb({ whereCalls }) {
  return (table) => {
    let rows = table === 'scheduled_services' ? ROWS.slice() : [];
    const chain = {};
    const passthrough = ['leftJoin', 'select', 'orderBy', 'orderByRaw', 'whereIn', 'whereNot', 'limit'];
    for (const m of passthrough) chain[m] = () => chain;
    chain.modify = (fn) => { if (typeof fn === 'function') fn(chain); return chain; };
    const applyPredicate = (col, op, val) => {
      const c = String(col).split('.').pop();
      rows = rows.filter((r) => {
        const rv = r[c];
        if (op === '>=') return rv >= val;
        if (op === '<=') return rv <= val;
        return rv === val;
      });
    };
    chain.where = (...args) => {
      if (table !== 'scheduled_services') return chain;
      whereCalls.push(args);
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const [k, v] = Object.entries(args[0])[0] || [];
        if (k) applyPredicate(k, '=', v);
      } else if (args.length === 2) {
        applyPredicate(args[0], '=', args[1]);
      } else if (args.length === 3) {
        applyPredicate(args[0], args[1], args[2]);
      }
      return chain;
    };
    chain.whereNotIn = (col, list) => {
      if (table === 'scheduled_services') {
        const c = String(col).split('.').pop();
        rows = rows.filter((r) => !list.includes(r[c]));
      }
      return chain;
    };
    chain.first = async () => {
      if (table === 'invoices') return { id: 'inv-1', status: 'sent', total: '650.00', token: 'tok-1' };
      return null;
    };
    chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    chain.catch = () => chain;
    return chain;
  };
}

afterEach(() => { mockDbCurrent = null; });

describe('AUDIT r1-authz-4 — GET /api/admin/dispatch/:date? technician scoping', () => {
  test('a technician token gets the day feed scoped to their own assigned visits (query-level)', async () => {
    const whereCalls = [];
    mockDbCurrent = scriptedDb({ whereCalls });
    const res = await invoke({ date: DATE }, { techRole: 'technician', technicianId: 'tech-7' });
    expect(res.statusCode).toBe(200);
    // EXPECTED: the builder was narrowed by technician_id (what
    // technicianCurrentVisitFilter does for the admin-schedule twin feed).
    const techScoped = whereCalls.some((args) =>
      (typeof args[0] === 'string' && /technician_id/.test(args[0]) && args.includes('tech-7'))
      || (args[0] && typeof args[0] === 'object' && Object.keys(args[0]).some((k) => /technician_id/.test(k))));
    expect(techScoped).toBe(true);
  });

  test('a technician token never receives another technician\'s visit, nor account pricing', async () => {
    const whereCalls = [];
    mockDbCurrent = scriptedDb({ whereCalls });
    const res = await invoke({ date: DATE }, { techRole: 'technician', technicianId: 'tech-7' });
    expect(res.statusCode).toBe(200);
    const ids = res.body.services.map((s) => s.id);
    // EXPECTED: only the caller's visit is present.
    expect(ids).toEqual(['svc-mine']);
    // EXPECTED: no cross-tech row with contact/billing context leaks.
    const leaked = res.body.services.find((s) => s.id === 'svc-other');
    expect(leaked).toBeUndefined();
  });

  test('an admin token stays unscoped (control — should pass on current code)', async () => {
    const whereCalls = [];
    mockDbCurrent = scriptedDb({ whereCalls });
    const res = await invoke({ date: DATE }, { techRole: 'admin', technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.services.map((s) => s.id).sort()).toEqual(['svc-mine', 'svc-other']);
    expect(res.body.techSummary.map((t) => t.technicianId).sort()).toEqual(['tech-7', 'tech-9']);
  });

  // Documents WHAT leaks on current code (diagnostic; passes either way).
  test('diagnostic: shape of what a technician currently receives for the other tech\'s visit', async () => {
    const whereCalls = [];
    mockDbCurrent = scriptedDb({ whereCalls });
    const res = await invoke({ date: DATE }, { techRole: 'technician', technicianId: 'tech-7' });
    const other = res.body.services.find((s) => s.id === 'svc-other');
     
    console.log('[r1-authz-4] technician tech-7 received for tech-9 visit:', other && {
      technicianId: other.technicianId, customerName: other.customerName, customerPhone: other.customerPhone,
      address: other.address, monthlyRate: other.monthlyRate, estimatedPrice: other.estimatedPrice,
      checkoutInvoiceId: other.checkoutInvoiceId, checkoutInvoiceTotal: other.checkoutInvoiceTotal,
    });
     
    console.log('[r1-authz-4] where() calls on scheduled_services:', JSON.stringify(whereCalls));
  });
});
