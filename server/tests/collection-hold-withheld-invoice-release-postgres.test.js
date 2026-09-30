/**
 * Owner ruling 2026-09-30: releasing a collections DISPUTE hold sends every
 * invoice whose pay link the hold withheld, at once, through the normal
 * scheduled-send queue.
 *
 * Real Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's
 * REPAIR_TEST_DATABASE_URL — a migrated nonproduction database; skipped
 * without either). Synthetic names only.
 */
const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;

jest.mock('../models/db', () => require('knex')({
  client: 'pg', connection: process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 4 },
}));
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));

const { randomUUID } = require('crypto');

const run = connection ? describe : describe.skip;
const MARKER = 'dispute_hold_pay_link_withheld';
const DISPUTE_REASON = 'dispute on call: synthetic billing question';

run('collections dispute hold: withheld-invoice marker and release send (postgres)', () => {
  let db;
  let Hold;
  let Admin;
  let logger;
  const customers = [];

  async function newCustomer() {
    const [row] = await db('customers').insert({ first_name: 'Synthetic', last_name: 'Holdtest', phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` }).returning('id');
    customers.push(row.id);
    return row.id;
  }

  async function newInvoice(customerId, patch = {}) {
    const [row] = await db('invoices').insert({
      token: randomUUID().replace(/-/g, '').slice(0, 24), invoice_number: `HT-${randomUUID().slice(0, 8)}`,
      customer_id: customerId, status: 'draft', total: 100, subtotal: 100, ...patch,
    }).returning('id');
    return row.id;
  }

  const invoice = (id) => db('invoices').where({ id }).first();
  const placeHold = async (customerId, reason = DISPUTE_REASON) => (await db('collections_flags')
    .insert({ customer_id: customerId, flag: 'collection_hold', reason, created_by: 'test' }).returning('id'))[0].id;
  const endHold = (id) => db('collections_flags').where({ id }).update({ released_at: db.fn.now() });

  beforeAll(async () => {
    db = require('../models/db');
    Hold = require('../services/collections/collection-hold');
    Admin = require('../services/collections/collection-hold-admin');
    logger = require('../services/logger');
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => {
    if (customers.length) {
      await db('dispatch_alerts').whereRaw("payload->>'customerId' = ANY(?)", [customers.map(String)]).del();
      await db('sms_log').whereIn('customer_id', customers).del();
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('invoices').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  describe('marker', () => {
    test('stamps a plain draft; leaves paid, sent, payer-stamped and other-stamped invoices alone', async () => {
      const c = await newCustomer();
      const draft = await newInvoice(c);
      const paid = await newInvoice(c, { status: 'paid', paid_at: db.fn.now() });
      const sent = await newInvoice(c, { status: 'sent', sent_at: db.fn.now() });
      const payerStamped = await newInvoice(c, { scheduled_send_error: 'payer_billed:7' });
      const renewal = await newInvoice(c, { scheduled_send_error: 'renewal_send_withheld: test' });
      expect(await Hold.markInvoiceWithheldByHold(draft)).toBe(true);
      for (const id of [paid, sent, payerStamped, renewal]) expect(await Hold.markInvoiceWithheldByHold(id)).toBe(false);
      expect((await invoice(draft)).scheduled_send_error).toBe(MARKER);
      expect((await invoice(payerStamped)).scheduled_send_error).toBe('payer_billed:7');
      expect((await invoice(renewal)).scheduled_send_error).toBe('renewal_send_withheld: test');
      expect((await invoice(paid)).scheduled_send_error).toBeNull();
    });

    test('inside a caller transaction a failing write cannot abort that transaction (savepoint)', async () => {
      const c = await newCustomer();
      const draft = await newInvoice(c);
      await db.transaction(async (trx) => {
        await expect(Hold.markInvoiceWithheldByHold('not-a-uuid', trx)).rejects.toThrow();
        // the outer transaction is still usable
        expect(await Hold.markInvoiceWithheldByHold(draft, trx)).toBe(true);
      });
      expect((await invoice(draft)).scheduled_send_error).toBe(MARKER);
    });
  });

  describe('release sends the withheld invoices', () => {
    test('queues exactly the marked, unpaid, self-pay drafts of that customer; skips and un-marks the rest', async () => {
      const c = await newCustomer();
      const other = await newCustomer();
      const holdId = await placeHold(c);
      const marked = await newInvoice(c, { scheduled_send_error: MARKER });
      const unmarked = await newInvoice(c);
      const paid = await newInvoice(c, { status: 'paid', paid_at: db.fn.now(), scheduled_send_error: MARKER });
      const voided = await newInvoice(c, { status: 'void', scheduled_send_error: MARKER });
      const refunded = await newInvoice(c, { status: 'refunded', scheduled_send_error: MARKER });
      const alreadySent = await newInvoice(c, { status: 'sent', sent_at: db.fn.now(), scheduled_send_error: MARKER });
      // a draft another path already delivered (sent_at set) is never queued a second time
      const deliveredElsewhere = await newInvoice(c, { scheduled_send_error: MARKER, sent_at: db.fn.now() });
      const otherCustomers = await newInvoice(other, { scheduled_send_error: MARKER });

      const res = await Admin.releaseCollectionHold(c);
      expect(res).toMatchObject({ ok: true, released: 1, withheldSend: { ok: true, queued: [marked] } });
      expect((await db('collections_flags').where({ id: holdId }).first()).released_at).not.toBeNull();

      expect(await invoice(marked)).toMatchObject({ status: 'scheduled', scheduled_send_error: null, scheduled_send_attempts: 0 });
      expect((await invoice(marked)).scheduled_send_at).not.toBeNull();
      // never queued
      expect(await invoice(unmarked)).toMatchObject({ status: 'draft', scheduled_send_at: null });
      for (const [id, status] of [[paid, 'paid'], [voided, 'void'], [refunded, 'refunded'], [alreadySent, 'sent'], [deliveredElsewhere, 'draft']]) {
        const row = await invoice(id);
        expect(row.status).toBe(status);
        expect(row.scheduled_send_at).toBeNull();
        expect(row.scheduled_send_error).toBeNull(); // marker cleared, nothing sent
      }
      // another customer's marked invoice is untouched
      expect(await invoice(otherCustomers)).toMatchObject({ status: 'draft', scheduled_send_error: MARKER });
    });

    test('a second release call queues nothing (the claim and the clear are one statement)', async () => {
      const c = await newCustomer();
      const marked = await newInvoice(c, { scheduled_send_error: MARKER });
      const first = await Hold.releaseWithheldInvoices({ customerId: c });
      const second = await Hold.releaseWithheldInvoices({ customerId: c });
      const both = await Promise.all([Hold.releaseWithheldInvoices({ customerId: c }), Hold.releaseWithheldInvoices({ invoiceId: marked })]);
      expect(first.queued).toEqual([marked]);
      expect(second.queued).toEqual([]);
      expect(both.flatMap((r) => r.queued)).toEqual([]);
    });

    test('another active dispute hold blocks the send and keeps the marker for the next release', async () => {
      const c = await newCustomer();
      const first = await placeHold(c);
      const marked = await newInvoice(c, { scheduled_send_error: MARKER });
      await endHold(first);
      const second = await placeHold(c, 'dispute raised on call'); // a new dispute lands after the release
      expect(await Admin.sendWithheldInvoicesAfterRelease(c)).toEqual({ ok: true, queued: [] });
      expect(await invoice(marked)).toMatchObject({ status: 'draft', scheduled_send_at: null, scheduled_send_error: MARKER });
      await endHold(second);
      expect(await Admin.sendWithheldInvoicesAfterRelease(c)).toEqual({ ok: true, queued: [marked] });
      expect((await invoice(marked)).status).toBe('scheduled');
    });

    test('a non-dispute (wrong-number fallback) hold does not block the send', async () => {
      const c = await newCustomer();
      await placeHold(c, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
      const marked = await newInvoice(c, { scheduled_send_error: MARKER });
      expect((await Hold.releaseWithheldInvoices({ customerId: c })).queued).toEqual([marked]);
    });

    test('a send failure keeps the release, logs it and raises an office alert', async () => {
      const c = await newCustomer();
      const holdId = await placeHold(c);
      const marked = await newInvoice(c, { scheduled_send_error: MARKER });
      await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_queue() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
      // Scoped to this test's invoice: CI shares the database across workers.
      await db.raw(`CREATE TRIGGER b10_fail_queue_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.id = '${marked}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_queue()`);
      try {
        const res = await Admin.releaseCollectionHold(c);
        expect(res).toMatchObject({ ok: true, released: 1, withheldSend: { ok: false, queued: [] } });
      } finally {
        await db.raw('DROP TRIGGER IF EXISTS b10_fail_queue_trg ON invoices');
        await db.raw('DROP FUNCTION IF EXISTS b10_fail_queue()');
      }
      expect((await db('collections_flags').where({ id: holdId }).first()).released_at).not.toBeNull();
      expect(await invoice(marked)).toMatchObject({ status: 'draft', scheduled_send_error: MARKER });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('release committed'));
      const alerts = await db('dispatch_alerts').where({ type: 'collection_hold_release_send_failed' }).whereRaw("payload->>'customerId' = ?", [String(c)]);
      expect(alerts).toHaveLength(1);
      // the office can retry: with the fault gone the next send goes through
      expect((await Admin.sendWithheldInvoicesAfterRelease(c)).queued).toEqual([marked]);
    });
  });

  describe('deferred completion replay: hold -> strip -> provider failure -> release -> retry', () => {
    const { persistStrippedPayLink } = require('../services/dispatch-completion-deferred');
    const PAY_URL = 'https://pay.example.test/i/synthetic-token';

    async function queueRow(customerId, invoiceId) {
      const [row] = await db('sms_log').insert({
        customer_id: customerId, direction: 'outbound', from_phone: '+15550000001', to_phone: '+15550000002', status: 'sending',
        message_body: `Your service is complete.\nReport: https://portal.example.test/r/abc\nInvoice: ${PAY_URL}`,
        metadata: {
          entry_point: 'dispatch_completion_deferred', invoice_id: invoiceId, pay_url: PAY_URL, customer_id: customerId,
          mark_invoice_delivery: true, scheduled_sms_attempts: 1,
        },
      }).returning('*');
      return row.id;
    }
    const smsRow = (id) => db('sms_log').where({ id }).first();
    async function recheckFor(id) {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const row = await smsRow(id);
      return recheckDeferredReplay('dispatch_completion_deferred', { ...row.metadata, customer_id: row.customer_id });
    }
    // The executor's provider failure path hands the claimed row back to the queue; the next
    // attempt claims it again.
    const providerFailsRetryably = (id) => db('sms_log').where({ id }).update({ status: 'scheduled' });
    const reclaim = (id) => db('sms_log').where({ id }).update({ status: 'sending' });

    test('the strip stamps the invoice atomically; the release sends it once; the retry stays report-only and sends nothing more', async () => {
      const c = await newCustomer();
      const holdId = await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);

      // attempt 1: the hold is active -> strip
      const first = await recheckFor(id);
      expect(first).toMatchObject({ eligible: true, stripPayLink: true, reason: 'collections-dispute-hold' });
      const { stripPayLinkLineFromBody } = require('../services/dispatch-completion-deferred');
      const changed = await persistStrippedPayLink({
        msgId: id, strippedBody: stripPayLinkLineFromBody((await smsRow(id)).message_body, PAY_URL),
        reason: first.reason, invoiceId: inv,
      });
      expect(changed).toBe(1);
      expect((await invoice(inv)).scheduled_send_error).toBe(MARKER);
      let row = await smsRow(id);
      expect(row.message_body).not.toContain('pay.example.test');
      expect(row.metadata.mark_invoice_delivery).toBeUndefined();
      expect(row.metadata.pay_link_stripped_reason).toBe('collections-dispute-hold');

      // the provider fails retryably; the office releases the hold before attempt 2
      await providerFailsRetryably(id);
      const res = await Admin.releaseCollectionHold(c);
      expect(res.withheldSend.queued).toEqual([inv]);
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      const queuedAt = (await invoice(inv)).scheduled_send_at;
      expect(queuedAt).not.toBeNull();

      // attempt 2: no hold. The row is still report-only and must not queue the invoice again.
      await reclaim(id);
      const second = await recheckFor(id);
      expect(second.stripPayLink).toBeUndefined();
      expect(second.eligible).not.toBe(false);
      const after = await invoice(inv);
      expect(after.status).toBe('scheduled');
      expect(after.scheduled_send_at.getTime()).toBe(queuedAt.getTime());
      row = await smsRow(id);
      expect(row.message_body).not.toContain('pay.example.test');
      expect(row.metadata.mark_invoice_delivery).toBeUndefined();
      expect((await Hold.releaseWithheldInvoices({ customerId: c })).queued).toEqual([]);
      expect(holdId).toBeTruthy();
    });

    test('a hold that ended by another path is picked up by the retry, and a later release then finds nothing', async () => {
      const c = await newCustomer();
      const holdId = await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      const first = await recheckFor(id);
      await persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: first.reason, invoiceId: inv });
      await providerFailsRetryably(id);
      await endHold(holdId); // ops script / direct flag release: no office-release send
      expect((await invoice(inv)).status).toBe('draft');

      await reclaim(id);
      const second = await recheckFor(id);
      expect(second.eligible).not.toBe(false);
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      expect((await Hold.releaseWithheldInvoices({ customerId: c })).queued).toEqual([]);
    });

    test('a retry while the hold still stands leaves the invoice draft and marked', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      const first = await recheckFor(id);
      await persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: first.reason, invoiceId: inv });
      await providerFailsRetryably(id);
      await reclaim(id);
      expect(await recheckFor(id)).toMatchObject({ stripPayLink: true });
      expect(await invoice(inv)).toMatchObject({ status: 'draft', scheduled_send_error: MARKER });
    });

    test('a non-hold strip (invoice already terminal) does not mark anything', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      await persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: 'invoice-terminal:paid', invoiceId: inv });
      expect((await invoice(inv)).scheduled_send_error).toBeNull();
    });

    test('a lost claim changes nothing on the invoice either', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      await db('sms_log').where({ id }).update({ status: 'sent' });
      expect(await persistStrippedPayLink({ msgId: id, strippedBody: 'x', reason: 'collections-dispute-hold', invoiceId: inv })).toBe(0);
      expect((await invoice(inv)).scheduled_send_error).toBeNull();
    });

    test('the deferred decline notice, suppressed whole under a hold, marks its invoice', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const verdict = await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: inv, customer_id: c });
      expect(verdict).toMatchObject({ eligible: false, reason: 'collections-dispute-hold' });
      expect((await invoice(inv)).scheduled_send_error).toBe(MARKER);
    });
  });
});
