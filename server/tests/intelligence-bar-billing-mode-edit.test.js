// Intelligence Bar update_customer: billing type + per-application fee
// (owner D5 2026-10-06, GATE_IB_BILLING_MODE_EDIT). Proposal rules mirror the
// customer page's PUT (billing-mode-rules.js), the card text, the commit-time
// pin, and the gate.
const mockState = {
  seriesIds: [], customer: null, version: 'v1', term: null, armed: null, unpriced: [], visits: [], updates: [],
  // Eligibility / lock doubles and the order of the commit's reads.
  cohortMiss: false, prepayBusy: false, roots: [], invoices: [], dues: [], invoiceBusy: false, autopayUnreadable: false, method: { id: 'pm-1', method_type: 'card' }, methodDetail: { last_four: null, bank_last_four: null }, taxRate: 0, unbillableSeries: new Set(), siblingInvoices: {}, orphan: null, ambiguous: null, inFlight: false, processing: null, processingInvoice: null, methodRows: [{ id: 'pm-1' }], methodsBusy: false, methodsAdvisoryBusy: false, traceTender: false, rootPrices: {}, unverifiedRoots: new Set(), zeroRoots: new Set(), topupSkips: {}, holdActive: false, covered: new Set(), pending: new Set(), chargeable: true, claimHeld: false, log: [],
};

jest.mock('../models/db', () => {
  const build = (table) => {
    const q = { cols: [] };
    // whereRaw notes the dues stamp, so the open-dues query is told apart from the visits' invoices.
    q.whereRaw = (sql, args) => { if (String(sql).includes('line_items::jsonb @>') && Array.isArray(args)) q.stampMonth = JSON.parse(args[0])[0].membership_dues_month; if (String(sql).startsWith('status IN') && Array.isArray(args) && args.length === 1 && args[0] === 'processing') q.procOnly = true; if (String(sql).includes("billed_month' = ?") && Array.isArray(args)) q.billedMonth = args[0]; if (String(sql).includes('membership_dues_month')) q.duesQuery = true; if (String(sql).includes('ambiguous_outcome')) q.ambiguousQuery = true; return q; };
    for (const m of ['whereNull', 'whereNotNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereRaw', 'orderBy', 'join']) q[m] = () => q;
    // limit is honoured, so a card that cut the visits at a page size would show it.
    q.limit = (n) => { q.cap = n; return q; };
    // where(fn) runs its callback (the live-visit clause is built that way).
    q.where = (f) => { if (typeof f === 'function') f.call(q, q); return q; };
    q.whereIn = (col, vals) => { if (col === 'id') q.byId = true; if (col === 'status') q.statuses = vals; return q; };
    q.forUpdate = () => { q.locked = true; if (table === 'customers') mockState.log.push('customers:row'); if (table === 'invoices') mockState.log.push('invoices:lock'); if (table === 'payment_methods') mockState.log.push('methods:lock'); return q; };
    // NOWAIT on a locked invoice fails at once (Postgres 55P03), it never waits.
    q.noWait = () => { q.nowait = true; return q; };
    q.select = (...cols) => { q.cols = cols; return q; };
    q.first = async (...cols) => {
      if (table === 'customers') {
        if (cols.length === 1 && cols[0]?.__raw) return { version: mockState.version };
        // The dues cohort read (monthly-dues-eligibility.js applyDuesCohort).
        if (Array.isArray(cols[0]) && mockState.cohortMiss) return null;
        return mockState.customer ? { ...mockState.customer, version: mockState.version } : null;
      }
      if (table === 'annual_prepay_terms') return mockState.term;
      if (table === 'payment_methods') return mockState.methodDetail;
      if (table === 'scheduled_services') return mockState.roots[0] || null;
      if (table.startsWith('service_completion_attempts')) return mockState.inFlight ? { id: 'att-1' } : null;
      if (table === 'invoices' && q.procOnly) return mockState.processingInvoice && mockState.processingInvoice.month === q.stampMonth ? mockState.processingInvoice : null;
      if (table === 'stripe_orphan_charges') return mockState.orphan;
      if (table === 'payments') return q.ambiguousQuery ? (mockState.ambiguous && (!mockState.ambiguous.month || mockState.ambiguous.month === q.billedMonth) ? mockState.ambiguous : null) : (q.statuses && q.statuses.includes('processing') ? mockState.processing : mockState.armed);
      return null;
    };
    q.then = (resolve, reject) => {
      let rows = [];
      if (table === 'scheduled_services') {
        rows = q.cols.includes('scheduled_date') ? mockState.unpriced : mockState.visits;
        if (q.byId) { rows = mockState.roots; if (q.locked) mockState.log.push('roots:lock'); }
        if (q.cols.flat().includes('is_recurring')) mockState.log.push(q.locked ? 'visits:lock' : 'visits:read');
      }
      if (table === 'invoices') {
        if (q.nowait && mockState.invoiceBusy) return Promise.reject(Object.assign(new Error('could not obtain lock on row'), { code: '55P03' })).then(resolve, reject);
        // The locked re-read is by id: every invoice row the mock holds.
        rows = q.duesQuery ? mockState.dues : (q.byId ? [...mockState.invoices, ...mockState.dues] : mockState.invoices);
      }
      if (table === 'payment_methods') {
        if (q.nowait && mockState.methodsBusy) return Promise.reject(Object.assign(new Error('could not obtain lock on row'), { code: '55P03' })).then(resolve, reject);
        rows = mockState.methodRows;
      }
      if (table.startsWith('service_completion_attempts')) rows = mockState.inFlight ? [{ status: mockState.inFlight === 'pending' ? 'side_effects_pending' : 'side_effects_running' }] : [];
      if (table === 'payments') rows = mockState.armed ? [].concat(mockState.armed) : [];
      if (q.cap != null) rows = rows.slice(0, q.cap);
      return Promise.resolve(rows).then(resolve, reject);
    };
    q.update = async (patch) => {
      mockState.updates.push({ table, ...patch });
      if (table === 'customers') Object.assign(mockState.customer, patch);
      return 1;
    };
    return q;
  };
  const db = jest.fn((table) => build(table));
  db.raw = jest.fn((sql, args) => {
    if (Array.isArray(args) && String(args[0]).startsWith('customer-comms:')) mockState.log.push('comms');
    if (String(sql).includes('pg_try_advisory_xact_lock') && Array.isArray(args) && args[0] === 0x4150) {
      mockState.log.push('prepay');
      return { rows: [{ locked: !mockState.prepayBusy }] };
    }
    if (String(sql).includes('pg_try_advisory_xact_lock') && Array.isArray(args) && args[0] === 'payment-methods') {
      mockState.log.push('methods:advisory');
      return { rows: [{ locked: !mockState.methodsAdvisoryBusy }] };
    }
    return { __raw: true };
  });
  db.transaction = jest.fn(async (cb) => cb(db));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  getActivelyCoveredCustomerIds: jest.fn(async () => mockState.covered),
  getPaymentPendingCustomerIds: jest.fn(async () => mockState.pending),
}));
jest.mock('../services/autopay-eligibility', () => ({
  ...jest.requireActual('../services/autopay-eligibility'),
  getChargeableAutopayMethod: jest.fn(async () => { if (mockState.traceTender) mockState.log.push('tender:read'); return mockState.method; }),
  customerOnAutopay: jest.fn(async () => { if (mockState.autopayUnreadable) throw new Error('payment_methods read failed'); return mockState.chargeable; }),
}));
jest.mock('../utils/customer-billing-lock', () => ({
  withCustomerBillingLock: jest.fn(),
  tryClaimCustomerCollectionInTrx: jest.fn(async () => { mockState.log.push('claim'); return !mockState.claimHeld; }),
}));
// The sibling first-application invoice lookup completion asks (estimate-first-application-invoice.js).
jest.mock('../services/estimate-first-application-invoice', () => ({
  findFirstApplicationInvoiceForEstimateService: jest.fn(async (svc) => mockState.siblingInvoices[String(svc.id)] || { invoice: null, liveBeside: null, canceledSetupFee: null }),
}));
jest.mock('../services/recurring-series-topup', () => ({ eligibleSeriesParentIds: jest.fn(async () => mockState.seriesIds) }));
// The top-up's own billable-amount verdict (admin-schedule.js), with its own tests in recurring-series-topup.test.js.
jest.mock('../routes/admin-schedule', () => ({
  seriesNextOccurrencesUnbillable: jest.fn(async (conn, id) => (mockState.unbillableSeries.has(String(id))
    ? { code: 'RECURRING_WITHOUT_BILLABLE_AMOUNT' } : null)),
  seriesNextOccurrencesPrice: jest.fn(async (conn, id) => ({
    unverified: mockState.unverifiedRoots.has(String(id)),
    price: mockState.rootPrices[String(id)] || 0,
    // The real one needs the price/service scope gate on AND an exact $0 override.
    explicitZero: mockState.zeroRoots.has(String(id)) && require('../config/feature-gates').gates.editApptPriceServiceScope === true,
  })),
  // The top-up's own two skip rules, driven by state: mockState.topupSkips = { rootId: reason }.
  splitRootsByTopupSkip: jest.fn(async (conn, customerId, ids) => ({
    extend: ids.filter((id) => !mockState.topupSkips[String(id)]),
    skipped: ids.filter((id) => mockState.topupSkips[String(id)]).map((id) => ({ id, reason: mockState.topupSkips[String(id)] })),
  })),
}));
// The collections hold the cron's own charge guard reads (collections/collection-hold.js).
jest.mock('../services/collections/collection-hold', () => {
  const actual = jest.requireActual('../services/collections/collection-hold');
  return {
    ...actual,
    assertNoCollectionHold: jest.fn(async () => {
      if (mockState.holdActive) throw Object.assign(new Error('hold'), { code: 'COLLECTION_HOLD_ACTIVE' });
    }),
  };
});
jest.mock('../routes/admin-customers', () => ({ _private: { ANNUAL_PREPAY_LOCK_NS: 0x4150 } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockNotifyAdmin = jest.fn(async () => {});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockMembershipEmail = {
  sendMembershipStarted: jest.fn(), sendMembershipUpdated: jest.fn(), sendMembershipCanceled: jest.fn(), sendMembershipReactivated: jest.fn(),
};
jest.mock('../services/account-membership-email', () => mockMembershipEmail);

const BillingModeChange = require('../services/intelligence-bar/billing-mode-change');
const BillingModeRules = require('../services/billing-mode-rules');
const { executeTool } = require('../services/intelligence-bar/tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { executesWithoutCard, mayExecuteWithoutCard } = require('../services/intelligence-bar/owner-direct');

const CUSTOMER_ID = 'cust-1';
const BASE = {
  id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Sample', deleted_at: null,
  billing_mode: 'per_visit', per_application_fee: null, monthly_rate: '0.00',
  waveguard_tier: null, waveguard_tier_source: null,
  payer_id: null, autopay_enabled: true, autopay_paused_until: null,
};
const MONTHLY_ARMED = { id: 'pay-1', description: 'Gold WaveGuard Monthly — Pat Sample' };
const ONE_TIME_ARMED = { id: 'pay-2', description: 'Pest Control — Pat Sample' };
const UNPRICED = { id: 's1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2099-01-05' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_BILLING_MODE_EDIT = 'true';
  mockState.customer = { ...BASE };
  mockState.version = 'v1';
  mockState.term = null;
  mockState.armed = null;
  mockState.unpriced = [];
  mockState.visits = [];
  mockState.updates = [];
  mockState.cohortMiss = false;
  mockState.prepayBusy = false;
  mockState.roots = [];
  mockState.invoices = [];
  mockState.dues = [];
  mockState.unbillableSeries = new Set();
  mockState.siblingInvoices = {};
  mockState.orphan = null;
  mockState.ambiguous = null;
  mockState.inFlight = false;
  mockState.processing = null;
  mockState.processingInvoice = null;
  mockState.methodsBusy = false;
  mockState.methodsAdvisoryBusy = false;
  mockState.rootPrices = {};
  mockState.zeroRoots = new Set();
  mockState.topupSkips = {};
  mockState.unverifiedRoots = new Set();
  mockState.holdActive = false;
  mockState.traceTender = false;
  mockState.methodRows = [{ id: 'pm-1' }];
  mockState.invoiceBusy = false;
  mockState.autopayUnreadable = false;
  mockState.method = { id: 'pm-1', method_type: 'card' };
  mockState.methodDetail = { last_four: null, bank_last_four: null };
  mockState.taxRate = 0;
  jest.spyOn(require('../services/tax-calculator'), 'calculateTax').mockImplementation(async () => ({ rate: mockState.taxRate }));
  mockState.seriesIds = [];
  mockState.covered = new Set();
  mockState.pending = new Set();
  mockState.chargeable = true;
  mockState.claimHeld = false;
  mockState.log = [];
});
afterAll(() => { delete process.env.GATE_IB_BILLING_MODE_EDIT; });

// The card pin with the collection context the mocks produce (Auto Pay chargeable, gate off).
const pinFor = (row, visits, fields = {}) => BillingModeChange.cardPin(row, visits, fields, {
  autopayActive: mockState.chargeable,
  gate: false,
  family: mockState.chargeable ? (mockState.method.method_type === 'card' ? 'card' : 'bank') : null,
  last4: mockState.chargeable ? (mockState.methodDetail.last_four || mockState.methodDetail.bank_last_four || null) : null,
  methodId: mockState.chargeable ? mockState.method.id : null,
  stampedZero: false,
  savedMethods: mockState.methodRows.map((m) => m.id).join(','),
});
const propose = (updates) => BillingModeChange.billingEditProposal(CUSTOMER_ID, updates);
const customerWrites = () => mockState.updates.filter((u) => u.table === 'customers');

describe('proposal refusals mirror the customer page (billing-mode-rules.js)', () => {
  test('an unknown billing type is refused with the route message', async () => {
    expect(await propose({ billing_mode: 'weekly' })).toMatchObject({ error: BillingModeRules.INVALID_BILLING_MODE, code: 'invalid_billing_mode' });
  });

  test('monthly membership needs a monthly rate', async () => {
    const r = await propose({ billing_mode: 'monthly_membership' });
    expect(r.code).toBe('billing_mode_rule');
    expect(r.error).toContain(BillingModeRules.MONTHLY_NEEDS_RATE);
  });

  test('per application needs a fee: refused with none on file, allowed when the card sets one', async () => {
    const r = await propose({ billing_mode: 'per_application' });
    expect(r.error).toContain(BillingModeRules.PER_APPLICATION_NEEDS_FEE);
    const ok = await propose({ billing_mode: 'per_application', per_application_fee: 147 });
    expect(ok.error).toBeUndefined();
    expect(ok.pin).toBe(pinFor(BASE, []));
  });

  test('per visit and one time refuse while an upcoming visit has no price (route message)', async () => {
    mockState.customer = { ...BASE, billing_mode: 'per_application', per_application_fee: '91.00' };
    mockState.unpriced = [UNPRICED];
    const r = await propose({ billing_mode: 'per_visit' });
    expect(r.error).toContain("Per visit bills each visit's own price — 1 upcoming visit (first 2099-01-05) has no price");
    const t = await propose({ billing_mode: 'one_time' });
    expect(t.error).toContain("One-time bills each visit's own price");
  });

  test('the route itself returns the same messages for the same facts', async () => {
    const facts = (over) => ({ loadRates: async () => ({ monthly_rate: 0, per_application_fee: null }), loadLiveAnnualTerm: async () => null, loadUnpricedFutureVisits: async () => [UNPRICED], ...over });
    expect(await BillingModeRules.billingModeRefusal('weekly', facts())).toBe(BillingModeRules.INVALID_BILLING_MODE);
    expect(await BillingModeRules.billingModeRefusal('monthly_membership', facts())).toBe(BillingModeRules.MONTHLY_NEEDS_RATE);
    expect(await BillingModeRules.billingModeRefusal('monthly_membership', facts({ requestedMonthlyRate: '55' }))).toBeNull();
    expect(await BillingModeRules.billingModeRefusal('per_application', facts())).toBe(BillingModeRules.PER_APPLICATION_NEEDS_FEE);
    expect(await BillingModeRules.billingModeRefusal('per_application', facts({ requestedPerApplicationFee: 147 }))).toBeNull();
    expect(await BillingModeRules.billingModeRefusal('annual_prepay', facts())).toBe(BillingModeRules.ANNUAL_NEEDS_TERM);
    expect(await BillingModeRules.billingModeRefusal('per_visit', facts())).toMatch(/^Per visit bills/);
  });
});

describe('cases refused because the bar would have to reproduce another flow', () => {
  test('annual prepay as the new type, from annual prepay, or with a live term', async () => {
    expect((await propose({ billing_mode: 'annual_prepay' })).code).toBe('annual_prepay_lane');
    mockState.customer = { ...BASE, billing_mode: 'annual_prepay' };
    expect((await propose({ billing_mode: 'per_visit' })).code).toBe('annual_prepay_lane');
    mockState.customer = { ...BASE, billing_mode: 'per_application', per_application_fee: '91.00' };
    mockState.term = { id: 'term-1' };
    expect((await propose({ per_application_fee: 99 })).code).toBe('live_annual_prepay_term');
  });

  test('clearing the type to Not set', async () => {
    expect((await propose({ billing_mode: null })).code).toBe('billing_mode_clear');
    expect((await propose({ billing_mode: '' })).code).toBe('billing_mode_clear');
  });

  test('a change that makes the customer a member (the page sends the welcome email)', async () => {
    // An automatic tier label on a label-only lane is not a membership; moving
    // it to per application makes it one.
    mockState.customer = { ...BASE, waveguard_tier: 'Bronze', waveguard_tier_source: 'auto' };
    expect((await propose({ billing_mode: 'per_application', per_application_fee: 147 })).code).toBe('starts_membership');
  });

  test('billing fields mixed with other fields, a bad fee, and no change', async () => {
    expect((await propose({ billing_mode: 'per_application', per_application_fee: 147, notes: 'x' })).code).toBe('billing_edit_alone');
    for (const bad of [0, -5, 'abc', 147.555, null, '']) {
      expect((await propose({ per_application_fee: bad })).code).toBe('invalid_per_application_fee');
    }
    mockState.customer = { ...BASE, billing_mode: 'per_application', per_application_fee: '147.00' };
    expect((await propose({ billing_mode: 'per_application', per_application_fee: 147 })).code).toBe('no_change');
  });

  test('gate off: the proposal refuses', async () => {
    delete process.env.GATE_IB_BILLING_MODE_EDIT;
    expect((await propose({ billing_mode: 'per_application', per_application_fee: 147 })).code).toBe('gate_off');
  });
});

describe('refusals added in Codex round 1 on #6118', () => {
  test('a Bill-To payer on the customer or on an upcoming visit', async () => {
    mockState.customer = { ...BASE, payer_id: 7 };
    expect((await propose({ billing_mode: 'per_application', per_application_fee: 147 })).code).toBe('bill_to_payer');
    mockState.customer = { ...BASE };
    mockState.visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: null, payer_id: 9 }];
    const r = await propose({ per_application_fee: 147 });
    expect(r).toMatchObject({ code: 'bill_to_payer', error: expect.stringContaining('This customer has a Bill-To payer — change billing on the customer page') });
  });

  test('monthly membership with Auto Pay off or paused', async () => {
    mockState.customer = { ...BASE, monthly_rate: '55.00', autopay_enabled: false };
    const off = await propose({ billing_mode: 'monthly_membership' });
    expect(off).toMatchObject({ code: 'autopay_off', error: expect.stringContaining('Turn on Auto Pay first; the monthly dues run skips customers without it') });
    mockState.customer = { ...BASE, monthly_rate: '55.00', autopay_paused_until: '2099-12-31' };
    expect((await propose({ billing_mode: 'monthly_membership' })).code).toBe('autopay_off');
    mockState.customer = { ...BASE, monthly_rate: '55.00', autopay_paused_until: '2000-01-01' };
    expect((await propose({ billing_mode: 'monthly_membership' })).error).toBeUndefined();
  });

  test('leaving monthly membership while a failed payment retry is armed', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    mockState.armed = MONTHLY_ARMED;
    const r = await propose({ billing_mode: 'per_application', per_application_fee: 147 });
    expect(r).toMatchObject({ code: 'dues_retry_armed', error: expect.stringContaining('This customer has a dues retry scheduled — resolve it on the billing page first') });
    // Not leaving the monthly lane: no retry check.
    mockState.customer = { ...BASE, billing_mode: 'per_application', per_application_fee: '91.00' };
    expect((await propose({ per_application_fee: 147 })).error).toBeUndefined();
  });
});

describe('card text', () => {
  test('monthly member to per application at $147: type, fee, the rule, the saved card, dues stop, no message', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    mockState.methodDetail = { last_four: '4242', bank_last_four: null };
    mockState.visits = [
      { id: 'v1', estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control' },
      { id: 'v2', estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: true, service_type: 'Pest Control' },
    ];
    const proposal = await propose({ billing_mode: 'per_application', per_application_fee: 147 });
    expect(proposal.error).toBeUndefined();
    expect(proposal.display.billing_type).toEqual({ before: 'billed by monthly membership (dues each month)', after: 'billed per application (each visit)' });
    expect(proposal.display.fee).toEqual({ before: 'none on file', after: '$147.00' });
    const contract = buildContract({
      toolName: 'update_customer',
      params: { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application', per_application_fee: 147 } },
      displayParams: { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application', per_application_fee: 147 } },
      preview: { billing_change: proposal.display },
      summary: 'update_customer',
    });
    const labels = contract.effects.map((e) => e.label);
    expect(labels).toContain('Billing type: billed by monthly membership (dues each month) → billed per application (each visit)');
    expect(labels).toContain('Per-application fee: none on file → $147.00');
    expect(labels).toContain('Each performed application is charged the $147.00 per-application fee. A visit closed out as inspection only or customer declined performs none and bills nothing, and neither do callbacks and free visit types. No monthly dues charge. Sales tax is added where it applies.');
    expect(labels).toContain('Future charges under this type go to the saved card ending 4242.');
    expect(labels).toContain('Credit-card charges carry the configured card surcharge.');
    // No per-visit amount is projected.
    expect(labels.join(' ')).not.toMatch(/Priced visit|partly prepaid|remaining after/);
    expect(labels).toContain('Monthly dues stop: the monthly dues charge and any retry of a failed dues charge no longer run. Dues already paid for this month are not refunded.');
    expect(labels).toContain('No customer message is sent');
  });

  test('a fee-only edit on a customer not billed per application says the next visits do not change', async () => {
    const proposal = await propose({ per_application_fee: 99 });
    expect(proposal.display.billing_type).toBeUndefined();
    expect(proposal.display.next_visits).toEqual([
      "The fee is used only while the customer is billed per application. This customer stays billed per visit (each visit's own price), so their next visits are charged the same as today.",
    ]);
  });
});

describe('commit (update_customer executor)', () => {
  const card = () => ({
    customer_id: CUSTOMER_ID,
    updates: { billing_mode: 'per_application', per_application_fee: 147 },
    _ib_customer_version: 'v1',
    _ib_billing_pin: pinFor(BASE, []),
  });

  test('writes the two columns only, sends no message, reports the changes', async () => {
    const result = await executeTool('update_customer', card());
    expect(result.error).toBeUndefined();
    expect(customerWrites()).toHaveLength(1);
    const { table: _t, updated_at: _u, ...written } = customerWrites()[0];
    expect(written).toEqual({ billing_mode: 'per_application', per_application_fee: 147 });
    expect(result.changes).toEqual({
      billing_mode: { from: 'per_visit', to: 'per_application' },
      per_application_fee: { from: null, to: 147 },
    });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    for (const send of Object.values(mockMembershipEmail)) expect(send).not.toHaveBeenCalled();
  });

  test('billing fields changed since the card: preview_changed, nothing written', async () => {
    mockState.customer = { ...BASE, per_application_fee: '91.00' };
    const result = await executeTool('update_customer', card());
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/billing or upcoming visits changed since the card/);
    expect(customerWrites()).toHaveLength(0);
  });

  test('a rule that no longer holds at commit refuses (a live annual-prepay term appeared)', async () => {
    mockState.term = { id: 'term-1' };
    const result = await executeTool('update_customer', card());
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/annual prepay term covering today.*Nothing was updated/);
    expect(customerWrites()).toHaveLength(0);
  });

  test('an upcoming visit changed since the card (projection pin): preview_changed, nothing written', async () => {
    const pinned = card();
    mockState.visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: '90.00' }];
    const result = await executeTool('update_customer', pinned);
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/upcoming visits changed/);
    expect(customerWrites()).toHaveLength(0);
  });

  test('Auto Pay turned off after a monthly-membership card: preview_changed', async () => {
    mockState.customer = { ...BASE, monthly_rate: '55.00' };
    const pin = pinFor(mockState.customer, []);
    mockState.customer.autopay_enabled = false;
    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: { billing_mode: 'monthly_membership' }, _ib_customer_version: 'v1', _ib_billing_pin: pin,
    });
    expect(result.preview_changed).toBe(true);
    expect(customerWrites()).toHaveLength(0);
  });

  test('a retry armed after the card refuses under the lock', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    const pin = pinFor(mockState.customer, []);
    mockState.armed = MONTHLY_ARMED;
    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application', per_application_fee: 147 }, _ib_customer_version: 'v1', _ib_billing_pin: pin,
    });
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/dues retry scheduled.*Nothing was updated/);
    expect(customerWrites()).toHaveLength(0);
  });

  test('a mode-only card and a fee-only card each commit', async () => {
    mockState.customer = { ...BASE, per_application_fee: '91.00' };
    const pin = pinFor(mockState.customer, []);
    const modeOnly = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application' }, _ib_customer_version: 'v1', _ib_billing_pin: pin,
    });
    expect(modeOnly.error).toBeUndefined();
    expect(modeOnly.changes).toEqual({ billing_mode: { from: 'per_visit', to: 'per_application' } });
    const pin2 = pinFor(mockState.customer, []);
    const feeOnly = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: { per_application_fee: 147 }, _ib_customer_version: 'v1', _ib_billing_pin: pin2,
    });
    expect(feeOnly.error).toBeUndefined();
    expect(feeOnly.changes).toEqual({ per_application_fee: { from: '91.00', to: 147 } });
    expect(customerWrites().map(({ table: _t, updated_at: _u, ...w }) => w)).toEqual([
      { billing_mode: 'per_application' }, { per_application_fee: 147 },
    ]);
  });

  test('a customer version change refuses (the existing update_customer pin)', async () => {
    mockState.version = 'v2';
    const result = await executeTool('update_customer', card());
    expect(result.preview_changed).toBe(true);
    expect(customerWrites()).toHaveLength(0);
  });

  test('no pin on the card, or the gate turned off: refused, nothing written', async () => {
    const { _ib_billing_pin: _p, ...noPin } = card();
    expect((await executeTool('update_customer', noPin)).preview_changed).toBe(true);
    delete process.env.GATE_IB_BILLING_MODE_EDIT;
    const off = await executeTool('update_customer', card());
    expect(off.error).toMatch(/GATE_IB_BILLING_MODE_EDIT/);
    expect(customerWrites()).toHaveLength(0);
  });
});

describe('Codex round 3 on #6118: reuse the collectors\' own mechanisms', () => {
  const MONTHLY = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
  const LEAVE = { billing_mode: 'per_application', per_application_fee: 147 };
  const commit = (customer, updates, visits = []) => executeTool('update_customer', {
    customer_id: CUSTOMER_ID, updates, _ib_customer_version: 'v1', _ib_billing_pin: pinFor(customer, visits),
  });

  describe('only a monthly dues retry blocks leaving the monthly lane (retry-collectibility isMonthlyObligationRow)', () => {
    test('an armed one-time or per-application failed charge does not block, at the card or the commit', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.armed = ONE_TIME_ARMED;
      expect((await propose(LEAVE)).error).toBeUndefined();
      const result = await commit(MONTHLY, LEAVE);
      expect(result.error).toBeUndefined();
      expect(customerWrites()).toHaveLength(1);
    });

    test('an armed monthly dues retry still blocks (the sweep\'s own marker)', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.armed = [ONE_TIME_ARMED, MONTHLY_ARMED];
      expect((await propose(LEAVE)).code).toBe('dues_retry_armed');
    });
  });

  describe('the commit holds the billing-collection claim the collectors hold', () => {
    test('a collector mid-charge refuses the commit: preview_changed, nothing written', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.claimHeld = true;
      const result = await commit(MONTHLY, LEAVE);
      expect(result).toMatchObject({ preview_changed: true });
      expect(result.error).toMatch(/billing collection is running.*nothing was updated/i);
      expect(customerWrites()).toHaveLength(0);
      expect(require('../utils/customer-billing-lock').tryClaimCustomerCollectionInTrx)
        .toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID);
    });

    test('the claim is taken before the retry check and the visit reads, inside the update transaction', async () => {
      mockState.customer = { ...MONTHLY };
      await commit(MONTHLY, LEAVE);
      expect(mockState.log.slice(0, 6)).toEqual(['comms', 'prepay', 'customers:row', 'claim', 'visits:lock', 'visits:read']);
    });

    test('a retry armed after the card is caught under the claim', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.armed = MONTHLY_ARMED;
      const result = await commit(MONTHLY, LEAVE);
      expect(result.error).toMatch(/dues retry scheduled.*Nothing was updated/);
      expect(mockState.log.indexOf('claim')).toBeGreaterThan(mockState.log.indexOf('customers:row'));
    });

    test('a proposal takes no claim (read only)', async () => {
      mockState.customer = { ...MONTHLY };
      await propose(LEAVE);
      expect(mockState.log).not.toContain('claim');
    });
  });

  describe('upcoming visits are locked FOR UPDATE at commit (the Schedule save\'s row lock)', () => {
    test('locks first, then reads the projection; a visit edited after the card refuses', async () => {
      mockState.customer = { ...BASE };
      const pinned = pinFor(BASE, []);
      mockState.visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: '120.00', payer_id: null }];
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: pinned,
      });
      expect(result).toMatchObject({ preview_changed: true });
      expect(result.error).toMatch(/billing or upcoming visits changed since the card/);
      expect(mockState.log).toEqual(['comms', 'prepay', 'customers:row', 'claim', 'visits:lock', 'visits:read', 'methods:advisory', 'methods:lock']);
      expect(customerWrites()).toHaveLength(0);
    });

    test('an unchanged projection commits, and the proposal reads without locking', async () => {
      mockState.customer = { ...BASE };
      const visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: null, payer_id: null }];
      mockState.visits = visits;
      expect((await propose(LEAVE)).error).toBeUndefined();
      expect(mockState.log).toEqual(['visits:read']);
      mockState.log = [];
      const result = await commit(BASE, LEAVE, visits);
      expect(result.error).toBeUndefined();
      expect(mockState.log).toEqual(['comms', 'prepay', 'customers:row', 'claim', 'visits:lock', 'visits:read', 'methods:advisory', 'methods:lock']);
    });
  });

  describe('a move into monthly membership needs the dues run\'s full eligibility (monthly-dues-eligibility.js)', () => {
    const into = () => { mockState.customer = { ...BASE, monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' }; };
    const MOVE = { billing_mode: 'monthly_membership' };

    test('an inactive or service-paused customer (outside the cohort) is refused', async () => {
      into();
      mockState.cohortMiss = true;
      expect(await propose(MOVE)).toMatchObject({ code: 'dues_not_collectible', error: expect.stringContaining('inactive, no monthly rate, or service paused after failed payments') });
    });

    test('annual prepay covering today, or an unpaid annual prepay invoice, is refused', async () => {
      into();
      mockState.covered = new Set([CUSTOMER_ID]);
      expect(await propose(MOVE)).toMatchObject({ code: 'dues_not_collectible', error: expect.stringContaining('An annual prepay term covers today') });
      mockState.covered = new Set();
      mockState.pending = new Set([CUSTOMER_ID]);
      expect(await propose(MOVE)).toMatchObject({ code: 'dues_not_collectible', error: expect.stringContaining('annual prepay invoice is still unpaid') });
    });

    test('no chargeable saved method is refused, and an unreadable check fails closed', async () => {
      into();
      mockState.chargeable = false;
      expect(await propose(MOVE)).toMatchObject({ code: 'dues_not_collectible', error: expect.stringContaining('no saved payment method the monthly dues run can charge') });
      mockState.chargeable = true;
      require('../services/annual-prepay-renewals').getPaymentPendingCustomerIds.mockRejectedValueOnce(new Error('db down'));
      expect(await propose(MOVE)).toMatchObject({ code: 'dues_not_collectible', error: expect.stringContaining('Could not confirm') });
    });

    test('a fully collectible customer gets the card, with the dues line', async () => {
      into();
      const proposal = await propose(MOVE);
      expect(proposal.error).toBeUndefined();
      expect(proposal.display.next_visits[0]).toMatch(/\$55\.00 monthly rate is charged each month by the dues run/);
    });

    test('the same check runs again at the commit: collectible at the card, not at the commit', async () => {
      into();
      const pin = pinFor(mockState.customer, []);
      mockState.covered = new Set([CUSTOMER_ID]);
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: MOVE, _ib_customer_version: 'v1', _ib_billing_pin: pin,
      });
      expect(result).toMatchObject({ preview_changed: true });
      expect(result.error).toMatch(/An annual prepay term covers today.*Nothing was updated/);
      expect(customerWrites()).toHaveLength(0);
    });
  });

  describe('the dues line follows eligibility for a customer already on monthly membership', () => {
    const EDIT = { billing_mode: 'monthly_membership', per_application_fee: 99 };
    test('collectible: the card says the rate is charged by the dues run', async () => {
      mockState.customer = { ...MONTHLY };
      expect((await propose(EDIT)).display.next_visits[0]).toMatch(/is charged each month by the dues run/);
    });
    test('not collectible: the card says the dues run does NOT charge it, and why', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.chargeable = false;
      const line = (await propose(EDIT)).display.next_visits[0];
      expect(line).toMatch(/\$55\.00 monthly rate is NOT charged by the dues run right now\. This customer has no saved payment method/);
      expect(line).not.toMatch(/is charged each month by the dues run/);
    });
  });
});

describe('Codex round 4 on #6118', () => {
  const LEAVE = { billing_mode: 'per_application', per_application_fee: 147 };

  test('new visits are fenced out: the customer comms lock comes before the customer row lock, then the collection claim, then the visit locks', async () => {
    mockState.customer = { ...BASE };
    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: pinFor(BASE, [], LEAVE),
    });
    expect(result.error).toBeUndefined();
    expect(mockState.log).toEqual(['comms', 'prepay', 'customers:row', 'claim', 'visits:lock', 'visits:read', 'methods:advisory', 'methods:lock']);
    // A non-billing edit takes no comms lock here.
    mockState.log = [];
    await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: { city: 'Sample City' } });
    expect(mockState.log).not.toContain('comms');
  });

  test('an en_route or on_site visit with no price blocks per_visit like a pending one (the customer page rule)', async () => {
    const BillingModeRules = require('../services/billing-mode-rules');
    // The predicate is the lifecycle guard's: the query is built with its clause.
    const lifecycle = require('../services/customer-lifecycle-guard');
    const spy = jest.spyOn(lifecycle, 'whereVisitRowLive');
    mockState.customer = { ...BASE, billing_mode: 'per_application', per_application_fee: '91.00' };
    mockState.unpriced = [{ id: 's9', service_type: 'Pest Control', is_callback: false, scheduled_date: '2026-10-09', status: 'on_site' }];
    const r = await propose({ billing_mode: 'per_visit' });
    expect(r).toMatchObject({ code: 'billing_mode_rule', error: expect.stringContaining('has no price and would complete unbilled') });
    expect(spy).toHaveBeenCalled();
    spy.mockClear();
    await BillingModeRules.unpricedFutureBillableVisits(require('../models/db'), CUSTOMER_ID);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    // The card's own visit read (projection, payer check) uses it too.
    spy.mockClear();
    await propose({ per_application_fee: 99 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('the live-visit clause both queries use lists en_route and on_site (real SQL)', () => {
    const knex = jest.requireActual('knex')({ client: 'pg' });
    const sql = knex('scheduled_services').where(function live() {
      require('../services/customer-lifecycle-guard').whereVisitRowLive(this, '2026-10-10');
    }).toString();
    expect(sql).toContain("\"status\" = 'en_route'");
    expect(sql).toContain("\"status\" = 'on_site'");
    expect(sql).toContain("\"status\" = 'pending'");
  });

});

describe('Codex round 5 on #6118', () => {
  const MONTHLY = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
  const priced = { id: 'pv1', status: 'confirmed', scheduled_date: '2099-03-01', estimated_price: '120.00', prepaid_amount: null, is_callback: false, service_type: 'Pest Control', payer_id: null };
  const gateFlags = () => require('../config/feature-gates').gates;
  afterEach(() => { gateFlags().completionAutopayCharge = false; });

  test('an ongoing recurring plan with no live visit left and no price refuses per_visit / one_time (the top-up\'s own series selector)', async () => {
    mockState.customer = { ...MONTHLY };
    mockState.visits = [];
    mockState.seriesIds = ['root-1'];
    mockState.roots = [{ id: 'root-1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2026-09-01' }];
    mockState.unbillableSeries = new Set(['root-1']);
    for (const billing_mode of ['per_visit', 'one_time']) {
      expect(await propose({ billing_mode })).toMatchObject({
        code: 'billing_mode_rule',
        error: expect.stringMatching(/1 ongoing recurring plan has no price, so the next visits would complete unbilled/),
      });
    }
    expect(require('../services/recurring-series-topup').eligibleSeriesParentIds)
      .toHaveBeenCalledWith(expect.anything(), { customerId: CUSTOMER_ID });
    // A plan the top-up's verdict finds billable does not block.
    mockState.unbillableSeries = new Set();
    expect((await propose({ billing_mode: 'per_visit' })).error).toBeUndefined();
  });

  test('annual-prepay lock: taken as a try-lock after comms and before the customer row; a busy lock refuses and writes nothing', async () => {
    mockState.customer = { ...BASE };
    const updates = { billing_mode: 'per_application', per_application_fee: 147 };
    const body = { customer_id: CUSTOMER_ID, updates, _ib_customer_version: 'v1', _ib_billing_pin: pinFor(BASE, []) };
    mockState.prepayBusy = true;
    const busy = await executeTool('update_customer', body);
    expect(busy).toMatchObject({ preview_changed: true });
    expect(busy.error).toMatch(/annual prepay is being created or confirmed.*nothing was updated/i);
    expect(customerWrites()).toHaveLength(0);
    expect(mockState.log).toEqual(['comms', 'prepay']);
    mockState.prepayBusy = false;
    mockState.log = [];
    expect((await executeTool('update_customer', body)).error).toBeUndefined();
    expect(mockState.log.slice(0, 3)).toEqual(['comms', 'prepay', 'customers:row']);
  });

  test('the visit-card renderer stays under the complexity limit (data table, not branches)', () => {
    const { Linter } = require('eslint');
    const fs = require('fs');
    const code = fs.readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8');
    const messages = new Linter().verify(code, {
      languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
      rules: { complexity: ['error', 20] },
    }, 'billing-mode-change.js');
    expect(messages.map((m) => `${m.line}: ${m.message}`)).toEqual([]);
  });
});

describe('Codex round 6 on #6118: no cut on the visits the card and the pin cover', () => {
  const LEAVE = { billing_mode: 'per_application', per_application_fee: 147 };
  const MONTHLY = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
  const visit = (n, extra = {}) => ({ id: `w${String(n).padStart(5, '0')}`, status: 'confirmed', scheduled_date: '2099-04-01', estimated_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control', payer_id: null, ...extra });
  const many = (count, extraFor = () => ({})) => Array.from({ length: count }, (_, i) => visit(i + 1, extraFor(i + 1)));

  test('250 visits: the card counts all of them and the pin covers all of them', async () => {
    mockState.customer = { ...MONTHLY };
    const visits = many(250);
    mockState.visits = visits;
    const proposal = await propose(LEAVE);
    expect(proposal.error).toBeUndefined();
    expect(proposal.pin).toBe(pinFor(MONTHLY, visits, LEAVE));
    // A change to visit 250 (past any 200-row page) changes the pin: the commit refuses it.
    const edited = visits.map((v, i) => (i === 249 ? { ...v, scheduled_date: '2099-04-02' } : v));
    mockState.visits = edited;
    const stale = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: proposal.pin,
    });
    expect(stale).toMatchObject({ preview_changed: true });
    expect(customerWrites()).toHaveLength(0);
    // Unchanged, the commit passes with the same 250 locked and read.
    mockState.visits = visits;
    expect((await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: proposal.pin,
    })).error).toBeUndefined();
  });

  test('a Bill-To payer on visit 250 refuses the card and the commit', async () => {
    mockState.customer = { ...BASE };
    mockState.visits = many(250, (n) => (n === 250 ? { payer_id: 9 } : {}));
    expect(await propose(LEAVE)).toMatchObject({ code: 'bill_to_payer' });
    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: pinFor(BASE, mockState.visits, LEAVE),
    });
    expect(result).toMatchObject({ preview_changed: true });
    expect(customerWrites()).toHaveLength(0);
  });

  test('past the hard limit the card is refused, not shown in part', async () => {
    mockState.customer = { ...BASE };
    mockState.visits = many(2001);
    expect(await propose(LEAVE)).toMatchObject({
      code: 'too_many_visits',
      error: expect.stringContaining('too many upcoming visits to confirm from the bar; change it on the customer page'),
    });
    mockState.visits = many(2000);
    expect((await propose(LEAVE)).error).toBeUndefined();
  });
});

describe('Codex round 7 on #6118', () => {
  const MONTHLY = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
  const LEAVE = { billing_mode: 'per_application', per_application_fee: 147 };
  const gates = () => require('../config/feature-gates').gates;
  const root = (extra = {}) => ({ id: 'root-1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2026-09-01', estimated_price: null, prepaid_amount: null, ...extra });

  test('P1: an ongoing plan is judged by the top-up\'s own verdict for its next occurrences, under the lane being set', async () => {
    const { seriesNextOccurrencesUnbillable } = require('../routes/admin-schedule');
    mockState.customer = { ...MONTHLY };
    mockState.seriesIds = ['root-1'];
    mockState.roots = [root()];
    // The verdict (cadence-filtered add-ons and discounts per date) says billable: allowed.
    expect((await propose({ billing_mode: 'per_visit' })).error).toBeUndefined();
    // It says unbillable (a root priced only by an add-on that drops off the next date): refused.
    mockState.unbillableSeries = new Set(['root-1']);
    expect(await propose({ billing_mode: 'one_time' })).toMatchObject({ code: 'billing_mode_rule', error: expect.stringMatching(/ongoing recurring plan/) });
    // The verdict is asked with the billing fields the customer would have, not the ones it has.
    expect(seriesNextOccurrencesUnbillable).toHaveBeenLastCalledWith(
      expect.anything(), 'root-1', { customerOverride: expect.objectContaining({ billing_mode: 'one_time', monthly_rate: 55 }) },
    );
  });

  test('P2: an open membership-dues invoice is named instead of the flat promise, pinned, and a new one refuses the commit; none keeps the old line', async () => {
    mockState.customer = { ...MONTHLY };
    mockState.visits = [];
    const stop = async () => (await propose({ billing_mode: 'per_visit' })).display.next_visits;
    expect((await stop()).some((l) => l.startsWith('Monthly dues stop: the monthly dues charge and any retry of a failed dues charge no longer run.'))).toBe(true);
    const none = await propose({ billing_mode: 'per_visit' });
    mockState.dues = [{ id: 'dues-1', total: '55.00', status: 'sent', customer_id: CUSTOMER_ID, payer_id: null }, { id: 'dues-2', total: '55.00', status: 'overdue', customer_id: CUSTOMER_ID, payer_id: null }];
    const withDues = await propose({ billing_mode: 'per_visit' });
    const lines = withDues.display.next_visits.join(' ');
    expect(lines).toContain('2 open membership-dues invoices ($110.00) stay collectible: their pay links and follow-ups continue');
    expect(lines).not.toContain('any retry of a failed dues charge no longer run');
    expect(withDues.pin).not.toBe(none.pin);
    // A dues invoice that appeared after the card (the pin has none) refuses; with the matching pin it commits.
    const commit = (pin) => executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_visit' }, _ib_customer_version: 'v1', _ib_billing_pin: pin });
    expect(await commit(none.pin)).toMatchObject({ preview_changed: true });
    expect(customerWrites()).toHaveLength(0);
    mockState.customer = { ...MONTHLY };
    expect((await commit(withDues.pin)).error).toBeUndefined();
  });

  test('P2: an unreadable saved-method lookup fails closed in the proposal and at the confirmation; a readable one is unchanged', async () => {
    const { customerOnAutopay } = require('../services/autopay-eligibility');
    mockState.customer = { ...MONTHLY };
    mockState.visits = [{ id: 'iv1', status: 'confirmed', scheduled_date: '2099-05-01', estimated_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control', payer_id: null }];
    const card = await propose(LEAVE);
    expect(card.error).toBeUndefined();
    expect(customerOnAutopay).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ failClosed: true }));
    mockState.autopayUnreadable = true;
    expect(await propose(LEAVE)).toEqual({
      error: 'Could not verify Auto Pay eligibility. Try again in a moment. Nothing was changed.', code: 'billing_autopay_unverified',
    });
    const commit = () => executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin });
    const refused = await commit();
    expect(refused).toMatchObject({ preview_changed: true, error: 'Could not verify Auto Pay eligibility. Try again in a moment. Nothing was changed.' });
    expect(customerWrites()).toHaveLength(0);
    mockState.autopayUnreadable = false;
    expect((await commit()).error).toBeUndefined();
  });

  test('P2: the unpriced-visit check has no row cut: a billable visit behind 100+ exempt ones still refuses per_visit', async () => {
    mockState.customer = { ...MONTHLY };
    const exempt = Array.from({ length: 150 }, (_, i) => ({ id: `cb${i}`, service_type: 'Pest Control', is_callback: true, scheduled_date: `2099-01-${String((i % 28) + 1).padStart(2, '0')}` }));
    mockState.unpriced = [...exempt, { id: 'late', service_type: 'Pest Control', is_callback: false, scheduled_date: '2099-12-01' }];
    expect(await propose({ billing_mode: 'per_visit' })).toMatchObject({
      code: 'billing_mode_rule',
      error: expect.stringContaining('1 upcoming visit (first 2099-12-01) has no price'),
    });
    // All exempt: nothing blocks.
    mockState.unpriced = exempt;
    expect((await propose({ billing_mode: 'per_visit' })).error).toBeUndefined();
  });
});

describe('Codex round 11 on #6118: no per-visit charge is projected; a visit with billing keeps the change on the customer page', () => {
  const LEAVE = { billing_mode: 'per_application', per_application_fee: 147 };
  const MONTHLY = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
  const clean = (id = 'c1', extra = {}) => ({ id, status: 'confirmed', scheduled_date: '2099-09-01', estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control', payer_id: null, is_recurring: true, create_invoice_on_complete: false, source_estimate_id: null, ...extra });
  const gateFlags = () => require('../config/feature-gates').gates;
  const refusedWith = (count) => ({
    code: 'billing_visits_priced',
    error: `This customer has ${count === 1 ? '1 upcoming visit' : `${count} upcoming visits`} with a price, a prepayment or an invoice. The bar changes the billing type only when no upcoming visit carries one; change it on the customer page, which shows each visit's charge. Nothing was changed.`,
  });
  afterEach(() => { gateFlags().completionAutopayCharge = false; require('../config/feature-gates').gates.stampedZeroFree = false; });

  describe('each thing a visit can carry refuses, at the card and under the lock', () => {
    const TRIGGERS = {
      'a price': { estimated_price: '120.00' },
      'a price that a discount froze to $0 (base price on file)': { estimated_price: '0.00', primary_line_price: '120.00' },
      'a deliberate $0 stamp': { estimated_price: '0.00' },
      'a prepayment': { prepaid_amount: '20.00', prepaid_method: 'cash' },
      'create-invoice-on-complete': { create_invoice_on_complete: true },
      'a callback with a price': { is_callback: true, estimated_price: '40.00' },
    };
    test.each(Object.entries(TRIGGERS))('%s', async (name, extra) => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [clean('c1'), clean('t1', extra)];
      expect(await propose(LEAVE)).toEqual(refusedWith(1));
      // Under the lock the same rule runs on the locked rows, whatever pin the card had.
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: pinFor(MONTHLY, mockState.visits, LEAVE),
      });
      expect(result).toMatchObject({ preview_changed: true, error: expect.stringContaining('with a price, a prepayment or an invoice') });
      expect(customerWrites()).toHaveLength(0);
    });

    test('an invoice attached to a visit, of any state the completion query keeps (the pre-minted and the refunded alike)', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [clean('i1'), clean('i2'), clean('i3')];
      mockState.invoices = [
        { id: 'inv-1', scheduled_service_id: 'i1', total: '100.00', status: 'sent' },
        { id: 'inv-2', scheduled_service_id: 'i2', total: '100.00', status: 'refunded' },
      ];
      expect(await propose(LEAVE)).toEqual(refusedWith(2));
    });

    test('a sibling or combined first-application invoice of the same estimate (completion\'s own lookup)', async () => {
      const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');
      mockState.customer = { ...MONTHLY };
      mockState.visits = [clean('s1', { source_estimate_id: 'est-1' }), clean('s2', { source_estimate_id: 'est-1' }), clean('s3')];
      mockState.siblingInvoices = { s1: { invoice: { id: 'combined-1' }, liveBeside: null }, s2: { invoice: null, liveBeside: { id: 'beside-1' } } };
      expect(await propose(LEAVE)).toEqual(refusedWith(2));
      // Only a visit from an accepted estimate asks the lookup.
      expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledTimes(2);
      expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', customer_id: CUSTOMER_ID }), expect.anything(), {});
      // A canceled setup-fee row counts as well.
      mockState.siblingInvoices = { s1: { invoice: null, liveBeside: null, canceledSetupFee: { id: 'fee-1' } } };
      expect(await propose(LEAVE)).toEqual(refusedWith(1));
    });

    test('the count names every such visit, not only the first', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [clean('a', { estimated_price: '10.00' }), clean('b', { prepaid_amount: '5.00' }), clean('c'), clean('d', { create_invoice_on_complete: true })];
      expect(await propose(LEAVE)).toEqual(refusedWith(3));
    });
  });

  test('the clean case passes: unpriced, unprepaid, uninvoiced visits, a callback with no price, a $0 callback', async () => {
    mockState.customer = { ...MONTHLY };
    mockState.visits = [clean('c1'), clean('c2'), clean('cb1', { is_callback: true }), clean('cb2', { is_callback: true, estimated_price: '0.00' })];
    const card = await propose(LEAVE);
    expect(card.error).toBeUndefined();
    expect(card.pin).toBe(pinFor(MONTHLY, mockState.visits, LEAVE));
    expect(card.pin).toContain('|0|');
    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin,
    });
    expect(result.error).toBeUndefined();
    expect(customerWrites()).toHaveLength(1);
  });

  test('a visit priced after the card was shown refuses at the commit, whatever else is unchanged; nothing is written', async () => {
    mockState.customer = { ...MONTHLY };
    mockState.visits = [clean('c1'), clean('c2')];
    const card = await propose(LEAVE);
    expect(card.error).toBeUndefined();
    mockState.visits = [clean('c1'), clean('c2', { estimated_price: '120.00' })];
    const stale = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin,
    });
    expect(stale).toMatchObject({ preview_changed: true });
    expect(customerWrites()).toHaveLength(0);
    // The count is in the pin itself.
    expect(pinFor(MONTHLY, [clean('c1'), clean('c2', { estimated_price: '120.00' })], LEAVE)).toContain('|1|');
  });

  test('an attached invoice another transaction holds is never waited on under the customer row (NOWAIT): refuse', async () => {
    mockState.customer = { ...MONTHLY };
    mockState.visits = [clean('i1')];
    mockState.invoices = [{ id: 'inv-9', scheduled_service_id: 'i1', total: '120.00', status: 'sent' }];
    mockState.invoiceBusy = true;
    const busy = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: pinFor(MONTHLY, mockState.visits, LEAVE),
    });
    expect(busy).toMatchObject({ preview_changed: true, error: expect.stringMatching(/invoice on this customer is being changed right now/) });
    // Customers, claim, visits, then the invoices last (NOWAIT).
    expect(mockState.log).toEqual(['comms', 'prepay', 'customers:row', 'claim', 'visits:lock', 'visits:read', 'invoices:lock']);
    expect(customerWrites()).toHaveLength(0);
  });

  test('both gates the billing rules read are in the pin: GATE_STAMPED_ZERO_FREE and GATE_COMPLETION_AUTOPAY_CHARGE', async () => {
    mockState.customer = { ...MONTHLY };
    mockState.visits = [clean('c1')];
    const off = await propose(LEAVE);
    require('../config/feature-gates').gates.stampedZeroFree = true;
    // stampedZeroFreeLive() is the canonical call-time reader.
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    try {
      const stampedOn = await propose(LEAVE);
      expect(stampedOn.pin).not.toBe(off.pin);
      // A card shown with the gate off refuses once it is on.
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: off.pin }))
        .toMatchObject({ preview_changed: true });
    } finally { delete process.env.GATE_STAMPED_ZERO_FREE; }
    gateFlags().completionAutopayCharge = true;
    expect((await propose(LEAVE)).pin).not.toBe(off.pin);
    expect(customerWrites()).toHaveLength(0);
  });

  describe('the saved-method line states the tender family and no amount', () => {
    const lines = async (updates = LEAVE) => (await propose(updates)).display.next_visits;

    test('a card: ending digits, and the surcharge sentence', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.methodDetail = { last_four: '4242', bank_last_four: null };
      const l = await lines();
      expect(l).toContain('Future charges under this type go to the saved card ending 4242.');
      expect(l).toContain('Credit-card charges carry the configured card surcharge.');
      expect(l.join(' ')).not.toMatch(/\$(?!147\.00)\d/);
    });

    test('an ACH bank account: debit wording, no surcharge sentence; the family and last four are pinned and a switch refuses', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.methodDetail = { last_four: '4242', bank_last_four: null };
      const card = await propose(LEAVE);
      mockState.method = { id: 'pm-2', method_type: 'us_bank_account' };
      mockState.methodDetail = { last_four: null, bank_last_four: '6789' };
      const bank = await propose(LEAVE);
      expect(bank.display.next_visits).toContain('Future charges under this type go to the saved bank account ending 6789 (ACH).');
      expect(bank.display.next_visits.join(' ')).not.toMatch(/surcharge|saved card/);
      expect(bank.pin).toContain('["bank","6789","pm-2","pm-1"]');
      expect(card.pin).toContain('["card","4242","pm-1","pm-1"]');
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
      mockState.customer = { ...MONTHLY };
      expect((await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: bank.pin })).error).toBeUndefined();
    });

    test('per visit goes to the saved method only with GATE_COMPLETION_AUTOPAY_CHARGE; otherwise charges are invoiced', async () => {
      mockState.customer = { ...MONTHLY };
      expect(await lines({ billing_mode: 'per_visit' })).toContain('Future charges under this type are invoiced.');
      gateFlags().completionAutopayCharge = true;
      expect(await lines({ billing_mode: 'per_visit' })).toContain('Future charges under this type go to the saved card.');
      mockState.chargeable = false;
      expect(await lines({ billing_mode: 'per_visit' })).toContain('Future charges under this type are invoiced.');
    });

    test('moving into monthly: the upcoming unpriced visits are exactly "covered by dues"', async () => {
      mockState.customer = { ...BASE, billing_mode: 'per_visit', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
      mockState.visits = [clean('m1'), clean('m2'), clean('m3')];
      const l = await lines({ billing_mode: 'monthly_membership' });
      expect(l[0]).toBe('The $55.00 monthly rate is charged each month by the dues run. 3 upcoming visits have no price today and are covered by dues.');
      mockState.visits = [clean('m1')];
      expect((await lines({ billing_mode: 'monthly_membership' }))[0]).toMatch(/1 upcoming visit has no price today and is covered by dues\.$/);
    });
  });

  describe('a completion that committed its record but has not finished billing fences the edit (completion-attempts.js customerHasCompletionInFlight)', () => {
    const MESSAGE = 'A completed visit for this customer still has billing in progress. Wait for it to finish, or release it, then try again.';

    test('an unpriced monthly visit completing while the edit switches to per application: the card is refused, never a silent no-bill', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      mockState.inFlight = true;
      expect(await propose(LEAVE)).toMatchObject({ code: 'billing_completion_pending', error: expect.stringContaining(MESSAGE) });
    });

    test('a card shown before the completion committed refuses under the lock once it has; nothing is written', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      const card = await propose(LEAVE);
      expect(card.error).toBeUndefined();
      // persistRecord committed the visit as completed (gone from the upcoming list) and the attempt as side_effects_running.
      mockState.inFlight = true;
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin,
      });
      expect(result).toMatchObject({ preview_changed: true, error: expect.stringContaining(MESSAGE) });
      expect(customerWrites()).toHaveLength(0);
      // Settled (the attempt succeeded): the same card commits.
      mockState.inFlight = false;
      mockState.customer = { ...MONTHLY };
      expect((await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin,
      })).error).toBeUndefined();
    });

    describe('Codex round 17: both unfinished states fence at any age', () => {
      // A tiny in-memory knex that EVALUATES the where clauses the fence builds: a flat list of
      // terms joined by AND / OR, a function argument being a nested group.
      const fakeKnex = (rows) => {
        const leaf = (col, op, val) => (r) => {
          const x = r[col.replace('a.', '')];
          return val === undefined ? x === op : (op === '>=' ? x >= val : x === val);
        };
        const makeBuilder = (terms) => {
          const b = {};
          const add = (conn, c, o, v) => {
            if (typeof c === 'function') {
              const inner = [];
              c.call(makeBuilder(inner));
              terms.push({ conn, f: (r) => inner.reduce((acc, t, i) => (i === 0 ? t.f(r) : (t.conn === 'or' ? acc || t.f(r) : acc && t.f(r))), true) });
            } else if (!String(c).startsWith('s.')) terms.push({ conn, f: leaf(c, o, v) });
            return b;
          };
          b.join = () => b;
          b.where = (c, o, v) => add('and', c, o, v);
          b.whereIn = (c, vals) => { terms.push({ conn: 'and', f: (r) => vals.includes(r[c.replace('a.', '')]) }); return b; };
          b.orWhere = (c, o, v) => add('or', c, o, v);
          b.select = async () => rows.filter((r) => terms.reduce((acc, t, i) => (i === 0 ? t.f(r) : (t.conn === 'or' ? acc || t.f(r) : acc && t.f(r))), true));
          return b;
        };
        const root = makeBuilder([]);
        return jest.fn(() => root);
      };
      const HOURS = (n) => new Date(Date.now() - n * 3600 * 1000);
      const state = async (rows) => require('../services/completion-attempts').customerCompletionInFlightState('cust-9', fakeKnex(rows));

      test('a 2-hour-old pending row fences; a 2-hour-old running row fences too; a fresh running row fences; none does not', async () => {
        expect(await state([{ status: 'side_effects_pending', updated_at: HOURS(2) }])).toBe('pending');
        expect(await state([{ status: 'side_effects_running', updated_at: HOURS(2) }])).toBe('running');
        expect(await state([{ status: 'side_effects_running', updated_at: HOURS(48) }])).toBe('running');
        expect(await state([{ status: 'side_effects_running', updated_at: HOURS(0.01) }])).toBe('running');
        expect(await state([{ status: 'side_effects_running', updated_at: HOURS(2) }, { status: 'side_effects_pending', updated_at: HOURS(3) }])).toBe('pending');
        expect(await state([])).toBe(null);
      });

      test('the boolean reader is the same answer', async () => {
        const { customerHasCompletionInFlight } = require('../services/completion-attempts');
        expect(await customerHasCompletionInFlight('cust-9', fakeKnex([{ status: 'side_effects_pending', updated_at: HOURS(2) }]))).toBe(true);
        expect(await customerHasCompletionInFlight('cust-9', fakeKnex([{ status: 'side_effects_running', updated_at: HOURS(2) }]))).toBe(true);
        expect(await customerHasCompletionInFlight('cust-9', fakeKnex([]))).toBe(false);
      });

      test('the card words the pending case as a retry that is still owed', async () => {
        mockState.customer = { ...MONTHLY };
        mockState.inFlight = 'pending';
        expect(await propose(LEAVE)).toMatchObject({
          code: 'billing_completion_pending',
          error: 'A completed visit for this customer still has billing to finish (retry pending). Finish or release it first. Nothing was proposed.',
        });
        mockState.inFlight = true;
        expect(await propose(LEAVE)).toMatchObject({ code: 'billing_completion_pending', error: 'A completed visit for this customer still has billing in progress. Wait for it to finish, or release it, then try again. Nothing was proposed.' });
      });
    });
  });

  describe('Codex round 17: ambiguity in the prior month, performed applications, draft dues', () => {
    const ET = require('../utils/datetime-et');
    const [yy, mm] = ET.etDateString().split('-').map(Number);
    const prior = mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, '0')}`;
    const monthName = (key) => new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    test('a dues attempt parked as ambiguous in the PRIOR month refuses, naming that month; this month still does', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.ambiguous = { id: 'pay-amb', month: prior };
      expect(await propose(LEAVE)).toMatchObject({
        code: 'dues_outcome_unresolved',
        error: `A dues charge for ${monthName(prior)} is still being reconciled with Stripe; try again after it settles. Nothing was proposed.`,
      });
      mockState.ambiguous = { id: 'pay-amb', month: ET.etDateString().slice(0, 7) };
      expect(await propose(LEAVE)).toMatchObject({ code: 'dues_outcome_unresolved' });
      mockState.ambiguous = { id: 'pay-amb', month: '2001-01' };
      expect((await propose(LEAVE)).error).toBeUndefined();
    });

    test('the per-application line says performed applications and discloses the non-performed outcomes from the completion route\'s own list', async () => {
      mockState.customer = { ...BASE };
      const lines = (await propose({ billing_mode: 'per_application', per_application_fee: 147 })).display.next_visits.join(' ');
      expect(lines).toContain('Each performed application is charged the $147.00 per-application fee.');
      expect(lines).toContain('A visit closed out as inspection only or customer declined performs none and bills nothing');
      expect(lines).not.toContain('Each completed visit');
    });

    test('source contract: one list of non-performed outcomes, read by the completion route and the card; the card retypes none', () => {
      const fs = require('fs');
      const { NON_PERFORMED_VISIT_OUTCOMES, visitWasPerformed } = require('../services/visit-outcomes');
      expect(NON_PERFORMED_VISIT_OUTCOMES).toEqual(['inspection_only', 'customer_declined']);
      expect(visitWasPerformed('completed')).toBe(true);
      expect(visitWasPerformed('inspection_only')).toBe(false);
      expect(visitWasPerformed('customer_declined')).toBe(false);
      const route = fs.readFileSync(require.resolve('../services/complete-scheduled-service.js'), 'utf8');
      expect(route).toContain("const visitPerformed = require('./visit-outcomes').visitWasPerformed(visitOutcome);");
      const card = fs.readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8');
      expect(card).toContain("require('../visit-outcomes')");
      expect(card).not.toMatch(/'inspection_only'|'customer_declined'/);
    });

    test('a stamped dues invoice still in draft refuses a departure, naming its month; a sent one passes; a draft that appears after the card refuses', async () => {
      const month = ET.etDateString().slice(0, 7);
      const dues = (status) => [{ id: 'dues-1', total: '55.00', status, customer_id: CUSTOMER_ID, payer_id: null, line_items: [{ membership_dues_month: month }] }];
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      mockState.dues = dues('draft');
      expect(await propose({ billing_mode: 'per_visit' })).toMatchObject({
        code: 'billing_dues_draft',
        error: `A dues invoice for ${monthName(month)} is still a draft. Send it or void it first. Nothing was proposed.`,
      });
      mockState.dues = dues('sent');
      const card = await propose({ billing_mode: 'per_visit' });
      expect(card.error).toBeUndefined();
      // The draft appears after the card: the pin differs, so the commit refuses and writes nothing.
      mockState.dues = dues('draft');
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_visit' }, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });
  });

  describe('Codex round 13: dues still processing by bank debit', () => {
    const thisMonth = require('../utils/datetime-et').etDateString().slice(0, 7);
    const PROCESSING = { id: 'pay-proc', amount: '55.00', status: 'processing', description: 'Gold WaveGuard Monthly — Pat Sample' };
    const label = new Date(`${thisMonth}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    test('Codex round 15: leaving monthly while a dues debit is processing is refused whatever the visits (a failed debit would lose its retry); no disclose path', async () => {
      const refusal = {
        code: 'billing_dues_processing',
        error: `The ${label} dues ($55.00) are still processing by bank debit. If the debit fails, this change would cancel its retry, so wait until it settles. Nothing was proposed.`,
      };
      mockState.customer = { ...MONTHLY };
      mockState.processing = PROCESSING;
      mockState.visits = [clean('p1', { scheduled_date: `${thisMonth}-28` })];
      expect(await propose(LEAVE)).toMatchObject(refusal);
      // Visits only in the future, or none: still refused (before: a disclosure line).
      mockState.visits = [clean('p1', { scheduled_date: '2099-01-05' })];
      expect(await propose(LEAVE)).toMatchObject(refusal);
      mockState.visits = [];
      expect(await propose({ billing_mode: 'per_visit' })).toMatchObject(refusal);
    });

    test('a debit that appears between the card and Confirm refuses at commit (the payment is pinned)', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      const card = await propose(LEAVE);
      expect(card.error).toBeUndefined();
      mockState.processing = PROCESSING;
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
      mockState.processing = null;
      mockState.customer = { ...MONTHLY };
      expect((await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin })).error).toBeUndefined();
    });

    test('Codex round 18: a stamped dues INVOICE paid by ACH and still processing refuses, naming the invoice and month; the pin carries it', async () => {
      const month = thisMonth;
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      mockState.processingInvoice = { id: 'inv-9', status: 'processing', invoice_number: 'INV-0009', month };
      expect(await propose(LEAVE)).toMatchObject({
        code: 'billing_dues_processing',
        error: `The ${label} dues invoice INV-0009 is still processing by bank debit. If the debit fails, this change would cancel its retry, so wait until it settles. Nothing was proposed.`,
      });
      // Seen through the commit's facts too (the pin): an invoice that starts processing after the card refuses.
      mockState.processingInvoice = null;
      const card = await propose(LEAVE);
      expect(card.error).toBeUndefined();
      mockState.processingInvoice = { id: 'inv-9', status: 'processing', invoice_number: 'INV-0009', month };
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });

    test('the invoice shape is asked through the cron\'s lookup (findLiveStampedDuesInvoice), narrowed to processing; a plain processing payment still refuses', async () => {
      const lane = require('fs').readFileSync(require.resolve('../services/billing-lane.js'), 'utf8');
      expect(lane).toContain("processingOnly ? ['processing'] : ['paid', 'prepaid', 'processing']");
      const card = require('fs').readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8');
      expect(card).toContain("findLiveStampedDuesInvoice(dbh, customerId, period.monthKey, { openInvoiceCovers: false, processingOnly: true })");
      mockState.customer = { ...MONTHLY };
      mockState.processing = PROCESSING;
      expect(await propose(LEAVE)).toMatchObject({ code: 'billing_dues_processing', error: expect.stringContaining('dues ($55.00) are still processing') });
    });

    test('a customer who is not leaving monthly is not asked about processing dues', async () => {
      mockState.customer = { ...BASE };
      mockState.processing = PROCESSING;
      expect((await propose(LEAVE)).error).toBeUndefined();
    });

    test('the "will settle" disclosure is gone', () => {
      const card = require('fs').readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8');
      expect(card).not.toMatch(/processingLine|bank debit and will settle/);
    });

    test('the cron\'s own already-collected predicate is asked, narrowed to processing and without the invoice fallback', async () => {
      const calls = [];
      const q = { where: (...a) => { calls.push(['where', ...a]); return q; }, whereIn: (...a) => { calls.push(['whereIn', ...a]); return q; }, first: async () => null };
      const { findCollectedMonthlyPayment } = require('../services/retry-collectibility');
      const conn = jest.fn(() => q);
      expect(await findCollectedMonthlyPayment('c1', { monthKey: '2026-10', monthStart: '2026-10-01', monthEnd: '2026-10-31' }, { conn, statuses: ['processing'], withDuesInvoice: false })).toBeFalsy();
      expect(calls).toContainEqual(['whereIn', 'status', ['processing']]);
      expect(conn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Codex round 13: the saved payment methods are locked before the final tender read', () => {
    test('FOR UPDATE NOWAIT on the customer\'s method rows, taken after the visits and invoices and before the tender is read', async () => {
      mockState.customer = { ...MONTHLY };
      const card = await propose(LEAVE);
      mockState.log = [];
      mockState.traceTender = true;
      expect((await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin })).error).toBeUndefined();
      expect(mockState.log).toEqual(['comms', 'prepay', 'customers:row', 'claim', 'visits:lock', 'visits:read', 'methods:advisory', 'methods:lock', 'tender:read']);
    });

    test('a method row another writer holds is never waited on under the customer row: refuse, nothing written', async () => {
      mockState.customer = { ...MONTHLY };
      const card = await propose(LEAVE);
      mockState.methodsBusy = true;
      const busy = await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin });
      expect(busy).toMatchObject({ preview_changed: true, error: expect.stringMatching(/saved payment method for this customer is being changed right now/) });
      expect(customerWrites()).toHaveLength(0);
    });

    test('a method updated or INSERTED after the card (before the lock) changes the pin and refuses; the id list is pinned', async () => {
      mockState.customer = { ...MONTHLY };
      const card = await propose(LEAVE);
      expect(card.pin).toContain('["card","","pm-1","pm-1"]');
      // A new default bank method inserted after the card: the id list and the chargeable one change.
      mockState.methodRows = [{ id: 'pm-1' }, { id: 'pm-2' }];
      mockState.method = { id: 'pm-2', method_type: 'us_bank_account' };
      mockState.methodDetail = { last_four: null, bank_last_four: '6789' };
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      // An extra method that does not change the chargeable one still changes the pin (a count change refuses).
      mockState.method = { id: 'pm-1', method_type: 'card' };
      mockState.methodDetail = { last_four: null, bank_last_four: null };
      mockState.customer = { ...MONTHLY };
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });
  });

  describe('Codex round 15: open dues invoices show the collectible amount', () => {
    test('$49 invoice with $20 applied credit shows $29; the credit is pinned, and one applied after the card refuses', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      mockState.dues = [{ id: 'dues-1', total: '49.00', credit_applied: '20.00', status: 'sent', customer_id: CUSTOMER_ID, payer_id: null }];
      const card = await propose({ billing_mode: 'per_visit' });
      const lines = card.display.next_visits.join(' ');
      expect(lines).toContain('1 open membership-dues invoice ($29.00) stays collectible');
      expect(lines).not.toContain('$49.00');
      expect(card.pin).toContain('["dues-1","49.00","sent","20.00"]');
      // More credit applied after the card: the pin differs, so the commit refuses.
      mockState.dues = [{ ...mockState.dues[0], credit_applied: '49.00' }];
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_visit' }, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });

    test('source contract: the amount is invoice-helpers invoiceAmountDue, the charge base every collection path uses', () => {
      const lane = require('fs').readFileSync(require.resolve('../services/billing-lane.js'), 'utf8');
      const fn = lane.slice(lane.indexOf('async function openStampedDuesInvoices'), lane.indexOf('// Reasons a no_charge prediction'));
      expect(fn).toContain("require('./invoice-helpers')");
      expect(fn).toContain('invoiceAmountDue(');
      expect(fn).toContain("'credit_applied'");
    });
  });

  describe('Codex round 19: roots the top-up skips, and an explicit $0 override', () => {
    const ROOT = { id: 'root-1', service_type: 'Pest Control', payer_id: null };
    const PER_APP = { billing_mode: 'per_application', per_application_fee: 147 };
    const setup = () => {
      mockState.customer = { ...BASE };
      mockState.visits = [];
      mockState.seriesIds = ['root-1'];
      mockState.roots = [ROOT];
      mockState.rootPrices = { 'root-1': 500 };
    };

    test('a root the top-up skips (churned customer, annual prepay) does not refuse and is listed as not extended; an active priced root still refuses', async () => {
      setup();
      expect(await propose(PER_APP)).toMatchObject({ code: 'billing_visits_priced' });
      mockState.topupSkips = { 'root-1': 'customer_churned' };
      const churned = await propose(PER_APP);
      expect(churned.error).toBeUndefined();
      expect(churned.display.next_visits).toContain('Not extended: the Pest Control plan (customer churned); the nightly top-up adds no visits to it, so this change does not reach it.');
      mockState.topupSkips = { 'root-1': 'annual_prepay_series' };
      const prepay = await propose(PER_APP);
      expect(prepay.error).toBeUndefined();
      expect(prepay.display.next_visits.join(' ')).toContain('annual prepay series');
      // The skip state is pinned: a root that becomes extendable after the card refuses at commit.
      mockState.topupSkips = {};
      expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: PER_APP, _ib_customer_version: 'v1', _ib_billing_pin: prepay.pin }))
        .toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });

    test('a skipped root does not carry a payer refusal either', async () => {
      setup();
      mockState.rootPrices = {};
      mockState.roots = [{ ...ROOT, payer_id: 7 }];
      expect(await propose(PER_APP)).toMatchObject({ code: 'billing_visits_payer_owned' });
      mockState.topupSkips = { 'root-1': 'plan_hold' };
      expect((await propose(PER_APP)).error).toBeUndefined();
    });

    test('source contract: the split runs the top-up\'s own two skip predicates, and both callers use it', () => {
      const fs = require('fs');
      const route = fs.readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
      const split = route.slice(route.indexOf('async function splitRootsByTopupSkip'), route.indexOf('// Reads a pg_try_advisory_xact_lock'));
      expect(split).toContain('topupCustomerSkipReason(customer)');
      expect(split).toContain('topupSeriesSkipReason(conn, parent, id, cols)');
      expect(split).toContain('SERIES_CUSTOMER_COLUMNS');
      // And those are the very calls the nightly writer makes.
      const topUp = route.slice(route.indexOf('async function topUpRecurringSeriesLocked'));
      expect(topUp).toContain('topupCustomerSkipReason(customer)');
      expect(topUp).toContain('topupSeriesSkipReason(conn, parent, parentId, cols)');
      expect(fs.readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8')).toContain('splitRootsByTopupSkip(');
      expect(fs.readFileSync(require.resolve('../services/billing-mode-rules.js'), 'utf8')).toContain('splitRootsByTopupSkip(');
    });

    describe('explicit $0 override', () => {
      const FG = require('../config/feature-gates');
      let before;
      beforeEach(() => { before = FG.gates.editApptPriceServiceScope; });
      afterEach(() => { FG.gates.editApptPriceServiceScope = before; });

      test('an explicit zero refuses a billing edit; an unpriced root passes', async () => {
        setup();
        mockState.rootPrices = {};
        FG.gates.editApptPriceServiceScope = true;
        mockState.zeroRoots = new Set(['root-1']);
        expect(await propose(PER_APP)).toMatchObject({
          code: 'billing_visits_priced',
          error: expect.stringContaining('ongoing Pest Control plan has a $0.00 price override on each visit it adds; it would bill nothing'),
        });
        mockState.zeroRoots = new Set();
        expect((await propose(PER_APP)).error).toBeUndefined();
      });

      test('the scope gate is pinned: a flip after the card refuses at commit', async () => {
        setup();
        mockState.rootPrices = {};
        mockState.zeroRoots = new Set(['root-1']);
        FG.gates.editApptPriceServiceScope = false;
        const card = await propose(PER_APP);
        expect(card.error).toBeUndefined();
        FG.gates.editApptPriceServiceScope = true;
        expect(await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: PER_APP, _ib_customer_version: 'v1', _ib_billing_pin: card.pin }))
          .toMatchObject({ preview_changed: true });
        expect(customerWrites()).toHaveLength(0);
      });

      test('source contract: the zero comes from the top-up\'s own condition (gate + exact $0 override), kept apart from unpriced', () => {
        const route = require('fs').readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
        const fn = route.slice(route.indexOf('async function seriesNextOccurrencesPrice'), route.indexOf('// GET /api/admin/schedule'));
        expect(fn).toContain("isEnabled('editApptPriceServiceScope')");
        expect(fn).toContain('parseTemplateOverrides(parent.recurring_template_overrides)?.estimated_price === 0');
        expect(fn).toContain('explicitZero');
      });
    });
  });

  describe('Codex round 14: an ongoing root whose template carries a price', () => {
    const ROOT = { id: 'root-1', service_type: 'Pest Control', payer_id: null };
    const PER_APP = { billing_mode: 'per_application', per_application_fee: 147 };

    test('no live visit but the top-up would copy a positive price onto the next one: refused, naming the series and the price', async () => {
      mockState.customer = { ...BASE };
      mockState.visits = [];
      mockState.seriesIds = ['root-1'];
      mockState.roots = [ROOT];
      mockState.rootPrices = { 'root-1': 500 };
      expect(await propose(PER_APP)).toMatchObject({
        code: 'billing_visits_priced',
        error: expect.stringContaining("ongoing Pest Control plan has a price of $500.00 on each visit it adds"),
      });
    });

    test('an unpriced root passes and its price is pinned; a price added after the card refuses at commit', async () => {
      mockState.customer = { ...BASE };
      mockState.visits = [];
      mockState.seriesIds = ['root-1'];
      mockState.roots = [ROOT];
      const card = await propose(PER_APP);
      expect(card.error).toBeUndefined();
      expect(card.pin).toContain('["root-1",null,"0","verified","",""]');
      mockState.rootPrices = { 'root-1': 500 };
      const stale = await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: PER_APP, _ib_customer_version: 'v1', _ib_billing_pin: card.pin });
      expect(stale).toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });

    test('a series whose price cannot be verified is refused, never passed', async () => {
      mockState.customer = { ...BASE };
      mockState.seriesIds = ['root-1'];
      mockState.roots = [ROOT];
      mockState.unverifiedRoots = new Set(['root-1']);
      expect(await propose(PER_APP)).toMatchObject({ code: 'billing_visits_priced', error: expect.stringContaining('a schedule too long to check') });
    });

    test('source contract: the price is the top-up\'s own resolver (template + due add-ons), shared with the unbillable verdict', () => {
      const fs = require('fs');
      const route = fs.readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
      const card = fs.readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8');
      const datePrices = route.slice(route.indexOf('async function seriesExtensionDatePrices'), route.indexOf('// The SAME billable-amount verdict for every OFFICE writer'));
      expect(datePrices).toContain('resolveSeriesExtensionPriceTemplate(conn, parent.id, parent)');
      expect(datePrices).toContain('storedOccurrenceFloorPrice(');
      // Both verdicts read the one function; neither re-derives a price.
      const unbillable = route.slice(route.indexOf('async function seriesExtensionUnbillable'), route.indexOf('const SERIES_VERDICT_MAX_ATTEMPTS'));
      expect(unbillable).toContain('seriesExtensionDatePrices(');
      const priceFn = route.slice(route.indexOf('async function seriesNextOccurrencesPrice'), route.indexOf('// GET /api/admin/schedule'));
      expect(priceFn).toContain('seriesVerdictWalk(conn, parentId)');
      expect(priceFn).toContain('seriesExtensionDatePrices(');
      expect(priceFn).not.toMatch(/calculateStoredVisitFinancials|storedOccurrenceFloorPrice/);
      expect(card).toContain('seriesNextOccurrencesPrice');
      expect(card).not.toMatch(/storedOccurrenceFloorPrice|calculateStoredVisitFinancials|resolveSeriesExtensionPriceTemplate/);
    });
  });

  describe('Codex round 14: a collections hold reads as not eligible for monthly dues', () => {
    test('a move INTO monthly for a customer with an active hold: refused as billing_collection_hold', async () => {
      mockState.customer = { ...BASE, monthly_rate: 55, autopay_enabled: true };
      mockState.holdActive = true;
      expect(await propose({ billing_mode: 'monthly_membership' })).toMatchObject({
        code: 'billing_collection_hold',
        error: expect.stringContaining('billing dispute hold'),
      });
      mockState.holdActive = false;
      expect((await propose({ billing_mode: 'monthly_membership' })).error).toBeUndefined();
    });

    test('the verdict asks the cron\'s own predicate and guard, not a parallel definition', async () => {
      const { monthlyDuesVerdict } = require('../services/monthly-dues-eligibility');
      const hold = require('../services/collections/collection-hold');
      mockState.customer = { ...BASE, monthly_rate: 55, autopay_enabled: true };
      mockState.holdActive = true;
      expect(await monthlyDuesVerdict(require('../models/db'), CUSTOMER_ID, { overrides: { billing_mode: 'monthly_membership' } })).toMatchObject({ eligible: false, reason: 'collection_hold' });
      expect(hold.assertNoCollectionHold).toHaveBeenCalledWith(CUSTOMER_ID, expect.anything());
      const fs = require('fs');
      const dues = fs.readFileSync(require.resolve('../services/monthly-dues-eligibility.js'), 'utf8');
      const cron = fs.readFileSync(require.resolve('../services/billing-cron.js'), 'utf8');
      expect(dues).toContain("require('./collections/collection-hold')");
      expect(dues).toMatch(/isCollectionHoldRefusal\(err\)/);
      expect(cron).toMatch(/isCollectionHoldRefusal\(err\)/);
    });
  });

  describe('Codex round 14: the one writer that inserts a saved method serializes behind the edit', () => {
    test('the advisory key is try-locked before the method rows are re-read, and a held key refuses without waiting', async () => {
      mockState.customer = { ...MONTHLY };
      const card = await propose(LEAVE);
      mockState.log = [];
      expect((await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin })).error).toBeUndefined();
      expect(mockState.log.indexOf('methods:advisory')).toBeGreaterThan(-1);
      expect(mockState.log.indexOf('methods:advisory')).toBeLessThan(mockState.log.indexOf('methods:lock'));
      mockState.customer = { ...MONTHLY };
      mockState.methodsAdvisoryBusy = true;
      mockState.log = [];
      const busy = await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin });
      expect(busy).toMatchObject({ preview_changed: true, error: expect.stringMatching(/payment method is being saved/) });
      expect(mockState.log).not.toContain('methods:lock');
    });

    test('source contract: savePaymentMethod takes the same key, around its insert, in the same transaction', () => {
      const fs = require('fs');
      const lock = require('../utils/payment-method-lock');
      const stripe = fs.readFileSync(require.resolve('../services/stripe.js'), 'utf8');
      const card = fs.readFileSync(require.resolve('../services/intelligence-bar/billing-mode-change.js'), 'utf8');
      const save = stripe.slice(stripe.indexOf('async savePaymentMethod'), stripe.indexOf('async getCards'));
      const txn = save.slice(save.indexOf('db.transaction'));
      expect(txn.indexOf('lockCustomerPaymentMethods(trx, customerId)')).toBeGreaterThan(-1);
      expect(txn.indexOf('lockCustomerPaymentMethods(trx, customerId)')).toBeLessThan(txn.indexOf("trx('payment_methods').insert("));
      expect(card).toContain('tryLockCustomerPaymentMethods(trx, customerId)');
      // One module owns the key: both sides use the same namespace and hash.
      const src = fs.readFileSync(require.resolve('../utils/payment-method-lock.js'), 'utf8');
      expect(src.match(/hashtext\(\?\), hashtext\(\?::text\)/g)).toHaveLength(2);
      expect(lock.PAYMENT_METHODS_LOCK_NS).toBe('payment-methods');
      // And the only inserter of a payment_methods row is savePaymentMethod.
      expect(stripe.match(/payment_methods'\)\.insert\(/g)).toHaveLength(1);
    });
  });

  describe('Codex round 13: an ongoing root stamped with a Bill-To payer', () => {
    const rootRow = (payer) => ({ id: 'root-1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2026-09-01', payer_id: payer });

    test('no live visit but a payer-stamped ongoing root: refused before the card says charges go to the customer\'s card', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      mockState.seriesIds = ['root-1'];
      mockState.roots = [rootRow(7)];
      expect(await propose(LEAVE)).toMatchObject({
        code: 'billing_visits_payer_owned',
        error: 'This customer has an ongoing recurring plan billed to a Bill-To payer — change billing on the customer page. Nothing was proposed.',
      });
      // The top-up's own selector decides which roots count.
      expect(require('../services/recurring-series-topup').eligibleSeriesParentIds).toHaveBeenCalledWith(expect.anything(), { customerId: CUSTOMER_ID });
    });

    test('an unstamped root passes; the roots are pinned and locked at the commit, and a payer stamped after the card refuses', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.visits = [];
      mockState.seriesIds = ['root-1'];
      mockState.roots = [rootRow(null)];
      const card = await propose(LEAVE);
      expect(card.error).toBeUndefined();
      expect(card.pin).toContain('[[["root-1",null,"0","verified","",""]],[],0]');
      mockState.log = [];
      expect((await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin })).error).toBeUndefined();
      expect(mockState.log).toContain('roots:lock');
      expect(mockState.log.indexOf('roots:lock')).toBeGreaterThan(mockState.log.indexOf('visits:lock'));
      mockState.customer = { ...MONTHLY };
      mockState.roots = [rootRow(7)];
      mockState.updates = [];
      const stale = await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: card.pin });
      expect(stale).toMatchObject({ preview_changed: true });
      expect(customerWrites()).toHaveLength(0);
    });
  });

  describe('leaving monthly membership waits for a dues charge whose Stripe outcome is not settled (retry-collectibility hasUnresolvedSiblingStripeOutcome)', () => {
    const LEAVE_MONTHLY = { billing_mode: 'per_application', per_application_fee: 147 };
    const message = /A dues charge for [A-Z][a-z]+ \d{4} is still being reconciled with Stripe; try again after it settles\./;

    test('an unresolved invoice-less stripe_orphan_charges row', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.orphan = { id: 'orph-1', stripe_payment_intent_id: 'pi_1' };
      expect(await propose(LEAVE_MONTHLY)).toMatchObject({ code: 'dues_outcome_unresolved', error: expect.stringMatching(message) });
    });

    test('a failed dues attempt parked with metadata.ambiguous_outcome', async () => {
      mockState.customer = { ...MONTHLY };
      mockState.ambiguous = { id: 'pay-amb' };
      expect(await propose(LEAVE_MONTHLY)).toMatchObject({ code: 'dues_outcome_unresolved', error: expect.stringMatching(message) });
    });

    test('settled: neither blocks; a state that appears after the card refuses under the lock', async () => {
      mockState.customer = { ...MONTHLY };
      const card = await propose(LEAVE_MONTHLY);
      expect(card.error).toBeUndefined();
      mockState.ambiguous = { id: 'pay-amb' };
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: LEAVE_MONTHLY, _ib_customer_version: 'v1', _ib_billing_pin: card.pin,
      });
      expect(result).toMatchObject({ preview_changed: true, error: expect.stringMatching(message) });
      expect(customerWrites()).toHaveLength(0);
    });

    test('a customer who is not leaving monthly is not held up by it', async () => {
      mockState.customer = { ...BASE };
      mockState.orphan = { id: 'orph-1' };
      expect((await propose(LEAVE_MONTHLY)).error).toBeUndefined();
    });
  });
});

test('never owner-direct: a billing edit always gets a card', () => {
  const input = { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application', per_application_fee: 147 } };
  expect(mayExecuteWithoutCard('update_customer', input)).toBe(false);
  expect(executesWithoutCard('update_customer', input, {})).toBe(false);
});
