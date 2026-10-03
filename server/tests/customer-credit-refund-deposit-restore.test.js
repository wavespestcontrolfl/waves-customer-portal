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

const mockDuesAlert = jest.fn(async () => undefined);
jest.mock('../services/invoice', () => ({
  ...jest.requireActual('../services/invoice'),
  alertIfMembershipDuesCoverageReleased: (...args) => mockDuesAlert(...args),
}));

const { returnAppliedCreditOnRefund, afterCommit } = require('../services/customer-credit');

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

// B08: a full refund of a STAMPED membership-dues invoice ends its month's
// coverage like a void, so the same office "rebill the month" alert is raised,
// after the caller's transaction commits and never on a rollback.
describe('returnAppliedCreditOnRefund — dues coverage release alert', () => {
  beforeEach(() => jest.clearAllMocks());
  // Postgres returns a jsonb column DECODED (an array of objects): that is the
  // production shape. A JSON string (a driver or test double that did not decode)
  // is also read.
  const duesLines = [{ description: 'Lawn', amount: 49, membership_dues_month: '2026-09' }];
  const stamped = (lineItems = duesLines) => invoice({
    status: 'paid',
    scheduled_service_id: 'visit-1',
    line_items: lineItems,
  });
  function trxWithCommit(row, { monthLockFree = true } = {}) {
    const trx = makeTrx(row);
    trx.raw = jest.fn(async () => ({ rows: [{ acquired: monthLockFree }] }));
    let settle;
    trx.executionPromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    trx.executionPromise.catch(() => {});
    trx.settle = settle;
    return trx;
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('alerts once the transaction commits, with the refunded invoice row', async () => {
    const trx = trxWithCommit(stamped());
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    await flush();
    expect(mockDuesAlert).not.toHaveBeenCalled(); // not before the commit
    trx.settle.resolve();
    await flush();
    expect(mockDuesAlert).toHaveBeenCalledTimes(1);
    expect(mockDuesAlert.mock.calls[0][0]).toMatchObject({ id: 'inv-1', status: 'refunded', customer_id: 'cust-1' });
    expect(mockDuesAlert.mock.calls[0][1]).toEqual({ releasedBy: 'refunded' });
  });

  it('never alerts when the transaction rolls back', async () => {
    const trx = trxWithCommit(stamped());
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    trx.settle.reject(new Error('rolled back'));
    await flush();
    expect(mockDuesAlert).not.toHaveBeenCalled();
  });

  it('takes the dues-month lock as a TRY (never a wait) for the stamped invoice\'s customer and month, before writing anything', async () => {
    const trx = trxWithCommit(stamped());
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    expect(trx.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = trx.raw.mock.calls[0];
    expect(sql).toMatch(/pg_try_advisory_xact_lock/);
    expect(sql).not.toMatch(/pg_advisory_xact_lock\(/);
    expect(bindings).toEqual(['membership.dues_month', 'cust-1:2026-09']);
  });

  it('a busy month lock (a completion is relying on the invoice) refuses the transition retryably BEFORE any write, restore or alert', async () => {
    const trx = trxWithCommit(stamped(), { monthLockFree: false });
    await expect(returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx))
      .rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_MONTH_BUSY', statusCode: 503, isOperational: true });
    expect(trx.updates).toHaveLength(0);
    expect(mockRestoreDepositCredit).not.toHaveBeenCalled();
    trx.settle.resolve();
    await flush();
    expect(mockDuesAlert).not.toHaveBeenCalled();
  });

  it('an unstamped invoice never touches the month lock, and a replay of an already-refunded stamped invoice does not either', async () => {
    const plain = trxWithCommit(invoice({ status: 'paid' }));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, plain);
    expect(plain.raw).not.toHaveBeenCalled();
    const replay = trxWithCommit({ ...stamped(), status: 'refunded' }, { monthLockFree: false });
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, replay);
    expect(replay.raw).not.toHaveBeenCalled();
  });

  it('reads the stamp from a JSON string too', async () => {
    const trx = trxWithCommit(stamped(JSON.stringify(duesLines)));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    trx.settle.resolve();
    await flush();
    expect(mockDuesAlert).toHaveBeenCalledTimes(1);
  });

  it('a decoded array with no stamp on any line raises nothing', async () => {
    const trx = trxWithCommit(stamped([{ description: 'Lawn', amount: 49 }, { description: 'Fee', amount: 5 }]));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, trx);
    trx.settle.resolve();
    await flush();
    expect(mockDuesAlert).not.toHaveBeenCalled();
  });

  it('an unstamped invoice, or a replay of an already-refunded one, raises nothing', async () => {
    const plain = trxWithCommit(invoice({ status: 'paid' }));
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, plain);
    plain.settle.resolve();
    const replay = trxWithCommit({ ...stamped(), status: 'refunded' });
    await returnAppliedCreditOnRefund({ invoiceId: 'inv-1' }, replay);
    replay.settle.resolve();
    await flush();
    expect(mockDuesAlert).not.toHaveBeenCalled();
  });
});

// afterCommit resolves against the OUTERMOST transaction: a savepoint's
// executionPromise settles when the savepoint is released, before the outer
// transaction commits, so a callback bound to it could fire for work an outer
// rollback then discards. knex hands a nested transaction handle a
// `parentTransaction` pointing at the handle it was started from.
describe('afterCommit — outermost transaction', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  function handles() {
    let settleTop; let settleSavepoint;
    const top = { executionPromise: new Promise((resolve, reject) => { settleTop = { resolve, reject }; }) };
    top.executionPromise.catch(() => {});
    const savepoint = { parentTransaction: top, executionPromise: new Promise((resolve, reject) => { settleSavepoint = { resolve, reject }; }) };
    savepoint.executionPromise.catch(() => {});
    return { top, savepoint, settleTop, settleSavepoint };
  }

  it('a callback registered inside a released savepoint does NOT fire when the outer transaction then rolls back', async () => {
    const { savepoint, settleTop, settleSavepoint } = handles();
    const fn = jest.fn();
    afterCommit(savepoint, fn);
    settleSavepoint.resolve(); // savepoint released
    await flush();
    expect(fn).not.toHaveBeenCalled(); // not at the savepoint release
    settleTop.reject(new Error('outer rolled back'));
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires exactly once, after the real commit, when the outer transaction commits', async () => {
    const { savepoint, settleTop, settleSavepoint } = handles();
    const fn = jest.fn();
    afterCommit(savepoint, fn);
    settleSavepoint.resolve();
    await flush();
    expect(fn).not.toHaveBeenCalled();
    settleTop.resolve();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('walks a chain of savepoints, and a top-level handle behaves as before', async () => {
    const { top, savepoint, settleTop } = handles();
    const deeper = { parentTransaction: savepoint, executionPromise: Promise.resolve() };
    const viaDeeper = jest.fn();
    const direct = jest.fn();
    afterCommit(deeper, viaDeeper);
    afterCommit(top, direct);
    await flush();
    expect(viaDeeper).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    settleTop.resolve();
    await flush();
    expect(viaDeeper).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
  });
});
