// Deposit credits are PRIOR PAYMENT, not price reductions: they must not
// shrink the commercial tax base or fold into discount reporting. The
// category: 'deposit_credit' line is excluded from the discount machinery
// and subtracted AFTER tax in InvoiceService.create.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-06-12'),
  addETDays: jest.fn(() => new Date('2026-07-12T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
const mockPendingDepositCredit = jest.fn();
const mockConsumeDepositCredit = jest.fn();
jest.mock('../services/estimate-deposits', () => ({
  pendingDepositCredit: (...args) => mockPendingDepositCredit(...args),
  consumeDepositCredit: (...args) => mockConsumeDepositCredit(...args),
}));
const mockTriggerNotification = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));
const mockRescheduleForInvoiceEdit = jest.fn();
jest.mock('../services/invoice-followups', () => ({
  scheduleForInvoice: jest.fn(),
  stopSequence: jest.fn(),
  rescheduleForInvoiceEdit: (...args) => mockRescheduleForInvoiceEdit(...args),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function setupDb({ customer }) {
  let insertedInvoice = null;
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => customer),
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return {
            returning: jest.fn(async () => [{ id: 'invoice-1', ...data }]),
          };
        }),
      };
      return q;
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { getInsertedInvoice: () => insertedInvoice };
}

describe('deposit credit is after-tax prior payment, never a discount', () => {
  beforeEach(() => jest.clearAllMocks());

  const serviceLine = {
    description: 'First service application',
    quantity: 1,
    unit_price: 200,
  };

  it('COMMERCIAL: tax is computed on the full charge, then the deposit subtracts after tax', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine],
      taxRate: 0.07,
      depositCredit: { amount: 70 },
    });
    const row = getInsertedInvoice();
    expect(row.subtotal).toBe(200);
    expect(row.discount_amount).toBe(0);          // deposit is NOT a discount
    expect(row.tax_amount).toBe(14);              // 7% of 200, not of 130
    expect(row.total).toBe(144);                  // 200 + 14 − 70
    // The line stays visible on the invoice.
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(true);
  });

  it('RESIDENTIAL: no tax, total is charge minus deposit, discount stays zero', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine],
      depositCredit: { amount: 70 },
    });
    const row = getInsertedInvoice();
    expect(row.subtotal).toBe(200);
    expect(row.discount_amount).toBe(0);
    expect(row.tax_amount).toBe(0);
    expect(row.total).toBe(130);
  });

  it('caller-supplied deposit_credit LINE ITEMS are rejected — only the ledger-backed param may mint one (P1)', async () => {
    setupDb({ customer: { id: 'cust-1', property_type: 'residential' } });
    // Admin manual/batch invoice routes pass request line items straight
    // through; a hand-crafted deposit_credit line would subtract real
    // dollars with no estimate_deposits ledger backing.
    await expect(InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, {
        description: 'Deposit credit (paid at acceptance)',
        quantity: 1,
        unit_price: -70,
        category: 'deposit_credit',
      }],
    })).rejects.toThrow(/depositCredit parameter/);
  });

  it('depositCredit REQUEST is capped at the POST-discount invoice value — discounted dollars never consume ledger money (P1)', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    const invoice = await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Discounted first visit',
      lineItems: [
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Promo', quantity: 1, unit_price: -80 }, // pre-tax discount
      ],
      depositCredit: { amount: 99 },
    });
    const row = getInsertedInvoice();
    // $100 − $80 discount = $20 of invoice value. Only $20 of the requested
    // $99 applies; create() reports the effective amount so the caller
    // consumes exactly that and the other $79 stays on the ledger.
    expect(invoice.applied_deposit_credit).toBe(20);
    expect(row.total).toBe(0);
    const credit = JSON.parse(row.line_items).find((i) => i.category === 'deposit_credit');
    expect(credit.unit_price).toBe(-20);
    expect(row.discount_amount).toBe(80);
  });

  it('depositCredit REQUEST on a commercial invoice caps at the after-tax value, not the pre-tax subtotal', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    const invoice = await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Discounted first visit',
      lineItems: [
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Promo', quantity: 1, unit_price: -80 },
      ],
      taxRate: 0.07,
      depositCredit: { amount: 99 },
    });
    const row = getInsertedInvoice();
    // After-discount $20 + 7% tax $1.40 = $21.40 of absorbable value.
    expect(invoice.applied_deposit_credit).toBe(21.4);
    expect(row.total).toBe(0);
  });

  it('the depositCredit line carries its estimate_id stamp — the application record void-restore reads (P1)', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First visit',
      lineItems: [{ description: 'Service', quantity: 1, unit_price: 100 }],
      depositCredit: { amount: 49, estimateId: 'est-1' },
    });
    const credit = JSON.parse(getInsertedInvoice().line_items).find((i) => i.category === 'deposit_credit');
    expect(credit.estimate_id).toBe('est-1');
  });

  it('a zero-value invoice applies NO depositCredit — the full balance rolls forward', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    const invoice = await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Fully discounted visit',
      lineItems: [
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Promo', quantity: 1, unit_price: -100 },
      ],
      depositCredit: { amount: 99 },
    });
    const row = getInsertedInvoice();
    expect(invoice.applied_deposit_credit).toBe(0);
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(false);
    expect(row.total).toBe(0);
  });

  it('REGRESSION GUARD: a plain negative line WITHOUT the category still behaves as a pre-tax discount', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, { description: 'Promo', quantity: 1, unit_price: -70 }],
      taxRate: 0.07,
    });
    const row = getInsertedInvoice();
    expect(row.discount_amount).toBe(70);
    expect(row.tax_amount).toBe(9.1);             // 7% of 130
    expect(row.total).toBe(139.1);
  });
});

describe('createFromService — estimate-deposit roll-forward', () => {
  beforeEach(() => jest.clearAllMocks());

  // setupDb plus the service-record spine createFromService walks, and a
  // pass-through transaction (the atomicity itself is exercised against the
  // real knex by the converter/accept paths; here we test the wiring).
  function setupServiceDb({ sourceEstimateId = 'est-1' } = {}) {
    let insertedInvoice = null;
    db.mockImplementation((table) => {
      if (table === 'service_records') {
        const q = {
          where: jest.fn(() => q),
          andWhere: jest.fn(() => q),
          leftJoin: jest.fn(() => q),
          select: jest.fn(() => q),
          first: jest.fn(async () => ({
            id: 'sr-1', customer_id: 'cust-1', scheduled_service_id: 'ss-1',
            service_type: 'One-Time Pest Treatment', technician_id: null,
            service_date: '2026-06-12', tech_name: null,
          })),
        };
        return q;
      }
      if (table === 'service_products' || table === 'service_photos') {
        const q = {
          where: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          select: jest.fn(async () => []),
        };
        return q;
      }
      if (table === 'scheduled_services') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ source_estimate_id: sourceEstimateId })) };
        return q;
      }
      if (table === 'customers') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ id: 'cust-1', property_type: 'residential' })) };
        return q;
      }
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => null),
          insert: jest.fn((data) => {
            insertedInvoice = data;
            return { returning: jest.fn(async () => [{ id: 'invoice-1', ...data }]) };
          }),
        };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    db.transaction = jest.fn(async (fn) => fn(db));
    return { getInsertedInvoice: () => insertedInvoice };
  }

  it('credits unapplied deposit money against the completed-visit invoice (one-time pay-at-visit lands here)', async () => {
    const { getInsertedInvoice } = setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue({ amount: 99 });
    mockConsumeDepositCredit.mockResolvedValue(99);

    await InvoiceService.createFromService('sr-1', { amount: 250, description: 'Rodent exclusion' });

    const row = getInsertedInvoice();
    const lines = JSON.parse(row.line_items);
    expect(lines.some((i) => i.category === 'deposit_credit' && i.unit_price === -99 && i.estimate_id === 'est-1')).toBe(true);
    expect(row.total).toBe(151); // 250 − 99, residential no tax
    expect(mockConsumeDepositCredit).toHaveBeenCalledWith(
      expect.objectContaining({ estimateId: 'est-1', amount: 99, invoiceId: 'invoice-1' }),
    );
  });

  it('caps the credit at the invoice value — the remainder stays on the ledger for the next visit', async () => {
    const { getInsertedInvoice } = setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue({ amount: 99 });
    mockConsumeDepositCredit.mockResolvedValue(60);

    await InvoiceService.createFromService('sr-1', { amount: 60, description: 'Small follow-up' });

    const row = getInsertedInvoice();
    const lines = JSON.parse(row.line_items);
    expect(lines.some((i) => i.category === 'deposit_credit' && i.unit_price === -60)).toBe(true);
    expect(mockConsumeDepositCredit).toHaveBeenCalledWith(expect.objectContaining({ amount: 60 }));
  });

  it('no traceable estimate or no balance = plain invoice, deposit machinery untouched', async () => {
    setupServiceDb({ sourceEstimateId: null });
    await InvoiceService.createFromService('sr-1', { amount: 250 });
    expect(mockPendingDepositCredit).not.toHaveBeenCalled();

    setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue(null);
    const inv = await InvoiceService.createFromService('sr-1', { amount: 250 });
    expect(inv.total).toBe(250);
    expect(mockConsumeDepositCredit).not.toHaveBeenCalled();
  });

  it('an allocation mismatch never blocks visit invoicing — falls back to an uncredited invoice and alerts', async () => {
    const { getInsertedInvoice } = setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue({ amount: 99 });
    mockConsumeDepositCredit.mockResolvedValue(0); // ledger flipped under us, twice

    const inv = await InvoiceService.createFromService('sr-1', { amount: 250 });

    expect(inv).toBeTruthy();
    const row = getInsertedInvoice();
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(false);
    expect(row.total).toBe(250);
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
  });
});

describe('line-item edits on deposit-credited invoices are blocked (P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  function invoicesOnlyDb(storedInvoice) {
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          first: jest.fn(async () => storedInvoice),
        };
        return q;
      }
      // The editability guard checks for an active payment plan before the
      // deposit-credit guard fires; these drafts have none.
      if (table === 'payment_plans') {
        const q = {
          where: jest.fn(() => q),
          first: jest.fn(async () => null),
        };
        return q;
      }
      // The applied-money fence probes the payments ledger on retotals;
      // these drafts have no recorded money.
      if (table === 'payments') {
        const q = {
          whereIn: jest.fn(() => q),
          whereRaw: jest.fn(() => q),
          first: jest.fn(async () => null),
        };
        return q;
      }
      // The in-flight-touch fence probes the follow-up sequence; no touch
      // is mid-send for these drafts.
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
  }

  it('rejects line-item edits when the stored invoice carries a deposit_credit line — void-and-recreate is the supported path', async () => {
    invoicesOnlyDb({
      id: 'inv-1',
      status: 'draft',
      customer_id: 'cust-1',
      line_items: JSON.stringify([
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -49, amount: -49, category: 'deposit_credit', estimate_id: 'est-1' },
      ]),
    });
    // The edit recalculation can neither re-cap the credit nor re-balance
    // the consumed estimate_deposits ledger — shrinking the invoice would
    // leave credited_amount over-applied with no roll-forward/refund path.
    await expect(InvoiceService.update('inv-1', {
      line_items: [{ description: 'Service', quantity: 1, unit_price: 50 }],
    })).rejects.toThrow(/deposit credit/);
  });

  it('rejects edits that introduce a deposit_credit line by hand — only create() may mint one, backed by the ledger', async () => {
    invoicesOnlyDb({ id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]' });
    await expect(InvoiceService.update('inv-1', {
      line_items: [{ description: 'Manual credit', quantity: 1, unit_price: -49, amount: -49, category: 'deposit_credit' }],
    })).rejects.toThrow(/deposit credit/);
  });
});

describe('editability guard blocks updates once an invoice leaves the safe-to-edit window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Every edit now runs runEdit inside a transaction (invoice row lock is
    // the serialization point against dun sends) — pass-through.
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  // Re-reads the CURRENT invoice row at write time; some cases also probe
  // payment_plans for an active plan and the payments ledger for the
  // applied-money fence.
  function guardDb(storedInvoice, { activePlan = null, appliedMoneyRow = null, inFlightTouch = null } = {}) {
    const captured = { paymentsQ: null };
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => storedInvoice) };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => activePlan) };
        return q;
      }
      if (table === 'payments') {
        const q = {
          whereIn: jest.fn(() => q),
          whereRaw: jest.fn(() => q),
          first: jest.fn(async () => appliedMoneyRow),
        };
        captured.paymentsQ = q;
        return q;
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => inFlightTouch) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    return captured;
  }

  it('refuses to rewrite an invoice that already raced to paid', async () => {
    guardDb({ id: 'inv-1', status: 'paid', customer_id: 'cust-1', line_items: '[]' });
    await expect(InvoiceService.update('inv-1', { notes: 'late edit' }))
      .rejects.toThrow(/can be edited/);
  });

  it('refuses to rewrite an invoice with payment processing', async () => {
    guardDb({ id: 'inv-1', status: 'processing', customer_id: 'cust-1', line_items: '[]' });
    await expect(InvoiceService.update('inv-1', { notes: 'late edit' }))
      .rejects.toThrow(/can be edited/);
  });

  it('refuses to retotal a DELIVERED invoice once a customer has a live PaymentIntent', async () => {
    // The 2026-07-17 sent-editable ruling opened delivered invoices to edits,
    // but the stale-pay-page fence is unchanged: once /pay/:token /setup has
    // stamped a PI, a retotal could let the customer confirm the old amount.
    guardDb({ id: 'inv-1', status: 'sent', customer_id: 'cust-1', line_items: '[]', stripe_payment_intent_id: 'pi_123' });
    await expect(InvoiceService.update('inv-1', { line_items: [{ description: 'X', quantity: 1, unit_price: 10 }] }))
      .rejects.toThrow(/already started paying/);
  });

  it('refuses any edit while a follow-up touch is mid-send (fresh claim on the sequence)', async () => {
    // fireStep stamps touch_claimed_at before rendering/sending; an edit
    // committing mid-send would make the reminder quote amounts the pay
    // page no longer charges (codex r3).
    guardDb(
      { id: 'inv-1', status: 'sent', customer_id: 'cust-1', line_items: '[]' },
      { inFlightTouch: { id: 'seq-1' } },
    );
    await expect(InvoiceService.update('inv-1', { notes: 'mid-send edit' }))
      .rejects.toThrow(/sending right now/);
  });

  it('refuses to retotal a delivered invoice that carries a recorded partial payment (payment_recorded_at)', async () => {
    // A partial in-person prepayment reduces total, stamps payment_recorded_at
    // and keeps the invoice collectible — a retotal from the stored lines
    // would erase the reduction and demand collected money again (codex P1).
    guardDb({ id: 'inv-1', status: 'sent', customer_id: 'cust-1', line_items: '[]', payment_recorded_at: '2026-07-16T12:00:00Z' });
    await expect(InvoiceService.update('inv-1', { line_items: [{ description: 'X', quantity: 1, unit_price: 10 }] }))
      .rejects.toThrow(/payment already applied/);
  });

  it('refuses to retotal a delivered invoice with a paid ledger row even without payment_recorded_at', async () => {
    guardDb(
      { id: 'inv-1', status: 'viewed', customer_id: 'cust-1', line_items: '[]' },
      { appliedMoneyRow: { id: 'pay-1', status: 'paid' } },
    );
    await expect(InvoiceService.update('inv-1', { line_items: [{ description: 'X', quantity: 1, unit_price: 10 }] }))
      .rejects.toThrow(/payment already applied/);
  });

  it('refuses to retotal a dispute-reopened invoice (payment sits in disputed)', async () => {
    // A chargeback reopens the invoice as overdue and clears its PI; the
    // dispute-won handler restores the original payment against whatever the
    // invoice then says — amounts must stay frozen while disputed (codex P1).
    const captured = guardDb(
      { id: 'inv-1', status: 'overdue', customer_id: 'cust-1', line_items: '[]' },
      { appliedMoneyRow: { id: 'pay-1', status: 'disputed' } },
    );
    await expect(InvoiceService.update('inv-1', { tax_rate: 0.07 }))
      .rejects.toThrow(/payment dispute/);
    // The ledger probe must cover every payment→invoice linkage key the
    // webhook supports — the dispute handler stamps dispute_invoice_id, not
    // invoice_id (codex r2).
    const [probeSql, probeBindings] = captured.paymentsQ.whereRaw.mock.calls[0];
    expect(probeSql).toContain("'invoice_id'");
    expect(probeSql).toContain("'dispute_invoice_id'");
    expect(probeSql).toContain("'waves_invoice_id'");
    expect(probeBindings).toEqual(['inv-1', 'inv-1', 'inv-1']);
  });

  it('refuses to retotal once a customer has a live PaymentIntent', async () => {
    guardDb({ id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]', stripe_payment_intent_id: 'pi_123' });
    await expect(InvoiceService.update('inv-1', { line_items: [{ description: 'X', quantity: 1, unit_price: 10 }] }))
      .rejects.toThrow(/already started paying/);
  });

  it('refuses to edit an invoice tied to an annual prepay term', async () => {
    guardDb({ id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]', annual_prepay_term_id: 'term-1' });
    await expect(InvoiceService.update('inv-1', { notes: 'x' }))
      .rejects.toThrow(/annual prepay term/);
  });

  it('refuses to edit an invoice with an active payment plan', async () => {
    guardDb({ id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]' }, { activePlan: { id: 'pp-1' } });
    await expect(InvoiceService.update('inv-1', { notes: 'x' }))
      .rejects.toThrow(/active payment plan/);
  });

  it('fails closed when the atomic write matches no row (status/PI/prepay raced after the guard read)', async () => {
    const stored = { id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]' };
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          // Predicate-guarded write no longer matches — simulates a concurrent
          // worker stamping the PI / flipping status / creating a payment plan
          // between read and write.
          update: jest.fn(() => ({ returning: jest.fn(async () => []) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    await expect(InvoiceService.update('inv-1', { notes: 'late' }))
      .rejects.toThrow(/can be edited/);
  });

  it('allows a metadata-only edit on a clean draft (no line_items, no retotal)', async () => {
    const stored = { id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]' };
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored, notes: 'updated' }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    const result = await InvoiceService.update('inv-1', { notes: 'updated' });
    expect(result.notes).toBe('updated');
  });

  it('allows an edit on a delivered (sent) invoice and writes the edited-after-send audit row', async () => {
    // Owner ruling 2026-07-17: delivered-but-unpaid invoices are editable so
    // Adam can fix and resend them. The edit must leave an activity_log trail
    // because the emailed copy is stale until the resend goes out.
    const stored = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', invoice_number: 'INV-100', line_items: '[]' };
    const activityInsert = jest.fn(async () => [1]);
    let invoicesQ = null;
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored, notes: 'updated' }]) })),
        };
        invoicesQ = q;
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    const result = await InvoiceService.update('inv-1', { notes: 'updated' });
    expect(result.notes).toBe('updated');
    // The atomic write predicate must carry the full editable-status list —
    // paid/processing/void/sending must never re-enter it.
    expect(invoicesQ.whereIn).toHaveBeenCalledWith('status', ['draft', 'scheduled', 'sent', 'viewed', 'overdue']);
    expect(activityInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice_edited_after_send',
      customer_id: 'cust-1',
    }));
  });

  it('still allows metadata edits (notes/due date) when a partial payment is recorded — only retotals are fenced', async () => {
    const stored = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', invoice_number: 'INV-101', line_items: '[]', payment_recorded_at: '2026-07-16T12:00:00Z', due_date: '2026-07-30' };
    const activityInsert = jest.fn(async () => [1]);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored, notes: 'call before arrival' }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    const result = await InvoiceService.update('inv-1', { notes: 'call before arrival' });
    expect(result.notes).toBe('call before arrival');
  });

  it('re-anchors an active follow-up sequence when a delivered due date changes', async () => {
    const stored = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', invoice_number: 'INV-102', line_items: '[]', due_date: '2026-07-30' };
    const activityInsert = jest.fn(async () => [1]);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored, due_date: '2026-08-15' }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    await InvoiceService.update('inv-1', { due_date: '2026-08-15' });
    expect(mockRescheduleForInvoiceEdit).toHaveBeenCalledWith(
      'inv-1',
      { previousDueDate: '2026-07-30', newDueDate: '2026-08-15' },
      expect.anything(), // the edit's own transaction — reschedule commits atomically with it
    );
  });

  it('reschedules from the LOCKED due date when a concurrent edit moved it first (stale-form save)', async () => {
    // Admin A moved the due date to 08-15 (and shifted the anchor) while
    // admin B's form still shows 07-30. B's save writes 07-30 back — the
    // comparison must run against the LOCKED row (08-15), not B's pre-lock
    // snapshot (07-30 vs 07-30 → no-op), or the sequence stays on A's
    // timeline while the invoice shows B's date (codex r7).
    const preRead = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', invoice_number: 'INV-105', line_items: '[]', due_date: '2026-07-30' };
    const lockedRow = { ...preRead, due_date: '2026-08-15' };
    const activityInsert = jest.fn(async () => [1]);
    const invoicesFirst = jest.fn()
      .mockResolvedValueOnce(preRead)
      .mockResolvedValue(lockedRow);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: invoicesFirst,
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...preRead }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    await InvoiceService.update('inv-1', { due_date: '2026-07-30' });
    expect(invoicesFirst).toHaveBeenCalledTimes(2); // pre-read + in-txn lock read
    expect(mockRescheduleForInvoiceEdit).toHaveBeenCalledWith(
      'inv-1',
      { previousDueDate: '2026-08-15', newDueDate: '2026-07-30' },
      expect.anything(),
    );
  });

  it('does NOT re-anchor the follow-up sequence when the due date is unchanged', async () => {
    const stored = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', invoice_number: 'INV-103', line_items: '[]', due_date: '2026-07-30' };
    const activityInsert = jest.fn(async () => [1]);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    // The editor always posts due_date; same calendar day must not re-anchor
    // a send-anchored cadence onto the due-date formula.
    await InvoiceService.update('inv-1', { due_date: '2026-07-30' });
    expect(mockRescheduleForInvoiceEdit).not.toHaveBeenCalled();
  });

  it('writes the audit row when a scheduled send completes mid-edit (saved row came back sent)', async () => {
    // The atomic predicate deliberately allows this race now that sent is
    // editable — but the audit trail must key on the SAVED status, not the
    // stale pre-read draft status (codex r2 P2).
    const stored = { id: 'inv-1', status: 'scheduled', customer_id: 'cust-1', invoice_number: 'INV-104', line_items: '[]' };
    const activityInsert = jest.fn(async () => [1]);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored, status: 'sent', notes: 'updated' }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    await InvoiceService.update('inv-1', { notes: 'updated' });
    expect(activityInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice_edited_after_send',
    }));
  });

  it('does NOT write the edited-after-send audit row for a draft edit', async () => {
    const stored = { id: 'inv-1', status: 'draft', customer_id: 'cust-1', line_items: '[]' };
    const activityInsert = jest.fn(async () => [1]);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          whereIn: jest.fn(() => q),
          whereNull: jest.fn(() => q),
          whereNotExists: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          first: jest.fn(async () => stored),
          update: jest.fn(() => ({ returning: jest.fn(async () => [{ ...stored, notes: 'updated' }]) })),
        };
        return q;
      }
      if (table === 'payment_plans') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      if (table === 'activity_log') {
        return { insert: activityInsert };
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    await InvoiceService.update('inv-1', { notes: 'updated' });
    expect(activityInsert).not.toHaveBeenCalled();
  });
});
