jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ create: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-06-20' }));
jest.mock('../routes/admin-customers', () => ({
  ensureCustomerAccount: jest.fn(),
  createDefaultCustomerRows: jest.fn().mockResolvedValue(),
}));

const InvoiceService = require('../services/invoice');
const adminCustomers = require('../routes/admin-customers');
const {
  buildProposalFirstInvoice,
  createProposalAcceptanceInvoice,
  ensureCustomerForProposalWin,
  promoteLinkedCustomerForProposalWin,
  resolveProposalWinContact,
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
      first: async () => (propertyType === undefined ? null : { property_type: propertyType }),
      update(patch) { ops.updates.push(patch); return Promise.resolve(1); },
    };
    return builder;
  });
  return { trx, ops };
}

describe('createProposalAcceptanceInvoice', () => {
  beforeEach(() => InvoiceService.create.mockReset());

  test('creates the invoice from proposal lines with the blended rate', async () => {
    InvoiceService.create.mockResolvedValue({ id: 7, invoice_number: 'WPC-2026-0007', token: 'tok', total: 2259.7 });
    const { trx, ops } = makeInvoiceTrx({ propertyType: 'commercial' });
    const invoice = await createProposalAcceptanceInvoice({
      trx, estimate: { id: 42 }, proposal: SIESTA_PROPOSAL, customerId: 'cust-1',
    });

    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    const args = InvoiceService.create.mock.calls[0][0];
    expect(args.customerId).toBe('cust-1');
    expect(args.database).toBe(trx);
    expect(args.title).toBe('Siesta Key Proposal');
    expect(args.lineItems).toHaveLength(3);
    expect(Math.round(2210 * args.taxRate * 100) / 100).toBe(49.7);
    expect(invoice.invoice_number).toBe('WPC-2026-0007');
    expect(ops.updates).toHaveLength(0); // already commercial → no re-flag
  });

  test('flags a non-commercial customer commercial when the proposal is taxable', async () => {
    InvoiceService.create.mockResolvedValue({ id: 9, invoice_number: 'WPC-2026-0009', total: 1 });
    const { trx, ops } = makeInvoiceTrx({ propertyType: 'single_family' });
    await createProposalAcceptanceInvoice({
      trx, estimate: { id: 42 }, proposal: SIESTA_PROPOSAL, customerId: 'cust-1',
    });
    expect(ops.updates).toEqual([{ property_type: 'commercial' }]);
  });

  test('does NOT touch property_type when the proposal has no taxable lines', async () => {
    InvoiceService.create.mockResolvedValue({ id: 9, invoice_number: 'WPC-2026-0009', total: 200 });
    const { trx, ops } = makeInvoiceTrx({ propertyType: 'single_family' });
    await createProposalAcceptanceInvoice({
      trx, estimate: { id: 42 }, proposal: NONTAXABLE_PROPOSAL, customerId: 'cust-1',
    });
    expect(ops.updates).toHaveLength(0);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
  });

  test('returns null and skips InvoiceService when there are no billable lines', async () => {
    const { trx } = makeInvoiceTrx({ propertyType: 'commercial' });
    const invoice = await createProposalAcceptanceInvoice({
      trx, estimate: { id: 42 }, customerId: 'cust-1',
      proposal: { taxRate: 0, buildings: [{ name: 'A', lineItems: [] }] },
    });
    expect(invoice).toBeNull();
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  test('throws without a customer', async () => {
    const { trx } = makeInvoiceTrx({ propertyType: 'commercial' });
    await expect(createProposalAcceptanceInvoice({
      trx, estimate: { id: 42 }, proposal: SIESTA_PROPOSAL, customerId: null,
    })).rejects.toThrow(/customer is required/i);
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
    adminCustomers.createDefaultCustomerRows.mockClear();
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
    expect(adminCustomers.createDefaultCustomerRows).toHaveBeenCalledWith(trx, 'new-cust');
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
    });
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
