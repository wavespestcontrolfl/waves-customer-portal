/**
 * Zelle payments from the Plaid bank feed (GATE_ZELLE_BANK_RECONCILE) —
 * services/zelle-notice-reconciler.js reconcileZelleBankFeed and the bank-line
 * parser in services/zelle-notice.js. Pins, with a per-table db mock:
 *   - the parser reads the bank's own wording first and refuses money that
 *     comes back (returned / reversed transfers);
 *   - gate off ⇒ the feed is never scanned; prod semantics = 'true' only;
 *   - the claim is per Plaid transaction (plaid_transaction_id, no email);
 *     a lost claim decides nothing;
 *   - an exact single match with a corroborating name settles through the
 *     Zelle tender with the receipt, raises no alert and stamps no email;
 *   - every park the feed can produce, and the quiet rule: no candidate
 *     invoice ⇒ no alert (a personal transfer on a mixed account);
 *   - the time rules: a stale posting day parks; an invoice created after the
 *     money arrived is never auto-matched;
 *   - a credit the bank corrected or withdrew after it was read never
 *     settles: the settlement fence checks the bank row before anything is
 *     retired and again under a bank-row lock right before the paid flip;
 *   - one failing row never stops the next;
 *   - every alert this module raises passes docs/admin-notifications.md;
 *   - the scheduler wiring and the Plaid request option (source pins).
 * The real SQL (scan, claim, CHECK) is pinned in
 * zelle-bank-feed-postgres.test.js.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  gateEnvValue: (name) => ['1', 'true', 'on'].includes(String(process.env[name] || '').toLowerCase()),
  isEnabled: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/open-balance', () => ({
  openSelfPayInvoicesByAmountDue: jest.fn(async () => []),
  rowIsSelfPayDue: jest.fn(async () => true),
  MAX_AMOUNT_CANDIDATES: 25,
}));
jest.mock('../services/invoice-manual-payment', () => ({
  recordManualPayment: jest.fn(async (id) => ({ invoice: { id, invoice_number: 'WPC-2026-0600', customer_id: 'cust-1', status: 'paid' }, receipt: { queued: true } })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => undefined) }));

const db = require('../models/db');
const OpenBalance = require('../services/open-balance');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const NotificationService = require('../services/notification-service');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { parseZelleBankPayer, isZelleBankCredit, bankZelleText } = require('../services/zelle-notice');
const {
  reconcileZelleBankFeed, isZelleBankReconcileEnabled, amountCentsOf, RECORDED_BY, BANK_SOURCE, _private,
} = require('../services/zelle-notice-reconciler');

// 2026-10-24 14:00 ET. Rows below are dated relative to it.
const NOW = new Date('2026-10-24T18:00:00Z').getTime();
const TODAY_START_ET = new Date('2026-10-24T04:00:00Z');

const bankRow = (over = {}) => ({
  plaid_transaction_id: 'ptx-1',
  account_label: 'capital-one-checking-0001',
  txn_date: '2026-10-24',
  amount: '117.00',
  description: 'Zelle',
  original_description: 'Zelle money received from PAT DOE',
  created_at: new Date('2026-10-24T16:30:00Z'),
  ...over,
});
const openRow = (over = {}) => ({
  id: 'inv-1', invoice_number: 'WPC-2026-0600', status: 'sent', customer_id: 'cust-1', total: '117.00', credit_applied: 0,
  service_date: '2026-10-20', created_at: new Date('2026-10-20T12:00:00Z'), customer_first_name: 'Pat', customer_last_name: 'Doe', ...over,
});

// Per-table recorder: every call is logged; terminal reads come from queues.
let tables;
function builder(table) {
  const t = tables[table] || (tables[table] = { firsts: [], returning: [], selects: [], calls: [] });
  const b = {};
  const chain = (name) => { b[name] = jest.fn((...args) => { t.calls.push([name, ...args]); return b; }); };
  ['where', 'whereIn', 'whereNot', 'whereNotNull', 'whereRaw', 'whereNotExists', 'orWhere', 'join', 'orderBy', 'limit', 'onConflict', 'ignore', 'insert'].forEach(chain);
  b.forUpdate = jest.fn(() => { t.calls.push(['forUpdate']); b.locked = true; return b; });
  b.first = jest.fn(async (...args) => {
    t.calls.push(['first', ...args]);
    if (b.locked && t.lockedRow !== undefined) return t.lockedRow;
    return t.firsts.length ? t.firsts.shift() : (t.fallback ?? null);
  });
  b.select = jest.fn(async (...args) => { t.calls.push(['select', ...args]); return t.selects.length ? t.selects.shift() : []; });
  b.update = jest.fn(async (patch) => { t.calls.push(['update', patch]); return 1; });
  // A queued function runs at read time (so a queued failure throws there, not at queue time).
  b.returning = jest.fn(async () => { const v = t.returning.length ? t.returning.shift() : []; return typeof v === 'function' ? v() : v; });
  return b;
}
const BANK = 'bank_transactions as bt';
const NOTICES = 'inbound_payment_notices';
const feed = (...rows) => { tables[BANK].selects.push(rows); };
// The claim insert's RETURNING row: what the database would hand back.
const claimed = (over = {}) => {
  tables[NOTICES].returning.push([{
    id: 'notice-1', plaid_transaction_id: 'ptx-1', source: BANK_SOURCE, payer_name: 'Pat Doe', amount_cents: 11700, claim_token: 'tok-1', ...over,
  }]);
};
const callsOf = (table, method) => (tables[table]?.calls || []).filter(([m]) => m === method).map(([, ...args]) => args);
const closesOf = (table) => callsOf(table, 'update').map(([p]) => p).filter((p) => p.status);
const insertsOf = (table) => callsOf(table, 'insert').map(([p]) => p);
const exactOnly = (rows) => async (cents, opts = {}) => (opts.toleranceCents ? [] : rows);

afterAll(() => { if (typeof Date.now.mockRestore === 'function') Date.now.mockRestore(); });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  tables = {
    [BANK]: { firsts: [], returning: [], selects: [], calls: [] },
    // The settlement fence's FOR UPDATE read of our claim finds it.
    [NOTICES]: { firsts: [], returning: [], selects: [], calls: [], lockedRow: { id: 'notice-1' } },
    emails: { firsts: [], returning: [], selects: [], calls: [] },
    // bankEvidenceHolds' read: by default the bank still lists the credit as read.
    bank_transactions: { firsts: [], returning: [], selects: [], calls: [], fallback: { amount: '117.00', direction: 'credit', suggestion: null } },
  };
  db.mockImplementation((table) => builder(table));
  delete process.env.GATE_ZELLE_BANK_RECONCILE;
  OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async () => []);
  OpenBalance.rowIsSelfPayDue.mockImplementation(async () => true);
});

describe('bank-line parser', () => {
  test.each([
    ['Zelle money received from PAT DOE', 'Pat Doe'],
    ['Zelle money received from PAT DOE Conf# AB12CD', 'Pat Doe'],
    ['Zelle money received from Pat Doe; Ref 123', 'Pat Doe'],
    ['ZELLE PAYMENT FROM JANE ROE', 'Jane Roe'],
    ['Zelle money received from Pat.Doe99@Example.com', 'pat.doe99@example.com'],
  ])('%s → %s', (text, payer) => {
    expect(parseZelleBankPayer(text)).toBe(payer);
  });

  test.each(['Zelle', 'ZELLE', 'Mobile Deposit', 'Zelle money received from ', null])('%s names no payer', (text) => {
    expect(parseZelleBankPayer(text)).toBeNull();
  });

  test('the bank\'s own wording is read before Plaid\'s cleaned name, and only a field that mentions Zelle counts', () => {
    expect(bankZelleText({ original_description: 'Zelle money received from PAT DOE', description: 'Zelle' })).toBe('Zelle money received from PAT DOE');
    expect(bankZelleText({ original_description: null, description: 'Zelle money received from Pat Doe' })).toBe('Zelle money received from Pat Doe');
    expect(bankZelleText({ original_description: 'ACH deposit', description: 'Zelle' })).toBe('Zelle');
    expect(bankZelleText({ original_description: 'Mobile Deposit', description: 'Mobile Deposit' })).toBeNull();
  });

  test('money coming back is not a payment', () => {
    expect(isZelleBankCredit({ description: 'Zelle money received from Pat Doe' })).toBe(true);
    expect(isZelleBankCredit({ description: 'Zelle money returned to you' })).toBe(false);
    expect(isZelleBankCredit({ original_description: 'Zelle payment reversal', description: 'Zelle' })).toBe(false);
    expect(isZelleBankCredit({ description: 'TRANSFER DEPOSIT From ....0001' })).toBe(false);
  });

  test('amounts become integer cents, never floats', () => {
    expect(amountCentsOf('117.00')).toBe(11700);
    expect(amountCentsOf('1250.1')).toBe(125010);
    expect(amountCentsOf('0.07')).toBe(7);
    expect(amountCentsOf(117)).toBe(11700);
    expect(amountCentsOf('0.00')).toBeNull();
    expect(amountCentsOf('-5.00')).toBeNull();
    expect(amountCentsOf('abc')).toBeNull();
  });
});

describe('gate', () => {
  test('dev/test: on unless explicitly false; prod: on only when exactly true', () => {
    expect(isZelleBankReconcileEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isZelleBankReconcileEnabled({ NODE_ENV: 'test', GATE_ZELLE_BANK_RECONCILE: 'false' })).toBe(false);
    process.env.GATE_ZELLE_BANK_RECONCILE = 'true';
    expect(isZelleBankReconcileEnabled({ NODE_ENV: 'production' })).toBe(true);
    delete process.env.GATE_ZELLE_BANK_RECONCILE;
    expect(isZelleBankReconcileEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  test('gate off ⇒ the feed is never scanned (stale-claim recovery still runs)', async () => {
    process.env.GATE_ZELLE_BANK_RECONCILE = 'false';
    expect(await reconcileZelleBankFeed({ now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalledWith(BANK);
    expect(db).toHaveBeenCalledWith(NOTICES);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });
});

describe('the scan', () => {
  test('reads Plaid credits on bank accounts in the window, skips ignored rows and rows that already have a notice', async () => {
    await _private.bankRowsToDecide(NOW);
    const calls = tables[BANK].calls;
    expect(calls).toContainEqual(['join', 'plaid_accounts as pa', 'pa.account_id', 'bt.plaid_account_id']);
    expect(calls).toContainEqual(['where', 'bt.source', 'plaid']);
    expect(calls).toContainEqual(['where', 'bt.direction', 'credit']);
    expect(calls).toContainEqual(['where', 'bt.account_type', 'bank']);
    expect(calls).toContainEqual(['whereNot', 'bt.status', 'ignored']);
    expect(calls).toContainEqual(['whereRaw', "bt.suggestion->'plaidModified' IS NULL AND bt.suggestion->'plaidRemoved' IS NULL"]);
    expect(calls).toContainEqual(['where', 'bt.txn_date', '>=', '2026-10-10']);
    expect(calls).toContainEqual(['whereRaw', expect.stringContaining('pa.created_at'), [2]]);
    expect(calls.some(([m]) => m === 'whereNotExists')).toBe(true);
    expect(calls).toContainEqual(['limit', 500]);
  });
});

describe('auto-apply', () => {
  test('one exact-cent invoice whose customer corroborates the payer ⇒ recorded via the Zelle tender with the receipt; no alert, no email stamp', async () => {
    feed(bankRow());
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    expect(await reconcileZelleBankFeed({ now: NOW })).toMatchObject({ read: 1, decided: 1, failed: 0 });

    const [claim] = insertsOf(NOTICES);
    expect(claim).toMatchObject({
      plaid_transaction_id: 'ptx-1', source: BANK_SOURCE, payer_name: 'Pat Doe', payer_name_norm: 'patdoe',
      amount_cents: 11700, memo: null, status: 'processing', received_at: TODAY_START_ET,
    });
    expect(claim).not.toHaveProperty('email_id');
    expect(callsOf(NOTICES, 'onConflict')).toEqual([['plaid_transaction_id']]);

    expect(recordManualPayment).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      method: 'zelle', reference: 'Pat Doe', note: '', recordedBy: RECORDED_BY, sendReceipt: true, via: 'both',
      expectedAmountCents: 11700, requireSelfPay: true, automated: true, settlementFence: expect.any(Function),
    }));
    expect(closesOf(NOTICES)[0]).toMatchObject({ status: 'auto_applied', match_method: 'amount_name', matched_invoice_id: 'inv-1', applied_by: RECORDED_BY });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalledWith('emails');
  });

  test('an invoice created later the same day but before the sync staged the payment still matches', async () => {
    feed(bankRow());
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow({ created_at: new Date('2026-10-24T15:00:00Z') })]));
    await reconcileZelleBankFeed({ now: NOW });
    expect(recordManualPayment).toHaveBeenCalledTimes(1);
  });

  test('a lost claim (another pass owns the transaction) decides nothing', async () => {
    feed(bankRow());
    tables[NOTICES].returning.push([]);
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    expect(await reconcileZelleBankFeed({ now: NOW })).toMatchObject({ owned: 1, decided: 0 });
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(closesOf(NOTICES)).toEqual([]);
  });
});

describe('parks', () => {
  test('no open invoice near the amount ⇒ parked no_match without an alert (most likely a personal transfer)', async () => {
    feed(bankRow());
    claimed();
    await reconcileZelleBankFeed({ now: NOW });
    expect(closesOf(NOTICES)[0]).toMatchObject({ status: 'parked', park_reason: 'no_match', candidates: '[]' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('an exact amount under another name ⇒ parked name_mismatch with the candidate, and the owner is alerted', async () => {
    feed(bankRow());
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow({ customer_first_name: 'Sam', customer_last_name: 'Roe' })]));
    await reconcileZelleBankFeed({ now: NOW });
    const park = closesOf(NOTICES)[0];
    expect(park).toMatchObject({ status: 'parked', park_reason: 'name_mismatch' });
    expect(JSON.parse(park.candidates)).toEqual([expect.objectContaining({ invoice_id: 'inv-1', exact_amount: true, name_match: false })]);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — review Pat Doe's $117.00 Zelle",
      'An open invoice is $117.00, but its customer name does not match the payer.',
      expect.objectContaining({ dedupeKey: 'zelle-notice:notice-1', bellDefault: true, link: '/admin/invoices', detail: 'Source: the bank feed.' }));
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a line that names no payer ⇒ parked parse_failed with the amount\'s candidates; alerted only when a candidate exists', async () => {
    feed(bankRow({ original_description: null, description: 'Zelle' }));
    claimed({ payer_name: null });
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    await reconcileZelleBankFeed({ now: NOW });
    expect(insertsOf(NOTICES)[0]).toMatchObject({ payer_name: null, payer_name_norm: null, amount_cents: 11700 });
    const park = closesOf(NOTICES)[0];
    expect(park).toMatchObject({ status: 'parked', park_reason: 'parse_failed' });
    expect(JSON.parse(park.candidates)).toEqual([expect.objectContaining({ invoice_id: 'inv-1', exact_amount: true, name_match: false })]);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Billing — review a $117.00 Zelle payment', 'The bank line does not say who sent it.', expect.any(Object));
    expect(recordManualPayment).not.toHaveBeenCalled();

    jest.clearAllMocks();
    tables[NOTICES].calls = [];
    feed(bankRow({ plaid_transaction_id: 'ptx-2', original_description: null, description: 'Zelle' }));
    claimed({ id: 'notice-2', plaid_transaction_id: 'ptx-2', payer_name: null });
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async () => []);
    await reconcileZelleBankFeed({ now: NOW });
    expect(closesOf(NOTICES)[0]).toMatchObject({ status: 'parked', park_reason: 'parse_failed' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a posting day that began more than 72h ago ⇒ parked stale_notice, never auto-settled', async () => {
    feed(bankRow({ txn_date: '2026-10-21', created_at: new Date('2026-10-24T16:30:00Z') }));
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    await reconcileZelleBankFeed({ now: NOW });
    expect(closesOf(NOTICES)[0]).toMatchObject({ status: 'parked', park_reason: 'stale_notice' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a posting day inside 72h still settles', async () => {
    feed(bankRow({ txn_date: '2026-10-22' }));
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    await reconcileZelleBankFeed({ now: NOW });
    expect(recordManualPayment).toHaveBeenCalledTimes(1);
  });

  test('an invoice created after the sync staged the payment is never auto-matched (it stays a candidate)', async () => {
    feed(bankRow({ created_at: new Date('2026-10-24T16:30:00Z') }));
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow({ created_at: new Date('2026-10-24T17:00:00Z') })]));
    await reconcileZelleBankFeed({ now: NOW });
    const park = closesOf(NOTICES)[0];
    expect(park).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(JSON.parse(park.candidates)).toHaveLength(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a same-payer same-amount transfer recorded in the last 14 days ⇒ parked possible_duplicate', async () => {
    feed(bankRow());
    claimed();
    tables[NOTICES].firsts.push({ id: 'notice-earlier' });
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    await reconcileZelleBankFeed({ now: NOW });
    expect(closesOf(NOTICES)[0]).toMatchObject({ status: 'parked', park_reason: 'possible_duplicate' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });
});

describe('the bank must still list the credit as it was read', () => {
  test.each([
    ['corrected to another amount', { amount: '17.00', direction: 'credit', suggestion: null }],
    ['now a debit', { amount: '117.00', direction: 'debit', suggestion: null }],
    ['withdrawn on a reviewed row', { amount: '117.00', direction: 'credit', suggestion: { plaidRemoved: true } }],
    ['a correction waiting on the operator', { amount: '117.00', direction: 'credit', suggestion: { plaidModified: { amount: 17 } } }],
    ['gone', null],
  ])('%s ⇒ the fence refuses before anything is recorded, and the notice parks apply_failed', async (_label, bankNow) => {
    feed(bankRow());
    claimed();
    tables.bank_transactions.firsts.push(bankNow);
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    // recordManualPayment's contract: the fence runs pre-lock first, and false is a 409 with nothing written.
    recordManualPayment.mockImplementationOnce(async (_id, opts) => {
      if (!(await opts.settlementFence(db))) {
        throw Object.assign(new Error('The settlement claim was lost before the payment could be recorded (the notice was reclaimed, or the bank changed or withdrew the payment) — nothing was recorded'), { statusCode: 409 });
      }
      throw new Error('the fence held — this test expects a refusal');
    });
    await reconcileZelleBankFeed({ now: NOW });
    expect(closesOf(NOTICES)[0]).toMatchObject({ status: 'parked', park_reason: 'apply_failed', apply_error: expect.stringMatching(/bank changed or withdrew/) });
    expect(callsOf('bank_transactions', 'where')).toContainEqual([{ plaid_transaction_id: 'ptx-1' }]);
  });

  test('the settlement fence re-checks the claim and the bank row, locking the row FOR SHARE under the invoice lock', async () => {
    feed(bankRow());
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    await reconcileZelleBankFeed({ now: NOW });
    const { settlementFence } = recordManualPayment.mock.calls[0][1];
    // A fake payment connection: the notice claim, then the bank row.
    const fenceConn = (reads) => {
      const seen = [];
      const conn = (table) => {
        const q = { table, locks: [] };
        seen.push(q);
        const b = {
          where: jest.fn((w) => { q.where = w; return b; }),
          forUpdate: jest.fn(() => { q.locks.push('update'); return b; }),
          forShare: jest.fn(() => { q.locks.push('share'); return b; }),
          first: jest.fn(async () => reads[table]),
        };
        return b;
      };
      return { conn, seen };
    };
    const ok = fenceConn({ inbound_payment_notices: { id: 'notice-1' }, bank_transactions: { amount: '117.00', direction: 'credit', suggestion: null } });
    expect(await settlementFence(ok.conn, { id: 'inv-1' })).toBe(true);
    expect(ok.seen.map(({ table, locks }) => [table, locks])).toEqual([['inbound_payment_notices', ['update']], ['bank_transactions', ['share']]]);
    expect(ok.seen[0].where).toEqual({ id: 'notice-1', status: 'processing', claim_token: 'tok-1' });

    const preLock = fenceConn({ inbound_payment_notices: { id: 'notice-1' }, bank_transactions: { amount: '117.00', direction: 'credit', suggestion: null } });
    expect(await settlementFence(preLock.conn)).toBe(true);
    expect(preLock.seen[1].locks).toEqual([]); // the pre-lock read takes no row lock

    const corrected = fenceConn({ inbound_payment_notices: { id: 'notice-1' }, bank_transactions: { amount: '17.00', direction: 'credit', suggestion: null } });
    expect(await settlementFence(corrected.conn, { id: 'inv-1' })).toBe(false);
    const lostClaim = fenceConn({ inbound_payment_notices: undefined, bank_transactions: { amount: '117.00', direction: 'credit', suggestion: null } });
    expect(await settlementFence(lostClaim.conn, { id: 'inv-1' })).toBe(false);
    expect(lostClaim.seen).toHaveLength(1); // a lost claim never reads the bank row
  });
});

describe('rows the pass does not decide', () => {
  test('money coming back is skipped without a claim', async () => {
    feed(bankRow({ original_description: 'Zelle money returned to you', description: 'Zelle' }));
    expect(await reconcileZelleBankFeed({ now: NOW })).toMatchObject({ read: 1, skipped: 1, decided: 0 });
    expect(insertsOf(NOTICES)).toEqual([]);
  });

  test('one failing row never stops the next; the failed one has no claim, so the next pass reads it again', async () => {
    feed(bankRow({ plaid_transaction_id: 'ptx-bad' }), bankRow({ plaid_transaction_id: 'ptx-2' }));
    tables[NOTICES].returning.push(() => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); });
    claimed({ id: 'notice-2', plaid_transaction_id: 'ptx-2' });
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(exactOnly([openRow()]));
    expect(await reconcileZelleBankFeed({ now: NOW })).toMatchObject({ read: 2, decided: 1, failed: 1 });
    expect(recordManualPayment).toHaveBeenCalledTimes(1);
  });
});

describe('alerts follow docs/admin-notifications.md', () => {
  const { parkedAlert, receiptCheckAlert, lateSettlementAlert } = _private;
  const REASONS = ['no_match', 'multiple_matches', 'name_mismatch', 'possible_duplicate', 'sender_unverified', 'parse_failed', 'apply_failed', 'stale_notice'];
  const candidates = [{ invoice_id: 'inv-1' }];

  test.each(REASONS)('%s composes for both sources and every payer shape', (reason) => {
    for (const source of [BANK_SOURCE, 'capitalone_zelle']) {
      for (const notice of [
        { id: 'n-1', source, payer_name: 'Pat Doe', amount_cents: 11700 },
        { id: 'n-2', source, payer_name: 'Maximiliana Wolfeschlegelsteinhausen-Bergerdorff', amount_cents: 1234567 },
        { id: 'n-3', source, payer_name: null, amount_cents: null },
        { id: 'n-4', source, payer_name: 'pat.doe99@example.com', amount_cents: 500 },
      ]) {
        const alert = parkedAlert(notice, reason, { candidates, applyError: 'PaymentIntent in flight' });
        expect(() => composeAdminAlert(alert.spec)).not.toThrow();
        expect(alert.opts.dedupeKey).toBe(`zelle-notice:${notice.id}`);
      }
    }
  });

  test('only a bank-feed no_match or parse_failed with no candidate at all is quiet', () => {
    const bank = { id: 'n-1', source: BANK_SOURCE, payer_name: 'Pat Doe', amount_cents: 11700 };
    expect(parkedAlert(bank, 'no_match', { candidates: [] })).toBeNull();
    expect(parkedAlert(bank, 'parse_failed', { candidates: null })).toBeNull();
    expect(parkedAlert(bank, 'no_match', { candidates })).not.toBeNull();
    expect(parkedAlert(bank, 'stale_notice', { candidates: [] })).not.toBeNull();
    expect(parkedAlert({ ...bank, source: 'capitalone_zelle' }, 'no_match', { candidates: [] })).not.toBeNull();
  });

  test('the receipt-check and late-settlement alerts compose and open the invoice', () => {
    const notice = { id: 'n-1', source: BANK_SOURCE, payer_name: 'Pat Doe', amount_cents: 11700 };
    const invoice = { id: 'inv-1', invoice_number: 'WPC-2026-0600' };
    for (const alert of [receiptCheckAlert(notice, invoice), lateSettlementAlert(notice, invoice)]) {
      const composed = composeAdminAlert(alert.spec);
      expect(composed.link).toBe('/admin/invoices?invoice=inv-1');
      expect(composed.metadata.subject).toEqual({ type: 'invoice', id: 'inv-1' });
    }
  });
});

describe('wiring (source pins)', () => {
  test('the hourly Plaid sync job runs the bank-feed pass after the sync, isolated from it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const job = src.slice(src.indexOf("runExclusive('plaid-bank-sync'"));
    expect(job.indexOf('syncAllItems()')).toBeGreaterThan(-1);
    expect(job.indexOf('reconcileZelleBankFeed()')).toBeGreaterThan(job.indexOf('syncAllItems()'));
    expect(job.slice(job.indexOf('reconcileZelleBankFeed()'), job.indexOf('reconcileZelleBankFeed()') + 200)).toMatch(/\.catch\(/);
  });

  test('the Plaid sync asks for the bank\'s own wording and stores it beside the cleaned name', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', 'services', 'plaid-client.js'), 'utf8');
    expect(client).toMatch(/include_original_description: true/);
    const { mapTransaction } = require('../services/plaid-sync');
    const account = { account_label: 'capital-one-checking-0001', account_type: 'bank', enabled: true, sync_from: '2026-01-01' };
    const txn = { transaction_id: 't-1', account_id: 'a-1', amount: -117, date: '2026-10-24', name: 'Zelle', original_description: '  Zelle money received from  PAT DOE ', pending: false, iso_currency_code: 'USD' };
    expect(mapTransaction(txn, account).row).toMatchObject({ description: 'Zelle', original_description: 'Zelle money received from PAT DOE', direction: 'credit', amount: 117 });
    expect(mapTransaction({ ...txn, original_description: undefined }, account).row.original_description).toBeNull();
  });
});
