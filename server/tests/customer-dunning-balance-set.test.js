// resolveDunnableSet — the single set authority for customer-level overdue
// reminders (dunning consolidation PR 1, inert). It re-runs the pay page's OWN
// authority (open-balance's openBalanceInvoices, pay-combined's
// combinedEligibleSiblings — both REAL here — and pay-v2's anchor predicates),
// so what a reminder names is what the page would charge. All ids are
// synthetic; the database, Stripe, payer lookup and the open read are fakes
// driven by one `state` object.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The pool handle must never serve a resolve (a database is always passed);
// only applyCreditBeforeResolve, which takes no handle, may use it.
const mockPool = { allowed: false, handle: null };
jest.mock('../models/db', () => (...a) => {
  if (!mockPool.allowed) throw new Error('the pool handle must not be used when a database is passed');
  return mockPool.handle(...a);
});
const mockDepositReady = jest.fn();
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: (...a) => mockDepositReady(...a) }));

const mockGates = { autoApplyAccountCredit: true, divertMicrodepositDunning: true };
const mockEnabled = { payIncludeBalance: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => mockEnabled[g] === true,
  gates: mockGates,
}));

let state;
const mockResolveForInvoice = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolveForInvoice(...a) }));
const mockOpenBalance = jest.fn();
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: (...a) => mockOpenBalance(...a) }));
const mockStopped = jest.fn();
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: (...a) => mockStopped(...a) }));
const mockMd = jest.fn();
const mockRetrievePi = jest.fn();
const mockReconcile = jest.fn();
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: (...a) => mockMd(...a),
  retrievePaymentIntent: (...a) => mockRetrievePi(...a),
  cancelPaymentIntent: jest.fn(),
  assertNoInvoiceChargeReconciliationPending: (...a) => mockReconcile(...a),
}));
const mockAutoApply = jest.fn();
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: (...a) => mockAutoApply(...a) }));

const PayCombined = require('../services/pay-combined');
const { resolveDunnableSet, applyCreditBeforeResolve, setDigest, HOLD_PRECEDENCE } = require('../services/customer-dunning/balance-set');

const CUSTOMER = 'cust-0000-synthetic';

// Invoices are created oldest-first: A (oldest) < B < C < D.
const inv = (id, over = {}) => ({
  id, invoice_number: `INV-${id}`, customer_id: CUSTOMER, status: 'overdue', total: '100.00', credit_applied: 0,
  payer_id: null, payer_statement_id: null, scheduled_send_error: null, stripe_payment_intent_id: null,
  token: `tok-${id}`, title: `Service ${id}`, service_date: '2026-08-01', due_date: '2026-08-15',
  scheduled_service_id: null, ...over,
});

// A fake knex handle answering only the reads balance-set and pay-combined
// make directly (sequence rows, the anchor's full invoice row, the customer's
// credit row).
function fakeDatabase() {
  const handle = jest.fn((table) => {
    const q = { cond: null, ids: null };
    q.where = (c) => { q.cond = c; return q; };
    q.whereIn = (_col, ids) => { q.ids = ids; return q; };
    q.select = async () => (table === 'invoice_followup_sequences'
      ? state.seqs.filter((s) => q.ids.includes(s.invoice_id)).map((s) => ({ ...s }))
      : []);
    q.first = async () => {
      if (table === 'invoices') return state.invoices.find((i) => i.id === q.cond.id);
      if (table === 'customers') return state.customerCredit;
      return undefined;
    };
    return q;
  });
  return handle;
}

let database;

function reset(openInvoices, seqStatuses = {}) {
  state = {
    invoices: openInvoices,
    seqs: Object.entries(seqStatuses).map(([invoice_id, status], i) => ({ id: `seq-${i}-${invoice_id}`, invoice_id, status })),
    customerCredit: { account_credits: 0, auto_apply_account_credit: false },
    openIncomplete: false,
    siblingReadIncomplete: false,
    md: new Set(),
    livePi: new Set(),
  };
  database = fakeDatabase();
}

beforeEach(() => {
  jest.resetAllMocks();
  mockEnabled.payIncludeBalance = true;
  mockGates.autoApplyAccountCredit = true;
  mockGates.divertMicrodepositDunning = true;
  reset([inv('A'), inv('B'), inv('C')], { A: 'active', B: 'active', C: 'active' });
  mockResolveForInvoice.mockResolvedValue({ payerId: null });
  // The open read: excludes `excludeInvoiceId`, signals incompleteness only
  // when the test asks (the resolver's own read vs the sibling read).
  mockOpenBalance.mockImplementation(async (customerId, args = {}) => {
    const isSiblingRead = Boolean(args.excludeInvoiceId);
    if (!isSiblingRead && state.openIncomplete) args.onResolveFailure?.();
    if (isSiblingRead && state.siblingReadIncomplete) args.onTruncation?.(200);
    return state.invoices.filter((i) => i.id !== args.excludeInvoiceId && i.status !== 'paid');
  });
  mockStopped.mockImplementation(async (ids) => new Set(state.seqs.filter((s) => s.status === 'stopped' && ids.includes(s.invoice_id)).map((s) => s.invoice_id)));
  mockMd.mockImplementation(async (i) => state.md.has(i.id));
  mockRetrievePi.mockImplementation(async (id) => ({ id, status: 'processing', created: Math.floor(Date.now() / 1000), metadata: {} }));
  mockReconcile.mockResolvedValue(undefined);
  mockDepositReady.mockResolvedValue(undefined);
  mockPool.allowed = false;
  mockPool.handle = null;
  mockAutoApply.mockResolvedValue(null);
});

const resolve = (extra = {}) => resolveDunnableSet(CUSTOMER, { database, now: new Date('2026-09-29T14:00:00Z'), ...extra });
const ids = (set) => set.members.map((m) => m.invoice_id);

describe('parity with pay-v2\'s preview set for the same anchor', () => {
  // pay-v2's GET preview: combinedEligibleSiblings(anchor, { reusePaymentIntentId: anchor.stripe_payment_intent_id })
  const previewSiblings = async (anchor) => (await PayCombined.combinedEligibleSiblings(anchor, {
    database, reusePaymentIntentId: anchor.stripe_payment_intent_id || null,
  })) || [];

  test('multi: [anchor, ...the page\'s siblings], total and digest from the same rows', async () => {
    const set = await resolve();
    const anchorRow = state.invoices[0];
    const expected = [anchorRow.id, ...(await previewSiblings(anchorRow)).map((i) => i.id)];
    expect(set.kind).toBe('multi');
    expect(ids(set)).toEqual(expected);
    expect(ids(set)).toEqual(['A', 'B', 'C']);
    expect(set.anchor).toMatchObject({ id: 'A', token: 'tok-A', invoice_number: 'INV-A', title: 'Service A' });
    expect(set.totalCents).toBe(30000);
    expect(set.activeCount).toBe(3);
    expect(set.digest).toBe(setDigest('A', set.members));
    expect(set.reason).toBeNull();
  });

  test('cents come from the amount due (total minus credit), not the face value', async () => {
    reset([inv('A'), inv('B', { total: '80.00', credit_applied: 30 })], { A: 'active', B: 'active' });
    const set = await resolve();
    expect(set.members.map((m) => m.cents)).toEqual([10000, 5000]);
    expect(set.totalCents).toBe(15000);
  });

  test('single: no sibling rides (reason none), even when other open invoices exist', async () => {
    reset([inv('A'), inv('B', { stripe_payment_intent_id: 'pi_live' })], { A: 'active', B: 'active' });
    const set = await resolve();
    expect(set.kind).toBe('single');
    expect(ids(set)).toEqual(['A']);
    expect(await previewSiblings(state.invoices[0])).toEqual([]);
  });

  test('a sibling stamped with the anchor\'s own PaymentIntent stays in (page reload must not shed it)', async () => {
    reset([inv('A', { stripe_payment_intent_id: 'pi_anchor' }), inv('B', { stripe_payment_intent_id: 'pi_anchor' })], { A: 'active', B: 'active' });
    const set = await resolve();
    expect(ids(set)).toEqual(['A', 'B']);
    expect(ids(set)).toEqual([state.invoices[0].id, ...(await previewSiblings(state.invoices[0])).map((i) => i.id)]);
  });

  test('empty: nothing open', async () => {
    reset([], {});
    const set = await resolve();
    expect(set).toMatchObject({ kind: 'empty', reason: 'no_open_invoices', anchor: null, members: [], totalCents: 0, digest: null });
  });

  test.each([
    ['gate off', () => { mockEnabled.payIncludeBalance = false; }, 'gate_off'],
    ['a payer on the anchor row', () => { state.invoices[0].payer_id = 'payer-1'; }, 'payer_anchor'],
    ['a payer statement on the anchor row', () => { state.invoices[0].payer_statement_id = 'stmt-1'; }, 'payer_anchor'],
    ['a withdrawn (payer-billed stamp) anchor', () => { state.invoices[0].scheduled_send_error = 'payer_billed:payer-1'; }, 'payer_anchor'],
    ['the LIVE payer resolve finds a payer', () => { mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-9' }); }, 'payer_anchor'],
    ['the payer lookup failing', () => { mockResolveForInvoice.mockRejectedValue(new Error('lookup down')); }, 'payer_unresolved'],
    ['an incomplete sibling read', () => { state.siblingReadIncomplete = true; }, 'incomplete'],
    ['over the sibling cap', () => {
      reset(
        Array.from({ length: PayCombined.MAX_COMBINED_SIBLINGS + 2 }, (_v, i) => inv(`I${String(i).padStart(2, '0')}`)),
        {},
      );
    }, 'over_cap'],
    ['credit that would fully cover the anchor', () => { state.customerCredit = { account_credits: 500, auto_apply_account_credit: true }; }, 'credit_covers_anchor'],
    ['an anchor that is no longer collectible', () => { state.invoices[0].status = 'void'; }, 'balance_incomplete'],
  ])('hold: %s', async (_label, arrange, reason) => {
    arrange();
    const set = await resolve();
    expect(set.kind).toBe('hold');
    expect(set.reason).toBe(reason);
  });

  test('hold: an anchor with a pending charge reconciliation is fenced read-only on the caller\'s database, and no sibling set is read', async () => {
    mockReconcile.mockImplementation(async (invoiceId) => {
      if (invoiceId === 'A') throw Object.assign(new Error('charge reconciliation pending'), { code: 'INVOICE_CHARGE_RECONCILIATION_PENDING' });
    });
    const set = await resolve();
    expect(set).toMatchObject({ kind: 'hold', reason: 'anchor_reconciliation' });
    expect(set.kind).not.toBe('multi');
    expect(set.reason).not.toBeNull();
    const anchorCalls = mockReconcile.mock.calls.filter((c) => c[0] === 'A');
    expect(anchorCalls).toHaveLength(1);
    expect(anchorCalls[0][1]).toBe(database);
    expect(anchorCalls[0][2]).toEqual({ readOnly: true });
    // the page's sibling read never ran (only the anchor was fenced)
    expect(mockReconcile.mock.calls.every((c) => c[0] === 'A')).toBe(true);
  });

  test('hold: a received-but-unapplied estimate deposit on the anchor holds like the page\'s deposit fence, read-only', async () => {
    mockDepositReady.mockRejectedValue(Object.assign(new Error('A received deposit is awaiting invoice reconciliation'), { code: 'DEPOSIT_RECONCILIATION_REQUIRED' }));
    const set = await resolve();
    expect(set).toMatchObject({ kind: 'hold', reason: 'anchor_reconciliation' });
    expect(mockDepositReady).toHaveBeenCalledWith(database, expect.objectContaining({ id: 'A' }), { lock: false });
  });

  test('an unfenced anchor is not held by the reconciliation check', async () => {
    expect((await resolve()).kind).toBe('multi');
    expect(mockReconcile.mock.calls.some((c) => c[0] === 'A' && c[2]?.readOnly === true)).toBe(true);
  });

  test('a credit-covered anchor holds as credit_covers_anchor before the fence is asked', async () => {
    state.customerCredit = { account_credits: 500, auto_apply_account_credit: true };
    mockReconcile.mockRejectedValue(new Error('pending'));
    expect((await resolve()).reason).toBe('credit_covers_anchor');
    expect(mockReconcile.mock.calls.filter((c) => c[0] === 'A')).toHaveLength(0);
  });

  test('hold: an incomplete open read stops before anything else is asked', async () => {
    state.openIncomplete = true;
    const set = await resolve();
    expect(set).toMatchObject({ kind: 'hold', reason: 'balance_incomplete', members: [] });
    expect(mockMd).not.toHaveBeenCalled();
    expect(mockResolveForInvoice).not.toHaveBeenCalled();
  });

  test('credit that only partly covers the anchor does not hold', async () => {
    state.customerCredit = { account_credits: 40, auto_apply_account_credit: true };
    expect((await resolve()).kind).toBe('multi');
  });
});

describe('classification matrix', () => {
  test('stopped is excluded and is never the anchor; the page drops it too', async () => {
    reset([inv('A'), inv('B'), inv('C')], { A: 'stopped', B: 'active', C: 'active' });
    const set = await resolve();
    expect(set.anchor.id).toBe('B');
    expect(ids(set)).toEqual(['B', 'C']);
    expect(set.excluded).toEqual({ stopped: ['A'], md: [] });
  });

  test('microdeposit-pending is excluded and is never the anchor', async () => {
    reset([inv('A', { stripe_payment_intent_id: 'pi_md' }), inv('B'), inv('C')], { A: 'active', B: 'active', C: 'active' });
    state.md.add('A');
    const set = await resolve();
    expect(set.anchor.id).toBe('B');
    expect(ids(set)).toEqual(['B', 'C']);
    expect(set.excluded).toEqual({ stopped: [], md: ['A'] });
  });

  test('every open invoice excluded => empty (all_excluded), not a send and not "balance cleared"', async () => {
    reset([inv('A'), inv('B')], { A: 'stopped', B: 'stopped' });
    const set = await resolve();
    expect(set).toMatchObject({ kind: 'empty', reason: 'all_excluded' });
    expect(set.excluded.stopped).toEqual(['A', 'B']);
  });

  test('the microdeposit check covers EVERY non-stopped member, not the anchor only', async () => {
    reset([inv('A', { stripe_payment_intent_id: 'pi_a' }), inv('B', { stripe_payment_intent_id: 'pi_b' }), inv('C', { stripe_payment_intent_id: 'pi_c' })],
      { A: 'active', B: 'stopped', C: 'active' });
    state.md.add('C');
    const set = await resolve();
    const checked = mockMd.mock.calls.map(([i]) => i.id).sort();
    expect(checked).toEqual(['A', 'C']); // the stopped one is skipped, the rest all asked
    expect(mockMd.mock.calls.every(([, opts]) => opts.throwOnError === true)).toBe(true);
    expect(set.excluded).toEqual({ stopped: ['B'], md: ['C'] });
  });

  test('with the diversion gate off no invoice is asked about microdeposits', async () => {
    mockGates.divertMicrodepositDunning = false;
    reset([inv('A', { stripe_payment_intent_id: 'pi_a' }), inv('B')], { A: 'active', B: 'active' });
    await resolve();
    expect(mockMd).not.toHaveBeenCalled();
  });

  test('an unreadable microdeposit state is a hold, never a silent "no"', async () => {
    reset([inv('A', { stripe_payment_intent_id: 'pi_a' }), inv('B')], { A: 'active', B: 'active' });
    mockMd.mockRejectedValue(new Error('stripe timeout'));
    expect(await resolve()).toMatchObject({ kind: 'hold', reason: 'balance_incomplete' });
  });

  test('paused member => hold member_paused; autopay_hold member => hold member_autopay_hold', async () => {
    reset([inv('A'), inv('B')], { A: 'active', B: 'paused' });
    expect(await resolve()).toMatchObject({ kind: 'hold', reason: 'member_paused' });
    reset([inv('A'), inv('B')], { A: 'active', B: 'autopay_hold' });
    expect(await resolve()).toMatchObject({ kind: 'hold', reason: 'member_autopay_hold' });
  });

  test('a paused ANCHOR holds too (it is in the set)', async () => {
    reset([inv('A'), inv('B')], { A: 'paused', B: 'active' });
    expect(await resolve()).toMatchObject({ kind: 'hold', reason: 'member_paused', anchor: { id: 'A' } });
  });

  test('a paused invoice the page would NOT charge (live PaymentIntent) does not hold the customer', async () => {
    reset([inv('A'), inv('B', { stripe_payment_intent_id: 'pi_live' })], { A: 'active', B: 'paused' });
    const set = await resolve();
    expect(set.kind).toBe('single');
    expect(ids(set)).toEqual(['A']);
  });

  test('completed and no-row members are QUIET: named in count/total, never counted as active', async () => {
    reset([inv('A'), inv('B'), inv('C')], { A: 'active', B: 'completed' /* C has no sequence row */ });
    const set = await resolve();
    expect(set.kind).toBe('multi');
    expect(set.members.map((m) => [m.invoice_id, m.seqStatus, m.quiet])).toEqual([
      ['A', 'active', false], ['B', 'completed', true], ['C', 'none', true],
    ]);
    expect(set.totalCents).toBe(30000);
    expect(set.activeCount).toBe(1);
  });

  test('a quiet oldest invoice is still the anchor (same order the page uses)', async () => {
    reset([inv('A'), inv('B')], { A: 'completed', B: 'active' });
    expect((await resolve()).anchor.id).toBe('A');
  });

  test('a sibling the open read did not see still gets its own sequence status', async () => {
    reset([inv('A'), inv('B')], { A: 'active', B: 'paused' });
    // First (resolver) read sees only A; the page's sibling read also returns B.
    let call = 0;
    mockOpenBalance.mockImplementation(async (_c, args = {}) => {
      call += 1;
      return call === 1 ? [state.invoices[0]] : state.invoices.filter((i) => i.id !== args.excludeInvoiceId);
    });
    expect(await resolve()).toMatchObject({ kind: 'hold', reason: 'member_paused' });
  });
});

describe('hold precedence', () => {
  test('balance_incomplete > member_paused > member_autopay_hold > credit_covers_anchor > anchor_reconciliation > payer_* > incomplete > over_cap > gate_off', () => {
    expect(HOLD_PRECEDENCE).toEqual([
      'balance_incomplete', 'member_paused', 'member_autopay_hold', 'credit_covers_anchor', 'anchor_reconciliation',
      'payer_anchor', 'payer_unresolved', 'incomplete', 'over_cap', 'gate_off',
    ]);
  });

  test('a paused member outranks a credit-covered anchor', async () => {
    reset([inv('A'), inv('B')], { A: 'paused', B: 'active' });
    state.customerCredit = { account_credits: 500, auto_apply_account_credit: true };
    expect((await resolve()).reason).toBe('member_paused');
  });

  test('with the page gate off there are no siblings, so a paused sibling cannot hold (gate_off is the reason)', async () => {
    reset([inv('A'), inv('B')], { A: 'active', B: 'paused' });
    mockEnabled.payIncludeBalance = false; // gate_off => no siblings, so B is not in the set
    expect((await resolve()).reason).toBe('gate_off');
  });
});

describe('every read goes through the database handle it was given', () => {
  test('the set read, the anchor read, the credit probe and the payer resolve all use `database`', async () => {
    state.customerCredit = { account_credits: 10, auto_apply_account_credit: true };
    await resolve();
    const tables = database.mock.calls.map(([t]) => t);
    expect(tables).toEqual(expect.arrayContaining(['invoice_followup_sequences', 'invoices', 'customers']));
    for (const call of mockOpenBalance.mock.calls) expect(call[1].database).toBe(database);
    for (const call of mockResolveForInvoice.mock.calls) expect(call[0].database).toBe(database);
    for (const call of mockStopped.mock.calls) expect(call[1].database).toBe(database);
    for (const call of mockReconcile.mock.calls) { expect(call[1]).toBe(database); expect(call[2]).toEqual({ readOnly: true }); }
    // (the pool handle is a mock that throws if touched; the run above passed)
  });
});

describe('never throws, never writes', () => {
  test('an unexpected failure is a hold', async () => {
    mockOpenBalance.mockRejectedValue(new Error('connection lost'));
    expect(await resolve()).toMatchObject({ kind: 'hold', reason: 'balance_incomplete' });
  });

  test('it applies no credit and mints nothing', async () => {
    state.customerCredit = { account_credits: 500, auto_apply_account_credit: true };
    await resolve();
    expect(mockAutoApply).not.toHaveBeenCalled();
  });
});

describe('the digest', () => {
  const members = [{ invoice_id: 'A', cents: 100 }, { invoice_id: 'B', cents: 200 }];

  test('is order-independent over members but bound to the anchor and every amount', () => {
    const d = setDigest('A', members);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(setDigest('A', [...members].reverse())).toBe(d);
    expect(setDigest('B', members)).not.toBe(d);
    expect(setDigest('A', [members[0], { invoice_id: 'B', cents: 201 }])).not.toBe(d);
    expect(setDigest('A', [members[0]])).not.toBe(d);
  });

  test('a credit landing on a sibling changes the digest (the boundary sees it)', async () => {
    const before = await resolve();
    state.invoices[1].credit_applied = 25;
    const after = await resolve();
    expect(after.digest).not.toBe(before.digest);
    expect(after.totalCents).toBe(before.totalCents - 2500);
  });
});

describe('applyCreditBeforeResolve (runner only)', () => {
  test('draws oldest first onto active / no-row invoices only, and returns the draws for reversal', async () => {
    reset([inv('A'), inv('B'), inv('C'), inv('D'), inv('E')], { A: 'active', B: 'paused', C: 'stopped', D: 'completed' /* E: no row */ });
    mockAutoApply.mockImplementation(async (id) => ({ applied: id === 'A' ? 20 : 0 }));
    mockPool.allowed = true; mockPool.handle = database;
    const draws = await applyCreditBeforeResolve(CUSTOMER);
    expect(mockAutoApply.mock.calls.map(([id]) => id)).toEqual(['A', 'E']);
    expect(draws).toEqual([{ invoiceId: 'A', amount: 20 }]);
    // each draw is its own transaction: no caller trx is threaded in (so the
    // credit helper still runs the full-coverage side effects itself), and the
    // collection fence rides INSIDE that transaction via the opt-in option
    for (const call of mockAutoApply.mock.calls) expect(call[1]).toEqual({ requireNoCollectionPending: true });
  });

  test('takes no database handle (a caller\'s handle would make the helper skip its full-coverage side effects)', () => {
    expect(applyCreditBeforeResolve.length).toBe(1);
  });

  test('never draws onto a microdeposit-pending invoice, or one whose Stripe state is unreadable', async () => {
    reset([inv('A', { stripe_payment_intent_id: 'pi_a' }), inv('B', { stripe_payment_intent_id: 'pi_b' }), inv('C')],
      { A: 'active', B: 'active', C: 'active' });
    mockMd.mockImplementation(async (i) => {
      if (i.id === 'A') return true;
      if (i.id === 'B') throw new Error('stripe timeout');
      return false;
    });
    mockAutoApply.mockResolvedValue({ applied: 5 });
    mockPool.allowed = true; mockPool.handle = database;
    const draws = await applyCreditBeforeResolve(CUSTOMER);
    expect(mockAutoApply.mock.calls.map(([id]) => id)).toEqual(['C']);
    expect(draws).toEqual([{ invoiceId: 'C', amount: 5 }]);
  });
});

describe('sibling reconciliation fence: pending excludes, an unreadable fence holds (resolver only)', () => {
  const pending = (code, extra = {}) => Object.assign(new Error(`fenced ${code}`), { code, ...extra });

  test.each([
    ['STRIPE_CHARGE_IN_PROGRESS', pending('STRIPE_CHARGE_IN_PROGRESS')],
    ['STRIPE_AMBIGUOUS_OUTCOME', pending('STRIPE_AMBIGUOUS_OUTCOME', { reconciliationRequired: true })],
    ['STRIPE_CHARGED_DB_FAILED', pending('STRIPE_CHARGED_DB_FAILED', { reconciliationRequired: true })],
    ['DEPOSIT_RECONCILIATION_REQUIRED', pending('DEPOSIT_RECONCILIATION_REQUIRED')],
    ['reconciliationRequired flag alone', Object.assign(new Error('parked'), { reconciliationRequired: true })],
  ])('a sibling fenced with %s is excluded; the rest of the set stands', async (_label, err) => {
    mockReconcile.mockImplementation(async (invoiceId) => { if (invoiceId === 'B') throw err; });
    const set = await resolve();
    expect(set.kind).toBe('multi');
    expect(ids(set)).toEqual(['A', 'C']);
  });

  test('an unexpected fence failure (DB down) on a sibling holds the whole set as incomplete', async () => {
    mockReconcile.mockImplementation(async (invoiceId) => { if (invoiceId === 'B') throw new Error('connection terminated'); });
    const set = await resolve();
    expect(set).toMatchObject({ kind: 'hold', reason: 'incomplete' });
  });
});

describe('deterministic anchor on equal created_at', () => {
  const at = '2026-08-01T10:00:00.000Z';
  const twin = (id) => inv(id, { created_at: at });

  test.each([
    ['ascending', ['X1', 'X2']],
    ['descending', ['X2', 'X1']],
  ])('two invoices sharing created_at (%s input order) pick the same anchor and digest', async (_label, order) => {
    reset(order.map(twin), { X1: 'active', X2: 'active' });
    const set = await resolve();
    expect(set.anchor.id).toBe('X1');
    expect(ids(set)).toEqual(['X1', 'X2']);
    reset(['X1', 'X2'].map(twin), { X1: 'active', X2: 'active' });
    const canonical = await resolve();
    expect(set.digest).toBe(canonical.digest);
  });

  test('an older created_at still wins over a smaller id', async () => {
    reset([inv('A', { created_at: '2026-08-02T00:00:00Z' }), inv('Z', { created_at: '2026-08-01T00:00:00Z' })], { A: 'active', Z: 'active' });
    expect((await resolve()).anchor.id).toBe('Z');
  });
});
