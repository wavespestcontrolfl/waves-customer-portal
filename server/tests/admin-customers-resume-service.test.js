/**
 * POST /admin/customers/:id/resume-service — the missing un-pause.
 *
 * billing-cron sets customers.service_paused_at + service_pause_reason when
 * autopay's 3-retry ladder exhausts, and processMonthlyBilling then filters
 * on .whereNull('service_paused_at'). Migration 20260418000002 described an
 * admin action to unset it; that action was never built, so the pause was
 * permanent — dues stopped for good even after the customer paid, and the
 * only remedy was editing the row by hand.
 *
 * Contract:
 *   - clears BOTH columns, so the monthly cron picks the customer back up
 *   - idempotent: a second click (or one that loses a race) is a no-op, not
 *     a second audit row
 *   - writes an audit note carrying the original pause date and reason
 *   - 404s an unknown or soft-deleted customer
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Programmable per-test state. `storedPausedAt` is what the row holds at
// UPDATE time — the compare-and-swap reads it, so a test can simulate
// billing-cron re-pausing between the SELECT and the UPDATE.
const CHARGEABLE_METHOD = {
  id: 'pm-1',
  processor: 'stripe',
  method_type: 'card',
  stripe_payment_method_id: 'pm_stripe_1',
  is_default: true,
  autopay_enabled: true,
  exp_month: 12,
  exp_year: 2099,
};

const mockState = {
  customer: null,
  freshCustomer: null,
  autopayMethod: CHARGEABLE_METHOD,
  annualPrepayCovered: [],
  annualPrepayPending: [],
  storedPausedAt: undefined,
  updates: [],
  interactions: [],
  auditEvents: [],
  insertShouldFail: false,
  rolledBack: false,
};

jest.mock('../services/annual-prepay-renewals', () => ({
  getActivelyCoveredCustomerIds: jest.fn(async () => new Set(mockState.annualPrepayCovered)),
  getPaymentPendingCustomerIds: jest.fn(async () => new Set(mockState.annualPrepayPending)),
}));

jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => { mockState.auditEvents.push(event); }),
}));

jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = { _table: table, _where: {}, _null: [] };
    q.where = (criteria) => { Object.assign(q._where, criteria); return q; };
    q.whereNull = (col) => { q._null.push(col); return q; };
    q.whereNotNull = (col) => { (q._notNull = q._notNull || []).push(col); return q; };
    q.first = async () => {
      if (table === 'payment_methods') return mockState.autopayMethod;
      if (table !== 'customers' || !mockState.customer) return null;
      // The initial read carries .whereNull('deleted_at'); the post-transaction
      // re-read does not, so this distinguishes them and lets a test move the
      // row underneath the request.
      if (!q._null.includes('deleted_at')) return mockState.freshCustomer || mockState.customer;
      if (mockState.customer.deleted_at) return null;
      return mockState.customer;
    };
    q.update = async (patch) => {
      mockState.updates.push({ table, where: { ...q._where }, nullChecks: [...q._null], patch });
      if (table === 'customers') {
        // Real compare-and-swap semantics: the row matches only when its
        // CURRENT service_paused_at equals the one the request selected.
        const stored = mockState.storedPausedAt === undefined
          ? mockState.customer?.service_paused_at
          : mockState.storedPausedAt;
        if ('service_paused_at' in q._where && q._where.service_paused_at !== stored) return 0;
        if (q._null.includes('deleted_at') && mockState.customer?.deleted_at) return 0;
      }
      return 1;
    };
    q.insert = async (row) => {
      if (mockState.insertShouldFail) throw new Error('audit insert exploded');
      mockState.interactions.push(row);
      return [1];
    };
    return q;
  };

  const db = jest.fn(builder);
  db.transaction = async (fn) => {
    const trx = jest.fn(builder);
    try {
      return await fn(trx);
    } catch (err) {
      // Mirror knex: a throwing callback rolls the whole transaction back.
      mockState.rolledBack = true;
      mockState.updates = mockState.updates.filter((u) => u.table !== 'customers');
      mockState.interactions = [];
      mockState.auditEvents = [];
      throw err;
    }
  };
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  db.raw = jest.fn((sql) => sql);
  return db;
});

const adminCustomersRoute = require('../routes/admin-customers');

// Invoke the handler directly (no supertest at the repo root): the admin-auth
// middleware is mocked above, so the handler only needs req.params/body and a
// res.json/res.status spy.
async function resumeService(id, body = {}) {
  const layer = adminCustomersRoute.stack.find(
    (l) => l.route?.path === '/:id/resume-service' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('POST /:id/resume-service is not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id }, body, technicianId: 'admin-1' };
  let payload = null;
  let status = 200;
  const res = {
    status: (code) => { status = code; return res; },
    json: (p) => { payload = p; return res; },
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { status, body: payload };
}

beforeEach(() => {
  mockState.customer = null;
  mockState.freshCustomer = null;
  mockState.autopayMethod = CHARGEABLE_METHOD;
  mockState.annualPrepayCovered = [];
  mockState.annualPrepayPending = [];
  mockState.storedPausedAt = undefined;
  mockState.updates = [];
  mockState.interactions = [];
  mockState.auditEvents = [];
  mockState.insertShouldFail = false;
  mockState.rolledBack = false;
});

const PAUSED = {
  id: 'cust-1',
  service_paused_at: '2026-05-02T12:00:00Z',
  service_pause_reason: 'autopay_final_failure',
};

describe('POST /admin/customers/:id/resume-service', () => {
  test('clears BOTH pause columns so the monthly cron picks the customer back up', async () => {
    mockState.customer = { ...PAUSED };

    const res = await resumeService('cust-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, resumed: true, pauseReason: 'autopay_final_failure' });
    const update = mockState.updates.find((u) => u.table === 'customers');
    expect(update).toBeTruthy();
    // Leaving service_pause_reason behind strands a stale reason on a
    // customer who is no longer paused.
    expect(update.patch).toEqual({ service_paused_at: null, service_pause_reason: null });
    // Compare-and-swap on THIS pause, not merely "some pause".
    expect(update.where).toMatchObject({ id: 'cust-1', service_paused_at: PAUSED.service_paused_at });
    expect(update.nullChecks).toContain('deleted_at');
  });

  test('a pause applied by billing-cron after the read is NOT wiped', async () => {
    mockState.customer = { ...PAUSED };
    // Between our SELECT and our UPDATE the original pause cleared and a
    // fresh ladder exhaustion re-paused this customer. Clearing that would
    // put a customer with a dead card back into the billing run.
    mockState.storedPausedAt = '2026-06-01T09:00:00Z';

    const res = await resumeService('cust-1');

    expect(res.body).toMatchObject({ success: true, resumed: false, reason: 'pause_changed' });
    expect(mockState.interactions).toHaveLength(0);
    expect(mockState.auditEvents).toHaveLength(0);
  });

  test('records a critical audit_log event alongside the note', async () => {
    mockState.customer = { ...PAUSED };

    await resumeService('cust-1');

    expect(mockState.auditEvents).toHaveLength(1);
    expect(mockState.auditEvents[0]).toMatchObject({
      actor_type: 'admin',
      action: 'customer.billing_resumed',
      resource_type: 'customer',
      resource_id: 'cust-1',
      critical: true,
    });
    // Written inside the transaction, not after it.
    expect(mockState.auditEvents[0].trx).toBeTruthy();
  });

  test('a failed audit write rolls the resume back rather than losing the record', async () => {
    mockState.customer = { ...PAUSED };
    mockState.insertShouldFail = true;

    await expect(resumeService('cust-1')).rejects.toThrow(/audit insert exploded/);

    // A money-affecting action that succeeded with no durable record is worse
    // than one that failed loudly.
    expect(mockState.rolledBack).toBe(true);
    expect(mockState.updates.filter((u) => u.table === 'customers')).toHaveLength(0);
  });

  test('records an audit note carrying the original pause date and reason', async () => {
    mockState.customer = { ...PAUSED };

    await resumeService('cust-1', { notes: 'card updated by phone' });

    const note = mockState.interactions[0];
    expect(note).toBeTruthy();
    expect(note.subject).toBe('Billing resumed');
    expect(note.body).toContain('2026-05-02');
    expect(note.body).toContain('autopay_final_failure');
    // The no-back-billing promise is what makes this safe to click, so it
    // belongs in the record and not only in the UI.
    expect(note.body).toContain('no back-billing');
    expect(note.body).toContain('card updated by phone');
    expect(note.admin_user_id).toBe('admin-1');
  });

  test('is a no-op on a customer who is not paused — no update, no audit row', async () => {
    mockState.customer = { id: 'cust-1', service_paused_at: null, service_pause_reason: null };

    const res = await resumeService('cust-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, resumed: false, reason: 'not_paused' });
    expect(mockState.updates.filter((u) => u.table === 'customers')).toHaveLength(0);
    expect(mockState.interactions).toHaveLength(0);
  });

  test('a concurrent click that loses the race writes no second audit row', async () => {
    mockState.customer = { ...PAUSED };
    // Another admin cleared the pause between our read and our write.
    mockState.storedPausedAt = null;

    const res = await resumeService('cust-1');

    expect(res.body).toMatchObject({ resumed: false, reason: 'pause_changed' });
    expect(mockState.interactions).toHaveLength(0);
    expect(mockState.auditEvents).toHaveLength(0);
  });

  test('files the pause date on its EASTERN calendar day', async () => {
    // 00:30 UTC on 2026-05-03 is 8:30pm ET on 2026-05-02. A UTC-derived date
    // would file this on the following business day.
    mockState.customer = { ...PAUSED, service_paused_at: '2026-05-03T00:30:00Z' };

    const res = await resumeService('cust-1');

    expect(res.body.pausedSince).toBe('2026-05-02');
    expect(mockState.interactions[0].body).toContain('2026-05-02');
    expect(mockState.auditEvents[0].metadata.paused_since).toBe('2026-05-02');
  });

  test('reports the OTHER cron guards that still stop dues after the pause clears', async () => {
    // Clearing the pause is necessary, not sufficient: processMonthlyBilling
    // has its own guards, and each one also means no dues. Claiming "resumed"
    // while removing the only warning would leave a customer silently
    // unbilled for a different reason.
    mockState.customer = {
      ...PAUSED,
      active: false,
      monthly_rate: '0',
      autopay_enabled: false,
      autopay_paused_until: '2099-01-01',
      billing_mode: 'per_visit',
    };

    const res = await resumeService('cust-1');

    expect(res.body.resumed).toBe(true);
    expect(res.body.blockers).toEqual(expect.arrayContaining([
      'customer_inactive',
      'no_monthly_rate',
      // ONE autopay label, not one per failing sub-check: customerOnAutopay
      // is the gate, and these narrower reads only name which part failed.
      'autopay_disabled',
      'billing_lane_per_visit',
    ]));
    expect(res.body.blockers).not.toContain('autopay_paused_until');
  });

  test('a live autopay_paused_until is labelled as such', async () => {
    mockState.customer = {
      ...PAUSED, active: true, monthly_rate: '55.00', autopay_enabled: true,
      autopay_paused_until: '2099-01-01', billing_mode: 'monthly_membership',
    };

    const res = await resumeService('cust-1');

    expect(res.body.blockers).toContain('autopay_paused_until');
  });

  test('annual-prepay coverage and a pending annual invoice both suppress dues', async () => {
    // GUARD 4 / 4b: a legacy monthly-lane customer can resolve monthly and
    // still be suppressed by prepaid coverage.
    mockState.customer = {
      ...PAUSED, active: true, monthly_rate: '55.00', autopay_enabled: true,
      autopay_paused_until: null, billing_mode: 'monthly_membership',
    };
    mockState.annualPrepayCovered = ['cust-1'];
    mockState.annualPrepayPending = ['cust-1'];

    const res = await resumeService('cust-1');

    expect(res.body.blockers).toEqual(expect.arrayContaining([
      'annual_prepay_covered',
      'annual_prepay_payment_pending',
    ]));
  });

  test('an UNCLASSIFIED customer is reported too — NULL billing_mode infers per_visit', async () => {
    // The cron resolves the lane (GUARD 3c) rather than reading billing_mode
    // directly, so a NULL-mode row with no real tier is skipped exactly like
    // an explicit per_visit one. Checking only explicit modes would hand this
    // customer blockers: [] and remove their only warning.
    mockState.customer = {
      ...PAUSED,
      active: true,
      monthly_rate: '55.00',
      autopay_enabled: true,
      autopay_paused_until: null,
      billing_mode: null,
      waveguard_tier: null,
    };

    const res = await resumeService('cust-1');

    expect(res.body.resumed).toBe(true);
    expect(res.body.blockers).toContain('billing_lane_per_visit');
  });

  test('a NULL-mode customer with a real tier and rate resolves monthly — no blocker', async () => {
    // The other side of the inference: this row IS the cron's customer.
    mockState.customer = {
      ...PAUSED,
      active: true,
      monthly_rate: '55.00',
      autopay_enabled: true,
      autopay_paused_until: null,
      billing_mode: null,
      waveguard_tier: 'Silver',
    };

    const res = await resumeService('cust-1');

    expect(res.body).toMatchObject({ resumed: true, blockers: [] });
  });

  test('reports no blockers for a customer the cron will actually bill', async () => {
    mockState.customer = {
      ...PAUSED,
      active: true,
      monthly_rate: '55.00',
      autopay_enabled: true,
      autopay_paused_until: null,
      billing_mode: 'monthly_membership',
    };

    const res = await resumeService('cust-1');

    expect(res.body).toMatchObject({ resumed: true, blockers: [] });
  });

  test('autopay_enabled is not the same as chargeable — an expired card is reported', async () => {
    // The next run would reach stripe.charge and fail while the UI had
    // already removed the only warning.
    mockState.customer = {
      ...PAUSED, active: true, monthly_rate: '55.00', autopay_enabled: true,
      autopay_paused_until: null, billing_mode: 'monthly_membership',
    };
    mockState.autopayMethod = { ...CHARGEABLE_METHOD, exp_month: 1, exp_year: 2020 };

    const res = await resumeService('cust-1');

    expect(res.body.blockers).toContain('no_chargeable_autopay_method');
  });

  test('no default autopay method at all is reported', async () => {
    mockState.customer = {
      ...PAUSED, active: true, monthly_rate: '55.00', autopay_enabled: true,
      autopay_paused_until: null, billing_mode: 'monthly_membership',
    };
    mockState.autopayMethod = undefined;

    const res = await resumeService('cust-1');

    expect(res.body.blockers).toContain('no_chargeable_autopay_method');
  });

  test('blockers come from a POST-transaction read, not the stale snapshot', async () => {
    mockState.customer = {
      ...PAUSED, active: true, monthly_rate: '55.00', autopay_enabled: true,
      autopay_paused_until: null, billing_mode: 'monthly_membership',
    };
    // The customer was deactivated while this request was in flight. Reporting
    // from the snapshot would claim dues are collectible when they are not.
    mockState.freshCustomer = { ...mockState.customer, active: false };

    const res = await resumeService('cust-1');

    expect(res.body.resumed).toBe(true);
    expect(res.body.blockers).toContain('customer_inactive');
  });

  test('billing-pause fields never reach a technician payload', async () => {
    // Same class as monthlyRate/billingMode. A tech opening Customer 360 for
    // an assigned visit must not see "autopay failed three times".
    const { techSafe360Payload } = adminCustomersRoute._private;
    const stripped = techSafe360Payload({
      customer: {
        id: 'cust-1',
        firstName: 'Avery',
        servicePausedAt: '2026-05-02T12:00:00Z',
        servicePausedOn: '2026-05-02',
        servicePauseReason: 'autopay_final_failure',
      },
    });
    expect(stripped.customer.servicePausedAt).toBeUndefined();
    expect(stripped.customer.servicePausedOn).toBeUndefined();
    expect(stripped.customer.servicePauseReason).toBeUndefined();
    // Non-financial fields still survive — this is a denylist, not a wipe.
    expect(stripped.customer.firstName).toBe('Avery');
  });

  test('404s an unknown customer', async () => {
    mockState.customer = null;
    const res = await resumeService('nope');
    expect(res.status).toBe(404);
  });

  test('404s a soft-deleted customer', async () => {
    mockState.customer = { ...PAUSED, deleted_at: '2026-01-01T00:00:00Z' };
    const res = await resumeService('cust-1');
    expect(res.status).toBe(404);
  });
});
