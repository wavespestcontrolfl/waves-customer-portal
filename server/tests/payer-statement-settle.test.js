// P3 settlement state machine: cascade-settle, idempotency, the processing
// transitions, and the sent→viewed stamp. The db is mocked as a per-table
// chainable so we exercise the control flow without a real Postgres.

let stmtRow = null;
let invoiceUpdateCount = 0;
let packetChildren = [];
const captured = { statementUpdates: [], invoiceUpdates: [], paymentInserts: [], processingUpdates: [], viewedUpdates: [] };

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const fn = jest.fn((...args) => mockDbHandler(...args));
  fn.fn = { now: () => 'NOW' };
  fn.raw = jest.fn(async () => ({})); // pg_advisory_xact_lock (statement money lock)
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-06-21' }));

const {
  settleStatementPaid,
  enrollSettledPacketReviews,
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
      where(clause) { if (clause && clause.id) this._id = clause.id; return this; },
      whereNotIn() { return this; },
      // The packet-owned children are read before the cascade so their
      // deferred review asks can be enrolled after the settlement commits.
      whereNotNull() { return this; },
      whereNot() { return this; },
      async select() { return packetChildren; },
      async pluck() { return packetChildren.map((row) => row.id); },
      async first() { return packetChildren.find((row) => row.id === this._id) || packetChildren[0]; },
      async update(patch) { captured.invoiceUpdates.push(patch); return invoiceUpdateCount; },
    };
  }
  if (table === 'payments') {
    return {
      where() { return this; },
      async first() { return undefined; }, // no existing row → settle inserts
      async insert(row) { captured.paymentInserts.push(row); return [1]; },
      async update(row) { captured.paymentInserts.push(row); return 1; },
    };
  }
  throw new Error(`unexpected table ${table}`);
}

beforeEach(() => {
  stmtRow = null;
  invoiceUpdateCount = 0;
  packetChildren = [];
  captured.statementUpdates = []; captured.invoiceUpdates = []; captured.paymentInserts = [];
  captured.processingUpdates = []; captured.viewedUpdates = [];
  mockDbHandler = handler;
});

describe('settleStatementPaid (cascade)', () => {
  test('a NET statement payment enrolls the deferred review of every packet-owned child', async () => {
    // The closeout defers a combined-visit review behind its unpaid invoice,
    // and closeOutVisitForIssuedInvoice refuses packet-owned visits — so this
    // rail is the only settlement signal those asks ever get.
    const Review = require('../services/review-request');
    stmtRow = { id: 11, payer_id: 4, status: 'sent', sent_at: 'T' };
    invoiceUpdateCount = 2;
    packetChildren = [
      { id: 'inv-a', invoice_number: 'WPC-A', customer_id: 'cust-a', visit_completion_packet_id: 'pkt-a' },
      { id: 'inv-b', invoice_number: 'WPC-B', customer_id: 'cust-b', visit_completion_packet_id: 'pkt-b' },
    ];
    const enroll = jest.spyOn(Review, 'enrollForPaidInvoice')
      .mockImplementation(async (invoice) => (invoice.id === 'inv-b' ? { recorded: false } : { enrolled: true }));
    try {
      const res = await settleStatementPaid(11, { paymentMethod: 'check', processor: 'manual', amountCents: 5000, source: 'admin' });
      expect(res.ok).toBe(true);
      // The settle itself enrolls NOTHING: it runs inside the caller's
      // transaction, where every child still reads as unpaid. It hands the
      // ids back instead (local audit r29 P1).
      expect(enroll).not.toHaveBeenCalled();
      expect(res.packetInvoiceIds).toEqual(['inv-a', 'inv-b']);

      // A redelivery finds the statement already paid and STILL reports the
      // packet children, so the caller can finish an enrollment that failed
      // after the first settlement committed (r30 P1).
      stmtRow = { id: 11, payer_id: 4, status: 'paid', paid_at: 'T' };
      const replay = await settleStatementPaid(11, { paymentMethod: 'check', processor: 'manual', amountCents: 5000, source: 'admin' });
      expect(replay).toMatchObject({ ok: true, alreadyPaid: true });
      expect(replay.packetInvoiceIds).toEqual(['inv-a', 'inv-b']);

      // The caller enrolls after its commit, on the root connection.
      const unrecorded = await enrollSettledPacketReviews(res.packetInvoiceIds);
      expect(enroll).toHaveBeenCalledTimes(2);
      expect(enroll).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-a' }), { source: 'payer_statement' });
      // An enrollment whose recovery write also failed is REPORTED, never
      // rolled back over captured money.
      expect(unrecorded).toEqual(['inv-b']);
    } finally {
      enroll.mockRestore();
    }
  });

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

  test('offline reconcile (PAYABLE-only) refuses to settle a statement whose online payment is processing', async () => {
    const { PAYABLE_STATEMENT_STATUSES } = require('../services/payer-statement-settle');
    stmtRow = { id: 7, payer_id: 9, status: 'processing' };
    const p = settleStatementPaid(7, { amountCents: 100 }, { allowedStatuses: PAYABLE_STATEMENT_STATUSES });
    await expect(p).rejects.toThrow(/not settleable/);
    await expect(p.catch((e) => e.statusCode)).resolves.toBe(409);
    expect(captured.paymentInserts).toHaveLength(0); // no double-collection
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
