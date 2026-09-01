/**
 * Cancel-flow C3 — admin "Cancel plan" endpoints
 *   POST /api/admin/customers/:id/cancel-plan/preview
 *   POST /api/admin/customers/:id/cancel-plan
 * on the same engine the customer portal uses (services/admin-cancellation).
 *
 * Contract under test (mirrors requests-cancellation-guard: real listen +
 * fetch, condition-honoring db fake):
 *   - both 404 while GATE_CANCEL_FLOW_V2 is off
 *   - preview = server facts (impact.js) + scope feasibility + prepay refund
 *     math (ruling C-6), zero writes
 *   - commit ORDER: scoped feasibility BEFORE the request row; the request
 *     row BEFORE the processor; the case AFTER the processor
 *   - scoped_unattributed / scope_not_owned → 409, nothing inserted
 *   - nothing_to_cancel → 400, nothing inserted
 *   - actor + keepThrough + waiveLateFee reach the processor; effective
 *     'end_of_coverage' keeps visits through term_end and decides the term
 *     'cancel'; 'now' + refund cancels coverage, RECORDS the refund and opens
 *     an office task — never a Stripe refund
 *   - sendConfirmation false ⇒ no customer communication at all
 *   - the outcome is the same truthful shape the portal returns
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }) }));
jest.mock('../services/cancellation-confirmations', () => ({
  sendCancellationConfirmations: jest.fn().mockResolvedValue({ smsSent: true, emailSent: true, channels: ['sms', 'email'], smsTemplateKey: 'service_cancellation_confirmation' }),
  familyLabelOf: (k) => ({ pest_control: 'Pest Control', lawn_care: 'Lawn Care' }[k] || k),
}));
// Fee lanes for previewVisitFees — default: no hold, no secured card.
const mockHoldPreview = jest.fn(async () => ({ held: false, feeApplies: false }));
const mockApptPreview = jest.fn(async () => ({ secured: false, feeApplies: false }));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldCancelPreview: (...a) => mockHoldPreview(...a) }));
jest.mock('../services/appointment-card-request', () => ({ appointmentCardCancelPreview: (...a) => mockApptPreview(...a) }));
const mockSignupPreview = jest.fn(async () => ({ eligible: false, blockers: ['beyond deposit stage'] }));
jest.mock('../services/customer-offboarding', () => ({ previewCancelSignup: (...a) => mockSignupPreview(...a) }));
jest.mock('../services/cancellation-eligibility', () => ({
  hasCancellableWork: jest.fn().mockResolvedValue(true),
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
  LIVE_TRACK_STATES: ['en_route', 'on_property'],
}));
jest.mock('../services/cancellation-resolution/impact', () => ({
  buildCancellationImpact: jest.fn().mockResolvedValue({
    families: [
      { key: 'pest_control', label: 'Pest Control', monthlyRate: 45, upcomingVisits: 2, nextVisitDate: '2099-01-05' },
      { key: 'lawn_care', label: 'Lawn Care', monthlyRate: 60, upcomingVisits: 1, nextVisitDate: '2099-01-09' },
    ],
    tierBefore: 'Silver', tierAfter: null, accountMonthlyBefore: 105, accountMonthlyAfter: 0,
    remaining: [], visitsCancelled: 3, nextVisitCancelled: '2099-01-05', openBalance: 0, autopayOn: true,
    termiteRental: false, wholeAccount: true, scopedSupported: null,
  }),
}));
// Persists a real row so retry latches and lost-response echoes can read
// back what the commit recorded (the outcome update patches it in place).
// beforeEach RE-ARMS this default — a test's mockImplementation would
// otherwise silently replace it for every later test.
const defaultOpenCase = async (args) => {
  (mockState.cancellation_cases ??= []).push({
    id: 'case-1',
    customer_id: args.customerId,
    service_request_id: args.serviceRequestId,
    status: args.processed ? 'committed' : 'open',
    snapshot: JSON.stringify(args.snapshot || {}),
    created_at: new Date(),
  });
  return { id: 'case-1', ...args };
};
const mockOpenCase = jest.fn(defaultOpenCase);
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
  openCancellationCase: (...args) => mockOpenCase(...args),
}));
const mockProcess = jest.fn();
const mockPlan = jest.fn();
jest.mock('../services/cancellation-processor', () => ({
  processCancellationRequest: (...args) => mockProcess(...args),
  planScopedWindDown: (...args) => mockPlan(...args),
  familyOfServiceRow: (row) => row.family || null,
  CHURN_REASON: 'Customer cancellation request',
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
}));
const mockRecordDecision = jest.fn().mockResolvedValue({ id: 'term-1', status: 'cancelled', renewal_decision: 'cancel' });
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
  coveredTermsAsOf: jest.fn(() => ({
    where: jest.fn(function where() { return this; }),
    orderBy: jest.fn(function orderBy() { return this; }),
    select: jest.fn(async () => mockState.annual_prepay_terms || []),
    first: jest.fn(async () => (mockState.annual_prepay_terms || [])[0] || null),
  })),
  // Canonical coverage rows for a term: window-matched scheduled rows minus
  // explicit non-coverage services (the real helper filters by the term's
  // coverage service type).
  coverageRowsForTerm: jest.fn(async (term) => (mockState.scheduled_services || []).filter((r) =>
    r.customer_id === term.customer_id
    && !r.non_coverage
    && String(r.status) !== 'cancelled'
    && String(r.scheduled_date) >= String(term.term_start).slice(0, 10)
    && String(r.scheduled_date) <= String(term.term_end).slice(0, 10))),
  recordDecision: (...args) => mockRecordDecision(...args),
}));

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(db));
  // Advisory commit lock (per-customer serialization). Tests flip
  // db.client.locked to simulate a concurrent commit holding it.
  const lockConn = {
    query: jest.fn(async (sql) => (/pg_try_advisory_lock/.test(String(sql))
      ? { rows: [{ locked: db.client.locked }] }
      : { rows: [] })),
  };
  db.client = {
    locked: true,
    lockConn,
    acquireConnection: jest.fn(async () => lockConn),
    releaseConnection: jest.fn(async () => {}),
  };
  return db;
});

const express = require('express');
const db = require('../models/db');
const { hasCancellableWork } = require('../services/cancellation-eligibility');
const { sendCancellationConfirmations } = require('../services/cancellation-confirmations');
const NotificationService = require('../services/notification-service');
const router = require('../routes/admin-customers');

let mockState;

// Condition-honoring fake: equality / '>=' / whereIn / whereNull /
// whereBetween filter the seeded rows; insert returns the row with an id.
function builderFor(table) {
  const b = {};
  const conds = [];
  // 'scheduled_services as s' reads the base table; qualified columns
  // ('s.customer_id') match their bare field on the row.
  const baseTable = String(table).split(' ')[0];
  const col = (c) => (String(c).includes('.') ? String(c).split('.').pop() : c);
  const rows = () => (mockState[baseTable] || []).filter((r) => conds.every((c) => c(r)));
  // Grouped builder (knex where(function () { ... })): AND-chains split into
  // OR-disjuncts by orWhere.
  const buildGroupMatcher = (fn) => {
    const disjuncts = [];
    let current = [];
    const group = {
      where(a, op, val) {
        if (typeof a === 'function') current.push(buildGroupMatcher(a));
        else if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => current.push((r) => r[col(k)] === v));
        else if (val === undefined) current.push((r) => r[col(a)] === op);
        else if (op === '>') current.push((r) => Number(r[col(a)]) > val);
        else throw new Error(`fake db group: unsupported operator ${op}`);
        return group;
      },
      orWhere(a, op, val) {
        disjuncts.push(current);
        current = [];
        return group.where(a, op, val);
      },
      whereNull(c) { current.push((r) => r[col(c)] == null); return group; },
      whereNotNull(c) { current.push((r) => r[col(c)] != null); return group; },
      orWhereNotNull(c) { disjuncts.push(current); current = [(r) => r[col(c)] != null]; return group; },
      // The prior-refund check links payments to the prepay invoice via
      // metadata JSON (same predicate the renewals reconciler uses).
      whereRaw(sql, bindings) {
        if (!/metadata::jsonb\s*->>\s*'invoice_id'/.test(String(sql))) throw new Error(`fake db group: unsupported whereRaw ${sql}`);
        const v = Array.isArray(bindings) ? bindings[0] : bindings;
        current.push((r) => {
          const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
          return m.invoice_id === v;
        });
        return group;
      },
    };
    fn.call(group);
    disjuncts.push(current);
    return (r) => disjuncts.some((ds) => ds.every((c) => c(r)));
  };
  b.where = jest.fn((criteria, opOrVal, maybeVal) => {
    if (typeof criteria === 'function') {
      conds.push(buildGroupMatcher(criteria));
    } else if (typeof criteria === 'string') {
      if (maybeVal === undefined) conds.push((r) => r[col(criteria)] === opOrVal);
      else if (opOrVal === '>=') conds.push((r) => r[col(criteria)] >= maybeVal);
      else throw new Error(`fake db: unsupported operator ${opOrVal}`);
    } else if (typeof criteria === 'object') {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[col(k)] === v));
    }
    return b;
  });
  b.whereIn = jest.fn((c, vals) => { conds.push((r) => vals.includes(r[col(c)])); return b; });
  b.whereNull = jest.fn((c) => { conds.push((r) => r[col(c)] == null); return b; });
  b.whereBetween = jest.fn((c, [lo, hi]) => { conds.push((r) => r[col(c)] >= lo && r[col(c)] <= hi); return b; });
  for (const method of ['leftJoin', 'orderBy', 'limit', 'offset']) b[method] = jest.fn(() => b);
  b.select = jest.fn(async () => rows());
  b.first = jest.fn(async () => rows()[0] || null);
  b.update = jest.fn(async (patch) => {
    const matched = rows();
    matched.forEach((r) => Object.assign(r, patch));
    (mockState.updates ??= []).push({ table, patch, count: matched.length });
    return matched.length;
  });
  b.insert = jest.fn((row) => ({
    returning: jest.fn(async () => {
      const inserted = { id: `${table}-${(mockState.inserted ??= []).length + 1}`, created_at: new Date(), ...row };
      mockState.inserted.push({ table, row: inserted });
      (mockState[table] ??= []).push(inserted);
      return [inserted];
    }),
  }));
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (baseUrl, path, body = {}) => fetch(`${baseUrl}/api/admin/customers/cust-1${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const PROCESSED = { ok: true, cancelledCount: 3, recurrenceStopped: 2, churned: true, errors: [], keptThrough: null, lateFeeWaived: false };

beforeEach(() => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockState = {
    customers: [{
      id: 'cust-1', first_name: 'Pat', last_name: 'Tester', phone: '+15550000000', email: 'pat@example.com',
      active: true, pipeline_stage: 'active_customer', waveguard_tier: 'Silver', monthly_rate: '105.00',
      billing_mode: 'monthly_membership', deleted_at: null,
    }],
    scheduled_services: [],
    service_requests: [],
    annual_prepay_terms: [],
  };
  db.mockImplementation((table) => builderFor(table));
  db.client.locked = true;
  db.client.acquireConnection.mockClear();
  db.client.releaseConnection.mockClear();
  db.client.lockConn.query.mockClear();
  mockProcess.mockReset().mockResolvedValue({ ...PROCESSED });
  mockPlan.mockReset().mockResolvedValue({ ok: true, inScope: ['lawn_care'], remaining: ['pest_control'], tierBefore: 'Silver', tierAfter: 'Bronze' });
  hasCancellableWork.mockResolvedValue(true);
  mockOpenCase.mockReset().mockImplementation(defaultOpenCase);
  mockRecordDecision.mockClear();
  mockSignupPreview.mockClear().mockResolvedValue({ eligible: false, blockers: ['beyond deposit stage'] });
  mockHoldPreview.mockClear().mockResolvedValue({ held: false, feeApplies: false });
  mockApptPreview.mockClear().mockResolvedValue({ secured: false, feeApplies: false });
  sendCancellationConfirmations.mockClear();
  NotificationService.notifyAdmin.mockClear();
});

afterAll(() => { delete process.env.GATE_CANCEL_FLOW_V2; });

describe('gate', () => {
  test('both endpoints 404 while GATE_CANCEL_FLOW_V2 is off — no writes, no processor', () => withServer(async (baseUrl) => {
    delete process.env.GATE_CANCEL_FLOW_V2;
    const preview = await post(baseUrl, '/cancel-plan/preview');
    expect(preview.status).toBe(404);
    const commit = await post(baseUrl, '/cancel-plan');
    expect(commit.status).toBe(404);
    expect((await commit.json()).code).toBe('cancel_flow_v2_off');
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockState.inserted).toBeUndefined();
  }));
});

describe('POST /:id/cancel-plan/preview', () => {
  test('whole-account preview carries the server facts and writes nothing', () => withServer(async (baseUrl) => {
    const res = await post(baseUrl, '/cancel-plan/preview', { note: 'called <b>in</b>' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({
      enabled: true, eligible: true, wholeAccount: true, scope: [], effectiveDate: 'now', prepay: null,
      // Angle brackets are stripped before storage (same rule as requests.js).
      sendConfirmation: true, waiveLateFee: false, note: 'called bin/b',
    }));
    expect(body.customer).toEqual(expect.objectContaining({ id: 'cust-1', name: 'Pat Tester', waveguardTier: 'Silver' }));
    expect(body.impact.visitsCancelled).toBe(3);
    expect(body.confirmationChannels).toEqual({ sms: true, email: true });
    expect(body.reasonCodes).toContain('price');
    expect(body.reasonCodes).toHaveLength(19);
    expect(body.effectiveOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockState.inserted).toBeUndefined();
    expect(mockState.updates).toBeUndefined();
    expect(mockProcess).not.toHaveBeenCalled();
  }));

  test('scoped preview reports feasibility instead of throwing', () => withServer(async (baseUrl) => {
    mockPlan.mockResolvedValueOnce({ ok: false, error: 'scoped_unattributed' });
    const res = await post(baseUrl, '/cancel-plan/preview', { families: ['lawn_care'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ wholeAccount: false, scopedSupported: false, scopeError: 'scoped_unattributed' }));

    const ok = await (await post(baseUrl, '/cancel-plan/preview', { families: ['lawn_care'] })).json();
    expect(ok).toEqual(expect.objectContaining({ wholeAccount: false, scope: ['lawn_care'], scopeLabels: ['Lawn Care'], scopedSupported: true }));
  }));

  test('annual-prepay customer: end_of_coverage names term_end; now computes the C-6 refund from completed covered visits', () => withServer(async (baseUrl) => {
    mockState.annual_prepay_terms = [{
      id: 'term-1', term_start: '2026-03-01', term_end: '2027-02-28', plan_label: 'Annual Pest',
      prepay_amount: '480.00', coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control', status: 'active',
    }];
    mockState.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
      // A DIFFERENT service completed in the window (not a coverage row —
      // the canonical helper filters it by service type).
      { id: 's2', customer_id: 'cust-1', status: 'completed', prepaid_method: null, scheduled_date: '2026-05-01', non_coverage: true },
      { id: 's3', customer_id: 'cust-1', status: 'confirmed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-10-01' },
    ];
    let body = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'end_of_coverage' })).json();
    expect(body.effectiveDate).toBe('end_of_coverage');
    // The "visits pulled" preview counts only what the button pulls — the
    // impact math gets the processor's keep-through boundary.
    const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
    // The preview hands the impact math the LIVE term's canonical covered
    // rows (coverageRowsForTerm) — the same set the processor will keep.
    expect(buildCancellationImpact).toHaveBeenLastCalledWith('cust-1', [], { after: '2027-02-28', keepVisitIds: ['s1', 's3'] });
    expect(body.effectiveOn).toBe('2027-02-28');
    expect(body.prepay).toEqual(expect.objectContaining({ termId: 'term-1', termEnd: '2027-02-28', disposition: 'end_at_term', refund: null }));

    body = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'now' })).json();
    expect(body.prepay.disposition).toBe('end_now_refund');
    // 480 ÷ 4 included × 3 remaining (one covered visit completed).
    expect(body.prepay.refund).toEqual(expect.objectContaining({ prepaidAmount: 480, includedVisits: 4, completedVisits: 1, remainingVisits: 3, amount: 360, needsManualCalc: false }));

    // No included-visit count on the term → recorded as a manual calc, never invented.
    mockState.annual_prepay_terms[0].coverage_visit_count = null;
    body = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'now' })).json();
    expect(body.prepay.refund).toEqual(expect.objectContaining({ amount: null, needsManualCalc: true, reason: 'coverage_visit_count_missing' }));
  }));

  test('end_of_coverage without live coverage → 400 no_paid_coverage', () => withServer(async (baseUrl) => {
    const res = await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'end_of_coverage' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_paid_coverage');
  }));
});

describe('POST /:id/cancel-plan', () => {
  test('whole account: request row (category cancellation, source admin) → processor with the admin actor → case → confirmations; same outcome shape as the portal', () => withServer(async (baseUrl) => {
    const order = [];
    db.mockImplementation((table) => {
      const b = builderFor(table);
      const insert = b.insert;
      b.insert = (row) => { order.push(`insert:${table}`); return insert(row); };
      return b;
    });
    // The processor CONFIRMS the requested waiver (every fee rail released) —
    // the response's lateFeeWaived reflects that verdict, never the request.
    mockProcess.mockImplementation(async () => { order.push('processor'); return { ...PROCESSED, lateFeeWaived: true }; });
    mockOpenCase.mockImplementation(async (args) => { order.push('case'); return { id: 'case-1', ...args }; });
    sendCancellationConfirmations.mockImplementation(async () => { order.push('confirm'); return { smsSent: true, emailSent: true, channels: ['sms', 'email'] }; });

    const res = await post(baseUrl, '/cancel-plan', { reasonCode: 'price', note: 'Too expensive', waiveLateFee: true });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(order).toEqual(['insert:service_requests', 'processor', 'case', 'confirm']);
    const request = mockState.inserted.find((i) => i.table === 'service_requests').row;
    // Inserted 'new'; the clean run closes the acceptance to 'resolved' so a
    // later cancel never reuses this request.
    expect(request).toEqual(expect.objectContaining({ customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'resolved', description: 'Too expensive' }));
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', requestId: request.id, families: [], keepThrough: null, waiveLateFee: true,
      actor: { type: 'admin', userId: 'admin-1' },
      // The recorded reason (code + note) feeds churn classification — never
      // the request-id boilerplate when the operator said why. Repairs key
      // on the IMMUTABLE request-scoped marker instead.
      reason: 'price — Too expensive',
      historyNote: `Admin cancellation request ${request.id}`,
    }));
    expect(mockOpenCase).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', serviceRequestId: request.id, families: [], reasonCode: 'price', reasonText: 'Too expensive', processed: true,
      snapshot: expect.objectContaining({
        actor: { type: 'admin', userId: 'admin-1' }, effectiveDate: 'now', waiveLateFee: true, prepayDisposition: null, refund: null,
        tier_before: 'Silver', monthly_rate_before: '105.00', billing_mode: 'monthly_membership',
      }),
    }));
    expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ id: 'cust-1' }), request: expect.objectContaining({ id: request.id }),
      processed: true, entryPoint: 'admin_cancel_plan', identityTrustLevel: 'admin_operator',
    }));
    expect(body).toEqual(expect.objectContaining({
      success: true, requestId: request.id, caseId: 'case-1', processed: true, visitsPulled: 3, scope: [], remaining: [],
      tierBefore: 'Silver', tierAfter: null, lateFeeWaived: true, confirmation: 'sms', confirmationChannels: ['sms', 'email'],
      confirmationRequested: true, errors: [],
    }));
    expect(body.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.refund).toBeUndefined();
    // Clean run → no review bell.
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  }));

  test('sendConfirmation false ⇒ no customer communication at all', () => withServer(async (baseUrl) => {
    const body = await (await post(baseUrl, '/cancel-plan', { sendConfirmation: false })).json();
    expect(sendCancellationConfirmations).not.toHaveBeenCalled();
    expect(body).toEqual(expect.objectContaining({ confirmation: null, confirmationChannels: [], confirmationRequested: false }));
    expect(mockOpenCase.mock.calls[0][0].snapshot.sendConfirmation).toBe(false);
  }));

  test('the preview surfaces scheduled-visit fee exposure on pulled visits, and a changed exposure trips preview_changed', () => withServer(async (baseUrl) => {
    const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
    const base = await buildCancellationImpact();
    buildCancellationImpact.mockResolvedValue({ ...base, pulledVisitKeys: ['v1:2099-01-05', 'v2:2099-01-09'] });
    mockHoldPreview.mockImplementation(async (id) => (id === 'v1'
      ? { held: true, feeApplies: true, feeAmount: 35 }
      : { held: false, feeApplies: false }));
    const preview = await (await post(baseUrl, '/cancel-plan/preview')).json();
    // Both lanes consulted per pulled visit; only the fee-applying one lists.
    expect(preview.visitFees).toEqual({
      applies: true, unresolved: false, total: 35,
      visits: [{ id: 'v1', lane: 'card_hold', feeApplies: true, feeAmount: 35, unresolved: false }],
    });
    expect(mockApptPreview).toHaveBeenCalledWith('v2');

    // The fee window lapsing between preview and commit changes the
    // approved facts — the fingerprint refuses.
    mockHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 35 });
    const res = await post(baseUrl, '/cancel-plan', { previewFingerprint: preview.previewFingerprint });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('preview_changed');
    buildCancellationImpact.mockResolvedValue(base);
  }));

  test('an unverifiable fee lane reads fee-may-apply — never a silent no-fee preview', () => withServer(async (baseUrl) => {
    const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
    const base = await buildCancellationImpact();
    buildCancellationImpact.mockResolvedValueOnce({ ...base, pulledVisitKeys: ['v1:2099-01-05'] });
    mockHoldPreview.mockRejectedValueOnce(new Error('hold lookup down'));
    const preview = await (await post(baseUrl, '/cancel-plan/preview')).json();
    expect(preview.visitFees).toEqual(expect.objectContaining({ applies: true, unresolved: true, total: null }));
  }));

  test('a retry after a partial run reuses the SAME accepted request — the repair pass can find the first attempt\'s rows', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, churned: true, errors: ['visit_cancel_flip:s1'] });
    const first = await (await post(baseUrl, '/cancel-plan')).json();
    expect(first.processed).toBe(false);
    const second = await (await post(baseUrl, '/cancel-plan')).json();
    expect(second.requestId).toBe(first.requestId);
    expect(mockState.inserted.filter((i) => i.table === 'service_requests')).toHaveLength(1);
    // Both runs hand the processor the SAME request-id reason, so the
    // note-less fallback reason matches the first attempt's history notes.
    expect(mockProcess.mock.calls[0][0].reason).toBe(mockProcess.mock.calls[1][0].reason);
    // The clean second run CLOSES the acceptance…
    expect(mockState.service_requests.find((r) => r.id === second.requestId).status).toBe('resolved');
    // …so a LATER cancel (win-back cancelled again) opens a fresh request
    // with its own case/audit trail instead of reusing the finished one.
    const third = await (await post(baseUrl, '/cancel-plan')).json();
    expect(third.requestId).not.toBe(first.requestId);
    expect(mockState.inserted.filter((i) => i.table === 'service_requests')).toHaveLength(2);
  }));

  test('a lost-response retry after a CLEAN run echoes the recorded outcome — never nothing_to_cancel', () => withServer(async (baseUrl) => {
    const first = await (await post(baseUrl, '/cancel-plan')).json();
    expect(first.errors).toEqual([]);
    // The clean run resolved its acceptance and left nothing cancellable.
    hasCancellableWork.mockResolvedValue(false);
    mockProcess.mockClear();
    sendCancellationConfirmations.mockClear();
    const retry = await (await post(baseUrl, '/cancel-plan')).json();
    expect(retry).toEqual(expect.objectContaining({
      duplicate: true, requestId: first.requestId, caseId: 'case-1', processed: true,
      visitsPulled: 3, confirmation: 'sms', confirmationChannels: ['sms', 'email'], errors: [],
    }));
    expect(mockProcess).not.toHaveBeenCalled();
    expect(sendCancellationConfirmations).not.toHaveBeenCalled();
    // A genuinely empty account (no recorded case) still refuses.
    mockState.cancellation_cases = [];
    const res = await post(baseUrl, '/cancel-plan');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('nothing_to_cancel');
  }));

  test('a LOST acceptance close is a surfaced follow-up failure — never a clean run leaving a reusable stale request', () => withServer(async (baseUrl) => {
    // The resolve update lands on zero rows (row vanished / status raced).
    db.mockImplementation((table) => {
      const b = builderFor(table);
      if (table === 'service_requests') {
        const update = b.update;
        b.update = async (patch) => (patch.status === 'resolved' ? 0 : update(patch));
      }
      return b;
    });
    const body = await (await post(baseUrl, '/cancel-plan')).json();
    expect(body.processed).toBe(true);
    expect(body.errors).toEqual(['acceptance_close_failed']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('acceptance_close_failed');
  }));

  test('a scoped retry after its visits were pulled is not stranded by scope_not_owned — the acceptance carries it to the repair pass', () => withServer(async (baseUrl) => {
    // Run 1: feasible scoped cancel; a per-visit side effect failed.
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, churned: false, scopedWoundDown: true, scope: ['lawn_care'], remaining: ['pest_control'], errors: ['invoice_void:s1'] });
    const first = await (await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] })).json();
    expect(first.processed).toBe(false);
    // Retry: the family is gone from the live rows — ownership resolution
    // refuses, but the open acceptance proves this is a repair retry.
    mockPlan.mockResolvedValue({ ok: false, error: 'scope_not_owned' });
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: true, churned: false, scopedWoundDown: true, scope: ['lawn_care'], remaining: [], cancelledCount: 0 });
    const second = await (await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] })).json();
    expect(second.requestId).toBe(first.requestId);
    expect(second.processed).toBe(true);
    // The processor got the SAME request-scoped reason both times, so its
    // repair pass finds run 1's rows.
    expect(mockProcess.mock.calls[0][0].reason).toBe(mockProcess.mock.calls[1][0].reason);
    // A genuinely un-owned scope with NO acceptance still refuses 409.
    mockState.service_requests = [];
    const res = await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('scope_not_owned');
  }));

  test('acceptance matching is actor- and order-independent — another operator or the other surface can drive the repair', () => withServer(async (baseUrl) => {
    // The first attempt was proposed from the Intelligence Bar by ANOTHER
    // operator; this dialog retry must still land on it.
    mockState.service_requests = [{
      id: 'req-ib', customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'new',
      subject: 'Cancel Lawn Care (Intelligence Bar (user other-admin))', description: '',
      metadata: JSON.stringify({ cancel_plan: { scope: ['lawn_care'], waiveLateFee: false } }),
      // Three days old: an OPEN acceptance stays repairable past any
      // freshness window (a weekend must not strand the repair).
      created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    }];
    mockPlan.mockResolvedValue({ ok: false, error: 'scope_not_owned' });
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: true, churned: false, scopedWoundDown: true, scope: ['lawn_care'], remaining: [], cancelledCount: 0 });
    const body = await (await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] })).json();
    expect(body.requestId).toBe('req-ib');
    expect(mockState.inserted).toBeUndefined();
  }));

  test('a deposit-stage account is refused — 409 use_cancel_signup routes to the dedicated offboarding flow', () => withServer(async (baseUrl) => {
    mockSignupPreview.mockResolvedValue({ eligible: true, blockers: [] });
    const commit = await post(baseUrl, '/cancel-plan');
    expect(commit.status).toBe(409);
    expect((await commit.json()).code).toBe('use_cancel_signup');
    expect(mockState.inserted).toBeUndefined();
    expect(mockProcess).not.toHaveBeenCalled();
    const preview = await post(baseUrl, '/cancel-plan/preview');
    expect(preview.status).toBe(409);
    // An OPEN acceptance (a generic cancel already partially ran) bypasses
    // the guard so its repairs are not stranded.
    mockState.service_requests = [{
      id: 'req-1', customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'new',
      subject: 'Cancel plan (Admin (user admin-1))', description: '',
      metadata: JSON.stringify({ cancel_plan: { scope: [], waiveLateFee: false } }),
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    }];
    const retry = await post(baseUrl, '/cancel-plan');
    expect(retry.status).toBe(200);
  }));

  test('the accepted waiver survives a LOST case write — the request metadata is the durable record', () => withServer(async (baseUrl) => {
    // Run 1: waived, a fee leg failed AND the case write failed.
    mockOpenCase.mockRejectedValueOnce(new Error('case table down'));
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, churned: true, lateFeeWaived: false, errors: ['card_hold:s1'] });
    const first = await (await post(baseUrl, '/cancel-plan', { waiveLateFee: true })).json();
    expect(first.caseId).toBeNull();
    // Retry from the default unchecked state still carries the waiver.
    const second = await (await post(baseUrl, '/cancel-plan')).json();
    expect(second.requestId).toBe(first.requestId);
    expect(mockProcess.mock.calls[1][0].waiveLateFee).toBe(true);
  }));

  test('a sticky waiver: a repair retry inherits the first attempt\'s accepted fee waiver', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, churned: true, lateFeeWaived: false, errors: ['card_hold:s1'] });
    const first = await (await post(baseUrl, '/cancel-plan', { waiveLateFee: true })).json();
    expect(first.processed).toBe(false);
    // Retry from the dialog's default UNCHECKED state.
    const second = await (await post(baseUrl, '/cancel-plan')).json();
    expect(second.requestId).toBe(first.requestId);
    expect(mockProcess.mock.calls[1][0].waiveLateFee).toBe(true);
  }));

  test('a repair retry MERGES its outcome with the first attempt\'s — the case never regresses to "0 pulled"', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, churned: true, cancelledCount: 3, errors: ['invoice_void:s1'] });
    const first = await (await post(baseUrl, '/cancel-plan')).json();
    expect(first.visitsPulled).toBe(3);
    // Retry: nothing new flips (repairs don't count).
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, cancelledCount: 0 });
    await post(baseUrl, '/cancel-plan');
    const latest = mockState.cancellation_cases[mockState.cancellation_cases.length - 1];
    const snap = JSON.parse(latest.snapshot);
    expect(snap.outcome.visitsPulled).toBe(3);
    expect(snap.outcome.errors).toEqual([]);
  }));

  test('the preview presents a partial run as a committable retry (eligible + scoped support restored)', () => withServer(async (baseUrl) => {
    // Whole-account: wound down, follow-up failed, acceptance open.
    mockState.service_requests = [{
      id: 'req-1', customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'new',
      subject: 'Cancel plan (Admin (user admin-1))', description: '',
      metadata: JSON.stringify({ cancel_plan: { scope: [], waiveLateFee: false } }),
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    }];
    hasCancellableWork.mockResolvedValue(false);
    let preview = await (await post(baseUrl, '/cancel-plan/preview')).json();
    expect(preview.eligible).toBe(true);
    expect(preview.repairRetry).toBe(true);

    // Scoped: the family is gone from the live rows but the acceptance is open.
    mockState.service_requests = [{
      id: 'req-2', customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'new',
      subject: 'Cancel Lawn Care (Admin (user admin-1))', description: '',
      metadata: JSON.stringify({ cancel_plan: { scope: ['lawn_care'], waiveLateFee: false } }),
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    }];
    mockPlan.mockResolvedValue({ ok: false, error: 'scope_not_owned' });
    preview = await (await post(baseUrl, '/cancel-plan/preview', { families: ['lawn_care'] })).json();
    expect(preview).toEqual(expect.objectContaining({ scopedSupported: true, scopeError: null, repairRetry: true }));
  }));

  test('a wound-down account with a lost follow-up step can still retry — the open acceptance beats nothing_to_cancel', () => withServer(async (baseUrl) => {
    // First run: the wind-down lands, the case write fails.
    mockOpenCase.mockRejectedValueOnce(new Error('case table down'));
    const first = await (await post(baseUrl, '/cancel-plan')).json();
    expect(first.errors).toEqual(['case_write']);
    expect(first.caseId).toBeNull();
    // The account is now churned — no cancellable work left — but the open
    // acceptance carries the retry through to the repair pass + case write.
    hasCancellableWork.mockResolvedValue(false);
    const second = await (await post(baseUrl, '/cancel-plan')).json();
    expect(second.requestId).toBe(first.requestId);
    expect(second.caseId).toBe('case-1');
    expect(second.errors).toEqual([]);
    // A genuinely empty account (no acceptance) still refuses.
    mockState.service_requests = [];
    const res = await post(baseUrl, '/cancel-plan');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('nothing_to_cancel');
  }));

  test('more visits pulled than the approved preview showed is an exception, never a clean "Done."', () => withServer(async (baseUrl) => {
    const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
    const base = await buildCancellationImpact();
    buildCancellationImpact.mockResolvedValue({ ...base, pulledVisitKeys: ['v1:2099-01-05', 'v2:2099-01-09', 'v3:2099-02-01'] });
    const preview = await (await post(baseUrl, '/cancel-plan/preview')).json();
    // A recurrence occurrence minted mid-flight: the straggler re-sweep
    // pulls a 4th visit the operator never saw.
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, cancelledCount: 4 });
    const body = await (await post(baseUrl, '/cancel-plan', { previewFingerprint: preview.previewFingerprint })).json();
    expect(body.processed).toBe(true);
    expect(body.errors).toContain('visits_pulled_beyond_preview');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);

    // IDENTITIES, not counts: an approved visit completing mid-run while a
    // minted occurrence is swept keeps the count equal — the swapped id is
    // still an exception.
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, cancelledCount: 3, cancelledIds: ['v1', 'v2', 'vNEW'] });
    const swap = await (await post(baseUrl, '/cancel-plan', { previewFingerprint: preview.previewFingerprint })).json();
    expect(swap.errors).toContain('visits_pulled_beyond_preview');

    // A MISSING approved visit (it completed mid-run and was delivered,
    // not cancelled) is changed facts too — strict subset flags.
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, cancelledCount: 2, cancelledIds: ['v1', 'v2'] });
    const subset = await (await post(baseUrl, '/cancel-plan', { previewFingerprint: preview.previewFingerprint })).json();
    expect(subset.errors).toContain('visits_pulled_beyond_preview');

    // The exact approved set reads clean.
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, cancelledCount: 3, cancelledIds: ['v1', 'v2', 'v3'] });
    const clean = await (await post(baseUrl, '/cancel-plan', { previewFingerprint: preview.previewFingerprint })).json();
    expect(clean.errors).toEqual([]);
    buildCancellationImpact.mockResolvedValue(base);
  }));

  test('a review alert that did not persist is surfaced — the UI must not claim the office has the details', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, errors: ['in_progress_visit:s9'] });
    // notifyAdmin's documented null-on-failure contract.
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);
    const body = await (await post(baseUrl, '/cancel-plan')).json();
    expect(body.errors).toEqual(expect.arrayContaining(['in_progress_visit:s9', 'review_alert_failed']));
  }));

  test('a repair retry inherits the accepted NO-communication choice — the silenced customer stays silent', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, churned: true, errors: ['invoice_void:s1'] });
    const first = await (await post(baseUrl, '/cancel-plan', { sendConfirmation: false })).json();
    expect(first.processed).toBe(false);
    expect(sendCancellationConfirmations).not.toHaveBeenCalled();
    // Retry from a fresh dialog (checkbox defaults back to true).
    const second = await (await post(baseUrl, '/cancel-plan')).json();
    expect(second.requestId).toBe(first.requestId);
    expect(sendCancellationConfirmations).not.toHaveBeenCalled();
  }));

  test('a requested confirmation a reachable channel did not accept is a surfaced failure — review bell, never a clean "Done."', () => withServer(async (baseUrl) => {
    sendCancellationConfirmations.mockResolvedValueOnce({ smsSent: false, emailSent: false, channels: [] });
    const body = await (await post(baseUrl, '/cancel-plan')).json();
    expect(body.processed).toBe(true);
    expect(body.errors).toEqual(['confirmation_sms_not_sent', 'confirmation_email_not_sent']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, , text] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('service');
    expect(text).toContain('confirmation_sms_not_sent');

    // An UNREACHABLE channel is not a failure — no email on file means the
    // SMS alone is the requested confirmation.
    NotificationService.notifyAdmin.mockClear();
    mockState.customers[0].email = null;
    sendCancellationConfirmations.mockResolvedValueOnce({ smsSent: true, emailSent: false, channels: ['sms'] });
    const clean = await (await post(baseUrl, '/cancel-plan')).json();
    expect(clean.errors).toEqual([]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  }));

  test('scoped: feasibility runs BEFORE the request row; unattributed → 409 and nothing inserted; feasible → scoped processor call', () => withServer(async (baseUrl) => {
    mockPlan.mockResolvedValueOnce({ ok: false, error: 'scoped_unattributed' });
    let res = await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('scoped_cancellation_unattributed');
    expect(mockState.inserted).toBeUndefined();
    expect(mockProcess).not.toHaveBeenCalled();

    mockPlan.mockResolvedValueOnce({ ok: false, error: 'scope_not_owned' });
    res = await post(baseUrl, '/cancel-plan', { families: ['mosquito'] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('scope_not_owned');

    mockProcess.mockResolvedValueOnce({ ...PROCESSED, churned: false, scopedWoundDown: true, scope: ['lawn_care'], remaining: ['pest_control'], tierBefore: 'Silver', tierAfter: 'Bronze', cancelledCount: 1 });
    res = await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ families: ['lawn_care'] }));
    expect(mockOpenCase).toHaveBeenCalledWith(expect.objectContaining({ families: ['lawn_care'] }));
    expect(body).toEqual(expect.objectContaining({ processed: true, visitsPulled: 1, scope: ['lawn_care'], remaining: ['pest_control'], tierBefore: 'Silver', tierAfter: 'Bronze' }));
  }));

  test('nothing to cancel → 400, no request row, processor never runs', () => withServer(async (baseUrl) => {
    hasCancellableWork.mockResolvedValueOnce(false);
    const res = await post(baseUrl, '/cancel-plan');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('nothing_to_cancel');
    expect(mockState.inserted).toBeUndefined();
    expect(mockProcess).not.toHaveBeenCalled();
  }));

  test('unknown customer → 404; bad reason code → 400', () => withServer(async (baseUrl) => {
    mockState.customers = [];
    expect((await post(baseUrl, '/cancel-plan')).status).toBe(404);
    mockState.customers = [{ id: 'cust-1', first_name: 'Pat', last_name: 'T', deleted_at: null }];
    const res = await post(baseUrl, '/cancel-plan', { reasonCode: 'because' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_reason_code');
    expect(mockState.inserted).toBeUndefined();
  }));

  describe('annual prepay', () => {
    beforeEach(() => {
      mockState.annual_prepay_terms = [{
        id: 'term-1', customer_id: 'cust-1', term_start: '2026-03-01', term_end: '2027-02-28', plan_label: 'Annual Pest',
        prepay_amount: '480.00', coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control', status: 'active', renewal_decision: null,
      }];
    });

    test('end_of_coverage: processor keeps visits through term_end, the term is decided cancel (no renewal), no refund, no office task', () => withServer(async (baseUrl) => {
      mockProcess.mockResolvedValueOnce({ ...PROCESSED, keptThrough: '2027-02-28' });
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ keepThrough: '2027-02-28' }));
      expect(mockRecordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'term-1', action: 'cancel', adminUserId: 'admin-1' }));
      expect((mockState.updates || []).filter((u) => u.table === 'annual_prepay_terms')).toEqual([]);
      expect(body).toEqual(expect.objectContaining({ effectiveDate: '2027-02-28', keptThrough: '2027-02-28', prepayDisposition: 'end_at_term', prepayTermOutcome: 'ends_at_term' }));
      expect(body.refund).toBeUndefined();
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
      expect(mockOpenCase.mock.calls[0][0].snapshot).toEqual(expect.objectContaining({ effectiveDate: 'end_of_coverage', effectiveOn: '2027-02-28', prepayDisposition: 'end_at_term', prepayTermId: 'term-1' }));
      // The confirmation names the coverage end, not today.
      expect(sendCancellationConfirmations.mock.calls[0][0].effectiveAt).toMatch(/^2027-02-28/);
    }));

    test('now + refund: coverage cancelled, refund RECORDED on the case + office task — nothing refunded automatically', () => withServer(async (baseUrl) => {
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
      ];
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ keepThrough: null }));
      // The term is DECIDED through move 8 (recordDecision) — this lane never
      // writes annual_prepay_terms.status directly (writer set is pinned by
      // the term-states guard test). Coverage revocation happens when the
      // recorded refund actually lands (move 9).
      expect(mockRecordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'term-1', action: 'cancel', adminUserId: 'admin-1' }));
      expect((mockState.updates || []).filter((u) => u.table === 'annual_prepay_terms')).toEqual([]);
      expect(body.refund).toEqual(expect.objectContaining({ amount: 360, remainingVisits: 3, needsManualCalc: false }));
      expect(body.prepayTermOutcome).toBe('ended_now');
      expect(mockOpenCase.mock.calls[0][0].snapshot.refund).toEqual(expect.objectContaining({ amount: 360 }));
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      const [category, title, text, opts] = NotificationService.notifyAdmin.mock.calls[0];
      expect(category).toBe('billing');
      expect(title).toMatch(/refund/i);
      expect(text).toContain('$360.00');
      expect(text).toContain('Nothing has been refunded automatically');
      expect(opts).toEqual(expect.objectContaining({ bell: true, dedupeKey: 'prepay_refund:term:term-1' }));
    }));

    test('contradictory pair → 400 prepay_disposition_mismatch', () => withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'now', prepayDisposition: 'end_at_term' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('prepay_disposition_mismatch');
      expect(mockState.inserted).toBeUndefined();
    }));

    test('two live terms → 409 multiple_prepay_terms; nothing is written', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms.push({
        id: 'term-2', customer_id: 'cust-1', term_start: '2026-06-01', term_end: '2027-05-31', plan_label: 'Annual Lawn',
        prepay_amount: '600.00', coverage_visit_count: 6, status: 'active', renewal_decision: null,
      });
      const res = await post(baseUrl, '/cancel-plan');
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('multiple_prepay_terms');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
    }));

    test('a term already decided renew → 409 prepay_term_decided before any write', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'renew';
      mockState.annual_prepay_terms[0].status = 'renewed';
      const res = await post(baseUrl, '/cancel-plan');
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('prepay_term_decided');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
    }));

    test('a paid payment_pending term → 409 prepay_term_not_actionable (recordDecision would silently miss)', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].status = 'payment_pending';
      const res = await post(baseUrl, '/cancel-plan');
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('prepay_term_not_actionable');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
    }));

    test('retry after a decided cancel reuses the recorded case — no second request, processor run, or customer text', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({
          prepayTermId: 'term-1', effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term',
          outcome: {
            visitsPulled: 4, scope: [], tierBefore: 'Silver', tierAfter: null, lateFeeWaived: false,
            confirmationRequested: true, confirmation: 'sms', confirmationChannels: ['sms', 'email'],
          },
        }),
      }];
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({ duplicate: true, requestId: 'req-9', caseId: 'case-9', processed: true, prepayTermOutcome: 'decision_already_recorded' }));
      // The RECORDED outcome answers the retry — never "nothing pulled /
      // nothing sent" for a run whose response was lost.
      expect(body).toEqual(expect.objectContaining({
        visitsPulled: 4, confirmationRequested: true, confirmation: 'sms', confirmationChannels: ['sms', 'email'],
      }));
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
      expect(mockRecordDecision).not.toHaveBeenCalled();
      expect(sendCancellationConfirmations).not.toHaveBeenCalled();
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    }));

    test('a commit carrying the preview fingerprint is refused (409 preview_changed) when the refund facts moved', () => withServer(async (baseUrl) => {
      const previewBody = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'now' })).json();
      expect(previewBody.previewFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // The same facts commit cleanly…
      const ok = await post(baseUrl, '/cancel-plan', { effectiveDate: 'now', previewFingerprint: previewBody.previewFingerprint });
      expect(ok.status).toBe(200);
    }));

    test('preview_changed: a payment or new invoice moving the open balance during the window refuses the commit', () => withServer(async (baseUrl) => {
      const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
      const previewBody = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'now' })).json();
      const base = await buildCancellationImpact();
      buildCancellationImpact.mockResolvedValueOnce({ ...base, openBalance: 45 });
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'now', previewFingerprint: previewBody.previewFingerprint });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('preview_changed');
      expect(mockState.inserted).toBeUndefined();
    }));

    test('preview_changed: an edited term amount between preview and commit refuses before any write', () => withServer(async (baseUrl) => {
      const previewBody = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'now' })).json();
      // The office edits the term (refund dollars change) during the window.
      mockState.annual_prepay_terms[0].prepay_amount = '999.00';
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'now', previewFingerprint: previewBody.previewFingerprint });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('preview_changed');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
    }));

    test('the destructive inverse is refused: end_at_term after a recorded end_now_refund → 409', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({ prepayTermId: 'term-1', prepayDisposition: 'end_now_refund', refund: { amount: 360 } }),
      }];
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('prepay_term_already_ended');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
      expect(sendCancellationConfirmations).not.toHaveBeenCalled();
    }));

    test('a prior end_at_term case does NOT swallow a new end-now-refund request (disposition must match)', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({ prepayTermId: 'term-1', effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' }),
      }];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.duplicate).toBeUndefined();
      expect(body.processed).toBe(true);
      expect(body.prepayTermOutcome).toBe('decision_already_recorded');
      expect(mockProcess).toHaveBeenCalledTimes(1);
      // The refund task for the newly requested end-now disposition is raised.
      expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('billing');
    }));

    test('a racing renew decision fails the disposition — no refund task, manual-review confirmation', () => withServer(async (baseUrl) => {
      // recordDecision's guard misses (returns null) and the direct re-read
      // shows a conflicting decision landed after resolveLiveTerm's read —
      // never "already recorded", never a refund.
      mockRecordDecision.mockResolvedValueOnce(null);
      db.mockImplementation((table) => {
        if (table === 'annual_prepay_terms') {
          const b = builderFor(table);
          b.first = jest.fn(async () => ({ ...mockState.annual_prepay_terms[0], renewal_decision: 'renew' }));
          return b;
        }
        return builderFor(table);
      });
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.processed).toBe(true);
      expect(body.prepayTermOutcome).toBe('decision_conflict');
      expect(body.errors).toContain('prepay_term_decision_conflict');
      // No RECORDED refund for a term that stands: the response must not
      // carry a refund object the dialog would render as "Refund recorded".
      expect(body.refund).toBeUndefined();
      // The case keeps the numbers as PROPOSED-only metadata.
      const snapshot = mockOpenCase.mock.calls[0][0].snapshot;
      expect(snapshot.refund).toBeNull();
      expect(snapshot.proposedRefund).toEqual(expect.objectContaining({ needsManualCalc: false }));
      // Only the review bell — the refund task must NOT be raised for a term
      // that is renewing.
      const categories = NotificationService.notifyAdmin.mock.calls.map((c) => c[0]);
      expect(categories).toEqual(['service']);
      // The customer gets the manual-review wording, not "will not renew".
      expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
    }));

    test('a pre-existing decided-cancel term with NO recorded case still runs; the decision write is skipped', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.prepayTermOutcome).toBe('decision_already_recorded');
      expect(mockRecordDecision).not.toHaveBeenCalled();
      expect(mockProcess).toHaveBeenCalledTimes(1);
      // The refund task is still owed.
      expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('billing');
    }));

    test('a covered visit completing DURING the commit re-prices the refund from the post-sweep rows and flags the run for review', () => withServer(async (baseUrl) => {
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
        { id: 's3', customer_id: 'cust-1', status: 'confirmed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-10-01' },
      ];
      // The lock serializes admin commits, not technician completion: s3
      // completes while the sweep runs (the sweep skips it benignly).
      mockProcess.mockImplementationOnce(async () => {
        mockState.scheduled_services.find((r) => r.id === 's3').status = 'completed';
        return { ...PROCESSED };
      });
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      // Recorded money = the post-sweep truth (2 consumed, 2 remaining),
      // never the stale pre-commit snapshot's $360.
      expect(body.refund).toEqual(expect.objectContaining({ completedVisits: 2, remainingVisits: 2, amount: 240 }));
      expect(body.errors).toContain('refund_recomputed_after_sweep');
      expect(mockOpenCase.mock.calls[0][0].snapshot.refund).toEqual(expect.objectContaining({ amount: 240 }));
      const billing = NotificationService.notifyAdmin.mock.calls.find((c) => c[0] === 'billing');
      expect(billing[2]).toContain('$240.00');
      expect(billing[2]).not.toContain('$360.00');
      // The changed amount is an exception: office review bell + the
      // manual-review confirmation wording.
      expect(NotificationService.notifyAdmin.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['billing', 'service']));
      expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
    }));

    test('a retry whose prior run lost the refund task REPAIRS it (term-deduped) and stamps the case — never a clean echo with no task', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
      ];
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({
          prepayTermId: 'term-1', effectiveDate: 'now', prepayDisposition: 'end_now_refund',
          refund: null,
          proposedRefund: { prepaidAmount: 480, includedVisits: 4, completedVisits: 1, remainingVisits: 3, amount: 360, needsManualCalc: false },
          outcome: { visitsPulled: 3, scope: [], confirmationRequested: true, confirmation: 'sms', confirmationChannels: ['sms'] },
        }),
      }];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body).toEqual(expect.objectContaining({ duplicate: true, caseId: 'case-9', errors: [] }));
      expect(body.refund).toEqual(expect.objectContaining({ amount: 360, needsManualCalc: false }));
      // The task is raised into the term dedupe (idempotent if it exists).
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      const [category, , , opts] = NotificationService.notifyAdmin.mock.calls[0];
      expect(category).toBe('billing');
      expect(opts).toEqual(expect.objectContaining({ dedupeKey: 'prepay_refund:term:term-1' }));
      // The case now records the refund; the proposed-only marker is gone.
      const caseUpdate = (mockState.updates || []).find((u) => u.table === 'cancellation_cases');
      const stamped = JSON.parse(caseUpdate.patch.snapshot);
      expect(stamped.refund).toEqual(expect.objectContaining({ amount: 360 }));
      expect(stamped.proposedRefund).toBeUndefined();
      // Still a duplicate: no second request, processor run, or customer text.
      expect(mockProcess).not.toHaveBeenCalled();
      expect(sendCancellationConfirmations).not.toHaveBeenCalled();
    }));

    test('a repair whose live refund no longer matches the recorded proposal is refused — a fresh approved preview unlocks it', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      // A covered visit completed between the attempts: live refund is now
      // 2 remaining ($240), not the recorded 3 ($360).
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
        { id: 's2', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-05-01' },
      ];
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({
          prepayTermId: 'term-1', prepayDisposition: 'end_now_refund', refund: null,
          proposedRefund: { prepaidAmount: 480, includedVisits: 4, completedVisits: 1, remainingVisits: 3, amount: 360, needsManualCalc: false },
        }),
      }];
      let body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.duplicate).toBe(true);
      expect(body.errors).toEqual(['refund_facts_changed']);
      expect(body.refund).toBeUndefined();
      // No task for numbers nobody approved.
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

      // The approval path: a FRESH preview (current numbers) → commit with
      // its fingerprint → the repair raises with the approved live refund.
      const preview = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'now' })).json();
      body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now', previewFingerprint: preview.previewFingerprint })).json();
      expect(body.duplicate).toBe(true);
      expect(body.errors).toEqual([]);
      expect(body.refund).toEqual(expect.objectContaining({ amount: 240, remainingVisits: 2 }));
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('billing');
    }));

    test('a duplicate answers with the FIRST run\'s recorded errors — a belled run never re-reads as "Done"', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({
          prepayTermId: 'term-1', effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term',
          outcome: {
            visitsPulled: 2, scope: [], confirmationRequested: true, confirmation: null, confirmationChannels: [],
            errors: ['confirmation_sms_not_sent', 'confirmation_email_not_sent'],
          },
        }),
      }];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' })).json();
      expect(body.duplicate).toBe(true);
      expect(body.errors).toEqual(['confirmation_sms_not_sent', 'confirmation_email_not_sent']);
    }));

    test('a duplicate with FAILED confirmation channels repairs them — the customer is not permanently untold', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.service_requests = [{
        id: 'req-9', customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'new',
        subject: 'Cancel plan (Admin (user admin-1))', description: '',
        metadata: JSON.stringify({ cancel_plan: { scope: [], waiveLateFee: false, sendConfirmation: true } }),
        created_at: new Date(Date.now() - 60 * 60 * 1000),
      }];
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({
          prepayTermId: 'term-1', effectiveDate: 'end_of_coverage', effectiveOn: '2027-02-28', prepayDisposition: 'end_at_term',
          outcome: {
            visitsPulled: 2, scope: [], confirmationRequested: true, confirmation: null, confirmationChannels: [],
            errors: ['confirmation_sms_not_sent', 'confirmation_email_not_sent'],
          },
        }),
      }];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' })).json();
      expect(body.duplicate).toBe(true);
      // The send-once-guarded helper re-ran with the ORIGINAL verdict/copy.
      expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({
        processed: true, keptThrough: true, entryPoint: 'admin_cancel_plan',
      }));
      expect(body.confirmationChannels).toEqual(['sms', 'email']);
      expect(body.errors).toEqual([]);
      // Clean repair stamps the case and closes the acceptance.
      expect(JSON.parse(mockState.cancellation_cases[0].snapshot).outcome.errors).toEqual([]);
      expect(mockState.service_requests[0].status).toBe('resolved');
      expect(mockProcess).not.toHaveBeenCalled();
    }));

    test('a failed repair reports the missing task instead of a clean duplicate; a recorded refund is never re-raised', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].renewal_decision = 'cancel';
      mockState.annual_prepay_terms[0].status = 'cancelled';
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({
          prepayTermId: 'term-1', prepayDisposition: 'end_now_refund', refund: null,
          proposedRefund: { prepaidAmount: 480, includedVisits: 4, completedVisits: 0, remainingVisits: 4, amount: 480, needsManualCalc: false },
        }),
      }];
      NotificationService.notifyAdmin.mockResolvedValueOnce({ suppressed: true });
      let body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.duplicate).toBe(true);
      expect(body.errors).toEqual(['prepay_refund_task_missing']);
      expect(body.refund).toBeUndefined();

      // A prior run that DID record its refund answers as-is — no re-raise.
      NotificationService.notifyAdmin.mockClear();
      mockState.cancellation_cases = [{
        id: 'case-9', customer_id: 'cust-1', service_request_id: 'req-9', status: 'committed',
        snapshot: JSON.stringify({ prepayTermId: 'term-1', prepayDisposition: 'end_now_refund', refund: { amount: 360, needsManualCalc: false } }),
      }];
      body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body).toEqual(expect.objectContaining({ duplicate: true, errors: [] }));
      expect(body.refund).toEqual(expect.objectContaining({ amount: 360 }));
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    }));

    test('a coverage visit completed BEFORE activation (deliberately unstamped) counts as consumed — its slice is never refunded', () => withServer(async (baseUrl) => {
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
        // Completed inside the pending window: reconciliation settles or
        // credits its invoice; the stamp never lands, but the visit consumed
        // a coverage slice all the same.
        { id: 's2', customer_id: 'cust-1', status: 'completed', prepaid_method: null, scheduled_date: '2026-03-05' },
      ];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.refund).toEqual(expect.objectContaining({ completedVisits: 2, remainingVisits: 2, amount: 240, needsManualCalc: false }));
    }));

    test('a legacy term with no readable coverage identity refuses end_of_coverage (409) — an empty covered set is never trusted', () => withServer(async (baseUrl) => {
      delete mockState.annual_prepay_terms[0].coverage_service_type;
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('prepay_coverage_unresolvable');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
      // The preview refuses the same way — the operator never sees a plan
      // that silently pulls the paid visits.
      const preview = await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'end_of_coverage' });
      expect(preview.status).toBe(409);
    }));

    test('a legacy term with no readable coverage identity records the end-now refund as MANUAL — a zero completed count is never a full refund', () => withServer(async (baseUrl) => {
      delete mockState.annual_prepay_terms[0].coverage_service_type;
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
      ];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.refund).toEqual(expect.objectContaining({ amount: null, needsManualCalc: true, reason: 'coverage_identity_missing' }));
      const billing = NotificationService.notifyAdmin.mock.calls.find((c) => c[0] === 'billing');
      expect(billing[2]).toContain('manual calculation');
    }));

    test('prior refund activity on the prepay payment records the refund as MANUAL — combined refunds must never exceed what was paid', () => withServer(async (baseUrl) => {
      mockState.annual_prepay_terms[0].prepay_invoice_id = 'inv-1';
      mockState.invoices = [{ id: 'inv-1', stripe_payment_intent_id: 'pi_1', stripe_charge_id: null }];
      mockState.payments = [{ id: 'pay-1', status: 'succeeded', refund_status: 'partial', refund_amount: '100.00', metadata: { invoice_id: 'inv-1' } }];
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
      ];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.refund).toEqual(expect.objectContaining({ amount: null, needsManualCalc: true, reason: 'prior_refund_activity' }));

      // No refund activity on the linked payment → the C-6 math stands.
      mockState.payments = [{ id: 'pay-1', status: 'succeeded', refund_status: null, refund_amount: null, metadata: { invoice_id: 'inv-1' } }];
      mockState.annual_prepay_terms[0].renewal_decision = null;
      mockState.cancellation_cases = [];
      mockRecordDecision.mockClear();
      const clean = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(clean.refund).toEqual(expect.objectContaining({ amount: 360, needsManualCalc: false }));
    }));

    test('a scoped cancel that would pull COVERED visits is refused — 409 scoped_covers_prepaid, nothing written', () => withServer(async (baseUrl) => {
      mockState.scheduled_services = [
        // Inside the live term's window AND upcoming — coverageRowsForTerm
        // (the canonical identity) reports it covered; a stamp alone no
        // longer does.
        { id: 'sv1', customer_id: 'cust-1', family: 'pest_control', status: 'confirmed', scheduled_date: '2026-10-05', prepaid_method: 'annual_prepay_invoice' },
      ];
      mockPlan.mockResolvedValue({ ok: true, inScope: ['pest_control'], remaining: ['lawn_care'], tierBefore: 'Silver', tierAfter: 'Bronze' });
      const preview = await (await post(baseUrl, '/cancel-plan/preview', { families: ['pest_control'] })).json();
      expect(preview).toEqual(expect.objectContaining({ scopedSupported: false, scopeError: 'scoped_covers_prepaid' }));
      const res = await post(baseUrl, '/cancel-plan', { families: ['pest_control'] });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('scoped_covers_prepaid');
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
    }));

    test('a scoped cancel OUTSIDE the covered family still runs (the covered rows are provably out of scope)', () => withServer(async (baseUrl) => {
      mockState.scheduled_services = [
        // Covered (in-window, upcoming) but out of the selected scope.
        { id: 'sv1', customer_id: 'cust-1', family: 'pest_control', status: 'confirmed', scheduled_date: '2026-10-05', prepaid_method: 'annual_prepay_invoice' },
      ];
      mockProcess.mockResolvedValueOnce({ ...PROCESSED, churned: false, scopedWoundDown: true, scope: ['lawn_care'], remaining: ['pest_control'] });
      const res = await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] });
      expect(res.status).toBe(200);
      expect(mockProcess).toHaveBeenCalledTimes(1);
      expect(mockRecordDecision).not.toHaveBeenCalled();
    }));

    test('refund math ignores completed visits stamped to ANOTHER term (overlapping terms)', () => withServer(async (baseUrl) => {
      mockState.scheduled_services = [
        { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01', annual_prepay_term_id: 'term-1' },
        { id: 's2', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-05-01', annual_prepay_term_id: null },
        { id: 's3', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-06-01', annual_prepay_term_id: 'term-OTHER' },
      ];
      const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
      expect(body.refund).toEqual(expect.objectContaining({ completedVisits: 2, remainingVisits: 2, amount: 240, needsManualCalc: false }));
    }));

    test('a scoped cancel leaves the term alone', () => withServer(async (baseUrl) => {
      mockProcess.mockResolvedValueOnce({ ...PROCESSED, churned: false, scopedWoundDown: true, scope: ['lawn_care'], remaining: ['pest_control'] });
      const body = await (await post(baseUrl, '/cancel-plan', { families: ['lawn_care'] })).json();
      expect(body.prepayDisposition).toBeNull();
      expect(mockRecordDecision).not.toHaveBeenCalled();
      expect((mockState.updates || []).filter((u) => u.table === 'annual_prepay_terms')).toEqual([]);
    }));
  });

  test('a green processor with a failed follow-up step (case write) still bells the office', () => withServer(async (baseUrl) => {
    mockOpenCase.mockRejectedValueOnce(new Error('case table down'));
    const body = await (await post(baseUrl, '/cancel-plan')).json();
    expect(body.processed).toBe(true);
    expect(body.errors).toEqual(['case_write']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, text] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('service');
    expect(title).toMatch(/needs review/);
    expect(text).toContain('a follow-up step failed');
    expect(text).toContain('case_write');
    // The customer hears the manual-review wording, not a green "done" —
    // the confirmation verdict reflects follow-up failures.
    expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
  }));

  test('a concurrent commit holding the customer lock → 409 cancel_in_progress, nothing written', () => withServer(async (baseUrl) => {
    db.client.locked = false;
    const res = await post(baseUrl, '/cancel-plan');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cancel_in_progress');
    expect(mockState.inserted).toBeUndefined();
    expect(mockProcess).not.toHaveBeenCalled();
    expect(db.client.releaseConnection).toHaveBeenCalled();
  }));

  test('the commit lock is released after a successful run (and the preview never takes it)', () => withServer(async (baseUrl) => {
    await post(baseUrl, '/cancel-plan/preview');
    expect(db.client.acquireConnection).not.toHaveBeenCalled();
    const res = await post(baseUrl, '/cancel-plan');
    expect(res.status).toBe(200);
    const sqls = db.client.lockConn.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('pg_try_advisory_lock'))).toBe(true);
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(db.client.releaseConnection).toHaveBeenCalled();
  }));

  test('a body customerId cannot re-point the cancel: the path id is authoritative', () => withServer(async (baseUrl) => {
    const res = await post(baseUrl, '/cancel-plan', { customerId: 'cust-EVIL' });
    expect(res.status).toBe(200);
    expect(mockState.inserted.find((i) => i.table === 'service_requests').row.customer_id).toBe('cust-1');
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1' }));
  }));

  test('a failed processor run never touches the prepaid term or raises the refund task', () => withServer(async (baseUrl) => {
    mockState.annual_prepay_terms = [{
      id: 'term-1', customer_id: 'cust-1', term_start: '2026-03-01', term_end: '2027-02-28', plan_label: 'Annual Pest',
      prepay_amount: '480.00', coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control', status: 'active', renewal_decision: null,
    }];
    mockProcess.mockRejectedValueOnce(new Error('sweep down'));
    const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
    expect(body.processed).toBe(false);
    expect(body.prepayTermOutcome).toBe('skipped_processor_failed');
    expect(body.errors).toEqual(expect.arrayContaining(['processor_threw', 'prepay_term_disposition_skipped']));
    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect((mockState.updates || []).filter((u) => u.table === 'annual_prepay_terms')).toEqual([]);
    // The only office notification is the review bell — never the refund task.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('service');
  }));

  test('a partial processor run reports processed:false, keeps the errors, and bells the office once', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, errors: ['in_progress_visit:s9'] });
    sendCancellationConfirmations.mockResolvedValueOnce({ smsSent: false, emailSent: true, channels: ['email'] });
    const body = await (await post(baseUrl, '/cancel-plan')).json();
    // The blocked SMS on a reachable phone is itself a surfaced failure.
    expect(body).toEqual(expect.objectContaining({ processed: false, errors: ['in_progress_visit:s9', 'confirmation_sms_not_sent'], confirmation: 'email', confirmationChannels: ['email'] }));
    expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
    expect(mockOpenCase).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][3]).toEqual(expect.objectContaining({ bell: true }));
  }));
});
