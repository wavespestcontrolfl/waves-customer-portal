/**
 * IB get_closeout_bill_preview — read-only "what will the close-out bill?" for one open visit.
 * The completion's own pure decision (shouldAutoInvoiceCompletion) and billing helpers run for real;
 * only the database reads and the invoice-line builder are replaced with synthetic facts.
 * The preview answers the plain path with confidence and returns 'uncertain' for every other state.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { previewCloseoutBill, _private: preview } = require('../services/closeout-bill-preview');
const AnnualPrepay = require('../services/annual-prepay-renewals');
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
    invoices: { existing: null, terminal: null, liveBeside: null, history: [], ...(rest.invoices || {}) },
    coverage: { annualVerdict: null, annualUnavailable: false, duesCollected: false, ...(rest.coverage || {}) },
    setup: { obligation: null, parkedElsewhere: false, claim: null, detectorError: false, ...(rest.setup || {}) },
    profile: { known: true, billingType: '', ...(rest.profile || {}) },
    addonsOwed: rest.addonsOwed === true,
  };
}

function run(f, lineItems = null) {
  return previewCloseoutBill(SERVICE_ID, {
    gather: async () => f,
    buildLines: async (v, amount) => lineItems || [{ description: v.service_type, amount }],
    previewTax: async (v, net) => ({ tax_rate: 0, tax_amount: 0, total: net }),
  });
}

describe('get_closeout_bill_preview: the plain path answers with confidence', () => {
  const saved = process.env.GATE_UNMINTED_SETUP_FEE_PARK;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_UNMINTED_SETUP_FEE_PARK;
    else process.env.GATE_UNMINTED_SETUP_FEE_PARK = saved;
  });
  const perApp = { estimated_price: 60, cust_billing_mode: 'per_application', is_recurring: true };

  test('per-visit visit with a tier discount: lines, named discount and total', async () => {
    const f = facts({ estimated_price: 90, primary_line_price: 100, create_invoice_on_complete: true, cust_waveguard_tier: 'Silver' });
    const out = await run(f, [
      { description: 'General Pest Control', amount: 100 },
      { description: 'WaveGuard Silver discount', amount: -10 },
    ]);
    expect(out.prediction).toBe('confident');
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

  test('first visit with a never-invoiced setup fee and the park gate on: confident, held, with the amount', async () => {
    process.env.GATE_UNMINTED_SETUP_FEE_PARK = 'true';
    const f = facts(
      { ...perApp, source_estimate_id: '33333333-3333-4333-8333-333333333333' },
      { setup: { obligation: { owed: true, setupFee: 99, firstVisitAlreadyCompleted: false } } },
    );
    const out = await run(f);
    expect(out.prediction).toBe('confident');
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('held_for_manual_billing');
    expect(out.reason).toMatch(/\$99\.00 setup fee was never invoiced/);
    expect(out.setup_fee).toMatchObject({ never_invoiced: true, amount: 99, held_for_manual_billing: true, park_gate_on: true });
    expect(out.application_amount_held).toBe(60);
  });

  test('same visit with the park gate off bills the application without the fee and says so', async () => {
    delete process.env.GATE_UNMINTED_SETUP_FEE_PARK;
    const f = facts(
      { ...perApp, source_estimate_id: '33333333-3333-4333-8333-333333333333' },
      { setup: { obligation: { owed: true, setupFee: 99, firstVisitAlreadyCompleted: false } } },
    );
    const out = await run(f);
    expect(out.prediction).toBe('confident');
    expect(out.will_invoice).toBe(true);
    expect(out.total).toBe(60);
    expect(out.notes.join(' ')).toMatch(/park gate is off.*\$99\.00 setup fee/);
  });

  test('a queued plan-choice setup fee on a visit that mints, no invoice on it, rides as its own line', async () => {
    const out = await run(facts(perApp, { setup: { claim: { amount: 99, state: 'queued' } } }));
    expect(out.prediction).toBe('confident');
    expect(out.lines.map((l) => l.description)).toEqual(['General Pest Control', 'One-time setup fee']);
    expect(out.total).toBe(159);
    expect(out.setup_fee.rides_on_this_invoice).toBe(99);
  });

  test('monthly membership visit covered by dues: no invoice, dues reason', async () => {
    const out = await run(facts(
      { cust_billing_mode: 'monthly_membership', cust_waveguard_tier: 'Gold', cust_monthly_rate: 89, is_recurring: true },
      { billing: { autopay_active: true } },
    ));
    expect(out.prediction).toBe('confident');
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('covered_by_monthly_dues');
  });

  test('annual prepay coverage with no add-ons and no invoice: no invoice', async () => {
    const out = await run(facts({ estimated_price: 90, create_invoice_on_complete: true }, { coverage: { annualVerdict: true } }));
    expect(out.prediction).toBe('confident');
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('covered_by_annual_prepay');
  });

  test('exactly one live invoice on the visit: already invoiced, the reason names it', async () => {
    const existing = { id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent', total: '90.00' };
    const out = await run(facts(
      { estimated_price: 90, create_invoice_on_complete: true },
      { invoices: { existing, history: [{ id: 'inv-1', status: 'sent' }] } },
    ));
    expect(out.prediction).toBe('confident');
    expect(out.will_invoice).toBe(false);
    expect(out.reason_code).toBe('already_invoiced');
    expect(out.reason).toMatch(/WPC-2026-0001/);
    expect(out.existing_invoice).toEqual({ id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent', total: 90 });
  });

  test('unknown visit id', async () => {
    expect(await previewCloseoutBill(SERVICE_ID, { gather: async () => null })).toEqual({ found: false });
  });
});

describe('get_closeout_bill_preview: every off-plain-path state is uncertain, never yes or no', () => {
  const priced = { estimated_price: 90, create_invoice_on_complete: true };
  const perApp = { estimated_price: 60, cust_billing_mode: 'per_application', is_recurring: true };
  const live = { id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent' };

  const cases = [
    ['a voided invoice on the visit', priced, { invoices: { history: [{ id: 'i', status: 'void' }] } }, 'dead_or_refunded_invoice', /a voided, canceled or refunded invoice is on this visit/],
    ['a canceled invoice on the visit', priced, { invoices: { history: [{ id: 'i', status: 'canceled' }] } }, 'dead_or_refunded_invoice'],
    ['a refunded invoice on the visit', priced, { invoices: { terminal: { id: 'i', status: 'refunded' }, history: [{ id: 'i', status: 'refunded' }] } }, 'dead_or_refunded_invoice'],
    ['two invoices on the visit', priced, { invoices: { existing: live, history: [{ id: 'a', status: 'sent' }, { id: 'b', status: 'paid' }] } }, 'several_invoices'],
    ['a visit that is not open', { ...priced, status: 'completed' }, {}, 'visit_not_open'],
    ['an annual-prepay covered visit with add-ons owed', priced, { coverage: { annualVerdict: true }, addonsOwed: true }, 'annual_prepay_addons_or_invoice'],
    ['an annual-prepay covered visit with an invoice on it', priced, { coverage: { annualVerdict: true }, invoices: { existing: live, history: [{ id: 'inv-1', status: 'sent' }] } }, 'annual_prepay_addons_or_invoice'],
    ['a stale annual-prepay stamp', priced, { coverage: { annualVerdict: false } }, 'annual_prepay_unconfirmed'],
    ['an unreadable annual-prepay check', priced, { coverage: { annualUnavailable: true } }, 'annual_prepay_unconfirmed'],
    ['an orphaned setup-fee claim', perApp, { setup: { claim: { amount: 99, state: 'orphaned' } } }, 'setup_fee_claim'],
    ['a queued setup fee beside an existing invoice (handed to the office)', perApp, { setup: { claim: { amount: 99, state: 'queued' } }, invoices: { existing: live, history: [{ id: 'inv-1', status: 'sent' }] } }, 'setup_fee_claim'],
    ['a queued setup fee on a visit that does not mint', { ...perApp, estimated_price: null }, { setup: { claim: { amount: 99, state: 'queued' } } }, 'setup_fee_claim'],
    ['a partial recorded prepayment', { ...priced, prepaid_amount: 30, prepaid_method: 'cash' }, {}, 'partial_prepayment'],
    ['a stranded setup-fee stamp', perApp, { setup: { obligation: { owed: true, setupFee: 99, unconsumableStamps: [{ parentId: 'p' }] } } }, 'stranded_setup_fee_stamp'],
    ['an unreadable completion type', priced, { profile: { known: false } }, 'completion_type_unreadable'],
    ['an unreadable setup-fee check', priced, { setup: { detectorError: true } }, 'setup_fee_check_unavailable'],
  ];

  test.each(cases.map((c) => [c[0], c[1], c[2], c[3], c[4] || /^uncertain: /]))('%s', async (label, visitOverrides, rest, code, reasonPattern) => {
    const out = await run(facts(visitOverrides, rest));
    expect(out.prediction).toBe('uncertain');
    expect(out.will_invoice).toBeNull();
    expect(out.reason_code).toBe('uncertain');
    expect(out.off_path).toContain(code);
    expect(out.reason).toMatch(/^uncertain: /);
    expect(out.reason).toMatch(reasonPattern);
    expect(out.notes.join(' ')).not.toMatch(/undefined/);
  });

  test('an uncertain visit that would mint shows its ordinary invoice only as before office handling', async () => {
    const out = await run(facts(priced, { invoices: { history: [{ id: 'i', status: 'void' }] } }));
    expect(out.will_invoice).toBeNull();
    expect(out.lines).toEqual([]);
    expect(out.before_office_handling).toMatchObject({ total: 90, lines: [{ description: 'General Pest Control', amount: 90 }] });
  });

  test('the add-on office-review note never appears with an undefined explanation', async () => {
    const out = await run(facts(priced, { coverage: { annualVerdict: true }, addonsOwed: true }));
    expect(JSON.stringify(out)).not.toMatch(/undefined/);
    expect(out.notes.join(' ')).not.toMatch(/office alert and collects nothing/);
  });
});

describe('get_closeout_bill_preview: the covered-visit and claim reads', () => {
  const savedGate = process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
    else process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = savedGate;
    jest.restoreAllMocks();
  });
  const flags = { perApplicationBilling: false, annualPrepayBilling: false, explicitMembershipLane: false };

  test('an unstamped termite renewal grace visit is covered: the completion check (annualPrepayCoversVisit) decides, not the prediction verdict', async () => {
    const covers = jest.spyOn(AnnualPrepay, 'annualPrepayCoversVisit').mockResolvedValue(true);
    const prediction = jest.spyOn(AnnualPrepay, 'annualCoverageVerdictForPrediction');
    const v = visit({ estimated_price: 90, create_invoice_on_complete: true });
    const coverage = await preview.loadCoverage({}, v, { payer_billed: false, autopay_active: false }, flags);
    expect(covers).toHaveBeenCalledWith(v, {}, { throwOnError: true });
    expect(prediction).not.toHaveBeenCalled();
    expect(coverage.annualVerdict).toBe(true);
  });

  test('a stamp the term no longer backs is false, an unstamped uncovered visit is null', async () => {
    jest.spyOn(AnnualPrepay, 'annualPrepayCoversVisit').mockResolvedValue(false);
    const stamped = await preview.loadCoverage({}, visit({ prepaid_method: AnnualPrepay.ANNUAL_PREPAY_PREPAID_METHOD }), { payer_billed: false }, flags);
    const bare = await preview.loadCoverage({}, visit(), { payer_billed: false }, flags);
    expect(stamped.annualVerdict).toBe(false);
    expect(bare.annualVerdict).toBeNull();
  });

  function claimDb(pending) {
    return () => ({ where: () => ({ first: async () => ({ pending_setup_fee: pending, updated_at: new Date() }) }) });
  }

  test('the setup-fee claim read: positive is queued, negative is orphaned, none is null', async () => {
    jest.spyOn(require('../services/setup-fee-obligation'), 'prepayWaivesDeferredSetupFee').mockResolvedValue(false);
    expect(await preview.loadQueuedSetupClaim(claimDb(99), visit({ is_recurring: true }))).toEqual({ amount: 99, state: 'queued' });
    expect(await preview.loadQueuedSetupClaim(claimDb(-99), visit({ is_recurring: true }))).toEqual({ amount: 99, state: 'orphaned' });
    expect(await preview.loadQueuedSetupClaim(claimDb(null), visit({ is_recurring: true }))).toBeNull();
  });
});

describe('get_closeout_bill_preview registration', () => {
  test('tool schema, description says uncertain, read-only policy row and no write gate', () => {
    const tool = CLOSEOUT_TOOLS.find((t) => t.name === 'get_closeout_bill_preview');
    expect(tool.input_schema.properties.service_id.format).toBe('uuid');
    expect(tool.input_schema.required).toEqual(['service_id']);
    expect(tool.description).toMatch(/uncertain/);
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
