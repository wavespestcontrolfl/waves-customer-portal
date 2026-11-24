/**
 * IB get_closeout_bill_preview — read-only "what will the close-out bill?" for one open visit.
 * The completion's own pure decision (shouldAutoInvoiceCompletion) and billing helpers run for real;
 * only the database reads and the invoice-line builder are replaced with synthetic facts.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { previewCloseoutBill } = require('../services/closeout-bill-preview');
const { _private: preview } = require('../services/closeout-bill-preview');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const SetupFee = require('../services/setup-fee-obligation');
const registry = require('../services/intelligence-bar/action-registry');
const { CLOSEOUT_TOOLS, executeCloseoutTool } = require('../services/intelligence-bar/closeout-tools');

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';

function visit(overrides = {}) {
  return {
    id: SERVICE_ID,
    customer_id: '22222222-2222-4222-8222-222222222222',
    status: 'confirmed',
    service_type: 'General Pest Control',
    scheduled_date: '2026-11-24',
    estimated_price: null,
    primary_line_price: null,
    is_recurring: false,
    is_callback: false,
    create_invoice_on_complete: false,
    source_estimate_id: null,
    recurring_parent_id: null,
    prepaid_amount: null,
    prepaid_method: null,
    cust_billing_mode: 'per_visit',
    cust_waveguard_tier: null,
    cust_monthly_rate: null,
    cust_per_application_fee: null,
    ...overrides,
  };
}

function facts(visitOverrides = {}, rest = {}) {
  return {
    visit: visit(visitOverrides),
    flags: require('../services/billing-lane').completionLaneFlags(visit(visitOverrides).cust_billing_mode),
    billing: { autopay_active: false, payer_billed: false, ...(rest.billing || {}) },
    invoices: { existing: null, terminal: null, liveBeside: null, ...(rest.invoices || {}) },
    coverage: { annualVerdict: null, annualUnavailable: false, duesCollected: false, ...(rest.coverage || {}) },
    setup: { obligation: null, parkedElsewhere: false, claim: null, detectorError: false, ...(rest.setup || {}) },
    profile: { known: true, billingType: '' },
    coveredExtras: rest.coveredExtras || null,
  };
}

function run(f, lineItems = null) {
  return previewCloseoutBill(SERVICE_ID, {
    gather: async () => f,
    buildLines: async (v, amount) => lineItems || [{ description: v.service_type, amount }],
    previewTax: async (v, net) => ({ tax_rate: 0, tax_amount: 0, total: net }),
  });
}

describe('get_closeout_bill_preview', () => {
  const saved = process.env.GATE_UNMINTED_SETUP_FEE_PARK;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_UNMINTED_SETUP_FEE_PARK;
    else process.env.GATE_UNMINTED_SETUP_FEE_PARK = saved;
  });

  test('per-visit visit with a tier discount: lines, named discount and total', async () => {
    const f = facts({ estimated_price: 90, primary_line_price: 100, create_invoice_on_complete: true, cust_waveguard_tier: 'Silver' });
    const out = await run(f, [
      { description: 'General Pest Control', amount: 100 },
      { description: 'WaveGuard Silver discount', amount: -10 },
    ]);
    expect(out.will_invoice).toBe(true);
    expect(out.lines).toEqual([{ description: 'General Pest Control', amount: 100 }]);
    expect(out.discounts).toEqual([{ name: 'WaveGuard Silver discount', amount: 10 }]);
    expect(out.subtotal).toBe(100);
    expect(out.discount_total).toBe(10);
    expect(out.total).toBe(90);
    expect(out.setup_fee.never_invoiced).toBe(false);
  });

  test('a visit with no stamped discount says so instead of promising the tier discount', async () => {
    const out = await run(facts({ estimated_price: 100, create_invoice_on_complete: true, cust_waveguard_tier: 'Silver' }));
    expect(out.discounts).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/No discount line is stamped on this visit \(customer tier: Silver\)/);
  });

  test('first visit with a never-invoiced setup fee and the park gate on: held, with the amount', async () => {
    process.env.GATE_UNMINTED_SETUP_FEE_PARK = 'true';
    const f = facts(
      { estimated_price: 60, cust_billing_mode: 'per_application', source_estimate_id: '33333333-3333-4333-8333-333333333333', is_recurring: true },
      { setup: { obligation: { owed: true, setupFee: 99, firstVisitAlreadyCompleted: false } } },
    );
    const out = await run(f);
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('held_for_manual_billing');
    expect(out.reason).toMatch(/\$99\.00 setup fee was never invoiced/);
    expect(out.setup_fee).toMatchObject({ never_invoiced: true, amount: 99, held_for_manual_billing: true, park_gate_on: true });
    expect(out.application_amount_held).toBe(60);
    expect(out.gates.GATE_UNMINTED_SETUP_FEE_PARK).toBe(true);
  });

  test('same visit with the park gate off bills the application without the fee and says so', async () => {
    delete process.env.GATE_UNMINTED_SETUP_FEE_PARK;
    const f = facts(
      { estimated_price: 60, cust_billing_mode: 'per_application', source_estimate_id: '33333333-3333-4333-8333-333333333333', is_recurring: true },
      { setup: { obligation: { owed: true, setupFee: 99, firstVisitAlreadyCompleted: false } } },
    );
    const out = await run(f);
    expect(out.will_invoice).toBe(true);
    expect(out.total).toBe(60);
    expect(out.setup_fee.held_for_manual_billing).toBe(false);
    expect(out.notes.join(' ')).toMatch(/park gate is off.*\$99\.00 setup fee/);
  });

  test('a queued plan-choice setup fee rides the first invoice as its own line', async () => {
    const f = facts(
      { estimated_price: 60, cust_billing_mode: 'per_application', is_recurring: true },
      { setup: { claim: { amount: 99, state: 'queued' } } },
    );
    const out = await run(f);
    expect(out.will_invoice).toBe(true);
    expect(out.lines.map((l) => l.description)).toEqual(['General Pest Control', 'One-time setup fee']);
    expect(out.total).toBe(159);
    expect(out.setup_fee.rides_on_this_invoice).toBe(99);
  });

  test('monthly membership visit covered by dues: no invoice, dues reason', async () => {
    const f = facts(
      { cust_billing_mode: 'monthly_membership', cust_waveguard_tier: 'Gold', cust_monthly_rate: 89, is_recurring: true },
      { billing: { autopay_active: true } },
    );
    const out = await run(f);
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('covered_by_monthly_dues');
    expect(out.reason).toMatch(/monthly membership dues/);
  });

  test('already invoiced: the reason names the invoice', async () => {
    const f = facts(
      { estimated_price: 90, create_invoice_on_complete: true },
      { invoices: { existing: { id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent', total: '90.00' } } },
    );
    const out = await run(f);
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('already_invoiced');
    expect(out.reason).toMatch(/WPC-2026-0001/);
    expect(out.existing_invoice).toEqual({ id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent', total: 90 });
  });

  test('a refunded invoice on the visit holds it for manual billing', async () => {
    const f = facts(
      { estimated_price: 90, create_invoice_on_complete: true },
      { invoices: { terminal: { id: 'inv-2', invoice_number: 'WPC-2026-0002', status: 'refunded' } } },
    );
    const out = await run(f);
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('held_for_manual_billing');
    expect(out.reason).toMatch(/WPC-2026-0002.*refunded/);
  });

  test('unknown visit id', async () => {
    const out = await previewCloseoutBill(SERVICE_ID, { gather: async () => null });
    expect(out).toEqual({ found: false });
  });
});

describe('covered visits, annual prepay add-ons and orphaned setup-fee claims', () => {
  const coveredVisit = { estimated_price: 90, create_invoice_on_complete: true };
  const addonRead = {
    kind: 'bill',
    extras: { total: 25, lines: [{ description: 'Mosquito add-on', amount: 30 }, { description: 'Add-on discount', amount: -5 }] },
  };
  const savedAddonGate = process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
  afterEach(() => {
    if (savedAddonGate === undefined) delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
    else process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = savedAddonGate;
    jest.restoreAllMocks();
  });

  test('an unstamped termite renewal grace visit is covered: the completion check (annualPrepayCoversVisit) decides, not the prediction verdict', async () => {
    const covers = jest.spyOn(AnnualPrepay, 'annualPrepayCoversVisit').mockResolvedValue(true);
    const prediction = jest.spyOn(AnnualPrepay, 'annualCoverageVerdictForPrediction');
    const v = visit(coveredVisit);
    const coverage = await preview.loadCoverage({}, v, { payer_billed: false, autopay_active: false }, { perApplicationBilling: false, annualPrepayBilling: false, explicitMembershipLane: false });
    expect(covers).toHaveBeenCalledWith(v, {}, { throwOnError: true });
    expect(prediction).not.toHaveBeenCalled();
    expect(coverage.annualVerdict).toBe(true);
    const out = await run(facts(coveredVisit, { coverage: { annualVerdict: true } }));
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('covered_by_annual_prepay');
  });

  test('a stamp the term no longer backs is false, an unstamped uncovered visit is null', async () => {
    jest.spyOn(AnnualPrepay, 'annualPrepayCoversVisit').mockResolvedValue(false);
    const flags = { perApplicationBilling: false, annualPrepayBilling: false, explicitMembershipLane: false };
    const stamped = await preview.loadCoverage({}, visit({ prepaid_method: AnnualPrepay.ANNUAL_PREPAY_PREPAID_METHOD }), { payer_billed: false }, flags);
    const bare = await preview.loadCoverage({}, visit(), { payer_billed: false }, flags);
    expect(stamped.annualVerdict).toBe(false);
    expect(bare.annualVerdict).toBeNull();
  });

  test('covered visit with priced add-ons and the add-on gate on: the add-ons bill alone', async () => {
    process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true';
    const out = await run(facts(coveredVisit, { coverage: { annualVerdict: true }, coveredExtras: addonRead }));
    expect(out.will_invoice).toBe(true);
    expect(out.reason_code).toBe('annual_prepay_addons_billed');
    expect(out.lines).toEqual([{ description: 'Mosquito add-on', amount: 30 }]);
    expect(out.discounts).toEqual([{ name: 'Add-on discount', amount: 5 }]);
    expect(out.total).toBe(25);
    expect(out.gates.GATE_ANNUAL_PREPAY_ADDON_BILLING).toBe(true);
  });

  test('covered visit with add-ons and the add-on gate off: nothing bills, and the note says why', async () => {
    delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
    const out = await run(facts(coveredVisit, { coverage: { annualVerdict: true }, coveredExtras: addonRead }));
    expect(out.will_invoice).toBe(false);
    expect(out.notes.join(' ')).toMatch(/GATE_ANNUAL_PREPAY_ADDON_BILLING is off/);
  });

  test('covered visit whose add-ons need the office (unpriced add-on) collects nothing and says so', async () => {
    process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true';
    const out = await run(facts(coveredVisit, { coverage: { annualVerdict: true }, coveredExtras: { kind: 'unpriced' } }));
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('covered_by_annual_prepay');
    expect(out.notes.join(' ')).toMatch(/an add-on has no price yet.*office alert/);
  });

  function claimDb(pending, updatedAt) {
    return () => ({ where: () => ({ first: async () => ({ pending_setup_fee: pending, updated_at: updatedAt }) }) });
  }
  const { SETUP_FEE_CLAIM_LEASE_MS } = require('../services/complete-scheduled-service');
  const oldClaim = new Date(Date.now() - SETUP_FEE_CLAIM_LEASE_MS - 60000);

  test('orphaned negative claim past its lease with no invoice line: adopted, the fee rides', async () => {
    jest.spyOn(SetupFee, 'seriesCarriesSetupFeeLine').mockResolvedValue(undefined);
    const claim = await preview.loadQueuedSetupClaim(claimDb(-99, oldClaim), visit({ is_recurring: true }));
    expect(claim).toEqual({ amount: 99, state: 'adopted_orphan' });
    const out = await run(facts({ estimated_price: 60, cust_billing_mode: 'per_application', is_recurring: true }, { setup: { claim } }));
    expect(out.will_invoice).toBe(true);
    expect(out.lines.map((l) => l.amount)).toEqual([60, 99]);
    expect(out.total).toBe(159);
    expect(out.setup_fee.rides_on_this_invoice).toBe(99);
  });

  test('orphaned claim inside its lease: held while the other completion mints', async () => {
    jest.spyOn(SetupFee, 'seriesCarriesSetupFeeLine').mockResolvedValue(undefined);
    const claim = await preview.loadQueuedSetupClaim(claimDb(-99, new Date()), visit({ is_recurring: true }));
    expect(claim).toEqual({ amount: 99, state: 'in_flight' });
    const out = await run(facts({ estimated_price: 60, cust_billing_mode: 'per_application', is_recurring: true }, { setup: { claim } }));
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('setup_fee_claim_in_flight');
    expect(out.setup_fee.claim_state).toBe('in_flight');
  });

  test('orphaned claim whose fee a live series invoice already carries: nothing rides', async () => {
    jest.spyOn(SetupFee, 'seriesCarriesSetupFeeLine').mockResolvedValue({ id: 'inv-9' });
    const claim = await preview.loadQueuedSetupClaim(claimDb(-99, oldClaim), visit({ is_recurring: true }));
    expect(claim).toEqual({ amount: 99, state: 'already_on_invoice' });
    const out = await run(facts({ estimated_price: 60, cust_billing_mode: 'per_application', is_recurring: true }, { setup: { claim } }));
    expect(out.will_invoice).toBe(true);
    expect(out.total).toBe(60);
    expect(out.setup_fee.rides_on_this_invoice).toBeNull();
  });
});

describe('get_closeout_bill_preview registration', () => {
  test('tool schema, read-only policy row and no write gate', () => {
    const tool = CLOSEOUT_TOOLS.find((t) => t.name === 'get_closeout_bill_preview');
    expect(tool.input_schema.properties.service_id.format).toBe('uuid');
    expect(tool.input_schema.required).toEqual(['service_id']);
    const action = registry.actions.get('get_closeout_bill_preview');
    expect(action).toMatchObject({ kind: 'read', role: 'admin', approval: null, scope: 'record', domain: 'closeout' });
    expect(registry.policyErrors).toEqual([]);
  });

  test('missing service_id is an error, never an invoice answer', async () => {
    expect(await executeCloseoutTool('get_closeout_bill_preview', {})).toEqual({ error: 'service_id is required' });
  });

  test('technician context is refused', async () => {
    const out = await registry.execute('get_closeout_bill_preview', { service_id: SERVICE_ID }, {
      role: 'technician', context: 'tech', techContext: { techId: 'tech-1' },
    });
    expect(out.code).toBe('permission_denied');
  });

  test.each([
    'will the close-out include the setup fee',
    'does this visit include the discount',
    'what will the invoice be for today\'s appointment',
  ])('discovery finds it for "%s"', (query) => {
    const { result } = registry.discover({ query }, { role: 'admin', context: 'dashboard', fullAccess: true });
    expect(result.capabilities.map((c) => c.id)).toContain('get_closeout_bill_preview');
  });
});
