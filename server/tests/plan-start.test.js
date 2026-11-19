'use strict';

// GATE_PORTAL_PLAN_START (owner 2026-11-19): POST /api/requests/start-plan (dark = 404; refusal = 409 { error, code };
// success = the estimate path) and mintPlanStartEstimate — the portal pricing card's first-plan estimate for an
// account with NO live recurring service. Same mint core as plan restart (publish without delivery, server recompute,
// frozen snapshot); this suite pins what is different: eligibility, the exact option priced, price parity with what
// the card showed, per-option reuse versus supersede, and the accept-time revalidation.

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
  // The shared live-plan reader (waveguard-existing-services) skips one-time booking sources.
  isOneTimeBookingSource: (source) => ['estimate-accept', 'quote-wizard-onetime', 'admin-manual-booking-resend'].includes(String(source || '').toLowerCase()),
  uniqueServiceFamilies: (keys) => Array.from(new Set(keys.map((k) => ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'].find((f) => k === f || k.startsWith(`${f}_`)) || k))),
}));


const mockMint = jest.fn();
jest.mock('../services/cancellation-resolution/restart', () => {
  const actual = jest.requireActual('../services/cancellation-resolution/restart');
  return { ...actual, mintPlanStartEstimate: (...args) => mockMint(...args) };
});

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customer = { id: 'cust-1', first_name: 'Pat', active: true, pipeline_stage: 'new_lead' };
    req.customerId = 'cust-1';
    req.customerInactive = false;
    next();
  },
  authenticateAllowInactive: (req, _res, next) => { req.customer = { id: 'cust-1' }; next(); },
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/requests');
const restart = require('../services/cancellation-resolution/restart');
// The route tests mock the mint; the unit tests below run the real one.
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
beforeEach(() => { process.env.GATE_PORTAL_PLAN_START = 'true'; mockMint.mockReset(); });
afterEach(() => { delete process.env.GATE_PORTAL_PLAN_START; });

const GOOD_SHOWN = { monthly: 31.67, perVisit: 95.01, dueAtStart: null, oneTime: null };
const GOOD_BODY = { serviceKey: 'pest_control', optionId: 'pest-quarterly', shown: GOOD_SHOWN };
async function post(body = GOOD_BODY) {
  const res = await fetch(`${baseUrl}/api/requests/start-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}

describe('POST /api/requests/start-plan', () => {
  test('dark = 404 { error: Not found }, nothing minted', async () => {
    delete process.env.GATE_PORTAL_PLAN_START;
    const res = await post();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('success hands back the estimate path and passes the body to the mint', async () => {
    mockMint.mockResolvedValueOnce({ estimateId: 'est-1', token: 'tok', url: '/estimate/tok', reused: true });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, url: '/estimate/tok', estimateId: 'est-1', reused: true });
    expect(mockMint).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ id: 'cust-1' }), serviceKey: 'pest_control', optionId: 'pest-quarterly', shown: GOOD_SHOWN,
    }));
  });

  test('a mint refusal maps to 409 { error, code }; an unexpected failure is a 500', async () => {
    mockMint.mockRejectedValueOnce(new restart.RestartUnavailableError('offer_changed', 'The price changed.'));
    let res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'The price changed.', code: 'offer_changed' });

    mockMint.mockRejectedValueOnce(new Error('snapshot did not freeze'));
    res = await post();
    expect(res.status).toBe(500);
  });

  test('a bad body is a 400 and never reaches the mint', async () => {
    for (const body of [
      {}, { ...GOOD_BODY, serviceKey: 'rodent_bait' }, { ...GOOD_BODY, optionId: '' }, { serviceKey: 'pest_control', optionId: 'pest-quarterly' },
      { ...GOOD_BODY, shown: { ...GOOD_SHOWN, monthly: 0 } }, { ...GOOD_BODY, shown: { ...GOOD_SHOWN, monthly: 'abc' } },
      { ...GOOD_BODY, shown: { ...GOOD_SHOWN, perVisit: -1 } }, { ...GOOD_BODY, shown: { perVisit: 95.01 } },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mockMint).not.toHaveBeenCalled();
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
  // The shared live-plan reader (loadActiveRecurringServiceRows) asks which columns exist.
  b.columnInfo = async () => ({ is_recurring: {}, is_callback: {}, source: {} });
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
      // Log the base table: the residual read aliases it ('scheduled_services as s').
      const name = String(table).split(' as ')[0];
      let locked = false;
      const origForUpdate = b.forUpdate;
      b.forUpdate = () => { locked = true; return origForUpdate(); };
      const origFirst = b.first;
      b.first = (...args) => { ops.push(`read:${name}${locked ? ':forUpdate' : ''}`); return origFirst(...args); };
      const origThen = b.then;
      b.then = (resolve, reject) => { ops.push(`read:${name}`); return origThen(resolve, reject); };
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
// The frozen bundle in the real builder's shape (frequencies[] plus services[], each section with
// defaultFrequencyKey and frequencies[]): one section for the minted family whose opening entry
// carries the row's own totals and one treatment row at the per-application price the card
// derives from the stored engine line. Its one-time money itemizes the stored result's one-time
// items plus the WaveGuard setup fee, as the real page does. A test that moves the page's opening
// entry passes `entry`; one that moves the bundle's one-time money passes `extra`.
function openingBundle(row, entry = {}, extra = {}) {
  const data = JSON.parse(row.estimate_data);
  const family = data.planStart?.families?.[0];
  const line = data.result?.lineItems?.[0] || null;
  const perApplication = line ? require('../services/customer-pricing-ai').quoteAmountFromLine(line).perVisit : null;
  const opening = {
    key: 'opening', monthly: row.monthly_total, annual: row.annual_total,
    perServiceTreatments: [{ service: family, perTreatment: perApplication, displayPrice: perApplication, visitsPerYear: line?.visitsPerYear ?? null }],
    ...entry,
  };
  const oneTime = data.result?.oneTime || {};
  const setupFee = Number(oneTime.membershipFee || 0) > 0
    ? { service: 'waveguard_setup', amount: oneTime.membershipFee, label: 'WaveGuard setup' } : null;
  const items = [
    ...(oneTime.items || []).map((item) => ({ service: item.service, label: item.name, amount: item.price, kind: 'charge', quoteRequired: false })),
    ...(setupFee ? [{ ...setupFee, kind: 'charge', quoteRequired: false }] : []),
  ];
  return {
    frequencies: [opening],
    services: [{ key: family, defaultFrequencyKey: 'opening', frequencies: [opening] }],
    oneTimeBreakdown: { items, total: oneTime.total ?? 0, quoteRequired: false },
    setupFee,
    ...extra,
  };
}
const snapshotWith = (entry, extra) => async (row) => ({ ...JSON.parse(row.estimate_data), sendSnapshot: { pricingBundle: openingBundle(row, entry, extra) } });
function deps(overrides = {}) {
  const pricingAi = require('../services/customer-pricing-ai');
  return {
    db: fakeDb,
    persistence: { serverRecomputeFromEstimateData: recompute, estimateExpiresAt: () => new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    pricingAi: {
      variantsForService: pricingAi.variantsForService,
      optionServices: pricingAi.optionServices,
      quoteAmountFromLine: pricingAi.quoteAmountFromLine,
      findLineItem: pricingAi.findLineItem,
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
    buildEstimateSendSnapshot: snapshotWith({}),
    // The public page's snapshot predicate: serves as is here; plan-start-snapshot-reader.test.js
    // runs the real one on a real bundle.
    sentSnapshotServesAsIs: () => true,
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


// The lead's own row: ACTIVE, not churned, no plan membership, no recurring rows.
const LEAD = { ...CUSTOMER, active: true, pipeline_stage: 'new_lead', waveguard_tier: null, billing_mode: null, monthly_rate: null };
// An engine line, and what the card shows for it through the REAL quoteAmountFromLine — so a
// test's `shown` matches its recompute unless the test drifts one amount on purpose.
function engineLine(service, monthly, extra = {}) {
  return { service, monthlyAfterDiscount: monthly, annualAfterDiscount: Math.round(monthly * 1200) / 100, visitsPerYear: 4, ...extra };
}
function shownOf(line) {
  const amount = require('../services/customer-pricing-ai').quoteAmountFromLine(line);
  return { monthly: amount.monthly ?? null, perVisit: amount.perVisit ?? null, dueAtStart: amount.dueAtStart ?? null, oneTime: amount.oneTime ?? null };
}
// The server's quote for one engine line. Its one-time money is the line's own one-time amounts
// (what the card shows as due at start and one-time) plus `setupFee`, the WaveGuard setup fee the
// engine adds on its own (result.oneTime.membershipFee), as in a real recompute.
function pricedAs(line, { setupFee = 0 } = {}) {
  const card = require('../services/customer-pricing-ai').quoteAmountFromLine(line);
  const charges = Number(card.dueAtStart || 0) + Number(card.oneTime || 0);
  const oneTime = {
    items: charges > 0 ? [{ service: `${line.service}_installation`, name: 'Installation', price: charges }] : [],
    total: charges + setupFee,
    membershipFee: setupFee,
  };
  return {
    recomputed: true,
    serverResult: { engineVersion: 'v9.9', lineItems: [line], oneTime },
    rawEngineResult: { waveGuard: { tier: 'Bronze' }, lineItems: [line] },
    serverTotals: { monthlyTotal: line.monthlyAfterDiscount, annualTotal: line.annualAfterDiscount, onetimeTotal: oneTime.total },
  };
}
const PEST_LINE = engineLine('pest_control', 31.67);
const BIMONTHLY_LINE = engineLine('pest_control', 44, { visitsPerYear: 6 });
const LAWN_LINE = engineLine('lawn_care', 49, { visitsPerYear: 9 });
const PREMIUM_LAWN_LINE = engineLine('lawn_care', 65, { visitsPerYear: 12 });
const FIXED_NOW = () => new Date('2026-11-19T12:00:00Z');
const TOKEN_BYTES = () => Buffer.from('abcdef0123456789');
function mint(overrides = {}, depOverrides = {}) {
  return actualRestart.mintPlanStartEstimate({
    customer: LEAD, serviceKey: 'pest_control', optionId: 'pest-quarterly', shown: shownOf(PEST_LINE), deps: deps(depOverrides), now: FIXED_NOW, randomBytes: TOKEN_BYTES, ...overrides,
  });
}

describe('mintPlanStartEstimate', () => {
  beforeEach(() => {
    tables.customers = [{ ...LEAD }];
    tables.cancellation_cases = [];
    recompute.mockResolvedValue(pricedAs(PEST_LINE));
  });

  test('mints a published, server-priced estimate for exactly the option shown, nothing sent', async () => {
    const result = await mint();
    expect(result).toEqual({ estimateId: 'estimates-1', token: '61626364656630313233343536373839', url: '/estimate/61626364656630313233343536373839', reused: false });
    const [estimateData] = recompute.mock.calls[0];
    expect(estimateData.engineInputs.services).toEqual({ pest: { frequency: 'quarterly', version: undefined } });
    expect(estimateData.noEngagementAutomation).toBe(true);
    const row = tables.estimates[0];
    expect(row).toMatchObject({
      customer_id: 'cust-1', source: 'plan_start', status: 'sent', pricing_authority: 'SERVER',
      followup_unviewed_sent: true, followup_viewed_sent: true, followup_final_sent: true, followup_expiring_sent: true,
      monthly_total: 31.67, service_interest: 'Pest Control',
    });
    const stored = JSON.parse(row.estimate_data);
    expect(stored.planStart).toEqual({ families: ['pest_control'], serviceKey: 'pest_control', optionId: 'pest-quarterly', mintedAt: '2026-11-19T12:00:00.000Z' });
    expect(stored.planRestart).toBeUndefined();
    expect(stored.sendSnapshot).toBeTruthy();
    // Timeline note only: no request row, no bell, no customer message.
    expect(tables.customer_interactions).toHaveLength(1);
    expect(tables.customer_interactions[0]).toMatchObject({
      customer_id: 'cust-1', interaction_type: 'note', subject: 'Plan estimate opened from portal — Pest Control',
    });
    expect(tables.customer_interactions[0].body).toBe("Customer opened a plan estimate (estimates-1) priced at today's rates. Accepting it books the first visit.");
    expect(tables.service_requests).toBeUndefined();
  });

  test('prices the SELECTED option, not the generic first one (premium lawn)', async () => {
    recompute.mockResolvedValue(pricedAs(PREMIUM_LAWN_LINE));
    await mint({ serviceKey: 'lawn_care', optionId: 'lawn-premium', shown: shownOf(PREMIUM_LAWN_LINE) });
    expect(recompute.mock.calls[0][0].engineInputs.services.lawn.tier).toBe('premium');
    expect(JSON.parse(tables.estimates[0].estimate_data).planStart.optionId).toBe('lawn-premium');
  });

  test('freezes the page snapshot with no delivery stamp: nothing was delivered', async () => {
    const snapshot = jest.fn(snapshotWith({}));
    await mint({}, { buildEstimateSendSnapshot: snapshot });
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ source: 'plan_start' }), FIXED_NOW, { delivered: false });
  });

  test('termite prices through the termite_bait family, its station setup checked like every shown amount', async () => {
    const termite = engineLine('termite_bait', 35, { installation: { price: 199 } });
    recompute.mockResolvedValue(pricedAs(termite));
    await mint({ serviceKey: 'termite', optionId: 'termite-basic', shown: shownOf(termite) });
    expect(recompute.mock.calls[0][0].engineInputs.services.termite).toEqual({ system: 'trelona', monitoringTier: 'basic' });
    expect(JSON.parse(tables.estimates[0].estimate_data).planStart.families).toEqual(['termite_bait']);
    // The setup the card shows as due at start is the quote's one-time money.
    expect(tables.estimates[0].onetime_total).toBe(199);
  });

  describe('eligibility refusals (fail closed, never a mint)', () => {
    const refused = async (code, overrides, depOverrides) => {
      await expect(mint(overrides, depOverrides)).rejects.toMatchObject({ code, restartUnavailable: true });
      expect(tables.estimates).toHaveLength(0);
      expect(recompute).not.toHaveBeenCalled();
    };

    test('a member (any live recurring service) keeps the request flow', async () => {
      tables.scheduled_services = [{ id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Quarterly Pest Control' }];
      await refused('not_eligible');
    });

    test('a member owning a DIFFERENT family is still refused', async () => {
      tables.scheduled_services = [{ id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Lawn Care Program' }];
      await refused('not_eligible');
    });

    test('a recurring visit still on site after ET midnight is a plan (the shared live-plan reader)', async () => {
      // Past-dated and not a rebook row: the restart read alone drops it.
      tables.scheduled_services = [{ id: 'ip-1', customer_id: 'cust-1', status: 'on_site', is_recurring: true, scheduled_date: '2000-01-01', service_type: 'Quarterly Pest Control' }];
      expect(await actualRestart._test.ownedResidualFamilies(fakeTrx(), 'cust-1')).toEqual([]);
      await refused('not_eligible');
    });

    test('bi-monthly or monthly pest is not offered: the estimate page opens pest on quarterly', async () => {
      await refused('not_eligible', { optionId: 'pest-bimonthly', shown: shownOf(BIMONTHLY_LINE) });
      await refused('not_eligible', { optionId: 'pest-monthly', shown: shownOf(BIMONTHLY_LINE) });
    });

    test('a live rodent monitoring plan is a plan too (the restart residual skips rodent-led rows)', async () => {
      tables.scheduled_services = [{ id: 'rodent-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Rodent Bait Monitoring' }];
      expect(await actualRestart._test.ownedResidualFamilies(fakeTrx(), 'cust-1')).toEqual([]);
      await refused('not_eligible');
    });

    test('an annual prepay term still covering today is a plan, whatever its family', async () => {
      tables.annual_prepay_terms = [{
        id: 'term-1', customer_id: 'cust-1', status: 'active', term_start: '2020-01-01', term_end: '2099-12-31',
        plan_label: 'Rodent Bait Monitoring', last_scheduled_service_id: null, prepay_invoice_id: null,
      }];
      await refused('not_eligible');
    });

    test.each([
      ['a real WaveGuard tier', { waveguard_tier: 'Silver' }],
      ['a plan billing lane', { billing_mode: 'annual_prepay' }],
      ['a legacy monthly rate', { monthly_rate: 45 }],
    ])('a member by the account row (%s) keeps the request flow', async (_label, membership) => {
      tables.customers = [{ ...LEAD, ...membership }];
      await refused('not_eligible');
    });

    test('a sentinel tier or a per-visit lane is not a plan: it mints', async () => {
      tables.customers = [{ ...LEAD, waveguard_tier: 'One-Time', billing_mode: 'per_visit' }];
      await expect(mint()).resolves.toMatchObject({ reused: false });
    });

    test('a churned account uses restart, not this', async () => {
      tables.customers = [{ ...CUSTOMER }];
      await refused('not_eligible');
    });

    test('active drifted to false or NULL (customer auth reads NULL as inactive), or a missing / deleted row, refuses', async () => {
      tables.customers = [{ ...LEAD, active: false }];
      await refused('not_eligible');
      tables.customers = [{ ...LEAD, active: null }];
      await refused('not_eligible');
      tables.customers = [{ ...LEAD, deleted_at: '2026-11-01' }];
      await refused('not_eligible');
      tables.customers = [];
      await refused('not_eligible');
    });

    test('a commercial property is priced by hand (stored type and resolved type)', async () => {
      tables.customers = [{ ...LEAD, property_type: 'commercial' }];
      await refused('pricing_unavailable');
      tables.customers = [{ ...LEAD }];
      await refused('pricing_unavailable', {}, {
        pricingAi: { ...deps().pricingAi, resolvePropertyContext: async () => ({ propertyInput: { propertyType: 'commercial', homeSqFt: 2200 }, grassType: 'st_augustine' }) },
      });
    });

    test('a multi-premises profile, or a proof that cannot run, is priced by hand', async () => {
      await refused('pricing_unavailable', {}, { customerHasOnlyPrimaryPremises: async () => false });
      await refused('pricing_unavailable', {}, { customerHasOnlyPrimaryPremises: async () => { throw new Error('boom'); } });
    });

    test('no property measurement, or a verified correction the price did not carry, is priced by hand', async () => {
      await refused('pricing_unavailable', {}, { pricingAi: { ...deps().pricingAi, missingPropertyFor: () => 'home_sqft' } });
      await refused('pricing_unavailable', {}, { hasVerifiedOverrides: async () => true });
    });

    test('a review marker on the priced line is priced by hand', async () => {
      recompute.mockResolvedValueOnce({
        recomputed: true, serverResult: {}, rawEngineResult: { fieldVerify: ['lot'], lineItems: [] },
        serverTotals: { monthlyTotal: 31.67, annualTotal: 380.04, onetimeTotal: 0 },
      });
      await expect(mint()).rejects.toMatchObject({ code: 'pricing_unavailable' });
      expect(tables.estimates).toHaveLength(0);
    });

    test('an unknown option, an unlisted service, or an unusable shown price refuses before any DB work', async () => {
      await refused('not_eligible', { optionId: 'pest-weekly' });
      await refused('not_eligible', { optionId: 'lawn-enhanced' });
      await refused('not_eligible', { serviceKey: 'rodent_bait', optionId: 'rodent-bait' });
      // Mosquito keeps the request flow: its plan adds a setup fee its line does not declare.
      await refused('not_eligible', { serviceKey: 'mosquito', optionId: 'mosquito-seasonal' });
      await refused('not_eligible', { shown: { ...shownOf(PEST_LINE), monthly: 0 } });
      await refused('not_eligible', { shown: { ...shownOf(PEST_LINE), monthly: 'abc' } });
      await refused('not_eligible', { shown: undefined });
    });

    test('an unreadable ownership lookup fails closed', async () => {
      const failingDb = { transaction: async (fn) => fn(fakeTrx(null, (table) => {
        // The residual read aliases the table ('scheduled_services as s').
        if (String(table).split(' as ')[0] === 'scheduled_services') throw new Error('pg down');
        return builder(table);
      })) };
      await refused('pricing_unavailable', {}, { db: failingDb });
    });
  });

  describe('price parity with the card', () => {
    test('a recomputed monthly that differs from what the card showed refuses with offer_changed and mints nothing', async () => {
      await expect(mint({ shown: { ...shownOf(PEST_LINE), monthly: 29.99 } })).rejects.toMatchObject({ code: 'offer_changed', restartUnavailable: true });
      expect(tables.estimates).toHaveLength(0);
      expect(tables.customer_interactions).toHaveLength(0);
    });

    test.each([
      ['a per-application price changed', PEST_LINE, { perVisit: 90 }],
      ['a setup fee the card did not show appeared', engineLine('pest_control', 31.67, { installation: { price: 199 } }), {}],
      ['a one-time price changed', engineLine('pest_control', 31.67, { price: 150 }), { oneTime: 140 }],
    ])('%s, monthly unchanged: offer_changed, nothing minted (every shown amount, to the cent)', async (_label, todayLine, drift) => {
      recompute.mockResolvedValue(pricedAs(todayLine));
      await expect(mint({ shown: { ...shownOf(PEST_LINE), ...drift } })).rejects.toMatchObject({ code: 'offer_changed' });
      expect(tables.estimates).toHaveLength(0);
    });

    test('within the same cent still mints; the client amounts are never stored', async () => {
      await mint({ shown: { ...shownOf(PEST_LINE), monthly: 31.674 } });
      expect(tables.estimates).toHaveLength(1);
      expect(tables.estimates[0].monthly_total).toBe(31.67);
      expect(tables.estimates[0].estimate_data).not.toContain('31.674');
      expect(tables.estimates[0].estimate_data).not.toContain('"shown"');
    });
  });

  describe('the estimate page opens on the card\'s price', () => {
    test.each([
      ['another monthly price', snapshotWith({ monthly: 31.68 })],
      ['another net price on its treatment row', snapshotWith({ perServiceTreatments: [{ service: 'pest_control', perTreatment: 95.01, displayPrice: 94, visitsPerYear: 4 }] })],
      ['a price range in place of the price', snapshotWith({ lowConfidenceRangePct: 0.1 })],
      ['no section for the family', async (row) => ({ ...JSON.parse(row.estimate_data), sendSnapshot: { pricingBundle: { frequencies: [], services: [] } } })],
    ])('an opening entry with %s refuses (priced by hand)', async (_label, buildEstimateSendSnapshot) => {
      await expect(mint({}, { buildEstimateSendSnapshot })).rejects.toMatchObject({ code: 'pricing_unavailable', restartUnavailable: true });
    });

    test('a lawn entry has no perVisit: the net price its treatment row shows must equal the card\'s', async () => {
      recompute.mockResolvedValue(pricedAs(LAWN_LINE));
      const lawn = { serviceKey: 'lawn_care', optionId: 'lawn-enhanced', shown: shownOf(LAWN_LINE) };
      // Same monthly and yearly totals as the card; only the per-application price differs.
      const lawnEntry = (displayPrice) => snapshotWith({ perServiceTreatments: [{ service: 'lawn_care', perTreatment: 65.33, displayPrice, visitsPerYear: 9 }] });
      await expect(mint(lawn, { buildEstimateSendSnapshot: lawnEntry(65.32) })).rejects.toMatchObject({ code: 'pricing_unavailable' });
      tables.estimates = [];
      await expect(mint(lawn, { buildEstimateSendSnapshot: lawnEntry(65.33) })).resolves.toMatchObject({ reused: false });
    });

    test('publishes only what the public page serves as is: the page\'s own predicate decides, not the generic totals check', async () => {
      const servesAsIs = jest.fn(() => true);
      // The generic check misses (quarterly pest: monthly x 12 is not the per-application total); the page's predicate decides.
      await mint({}, { sentSnapshotServesAsIs: servesAsIs, bundleUtils: { pricingBundleMatchesEstimateTotals: () => false } });
      const stored = JSON.parse(tables.estimates[0].estimate_data);
      expect(servesAsIs).toHaveBeenCalledWith(
        stored.sendSnapshot.pricingBundle,
        expect.objectContaining({ source: 'plan_start', monthly_total: 31.67 }),
        expect.objectContaining({ planStart: stored.planStart, sendSnapshot: stored.sendSnapshot }),
      );
      tables.estimates = [];
      servesAsIs.mockReturnValue(false);
      await expect(mint({}, { sentSnapshotServesAsIs: servesAsIs })).rejects.toMatchObject({ code: 'pricing_unavailable', restartUnavailable: true });
    });
  });

  // codex pre-push P0: the card shows due-at-start and one-time amounts; the quote may carry no
  // other one-time money except the WaveGuard setup fee, which the page itemizes on its own line.
  describe('one-time money matches the card; the WaveGuard setup fee is counted on its own', () => {
    const TERMITE = engineLine('termite_bait', 35, { installation: { price: 199 } });
    const termite = { serviceKey: 'termite', optionId: 'termite-basic', shown: shownOf(TERMITE) };
    const charge = (service, amount, more = {}) => ({ service, amount, kind: 'charge', quoteRequired: false, ...more });
    const setup = (amount) => ({ service: 'waveguard_setup', amount, label: 'WaveGuard setup' });
    // The pest line declares its setup fee (initialFee), as the real engine's pest line does.
    const withSetupFee = pricedAs({ ...PEST_LINE, initialFee: 99 }, { setupFee: 99 });

    test('the setup fee the option\'s line declares, itemized on the page, mints at the card\'s other amounts', async () => {
      recompute.mockResolvedValue(withSetupFee);
      await mint();
      expect(tables.estimates[0].onetime_total).toBe(99);
    });

    test.each([
      ['the quote drops the station setup the card shows (one-time total $0)', termite,
        { ...pricedAs(TERMITE), serverTotals: { ...pricedAs(TERMITE).serverTotals, onetimeTotal: 0 } }, {}],
      ['the page charges another station setup', termite, pricedAs(TERMITE),
        { oneTimeBreakdown: { items: [charge('termite_bait_installation', 249)], total: 249 } }],
      ['the page adds a charge the card does not show', termite, pricedAs(TERMITE),
        { oneTimeBreakdown: { items: [charge('termite_bait_installation', 199), charge('pest_initial', 50)], total: 249 } }],
      ['the page prices the station setup by quote', termite, pricedAs(TERMITE),
        { oneTimeBreakdown: { items: [charge('termite_bait_installation', 199, { quoteRequired: true })], total: 199 } }],
      ['the engine adds a setup fee the option\'s line does not declare (a mosquito-only plan)', {}, pricedAs(PEST_LINE, { setupFee: 99 }), {}],
      ['the page does not itemize the setup fee', {}, withSetupFee, { oneTimeBreakdown: { items: [], total: 99 } }],
      ['the page shows another setup fee', {}, withSetupFee, { setupFee: setup(129) }],
      ['the page shows a setup fee the quote does not carry', {}, pricedAs(PEST_LINE),
        { oneTimeBreakdown: { items: [charge('waveguard_setup', 99)], total: 99 }, setupFee: setup(99) }],
    ])('%s: refused (priced by hand)', async (_label, option, quote, pageOneTime) => {
      recompute.mockResolvedValue(quote);
      await expect(mint(option, { buildEstimateSendSnapshot: snapshotWith({}, pageOneTime) }))
        .rejects.toMatchObject({ code: 'pricing_unavailable', restartUnavailable: true });
    });
  });

  describe('reuse and lineage', () => {
    test('a live plan_start estimate for the same option at today\'s identical offer is handed back, not re-minted', async () => {
      const first = await mint();
      const again = await mint({}, {});
      expect(again).toEqual({ estimateId: first.estimateId, token: first.token, url: first.url, reused: true });
      expect(tables.estimates).toHaveLength(1);
      // Reuse writes no second timeline note.
      expect(tables.customer_interactions).toHaveLength(1);
    });

    test('a reuse re-checks every shown amount too: a changed per-application price refuses, nothing archived', async () => {
      const first = await mint();
      await expect(mint({ shown: { ...shownOf(PEST_LINE), perVisit: 90 } })).rejects.toMatchObject({ code: 'offer_changed' });
      expect(tables.estimates).toHaveLength(1);
      expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).toBeFalsy();
    });

    test.each([
      // The page's tier handlers delete sendSnapshot.pricingBundle and leave inputs, result and totals.
      ['the page dropped its frozen snapshot', ({ pricingBundle, ...rest }) => rest],
      ['its frozen snapshot no longer carries the card\'s one-time money',
        (snapshot) => ({ ...snapshot, pricingBundle: { ...snapshot.pricingBundle, oneTimeBreakdown: { items: [], total: 50 } } })],
    ])('a live quote whose %s is archived and re-minted, never handed back (codex pre-push P0)', async (_label, editSnapshot) => {
      const first = await mint();
      const stored = JSON.parse(tables.estimates[0].estimate_data);
      tables.estimates[0].estimate_data = JSON.stringify({ ...stored, sendSnapshot: editSnapshot(stored.sendSnapshot) });
      const next = await mint({ randomBytes: () => Buffer.from('0123456789abcdef') });
      expect(next.reused).toBe(false);
      expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).toBeTruthy();
      expect(JSON.parse(tables.estimates.find((r) => r.id === next.estimateId).estimate_data).sendSnapshot.pricingBundle).toBeTruthy();
    });

    test('a quote for ANOTHER option is archived and a fresh one minted', async () => {
      const first = await mint();
      recompute.mockResolvedValue(pricedAs(LAWN_LINE));
      const next = await mint({ serviceKey: 'lawn_care', optionId: 'lawn-enhanced', shown: shownOf(LAWN_LINE), randomBytes: () => Buffer.from('0123456789abcdef') });
      expect(next.reused).toBe(false);
      expect(next.estimateId).not.toBe(first.estimateId);
      expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).toBeTruthy();
      expect(tables.estimates.find((r) => r.id === next.estimateId).archived_at).toBeFalsy();
    });

    test('a live quote stored at another address is archived, and the fresh one is minted at today\'s primary premises', async () => {
      const first = await mint();
      // Identical offer and option; only the street the quote names differs from the account's.
      tables.estimates[0].address = '9 Oak Ave, Parrish, FL 34219';
      const next = await mint({ randomBytes: () => Buffer.from('0123456789abcdef') });
      expect(next.reused).toBe(false);
      expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).toBeTruthy();
      expect(tables.estimates.find((r) => r.id === next.estimateId).address).toBe('1 Main St, Parrish, FL 34219');
    });

    test('same option but today\'s totals drifted from the stored offer: the lineage is archived and re-minted', async () => {
      const first = await mint();
      const drifted = engineLine('pest_control', 33.33);
      recompute.mockResolvedValue(pricedAs(drifted));
      const next = await mint({ shown: shownOf(drifted), randomBytes: () => Buffer.from('0123456789abcdef') });
      expect(next.reused).toBe(false);
      expect(tables.estimates.find((r) => r.id === first.estimateId).archived_at).toBeTruthy();
    });

    test('a plan_restart lineage is never touched, and a mid-delivery plan_start refuses the mint', async () => {
      tables.estimates = [
        { id: 'est-restart', customer_id: 'cust-1', source: 'plan_restart', status: 'sent', token: 'r', expires_at: '2099-01-01', archived_at: null },
        { id: 'est-sending', customer_id: 'cust-1', source: 'plan_start', status: 'sending', token: 's', expires_at: '2099-01-01', archived_at: null, estimate_data: '{}' },
      ];
      await expect(mint()).rejects.toMatchObject({ code: 'delivery_in_flight' });
      tables.estimates = [tables.estimates[0]];
      await mint();
      expect(tables.estimates.find((r) => r.id === 'est-restart').archived_at).toBeFalsy();
    });
  });
});

describe('assertPlanStartAcceptEligible', () => {
  const trx = fakeTrx();
  const ESTIMATE = { id: 'est-ps1' };
  beforeEach(() => {
    tables.customers = [{ ...LEAD }];
    tables.estimates = [{
      id: 'est-ps1', customer_id: 'cust-1', source: 'plan_start', status: 'sent', token: 'tok-ps1',
      estimate_data: JSON.stringify({ planStart: { families: ['pest_control'], serviceKey: 'pest_control', optionId: 'pest-quarterly' } }),
    }];
  });

  test('a still-plain account owning no recurring service accepts', async () => {
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).resolves.toBeUndefined();
  });

  test('a quoted family that went live since the mint refuses (409 PLAN_START_STATE_CHANGED)', async () => {
    tables.scheduled_services = [{ id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Quarterly Pest Control' }];
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
  });

  test('a family OUTSIDE the quote refuses too: the mint priced the option standalone, and a member\'s price differs', async () => {
    tables.scheduled_services = [{ id: 'live-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Lawn Care Program' }];
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
  });

  test('a recurring visit still en route after ET midnight refuses (the shared live-plan reader)', async () => {
    tables.scheduled_services = [{ id: 'ip-1', customer_id: 'cust-1', status: 'en_route', is_recurring: true, scheduled_date: '2000-01-01', service_type: 'Lawn Care Program' }];
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
  });

  test('a rodent monitoring plan started since the mint refuses (not a restartable family, still a plan)', async () => {
    tables.scheduled_services = [{ id: 'rodent-1', customer_id: 'cust-1', status: 'scheduled', is_recurring: true, scheduled_date: '2099-01-01', service_type: 'Rodent Bait Monitoring' }];
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
  });

  test.each([
    ['a real WaveGuard tier', { waveguard_tier: 'Gold' }],
    ['a plan billing lane', { billing_mode: 'monthly_membership' }],
    ['a legacy monthly rate', { monthly_rate: 52 }],
  ])('a membership set on the account row since the mint (%s) refuses', async (_label, membership) => {
    tables.customers = [{ ...LEAD, ...membership }];
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
  });

  test('a churned, inactive-flagged (false or NULL), deleted or missing customer refuses', async () => {
    for (const rows of [[{ ...CUSTOMER }], [{ ...LEAD, active: false }], [{ ...LEAD, active: null }], [{ ...LEAD, deleted_at: '2026-11-01' }], []]) {
      tables.customers = rows;
      await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
    }
  });

  test('a malformed estimate (no quoted families) never accepts', async () => {
    tables.estimates[0].estimate_data = JSON.stringify({ planStart: {} });
    await expect(actualRestart.assertPlanStartAcceptEligible(trx, ESTIMATE)).rejects.toMatchObject({ status: 409 });
  });

  test('an unreadable state fails closed and takes the comms lock then the customer row lock first', async () => {
    const ops = [];
    await actualRestart.assertPlanStartAcceptEligible(fakeTrx(ops), ESTIMATE);
    const lockAt = ops.findIndex((o) => o.startsWith('raw:'));
    const customerAt = ops.findIndex((o) => o === 'read:customers:forUpdate');
    const rowsAt = ops.findIndex((o) => o === 'read:scheduled_services');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(customerAt).toBeGreaterThan(lockAt);
    expect(rowsAt).toBeGreaterThan(customerAt);
    const failingTrx = fakeTrx(null, () => { throw new Error('pg down'); });
    await expect(actualRestart.assertPlanStartAcceptEligible(failingTrx, ESTIMATE)).rejects.toMatchObject({ status: 409, code: 'PLAN_START_STATE_CHANGED' });
  });
});

describe('readers that skip undelivered self-serve mints include plan_start', () => {
  test('the pipeline derives no "Follow up" from a plan_start mint (the plan_restart contract)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-pipeline.js'), 'utf8');
    expect(src).toContain(".orWhereNotIn('estimates.source', ['plan_restart', 'plan_start'])");
  });
});
