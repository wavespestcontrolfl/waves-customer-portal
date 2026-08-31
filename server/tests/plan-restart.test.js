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
  b.where = (a, op, val) => {
    if (typeof a === 'function') {
      // grouped predicate (is_callback NULL OR false) — pass-through
      return b;
    }
    if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => conds.push((r) => String(r[norm(k)]) === String(v)));
    else if (val === undefined) conds.push((r) => String(r[norm(a)]) === String(op));
    else if (op === 'like') { const prefix = String(val).replace(/%$/, ''); conds.push((r) => String(r[norm(a)] || '').startsWith(prefix)); }
    else if (op === '>=') conds.push((r) => (r[norm(a)] ?? '') >= val);
    else conds.push((r) => String(r[norm(a)]) === String(val));
    return b;
  };
  b.whereNotIn = (col, vals) => { conds.push((r) => !vals.map(String).includes(String(r[norm(col)]))); return b; };
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
const fakeDb = { transaction: async (fn) => fn((table) => builder(table)) };

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
      transaction: async (fn) => fn((table) => {
        const b = builder(table);
        if (table === 'customer_interactions') {
          b.insert = () => Promise.reject(new Error('note insert boom'));
        }
        return b;
      }),
    };
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: failingDb }) }))
      .rejects.toThrow('note insert boom');
  });

  test('a second tap reuses the live restart estimate instead of minting beside it', async () => {
    tables.estimates.push({
      id: 'est-live', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'live-tok', expires_at: '2099-01-01', archived_at: null,
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'] } }),
    });
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    expect(result).toEqual({ estimateId: 'est-live', token: 'live-tok', url: '/estimate/live-tok', reused: true });
    expect(recompute).not.toHaveBeenCalled();
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

  test('an expired or archived prior restart estimate does not block a fresh mint', async () => {
    tables.estimates.push(
      { id: 'est-old', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'old', expires_at: '2020-01-01', archived_at: null },
      { id: 'est-arch', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'arch', expires_at: '2099-01-01', archived_at: '2026-08-01' },
    );
    const result = await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    expect(result.reused).toBe(false);
    expect(recompute).toHaveBeenCalledTimes(1);
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
    const found = await actualRestart.cancelledFamiliesFor('cust-1', (table) => builder(table));
    expect(found.caseId).toBe('case-1');
    expect(found.source).toBe('cancelled_rows');
    expect([...found.families].sort()).toEqual(['lawn_care', 'mosquito', 'pest_control']);
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
    const found = await actualRestart.cancelledFamiliesFor('cust-1', (table) => builder(table));
    expect(found).toEqual({ families: ['pest_control'], caseId: 'case-new', source: 'cancelled_rows' });
  });

  test('falls back to the scoped churn note, then reports nothing to restart', async () => {
    tables.cancellation_cases = [];
    tables.customer_interactions = [{ customer_id: 'cust-1', interaction_type: 'note', subject: 'Cancelled Lawn Care, Mosquito — plan continues with Pest Control', created_at: '2026-08-01' }];
    expect(await actualRestart.cancelledFamiliesFor('cust-1', (table) => builder(table))).toEqual({ families: ['lawn_care', 'mosquito'], caseId: null, source: 'churn_note' });

    tables.customer_interactions = [];
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'nothing_to_restart' });
    expect(tables.estimates).toHaveLength(0);
  });

  test('residual ownership fails closed; a family with LIVE recurring rows is dropped; nothing left = nothing_to_restart', async () => {
    // The pricing-ai ownership loaders answer [] for an inactive customer,
    // so the mint reads scheduled_services directly — a broken read refuses.
    const failingDb = {
      transaction: async (fn) => fn((table) => {
        const b = builder(table);
        if (table.startsWith('scheduled_services')) {
          b.whereNotIn = () => { throw new Error('rows read boom'); };
        }
        return b;
      }),
    };
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps({ db: failingDb }) }))
      .rejects.toMatchObject({ code: 'pricing_unavailable' });

    // A LIVE recurring pest row (staff restored it) drops pest from the
    // quote and prices lawn at the combined tier.
    tables.scheduled_services = [
      { id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, service_type: 'Quarterly Pest Control' },
    ];
    await actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() });
    const [estimateData, recomputeDeps] = recompute.mock.calls[0];
    expect(Object.keys(estimateData.engineInputs.services)).toEqual(['lawn']);
    expect(recomputeDeps.priorQualifyingServices).toEqual(['pest_control']);

    // Both families live again = nothing to restart.
    tables.scheduled_services.push(
      { id: 'live-2', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, service_type: 'Lawn Care Program' },
    );
    tables.estimates = [];
    await expect(actualRestart.mintRestartEstimate({ customer: CUSTOMER, deps: deps() })).rejects.toMatchObject({ code: 'nothing_to_restart' });
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
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'] } }),
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
  const trx = (table) => builder(table);
  const RESTART_ESTIMATE = { id: 'est-r1' };
  beforeEach(() => {
    tables.estimates = [{
      id: 'est-r1', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'tok-r1',
      estimate_data: JSON.stringify({ planRestart: { families: ['pest_control', 'lawn_care'] } }),
    }];
  });

  test('a still-churned account with no residual live families accepts', async () => {
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE)).resolves.toBeUndefined();
  });

  test('a quoted family that went LIVE after the mint refuses the accept (staff restored it)', async () => {
    tables.scheduled_services = [
      { id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, service_type: 'Quarterly Pest Control' },
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
    tables.estimates[0].estimate_data = JSON.stringify({ planRestart: { families: ['lawn_care'] } });
    tables.scheduled_services = [
      { id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, service_type: 'Quarterly Pest Control' },
    ];
    await expect(actualRestart.assertRestartAcceptEligible(trx, RESTART_ESTIMATE)).resolves.toBeUndefined();
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
    const failingTrx = (table) => {
      const b = builder(table);
      if (table.startsWith('scheduled_services')) {
        b.whereNotIn = () => { throw new Error('rows read boom'); };
      }
      return b;
    };
    await expect(actualRestart.assertRestartAcceptEligible(failingTrx, RESTART_ESTIMATE))
      .rejects.toMatchObject({ status: 409, code: 'RESTART_STATE_CHANGED' });
  });
});
