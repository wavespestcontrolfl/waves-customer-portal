/**
 * returnAppliedCreditOnRefund — estimate-deposit restore on the refund
 * terminal transition.
 *
 * Refund is the ONLY exit for a paid deposit-credited invoice (voidInvoice
 * refuses paid invoices), and the void paths' restoreDepositCreditForVoidedInvoice
 * can never run on a 'refunded' invoice — so before this, a full refund
 * stranded the consumed deposit 'credited' against the refunded invoice
 * forever (money-path audit 2026-07-06). Contract:
 *   - the transition WINNER (non-terminal → 'refunded', under the row lock)
 *     restores the invoice's consumed deposit credit in the same trx
 *   - a replayed event (invoice already refunded/void/canceled) never
 *     re-restores — exactly-once across webhook replays and the
 *     admin-refund/webhook pair
 *   - a restore shortfall THROWS so the caller's transaction rolls back
 *     (webhook → HTTP 500 → Stripe retries), mirroring the void contract
 *   - pre-settlement refunds (invoice still 'sent'/'viewed') restore too —
 *     the deposit was consumed at MINT time, not at payment
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
const mockRestoreDepositCredit = jest.fn(async () => 0);
jest.mock('../services/estimate-deposits', () => ({
  restoreDepositCreditForVoidedInvoice: (...args) => mockRestoreDepositCredit(...args),
}));

const { returnAppliedCreditOnRefund } = require('../services/customer-credit');

function makeTrx(invRow) {
  const updates = [];
  const trx = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'invoices' ? invRow : undefined));
    q.update = jest.fn(async (payload) => { updates.push({ table, payload }); return 1; });
    q.insert = jest.fn(async () => [1]);
    return q;
  };
  trx.fn = { now: () => 'NOW' };
  trx.updates = updates;
  return trx;
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'WPC-2026-1042',
    status: 'paid',
    credit_applied: 0,
    line_items: JSON.stringify([
      { description: 'First application', amount: 150 },
      { description: 'Deposit credit', amount: -49, category: 'deposit_credit', estimate_id: 'est-1' },
    ]),
    ...overrides,
  };
}

describe('returnAppliedCreditOnRefund — deposit restore', () => {
  beforeEach(() => jest.clearAllMocks());

  it('restores the consumed deposit credit when it wins the refunded transition', async () => {
    const inv = invoice({ status: 'paid' });
    const trx = makeTrx(inv);
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    expect(trx.updates).toHaveLength(1);
    expect(trx.updates[0].payload.status).toBe('refunded');
    expect(mockRestoreDepositCredit).toHaveBeenCalledTimes(1);
    const arg = mockRestoreDepositCredit.mock.calls[0][0];
    expect(arg.invoice.id).toBe('inv-1');
    expect(arg.invoice.line_items).toBe(inv.line_items);
    expect(arg.trx).toBe(trx);
  });

  it('restores on a pre-settlement refund too (invoice still sent — deposit was consumed at mint)', async () => {
    const trx = makeTrx(invoice({ status: 'sent' }));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    expect(trx.updates[0].payload.status).toBe('refunded');
    expect(mockRestoreDepositCredit).toHaveBeenCalledTimes(1);
  });

  it('never re-restores on a replay (invoice already refunded)', async () => {
    const trx = makeTrx(invoice({ status: 'refunded' }));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    expect(trx.updates).toHaveLength(0);
    expect(mockRestoreDepositCredit).not.toHaveBeenCalled();
  });

  it('never touches deposits on an already-void invoice (void path owns that restore)', async () => {
    const trx = makeTrx(invoice({ status: 'void' }));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    expect(mockRestoreDepositCredit).not.toHaveBeenCalled();
  });

  it('propagates a restore shortfall so the caller transaction rolls back', async () => {
    mockRestoreDepositCredit.mockRejectedValueOnce(new Error('deposit credit restore incomplete'));
    const trx = makeTrx(invoice({ status: 'paid' }));
    await expect(returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx))
      .rejects.toThrow(/restore incomplete/);
  });

  it('missing invoice stays a no-op', async () => {
    const trx = makeTrx(undefined);
    await returnAppliedCreditOnRefund({ invoiceId: 'nope' }, trx);
    expect(mockRestoreDepositCredit).not.toHaveBeenCalled();
  });
});
