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
const mockOpenCase = jest.fn(async (args) => ({ id: 'case-1', ...args }));
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
  openCancellationCase: (...args) => mockOpenCase(...args),
}));
const mockProcess = jest.fn();
const mockPlan = jest.fn();
jest.mock('../services/cancellation-processor', () => ({
  processCancellationRequest: (...args) => mockProcess(...args),
  planScopedWindDown: (...args) => mockPlan(...args),
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
  const rows = () => (mockState[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = jest.fn((criteria, opOrVal, maybeVal) => {
    if (typeof criteria === 'string') {
      if (maybeVal === undefined) conds.push((r) => r[criteria] === opOrVal);
      else if (opOrVal === '>=') conds.push((r) => r[criteria] >= maybeVal);
      else throw new Error(`fake db: unsupported operator ${opOrVal}`);
    } else if (typeof criteria === 'object') {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
    }
    return b;
  });
  b.whereIn = jest.fn((col, vals) => { conds.push((r) => vals.includes(r[col])); return b; });
  b.whereNull = jest.fn((col) => { conds.push((r) => r[col] == null); return b; });
  b.whereBetween = jest.fn((col, [lo, hi]) => { conds.push((r) => r[col] >= lo && r[col] <= hi); return b; });
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
      const inserted = { id: `${table}-${(mockState.inserted ??= []).length + 1}`, created_at: new Date('2026-08-31T14:00:00Z'), ...row };
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
  mockOpenCase.mockClear();
  mockRecordDecision.mockClear();
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
      prepay_amount: '480.00', coverage_visit_count: 4, status: 'active',
    }];
    mockState.scheduled_services = [
      { id: 's1', customer_id: 'cust-1', status: 'completed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-04-01' },
      { id: 's2', customer_id: 'cust-1', status: 'completed', prepaid_method: null, scheduled_date: '2026-05-01' },
      { id: 's3', customer_id: 'cust-1', status: 'confirmed', prepaid_method: 'annual_prepay_invoice', scheduled_date: '2026-10-01' },
    ];
    let body = await (await post(baseUrl, '/cancel-plan/preview', { effectiveDate: 'end_of_coverage' })).json();
    expect(body.effectiveDate).toBe('end_of_coverage');
    // The "visits pulled" preview counts only what the button pulls — the
    // impact math gets the processor's keep-through boundary.
    const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
    expect(buildCancellationImpact).toHaveBeenLastCalledWith('cust-1', [], { after: '2027-02-28' });
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
    mockProcess.mockImplementation(async () => { order.push('processor'); return { ...PROCESSED }; });
    mockOpenCase.mockImplementation(async (args) => { order.push('case'); return { id: 'case-1', ...args }; });
    sendCancellationConfirmations.mockImplementation(async () => { order.push('confirm'); return { smsSent: true, emailSent: false, channels: ['sms'] }; });

    const res = await post(baseUrl, '/cancel-plan', { reasonCode: 'price', note: 'Too expensive', waiveLateFee: true });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(order).toEqual(['insert:service_requests', 'processor', 'case', 'confirm']);
    const request = mockState.inserted.find((i) => i.table === 'service_requests').row;
    expect(request).toEqual(expect.objectContaining({ customer_id: 'cust-1', category: 'cancellation', source: 'admin', status: 'new', description: 'Too expensive' }));
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', requestId: request.id, families: [], keepThrough: null, waiveLateFee: true,
      actor: { type: 'admin', userId: 'admin-1' },
      // The recorded reason (code + note) feeds churn classification — never
      // the request-id boilerplate when the operator said why.
      reason: 'price — Too expensive',
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
      tierBefore: 'Silver', tierAfter: null, lateFeeWaived: true, confirmation: 'sms', confirmationChannels: ['sms'],
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
        prepay_amount: '480.00', coverage_visit_count: 4, status: 'active', renewal_decision: null,
      }];
    });

    test('end_of_coverage: processor keeps visits through term_end, the term is decided cancel (no renewal), no refund, no office task', () => withServer(async (baseUrl) => {
      mockProcess.mockResolvedValueOnce({ ...PROCESSED, keptThrough: '2027-02-28' });
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ keepThrough: '2027-02-28' }));
      expect(mockRecordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'term-1', action: 'cancel', adminUserId: 'admin-1' }));
      expect(mockState.updates || []).toEqual([]);
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
      expect(mockState.updates || []).toEqual([]);
      expect(body.refund).toEqual(expect.objectContaining({ amount: 360, remainingVisits: 3, needsManualCalc: false }));
      expect(body.prepayTermOutcome).toBe('ended_now');
      expect(mockOpenCase.mock.calls[0][0].snapshot.refund).toEqual(expect.objectContaining({ amount: 360 }));
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      const [category, title, text, opts] = NotificationService.notifyAdmin.mock.calls[0];
      expect(category).toBe('billing');
      expect(title).toMatch(/refund/i);
      expect(text).toContain('$360.00');
      expect(text).toContain('Nothing has been refunded automatically');
      expect(opts).toEqual(expect.objectContaining({ bell: true, dedupeKey: `prepay_refund:${body.requestId}` }));
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
        snapshot: JSON.stringify({ prepayTermId: 'term-1', effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' }),
      }];
      const res = await post(baseUrl, '/cancel-plan', { effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({ duplicate: true, requestId: 'req-9', caseId: 'case-9', processed: true, prepayTermOutcome: 'decision_already_recorded' }));
      expect(mockState.inserted).toBeUndefined();
      expect(mockProcess).not.toHaveBeenCalled();
      expect(mockRecordDecision).not.toHaveBeenCalled();
      expect(sendCancellationConfirmations).not.toHaveBeenCalled();
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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
      expect(mockState.updates || []).toEqual([]);
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
      prepay_amount: '480.00', coverage_visit_count: 4, status: 'active', renewal_decision: null,
    }];
    mockProcess.mockRejectedValueOnce(new Error('sweep down'));
    const body = await (await post(baseUrl, '/cancel-plan', { effectiveDate: 'now' })).json();
    expect(body.processed).toBe(false);
    expect(body.prepayTermOutcome).toBe('skipped_processor_failed');
    expect(body.errors).toEqual(expect.arrayContaining(['processor_threw', 'prepay_term_disposition_skipped']));
    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockState.updates || []).toEqual([]);
    // The only office notification is the review bell — never the refund task.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('service');
  }));

  test('a partial processor run reports processed:false, keeps the errors, and bells the office once', () => withServer(async (baseUrl) => {
    mockProcess.mockResolvedValueOnce({ ...PROCESSED, ok: false, errors: ['in_progress_visit:s9'] });
    sendCancellationConfirmations.mockResolvedValueOnce({ smsSent: false, emailSent: true, channels: ['email'] });
    const body = await (await post(baseUrl, '/cancel-plan')).json();
    expect(body).toEqual(expect.objectContaining({ processed: false, errors: ['in_progress_visit:s9'], confirmation: 'email', confirmationChannels: ['email'] }));
    expect(sendCancellationConfirmations).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
    expect(mockOpenCase).toHaveBeenCalledWith(expect.objectContaining({ processed: false }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][3]).toEqual(expect.objectContaining({ bell: true }));
  }));
});
