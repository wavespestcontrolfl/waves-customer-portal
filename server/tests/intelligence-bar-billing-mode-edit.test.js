// Intelligence Bar update_customer: billing type + per-application fee
// (owner D5 2026-10-06, GATE_IB_BILLING_MODE_EDIT). Proposal rules mirror the
// customer page's PUT (billing-mode-rules.js), the card text, the commit-time
// pin, and the gate.
const mockState = { customer: null, version: 'v1', term: null, unpriced: [], visits: [], updates: [] };

jest.mock('../models/db', () => {
  const build = (table) => {
    const q = { cols: [] };
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'forUpdate']) q[m] = () => q;
    q.select = (...cols) => { q.cols = cols; return q; };
    q.first = async (...cols) => {
      if (table === 'customers') {
        if (cols.length === 1 && cols[0]?.__raw) return { version: mockState.version };
        return mockState.customer ? { ...mockState.customer, version: mockState.version } : null;
      }
      if (table === 'annual_prepay_terms') return mockState.term;
      return null;
    };
    q.then = (resolve, reject) => {
      let rows = [];
      if (table === 'scheduled_services') rows = q.cols.includes('scheduled_date') ? mockState.unpriced : mockState.visits;
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
  db.raw = jest.fn(() => ({ __raw: true }));
  db.transaction = jest.fn(async (cb) => cb(db));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
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
};
const UNPRICED = { id: 's1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2099-01-05' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_BILLING_MODE_EDIT = 'true';
  mockState.customer = { ...BASE };
  mockState.version = 'v1';
  mockState.term = null;
  mockState.unpriced = [];
  mockState.visits = [];
  mockState.updates = [];
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
    expect(ok.pin).toBe(BillingModeChange.billingPin(BASE));
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

describe('card text', () => {
  test('monthly member to per application at $147: type, fee, next visits, dues stop, no message', async () => {
    mockState.customer = { ...BASE, billing_mode: 'monthly_membership', monthly_rate: '55.00', waveguard_tier: 'Gold', waveguard_tier_source: 'manual' };
    mockState.visits = [
      { estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control' },
      { estimated_price: null, primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Pest Control' },
      { estimated_price: '120.00', primary_line_price: null, prepaid_amount: null, is_callback: false, service_type: 'Lawn Care' },
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
    _ib_billing_pin: BillingModeChange.billingPin(BASE),
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
    expect(result.error).toMatch(/billing changed since the card/);
    expect(customerWrites()).toHaveLength(0);
  });

  test('a rule that no longer holds at commit refuses (a live annual-prepay term appeared)', async () => {
    mockState.term = { id: 'term-1' };
    const result = await executeTool('update_customer', card());
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/annual prepay term covering today.*Nothing was updated/);
    expect(customerWrites()).toHaveLength(0);
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

test('never owner-direct: a billing edit always gets a card', () => {
  const input = { customer_id: CUSTOMER_ID, updates: { billing_mode: 'per_application', per_application_fee: 147 } };
  expect(mayExecuteWithoutCard('update_customer', input)).toBe(false);
  expect(executesWithoutCard('update_customer', input, {})).toBe(false);
});
