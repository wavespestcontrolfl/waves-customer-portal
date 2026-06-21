// P3 settlement state machine: cascade-settle, idempotency, the processing
// transitions, and the sent→viewed stamp. The db is mocked as a per-table
// chainable so we exercise the control flow without a real Postgres.

let stmtRow = null;
let invoiceUpdateCount = 0;
const captured = { statementUpdates: [], invoiceUpdates: [], paymentInserts: [], processingUpdates: [], viewedUpdates: [] };

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const fn = jest.fn((...args) => mockDbHandler(...args));
  fn.fn = { now: () => 'NOW' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-06-21' }));

const {
  settleStatementPaid,
  markStatementProcessing,
  revertStatementProcessing,
  markStatementViewed,
  priorPayableStatus,
  isPayableStatementStatus,
} = require('../services/payer-statement-settle');

// Per-table chainable: payer_statements (forUpdate/first/update/whereIn),
// invoices (whereNotIn/update→count), payments (insert).
function handler(table) {
  if (table === 'payer_statements') {
    const b = {
      _where: null,
      where(c) { this._where = c; return this; },
      whereIn() { this._whereIn = true; return this; },
      forUpdate() { return this; },
      async first() { return stmtRow ? { ...stmtRow } : undefined; },
      async update(patch) {
        if (this._whereIn) captured.processingUpdates.push(patch);          // markStatementProcessing
        else if (this._where?.status === 'sent') captured.viewedUpdates.push(patch); // markStatementViewed (sent→viewed)
        else captured.statementUpdates.push(patch);                          // settle / revert
        return 1;
      },
    };
    return b;
  }
  if (table === 'invoices') {
    return {
      where() { return this; },
      whereNotIn() { return this; },
      async update(patch) { captured.invoiceUpdates.push(patch); return invoiceUpdateCount; },
    };
  }
  if (table === 'payments') {
    return { async insert(row) { captured.paymentInserts.push(row); return [1]; } };
  }
  throw new Error(`unexpected table ${table}`);
}

beforeEach(() => {
  stmtRow = null;
  invoiceUpdateCount = 0;
  captured.statementUpdates = []; captured.invoiceUpdates = []; captured.paymentInserts = [];
  captured.processingUpdates = []; captured.viewedUpdates = [];
  mockDbHandler = handler;
});

describe('settleStatementPaid (cascade)', () => {
  test('settles a sent statement → paid, cascades children, writes ONE payer-scoped row', async () => {
    stmtRow = { id: 7, payer_id: 9, status: 'sent', sent_at: 'T', stripe_payment_intent_id: 'pi_1' };
    invoiceUpdateCount = 3;
    const res = await settleStatementPaid(7, {
      paymentMethod: 'card', processor: 'stripe', stripePaymentIntentId: 'pi_1', stripeChargeId: 'ch_1',
      amountCents: 33170, baseAmountCents: 32200, surchargeAmountCents: 970, surchargeRateBps: 290,
      cardFunding: 'credit', cardBrand: 'visa', source: 'stripe_webhook',
    });
    expect(res.ok).toBe(true);
    expect(res.childrenSettled).toBe(3);
    // statement → paid
    expect(captured.statementUpdates[0]).toMatchObject({ status: 'paid', payment_method: 'card', stripe_charge_id: 'ch_1' });
    // children cascaded
    expect(captured.invoiceUpdates[0]).toMatchObject({ status: 'paid' });
    // ONE payer-scoped ledger row: customer_id NULL, payer_id set, CHARGED total
    expect(captured.paymentInserts).toHaveLength(1);
    const row = captured.paymentInserts[0];
    expect(row.customer_id).toBeNull();
    expect(row.payer_id).toBe(9);
    expect(row.statement_id).toBe(7);
    expect(row.amount).toBeCloseTo(331.70, 2);
    expect(row.base_amount_cents).toBe(32200);
    expect(row.surcharge_amount_cents).toBe(970);
  });

  test('is idempotent — an already-paid statement is a no-op (duplicate/late webhook)', async () => {
    stmtRow = { id: 7, payer_id: 9, status: 'paid' };
    const res = await settleStatementPaid(7, { amountCents: 100 });
    expect(res).toMatchObject({ ok: true, alreadyPaid: true });
    expect(captured.statementUpdates).toHaveLength(0);
    expect(captured.paymentInserts).toHaveLength(0);
  });

  test('refuses to settle a non-settleable status (open / void)', async () => {
    stmtRow = { id: 7, payer_id: 9, status: 'open' };
    await expect(settleStatementPaid(7, { amountCents: 100 })).rejects.toThrow(/not settleable/);
    stmtRow = { id: 7, payer_id: 9, status: 'void' };
    await expect(settleStatementPaid(7, { amountCents: 100 })).rejects.toThrow(/not settleable/);
  });

  test('requires a numeric amountCents', async () => {
    stmtRow = { id: 7, payer_id: 9, status: 'finalized' };
    await expect(settleStatementPaid(7, {})).rejects.toThrow(/amountCents/);
  });
});

describe('processing transitions', () => {
  test('markStatementProcessing moves only the active-PI payable statement', async () => {
    const moved = await markStatementProcessing(7, 'pi_1');
    expect(moved).toBe(true);
    expect(captured.processingUpdates[0]).toMatchObject({ status: 'processing' });
  });

  test('revertStatementProcessing rolls processing back to the derived prior payable', async () => {
    stmtRow = { id: 7, payer_id: 9, status: 'processing', stripe_payment_intent_id: 'pi_1', viewed_at: 'T', sent_at: 'T' };
    const reverted = await revertStatementProcessing(7, 'pi_1');
    expect(reverted).toBe(true);
    expect(captured.statementUpdates[0]).toMatchObject({ status: 'viewed' }); // viewed_at set → viewed
  });

  test('revertStatementProcessing no-ops when not processing on this PI', async () => {
    stmtRow = null; // forUpdate().first() returns undefined
    const reverted = await revertStatementProcessing(7, 'pi_1');
    expect(reverted).toBe(false);
  });
});

describe('priorPayableStatus / markStatementViewed', () => {
  test('priorPayableStatus derives from timestamps', () => {
    expect(priorPayableStatus({ viewed_at: 'T', sent_at: 'T' })).toBe('viewed');
    expect(priorPayableStatus({ sent_at: 'T' })).toBe('sent');
    expect(priorPayableStatus({})).toBe('finalized');
  });

  test('isPayableStatementStatus', () => {
    ['finalized', 'sent', 'viewed'].forEach((s) => expect(isPayableStatementStatus(s)).toBe(true));
    ['open', 'processing', 'paid', 'void'].forEach((s) => expect(isPayableStatementStatus(s)).toBe(false));
  });

  test('markStatementViewed only stamps sent → viewed', async () => {
    await markStatementViewed(7);
    expect(captured.viewedUpdates[0]).toMatchObject({ status: 'viewed' });
  });
});
