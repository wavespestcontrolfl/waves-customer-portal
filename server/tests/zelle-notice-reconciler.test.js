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
  // The settle-and-close step runs under a row lock: the trx is the same
  // per-table recorder, plus forUpdate; the locked read comes from `locks`.
  fn.transaction = jest.fn(async (work) => {
    const trx = (table) => fn(table);
    trx.fn = fn.fn;
    trx.raw = fn.raw;
    return work(trx);
  });
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
  recordManualPayment: jest.fn(async (id) => ({ invoice: { id, invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'paid' }, receipt: { email: { ok: true }, sms: { ok: true } } })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => undefined) }));

const db = require('../models/db');
const OpenBalance = require('../services/open-balance');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const NotificationService = require('../services/notification-service');
const { maybeHandleZelleNotice, isZelleReconcileEnabled, recoverStaleClaims, sweepStaleClaims, reofferMarkedEmails, RECORDED_BY, ZELLE_RETRY_MARK } = require('../services/zelle-notice-reconciler');

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
  ['where', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'onConflict', 'ignore', 'insert', 'join'].forEach(chain);
  b.forUpdate = jest.fn(() => { t.calls.push(['forUpdate']); b.locked = true; return b; });
  b.first = jest.fn(async (...args) => {
    t.calls.push(['first', ...args]);
    if (b.locked) return t.locks && t.locks.length ? t.locks.shift() : { id: 'notice-1', status: 'processing' };
    const v = t.firsts.length ? t.firsts.shift() : null;
    return typeof v === 'function' ? v(t) : v;
  });
  b.select = jest.fn(async () => []);
  b.update = jest.fn(async (patch) => { t.calls.push(['update', patch]); return t.updates && t.updates.length ? t.updates.shift() : 1; });
  b.returning = jest.fn(async () => (t.returning.length ? t.returning.shift() : []));
  return b;
}
const claimed = (row = { id: 'notice-1', payer_name: 'Pat Doe', amount_cents: 11700 }) => { tables.inbound_payment_notices.returning.push([{ claim_token: 'tok-1', ...row }]); };
const updatesOf = (table) => (tables[table]?.calls || []).filter(([m]) => m === 'update').map(([, p]) => p);
// Terminal transitions only — the committed match stamp before settlement carries no status.
const closesOf = (table) => updatesOf(table).filter((p) => p.status);
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

describe('stale notices', () => {
  test('a notice older than 48h at first decision (sync outage, expired history cursor) parks stale_notice with candidates — never auto-settled', async () => {
    claimed({ id: 'notice-1', payer_name: 'Pat Doe', amount_cents: 11700, received_at: new Date(Date.now() - 3 * 24 * 3600 * 1000) });
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    expect(await maybeHandleZelleNotice(notice({ received_at: new Date(Date.now() - 3 * 24 * 3600 * 1000) }))).toBe(true);
    expect(recordManualPayment).not.toHaveBeenCalled();
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'stale_notice' });
    expect(JSON.parse(patch.candidates)).toEqual([expect.objectContaining({ invoice_id: 'inv-1', exact_amount: true })]);
  });
});

describe('not ours', () => {
  test('initial-sync history (backfill) ⇒ false before any read — old notices never settle today\'s invoices', async () => {
    expect(await maybeHandleZelleNotice(notice(), { backfill: true })).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('ordinary mail ⇒ false, no reads', async () => {
    expect(await maybeHandleZelleNotice(notice({ subject: 'Hello', body_text: 'Can you come Tuesday?', snippet: 'Can you' }))).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('untrusted sender that still parses ⇒ parked sender_unverified, returns false so the classifier sees it', async () => {
    claimed();
    const out = await maybeHandleZelleNotice(notice({ from_address: 'owner@gmail.com', authentication_results: 'mx.google.com; dkim=pass header.i=@gmail.com' }));
    expect(out).toBe(false);
    expect(insertsOf('inbound_payment_notices')[0]).toMatchObject({ email_id: 'email-1', status: 'processing', payer_name: 'Pat Doe', amount_cents: 11700 });
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'sender_unverified' });
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
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700, { limit: 25 });
    expect(recordManualPayment).toHaveBeenCalledWith('inv-1', {
      method: 'zelle', reference: 'Pat Doe', note: 'Zelle memo: Quarterly Service Pat D', recordedBy: RECORDED_BY, sendReceipt: true, via: 'both', expectedAmountCents: 11700, requireSelfPay: true, automated: true,
    });
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied', match_method: 'amount_name', matched_invoice_id: 'inv-1', matched_customer_id: 'cust-1', applied_by: RECORDED_BY });
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
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied', match_method: 'memo_invoice_number', matched_invoice_id: 'inv-2' });
  });

  test('a record-payment refusal parks apply_failed with the reason — never a silent loss', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('A payment is already in flight (processing)'), { statusCode: 409 }));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'apply_failed', apply_error: 'A payment is already in flight (processing)', matched_customer_id: 'cust-1' });
    expect(JSON.parse(patch.candidates)[0]).toMatchObject({ invoice_id: 'inv-1', exact_amount: true, name_match: true });
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_parked:apply_failed' });
  });
});

describe('settlement without a held transaction (pool floor is 2)', () => {
  const oneExact = () => OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));

  test('no transaction is held across recordManualPayment; the claim is the serialization', async () => {
    claimed();
    oneExact();
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(recordManualPayment).toHaveBeenCalledTimes(1);
  });

  test('a claim no longer processing when the match is stamped (0 rows — the sweep parked it) is not settled', async () => {
    claimed();
    oneExact();
    tables.inbound_payment_notices.updates = [0]; // the stamp's CAS on status = processing
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(closesOf('inbound_payment_notices')).toHaveLength(0);
  });

  test('a Zelle-paid invoice for the matched customer at these cents inside the window (recorded by hand, no notice row) parks possible_duplicate', async () => {
    claimed();
    oneExact();
    tables.invoices = { firsts: [{ id: 'inv-0' }], returning: [], calls: [] }; // the direct-settlement read
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'possible_duplicate' });
    expect(tables.invoices.calls).toContainEqual(['where', { customer_id: 'cust-1', status: 'paid', payment_method: 'zelle' }]);
  });

  test('the duplicate check is re-run right before settling — a copy applied meanwhile parks possible_duplicate', async () => {
    claimed();
    oneExact();
    // Pre-match check: clean. Right before settling: a second copy of the same transfer settled meanwhile.
    tables.inbound_payment_notices.firsts.push(null, { id: 'notice-0' });
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'possible_duplicate' });
  });

  test('a settlement that commits closes the claim with a CAS on processing', async () => {
    claimed();
    oneExact();
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const calls = tables.inbound_payment_notices.calls;
    const closeAt = calls.findIndex(([m, p]) => m === 'update' && p.status === 'auto_applied');
    expect(closeAt).toBeGreaterThan(-1);
    expect(calls[closeAt - 1]).toEqual(['where', { id: 'notice-1', status: 'processing', claim_token: 'tok-1' }]);
  });

  test('the match is COMMITTED on the claim before settling (matched invoice + recorder), so a lost close is recoverable', async () => {
    claimed();
    oneExact();
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const calls = tables.inbound_payment_notices.calls;
    const stampAt = calls.findIndex(([m, p]) => m === 'update' && p.matched_invoice_id === 'inv-1' && !p.status);
    expect(stampAt).toBeGreaterThan(-1);
    expect(calls[stampAt][1]).toMatchObject({ match_method: 'amount_name', matched_customer_id: 'cust-1', applied_by: RECORDED_BY });
    expect(calls[stampAt - 1]).toEqual(['where', { id: 'notice-1', status: 'processing', claim_token: 'tok-1' }]);
    expect(stampAt).toBeLessThan(calls.findIndex(([m, p]) => m === 'update' && p.status === 'auto_applied'));
    // The claim itself minted the token.
    expect(insertsOf('inbound_payment_notices')[0].claim_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a lost close with OUR token still on the row (the sweep parked a slow settlement) is forced to match the ledger', async () => {
    claimed();
    oneExact();
    tables.inbound_payment_notices.updates = [1, 0]; // stamp ok, CAS close lost
    tables.inbound_payment_notices.firsts.push(null, null, { claim_token: 'tok-1', status: 'parked' }); // dup pre, dup pre-settle, re-read
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const calls = tables.inbound_payment_notices.calls;
    const forcedAt = calls.findIndex(([m, p]) => m === 'update' && p.status === 'auto_applied' && p.apply_error === null);
    expect(forcedAt).toBeGreaterThan(-1);
    expect(calls[forcedAt - 1]).toEqual(['where', { id: 'notice-1', claim_token: 'tok-1' }]);
  });

  test('a lost close with a DIFFERENT token (the operator reclaimed the notice) never consumes the new claim — surfaced for review instead', async () => {
    claimed();
    oneExact();
    tables.inbound_payment_notices.updates = [1, 0];
    tables.inbound_payment_notices.firsts.push(null, null, { claim_token: 'tok-operator', status: 'processing' });
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices').filter((p) => p.status === 'auto_applied')).toHaveLength(1); // only the failed CAS attempt
    expect(tables.inbound_payment_notices.calls).not.toContainEqual(['where', { id: 'notice-1', claim_token: 'tok-1' }]); // the forced-close path never ran
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment needs review', expect.stringContaining('reclaimed'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-1:late', bellDefault: true }));
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_applied:WPC-2026-0500' });
  });

  test('the DB refusing the stamp (another notice already holds this invoice — partial UNIQUE index) parks possible_duplicate, nothing settles', async () => {
    claimed();
    oneExact();
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = orig(table);
      if (table === 'inbound_payment_notices') {
        const realUpdate = b.update;
        b.update = jest.fn(async (patch) => { if (patch.matched_invoice_id === 'inv-1' && !patch.status) throw Object.assign(new Error('duplicate key'), { code: '23505' }); return realUpdate(patch); });
      }
      return b;
    });
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'possible_duplicate', matched_invoice_id: null, applied_by: null });
  });
});

describe('post-commit failures', () => {
  test('a non-refusal error after the ledger committed records the notice as applied (receipt unknown), never as failed', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    recordManualPayment.mockRejectedValueOnce(new Error('activity_log insert exploded'));
    tables.invoices = { firsts: [null, { id: 'inv-1', invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'paid', payment_method: 'zelle', payment_recorded_by: RECORDED_BY, payment_reference: 'Pat Doe' }], returning: [], calls: [] }; // [direct-dup read, post-commit re-read]
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied', matched_invoice_id: 'inv-1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment applied', expect.stringContaining('receipt: unknown'), expect.anything());
  });

  test('a non-refusal error with the invoice still open parks apply_failed with an "uncertain" note', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    recordManualPayment.mockRejectedValueOnce(new Error('db down'));
    tables.invoices = { firsts: [null, openRow()], returning: [], calls: [] }; // [direct-dup read, post-commit re-read]
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'apply_failed' });
    expect(patch.apply_error).toMatch(/uncertain.*db down/);
  });
});

describe('park reasons', () => {
  test('no exact-cent invoice ⇒ no_match, with the near-amount candidates for the operator', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [openRow({ id: 'inv-9', invoice_number: 'WPC-2026-0509', total: '120.00' })] : []));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700, { toleranceCents: 500 });
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(JSON.parse(patch.candidates)).toEqual([expect.objectContaining({ invoice_id: 'inv-9', amount_due_cents: 12000, exact_amount: false, name_match: true })]);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a near-amount candidate that fails the live self-pay predicate is dropped from the dropdown (never third-party debt)', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents
      ? [openRow({ id: 'inv-9', invoice_number: 'WPC-2026-0509', total: '120.00' }), openRow({ id: 'inv-8', invoice_number: 'WPC-2026-0508', total: '115.00', customer_id: 'cust-8' })]
      : []));
    OpenBalance.rowIsSelfPayDue.mockImplementation(async (customerId) => customerId !== 'cust-8');
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(JSON.parse(patch.candidates).map((c) => c.invoice_id)).toEqual(['inv-9']);
    expect(OpenBalance.rowIsSelfPayDue).toHaveBeenCalledWith('cust-8', expect.objectContaining({ id: 'inv-8' }));
  });

  test('a memo naming SEVERAL exact-cent invoices parks multiple_matches even when the payer name corroborates exactly one', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [
      openRow(), openRow({ id: 'inv-2', invoice_number: 'WPC-2026-0501', customer_id: 'cust-2', customer_first_name: 'Sam', customer_last_name: 'Roe' }),
    ]));
    expect(await maybeHandleZelleNotice(notice({ body_text: TEXT.replace('Quarterly Service Pat D', 'WPC-2026-0500 WPC-2026-0501'), snippet: 'x' }))).toBe(true);
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'multiple_matches' });
  });

  test('exact amount but the customer name does not corroborate ⇒ name_mismatch', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow({ customer_first_name: 'Sam', customer_last_name: 'Roe' })]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'name_mismatch' });
    expect(JSON.parse(patch.candidates)[0]).toMatchObject({ invoice_id: 'inv-1', exact_amount: true, name_match: false });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a FULL exact-cent candidate page is ambiguous by definition ⇒ multiple_matches, never an auto-apply on a truncated view', async () => {
    claimed();
    const page = Array.from({ length: 25 }, (_, i) => openRow({ id: `inv-${i}`, invoice_number: `WPC-2026-${1000 + i}`, customer_first_name: i === 0 ? 'Pat' : 'Sam', customer_last_name: i === 0 ? 'Doe' : 'Roe' }));
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : page));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700, { limit: 25 });
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'multiple_matches' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('two exact-cent invoices that both corroborate ⇒ multiple_matches', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow(), openRow({ id: 'inv-2', invoice_number: 'WPC-2026-0501' })]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'multiple_matches' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('same payer + amount already applied within the window ⇒ possible_duplicate, even with a clean single match', async () => {
    claimed();
    tables.inbound_payment_notices.firsts.push({ id: 'notice-0' }); // the duplicate-guard read
    const windowClause = () => tables.inbound_payment_notices.calls.find(([m, col, op]) => m === 'where' && op === '>' && col === 'applied_at');
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(windowClause()).toBeTruthy(); // window keyed by settlement time, not email receipt
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'possible_duplicate' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a row the live payer re-resolution drops never auto-applies', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    OpenBalance.rowIsSelfPayDue.mockResolvedValueOnce(false);
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('trusted sender whose template did not parse ⇒ parse_failed (amount unknown), handled', async () => {
    claimed({ id: 'notice-1', payer_name: null, amount_cents: null });
    expect(await maybeHandleZelleNotice(notice({ body_text: 'Someone sent you money with Zelle. Sign in to see details.', snippet: 'x' }))).toBe(true);
    expect(insertsOf('inbound_payment_notices')[0]).toMatchObject({ amount_cents: null, payer_name: null, status: 'processing' });
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'parse_failed' });
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).not.toHaveBeenCalled();
  });
});

describe('owner surfacing under the bell policy', () => {
  test('a parked notice defaults the bell ON (bellDefault — owner override still wins); an applied FYI does not', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async () => []);
    expect(await maybeHandleZelleNotice(notice())).toBe(true); // no_match → parked
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment needs review', expect.any(String), expect.objectContaining({ bellDefault: true }));
    jest.clearAllMocks();
    tables.inbound_payment_notices.returning = []; tables.inbound_payment_notices.calls = [];
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const applied = NotificationService.notifyAdmin.mock.calls.find(([, title]) => title === 'Zelle payment applied');
    expect(applied).toBeTruthy();
    expect(applied[3].bellDefault).toBeUndefined();
  });
});

describe('stale claim recovery', () => {
  test('a processing row older than the window is parked apply_failed for the operator, stamped and surfaced; the sweep runs on every notice', async () => {
    tables.inbound_payment_notices.selects = [[{ id: 'notice-old', email_id: 'email-old', payer_name: 'Old Payer', amount_cents: 5000, claim_token: 'tok-old' }]];
    // builder.select is a plain mock — feed the stale row through it
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => { const b = orig(table); if (table === 'inbound_payment_notices') { const q = tables[table].selects; b.select = jest.fn(async () => (q.length ? q.shift() : [])); } return b; });
    expect(await recoverStaleClaims()).toBe(1);
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'apply_failed' });
    expect(patch.apply_error).toMatch(/interrupted/);
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_parked:apply_failed' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment needs review', expect.stringContaining('interrupted'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-old' }));
    expect(patch).toMatchObject({ matched_invoice_id: null, applied_by: null }); // frees the one-notice-per-invoice index
    // The CAS re-checks status + age so a row another pod just finished is left alone.
    expect(tables.inbound_payment_notices.calls).toContainEqual(['where', { id: 'notice-old', status: 'processing', claim_token: 'tok-old' }]);
  });

  test('a stale claim whose stamped invoice is paid by Zelle under the stamped recorder is CLOSED to match the ledger, never parked', async () => {
    const stale = { id: 'notice-old', email_id: 'email-old', payer_name: 'Old Payer', amount_cents: 5000, matched_invoice_id: 'inv-7', applied_by: RECORDED_BY, claim_token: 'tok-old' };
    tables.inbound_payment_notices.selects = [[stale]];
    tables.invoices = { firsts: [{ id: 'inv-7', invoice_number: 'WPC-2026-0507', customer_id: 'cust-7', status: 'paid', payment_method: 'zelle', payment_recorded_by: RECORDED_BY, payment_reference: 'Old Payer' }], returning: [], calls: [] };
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => { const b = orig(table); if (table === 'inbound_payment_notices') { const q = tables[table].selects; b.select = jest.fn(async () => (q.length ? q.shift() : [])); } return b; });
    expect(await recoverStaleClaims()).toBe(1);
    expect(closesOf('inbound_payment_notices')).toEqual([expect.objectContaining({ status: 'auto_applied', park_reason: null, apply_error: null, matched_customer_id: 'cust-7' })]);
    expect(tables.inbound_payment_notices.calls).toContainEqual(['where', { id: 'notice-old', status: 'processing', claim_token: 'tok-old' }]);
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_applied:WPC-2026-0507' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', 'Zelle payment applied', expect.stringContaining('WPC-2026-0507'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-old' }));
  });

  test('a stamped invoice settled by someone ELSE (or still open) is not ours — the claim parks apply_failed as before', async () => {
    const stale = { id: 'notice-old', email_id: 'email-old', payer_name: 'Old Payer', amount_cents: 5000, matched_invoice_id: 'inv-7', applied_by: RECORDED_BY };
    tables.inbound_payment_notices.selects = [[stale]];
    tables.invoices = { firsts: [{ id: 'inv-7', status: 'paid', payment_method: 'zelle', payment_recorded_by: 'Adam', payment_reference: 'Old Payer' }], returning: [], calls: [] };
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => { const b = orig(table); if (table === 'inbound_payment_notices') { const q = tables[table].selects; b.select = jest.fn(async () => (q.length ? q.shift() : [])); } return b; });
    expect(await recoverStaleClaims()).toBe(1);
    expect(closesOf('inbound_payment_notices')).toEqual([expect.objectContaining({ status: 'parked', park_reason: 'apply_failed' })]);
  });

  test('the sweep re-offers hook-marked emails (oldest first, small batch, no age cap) and clears a mark only while it is still the mark', async () => {
    const marked = { ...notice({ id: 'email-marked' }), auto_action: ZELLE_RETRY_MARK };
    tables.emails.selects = [[marked]];
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => { const b = orig(table); if (table === 'emails') { const q = tables[table].selects; b.select = jest.fn(async () => (q.length ? q.shift() : [])); } return b; });
    claimed({ id: 'notice-m', payer_name: 'Pat Doe', amount_cents: 11700 });
    expect(await reofferMarkedEmails()).toBe(1);
    const emailCalls = tables.emails.calls;
    expect(emailCalls).toContainEqual(['where', { auto_action: ZELLE_RETRY_MARK }]);
    expect(emailCalls.find(([m, col, op]) => m === 'where' && col === 'received_at' && op === '>')).toBeUndefined(); // a mark stays actionable until handled
    expect(emailCalls).toContainEqual(['orderBy', 'received_at', 'asc']);
    expect(emailCalls).toContainEqual(['limit', 25]);
    // The full decision ran: a claim was inserted for the marked email, then parked (no open invoice) …
    expect(insertsOf('inbound_payment_notices')[0]).toMatchObject({ email_id: 'email-marked', status: 'processing' });
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    // … and the mark is cleared conditionally (never a concurrent owner's stamp).
    expect(emailCalls).toContainEqual(['where', { id: 'email-marked', auto_action: ZELLE_RETRY_MARK }]);
  });

  test('the sync-cadence sweep is gate-aware: off ⇒ no reads', async () => {
    process.env.GATE_ZELLE_NOTICE_RECONCILE = 'false';
    expect(await sweepStaleClaims()).toBe(0);
    expect(db).not.toHaveBeenCalled();
  });

  test('nothing stale ⇒ no writes', async () => {
    expect(await recoverStaleClaims()).toBe(0);
    expect(updatesOf('inbound_payment_notices')).toHaveLength(0);
  });
});

describe('sync wiring', () => {
  test('upsertEmail runs the reconciler before classification and skips the classifier when it owns the email', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'email', 'email-sync.js'), 'utf8');
    const hook = src.indexOf("require('../zelle-notice-reconciler')");
    const classify = src.indexOf("require('./email-classifier')");
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(classify);
    expect(src).toMatch(/zelleHandled = await offerZelleNotice\(email, \{ backfill \}\)/);
    expect(src).toMatch(/return await maybeHandleZelleNotice\(email, \{ backfill \}\)/);
    expect(src).toMatch(/if \(!proofHandled && !approvalControl && !zelleHandled && /);
    // A hook throw marks the row for a targeted re-offer; the existing-email
    // branch re-offers ONLY marked rows (never a gate-flip replay of history).
    expect(src).toMatch(/whereNull\('auto_action'\)\.update\(\{ auto_action: ZELLE_RETRY_MARK/);
    // A failed mark write PROPAGATES the original error (the message counts as failed; classification never runs).
    expect(src).toMatch(/catch \(markErr\) \{[\s\S]{0,300}throw err;/);
    // A MARKED email is owned: classification (which also writes auto_action) must not erase the retry record.
    expect(src).toMatch(/if \(!marked\) \{[\s\S]{0,200}throw err;\s*\}\s*return true;/);
    // A 0-row mark (auto_action already set by something other than the reconciler) is NOT a durable record.
    expect(src).toMatch(/startsWith\('zelle_notice'\)/);
    // A lost retry record withholds the INCREMENTAL cursor too (fullSync already withholds on any failed message).
    expect(src).toMatch(/if \(err\.zelleRetryLost\) cursorWithheld = true;/);
    expect(src).toMatch(/last_history_id: cursorWithheld \? state\.last_history_id : latestHistoryId/);
    expect(src).toMatch(/if \(existing\.auto_action === ZELLE_RETRY_MARK \|\| \(existing\.auto_action == null && existing\.classification == null\)\) \{\s*await offerZelleNotice\(/);
    expect(src).toMatch(/\(proofHandled \|\| approvalControl \|\| zelleHandled\) && await bellClaimColumnExists\(\)/);
    // The stale-claim sweep runs on every sync beside the bell sweep.
    expect(src).toMatch(/sweepUnclaimedCustomerEmailBells\(\)[\s\S]{0,600}require\('\.\.\/zelle-notice-reconciler'\)\.sweepStaleClaims\(\)/);
  });
});
