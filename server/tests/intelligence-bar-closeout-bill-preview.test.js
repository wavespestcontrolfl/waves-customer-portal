/**
 * IB get_closeout_bill_preview — read-only "what will the close-out bill?" for one open visit.
 * The completion's own pure decision (shouldAutoInvoiceCompletion) and billing helpers run for real;
 * only the database reads and the invoice-line builder are replaced with synthetic facts.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { previewCloseoutBill } = require('../services/closeout-bill-preview');
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
    coverage: { annualVerdict: null, duesCollected: false, ...(rest.coverage || {}) },
    setup: { obligation: null, parkedElsewhere: false, claimAmount: null, detectorError: false, ...(rest.setup || {}) },
    profile: { known: true, billingType: '' },
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
      { setup: { claimAmount: 99 } },
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
