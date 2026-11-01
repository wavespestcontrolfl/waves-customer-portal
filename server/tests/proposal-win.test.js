jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({
  // No-arg calls resolve the mocked "today"; date-arg calls format the date,
  // so Net-N due-date tests can assert actual offsets from mocked today.
  etDateString: (date) => (date ? date.toISOString().slice(0, 10) : '2026-06-20'),
  addETDays: (_date, days) => new Date(Date.UTC(2026, 5, 20 + (days || 0))),
}));
jest.mock('../services/payer', () => ({
  PAYMENT_TERMS: ['due_on_receipt', 'net15', 'net30', 'net60'],
  PAYMENT_TERM_NET_DAYS: { net15: 15, net30: 30, net60: 60 },
  resolveForInvoice: jest.fn().mockResolvedValue({ payerId: null, paymentTerms: null }),
}));
jest.mock('../routes/admin-customers', () => ({
  ensureCustomerAccount: jest.fn(),
}));
jest.mock('../services/customer-default-rows', () => ({
  createDefaultCustomerRows: jest.fn().mockResolvedValue(),
}));

const adminCustomers = require('../routes/admin-customers');
const { createDefaultCustomerRows } = require('../services/customer-default-rows');
const {
  buildProposalFirstInvoice,
  assertProposalTermsMatchPayer,
  flagProposalCustomerCommercialIfTaxable,
  proposalTermsDueDate,
  ensureCustomerForProposalWin,
  promoteLinkedCustomerForProposalWin,
  resolveProposalWinContact,
  recordProposalBuildingUse,
} = require('../services/proposal-win');

const SIESTA_PROPOSAL = {
  title: 'Siesta Key Proposal',
  preparedFor: 'Siesta Key HOA',
  propertyAddress: '100 Beach Rd, Sarasota FL',
  taxRate: 0.07,
  buildings: [
    {
      name: 'Tower A',
      lineItems: [
        { description: 'Monthly pest', quantity: 1, unitPrice: 260, frequency: 'monthly', taxable: true, amount: 260 },
        { description: 'Initial knockdown', quantity: 1, unitPrice: 450, frequency: 'one_time', taxable: true, amount: 450 },
      ],
    },
    {
      name: 'Lake Houses',
      lineItems: [
        { description: 'Quarterly lawn', quantity: 50, unitPrice: 30, frequency: 'quarterly', taxable: false, amount: 1500 },
      ],
    },
  ],
};

describe('buildProposalFirstInvoice', () => {
  test('bills every line once with building prefix + first-period labels and mixed tax', () => {
    const built = buildProposalFirstInvoice(SIESTA_PROPOSAL);

    expect(built.lineItems).toEqual([
      { description: 'Tower A — Monthly pest (first month)', quantity: 1, unit_price: 260 },
      { description: 'Tower A — Initial knockdown', quantity: 1, unit_price: 450 },
      { description: 'Lake Houses — Quarterly lawn (first quarter)', quantity: 50, unit_price: 30 },
    ]);
    expect(built.subtotal).toBe(2210);
    expect(built.taxableSubtotal).toBe(710);
    expect(built.taxAmount).toBe(49.7);
    expect(built.total).toBe(2259.7);
    // Blended rate must reproduce the exact tax dollars through a single-rate invoice.
    expect(Math.round(built.subtotal * built.blendedTaxRate * 100) / 100).toBe(built.taxAmount);
  });

  test('bills structured corrective-work lines too — the accepted remediation must reach the invoice (slice 1A-i)', () => {
    const built = buildProposalFirstInvoice({
      ...SIESTA_PROPOSAL,
      correctiveWork: [
        { label: 'German roach cleanout — Units 2 & 4', amount: 450, taxable: true, includes: ['Both kitchens'] },
        { label: 'Soffit exclusion', amount: 300, taxable: false },
        { label: 'Zero-dollar note', amount: 0 },
      ],
    });
    expect(built.lineItems.slice(-2)).toEqual([
      { description: 'German roach cleanout — Units 2 & 4', quantity: 1, unit_price: 450 },
      { description: 'Soffit exclusion', quantity: 1, unit_price: 300 },
    ]);
    expect(built.subtotal).toBe(2960);           // 2210 + 750
    expect(built.taxableSubtotal).toBe(1160);    // 710 + 450
    expect(built.taxAmount).toBe(81.2);          // 1160 * 0.07
    expect(built.total).toBe(3041.2);
    expect(Math.round(built.subtotal * built.blendedTaxRate * 100) / 100).toBe(built.taxAmount);
  });

  test('bills each service program\'s first application, with per-program tax (slice 1A-ii)', () => {
    const built = buildProposalFirstInvoice({
      taxRate: 0.07,
      buildings: [],
      programs: [
        { service: 'pest', label: 'Quarterly pest program', frequencyPerYear: 4, pricePerApplication: 117, annual: 468, taxable: true },
        { service: 'mosquito', label: 'Mosquito program', frequencyPerYear: 9, pricePerApplication: 65, annual: 585, taxable: false },
      ],
      correctiveWork: [{ label: 'Cleanout', amount: 450, taxable: true }],
    });
    expect(built.lineItems).toEqual([
      { description: 'Quarterly pest program (first application)', quantity: 1, unit_price: 117 },
      { description: 'Mosquito program (first application)', quantity: 1, unit_price: 65 },
      { description: 'Cleanout', quantity: 1, unit_price: 450 },
    ]);
    expect(built.subtotal).toBe(632);
    expect(built.taxableSubtotal).toBe(567);        // 117 recurring + 450 one-time
    expect(built.taxAmount).toBe(39.69);            // round(117*.07)=8.19 + round(450*.07)=31.5
    expect(Math.round(built.subtotal * built.blendedTaxRate * 100) / 100).toBe(built.taxAmount);
  });

  test('program tax rounds per application, matching ongoing invoices and the displayed annual (r15b)', () => {
    // $100.07 at 7% → each application collects $7.00; two such programs on
    // ONE acceptance invoice must collect $14.00 (per-line rounding), never
    // a bucket-rounded $14.01 the agreement and later invoices don't show.
    const built = buildProposalFirstInvoice({
      taxRate: 0.07,
      buildings: [],
      programs: [
        { service: 'pest', label: 'Pest', frequencyPerYear: 4, pricePerApplication: 100.07, annual: 400.28, taxable: true },
        { service: 'mosquito', label: 'Mosquito', frequencyPerYear: 9, pricePerApplication: 100.07, annual: 900.63, taxable: true },
      ],
    });
    expect(built.subtotal).toBe(200.14);
    expect(built.taxAmount).toBe(14);
    expect(built.total).toBe(214.14);
    expect(Math.round(built.subtotal * built.blendedTaxRate * 100) / 100).toBe(built.taxAmount);
  });

  test('rounds recurring and one-time tax buckets separately, matching computeProposalTotals (codex 1A-i r3 P0)', () => {
    // Two $100.07 taxable amounts at 7%: each bucket's tax is $7.0049 →
    // $7.00 rounded per bucket = $14.00 total. A merged bucket would round
    // $14.0098 → $14.01 and invoice a cent more than the accepted proposal.
    const built = buildProposalFirstInvoice({
      taxRate: 0.07,
      buildings: [{
        name: 'B',
        lineItems: [{ description: 'Annual program', quantity: 1, unitPrice: 100.07, frequency: 'annual', taxable: true, amount: 100.07 }],
      }],
      correctiveWork: [{ label: 'Cleanout', amount: 100.07, taxable: true }],
    });
    expect(built.taxAmount).toBe(14);
    expect(built.total).toBe(214.14);
    const { normalizeProposal, computeProposalTotals } = require('../services/estimate-proposal');
    const totals = computeProposalTotals(normalizeProposal({
      estimate_data: {
        proposal: {
          enabled: true,
          taxRate: 0.07,
          buildings: [{ name: 'B', lineItems: [{ description: 'Annual program', unitPrice: 100.07, frequency: 'annual', taxable: true }] }],
          correctiveWork: [{ label: 'Cleanout', amount: 100.07, taxable: true }],
        },
      },
    }));
    // The invoice's tax dollars equal the proposal's for coinciding amounts.
    expect(built.taxAmount).toBe(totals.totalTax);
    expect(Math.round(built.subtotal * built.blendedTaxRate * 100) / 100).toBe(built.taxAmount);
  });

  test('single building omits the building prefix', () => {
    const built = buildProposalFirstInvoice({
      taxRate: 0,
      buildings: [{ name: 'Main', lineItems: [
        { description: 'Service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: false, amount: 100 },
      ] }],
    });
    expect(built.lineItems[0].description).toBe('Service (first month)');
    expect(built.blendedTaxRate).toBe(0);
    expect(built.total).toBe(100);
  });

  test('uniformly-taxable proposal yields the real rate (not a blended one)', () => {
    const built = buildProposalFirstInvoice({
      taxRate: 0.07,
      buildings: [{ name: 'A', lineItems: [
        { description: 'X', quantity: 1, unitPrice: 100, frequency: 'one_time', taxable: true, amount: 100 },
      ] }],
    });
    expect(built.blendedTaxRate).toBeCloseTo(0.07, 10);
    expect(built.taxAmount).toBe(7);
  });

  test('no billable lines → empty invoice', () => {
    const built = buildProposalFirstInvoice({
      taxRate: 0.07,
      buildings: [{ name: 'A', lineItems: [
        { description: 'Zero', quantity: 1, unitPrice: 0, frequency: 'monthly', taxable: true, amount: 0 },
      ] }],
    });
    expect(built.lineItems).toHaveLength(0);
    expect(built.subtotal).toBe(0);
  });
});

const NONTAXABLE_PROPOSAL = {
  title: 'HOA Pest + Lawn',
  taxRate: 0,
  buildings: [{ name: 'Commons', lineItems: [
    { description: 'Monthly pest', quantity: 1, unitPrice: 200, frequency: 'monthly', taxable: false, amount: 200 },
  ] }],
};

// trx mock for the customers ensure-commercial query inside the invoice path.
function makeInvoiceTrx({ propertyType } = {}) {
  const ops = { updates: [] };
  const trx = jest.fn(() => {
    const builder = {
      where() { return builder; },
      forShare() { return builder; },
      first: async () => (propertyType === undefined ? null : { property_type: propertyType }),
      update(patch) { ops.updates.push(patch); return Promise.resolve(1); },
    };
    return builder;
  });
  return { trx, ops };
}

// Owner 2026-10-30 (pipeline audit item 1, option A): an invoice-mode win makes no invoice; every visit bills when it
// is completed. The win keeps the agreement-vs-payer term check, and it still flags a taxable customer commercial.
describe('assertProposalTermsMatchPayer', () => {
  const { resolveForInvoice } = require('../services/payer');
  const withTerm = (paymentTerms) => ({ ...SIESTA_PROPOSAL, commercialTerms: { paymentTerms } });
  // Payer resolution runs TWICE when a payer exists (lock-then-re-resolve, codex #3297 r4b).
  const queuePayer = (value) => { resolveForInvoice.mockResolvedValueOnce(value).mockResolvedValueOnce(value); };
  beforeEach(() => resolveForInvoice.mockReset().mockResolvedValue({ payerId: null, paymentTerms: null }));

  test('no authored term: nothing to check, the payer is never read', async () => {
    const { trx } = makeInvoiceTrx({ propertyType: 'commercial' });
    await expect(assertProposalTermsMatchPayer({ trx, customerId: 'cust-1', proposal: SIESTA_PROPOSAL })).resolves.toBeUndefined();
    expect(resolveForInvoice).not.toHaveBeenCalled();
  });

  test('a payer on the same terms, or self-pay, passes', async () => {
    queuePayer({ payerId: 77, paymentTerms: 'net30' });
    await expect(assertProposalTermsMatchPayer({ trx: makeInvoiceTrx({}).trx, customerId: 'cust-1', proposal: withTerm('net30') })).resolves.toBeUndefined();
    expect(resolveForInvoice).toHaveBeenCalledTimes(2);
    await expect(assertProposalTermsMatchPayer({ trx: makeInvoiceTrx({}).trx, customerId: 'cust-1', proposal: withTerm('net15') })).resolves.toBeUndefined();
  });

  test('a payer contradicting the signed agreement REJECTS the win (codex #3297 r2d)', async () => {
    queuePayer({ payerId: 77, paymentTerms: 'net30' });
    await expect(assertProposalTermsMatchPayer({ trx: makeInvoiceTrx({}).trx, customerId: 'cust-1', proposal: withTerm('net15') }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('net15 payment terms but the customer bills through a payer on net30') });
  });

  test('a failed payer lookup aborts the win instead of passing as self-pay (codex 1A-i r3 P0)', async () => {
    resolveForInvoice.mockRejectedValueOnce(new Error('payer lookup down'));
    await expect(assertProposalTermsMatchPayer({ trx: makeInvoiceTrx({}).trx, customerId: 'cust-1', proposal: withTerm('net30') }))
      .rejects.toThrow('payer lookup down');
  });
});

// The win makes no invoice (option A), so each visit invoice of an invoice-mode proposal carries the agreement's Net
// term (pre-push Codex P1: without it a self-pay customer's first invoice was due on the visit date).
describe('proposalTermsDueDate', () => {
  const estimateConn = (row) => jest.fn(() => ({ where() { return this; }, first: async () => row }));
  const invoiceModeRow = (paymentTerms, extra = {}) => ({
    status: 'accepted', bill_by_invoice: true,
    estimate_data: { proposal: { ...SIESTA_PROPOSAL, enabled: true, commercialTerms: { paymentTerms } } },
    ...extra,
  });

  test('an accepted invoice-mode proposal on Net 15 / 30 / 60 is due that many calendar days after the base date', async () => {
    expect(await proposalTermsDueDate(estimateConn(invoiceModeRow('net30')), 'est-1', '2026-11-03')).toBe('2026-12-03');
    expect(await proposalTermsDueDate(estimateConn(invoiceModeRow('net60')), 'est-1', '2026-11-03')).toBe('2027-01-02');
    expect(await proposalTermsDueDate(estimateConn(invoiceModeRow('net15')), 'est-1', new Date('2026-12-20T15:00:00Z'))).toBe('2027-01-04');
  });

  test('anything else keeps the caller\'s own due date (null)', async () => {
    for (const row of [
      invoiceModeRow('due_on_receipt'), invoiceModeRow(undefined), invoiceModeRow('net30', { bill_by_invoice: false }),
      invoiceModeRow('net30', { status: 'sent' }), undefined,
      { status: 'accepted', bill_by_invoice: true, estimate_data: { recurring: { services: [] } } },
    ]) {
      expect(await proposalTermsDueDate(estimateConn(row), 'est-1', '2026-11-03')).toBeNull();
    }
    expect(await proposalTermsDueDate(estimateConn(invoiceModeRow('net30')), null, '2026-11-03')).toBeNull();
  });

  test('both completion lanes use it for the visit invoice due date (source pins)', () => {
    const read = (rel) => require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8');
    const legacy = read('../services/complete-scheduled-service.js');
    expect(legacy).toContain("proposalTermsDue = await require('./proposal-win').proposalTermsDueDate(");
    // Never before today on either lane: a backfill or a late form backdates the record day.
    expect(legacy.split('dueDate: proposalTermsDue || invoiceDueBaseDay(record.service_date),').length - 1).toBe(2);
    // A failed read mints nothing: the mint's catch releases the closeout for resume on every lane (pre-push Codex P1).
    expect(legacy).toContain("{ code: 'PROPOSAL_TERMS_UNREAD' }");
    const handler = legacy.slice(legacy.indexOf("if (invErr?.code === 'PROPOSAL_TERMS_UNREAD' && !invoice?.id) {"));
    expect(handler.length).toBeGreaterThan(0);
    expect(handler.slice(0, 900)).toContain('const termsReleased = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, invErr);');
    expect(handler.slice(0, 900)).toContain("code: 'proposal_terms_unread'");
    // A required lane takes the release in the required-mint branch; every other lane reaches this one.
    expect(legacy.indexOf("if (invErr?.code === 'PROPOSAL_TERMS_UNREAD' && !invoice?.id) {"))
      .toBeLessThan(legacy.indexOf("if (invErr?.code === 'BILLING_LANE_CHANGED' && !invoice?.id) {"));
    const sheet = read('../services/visit-completion-invoice.js');
    expect(sheet).toContain("require('./proposal-win').proposalTermsDueDate(trx, sourceEstimateId, invoiceDueBaseDay(visit.scheduled_date))");
    expect(sheet).toContain('dueDate: proposalTermsDue || dateOnly(visit.scheduled_date)');
  });
});

describe('flagProposalCustomerCommercialIfTaxable', () => {
  test('flags a non-commercial customer commercial when the proposal is taxable', async () => {
    const { trx, ops } = makeInvoiceTrx({ propertyType: 'single_family' });
    await flagProposalCustomerCommercialIfTaxable({ trx, customerId: 'cust-1', proposal: SIESTA_PROPOSAL });
    expect(ops.updates).toEqual([{ property_type: 'commercial' }]);
  });

  test('does NOT touch property_type when the proposal has no taxable lines, or the customer is already commercial', async () => {
    const plain = makeInvoiceTrx({ propertyType: 'single_family' });
    await flagProposalCustomerCommercialIfTaxable({ trx: plain.trx, customerId: 'cust-1', proposal: NONTAXABLE_PROPOSAL });
    expect(plain.ops.updates).toHaveLength(0);
    const commercial = makeInvoiceTrx({ propertyType: 'commercial' });
    await flagProposalCustomerCommercialIfTaxable({ trx: commercial.trx, customerId: 'cust-1', proposal: SIESTA_PROPOSAL });
    expect(commercial.ops.updates).toHaveLength(0);
  });
});

function makeTrx() {
  const ops = { updates: [], inserts: [] };
  const trx = jest.fn(() => {
    const builder = {
      _clause: null,
      where(clause) { this._clause = clause; return this; },
      update(patch) { ops.updates.push({ clause: this._clause, patch }); return Promise.resolve(1); },
      insert(row) {
        ops.inserts.push({ row });
        return { returning: () => Promise.resolve([{ id: 'new-cust', ...row }]) };
      },
    };
    return builder;
  });
  return { trx, ops };
}

describe('ensureCustomerForProposalWin', () => {
  beforeEach(() => {
    adminCustomers.ensureCustomerAccount.mockReset();
    createDefaultCustomerRows.mockClear();
  });

  test('creates a new commercial customer when no account matches', async () => {
    adminCustomers.ensureCustomerAccount.mockResolvedValue({ accountId: 'acct-1', existingCustomer: null });
    const { trx, ops } = makeTrx();
    const estimate = { id: 5, customer_name: 'Siesta Key HOA', customer_phone: '9415551234', customer_email: 'BOARD@example.com', address: '100 Beach Rd' };

    const res = await ensureCustomerForProposalWin({ trx, estimate, proposal: SIESTA_PROPOSAL });

    expect(res).toEqual({ customerId: 'new-cust', created: true });
    expect(ops.inserts).toHaveLength(1);
    expect(ops.inserts[0].row).toMatchObject({
      account_id: 'acct-1',
      is_primary_profile: true,
      pipeline_stage: 'active_customer',
      member_since: '2026-06-20',
      lead_source: 'commercial_proposal',
      property_type: 'commercial',
      active: true,
      email: 'board@example.com',
    });
    expect(createDefaultCustomerRows).toHaveBeenCalledWith(trx, 'new-cust');
  });

  test('NEVER reuses a phone-matched customer — creates a new commercial profile under the matched account (phone != property; money-correctness)', async () => {
    // Even a COMMERCIAL phone match (e.g. a property manager's OTHER property)
    // must not be reused — reusing it could invoice this proposal to the wrong
    // property/payer. We create a distinct commercial profile under the matched
    // account instead; the existing customer row is left untouched.
    adminCustomers.ensureCustomerAccount.mockResolvedValue({
      accountId: 'acct-1',
      existingCustomer: { id: 'cust-other', pipeline_stage: 'active_customer', property_type: 'commercial' },
    });
    const { trx, ops } = makeTrx();
    const res = await ensureCustomerForProposalWin({
      trx, estimate: { id: 5, customer_phone: '9415551234' }, proposal: SIESTA_PROPOSAL,
    });
    expect(res).toEqual({ customerId: 'new-cust', created: true });
    expect(ops.updates).toHaveLength(0); // existing customer untouched (never billed/flipped)
    expect(ops.inserts).toHaveLength(1);
    // Secondary profile under the matched account (its own primary is the existing row).
    expect(ops.inserts[0].row).toMatchObject({ account_id: 'acct-1', is_primary_profile: false, property_type: 'commercial' });
  });

  test('throws a controlled error when the estimate has no phone', async () => {
    const { trx } = makeTrx();
    await expect(ensureCustomerForProposalWin({
      trx, estimate: { id: 5, customer_email: 'board@example.com' }, proposal: { preparedFor: 'HOA', buildings: [] },
    })).rejects.toThrow(/phone number/i);
    expect(adminCustomers.ensureCustomerAccount).not.toHaveBeenCalled();
  });
});

function makeCustomerTrx(customerRow) {
  const ops = { updates: [] };
  const trx = jest.fn(() => {
    const builder = {
      where() { return builder; },
      first: async () => customerRow || null,
      update(patch) { ops.updates.push(patch); return Promise.resolve(1); },
    };
    return builder;
  });
  return { trx, ops };
}

describe('promoteLinkedCustomerForProposalWin', () => {
  test('promotes a pre-linked lead-stage customer', async () => {
    const { trx, ops } = makeCustomerTrx({ pipeline_stage: 'new_lead', member_since: null, active: true, churned_at: null });
    await promoteLinkedCustomerForProposalWin({ trx, customerId: 'cust-1' });
    expect(ops.updates).toHaveLength(1);
    expect(ops.updates[0]).toMatchObject({ pipeline_stage: 'active_customer', member_since: '2026-06-20' });
  });

  test('reactivates a pre-linked churned/inactive customer (keeps original start)', async () => {
    const { trx, ops } = makeCustomerTrx({ pipeline_stage: 'churned', member_since: '2024-03-01', active: false, churned_at: '2025-10-01' });
    await promoteLinkedCustomerForProposalWin({ trx, customerId: 'cust-1' });
    expect(ops.updates[0]).toMatchObject({
      pipeline_stage: 'active_customer',
      active: true,
      churned_at: null,
      churn_reason: null,
      churn_episode_id: null,
    });
    expect(ops.updates[0]).not.toHaveProperty('member_since'); // original start preserved
  });

  test('reactivates a pre-linked past_customer (keeps original start)', async () => {
    const { trx, ops } = makeCustomerTrx({ pipeline_stage: 'past_customer', member_since: '2024-03-01', active: true, churned_at: null });
    await promoteLinkedCustomerForProposalWin({ trx, customerId: 'cust-1' });
    expect(ops.updates[0]).toMatchObject({ pipeline_stage: 'active_customer' });
    expect(ops.updates[0]).not.toHaveProperty('member_since'); // original start preserved
  });

  test('no-op for an already-active real customer', async () => {
    const { trx, ops } = makeCustomerTrx({ pipeline_stage: 'active_customer', member_since: '2024-01-01', active: true, churned_at: null });
    await promoteLinkedCustomerForProposalWin({ trx, customerId: 'cust-1' });
    expect(ops.updates).toHaveLength(0);
  });

  test('un-archives a pre-linked soft-deleted customer', async () => {
    const { trx, ops } = makeCustomerTrx({ pipeline_stage: 'active_customer', member_since: '2024-01-01', active: true, churned_at: null, deleted_at: '2025-05-01' });
    await promoteLinkedCustomerForProposalWin({ trx, customerId: 'cust-1' });
    expect(ops.updates[0]).toEqual({ deleted_at: null });
  });

  test('no-op (no throw) when the customer row is missing', async () => {
    const { trx, ops } = makeCustomerTrx(null);
    await promoteLinkedCustomerForProposalWin({ trx, customerId: 'gone' });
    expect(ops.updates).toHaveLength(0);
  });
});

describe('resolveProposalWinContact', () => {
  test('prefers proposal preparedFor/address then estimate fields, lowercases email', () => {
    const c = resolveProposalWinContact(
      { customer_name: 'Fallback', customer_phone: '9415550000', customer_email: 'A@B.COM', address: 'Est Addr' },
      { preparedFor: 'Siesta Key HOA', propertyAddress: '100 Beach Rd' },
    );
    expect(c).toEqual({
      name: 'Siesta Key HOA',
      phone: '9415550000',
      email: 'a@b.com',
      address: '100 Beach Rd',
      companyName: 'Siesta Key HOA',
    });
  });

  test('clamps long names/phone/email to DB column widths', () => {
    const c = resolveProposalWinContact(
      { customer_phone: '1'.repeat(40), customer_email: `${'a'.repeat(200)}@b.com` },
      { preparedFor: 'X'.repeat(200) },
    );
    expect(c.name).toHaveLength(50);       // first_name varchar(50)
    expect(c.companyName).toHaveLength(150); // company_name varchar(150)
    expect(c.phone).toHaveLength(20);      // phone varchar(20)
    expect(c.email).toHaveLength(150);     // email varchar(150)
  });
});

// Owner 2026-10-28: the won proposal's building use decides the tax on the account's later visits
// (TaxCalculator, GATE_BUILDING_USE_TAX), so every win records it; no pick leaves the customer as it is.
describe('recordProposalBuildingUse', () => {
  test("writes the won proposal's building use onto the customer", async () => {
    const { trx, ops } = makeTrx();
    await recordProposalBuildingUse({ trx, customerId: 'cust-1', proposal: { buildingUse: 'residential' } });
    expect(ops.updates).toEqual([{ clause: { id: 'cust-1' }, patch: { building_use: 'residential' } }]);
  });

  test('leaves the customer alone with no pick, an unknown pick, or no customer', async () => {
    const { trx, ops } = makeTrx();
    await recordProposalBuildingUse({ trx, customerId: 'cust-1', proposal: {} });
    await recordProposalBuildingUse({ trx, customerId: 'cust-1', proposal: { buildingUse: 'warehouse' } });
    await recordProposalBuildingUse({ trx, customerId: null, proposal: { buildingUse: 'residential' } });
    expect(ops.updates).toHaveLength(0);
  });
});
