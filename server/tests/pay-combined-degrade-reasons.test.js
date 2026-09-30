// Dunning consolidation PR 1: combinedEligibleSiblings gains an OBSERVER,
// onDegrade(reason), so the customer-level dunning set can tell "genuinely a
// single invoice" ('none') from "the combined flow could not engage"
// (gate_off | payer_anchor | payer_unresolved | incomplete | over_cap). The
// return values are unchanged (null or the sibling rows), the setup-seam
// throws are unchanged, and the caller's `database` now reaches the payer
// resolve too (a boundary check inside a held transaction must not need a
// second pool connection). invoiceCreditWouldFullyCover moved here with a
// `database` param; pay-v2 re-exports the same function.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockGates = { autoApplyAccountCredit: true };
const mockEnabled = { payIncludeBalance: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => mockEnabled[g] === true,
  gates: mockGates,
}));
const mockResolveForInvoice = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolveForInvoice(...a) }));
const mockStopped = jest.fn();
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: (...a) => mockStopped(...a) }));
const mockOpenBalance = jest.fn();
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: (...a) => mockOpenBalance(...a) }));
const mockReconcile = jest.fn();
const mockRetrieve = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...a) => mockRetrieve(...a),
  cancelPaymentIntent: jest.fn(),
  assertNoInvoiceChargeReconciliationPending: (...a) => mockReconcile(...a),
}));

const db = require('../models/db');
const PayCombined = require('../services/pay-combined');

const anchor = (over = {}) => ({
  id: 'inv-anchor', invoice_number: 'INV-A', customer_id: 'cust-1', payer_id: null, payer_statement_id: null,
  status: 'sent', total: '100.00', credit_applied: 0, stripe_payment_intent_id: null, ...over,
});
const sib = (id, over = {}) => ({
  id, invoice_number: `INV-${id}`, status: 'overdue', total: '50.00', credit_applied: 0, stripe_payment_intent_id: null, ...over,
});

let reasons;
let fullRows;
const defaultFullRow = (id) => ({ id, invoice_number: `INV-${id}`, customer_id: 'cust-1', status: 'overdue', payer_id: null, payer_statement_id: null, scheduled_send_error: null });
const serveFullRow = (table) => ({
  where: (cond) => ({
    first: async () => {
      // the real deposit check reads the visit's provenance: same customer, no estimate
      if (table === 'scheduled_services') return { id: cond.id, customer_id: 'cust-real', source_estimate_id: null };
      return fullRows.has(cond.id) ? fullRows.get(cond.id) : defaultFullRow(cond.id);
    },
  }),
});
const opts = (extra = {}) => ({ onDegrade: (r) => reasons.push(r), ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  reasons = [];
  mockEnabled.payIncludeBalance = true;
  mockGates.autoApplyAccountCredit = true;
  mockResolveForInvoice.mockResolvedValue({ payerId: null });
  mockStopped.mockResolvedValue(new Set());
  mockOpenBalance.mockResolvedValue([sib('s1')]);
  mockReconcile.mockResolvedValue(undefined);
  // The readOnly member predicate re-reads each sibling's FULL invoice row by
  // id (openBalanceInvoices rows carry no customer/payer columns).
  fullRows = new Map();
  db.mockImplementation(serveFullRow);
});

describe('onDegrade reasons — each null return names why, and the return value is unchanged', () => {
  test('a combined selection engaged: the siblings come back and nothing is reported', async () => {
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts());
    expect(out.map((i) => i.id)).toEqual(['s1']);
    expect(reasons).toEqual([]);
  });

  test('gate off', async () => {
    mockEnabled.payIncludeBalance = false;
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['gate_off']);
    expect(mockOpenBalance).not.toHaveBeenCalled();
  });

  test.each([
    ['payer_id set', { payer_id: 'payer-1' }],
    ['payer_statement_id set', { payer_statement_id: 'stmt-1' }],
  ])('payer-billed anchor (%s)', async (_label, over) => {
    await expect(PayCombined.combinedEligibleSiblings(anchor(over), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['payer_anchor']);
    expect(mockResolveForInvoice).not.toHaveBeenCalled();
  });

  test('the live payer resolve finds a payer the raw column does not show', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-9' });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['payer_anchor']);
  });

  test('the payer resolve fails: payer_unresolved (fail closed, not "single")', async () => {
    mockResolveForInvoice.mockRejectedValue(new Error('lookup down'));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['payer_unresolved']);
  });

  test.each([
    ['a sibling payer resolve failed', (args) => args.onResolveFailure()],
    ['the candidate bound was hit', (args) => args.onTruncation(200)],
  ])('incomplete open read: %s', async (_label, signal) => {
    mockOpenBalance.mockImplementation(async (_customer, args) => { signal(args); return [sib('s1')]; });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['incomplete']);
  });

  test('a missing customer id and an unexpected failure both read as incomplete', async () => {
    await expect(PayCombined.combinedEligibleSiblings(anchor({ customer_id: null }), opts())).resolves.toBeNull();
    mockOpenBalance.mockRejectedValue(new Error('boom'));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['incomplete', 'incomplete']);
  });

  test('over the sibling cap', async () => {
    mockOpenBalance.mockResolvedValue(
      Array.from({ length: PayCombined.MAX_COMBINED_SIBLINGS + 1 }, (_v, i) => sib(`s${i}`)),
    );
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['over_cap']);
  });

  describe('none: the combined flow engaged and simply no sibling rides it', () => {
    test('no other open invoice', async () => {
      mockOpenBalance.mockResolvedValue([]);
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });

    test('every other invoice is stopped', async () => {
      mockStopped.mockResolvedValue(new Set(['s1']));
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });

    test('every other invoice carries a live PaymentIntent', async () => {
      mockOpenBalance.mockResolvedValue([sib('s1', { stripe_payment_intent_id: 'pi_live' })]);
      mockRetrieve.mockResolvedValue({ id: 'pi_live', status: 'processing', created: Math.floor(Date.now() / 1000), metadata: {} });
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });

    test('every other invoice has a charge reconciliation pending', async () => {
      mockReconcile.mockRejectedValue(new Error('reconciliation pending'));
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });
  });
});

describe('unchanged behavior', () => {
  test('without a callback the same inputs return the same values', async () => {
    await expect(PayCombined.combinedEligibleSiblings(anchor())).resolves.toHaveLength(1);
    mockEnabled.payIncludeBalance = false;
    await expect(PayCombined.combinedEligibleSiblings(anchor())).resolves.toBeNull();
  });

  test('a throwing observer never changes the result', async () => {
    const out = await PayCombined.combinedEligibleSiblings(anchor(), { onDegrade: () => { throw new Error('observer bug'); } });
    expect(out).toHaveLength(1);
    mockOpenBalance.mockResolvedValue([]);
    await expect(PayCombined.combinedEligibleSiblings(anchor(), { onDegrade: () => { throw new Error('observer bug'); } })).resolves.toBeNull();
  });

  test('the setup-seam abort verdicts still throw, and report nothing', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts({ throwOnPayerAnchor: true })))
      .rejects.toMatchObject({ payerBilledAnchor: true, combinedSetupAbort: true });
    mockResolveForInvoice.mockRejectedValue(new Error('lookup down'));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts({ throwOnPayerAnchor: true })))
      .rejects.toMatchObject({ combinedSetupAbort: true, statusCode: 409 });
    expect(reasons).toEqual([]);
  });

  test('the closed reason list is exported', () => {
    expect(PayCombined.DEGRADE_REASONS).toEqual(['gate_off', 'payer_anchor', 'payer_unresolved', 'incomplete', 'over_cap', 'none']);
  });
});

describe('the caller\'s database handle reaches the payer resolve', () => {
  test('resolveForInvoice and the open read receive the SAME handle', async () => {
    const handle = jest.fn(serveFullRow);
    await PayCombined.combinedEligibleSiblings(anchor({ scheduled_service_id: 'visit-1' }), { database: handle });
    expect(mockResolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      database: handle, customerId: 'cust-1', scheduledServiceId: 'visit-1', throwOnError: true,
    }));
    expect(mockOpenBalance).toHaveBeenCalledWith('cust-1', expect.objectContaining({ database: handle }));
    expect(mockStopped).toHaveBeenCalledWith(['s1'], { database: handle });
    // Default callers (the pay page, money seams) keep the writing fence.
    expect(mockReconcile).toHaveBeenCalledWith('s1', handle, { readOnly: false });
  });

  test('readOnly reaches the sibling reconciliation fence', async () => {
    const handle = jest.fn(serveFullRow);
    await PayCombined.combinedEligibleSiblings(anchor(), { database: handle, readOnly: true });
    expect(mockReconcile).toHaveBeenCalledWith('s1', handle, { readOnly: true });
  });

  test('with no handle the default pool handle is passed explicitly', async () => {
    await PayCombined.combinedEligibleSiblings(anchor());
    expect(mockResolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ database: db }));
  });
});

describe('invoiceCreditWouldFullyCover (hoisted from pay-v2)', () => {
  const invoice = { customer_id: 'cust-1', total: 100, credit_applied: 0 };
  const dbReturning = (row) => {
    const handle = jest.fn(() => ({ where: () => ({ first: jest.fn(async () => row) }) }));
    return handle;
  };

  test('reads through the handle it is given, never the pool', async () => {
    const handle = dbReturning({ account_credits: 150, auto_apply_account_credit: true });
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: handle })).resolves.toBe(true);
    expect(handle).toHaveBeenCalledWith('customers');
    expect(db).not.toHaveBeenCalled();
  });

  test('the same verdicts as before: partial, opted out, payer-billed, gate off', async () => {
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: dbReturning({ account_credits: 40, auto_apply_account_credit: true }) })).resolves.toBe(false);
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: dbReturning({ account_credits: 150, auto_apply_account_credit: false }) })).resolves.toBe(false);
    const untouched = dbReturning({ account_credits: 150, auto_apply_account_credit: true });
    await expect(PayCombined.invoiceCreditWouldFullyCover({ ...invoice, payer_id: 'payer-1' }, { database: untouched })).resolves.toBe(false);
    expect(untouched).not.toHaveBeenCalled();
    mockGates.autoApplyAccountCredit = false;
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: untouched })).resolves.toBe(false);
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe('readOnly sibling fence: recognised pending states exclude, anything else degrades', () => {
  const code = (c, extra = {}) => Object.assign(new Error(c), { code: c, ...extra });

  test.each([
    ['STRIPE_CHARGE_IN_PROGRESS', code('STRIPE_CHARGE_IN_PROGRESS')],
    ['STRIPE_AMBIGUOUS_OUTCOME', code('STRIPE_AMBIGUOUS_OUTCOME', { reconciliationRequired: true })],
    ['STRIPE_CHARGED_DB_FAILED', code('STRIPE_CHARGED_DB_FAILED', { reconciliationRequired: true })],
    ['DEPOSIT_RECONCILIATION_REQUIRED', code('DEPOSIT_RECONCILIATION_REQUIRED')],
  ])('readOnly: %s excludes just that sibling', async (_l, err) => {
    mockOpenBalance.mockResolvedValue([sib('s1'), sib('s2')]);
    mockReconcile.mockImplementation(async (id) => { if (id === 's1') throw err; });
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts({ readOnly: true }));
    expect(out.map((i) => i.id)).toEqual(['s2']);
    expect(reasons).toEqual([]);
  });

  test('readOnly: an unexpected fence error degrades to incomplete (null)', async () => {
    mockOpenBalance.mockResolvedValue([sib('s1'), sib('s2')]);
    mockReconcile.mockImplementation(async (id) => { if (id === 's1') throw new Error('connection terminated'); });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts({ readOnly: true }))).resolves.toBeNull();
    expect(reasons).toEqual(['incomplete']);
  });

  test('NOT readOnly: the same unexpected error still just excludes the sibling (unchanged)', async () => {
    mockOpenBalance.mockResolvedValue([sib('s1'), sib('s2')]);
    mockReconcile.mockImplementation(async (id) => { if (id === 's1') throw new Error('connection terminated'); });
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts());
    expect(out.map((i) => i.id)).toEqual(['s2']);
    expect(reasons).toEqual([]);
  });
});

describe('readOnly siblings arrive in the REAL openBalanceInvoices column shape', () => {
  // The select list of open-balance.js openInvoiceQuery, read from its source
  // so a column added or dropped there changes this fixture: those rows carry
  // NO customer_id / payer_id / payer_statement_id / scheduled_send_error.
  const fs = require('fs');
  const path = require('path');
  const openSrc = fs.readFileSync(path.join(__dirname, '../services/open-balance.js'), 'utf8');
  const listStart = openSrc.indexOf('function openInvoiceQuery');
  const selectBody = openSrc.slice(openSrc.indexOf('.select(', listStart), openSrc.indexOf(');', openSrc.indexOf('.select(', listStart)));
  const realColumns = [...selectBody.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((c) => c !== 'is_overdue');
  const openShaped = (id, over = {}) => {
    const row = Object.fromEntries(realColumns.map((c) => [c, null]));
    return { ...row, id, invoice_number: `INV-${id}`, status: 'overdue', total: '50.00', credit_applied: 0, ...over };
  };

  test('fixture sanity: the real select list has no ownership columns', () => {
    expect(realColumns).toEqual(expect.arrayContaining(['id', 'status', 'total', 'scheduled_service_id']));
    for (const c of ['customer_id', 'payer_id', 'payer_statement_id', 'scheduled_send_error']) expect(realColumns).not.toContain(c);
  });

  test('the payer resolve receives the sibling\'s REAL customer_id (from the full row), never undefined', async () => {
    mockOpenBalance.mockResolvedValue([openShaped('s1', { scheduled_service_id: 'visit-9' })]);
    fullRows.set('s1', { ...openShaped('s1', { scheduled_service_id: 'visit-9' }), customer_id: 'cust-real', payer_id: null, payer_statement_id: null, scheduled_send_error: null });
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts({ readOnly: true }));
    expect(out.map((i) => i.id)).toEqual(['s1']);
    const siblingResolve = mockResolveForInvoice.mock.calls.map((c) => c[0]).find((a) => a.scheduledServiceId === 'visit-9');
    expect(siblingResolve).toMatchObject({ customerId: 'cust-real', throwOnError: true });
    expect(siblingResolve.customerId).not.toBe('undefined');
  });

  test.each([
    ['payer_id', { payer_id: 'payer-1' }],
    ['payer_statement_id', { payer_statement_id: 'stmt-1' }],
    ['a withdrawal stamp', { scheduled_send_error: 'payer_billed:payer-1' }],
    ['no longer collectible', { status: 'void' }],
  ])('a sibling whose FULL row shows %s is excluded even though the open row did not', async (_l, over) => {
    mockOpenBalance.mockResolvedValue([openShaped('s1'), openShaped('s2')]);
    fullRows.set('s1', { ...openShaped('s1'), customer_id: 'cust-1', payer_id: null, payer_statement_id: null, scheduled_send_error: null, ...over });
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts({ readOnly: true }));
    expect(out.map((i) => i.id)).toEqual(['s2']);
  });

  test('a sibling row that vanished between the open read and the check is excluded', async () => {
    mockOpenBalance.mockResolvedValue([openShaped('s1'), openShaped('s2')]);
    fullRows.set('s1', undefined);
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts({ readOnly: true }));
    expect(out.map((i) => i.id)).toEqual(['s2']);
  });

  test('a failed full-row read degrades the selection to incomplete (the resolver holds)', async () => {
    mockOpenBalance.mockResolvedValue([openShaped('s1')]);
    db.mockImplementation(() => ({ where: () => ({ first: async () => { throw new Error('connection terminated'); } }) }));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts({ readOnly: true }))).resolves.toBeNull();
    expect(reasons).toEqual(['incomplete']);
  });
});
