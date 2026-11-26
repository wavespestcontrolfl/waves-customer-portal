/**
 * services/zelle-notice-reconciler.js — the shared decision table and money
 * path (the Plaid bank feed drives it in production; zelle-bank-reconciler
 * .test.js pins that entry). The email-notice intake was removed 2026-11-26,
 * so these tests drive the shared decision (`_private.settleOrPark`) through a
 * small test-only shim that claims a notice row first, as the intake did.
 * Pins, with a per-table db mock:
 *   - exact single match by memo invoice number / by corroborating name ⇒
 *     recordManualPayment(zelle, receipt email + SMS) + `auto_applied` + stamps;
 *   - every park reason (no_match, name_mismatch, multiple_matches,
 *     possible_duplicate, apply_failed, stale_notice) with the candidate list;
 *   - payer re-resolution drops (rowIsSelfPayDue=false) never auto-apply;
 *   - stale-claim recovery.
 */
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
  recordManualPayment: jest.fn(async (id) => ({ invoice: { id, invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'paid' }, receipt: { queued: true } })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => undefined) }));

const db = require('../models/db');
const OpenBalance = require('../services/open-balance');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const NotificationService = require('../services/notification-service');
const logger = require('../services/logger');
const { recoverStaleClaims, sweepStaleClaims, retireMarkedEmails, RECORDED_BY, STALE_NOTICE_MS, _private: { settleOrPark } } = require('../services/zelle-notice-reconciler');

// Received one hour ago on the real clock: the reconciler parks anything
// older than STALE_NOTICE_MS (48h) at first decision, so an absolute date
// here turned every settlement test into a stale_notice park two days later.
const RECEIVED_AT = new Date(Date.now() - 60 * 60 * 1000);

function notice(over = {}) {
  return { id: 'email-1', payer: 'Pat Doe', amountCents: 11700, memo: 'Quarterly Service Pat D', received_at: RECEIVED_AT, ...over };
}
// Test-only stand-in for the removed email intake: claim the notice row (the
// mock's `returning` queue is the claim), then run the shared decision.
async function maybeHandleZelleNotice(email) {
  const parsed = { payerName: email.payer, amountCents: email.amountCents, memo: email.memo };
  const [row] = await db('inbound_payment_notices')
    .insert({ email_id: email.id, source: 'capitalone_zelle', payer_name: parsed.payerName, amount_cents: parsed.amountCents, memo: parsed.memo, received_at: email.received_at, status: 'processing', claim_token: require('crypto').randomUUID() })
    .onConflict('email_id').ignore().returning('*');
  if (!row) return true; // another pass owns this notice
  const receivedAt = new Date(row.received_at || email.received_at || Date.now()).getTime();
  const ageMs = Date.now() - receivedAt;
  return settleOrPark(row, email, parsed, { cutoffMs: receivedAt, stale: Number.isFinite(receivedAt) && ageMs > STALE_NOTICE_MS, ageMs, ref: email.id });
}
const openRow = (over = {}) => ({
  id: 'inv-1', invoice_number: 'WPC-2026-0500', status: 'sent', customer_id: 'cust-1', total: '117.00', credit_applied: 0,
  service_date: '2026-09-01', created_at: new Date('2026-09-01T12:00:00Z'), customer_first_name: 'Pat', customer_last_name: 'Doe', ...over,
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

// The fixtures are dated 2026-09-02 and the reconciler parks a notice older
// than 48h at first decision — on the WALL clock, so the whole auto-apply
// battery drifted into stale_notice at 17:00Z on 2026-09-04. Every decision
// runs on this fixture clock; the stale test still builds its notice relative
// to it.
const FIXTURE_NOW = new Date('2026-09-02T18:00:00Z').getTime();
afterAll(() => { if (typeof Date.now.mockRestore === 'function') Date.now.mockRestore(); });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(FIXTURE_NOW);
  tables = { inbound_payment_notices: { firsts: [], returning: [], calls: [] }, emails: { firsts: [], returning: [], calls: [] } };
  db.mockImplementation((table) => builder(table));
  OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async () => []);
  OpenBalance.rowIsSelfPayDue.mockImplementation(async () => true);
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

describe('claims', () => {
  test('a lost claim (another pass owns the notice) decides nothing', async () => {
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
      method: 'zelle', reference: 'Pat Doe', note: 'Zelle memo: Quarterly Service Pat D', recordedBy: RECORDED_BY, sendReceipt: true, via: 'both', expectedAmountCents: 11700, requireSelfPay: true, automated: true, settlementFence: expect.any(Function),
    });
    // The fence checks OUR claim (id + processing + token) on the payment connection.
    const fenceTrx = jest.fn(() => ({ where: jest.fn((w) => { fenceTrx.where = w; return { forUpdate: jest.fn(() => { fenceTrx.locked = true; return { first: jest.fn(async () => ({ id: 'notice-1' })) }; }) }; }) }));
    expect(await recordManualPayment.mock.calls[0][1].settlementFence(fenceTrx)).toBe(true);
    expect(fenceTrx).toHaveBeenCalledWith('inbound_payment_notices');
    expect(fenceTrx.where).toEqual({ id: 'notice-1', status: 'processing', claim_token: 'tok-1' });
    expect(fenceTrx.locked).toBe(true); // FOR UPDATE — the claim row stays locked through the paid flip
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied', match_method: 'amount_name', matched_invoice_id: 'inv-1', matched_customer_id: 'cust-1', applied_by: RECORDED_BY });
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_applied:WPC-2026-0500', classification: 'other' });
    // Good news is FYI (docs/admin-notifications.md): no alert row; the log keeps the receipt legs.
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('receipt: queued on the receipt queue'));
  });

  test('the memo invoice number picks one of several exact-cent invoices', async () => {
    claimed();
    const memoNotice = notice({ memo: 'wpc-2026-0501 lawn' });
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

  test('a park whose token-fenced CAS moves nothing (claim swept or reclaimed) stamps nothing and raises no bell', async () => {
    claimed();
    oneExact();
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('A payment is already in flight'), { statusCode: 409 }));
    tables.inbound_payment_notices.updates = [1, 0]; // stamp ok, the park CAS lost
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(updatesOf('emails')).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a lost close with a DIFFERENT token (the operator reclaimed the notice) never consumes the new claim — surfaced for review instead', async () => {
    claimed();
    oneExact();
    tables.inbound_payment_notices.updates = [1, 0];
    tables.inbound_payment_notices.firsts.push(null, null, { claim_token: 'tok-operator', status: 'processing' });
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices').filter((p) => p.status === 'auto_applied')).toHaveLength(1); // only the failed CAS attempt
    expect(tables.inbound_payment_notices.calls).not.toContainEqual(['where', { id: 'notice-1', claim_token: 'tok-1' }]); // the forced-close path never ran
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — check Pat Doe's $117.00 Zelle", expect.stringContaining('after someone reopened it'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-1:late', bellDefault: true }));
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
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — check the receipt for Pat Doe's $117.00 Zelle", expect.stringContaining('could not confirm the receipt went out'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-1:receipt', bellDefault: true }));
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
    expect(await maybeHandleZelleNotice(notice({ memo: 'WPC-2026-0500 WPC-2026-0501' }))).toBe(true);
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

  test('an exact-amount invoice CREATED AFTER the notice is never auto-matched (the transfer predates that debt) ⇒ no_match, still listed as a candidate for the operator', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [
      openRow({ id: 'inv-later', invoice_number: 'WPC-2026-0510', created_at: new Date(RECEIVED_AT.getTime() + 30 * 60 * 1000) }), // 30 min after the notice
    ]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    const patch = closesOf('inbound_payment_notices')[0];
    expect(patch).toMatchObject({ status: 'parked', park_reason: 'no_match' });
    expect(JSON.parse(patch.candidates)[0]).toMatchObject({ invoice_id: 'inv-later', exact_amount: true, name_match: true });
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(updatesOf('inbound_payment_notices').some((u) => u.matched_invoice_id)).toBe(false);
  });

  test('an exact-amount invoice with no created_at is never auto-matched (fail closed)', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow({ created_at: null })]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'parked', park_reason: 'no_match' });
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

});

describe('owner surfacing under the bell policy', () => {
  test('a parked notice defaults the bell ON (bellDefault — owner override still wins); an applied notice raises no alert (FYI)', async () => {
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async () => []);
    expect(await maybeHandleZelleNotice(notice())).toBe(true); // no_match → parked
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — review Pat Doe's $117.00 Zelle", 'No open invoice is $117.00, so the portal did not record it.', expect.objectContaining({ bellDefault: true }));
    jest.clearAllMocks();
    tables.inbound_payment_notices.returning = []; tables.inbound_payment_notices.calls = [];
    claimed();
    OpenBalance.openSelfPayInvoicesByAmountDue.mockImplementation(async (cents, opts = {}) => (opts.toleranceCents ? [] : [openRow()]));
    expect(await maybeHandleZelleNotice(notice())).toBe(true);
    expect(closesOf('inbound_payment_notices')[0]).toMatchObject({ status: 'auto_applied' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — review Old Payer's $50.00 Zelle", expect.stringContaining('stopped before it finished recording'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-old' }));
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
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', "Billing — check the receipt for Old Payer's $50.00 Zelle", expect.stringContaining('WPC-2026-0507'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-old:receipt' }));
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

  test('the sync-cadence sweep runs stale-claim RECOVERY (a kill never strands a processing claim)', async () => {
    expect(await sweepStaleClaims()).toBe(0);
    expect(tables.inbound_payment_notices.calls).toContainEqual(['where', { status: 'processing' }]); // recovery read
  });

  // Legacy rows from the removed email path; prod had 0 on 2026-11-26.
  const feedMarkedEmails = (rows) => {
    tables.emails.selects = [rows];
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => { const b = orig(table); if (table === 'emails') { const q = tables[table].selects; b.select = jest.fn(async () => (q.length ? q.shift() : [])); } return b; });
  };

  test('a retry-marked email with no notice row is parked for manual review, alerted, and its mark is overwritten', async () => {
    feedMarkedEmails([{ id: 'email-marked', received_at: RECEIVED_AT }]);
    claimed({ id: 'notice-m', payer_name: null, amount_cents: null });
    expect(await retireMarkedEmails()).toBe(1);
    expect(tables.emails.calls).toContainEqual(['where', { auto_action: 'zelle_notice_retry' }]);
    // Inserted already parked with the bank-check warning: no processing step to crash between.
    expect(insertsOf('inbound_payment_notices')[0]).toMatchObject({ email_id: 'email-marked', source: 'capitalone_zelle', status: 'parked', park_reason: 'parse_failed', apply_error: expect.stringContaining('never verified') });
    expect(updatesOf('inbound_payment_notices')).toHaveLength(0);
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: 'zelle_notice_parked:parse_failed' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('payment', expect.any(String), expect.stringContaining('left unprocessed'), expect.objectContaining({ dedupeKey: 'zelle-notice:notice-m' }));
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('retirement is idempotent: a mark whose notice row already exists is only cleared, never alerted twice', async () => {
    feedMarkedEmails([{ id: 'email-marked', received_at: RECEIVED_AT }]); // returning [] ⇒ the insert hit the email_id unique row
    expect(await retireMarkedEmails()).toBe(1);
    expect(updatesOf('inbound_payment_notices')).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(tables.emails.calls).toContainEqual(['where', { id: 'email-marked', auto_action: 'zelle_notice_retry' }]);
    expect(updatesOf('emails')[0]).toMatchObject({ auto_action: null });
  });

  test('no marked emails ⇒ nothing written, and the sync sweep runs the retirement', async () => {
    expect(await retireMarkedEmails()).toBe(0);
    expect(insertsOf('inbound_payment_notices')).toHaveLength(0);
    feedMarkedEmails([{ id: 'email-marked', received_at: RECEIVED_AT }]);
    claimed({ id: 'notice-m', payer_name: null, amount_cents: null });
    expect(await sweepStaleClaims()).toBe(1);
  });

  test('nothing stale ⇒ no writes', async () => {
    expect(await recoverStaleClaims()).toBe(0);
    expect(updatesOf('inbound_payment_notices')).toHaveLength(0);
  });
});

describe('sync wiring', () => {
  test('the email sync runs the stale-claim sweep on every sync beside the bell sweep', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'email', 'email-sync.js'), 'utf8');
    expect(src).toMatch(/sweepUnclaimedCustomerEmailBells\(\)[\s\S]{0,600}require\('\.\.\/zelle-notice-reconciler'\)\.sweepStaleClaims\(\)/);
  });
});
