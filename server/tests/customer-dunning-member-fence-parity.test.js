// PARITY: the customer-dunning resolver vets every set member (anchor and each
// sibling) with PayCombined.memberCollectionPending. That predicate must
// mirror the per-member money checks the pay page's locked verifier
// (pay-combined.js verifyAllocationLocked) and route preflight (pay-v2.js
// rejectIfInvoiceCollectionPending) run. The fence seam recurred through four
// review rounds because the two lists were maintained by hand; this file makes
// them one list. It scans the verifier's own source, so a check ADDED there
// fails here until it is either mirrored in the predicate or explicitly
// classified as session-only / covered elsewhere with a reason.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true, gates: { autoApplyAccountCredit: false } }));
const mockResolveForInvoice = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolveForInvoice(...a) }));
const mockDeposit = jest.fn();
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: (...a) => mockDeposit(...a) }));
const mockRecon = jest.fn();
jest.mock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: (...a) => mockRecon(...a) }));
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: jest.fn() }));
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: jest.fn() }));

const PayCombined = require('../services/pay-combined');

// Every refusal the verifier can raise, normalised (`${...}` -> #), with where
// the resolver covers it. 'predicate:<reason>' = memberCollectionPending
// returns that reason; anything else says why it does not apply to a read.
const VERIFIER_REFUSALS = {
  'invoice # not found': 'session-only: a row that vanished is absent from the resolver\'s own reads (the anchor row read returns balance_incomplete)',
  'dunning stopped on invoice #': 'other-authority: classifyOpen excludes a stopped member and combinedEligibleSiblings drops stopped siblings (dunningStoppedInvoiceIds)',
  'invoice # is #': 'predicate:not_collectible',
  'invoice # became payer-billed': 'predicate:payer_billed',
  'invoice # was withdrawn to a third-party payer': 'predicate:withdrawn',
  'payer resolution unavailable for invoice #': 'predicate:throws (payer lookup failure is never "clear")',
  'invoice # is payer-billed': 'predicate:payer_billed',
  'invoice # remainder changed': 'session-only: compares against the allocation snapshot the page minted; the resolver builds the snapshot itself from these same rows',
  'invoice # has a pending payment reconciliation': 'predicate:charge_reconciliation',
  'invoice # has a different active payment': 'session-only: compares against the live PaymentIntent of a pay session; combinedEligibleSiblings already keeps only unbound / anchor-PI siblings',
  'invoice # lost its payment binding': 'session-only: a pay session\'s PaymentIntent binding',
};

// The helper calls the verifier makes (identifier before `(`), with coverage.
const VERIFIER_CALLS = {
  dunningStoppedInvoiceIds: 'other-authority (see above)',
  isInvoiceCollectibleStatus: 'predicate',
  invoiceWithdrawnFromCustomer: 'predicate',
  resolveForInvoice: 'predicate',
  amountDueCents: 'session-only (snapshot cents)',
  assertNoInvoiceChargeReconciliationPending: 'predicate',
  assertInvoiceDepositSettlementReady: 'predicate',
  // plain control flow / constructors that are not checks
  staleErr: 'refusal constructor', require: 'module load', Error: 'constructor', Set: 'constructor', Map: 'constructor',
  String: 'coercion', warn: 'logging', has: 'set lookup', get: 'map lookup', map: 'array', filter: 'array', sort: 'array',
  whereIn: 'query', orderBy: 'query', forUpdate: 'query', trx: 'query', trx_: 'query',
  verifyAllocationLocked: 'self',
};

const src = (fn) => fn.toString();
const norm = (s) => s.replace(/\$\{[^}]*\}/g, '#');

describe('memberCollectionPending mirrors the pay page\'s per-member checks', () => {
  const verifier = src(PayCombined.verifyAllocationLocked);

  test('every refusal the locked verifier can raise is classified (a new one fails here until mirrored or justified)', () => {
    const found = [...verifier.matchAll(/staleErr\(`([^`]*)`\)/g)].map((m) => norm(m[1]));
    expect(found.length).toBeGreaterThan(5);
    expect([...new Set(found)].sort()).toEqual(Object.keys(VERIFIER_REFUSALS).sort());
  });

  test('every helper the locked verifier calls is classified', () => {
    const called = new Set([...verifier.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(/g)].map((m) => m[1]));
    for (const kw of ['if', 'for', 'while', 'switch', 'catch', 'function', 'async', 'await', 'return', 'throw']) called.delete(kw);
    const unclassified = [...called].filter((name) => !(name in VERIFIER_CALLS));
    expect(unclassified).toEqual([]);
  });

  test('the route preflight makes exactly the two collection checks the predicate makes', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/pay-v2.js'), 'utf8');
    const start = route.indexOf('async function rejectIfInvoiceCollectionPending');
    const body = route.slice(start, route.indexOf('\n}\n', start));
    const asserts = [...new Set([...body.matchAll(/\b(assert[A-Za-z]+)\(/g)].map((m) => m[1]))].sort();
    expect(asserts).toEqual(['assertInvoiceDepositSettlementReady', 'assertNoInvoiceChargeReconciliationPending']);
  });

  test('the predicate itself calls exactly the verifier\'s collection helpers (no fewer, no invented ones)', () => {
    const body = src(PayCombined.memberCollectionPending);
    const asserts = [...new Set([...body.matchAll(/\b(assert[A-Za-z]+)\(/g)].map((m) => m[1]))].sort();
    expect(asserts).toEqual(['assertInvoiceDepositSettlementReady', 'assertNoInvoiceChargeReconciliationPending']);
    for (const h of ['isInvoiceCollectibleStatus', 'invoiceWithdrawnFromCustomer', 'resolveForInvoice']) expect(body).toContain(h);
  });

  // Behavioural half: every 'predicate:<reason>' row above is actually produced.
  const base = () => ({ id: 'i1', invoice_number: 'INV-1', customer_id: 'c1', status: 'overdue', total: '10.00', credit_applied: 0, payer_id: null, payer_statement_id: null, scheduled_send_error: null, scheduled_service_id: null });
  // The predicate re-reads the FULL current row by id on `database`; `stored`
  // is what that read returns (default: the row under test).
  let stored;
  let readError = null;
  const database = jest.fn(() => ({
    where: () => ({ first: async () => { if (readError) throw readError; return stored; } }),
  }));
  const run = (inv) => { stored = inv; return PayCombined.memberCollectionPending(inv, { database }); };
  const pending = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

  beforeEach(() => {
    jest.clearAllMocks();
    readError = null;
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    mockDeposit.mockResolvedValue(undefined);
    mockRecon.mockResolvedValue(undefined);
  });

  test('clear member: { row } (the refreshed row), and both fences ran read-only on the given database', async () => {
    const out = await run(base());
    expect(out).toEqual({ row: stored });
    expect(out.reason).toBeUndefined();
    expect(mockDeposit).toHaveBeenCalledWith(database, expect.objectContaining({ id: 'i1' }), { lock: false });
    expect(mockRecon).toHaveBeenCalledWith('i1', database, { readOnly: true });
    expect(mockResolveForInvoice.mock.calls[0][0]).toMatchObject({ database, throwOnError: true });
  });

  test.each([
    ['not_collectible', { status: 'void' }],
    ['payer_billed', { payer_id: 'p1' }],
    ['payer_billed', { payer_statement_id: 's1' }],
    ['withdrawn', { scheduled_send_error: 'payer_billed:p1' }],
  ])('%s from the row alone (%j), before any query', async (reason, over) => {
    expect(await run({ ...base(), ...over })).toEqual({ reason });
    expect(mockResolveForInvoice).not.toHaveBeenCalled();
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  test('it vets the FULL current row, not the row it was handed: a sparse row (open-balance shape) is judged by the stored payer / withdrawal columns', async () => {
    const sparse = { id: 'i1', invoice_number: 'INV-1', status: 'overdue', total: '10.00' }; // no customer_id / payer columns
    stored = { ...base(), payer_id: 'p1' };
    expect(await PayCombined.memberCollectionPending(sparse, { database })).toEqual({ reason: 'payer_billed' });
    stored = { ...base(), scheduled_send_error: 'payer_billed:p1' };
    expect(await PayCombined.memberCollectionPending(sparse, { database })).toEqual({ reason: 'withdrawn' });
    stored = { ...base(), customer_id: 'cust-real' };
    const clear = await PayCombined.memberCollectionPending(sparse, { database });
    expect(clear.row).toBe(stored); // the REFRESHED row, not the sparse one handed in
    expect(mockResolveForInvoice.mock.calls.at(-1)[0].customerId).toBe('cust-real');
    expect(mockDeposit.mock.calls.at(-1)[1]).toMatchObject({ customer_id: 'cust-real' });
  });

  test('a row that has vanished is not_collectible; a failed re-read THROWS (caller holds)', async () => {
    stored = undefined;
    expect(await PayCombined.memberCollectionPending({ id: 'gone' }, { database })).toEqual({ reason: 'not_collectible' });
    expect(await PayCombined.memberCollectionPending({}, { database })).toEqual({ reason: 'not_collectible' });
    stored = base();
    readError = new Error('connection terminated');
    await expect(PayCombined.memberCollectionPending({ id: 'i1' }, { database })).rejects.toThrow('connection terminated');
  });

  test('the returned row carries the CURRENT amount: a total that moved since the caller\'s copy is what the caller sees', async () => {
    const stale = { ...base(), total: '100.00' };
    stored = { ...base(), total: '60.00' };
    const out = await PayCombined.memberCollectionPending(stale, { database });
    expect(out.row.total).toBe('60.00');
    stored = { ...base(), total: '60.00', credit_applied: 60 };
    expect(await PayCombined.memberCollectionPending(stale, { database })).toEqual({ reason: 'nothing_due' });
  });

  test('payer_billed from the LIVE resolve', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'p9' });
    expect(await run(base())).toEqual({ reason: 'payer_billed' });
  });

  test('a payer lookup failure THROWS (tagged), never reads as clear', async () => {
    mockResolveForInvoice.mockRejectedValue(new Error('lookup down'));
    await expect(run(base())).rejects.toMatchObject({ memberCheck: 'payer_resolve' });
  });

  test.each(['DEPOSIT_RECONCILIATION_REQUIRED'])('deposit_settlement (%s)', async (code) => {
    mockDeposit.mockRejectedValue(pending(code));
    expect(await run(base())).toMatchObject({ reason: 'deposit_settlement', code });
    expect(mockRecon).not.toHaveBeenCalled();
  });

  test.each(['STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGED_DB_FAILED'])('charge_reconciliation (%s)', async (code) => {
    mockRecon.mockRejectedValue(pending(code));
    expect(await run(base())).toMatchObject({ reason: 'charge_reconciliation', code });
  });

  test('an unexpected failure in either fence THROWS', async () => {
    mockDeposit.mockRejectedValue(new Error('connection terminated'));
    await expect(run(base())).rejects.toThrow('connection terminated');
    mockDeposit.mockResolvedValue(undefined);
    mockRecon.mockRejectedValue(new Error('connection terminated'));
    await expect(run(base())).rejects.toThrow('connection terminated');
  });
});
