'use strict';

// C4 restart: POST /api/requests/restart-plan (dark = 404; not cancelled =
// 409; mint failure = 409 with a code; success = the estimate path) and the
// mint itself — cancelled families from the committed case scope (or the
// pulled rows / the churn note when the scope was the whole account), the
// SAME server recompute every estimate save runs, publish-without-delivery,
// reuse of a live restart estimate, and fail-closed ownership.

jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn().mockResolvedValue({ sent: false }) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));
jest.mock('../services/account-membership-email', () => ({
  sendRequestReceived: jest.fn().mockResolvedValue(null),
  sendCancellationReceived: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/cancellation-processor', () => ({
  processCancellationRequest: jest.fn(),
  CHURN_REASON: 'Customer cancellation request',
  PORTAL_CANCEL_REASON_PREFIX: 'Portal cancellation request',
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
}));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn().mockResolvedValue(false) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) })); // hold lookup: none of these fixtures is a hold
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
  previewCancellationResolution: jest.fn(),
  openCancellationCase: jest.fn(),
}));
// Family detection off the row text, like the real detector does for
// pulled rows (the real module drags in the whole scheduler).
jest.mock('../services/self-booking-plan-sync', () => ({
  detectWaveGuardPlanKeys: (row) => {
    const text = String(row.service_type || row.service_name || '').toLowerCase();
    const keys = [];
    if (/pest/.test(text)) keys.push('pest_control_quarterly');
    if (/lawn/.test(text)) keys.push('lawn_care');
    if (/mosquito/.test(text)) keys.push('mosquito');
    return keys;
  },
  isCommercialServiceRow: () => false,
  isRodentLedServiceRow: (row) => /rodent/i.test(String(row.service_type || '')),
  uniqueServiceFamilies: (keys) => Array.from(new Set(keys.map((k) => ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'].find((f) => k === f || k.startsWith(`${f}_`)) || k))),
}));

const mockMint = jest.fn();
jest.mock('../services/cancellation-resolution/restart', () => {
  const actual = jest.requireActual('../services/cancellation-resolution/restart');
  return { ...actual, mintRestartEstimate: (...args) => mockMint(...args) };
});

let mockInactive = true;
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customer = { id: 'cust-1', first_name: 'Pat', active: !mockInactive, pipeline_stage: mockInactive ? 'churned' : 'active_customer' };
    req.customerId = 'cust-1';
    req.customerInactive = mockInactive;
    next();
  },
  authenticateAllowInactive: (req, _res, next) => { req.customer = { id: 'cust-1' }; next(); },
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/requests');
const restart = require('../services/cancellation-resolution/restart');
// The route tests above mock the mint; the unit tests below run the real one.
const actualRestart = jest.requireActual('../services/cancellation-resolution/restart');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { process.env.GATE_CANCEL_FLOW_V2 = 'true'; mockInactive = true; mockMint.mockReset(); });
afterEach(() => { delete process.env.GATE_CANCEL_FLOW_V2; });

async function post() {
  const res = await fetch(`${baseUrl}/api/requests/restart-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}

describe('POST /api/requests/restart-plan', () => {
  test('dark = 404, nothing minted', async () => {
    delete process.env.GATE_CANCEL_FLOW_V2;
    const res = await post();
    expect(res.status).toBe(404);
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('an active (not cancelled) customer gets 409 not_cancelled', async () => {
    mockInactive = false;
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_cancelled');
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('success hands back the estimate path', async () => {
    mockMint.mockResolvedValueOnce({ estimateId: 'est-1', token: 'tok', url: '/estimate/tok', reused: false });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, url: '/estimate/tok', estimateId: 'est-1', reused: false });
    expect(mockMint).toHaveBeenCalledWith(expect.objectContaining({ customer: expect.objectContaining({ id: 'cust-1' }) }));
  });

  test('a mint refusal maps to 409 with its code; an unexpected failure is a 500', async () => {
    mockMint.mockRejectedValueOnce(new restart.RestartUnavailableError('nothing_to_restart', 'We could not find the plan to restart from this account.'));
    let res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'We could not find the plan to restart from this account.', code: 'nothing_to_restart' });

    mockMint.mockRejectedValueOnce(new Error('snapshot did not freeze'));
    res = await post();
    expect(res.status).toBe(500);

    // Knex puts an insert's bound values in its message (AGENTS.md "PII in logs"): the route
    // logs and forwards the database code and the customer id only, as start-plan does.
    const logged = jest.spyOn(require('../services/logger'), 'error').mockImplementation(() => {});
    try {
      mockMint.mockRejectedValueOnce(Object.assign(new Error(`insert into "estimates" ("address", "customer_phone") values ('1 Main St, Parrish, FL 34219', '+19415550101') - boom`), { code: '23505' }));
      res = await post();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/Main St|5550101/);
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/Main St|5550101/);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/\[plan-restart\] mint failed for customer cust-1: 23505$/));
    } finally {
      logged.mockRestore();
    }
  });
});

// ── mint unit tests: fake db + injected pricing/persistence deps ──────────
let tables;
const norm = (col) => String(col).replace(/^[a-z]+\./, '');
function builder(table) {
  const conds = [];
  let limitN = null;
  const b = {};
  const rows = () => {
    const out = (tables[table.split(' as ')[0]] || []).filter((r) => conds.every((c) => c(r)));
    return limitN ? out.slice(0, limitN) : out;
  };
  const scalarCond = (a, op, val) => {
    if (typeof a === 'object') { const entries = Object.entries(a); return (r) => entries.every(([k, v]) => String(r[norm(k)]) === String(v)); }
    if (val === undefined) return (r) => String(r[norm(a)]) === String(op);
    if (op === 'like') { const prefix = String(val).replace(/%$/, ''); return (r) => String(r[norm(a)] || '').startsWith(prefix); }
    if (op === '>=') return (r) => (r[norm(a)] ?? '') >= val;
    if (op === '<=') return (r) => (r[norm(a)] ?? '') <= val;
    return (r) => String(r[norm(a)]) === String(val);
  };
  // Grouped predicate with knex's real AND/OR semantics (the reason group,
  // notCallback, and coveredTermsAsOf's nested status guard all run through
  // here) — a where/andWhere ANDs, an orWhere ORs, and a function nests.
  const groupCond = (fn) => {
    const parts = [];
    const push = (or, cond) => { parts.push({ or, cond }); };
    const sub = {
      where: (sa, sop, sval) => { push(false, typeof sa === 'function' ? groupCond(sa) : scalarCond(sa, sop, sval)); return sub; },
      andWhere: (sa, sop, sval) => sub.where(sa, sop, sval),
      orWhere: (sa, sop, sval) => { push(true, typeof sa === 'function' ? groupCond(sa) : scalarCond(sa, sop, sval)); return sub; },
      whereNot: (col, val) => { push(false, (r) => String(r[norm(col)]) !== String(val)); return sub; },
      whereNull: (col) => { push(false, (r) => r[norm(col)] == null); return sub; },
      orWhereNull: (col) => { push(true, (r) => r[norm(col)] == null); return sub; },
      whereNotNull: (col) => { push(false, (r) => r[norm(col)] != null); return sub; },
      orWhereNotNull: (col) => { push(true, (r) => r[norm(col)] != null); return sub; },
      whereIn: (col, vals) => { push(false, (r) => vals.map(String).includes(String(r[norm(col)]))); return sub; },
      orWhereIn: (col, vals) => { push(true, (r) => vals.map(String).includes(String(r[norm(col)]))); return sub; },
      // coveredTermsAsOf's P2-4 termite grace-deadline check (a raw SQL
      // GREATEST/INTERVAL expression) — vacuously true, same rationale as
      // the top-level b.whereRaw below: no fixture here carries both
      // renewed_from_term_id AND annual_plan_version on a payment_pending
      // row, so the preceding whereNotNull gates already decide this
      // branch before whereRaw's own value would matter.
      whereRaw: () => { push(false, () => true); return sub; },
      // coveredTermsAsOf's grace branch also requires a parent that still
      // authorizes the renewal (Codex #4971 r28, an EXISTS subquery) —
      // vacuously true here for the same reason as whereRaw above: the
      // preceding whereNotNull gates already exclude every fixture row.
      whereExists: () => { push(false, () => true); return sub; },
    };
    fn.call(sub);
    return (r) => parts.reduce((acc, p, i) => (i === 0 ? p.cond(r) : (p.or ? (acc || p.cond(r)) : (acc && p.cond(r)))), false);
  };
  b.where = (a, op, val) => {
    if (typeof a === 'function') { conds.push(groupCond(a)); return b; }
    conds.push(scalarCond(a, op, val));
    return b;
  };
  b.whereIn = (col, vals) => { conds.push((r) => vals.map(String).includes(String(r[norm(col)]))); return b; };
  // coveredTermsAsOf's raw guards (cancelled-invoice coalesce, refunded-
  // payment NOT EXISTS) are vacuously true with no invoice/payment rows in
  // these fixtures — pass through.
  b.whereRaw = () => b;
  b.whereNotIn = (col, vals) => { conds.push((r) => !vals.map(String).includes(String(r[norm(col)]))); return b; };
  b.whereNot = (col, val) => { conds.push((r) => String(r[norm(col)]) !== String(val)); return b; };
  b.whereNull = (col) => { conds.push((r) => r[norm(col)] == null); return b; };
  b.orderBy = () => b;
  b.leftJoin = () => b;
  b.select = () => b;
  b.forUpdate = () => b;
  b.limit = (n) => { limitN = n; return b; };
  b.first = async () => rows()[0] || null;
  // A returning list (the replace step's archive) answers with the updated ids, as pg does.
  b.update = async (patch, returning) => {
    const hit = rows();
    hit.forEach((r) => Object.assign(r, patch));
    return returning ? hit.map((r) => ({ id: r.id })) : hit.length;
  };
  b.insert = (row) => {
    const list = (tables[table] ||= []);
    // A database-side value (the mint's order stamp) is stored as a timestamp: keep what was sent beside it.
    const stamped = row.created_at?.sql
      ? { created_at: new Date().toISOString(), created_at_sent: { sql: row.created_at.sql, bindings: row.created_at.bindings } } : {};
    const inserted = { id: `${table}-${list.length + 1}`, created_at: new Date().toISOString(), ...row, ...stamped };
    list.push(inserted);
    return Object.assign(Promise.resolve([inserted]), { returning: async () => [inserted] });
  };
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}
// Transaction-handle shape: a builder factory plus the .raw the advisory
// lock (lockCustomerComms) issues. `ops`, when given, records statement
// order for the lock-before-reads assertions.
function fakeTrx(ops = null, tableFactory = builder) {
  const t = (table) => {
    const b = tableFactory(table);
    if (ops) {
      let locked = false;
      const origForUpdate = b.forUpdate;
      b.forUpdate = () => { locked = true; return origForUpdate(); };
      const origFirst = b.first;
      b.first = (...args) => { ops.push(`read:${table}${locked ? ':forUpdate' : ''}`); return origFirst(...args); };
      const origThen = b.then;
      b.then = (resolve, reject) => { ops.push(`read:${table}`); return origThen(resolve, reject); };
    }
    return b;
  };
  t.raw = (sql, bindings) => {
    // A knex raw is a statement when awaited and a value when a query carries it (the mint's order
    // stamp). Only a statement is logged.
    const value = String(sql).startsWith('GREATEST(');
    if (ops && !value) ops.push(`raw:${String(sql)}:${JSON.stringify(bindings)}`);
    // A try-lock answers one row, as Postgres does; a key named in t.busy is another transaction's.
    const answer = String(sql).includes('pg_try_advisory_xact_lock') ? { rows: [{ acquired: !t.busy.includes(bindings?.[0]) }] } : {};
    return Object.assign(Promise.resolve(answer), { sql: String(sql), bindings });
  };
  t.busy = [];
  // Savepoint stand-in: the mint nests best-effort lookups (seed) so their
  // failure can't abort the outer transaction.
  t.transaction = async (fn) => fn(t);
  return t;
}
const fakeDb = { transaction: async (fn) => fn(fakeTrx()) };

const CUSTOMER = {
  id: 'cust-1', active: false, pipeline_stage: 'churned', deleted_at: null,
  first_name: 'Pat', last_name: 'Former', phone: '+19415550101', email: 'pat@example.com',
  address_line1: '1 Main St', city: 'Parrish', state: 'FL', zip: '34219', property_type: null,
};
const recompute = jest.fn();
const releaseHolds = jest.fn(async () => ({ released: 0 }));
function deps(overrides = {}) {
  const pricingAi = require('../services/customer-pricing-ai');
  return {
    db: fakeDb,
    persistence: { serverRecomputeFromEstimateData: recompute, estimateExpiresAt: () => new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    pricingAi: {
      variantsForService: pricingAi.variantsForService,
      optionServices: pricingAi.optionServices,
      addressForCustomer: () => '1 Main St, Parrish, FL 34219',
      loadTurfProfile: async () => null,
      resolvePropertyContext: async () => ({ propertyInput: { homeSqFt: 2200, lotSqFt: 9000, stories: 1 }, grassType: 'st_augustine', palmCount: null }),
      missingPropertyFor: () => null,
    },
    // Injected so the mint never requires the heavy cross-sell/lookup
    // modules in this suite; the seed and cache-only lookup paths are inert.
    crossSell: { loadEstimateSeed: async () => null },
    // The scheduler's hold release, recorded: the replace step frees each archived quote's holds.
    releaseEstimateHolds: releaseHolds,
    propertyLookup: null,
    // Single-premises proof + verified-override probe (codex GH r4): green
    // by default here; the refusal tests override them.
    customerHasOnlyPrimaryPremises: async () => true,
    hasVerifiedOverrides: async () => false,
    bundleUtils: { pricingBundleMatchesEstimateTotals: () => true },
    buildEstimateSendSnapshot: async (row) => ({ ...JSON.parse(row.estimate_data), sendSnapshot: { pricingBundle: { frozen: true } } }),
    ...overrides,
  };
}

beforeEach(() => {
  db.mockImplementation((table) => builder(table));
  recompute.mockReset();
  releaseHolds.mockClear();
  recompute.mockResolvedValue({
    recomputed: true,
    serverResult: { engineVersion: 'v9.9', lineItems: [] },
    rawEngineResult: { waveGuard: { tier: 'Silver' }, lineItems: [] },
    serverTotals: { monthlyTotal: 138, annualTotal: 1656, onetimeTotal: 99 },
  });
  tables = {
    customers: [{ ...CUSTOMER }],
    cancellation_cases: [{ id: 'case-1', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control', 'lawn_care']), created_at: '2026-08-22' }],
    estimates: [],
    scheduled_services: [],
    customer_interactions: [],
  };
});

describe('mintRestartEstimate', () => {
  test('mints a published, server-priced estimate for the cancelled families at today\'s price', async () => {
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), now: () => new Date('2026-08-31T12:00:00Z'), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result).toEqual({ estimateId: 'estimates-1', token: '61626364656630313233343536373839', url: '/estimate/61626364656630313233343536373839', reused: false });

    // Server-authoritative recompute, no client-claimable identity, no
    // restored tier: priors are the (empty) live ownership set.
    expect(recompute).toHaveBeenCalledTimes(1);
    const [estimateData, recomputeDeps] = recompute.mock.calls[0];
    expect(estimateData.engineInputs.services).toEqual({
      pest: { frequency: 'quarterly', version: undefined },
      lawn: { track: 'st_augustine', tier: 'enhanced', lawnFreq: 9 },
    });
    expect(recomputeDeps).toEqual({ priorQualifyingServices: [], recurringCustomer: false });

    const row = tables.estimates[0];
    expect(row).toEqual(expect.objectContaining({
      customer_id: 'cust-1', source: 'plan_restart', status: 'sent', pricing_authority: 'SERVER',
      monthly_total: 138, annual_total: 1656, onetime_total: 99, waveguard_tier: 'Silver',
      followup_unviewed_sent: true, followup_viewed_sent: true, followup_final_sent: true, followup_expiring_sent: true,
      service_interest: 'Pest Control + Lawn Care', category: 'RESIDENTIAL', pricing_version: 'v9.9',
    }));
    // The quote's place in its lineage is assigned in the database, after every stored quote of this
    // customer and source (plan-quote-lineage.db.test.js proves the SQL).
    expect(row.created_at_sent).toEqual({
      sql: expect.stringContaining("GREATEST(now(), (SELECT max(prior.created_at) + interval '1 microsecond'"),
      bindings: ['cust-1', 'plan_restart'],
    });
    const stored = JSON.parse(row.estimate_data);
    expect(stored.noEngagementAutomation).toBe(true);
    expect(stored.planRestart).toEqual(expect.objectContaining({ families: ['pest_control', 'lawn_care'], familiesSource: 'case_scope', cancellationCaseId: 'case-1' }));
    expect(stored.sendSnapshot.pricingBundle).toEqual({ frozen: true });
    expect(stored.membershipSnapshot).toBeUndefined();
    // Audit note, no customer send of any kind.
    expect(tables.customer_interactions).toHaveLength(1);
    expect(tables.customer_interactions[0].subject).toMatch(/^Restart estimate requested from portal/);
  });

  test('a failed audit note fails the mint (aborted pg transaction must never resolve with a URL)', async () => {
    const failingDb = {
      transaction: async (fn) => fn(fakeTrx(null, (table) => {
        const b = builder(table);
        if (table === 'customer_interactions') {
          b.insert = () => Promise.reject(new Error('note insert boom'));
        }
        return b;
      })),
    };
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: failingDb }) }))
      .rejects.toThrow('note insert boom');
  });

  test('a second tap reuses the live restart estimate instead of minting beside it — only when today\'s full offer matches', async () => {
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(first.reused).toBe(false);
    recompute.mockClear();
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    expect(again).toEqual({ estimateId: first.estimateId, token: first.token, url: first.url, reused: true });
    // The second tap still recomputed today's offer (the reuse comparison
    // needs it) but minted nothing beside the live row.
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(tables.estimates).toHaveLength(1);
    expect(tables.estimates[0].archived_at == null).toBe(true);
    expect(releaseHolds).not.toHaveBeenCalled();
  });

  test.each(['show_one_time_option', 'bill_by_invoice'])('a live quote with %s turned on by staff is re-minted, never handed back as staff changed it (codex pre-push r29 on #8132)', async (column) => {
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    tables.estimates[0] = { ...tables.estimates[0], [column]: true };
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('0123456789abcdef') });
    expect(again.reused).toBe(false);
    expect(again.estimateId).not.toBe(first.estimateId);
    expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).not.toBeNull();
    // The new quote carries neither option: the mint never sets them.
    const minted = tables.estimates.find((r) => r.id === again.estimateId);
    expect(!!minted.show_one_time_option || !!minted.bill_by_invoice).toBe(false);
  });

  test('an identical tap at an address that does not parse back to its home reuses the live quote: its stored address is today\'s own string (codex pre-push r38 P1)', async () => {
    // With no city, the unit line "Building 2" reads back as the stored address's city.
    const unitOnly = { ...CUSTOMER, address_line2: 'Building 2', city: null };
    tables.customers = [{ ...unitOnly }];
    const realAddress = deps({ pricingAi: { ...deps().pricingAi, addressForCustomer: require('../services/customer-pricing-ai').addressForCustomer } });
    const first = await actualRestart.mintRestartEstimate({ customer: unitOnly, deps: realAddress, randomBytes: () => Buffer.from('abcdef0123456789') });
    const again = await actualRestart.mintRestartEstimate({ customer: unitOnly, deps: realAddress });
    expect(again).toEqual({ estimateId: first.estimateId, token: first.token, url: first.url, reused: true });
    expect(tables.estimates[0].archived_at == null).toBe(true);
    expect(releaseHolds).not.toHaveBeenCalled();
  });

  test('a quote that expires while the tap waits on its locks is not handed back: liveness reads the clock after the locks (codex pre-push P1)', async () => {
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    tables.estimates[0].expires_at = '2026-09-01T12:00:00.000Z';
    // The tap starts a second before the quote expires; its locked read lands a second after.
    let calls = 0;
    const now = () => new Date(calls++ === 0 ? '2026-09-01T11:59:59Z' : '2026-09-01T12:00:01Z');
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), now, randomBytes: () => Buffer.from('0123456789abcdef') });
    expect(again.reused).toBe(false);
    expect(again.estimateId).not.toBe(first.estimateId);
  });

  test('a live quote from a PRIOR attempt is never reused — same families re-cancelled re-mint at today\'s price (codex GH r16 P1)', async () => {
    // Reactivate-then-recancel of the SAME families: the accept-time
    // identity check refuses the old token, so reusing it would hand back
    // the same unusable token on every tap.
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(first.reused).toBe(false);
    tables.cancellation_cases = [{
      id: 'case-2', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control', 'lawn_care']), created_at: '2026-08-30',
    }];
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('0123456789abcdef') });
    expect(again.reused).toBe(false);
    expect(again.estimateId).not.toBe(first.estimateId);
    // The prior attempt's token is retired, never live beside the new one.
    const firstRow = tables.estimates.find((e) => e.id === first.estimateId);
    expect(firstRow.archived_at != null).toBe(true);
  });

  test('a mid-delivery lineage row refuses the mint — never archive a token the provider is about to deliver (codex GH r19 P0)', async () => {
    // An operator send claims the row 'sending' before the provider call;
    // finalization does not reject an archived row.
    tables.estimates = [{
      id: 'est-sending', customer_id: 'cust-1', source: 'plan_restart', status: 'sending', token: 'tok-s',
      expires_at: '2099-01-01', archived_at: null, estimate_data: JSON.stringify({ planRestart: { families: ['x'] } }),
    }];
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() }))
      .rejects.toMatchObject({ code: 'delivery_in_flight' });
    expect(tables.estimates).toHaveLength(1);
    expect(tables.estimates[0].archived_at == null).toBe(true);

    // A staff-scheduled delivery blocks the same way.
    tables.estimates[0].status = 'scheduled';
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() }))
      .rejects.toMatchObject({ code: 'delivery_in_flight' });

    // A resend claimed just before expiry is in flight while its claim is fresh, whatever
    // expires_at says: the send refreshes the expiry only after the handoff (codex pre-push P1).
    tables.estimates[0].status = 'sending';
    tables.estimates[0].expires_at = '2020-01-01';
    tables.estimates[0].updated_at = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() }))
      .rejects.toMatchObject({ code: 'delivery_in_flight' });
    expect(tables.estimates).toHaveLength(1);
    expect(tables.estimates[0].archived_at == null).toBe(true);

    // A CRASHED 'sending' claim (window lapsed, claim no longer fresh) is dead — archives + mints.
    tables.estimates[0].updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    expect(tables.estimates.find((e) => e.id === 'est-sending').archived_at != null).toBe(true);
  });

  test('same totals but a drifted offer body does NOT reuse — the full fingerprint decides (codex GH r9 P1)', async () => {
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    // Offsetting price changes: aggregates identical, per-service result
    // different from what the live row stored.
    const drifted = JSON.parse(tables.estimates[0].estimate_data);
    drifted.result = { engineVersion: 'v9.9', lineItems: [{ service: 'pest', mo: 61 }] };
    tables.estimates[0].estimate_data = JSON.stringify(drifted);
    recompute.mockClear();
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('bbcdef0123456789') });
    expect(again.reused).toBe(false);
    expect(again.estimateId).not.toBe(first.estimateId);
    expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).not.toBeNull();
  });

  test('the reuse checks read the live quote again under its row lock: a tier picked while today\'s price was computed re-mints it (codex pre-push P1)', async () => {
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(first.estimateId).toBe('estimates-1');
    // The customer's tier pick in another tab commits during the recompute,
    // after the first lineage read: a new row version, as Postgres returns
    // one, without the frozen snapshot (the page's tier handlers drop it).
    const priced = recompute.getMockImplementation();
    recompute.mockImplementationOnce(async (...args) => {
      const stored = JSON.parse(tables.estimates[0].estimate_data);
      delete stored.sendSnapshot.pricingBundle;
      tables.estimates[0] = { ...tables.estimates[0], estimate_data: JSON.stringify(stored) };
      return priced(...args);
    });
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('bbcdef0123456789') });
    expect(again.reused).toBe(false);
    expect(again.estimateId).not.toBe(first.estimateId);
    expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).not.toBeNull();
  });

  test.each([
    // The page's tier handlers delete sendSnapshot.pricingBundle and leave inputs, result and totals.
    ['the page dropped its frozen snapshot', (stored) => { delete stored.sendSnapshot.pricingBundle; }, {}],
    ['its frozen snapshot no longer carries the row\'s totals', () => {},
      { bundleUtils: { pricingBundleMatchesEstimateTotals: (_bundle, row) => row.id !== 'estimates-1' } }],
  ])('a live quote whose %s is re-minted, never handed back (codex pre-push P0)', async (_label, editStored, depOverrides) => {
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(first.estimateId).toBe('estimates-1');
    const stored = JSON.parse(tables.estimates[0].estimate_data);
    editStored(stored);
    tables.estimates[0].estimate_data = JSON.stringify(stored);
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(depOverrides), randomBytes: () => Buffer.from('bbcdef0123456789') });
    expect(again.reused).toBe(false);
    expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).not.toBeNull();
  });

  test('a live estimate whose price no longer recomputes to its frozen totals is archived and re-priced (codex pre-push P0)', async () => {
    tables.estimates.push({
      id: 'est-old-price', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'old-price', expires_at: '2099-01-01', archived_at: null,
      // Minted before a pricing-config change: today's recompute says 138.
      monthly_total: 120, annual_total: 1440, onetime_total: 99,
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'], cancellationCaseId: 'case-1', cancellationRequestId: null } }),
    });
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    // One recompute serves both the reuse comparison and the fresh mint.
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(tables.estimates.find((r) => r.id === 'est-old-price').archived_at).not.toBeNull();
    expect(Number(tables.estimates.find((r) => r.id !== 'est-old-price').monthly_total)).toBe(138);
  });

  test('a live estimate whose scope no longer matches is archived and re-priced, never handed back stale', async () => {
    tables.estimates.push({
      id: 'est-stale', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'stale-tok', expires_at: '2099-01-01', archived_at: null,
      // Minted when the cancellation covered pest only; the current case
      // scope is pest + lawn.
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control'] } }),
    });
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), now: () => new Date('2026-08-31T12:00:00Z'), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(tables.estimates.find((r) => r.id === 'est-stale').archived_at).not.toBeNull();
  });

  test('an expired or archived prior restart estimate does not block a fresh mint — and the expired one is archived, not left revivable', async () => {
    tables.estimates.push(
      { id: 'est-old', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'old', expires_at: '2020-01-01', archived_at: null },
      { id: 'est-arch', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'arch', expires_at: '2099-01-01', archived_at: '2026-08-01' },
      // Accepted rows are history and must survive the sweep.
      { id: 'est-done', customer_id: 'cust-1', source: 'plan_restart', status: 'accepted', token: 'done', expires_at: '2020-01-01', archived_at: null },
    );
    let trx = null;
    const txDb = { transaction: async (fn) => { trx = fakeTrx(); return fn(trx); } };
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: txDb }) });
    expect(result.reused).toBe(false);
    expect(recompute).toHaveBeenCalledTimes(1);
    // Codex GH r6 P1: an expired-but-unarchived restart quote stays
    // revivable through /extension-request for 7 days — the replacement
    // mint must retire the whole unaccepted lineage.
    expect(tables.estimates.find((r) => r.id === 'est-old').archived_at).not.toBeNull();
    expect(tables.estimates.find((r) => r.id === 'est-done').archived_at).toBeNull();
    // The quote it archives frees its slot holds in the same transaction
    // (codex pre-push r15 P1); an accepted or already-archived quote's do not.
    expect(releaseHolds.mock.calls).toEqual([[{ estimateId: 'est-old', database: trx }]]);
  });

  test('refuses an account that is not cancelled (row re-read under the lock)', async () => {
    tables.customers[0].active = true;
    tables.customers[0].pipeline_stage = 'active_customer';
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'not_cancelled', restartUnavailable: true });
  });

  test('refuses under the lock when active drifted to NULL (only the exact churn stamp mints)', async () => {
    tables.customers[0].active = null;
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'not_cancelled' });
  });

  test('a re-armed completed series anchor (recurring_ongoing) counts as ownership', async () => {
    tables.scheduled_services = [
      { id: 'anchor', customer_id: 'cust-1', status: 'completed', is_recurring: true, recurring_ongoing: true, service_type: 'Quarterly Pest Control' },
    ];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    const [estimateData, recomputeDeps] = recompute.mock.calls[0];
    expect(Object.keys(estimateData.engineInputs.services)).toEqual(['lawn']);
    expect(recomputeDeps.priorQualifyingServices).toEqual(['pest_control']);
  });

  test('an engine result flagged for review never publishes (fail closed to priced-by-hand)', async () => {
    recompute.mockResolvedValueOnce({
      recomputed: true,
      serverResult: { engineVersion: 'v9.9', lineItems: [] },
      rawEngineResult: { waveGuard: { tier: 'Silver' }, lineItems: [{ service: 'pest', requiresManualReview: true }] },
      serverTotals: { monthlyTotal: 138, annualTotal: 1656, onetimeTotal: 99 },
    });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);

    // A seed whose source estimate carried verification markers refuses too.
    const d = deps({ crossSell: { loadEstimateSeed: async () => ({ homeSqFt: 2200, requiresFieldVerification: true }) } });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);
  });

  test('a restart keeps main\'s best-effort seed: an unreadable seed still prices (plan start alone refuses)', async () => {
    const d = deps({ crossSell: { loadEstimateSeed: async () => { throw new Error('pg down'); } } });
    const minted = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d, randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(minted.url).toEqual(expect.any(String));
    expect(tables.estimates).toHaveLength(1);
  });

  test.each([
    ['a $79 fee', 79],
    ['a $0 fee', 0],
  ])('a pest restart freezes %s where the accept bills it; a quote minted before the freeze is re-minted (codex pre-push P0s)', async (_label, fee) => {
    tables.cancellation_cases[0].scope = JSON.stringify(['pest_control']);
    recompute.mockResolvedValue({
      recomputed: true,
      // A solo pest plan, the mix the setup fee applies to.
      serverResult: { engineVersion: 'v9.9', lineItems: [{ service: 'pest_control', annual: 452 }], oneTime: { membershipFee: fee, total: fee } },
      rawEngineResult: { waveGuard: { tier: 'Bronze' }, lineItems: [] },
      serverTotals: { monthlyTotal: 37.67, annualTotal: 452, onetimeTotal: fee },
    });
    const first = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    const { setupFeeQuote, ...preChange } = JSON.parse(tables.estimates[0].estimate_data);
    expect(setupFeeQuote).toEqual({ amount: fee, kind: 'waveguard_membership' });
    // The public accept's own decision: whether a fee applies, then the amount it stamps and invoices.
    const converter = require('../services/estimate-converter');
    const bills = (data) => (converter.shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: converter.recurringServicesFromEstimateData(data), estimateData: data,
    }) ? converter.frozenSetupFeeAmount(data) : 0);
    expect(bills({ ...preChange, setupFeeQuote })).toBe(fee);
    // Without the freeze the accept bills the $99 code constant.
    expect(bills(preChange)).toBe(99);
    // A live quote minted before the freeze, otherwise today's offer, is never handed back.
    tables.estimates[0].estimate_data = JSON.stringify(preChange);
    const again = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('bbcdef0123456789') });
    expect(again.reused).toBe(false);
    expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).not.toBeNull();
    expect(JSON.parse(tables.estimates.find((r) => r.id === again.estimateId).estimate_data).setupFeeQuote).toEqual(setupFeeQuote);
  });

  test('a Tree & Shrub restart on a seed whose zero tree count is ambiguous is priced by hand (codex pre-push P0)', async () => {
    tables.cancellation_cases = [{ id: 'case-1', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['tree_shrub']), created_at: '2026-08-22' }];
    const seeded = (seed) => deps({ crossSell: { loadEstimateSeed: async () => seed } });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: seeded({ homeSqFt: 2200, zeroTreeCountAmbiguous: true }) }))
      .rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);
    // A known tree count restarts as before.
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: seeded({ homeSqFt: 2200 }) })).resolves.toMatchObject({ reused: false });
  });

  test('whole-account scope ([]) recovers the families from the rows the processor pulled', async () => {
    tables.cancellation_cases[0].scope = '[]';
    tables.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Quarterly Pest Control', cancelled_at: '2026-08-23' },
      { id: 's2', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Monthly Mosquito Program', cancelled_at: '2026-08-23' },
      // A staff-cancelled one-off and a rodent row are not plan evidence.
      { id: 's3', customer_id: 'cust-1', status: 'cancelled', is_recurring: false, cancellation_reason: 'weather', service_type: 'Lawn Care Program', cancelled_at: '2026-08-23' },
      { id: 's4', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Rodent Bait Stations', cancelled_at: '2026-08-23' },
      // A family churned in an EARLIER cancellation (before this case) is
      // not part of the plan the customer just cancelled.
      { id: 's5', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Tree & Shrub Program', cancelled_at: '2026-05-01' },
      // The H0 path stamps rows BEFORE writing the case — minutes-earlier
      // rows are still THIS attempt (slack window).
      { id: 's6', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Lawn Care Program', cancelled_at: '2026-08-21T23:30:00' },
    ];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found.caseId).toBe('case-1');
    expect(found.source).toBe('cancelled_rows');
    expect([...found.families].sort()).toEqual(['lawn_care', 'mosquito', 'pest_control']);
  });

  test('a case with a request linkage keys recovery to EXACTLY that request\'s rows — a prior cancellation inside the slack hour stays out', async () => {
    // Reactivate-then-recancel: both requests' rows sit inside the one-hour
    // window, but the case's service_request_id names the second — only its
    // rows are this attempt's evidence (codex GH r7 P1).
    tables.cancellation_cases = [{
      id: 'case-2', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:30:00Z', service_request_id: 'req-9',
    }];
    tables.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-9', service_type: 'Quarterly Pest Control', cancelled_at: '2026-08-23T12:25:00Z' },
      { id: 's2', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-8', service_type: 'Lawn Care Program', cancelled_at: '2026-08-23T12:00:00Z' },
      { id: 's3', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Monthly Mosquito Program', cancelled_at: '2026-08-23T12:05:00Z' },
    ];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-2', requestId: null, source: 'cancelled_rows' });
  });

  test('a plan whose only footprint was a completed series anchor recovers from the reason the recurrence-stop stamped', async () => {
    // The processor clears recurring_ongoing without cancelling the anchor
    // (no upcoming rows existed) — the stamped reason is the surviving
    // evidence (codex GH r8 P1).
    tables.cancellation_cases = [{
      id: 'case-3', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23', service_request_id: 'req-5',
    }];
    tables.scheduled_services = [
      { id: 'anchor-1', customer_id: 'cust-1', status: 'completed', is_recurring: true, recurring_ongoing: false, cancellation_reason: 'Portal cancellation request req-5', service_type: 'Quarterly Pest Control', cancelled_at: null },
    ];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-3', requestId: null, source: 'cancelled_rows' });
  });

  test('a live annual-prepay term is plan evidence even with zero schedule rows (codex GH r10 P1)', async () => {
    // Coverage visits ride recurring_ongoing=false and the last one is
    // completed — nothing for the sweep or the recurrence stop to stamp;
    // the term that covered the attempt date names the plan.
    tables.cancellation_cases = [{
      id: 'case-5', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-11',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-1', customer_id: 'cust-1', status: 'active', term_start: '2026-01-01', term_end: '2026-12-31',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: null,
    }];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-5', requestId: null, source: 'cancelled_rows' });
  });

  test('a cancel-then-refunded prepay term still names the cancelled plan (codex GH r11 P1)', async () => {
    // Refund processing CANCELS the term — historical evidence must survive
    // the status flip; ownership (live classifier) correctly excludes it,
    // so the family is restartable.
    tables.cancellation_cases = [{
      id: 'case-8', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-14',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-4', customer_id: 'cust-1', status: 'cancelled', term_start: '2026-01-01', term_end: '2026-12-31',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: null,
    }];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-8', requestId: null, source: 'cancelled_rows' });
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    expect(tables.estimates).toHaveLength(1);
  });

  test('an attempt anchored before the CURRENT churn transition is stale — admin re-churn must not resurrect the old cancellation (codex GH r22 P1)', async () => {
    // Staff reactivated after the portal cancellation, then churned the
    // account through the admin editor — that transition creates no
    // request or case, only the churned_at stamp.
    tables.customers[0].churned_at = '2026-08-30';
    tables.cancellation_cases = [{
      id: 'case-old', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-01T12:00:00Z',
    }];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: [], caseId: 'case-old', requestId: null, source: 'none' });

    // An attempt inside the transition window (day before the DATE stamp)
    // stays live — the tolerance absorbs a just-before-midnight request.
    tables.cancellation_cases[0].created_at = '2026-08-29T23:59:00Z';
    const live = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(live.families).toEqual(['pest_control']);
  });

  test('a SAME-DAY admin re-churn refuses the morning portal attempt — pipeline_stage_changed_at binds precisely (codex GH r23 P1)', async () => {
    // Portal cancellation at noon, staff reactivate, admin re-churn that
    // evening: the DATE stamp matches but the transition instant does not.
    tables.customers[0].churned_at = '2026-08-23';
    tables.customers[0].pipeline_stage_changed_at = '2026-08-23T20:00:00Z';
    tables.cancellation_cases = [{
      id: 'case-old', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-23T12:00:00Z',
    }];
    const stale = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(stale).toEqual({ families: [], caseId: 'case-old', requestId: null, source: 'none' });

    // The portal attempt's own transition (stamped within the processor's
    // slack of the request, carrying the processor's churn_reason literal)
    // stays live.
    tables.customers[0].pipeline_stage_changed_at = '2026-08-23T12:30:00Z';
    tables.customers[0].churn_reason = 'Customer cancellation request';
    const live = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(live.families).toEqual(['pest_control']);
  });

  test('a reactivate + admin re-churn INSIDE the slack hour still refuses the portal attempt — the transition must be the processor\'s own (codex GH r24 P1)', async () => {
    // Portal cancellation at noon, staff reactivate and re-churn through
    // the editor at 12:30 — timestamps alone cannot tell the transitions
    // apart, but the admin path stamps its own reason (or NULL), never the
    // processor's literal.
    tables.customers[0].churned_at = '2026-08-23';
    tables.customers[0].pipeline_stage_changed_at = '2026-08-23T12:30:00Z';
    tables.cancellation_cases = [{
      id: 'case-old', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-23T12:00:00Z',
    }];
    for (const adminReason of [null, 'Moved out of state']) {
      tables.customers[0].churn_reason = adminReason;
      const stale = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
      expect(stale).toEqual({ families: [], caseId: 'case-old', requestId: null, source: 'none' });
    }

    // The same instant stamped by the processor itself carries the literal
    // — live.
    tables.customers[0].churn_reason = 'Customer cancellation request';
    const live = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(live.families).toEqual(['pest_control']);
  });

  test('a failing turf-profile read degrades to a null profile — the savepoint keeps the mint alive (codex GH r23 P2)', async () => {
    const d = deps();
    const reads = [];
    d.pricingAi.loadTurfProfile = async (_db, _id, options) => { reads.push(options); throw new Error('schema skew boom'); };
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d, randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    expect(tables.estimates).toHaveLength(1);
    // Restart keeps main's forgiving read, lawn included (plan start reads it strictly).
    expect(reads).toEqual([{ strict: false }]);
  });

  test('a failing request lookup falls back to case-only correlation — the savepoint keeps the outer transaction usable (codex GH r25 P2)', async () => {
    tables.cancellation_cases = [{
      id: 'case-12', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-21',
    }];
    const t = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('service_requests')) { b.first = async () => { throw new Error('schema skew boom'); }; }
      return b;
    });
    const found = await actualRestart.cancelledFamiliesFor('cust-1', t);
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-12', requestId: null, source: 'case_scope' });
  });

  test('a failing churn-correlation read keeps the legacy correlation — the savepoint keeps the outer transaction usable (codex GH r26 P2)', async () => {
    tables.cancellation_cases = [{
      id: 'case-13', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-22',
    }];
    const t = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('customers')) { b.first = async () => { throw new Error('schema skew boom'); }; }
      return b;
    });
    const found = await actualRestart.cancelledFamiliesFor('cust-1', t);
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-13', requestId: null, source: 'case_scope' });
  });

  test('strict (the accept re-check): a failing request lookup, churn-correlation read or attempt prepay read throws instead of falling back (codex pre-push P1)', async () => {
    // A whole-account attempt (empty scope), so the evidence reaches the prepay terms.
    tables.cancellation_cases = [{
      id: 'case-14', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-23',
    }];
    for (const failing of ['service_requests', 'customers', 'annual_prepay_terms']) {
      const t = fakeTrx(null, (table) => {
        const b = builder(table);
        if (table.startsWith(failing)) {
          const boom = () => { throw new Error(`${failing} read boom`); };
          b.first = async () => boom();
          b.then = boom;
        }
        return b;
      });
      await expect(actualRestart.cancelledFamiliesFor('cust-1', t, true)).rejects.toThrow(`${failing} read boom`);
    }
  });

  test('a failing prepay evidence read only NARROWS — the savepoint keeps the outer transaction usable (codex GH r18 P2)', async () => {
    // The prepay lookup is best-effort, but without a savepoint a pg
    // statement error aborts the OUTER mint transaction — the catch would
    // swallow it and every later read still fails.
    tables.cancellation_cases = [{
      id: 'case-11', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-20',
    }];
    tables.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-20', service_type: 'Quarterly Pest Control', cancelled_at: '2026-08-23' },
    ];
    const t = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('annual_prepay_terms')) { b.then = () => { throw new Error('schema skew boom'); }; }
      return b;
    });
    const found = await actualRestart.cancelledFamiliesFor('cust-1', t);
    expect(found.families).toEqual(['pest_control']);
    expect(found.source).toBe('cancelled_rows');
  });

  test('a term whose terminal flip predates THIS attempt is not evidence — an old refunded cycle must not resurrect (codex GH r19 P1)', async () => {
    // Previous cancel-and-refund cycle: the term's date range still covers
    // the new attempt, its paid marker survives, but updated_at records a
    // terminal flip months before this cancellation.
    tables.cancellation_cases = [{
      id: 'case-12', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-21',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-old', customer_id: 'cust-1', status: 'cancelled', term_start: '2026-01-01', term_end: '2026-12-31',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: 'inv-old',
      paid_at: '2026-01-02T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
    }];
    const stale = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(stale).toEqual({ families: [], caseId: 'case-12', requestId: null, source: 'none' });

    // The SAME shape flipped during this attempt (the r11 cancel-then-
    // refund) stays evidence.
    tables.annual_prepay_terms[0].updated_at = '2026-08-23T12:20:00Z';
    const current = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(current.families).toEqual(['pest_control']);
  });

  test('a NEVER-PAID pending term whose voided invoice cancelled it is NOT purchase evidence (codex pre-push r18 P1)', async () => {
    // invoiceTermStatus maps a voided pending invoice to term 'cancelled' —
    // same terminal status as the r11 refund shape, but no money ever
    // moved. The linked invoice carries no paid marker, so reallyBought
    // must exclude it (a bare whereNot(payment_pending) admitted it).
    tables.cancellation_cases = [{
      id: 'case-9', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-15',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-5', customer_id: 'cust-1', status: 'cancelled', term_start: '2026-01-01', term_end: '2026-12-31',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: 'inv-void-1',
    }];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: [], caseId: 'case-9', requestId: null, source: 'none' });
  });

  test('a cancelled term with a linked EVER-PAID invoice keeps its r11 evidence (non-legacy shape)', async () => {
    // The invoice join is a stub no-op with prefixes stripped, so joined
    // invoice columns are emulated as fields on the term row: paid_at here
    // is i.paid_at — payment evidence that survives the status flip.
    tables.cancellation_cases = [{
      id: 'case-10', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-16',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-6', customer_id: 'cust-1', status: 'cancelled', term_start: '2026-01-01', term_end: '2026-12-31',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: 'inv-paid-1',
      paid_at: '2026-01-02T00:00:00Z',
    }];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-10', requestId: null, source: 'cancelled_rows' });
  });

  test('a prepay term still covering TODAY is owned coverage — the mint refuses rather than re-sell it (codex pre-push P0)', async () => {
    tables.cancellation_cases = [{
      id: 'case-6', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-12',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-2', customer_id: 'cust-1', status: 'active', term_start: '2026-01-01', term_end: '2027-12-31',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: null,
    }];
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() }))
      .rejects.toMatchObject({ code: 'nothing_to_restart' });
    expect(tables.estimates).toHaveLength(0);
  });

  test('an EXPIRED prepay term that covered the attempt is restartable — evidence without ownership', async () => {
    tables.cancellation_cases = [{
      id: 'case-7', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-13',
    }];
    tables.scheduled_services = [];
    tables.annual_prepay_terms = [{
      id: 'term-3', customer_id: 'cust-1', status: 'active', term_start: '2025-09-01', term_end: '2026-08-25',
      plan_label: 'Quarterly Pest Control', last_scheduled_service_id: null, prepay_invoice_id: null,
    }];
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    expect(tables.estimates).toHaveLength(1);
  });

  test('a stale case (newest request has no case row) contributes neither scope nor correlation — the request itself does', async () => {
    // The best-effort case insert failed for req-new (requests.js swallows
    // it); the older committed case must not answer (codex GH r8 P1).
    tables.service_requests = [
      { id: 'req-new', customer_id: 'cust-1', category: 'cancellation', created_at: '2026-08-25' },
      { id: 'req-old', customer_id: 'cust-1', category: 'cancellation', created_at: '2026-07-01' },
    ];
    tables.cancellation_cases = [{
      id: 'case-old', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['tree_shrub']), created_at: '2026-07-01', service_request_id: 'req-old',
    }];
    tables.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-new', service_type: 'Quarterly Pest Control', cancelled_at: '2026-08-25' },
      { id: 's2', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-old', service_type: 'Tree & Shrub Program', cancelled_at: '2026-07-01' },
    ];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: null, requestId: 'req-new', source: 'cancelled_rows' });
  });

  test('rows cancelled with the request-scoped portal reason are this plan\'s evidence too', async () => {
    // Every requests.js path passes "Portal cancellation request <id>" as
    // the reason, and it lands verbatim on the rows — matching only the
    // bare CHURN_REASON default found nothing for ordinary whole-account
    // cancels (codex GH r5 P1).
    tables.cancellation_cases[0].scope = '[]';
    tables.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-77', service_type: 'Quarterly Pest Control', cancelled_at: '2026-08-23' },
      { id: 's2', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Portal cancellation request req-77', service_type: 'Lawn Care Program', cancelled_at: '2026-08-23' },
      // A staff cancellation with its own reason is still not plan evidence.
      { id: 's3', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'duplicate booking', service_type: 'Monthly Mosquito Program', cancelled_at: '2026-08-23' },
    ];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found.source).toBe('cancelled_rows');
    expect([...found.families].sort()).toEqual(['lawn_care', 'pest_control']);
  });

  test('an uncommitted LATEST case never lets an older committed scope answer — recovery keys to the new attempt', async () => {
    // Newest first — this suite's builder does not sort, so fixture order
    // stands in for the created_at DESC the real query applies.
    tables.cancellation_cases = [
      { id: 'case-new', customer_id: 'cust-1', status: 'open', scope: JSON.stringify(['pest_control']), created_at: '2026-08-22' },
      { id: 'case-old', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['lawn_care']), created_at: '2026-07-01' },
    ];
    tables.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Quarterly Pest Control', cancelled_at: '2026-08-23' },
      { id: 's2', customer_id: 'cust-1', status: 'cancelled', is_recurring: true, cancellation_reason: 'Customer cancellation request', service_type: 'Lawn Care Program', cancelled_at: '2026-07-02' },
    ];
    const found = await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx());
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-new', requestId: null, source: 'cancelled_rows' });
  });

  test('a request-linked attempt with no row evidence FAILS CLOSED — an earlier scoped note inside the window supplies nothing (codex GH r9 P1)', async () => {
    tables.cancellation_cases = [{
      id: 'case-4', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-23T12:00:00Z', service_request_id: 'req-7',
    }];
    tables.scheduled_services = []; // e.g. the attempt's only service was rodent-led
    tables.customer_interactions = [{
      customer_id: 'cust-1', interaction_type: 'note', subject: 'Cancelled Lawn Care — plan continues with Pest Control', created_at: '2026-08-23T11:30:00Z',
    }];
    expect(await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx()))
      .toEqual({ families: [], caseId: 'case-4', requestId: null, source: 'none' });
  });

  test('falls back to the scoped churn note, then reports nothing to restart', async () => {
    tables.cancellation_cases = [];
    tables.customer_interactions = [{ customer_id: 'cust-1', interaction_type: 'note', subject: 'Cancelled Lawn Care, Mosquito — plan continues with Pest Control', created_at: '2026-08-01' }];
    expect(await actualRestart.cancelledFamiliesFor('cust-1', fakeTrx())).toEqual({ families: ['lawn_care', 'mosquito'], caseId: null, requestId: null, source: 'churn_note' });

    tables.customer_interactions = [];
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'nothing_to_restart' });
    expect(tables.estimates).toHaveLength(0);
  });

  test('residual ownership fails closed; a family with LIVE recurring rows is dropped; nothing left = nothing_to_restart', async () => {
    // The pricing-ai ownership loaders answer [] for an inactive customer,
    // so the mint reads scheduled_services directly — a broken read refuses.
    const failingDb = {
      transaction: async (fn) => fn(fakeTrx(null, (table) => {
        const b = builder(table);
        if (table.startsWith('scheduled_services')) {
          b.whereNotIn = () => { throw new Error('rows read boom'); };
        }
        return b;
      })),
    };
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: failingDb }) }))
      .rejects.toMatchObject({ code: 'pricing_unavailable' });

    // A LIVE recurring pest row (staff restored it) drops pest from the
    // quote and prices lawn at the combined tier.
    tables.scheduled_services = [
      { id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Quarterly Pest Control' },
    ];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    const [estimateData, recomputeDeps] = recompute.mock.calls[0];
    expect(Object.keys(estimateData.engineInputs.services)).toEqual(['lawn']);
    expect(recomputeDeps.priorQualifyingServices).toEqual(['pest_control']);

    // Both families live again = nothing to restart.
    tables.scheduled_services.push(
      { id: 'live-2', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Lawn Care Program' },
    );
    tables.estimates = [];
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'nothing_to_restart' });
  });

  test('a RESCHEDULED recurring row is residual ownership — an open rebook obligation must not be re-sold (codex GH r13 P1)', async () => {
    // 'rescheduled' sits in the coverage view's TERMINAL_STATUSES (phantom
    // row until SmartRebooker actions it) but is an open obligation the
    // processor sweeps — ownership must keep it.
    tables.scheduled_services = [
      { id: 'resched-1', customer_id: 'cust-1', status: 'rescheduled', is_recurring: true, service_type: 'Quarterly Pest Control' },
    ];
    tables.estimates = [];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    const [estimateData, recomputeDeps] = recompute.mock.calls[recompute.mock.calls.length - 1];
    expect(Object.keys(estimateData.engineInputs.services)).toEqual(['lawn']);
    expect(recomputeDeps.priorQualifyingServices).toEqual(['pest_control']);
  });

  test('a STALE past pending row is NOT residual ownership — the processor left it untouched by date, so must this read (codex GH r14 P1)', async () => {
    // The sweep only cancels pending/confirmed rows with scheduled_date >=
    // today; a historical stray survives cancellation with its status and
    // must not empty eligibleFamilies forever.
    tables.scheduled_services = [
      { id: 'stale-1', customer_id: 'cust-1', status: 'pending', is_recurring: true, scheduled_date: '2024-01-15', service_type: 'Quarterly Pest Control' },
    ];
    tables.estimates = [];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    const [estimateData] = recompute.mock.calls[recompute.mock.calls.length - 1];
    expect(Object.keys(estimateData.engineInputs.services).sort()).toEqual(['lawn', 'pest']);
  });

  test('a tracker-COMPLETED row is not residual ownership; a tech en route still is (codex GH r17 P1)', async () => {
    // track_state leads the legacy status (the sync is best-effort) — a
    // completed visit stuck on status 'confirmed' is done work the sweep
    // also excludes, not an upcoming obligation.
    tables.scheduled_services = [
      { id: 'done-1', customer_id: 'cust-1', status: 'confirmed', is_recurring: true, scheduled_date: '2099-01-01', track_state: 'complete', service_type: 'Quarterly Pest Control' },
    ];
    tables.estimates = [];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    const [withComplete] = recompute.mock.calls[recompute.mock.calls.length - 1];
    expect(Object.keys(withComplete.engineInputs.services).sort()).toEqual(['lawn', 'pest']);

    tables.scheduled_services[0].track_state = 'en_route';
    tables.estimates = [];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('0123456789abcdef') });
    const [withLive] = recompute.mock.calls[recompute.mock.calls.length - 1];
    expect(Object.keys(withLive.engineInputs.services)).toEqual(['lawn']);
  });

  test('a STORED commercial property never gets an online restart price — refused before reuse or mint (codex pre-push P0)', async () => {
    tables.customers[0].property_type = 'commercial';
    // Even a LIVE reusable restart estimate must not be handed back.
    tables.estimates.push({
      id: 'est-live', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'live-tok', expires_at: '2099-01-01', archived_at: null,
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'], cancellationCaseId: 'case-1', cancellationRequestId: null } }),
    });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(recompute).not.toHaveBeenCalled();
    expect(tables.estimates).toHaveLength(1); // nothing new minted
  });

  test('a RESOLVED commercial property (cached lookup / seed classification) refuses too', async () => {
    const d = deps();
    d.pricingAi.resolvePropertyContext = async () => ({
      propertyInput: { homeSqFt: 2200, lotSqFt: 9000, stories: 1, propertyType: 'commercial' },
      grassType: 'st_augustine', palmCount: null,
    });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(recompute).not.toHaveBeenCalled();
    expect(tables.estimates).toHaveLength(0);
  });

  test('an unevaluable commercial check fails closed (never prices blind)', async () => {
    const d = deps({ isCommercialProperty: () => { throw new Error('classifier boom'); } });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(recompute).not.toHaveBeenCalled();
    expect(tables.estimates).toHaveLength(0);
  });

  test('the mint takes the customer-comms advisory lock BEFORE its customers row lock (lock-order contract)', async () => {
    const ops = [];
    const orderedDb = { transaction: async (fn) => fn(fakeTrx(ops)) };
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: orderedDb }), randomBytes: () => Buffer.from('abcdef0123456789') });
    const advisoryIdx = ops.findIndex((op) => op.includes('pg_advisory_xact_lock') && op.includes('customer-comms:cust-1'));
    const customerReadIdx = ops.findIndex((op) => op.startsWith('read:customers'));
    expect(advisoryIdx).toBe(0); // FIRST statement of the transaction
    expect(customerReadIdx).toBeGreaterThan(advisoryIdx);
    expect(ops[customerReadIdx]).toBe('read:customers:forUpdate');
  });

  test('a multi-premises profile never gets an online restart price (proof false, proof unreadable, or no provable primary street)', async () => {
    // Proof says a second premises exists → priced-by-hand 409, no row.
    let d = deps({ customerHasOnlyPrimaryPremises: async () => false });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);
    expect(recompute).not.toHaveBeenCalled();

    // An unreadable proof is not evidence of a single premises — refuse.
    d = deps({ customerHasOnlyPrimaryPremises: async () => { throw new Error('witness boom'); } });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);

    // No primary street on the customer row → the proof cannot anchor.
    tables.customers[0].address_line1 = null;
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);
  });

  test('a first line with no house number gets no online restart price: its home key would name no house (codex pre-push r31 P1)', async () => {
    for (const [line1, line2] of [['', 'Apt 4'], ['Apt 4', null], ['#4', null], ['Apt#4', null], ['Apt # AB', null], ['4B', null], ['PH1', null], ['Bldg 2, Apt 4', null], ['4', null],
      ['Parrish', null], ['Apt 4, Parrish, FL 34219', null], ['Main St', null], ['59th Ave E', null], ['5th Floor', null], ['PO Box 123', null]]) {
      tables.customers[0] = { ...tables.customers[0], address_line1: line1, address_line2: line2 };
      await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    }
    expect(tables.estimates).toHaveLength(0);
    expect(recompute).not.toHaveBeenCalled();
    // A unit-first line carries its house number behind the unit.
    tables.customers[0] = { ...tables.customers[0], address_line1: 'Unit 4, 1 Main St', address_line2: null };
    const minted = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps(), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(minted.url).toEqual(expect.any(String));
  });

  test('a restart keeps main\'s premises proof: an unresolvable visit link or another profile on the account is not a second premises (plan start alone runs the strict one)', async () => {
    // Another profile on the account: the strict proof refuses it (codex pre-push r16 P0); a restart, as on main, does not read it.
    tables.customers.push({ ...CUSTOMER, id: 'cust-2', account_id: 'cust-1' });
    const proof = jest.fn(async (_db, _id, _customer, _street, options) => options?.unresolvedFails !== true);
    const minted = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ customerHasOnlyPrimaryPremises: proof }), randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(minted.url).toEqual(expect.any(String));
    expect(proof).toHaveBeenCalledWith(expect.anything(), 'cust-1', expect.anything(), expect.any(String), { unresolvedFails: false });
  });

  test('multi-premises also blocks REUSE of a live restart estimate (no URL of any kind)', async () => {
    tables.estimates.push({
      id: 'est-live', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'live-tok', expires_at: '2099-01-01', archived_at: null,
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'], cancellationCaseId: 'case-1', cancellationRequestId: null } }),
    });
    const d = deps({ customerHasOnlyPrimaryPremises: async () => false });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
  });

  test('verified property overrides on a lookup miss refuse the online price (and an unreadable probe refuses too)', async () => {
    // No usable lookup result (propertyLookup null) + a correction on file.
    let d = deps({ hasVerifiedOverrides: async () => true });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);
    expect(recompute).not.toHaveBeenCalled();

    // Probe failure is not evidence that no corrections exist.
    d = deps({ hasVerifiedOverrides: async () => { throw new Error('probe boom'); } });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);
  });

  test('a USABLE lookup result skips the override probe (corrections are folded into the result)', async () => {
    // The lookup returns a clean payload → the probe (which would refuse)
    // must not run; the resolver receives the tracked wrapper.
    const d = deps({
      propertyLookup: async () => ({ enriched: { homeSqFt: 2200 } }),
      hasVerifiedOverrides: async () => { throw new Error('must not be called'); },
    });
    d.pricingAi.resolvePropertyContext = async (args) => {
      await args.propertyLookup('1 Main St, Parrish, FL 34219');
      return { propertyInput: { homeSqFt: 2200, lotSqFt: 9000, stories: 1 }, grassType: 'st_augustine', palmCount: null };
    };
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d, randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(result.reused).toBe(false);
    expect(tables.estimates).toHaveLength(1);
  });

  test('the accepted-estimate property seed and cache-only lookup reach the property resolver', async () => {
    const seen = {};
    const d = deps({
      crossSell: { loadEstimateSeed: async () => ({ homeSqFt: 2450 }) },
      propertyLookup: 'cache-only-stub',
    });
    d.pricingAi.resolvePropertyContext = async (args) => {
      Object.assign(seen, { propertySeed: args.propertySeed, propertyLookup: args.propertyLookup });
      return { propertyInput: { homeSqFt: 2450, lotSqFt: 9000, stories: 1 }, grassType: 'st_augustine', palmCount: null };
    };
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d, randomBytes: () => Buffer.from('abcdef0123456789') });
    expect(seen.propertySeed).toEqual({ homeSqFt: 2450 });
    expect(seen.propertyLookup).toBe('cache-only-stub');
  });

  test('a property that cannot be priced online is pricing_unavailable, and a snapshot that will not freeze throws (no row survives)', async () => {
    const d = deps();
    d.pricingAi.missingPropertyFor = () => 'home_sqft';
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: d })).rejects.toMatchObject({ code: 'pricing_unavailable' });
    expect(tables.estimates).toHaveLength(0);

    const bad = deps({ buildEstimateSendSnapshot: async (row) => ({ ...JSON.parse(row.estimate_data), sendSnapshot: { pricingBundleError: 'boom' } }) });
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: bad })).rejects.toThrow(/did not freeze pricing/);
  });
});

// ── accept-time revalidation (codex GH r4 P1): the checks the public accept
// transaction re-runs on a plan_restart estimate under the estimate row lock.
// The cap on how many mints hold a transaction at once in one process (#8132 pre-push r26, r40): a mint
// holds its transaction's connection and reads on a second one from the pool, so as many mints as the pool
// has connections could each hold one and wait for a second that no one can give. plan-mint-pool.db.test.js
// proves the cap on a real pool; this pins its rules.
describe('mintTransaction', () => {
  const { mintTransaction } = actualRestart;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // A handle whose transaction runs the work, as knex does. Its pool has `max` connections, or is unknown.
  const handle = (max) => ({
    ...(max === undefined ? {} : { client: { pool: { max } } }),
    transaction: (work) => work('trx'),
  });
  // Starts `count` mints that each wait for their own release. Returns what has started, and the releases.
  function start(dbh, count) {
    const started = [];
    const ended = [];
    const releases = [];
    const settled = Array.from({ length: count }, (_unused, i) => mintTransaction(dbh, async (trx) => {
      started.push(i);
      await new Promise((resolve) => { releases[i] = resolve; });
      ended.push(i);
      return `${trx}-${i}`;
    }));
    return { started, ended, releases, settled };
  }
  async function drain(run) {
    for (let i = 0; i < run.settled.length; i += 1) {
      while (!run.releases[i]) await tick();
      run.releases[i]();
      await run.settled[i];
    }
  }

  test('one mint for every four pool connections runs at once; the rest wait in line, first come first served', async () => {
    const run = start(handle(8), 5);
    await tick();
    expect(run.started).toEqual([0, 1]);
    // A finished mint hands its slot to the first one in line: never to a later one, never two at once.
    run.releases[1]();
    await run.settled[1];
    await tick();
    expect(run.started).toEqual([0, 1, 2]);
    run.releases[0]();
    await tick();
    expect(run.started).toEqual([0, 1, 2, 3]);
    await drain(run);
    expect(run.started).toEqual([0, 1, 2, 3, 4]);
    // Each mint gets its own transaction's answer.
    expect(await Promise.all(run.settled)).toEqual(['trx-0', 'trx-1', 'trx-2', 'trx-3', 'trx-4']);
  });

  test.each([
    [20, 5], [10, 2], [7, 1], [4, 1], [0, 5], [undefined, 5], ['not a number', 5],
  ])('a pool of %s connections runs %s mints at once', async (max, limit) => {
    const run = start(handle(max), 7);
    await tick();
    expect(run.started).toHaveLength(limit);
    await drain(run);
    expect(run.ended).toHaveLength(7);
  });

  test('a mint that fails frees its slot, and its error reaches its own caller', async () => {
    const dbh = handle(4);
    const failed = mintTransaction(dbh, async () => { throw new Error('mint boom'); });
    const cannotOpen = mintTransaction({ ...dbh, transaction: () => { throw new Error('pool gone'); } }, async () => 'never');
    const after = mintTransaction(dbh, async () => 'ran');
    await expect(failed).rejects.toThrow('mint boom');
    await expect(cannotOpen).rejects.toThrow('pool gone');
    await expect(after).resolves.toBe('ran');
    // Nothing is left held: the next mints start at once, up to the limit.
    const run = start(handle(8), 3);
    await tick();
    expect(run.started).toEqual([0, 1]);
    await drain(run);
  });

  // #8256 pre-push r1: the wait in line has an end. A mint that started long after its tap would archive
  // a quote, and free its slot hold, for a customer whose page already gave up.
  describe('a mint that waits in line longer than 10 seconds', () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }));
    afterEach(() => jest.useRealTimers());

    test('leaves the line with the coded "try again" refusal, never runs, and takes no slot from the mints behind it', async () => {
      const run = start(handle(4), 1);
      await tick();
      const ran = [];
      const waited = (name) => mintTransaction(handle(4), async () => { ran.push(name); return name; });
      const first = waited('first');
      const outcome = first.then(() => 'ran', (err) => err);
      jest.advanceTimersByTime(4000);
      const second = waited('second');
      jest.advanceTimersByTime(5999);
      await tick();
      expect(ran).toEqual([]);
      // 10 s after ITS tap, the first in line gives up. The route answers a restartUnavailable error
      // with 409 { error, code }; both cards show the message, and neither files a request for this code.
      jest.advanceTimersByTime(1);
      const refusal = await outcome;
      expect(refusal).toMatchObject({
        restartUnavailable: true, code: 'busy', message: 'We could not verify your services just now. Please try again in a moment.',
      });
      // The slot that frees next goes to the mint still in line, not to the one that left.
      run.releases[0]();
      await run.settled[0];
      await expect(second).resolves.toBe('second');
      expect(ran).toEqual(['second']);
      // Nothing is left held or waiting: a new mint starts at once, and no timer is pending.
      await expect(waited('third')).resolves.toBe('third');
      expect(jest.getTimerCount()).toBe(0);
    });

    test('a mint that gets its slot in time is not refused later', async () => {
      const run = start(handle(4), 1);
      await tick();
      let release;
      const slow = mintTransaction(handle(4), () => new Promise((resolve) => { release = resolve; }));
      jest.advanceTimersByTime(9999);
      run.releases[0]();
      await run.settled[0];
      await tick();
      // It runs now, and its wait has no timer left. A long mint is not cut off: the limit is on the
      // wait in line only.
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60000);
      release('minted');
      await expect(slow).resolves.toBe('minted');
    });
  });

  // #8256 pre-push r2: a pool under four connections has no quarter of its own. A mint beside one cron lock
  // holder would pin both connections of a pool of two (the knexfile floor), and each would wait for a third.
  // There the mint takes one of the lock holders' slots (utils/cron-lock.js): one holder of either kind at a time.
  describe('on a pool under four connections the mint takes a cron lock holder\'s slot', () => {
    const { holdLockSlot } = require('../utils/cron-lock');
    // The app's own pool, which the cron locks count, is the pool the mint runs on.
    const smallPool = (max) => { db.client = { pool: { max } }; return handle(max); };
    afterEach(() => { delete db.client; jest.useRealTimers(); });

    test.each([[3], [2]])('a pool of %s runs one mint at a time, first come first served', async (max) => {
      const run = start(smallPool(max), 3);
      await tick();
      expect(run.started).toEqual([0]);
      await drain(run);
      expect(run.ended).toEqual([0, 1, 2]);
    });

    test('a mint waits while a lock holder has the slot, and a lock holder gets none while a mint runs', async () => {
      const dbh = smallPool(2);
      const giveBack = await holdLockSlot('a-cron-job', 1000);
      const run = start(dbh, 1);
      await tick();
      expect(run.started).toEqual([]);
      giveBack();
      await tick();
      expect(run.started).toEqual([0]);
      // The running mint holds the only slot: a lock holder that asks now gets none in its 20 ms.
      await expect(holdLockSlot('another-cron-job', 20)).resolves.toBeNull();
      await drain(run);
      // The mint gave it back: the next holder has it at once.
      const after = await holdLockSlot('a-later-cron-job', 1000);
      expect(after).toEqual(expect.any(Function));
      after();
    });

    test('the wait there ends after 10 seconds with the same refusal, and a failed mint gives the slot back', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      const dbh = smallPool(2);
      const giveBack = await holdLockSlot('a-long-cron-job', 1000);
      const work = jest.fn(async () => 'never');
      let settled = false;
      const outcome = mintTransaction(dbh, work).then(() => 'ran', (err) => err).finally(() => { settled = true; });
      jest.advanceTimersByTime(9999);
      await tick();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await outcome).toMatchObject({
        restartUnavailable: true, code: 'busy', message: 'We could not verify your services just now. Please try again in a moment.',
      });
      expect(work).not.toHaveBeenCalled();
      giveBack();
      // The place that gave up took nothing, and a mint that fails or cannot open gives the slot back.
      await expect(mintTransaction(dbh, async () => { throw new Error('mint boom'); })).rejects.toThrow('mint boom');
      await expect(mintTransaction({ ...dbh, transaction: () => { throw new Error('pool gone'); } }, async () => 'never')).rejects.toThrow('pool gone');
      await expect(mintTransaction(dbh, async () => 'ran')).resolves.toBe('ran');
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  test('the restart mint runs in it: on a pool of four, three taps hold one transaction at a time', async () => {
    tables.customers = [{ ...CUSTOMER }];
    tables.cancellation_cases = [{ id: 'case-1', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-22' }];
    tables.estimates = [];
    recompute.mockResolvedValue({ recomputed: true, result: { engineVersion: 'v9.9' }, monthlyTotal: 45, annualTotal: 540, onetimeTotal: 0, serverTier: 'Bronze' });
    let open = 0;
    let peak = 0;
    const pooled = {
      client: { pool: { max: 4 } },
      transaction: async (fn) => {
        open += 1;
        peak = Math.max(peak, open);
        try { await tick(); return await fn(fakeTrx()); } finally { open -= 1; }
      },
    };
    const taps = await Promise.allSettled([1, 2, 3].map(() => actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: pooled }) })));
    // The first tap mints; the next two find its live quote.
    expect(taps.map((tap) => [tap.status, tap.value?.reused])).toEqual([['fulfilled', false], ['fulfilled', true], ['fulfilled', true]]);
    expect(peak).toBe(1);
  });
});

describe('assertRestartAcceptEligible', () => {
  const trx = fakeTrx();
  // The handler's pre-lock read of the row: its id and the customer it books for.
  const RESTART_ESTIMATE = { id: 'est-r1', customer_id: 'cust-1' };
  beforeEach(() => {
    tables.estimates = [{
      id: 'est-r1', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'tok-r1',
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'], cancellationCaseId: 'case-1', cancellationRequestId: null } }),
    }];
  });

  test('a still-churned account with no residual live families accepts', async () => {
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE)).resolves.toBeUndefined();
  });

  test('a quoted family that went LIVE after the mint refuses the accept (staff restored it)', async () => {
    tables.scheduled_services = [
      { id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Quarterly Pest Control' },
    ];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('a re-armed completed series anchor counts as live at accept time too', async () => {
    tables.scheduled_services = [
      { id: 'anchor', customer_id: 'cust-1', status: 'completed', is_recurring: true, recurring_ongoing: true, service_type: 'Lawn Care Program' },
    ];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('a residual family OUTSIDE the quote does not block the accept', async () => {
    tables.estimates[0].estimate_data = JSON.stringify({ planRestart: { families: ['lawn_care'], cancellationCaseId: 'case-1', cancellationRequestId: null } });
    tables.scheduled_services = [
      { id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Quarterly Pest Control' },
    ];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE)).resolves.toBeUndefined();
  });

  test('a NARROWER older quote refuses too — the quote must EQUAL the latest attempt\'s eligible set (codex pre-push P1)', async () => {
    // The latest attempt (default case) cancelled pest + lawn; an older
    // pest-only token would restart a subset at a composition the current
    // attempt never priced.
    tables.estimates[0].estimate_data = JSON.stringify({ planRestart: { families: ['pest_control'] } });
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('a quote from an EARLIER cancellation refuses once a re-cancellation changed the scope (codex GH r8 P1)', async () => {
    // The account is churned again and pest has no residual rows, but the
    // latest attempt cancelled only lawn — the old pest+lawn token must not
    // restart pest.
    tables.cancellation_cases = [{
      id: 'case-2', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['lawn_care']), created_at: '2026-08-25',
    }];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('a SAME-families re-cancellation refuses the prior attempt\'s token — attempt identity beyond set equality (codex GH r14 P1)', async () => {
    // Reactivate-then-recancel of the same families: churn stamp, residual
    // and set-equality checks all pass, but the frozen price belongs to
    // the earlier attempt. The case id no longer matches → refuse.
    tables.cancellation_cases = [{
      id: 'case-2', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control', 'lawn_care']), created_at: '2026-08-30',
    }];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });

    // A pre-stamp token (no attempt ids in planRestart) fails closed the
    // same way once any identified attempt exists.
    tables.cancellation_cases = [{
      id: 'case-1', customer_id: 'cust-1', status: 'committed', scope: JSON.stringify(['pest_control', 'lawn_care']), created_at: '2026-08-22',
    }];
    tables.estimates[0].estimate_data = JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'] } });
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('a reactivated (or drifted) account refuses: only the exact churn stamp accepts', async () => {
    tables.customers[0].active = true;
    tables.customers[0].pipeline_stage = 'active_customer';
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });

    tables.customers[0].active = null;
    tables.customers[0].pipeline_stage = 'churned';
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('malformed restart metadata or a missing customer refuses (never accept blind)', async () => {
    tables.estimates[0].estimate_data = JSON.stringify({});
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });

    tables.estimates[0].estimate_data = JSON.stringify({ planRestart: { families: ['pest_control'] } });
    tables.customers = [];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('an unreadable residual read fails closed with its own retry code (codex pre-push r32: a failed read is not a changed account, so the page keeps the held time)', async () => {
    const failingTrx = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('scheduled_services')) {
        b.whereNotIn = () => { throw new Error('rows read boom'); };
      }
      return b;
    });
    await expect(actualRestart.assertRestartAcceptEligible(failingTrx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_RECHECK_RETRY' });
  });

  test('a failed cancellation-request read answers the retry code, not a changed account (codex pre-push P1)', async () => {
    // Read leniently, the lookup fell back to "no request", the quote's stored request id then failed
    // the attempt identity check as a changed account, and the estimate page released a valid hold.
    tables.estimates[0].estimate_data = JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'], cancellationCaseId: 'case-1', cancellationRequestId: 'req-1' } });
    const failingTrx = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('service_requests')) { b.first = async () => { throw new Error('request read boom'); }; }
      return b;
    });
    await expect(actualRestart.assertRestartAcceptEligible(failingTrx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_RECHECK_RETRY' });
  });

  test('a failed historical prepay read answers the retry code, never a narrower family set read as a changed account (codex pre-push P1)', async () => {
    // A whole-account attempt (empty scope): its families come from rows and the attempt's prepay
    // terms. Only the historical prepay read, in its savepoint, fails; today's ownership read of
    // the same table runs on the transaction itself and succeeds.
    tables.cancellation_cases = [{ id: 'case-1', customer_id: 'cust-1', status: 'committed', scope: '[]', created_at: '2026-08-22' }];
    const t = fakeTrx();
    t.transaction = async (fn) => {
      const sp = (table) => {
        const b = t(table);
        if (table.startsWith('annual_prepay_terms')) b.then = () => { throw new Error('historical prepay read boom'); };
        return b;
      };
      Object.assign(sp, { raw: t.raw, transaction: t.transaction, busy: t.busy });
      return fn(sp);
    };
    await expect(actualRestart.assertRestartAcceptEligible(t, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_RECHECK_RETRY' });
  });

  test('a failed churn-correlation read answers the retry code, never the lenient correlation that skips the stale-attempt binding (codex pre-push P1)', async () => {
    // The locked customers read succeeds; only the correlation read (unlocked, in its savepoint) fails.
    const failingTrx = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('customers')) {
        let locked = false;
        const forUpdate = b.forUpdate;
        b.forUpdate = (...args) => { locked = true; return forUpdate(...args); };
        const first = b.first;
        b.first = async (...args) => {
          if (!locked) throw new Error('correlation read boom');
          return first(...args);
        };
      }
      return b;
    });
    await expect(actualRestart.assertRestartAcceptEligible(failingTrx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_RECHECK_RETRY' });
  });

  test('serializes BEFORE reading: the comms key, then the property-preferences key, then customers FOR UPDATE precede every eligibility read (codex pre-push P1; the converter\'s order, r28)', async () => {
    const ops = [];
    await actualRestart.assertRestartAcceptEligible(fakeTrx(ops), RESTART_ESTIMATE);
    const advisoryIdx = ops.findIndex((op) => op.includes('pg_advisory_xact_lock') && op.includes('customer-comms:cust-1'));
    const prefsIdx = ops.findIndex((op) => op.startsWith('raw:') && op.includes('"property-preferences","cust-1"'));
    const customerReadIdx = ops.findIndex((op) => op.startsWith('read:customers'));
    const residualReads = ops
      .map((op, i) => ({ op, i }))
      .filter(({ op }) => op.startsWith('read:scheduled_services'));
    // The comms key is taken first, then the property-preferences key, both BEFORE the customers
    // read: the converter after this check takes the property-preferences key before its own
    // customers row lock, so taking the row first would deadlock against a turf-profile save.
    expect(advisoryIdx).toBeGreaterThanOrEqual(0);
    expect(prefsIdx).toBeGreaterThan(advisoryIdx);
    expect(customerReadIdx).toBeGreaterThan(prefsIdx);
    // The customers read itself holds the row lock (a concurrent
    // reactivation UPDATE blocks until this accept commits or rolls back).
    expect(ops[customerReadIdx]).toBe('read:customers:forUpdate');
    // Every residual eligibility read runs after all three locks.
    expect(residualReads.length).toBeGreaterThan(0);
    for (const { i } of residualReads) expect(i).toBeGreaterThan(customerReadIdx);
  });

  test('the property-preferences key is tried, never waited on, while the comms key is held: a held key asks for the retry and reads no customer row (codex pre-push r33 to r35)', async () => {
    // A staff tier, rate or billing edit holds the property-preferences key and waits for the comms
    // key (admin-customers.js); a blocking acquire here would deadlock against it.
    const ops = [];
    await actualRestart.assertRestartAcceptEligible(fakeTrx(ops), RESTART_ESTIMATE);
    expect(ops.find((op) => op.includes('"property-preferences","cust-1"'))).toContain('pg_try_advisory_xact_lock');
    const busyOps = [];
    const busyTrx = fakeTrx(busyOps);
    busyTrx.busy = ['property-preferences'];
    await expect(actualRestart.assertRestartAcceptEligible(busyTrx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_RECHECK_RETRY' });
    expect(busyOps.some((op) => op.startsWith('read:customers'))).toBe(false);
  });

  test('an estimate moved to another customer since the handler read it refuses as changed and locks no customer (the plan-start rule, codex pre-push P0)', async () => {
    // A merge or its undo moved the row after the handler's pre-lock read; the handler books for
    // the customer it read, so the re-check must not validate the row's new owner instead.
    const ops = [];
    await expect(actualRestart.assertRestartAcceptEligible(fakeTrx(ops), { id: 'est-r1', customer_id: 'cust-0' }))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
    expect(ops.some((op) => op.startsWith('read:customers') || op.startsWith('raw:'))).toBe(false);
  });

  test.each(['bill_by_invoice', 'show_one_time_option'])('a quote staff changed after the handler read it (%s on the locked row) refuses as changed and takes no lock (codex pre-push P1)', async (column) => {
    // The handler read the row with both options off; a writer from before the write refusal
    // turned one on before the accept took the estimate row lock. Reads return only the columns
    // they name, as Postgres does, so the re-check must select both options.
    const namedColumns = (table) => {
      const b = builder(table);
      const first = b.first;
      b.first = async (...cols) => {
        const row = await first();
        return row && cols.length ? Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])) : row;
      };
      return b;
    };
    tables.estimates[0][column] = true;
    const ops = [];
    await expect(actualRestart.assertRestartAcceptEligible(fakeTrx(ops, namedColumns), RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED', message: expect.stringMatching(/restart quote changed since it was created/) });
    expect(ops).toEqual(['read:estimates']);
  });

  test('an unacquirable advisory lock fails closed with the retry code (never proceeds unfenced)', async () => {
    const t = fakeTrx();
    t.raw = async () => { throw new Error('lock boom'); };
    await expect(actualRestart.assertRestartAcceptEligible(t, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_RECHECK_RETRY' });
  });
});
