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
  b.update = async (patch) => { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit.length; };
  b.insert = (row) => {
    const list = (tables[table] ||= []);
    const inserted = { id: `${table}-${list.length + 1}`, created_at: new Date().toISOString(), ...row };
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
  t.raw = async (sql, bindings) => {
    if (ops) ops.push(`raw:${String(sql)}:${JSON.stringify(bindings)}`);
    return {};
  };
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
function deps(overrides = {}) {
  const pricingAi = require('../services/customer-pricing-ai');
  return {
    db: fakeDb,
    persistence: { serverRecomputeFromEstimateData: recompute, estimateExpiresAt: () => new Date('2026-10-01T00:00:00Z') },
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
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    expect(result.reused).toBe(false);
    expect(recompute).toHaveBeenCalledTimes(1);
    // Codex GH r6 P1: an expired-but-unarchived restart quote stays
    // revivable through /extension-request for 7 days — the replacement
    // mint must retire the whole unaccepted lineage.
    expect(tables.estimates.find((r) => r.id === 'est-old').archived_at).not.toBeNull();
    expect(tables.estimates.find((r) => r.id === 'est-done').archived_at).toBeNull();
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
describe('assertRestartAcceptEligible', () => {
  const trx = fakeTrx();
  const RESTART_ESTIMATE = { id: 'est-r1' };
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

  test('an unreadable residual read fails closed with a retryable 409', async () => {
    const failingTrx = fakeTrx(null, (table) => {
      const b = builder(table);
      if (table.startsWith('scheduled_services')) {
        b.whereNotIn = () => { throw new Error('rows read boom'); };
      }
      return b;
    });
    await expect(actualRestart.assertRestartAcceptEligible(failingTrx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });

  test('serializes BEFORE reading: comms advisory lock + customers FOR UPDATE precede every eligibility read (codex pre-push P1)', async () => {
    const ops = [];
    await actualRestart.assertRestartAcceptEligible(fakeTrx(ops), RESTART_ESTIMATE);
    const advisoryIdx = ops.findIndex((op) => op.includes('pg_advisory_xact_lock') && op.includes('customer-comms:cust-1'));
    const customerReadIdx = ops.findIndex((op) => op.startsWith('read:customers'));
    const residualReads = ops
      .map((op, i) => ({ op, i }))
      .filter(({ op }) => op.startsWith('read:scheduled_services'));
    // The advisory key is taken, and BEFORE the customers read.
    expect(advisoryIdx).toBeGreaterThanOrEqual(0);
    expect(customerReadIdx).toBeGreaterThan(advisoryIdx);
    // The customers read itself holds the row lock (a concurrent
    // reactivation UPDATE blocks until this accept commits or rolls back).
    expect(ops[customerReadIdx]).toBe('read:customers:forUpdate');
    // Every residual eligibility read runs after BOTH locks.
    expect(residualReads.length).toBeGreaterThan(0);
    for (const { i } of residualReads) expect(i).toBeGreaterThan(customerReadIdx);
  });

  test('an unacquirable advisory lock fails closed (never proceeds unfenced)', async () => {
    const t = fakeTrx();
    t.raw = async () => { throw new Error('lock boom'); };
    await expect(actualRestart.assertRestartAcceptEligible(t, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });
});
