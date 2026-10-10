// Intelligence Bar update_customer: billing type + per-application fee
// (owner D5 2026-10-06, GATE_IB_BILLING_MODE_EDIT). Proposal rules mirror the
// customer page's PUT (billing-mode-rules.js), the card text, the commit-time
// pin, and the gate.
const mockState = {
  customer: null, version: 'v1', term: null, armed: null, unpriced: [], visits: [], updates: [],
  // Eligibility / lock doubles and the order of the commit's reads.
  cohortMiss: false, covered: new Set(), pending: new Set(), chargeable: true, claimHeld: false, log: [],
};

jest.mock('../models/db', () => {
  const build = (table) => {
    const q = { cols: [] };
    for (const m of ['whereIn', 'whereNull', 'whereNotNull', 'whereNot', 'whereRaw', 'orWhere', 'orWhereRaw', 'orderBy', 'limit']) q[m] = () => q;
    // where(fn) runs its callback (the live-visit clause is built that way).
    q.where = (f) => { if (typeof f === 'function') f.call(q, q); return q; };
    q.forUpdate = () => { q.locked = true; if (table === 'customers') mockState.log.push('customers:row'); return q; };
    q.select = (...cols) => { q.cols = cols; return q; };
    q.first = async (...cols) => {
      if (table === 'customers') {
        if (cols.length === 1 && cols[0]?.__raw) return { version: mockState.version };
        // The dues cohort read (monthly-dues-eligibility.js applyDuesCohort).
        if (Array.isArray(cols[0]) && mockState.cohortMiss) return null;
        return mockState.customer ? { ...mockState.customer, version: mockState.version } : null;
      }
      if (table === 'annual_prepay_terms') return mockState.term;
      if (table === 'payments') return mockState.armed;
      return null;
    };
    q.then = (resolve, reject) => {
      let rows = [];
      if (table === 'scheduled_services') {
        rows = q.cols.includes('scheduled_date') ? mockState.unpriced : mockState.visits;
        if (q.cols.flat().includes('payer_id')) mockState.log.push(q.locked ? 'visits:lock' : 'visits:read');
      }
      if (table === 'payments') rows = mockState.armed ? [].concat(mockState.armed) : [];
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
  customerOnAutopay: jest.fn(async () => mockState.chargeable),
}));
jest.mock('../utils/customer-billing-lock', () => ({
  withCustomerBillingLock: jest.fn(),
  tryClaimCustomerCollectionInTrx: jest.fn(async () => { mockState.log.push('claim'); return !mockState.claimHeld; }),
}));
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
  mockState.covered = new Set();
  mockState.pending = new Set();
  mockState.chargeable = true;
  mockState.claimHeld = false;
  mockState.log = [];
});
afterAll(() => { delete process.env.GATE_IB_BILLING_MODE_EDIT; });

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
    expect(ok.pin).toBe(BillingModeChange.cardPin(BASE, []));
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
    mockState.visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: '90.00', payer_id: 9 }];
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
  test('monthly member to per application at $147: type, fee, next visits, dues stop, no message', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    mockState.visits = [
      { id: 'v1', estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control' },
      { id: 'v2', estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control' },
      { scheduled_date: '2099-01-06', estimated_price: '120.00', primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Lawn Care' },
      { estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: true, service_type: 'Pest Control' },
      // $100 paid in cash against the new $147 fee: $47 still collects.
      { estimated_price: null, primary_line_price: null, prepaid_amount: '100.00', prepaid_method: 'cash', is_callback: false, service_type: 'Pest Control' },
      { estimated_price: null, primary_line_price: null, prepaid_amount: '147.00', prepaid_method: 'cash', is_callback: false, service_type: 'Pest Control' },
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
    expect(labels).toContain('Each completed visit is charged its own scheduled price, or $147.00 when it has none — auto-charged to the saved card when Auto Pay is on, invoiced otherwise. Callbacks and free visit types bill nothing. No monthly dues charge.');
    expect(labels).toContain('Upcoming visits now on the schedule: 2 visits at $147.00, 1 visit at its own price, 1 visit is partly prepaid (the rest is charged), 1 visit bills nothing, 1 visit is fully prepaid.');
    // The $120 visit's own price is listed, not just counted.
    expect(labels).toContain('Priced visit on 2099-01-06 (Lawn Care): $120.00 is collected at completion.');
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
    _ib_billing_pin: BillingModeChange.cardPin(BASE, []),
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
    const pin = BillingModeChange.cardPin(mockState.customer, []);
    mockState.customer.autopay_enabled = false;
    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: { billing_mode: 'monthly_membership' }, _ib_customer_version: 'v1', _ib_billing_pin: pin,
    });
    expect(result.preview_changed).toBe(true);
    expect(customerWrites()).toHaveLength(0);
  });

  test('a retry armed after the card refuses under the lock', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    const pin = BillingModeChange.cardPin(mockState.customer, []);
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
    const pin = BillingModeChange.cardPin(mockState.customer, []);
    const modeOnly = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application' }, _ib_customer_version: 'v1', _ib_billing_pin: pin,
    });
    expect(modeOnly.error).toBeUndefined();
    expect(modeOnly.changes).toEqual({ billing_mode: { from: 'per_visit', to: 'per_application' } });
    const pin2 = BillingModeChange.cardPin(mockState.customer, []);
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
    customer_id: CUSTOMER_ID, updates, _ib_customer_version: 'v1', _ib_billing_pin: BillingModeChange.cardPin(customer, visits),
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
      expect(mockState.log.slice(0, 5)).toEqual(['comms', 'customers:row', 'claim', 'visits:lock', 'visits:read']);
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
      const pinned = BillingModeChange.cardPin(BASE, []);
      mockState.visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: '120.00', payer_id: null }];
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: pinned,
      });
      expect(result).toMatchObject({ preview_changed: true });
      expect(result.error).toMatch(/billing or upcoming visits changed since the card/);
      expect(mockState.log).toEqual(['comms', 'customers:row', 'claim', 'visits:lock', 'visits:read']);
      expect(customerWrites()).toHaveLength(0);
    });

    test('an unchanged projection commits, and the proposal reads without locking', async () => {
      mockState.customer = { ...BASE };
      const visits = [{ id: 'v1', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: '120.00', payer_id: null }];
      mockState.visits = visits;
      expect((await propose(LEAVE)).error).toBeUndefined();
      expect(mockState.log).toEqual(['visits:read']);
      mockState.log = [];
      const result = await commit(BASE, LEAVE, visits);
      expect(result.error).toBeUndefined();
      expect(mockState.log).toEqual(['comms', 'customers:row', 'claim', 'visits:lock', 'visits:read']);
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
      const pin = BillingModeChange.cardPin(mockState.customer, []);
      mockState.chargeable = false;
      const result = await executeTool('update_customer', {
        customer_id: CUSTOMER_ID, updates: MOVE, _ib_customer_version: 'v1', _ib_billing_pin: pin,
      });
      expect(result).toMatchObject({ preview_changed: true });
      expect(result.error).toMatch(/no saved payment method.*Nothing was updated/);
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
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: BillingModeChange.cardPin(BASE, [], LEAVE),
    });
    expect(result.error).toBeUndefined();
    expect(mockState.log).toEqual(['comms', 'customers:row', 'claim', 'visits:lock', 'visits:read']);
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

  test('a $100 prepayment on an unpriced visit: the card shows the balance moving from $0.00 to $47.00, and the pin carries it', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    const visit = {
      id: 'v7', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: null, primary_line_price: null,
      prepaid_amount: '100.00', prepaid_method: 'cash', is_callback: false, service_type: 'Pest Control', payer_id: null, is_recurring: true,
    };
    mockState.visits = [visit];
    const proposal = await propose(LEAVE);
    expect(proposal.error).toBeUndefined();
    expect(proposal.display.next_visits).toContain('Partly prepaid visit on 2099-01-05 (Pest Control): $100.00 paid; still collected at completion $0.00 → $47.00.');
    // Pinned: the same visit with a different prepayment changes the balance, so the pin differs.
    const pinTwo = BillingModeChange.cardPin(mockState.customer, [{ ...visit, prepaid_amount: '120.00' }], LEAVE);
    expect(pinTwo).not.toBe(proposal.pin);
    expect(proposal.pin).toContain('"v7",0,47');
    // Commit with the same state succeeds; a changed prepayment refuses.
    const ok = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: proposal.pin,
    });
    expect(ok.error).toBeUndefined();
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    mockState.visits = [{ ...visit, prepaid_amount: '120.00' }];
    const stale = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID, updates: LEAVE, _ib_customer_version: 'v1', _ib_billing_pin: proposal.pin,
    });
    expect(stale).toMatchObject({ preview_changed: true });
  });

  test('priced visits are listed up to five, then one exact aggregate line; a partial prepayment shows what is left', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    const priced = (n, price, extra = {}) => ({ id: `p${n}`, status: 'confirmed', scheduled_date: `2099-02-0${n}`, estimated_price: price, prepaid_amount: null, is_callback: false, service_type: 'Pest Control', payer_id: null, ...extra });
    mockState.visits = [1, 2, 3, 4, 5].map((n) => priced(n, '100.00')).concat([priced(6, '90.00'), priced(7, '60.00', { prepaid_amount: '20.00', prepaid_method: 'cash' })]);
    const proposal = await propose(LEAVE);
    const lines = proposal.display.next_visits;
    expect(lines.filter((l) => l.startsWith('Priced visit'))).toHaveLength(5);
    expect(lines).toContain('Priced visit on 2099-02-01 (Pest Control): $100.00 is collected at completion.');
    expect(lines).toContain('2 more priced visits: $130.00 collected at completion in all.');
    // A partial prepayment on a priced visit shows the amount left.
    mockState.visits = [priced(7, '60.00', { prepaid_amount: '20.00', prepaid_method: 'cash' })];
    expect((await propose(LEAVE)).display.next_visits).toContain('Priced visit on 2099-02-07 (Pest Control): $60.00 is collected at completion ($40.00 after $20.00 paid).');
    // The price is pinned: a visit price edit changes the pin.
    expect(BillingModeChange.cardPin(mockState.customer, [priced(1, '100.00')], LEAVE))
      .not.toBe(BillingModeChange.cardPin(mockState.customer, [priced(1, '110.00')], LEAVE));
  });

  test('a priced visit with a partial prepayment shows no balance line (its own price wins in every lane)', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    mockState.visits = [{ id: 'v8', status: 'confirmed', scheduled_date: '2099-01-05', estimated_price: '120.00', prepaid_amount: '50.00', prepaid_method: 'cash', service_type: 'Pest Control' }];
    const lines = (await propose(LEAVE)).display.next_visits;
    expect(lines.some((l) => l.startsWith('Partly prepaid visit'))).toBe(false);
  });
});

test('never owner-direct: a billing edit always gets a card', () => {
  const input = { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application', per_application_fee: 147 } };
  expect(mayExecuteWithoutCard('update_customer', input)).toBe(false);
  expect(executesWithoutCard('update_customer', input, {})).toBe(false);
});
