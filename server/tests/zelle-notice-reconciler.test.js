/**
 * services/zelle-notice-reconciler.js — the deterministic decision table the
 * email sync runs on a Capital One Zelle notice (GATE_ZELLE_NOTICE_RECONCILE).
 * Pins, with a per-table db mock:
 *   - gate off ⇒ returns false before ANY DB read; prod semantics = 'true' only;
 *   - non-notice mail ⇒ false, no reads;
 *   - untrusted sender ⇒ parked `sender_unverified`, returns false (classifier still runs);
 *   - the at-most-once claim (email_id UNIQUE): a lost claim decides nothing;
 *   - exact single match by memo invoice number / by corroborating name ⇒
 *     recordManualPayment(zelle, receipt email + SMS) + `auto_applied` + stamps;
 *   - every park reason (no_match, name_mismatch, multiple_matches,
 *     possible_duplicate, apply_failed, parse_failed) with the candidate list;
 *   - payer re-resolution drops (rowIsSelfPayDue=false) never auto-apply;
 *   - the sync hook is wired (source pin).
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
}));
jest.mock('../services/invoice-manual-payment', () => ({
  recordManualPayment: jest.fn(async (id) => ({ invoice: { id, invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'paid' }, receipt: { email: { ok: true }, sms: { ok: true } } })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => undefined) }));

const db = require('../models/db');
const OpenBalance = require('../services/open-balance');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const NotificationService = require('../services/notification-service');
const { maybeHandleZelleNotice, isZelleReconcileEnabled, RECORDED_BY } = require('../services/zelle-notice-reconciler');

const TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'zelle-notice-capitalone.txt'), 'utf8');
const FORWARDED_AUTH = 'mx.google.com; dkim=pass header.i=@notification.capitalone.com header.s=k1; '
  + 'spf=pass smtp.mailfrom="owner+caf_=contact=wavespestcontrol.com@gmail.com"; dmarc=pass header.from=capitalone.com';

function notice(over = {}) {
  return {
    id: 'email-1', from_address: 'capitalone@notification.capitalone.com', subject: 'Good news: Someone sent you money with Zelle®.',
    body_text: TEXT, body_html: null, snippet: 'PAT DOE has just sent you money', authentication_results: FORWARDED_AUTH,
    received_at: new Date('2026-09-02T17:00:00Z'), ...over,
  };
}
const openRow = (over = {}) => ({
  id: 'inv-1', invoice_number: 'WPC-2026-0500', status: 'sent', customer_id: 'cust-1', total: '117.00', credit_applied: 0,
  service_date: '2026-09-01', customer_first_name: 'Pat', customer_last_name: 'Doe', ...over,
});

// Per-table recorder: every call is logged; terminal reads come from queues.
let tables;
function builder(table) {
  const t = tables[table] || (tables[table] = { firsts: [], returning: [], calls: [] });
  const b = {};
  const chain = (name) => { b[name] = jest.fn((...args) => { t.calls.push([name, ...args]); return b; }); };
  ['where', 'whereIn', 'whereNotIn', 'orderBy', 'limit', 'onConflict', 'ignore', 'insert', 'join'].forEach(chain);
  b.first = jest.fn(async (...args) => { t.calls.push(['first', ...args]); return t.firsts.length ? t.firsts.shift() : null; });
  b.select = jest.fn(async () => []);
  b.update = jest.fn(async (patch) => { t.calls.push(['update', patch]); return 1; });
  b.returning = jest.fn(async () => (t.returning.length ? t.returning.shift() : []));
  return b;
}
const claimed = (row = { id: 'notice-1', payer_name: 'Pat Doe', amount_cents: 11700 }) => { tables.inbound_payment_notices.returning.push([row]); };
const updatesOf = (table) => (tables[table]?.calls || []).filter(([m]) => m === 'update').map(([, p]) => p);
const insertsOf = (table) => (tables[table]?.calls || []).filter(([m]) => m === 'insert').map(([, p]) => p);

beforeEach(() => {
  jest.clearAllMocks();
  tables = { inbound_payment_notices: { firsts: [], returning: [], calls: [] }, emails: { firsts: [], returning: [], calls: [] } };
  db.mockImplementation((table) => builder(table));
  delete process.env.GATE_ZELLE_NOTICE_RECONCILE;
  OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async () => []);
  OpenBalance.rowIsSelfPayDue.mockImplementation(async () => true);
});

describe('gate', () => {
  test('dev/test: on unless explicitly false; prod: on only when exactly true', () => {
    expect(isZelleReconcileEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isZelleReconcileEnabled({ NODE_ENV: 'test', GATE_ZELLE_NOTICE_RECONCILE: 'false' })).toBe(false);
    process.env.GATE_ZELLE_NOTICE_RECONCILE = 'true';
    expect(isZelleReconcileEnabled({ NODE_ENV: 'production' })).toBe(true);
    delete process.env.GATE_ZELLE_NOTICE_RECONCILE;
    expect(isZelleReconcileEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  test('gate off ⇒ false with zero DB reads, even for a real notice', async () => {
    process.env.GATE_ZELLE_NOTICE_RECONCILE = 'false';
    expect(await maybeHandleZelleNotice(notice())).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('not ours', () => {
  test('ordinary mail ⇒ false, no reads', async () => {
    expect(await maybeHandleZelleNotice(notice({ subject: 'Hello', body_text: 'Can you come Tuesday?', snippet: 'Can you' }))).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('untrusted sender that still parses ⇒ parked sender_unverified, returns false so the classifier sees it', async () => {
    claimed();
    const out = await maybeHandleZelleNotice(notice({ from_address: 'owner@gmail.com', authentication_results: 'mx.google.com; dkim=pass header.i=@gmail.com' }));
    expect(out).toBe(false);
    expect(insertsOf('inbound_payment_notices')[0]).toMatchObject({ email_id: 'email-1', status: 'processing', payer_name: 'Pat Doe', amount_cents: 11700 });
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'sender_unverified' });
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_parked:sender_unverified' });
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment needs review', expect.stringContaining('sender unverified'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-1' }));
  });

  test('a lost claim (another sync owns the email) decides nothing', async () => {
    // returning [] ⇒ onConflict(email_id).ignore() dropped our insert
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(updatesOf('inbound_payment_notices')).toHaveLength(0);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });
});

describe('auto-apply', () => {
  test('exactly one exact-cent invoice whose customer corroborates the payer ⇒ recorded via the Zelle tender with the receipt', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700);
    expect(recordManualPayment).toHaveBeenCalledWith('inv-1', {
      method: 'zelle', reference: 'Pat Doe', note: 'Zelle memo: Quarterly Service Pat D', recordedBy: RECORDED_BY, sendReceipt: true, via: 'both',
    });
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied', match_method: 'amount_name', matched_invoice_id: 'inv-1', matched_customer_id: 'cust-1', applied_by: RECORDED_BY });
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_applied:WPC-2026-0500', classification: 'other' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment applied', expect.stringContaining('receipt: email + sms'), expect.anything());
  });

  test('the memo invoice number picks one of several exact-cent invoices', async () => {
    claimed();
    const memoNotice = notice({ body_text: TEXT.replace('Quarterly Service Pat D', 'wpc-2026-0501 lawn') });
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [
      openRow(), openRow({ id: 'inv-2', invoice_number: 'WPC-2026-0501', customer_id: 'cust-2', customer_first_name: 'Sam', customer_last_name: 'Roe' }),
    ]));
    expect(await maybeHandleZelleNotice(memoNotice)).toBe(true);
    expect(recordManualPayment).toHaveBeenCalledWith('inv-2', expect.objectContaining({ method: 'zelle', note: 'Zelle memo: wpc-2026-0501 lawn' }));
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied', match_method: 'memo_invoice_number', matched_invoice_id: 'inv-2' });
  });

  test('a record-payment refusal parks apply_failed with the reason — never a silent loss', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('A payment is already in flight (processing)'), { statusCode: 409 }));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = updatesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'apply_failed', apply_error: 'A payment is already in flight (processing)', matched_customer_id: 'cust-1' });
    expect(JSON.parse(patch.candidates)[0]).toMatchObject({ invoice_id: 'inv-1', exact_amount: true, name_match: true });
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_parked:apply_failed' });
  });
});

describe('park reasons', () => {
  test('no exact-cent invoice ⇒ no_match, with the near-amount candidates for the operator', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [openRow({ id: 'inv-9', invoice_number: 'WPC-2026-0509', total: '120.00' })] : []));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700, { toleranceCents: 500 });
    const patch = updatesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(JSON.parse(patch.candidates)).toEqual([expect.objectContaining({ invoice_id: 'inv-9', amount_due_cents: 12000, exact_amount: false, name_match: true })]);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('exact amount but the customer name does not corroborate ⇒ name_mismatch', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow({ customer_first_name: 'Sam', customer_last_name: 'Roe' })]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = updatesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'name_mismatch' });
    expect(JSON.parse(patch.candidates)[0]).toMatchObject({ invoice_id: 'inv-1', exact_amount: true, name_match: false });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('two exact-cent invoices that both corroborate ⇒ multiple_matches', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow(), openRow({ id: 'inv-2', invoice_number: 'WPC-2026-0501' })]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'multiple_matches' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('same payer + amount already applied within the window ⇒ possible_duplicate, even with a clean single match', async () => {
    claimed();
    tables.inbound_payment_notices.firsts.push({ id: 'notice-0' }); // the duplicate-guard read
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'possible_duplicate' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a row the live payer re-resolution drops never auto-applies', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    OpenBalance.rowIsSelfPayDue.mockResolvedValueOnce(false);
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('trusted sender whose template did not parse ⇒ parse_failed (amount unknown), handled', async () => {
    claimed({ id: 'notice-1', payer_name: null, amount_cents: null });
    expect(await maybeHandleZelleNotice(notice({ body_text: 'Someone sent you money with Zelle. Sign in to see details.', snippet: 'x' }))).toBe(true);
    expect(insertsOf('inbound_payment_notices')[0]).toMatchObject({ amount_cents: null, payer_name: null, status: 'processing' });
    expect(updatesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'parse_failed' });
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).not.toHaveBeenCalled();
  });
});

describe('sync wiring', () => {
  test('upsertEmail runs the reconciler before classification and skips the classifier when it owns the email', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'email', 'email-sync.js'), 'utf8');
    const hook = src.indexOf("require('../zelle-notice-reconciler')");
    const classify = src.indexOf("require('./email-classifier')");
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(classify);
    expect(src).toMatch(/zelleHandled = await maybeHandleZelleNotice\(email\)/);
    expect(src).toMatch(/if \(!proofHandled && !approvalControl && !zelleHandled && /);
    expect(src).toMatch(/\(proofHandled \|\| approvalControl \|\| zelleHandled\) && await bellClaimColumnExists\(\)/);
  });
});
