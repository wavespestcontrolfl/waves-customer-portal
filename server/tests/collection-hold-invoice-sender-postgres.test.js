/**
 * Owner ruling 2026-09-30: while a customer has an ACTIVE collections DISPUTE
 * hold no pay link reaches them; when the hold ends, an invoice that was held
 * back is sent through the normal invoice path.
 *
 * The one chokepoint is the scheduled-invoice SENDER
 * (InvoiceService.processScheduledSends): a held invoice stays 'scheduled', is
 * pushed a tick out with no attempt spent, and goes out on the first tick after
 * the hold ends - by ANY release path (the flag row is all the sender reads).
 * Every withhold point QUEUES the invoice onto that sender
 * (queueHeldInvoiceForSender); nothing is stamped or hooked.
 *
 * Real Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's
 * REPAIR_TEST_DATABASE_URL - a migrated nonproduction database; skipped
 * without either). Synthetic names only. Triggers are scoped to the test's own
 * invoice ids because CI shares the database across workers.
 */
const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;

// A knex instance whose tables can be made to fail on demand (the hold-lookup
// failure cases). Queries pass straight through otherwise.
jest.mock('../models/db', () => {
  const k = require('knex')({
    client: 'pg', connection: process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 4 },
  });
  const failing = new Set();
  const wrapped = new Proxy(k, {
    apply(target, thisArg, args) {
      if (failing.has(args[0])) throw new Error(`simulated read failure on ${args[0]}`);
      return target(...args);
    },
    get(target, prop) {
      if (prop === '__failTables') return failing;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return wrapped;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
// The 8AM-8PM ET fence is clock math, not what this suite is about.
jest.mock('../services/messaging/send-window', () => ({
  ...jest.requireActual('../services/messaging/send-window'),
  isWithinSendWindowET: jest.fn(() => true),
}));

const { randomUUID } = require('crypto');

const run = connection ? describe : describe.skip;
const DISPUTE_REASON = 'dispute on call: synthetic billing question';

run('collections dispute hold: the scheduled-invoice sender is the chokepoint (postgres)', () => {
  let db;
  let Hold;
  let Invoices;
  let sendSpy;
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
  // The ops script path (ops/agents/collections-flag.js): releaseFlag directly, no admin route.
  const releaseViaOpsScript = (customerId) => require('../services/collections/outbound-voice/flags').releaseFlag({ customerId, flag: 'collection_hold' });
  const makeDueNow = (id) => db('invoices').where({ id }).update({ scheduled_send_at: new Date(Date.now() - 1000) });
  // Queue, then make it unambiguously due (the DB's now() can sit a sub-millisecond ahead of the sender's JS clock).
  const queueDue = async (id) => { await Hold.queueHeldInvoiceForSender(id); await makeDueNow(id); };
  // The sender walks the whole due queue; this suite only asserts on its own invoices.
  const sentIds = () => sendSpy.mock.calls.map((c) => c[0]);

  beforeAll(async () => {
    db = require('../models/db');
    Hold = require('../services/collections/collection-hold');
    Invoices = require('../services/invoice');
    // The provider handoff is out of scope: finalize the way a real delivery would.
    sendSpy = jest.spyOn(Invoices, 'sendViaSMSAndEmail').mockImplementation(async (invoiceId, opts = {}) => {
      await db('invoices').where({ id: invoiceId }).update({
        status: 'sent', sent_at: db.fn.now(), scheduled_send_at: null, send_claim_token: null, updated_at: db.fn.now(),
      });
      return { ok: true, opts };
    });
  });
  beforeEach(() => { jest.clearAllMocks(); db.__failTables.clear(); });
  afterAll(async () => {
    sendSpy.mockRestore();
    if (customers.length) {
      await db('dispatch_alerts').whereRaw("payload->>'customerId' = ANY(?)", [customers.map(String)]).del();
      await db('sms_log').whereIn('customer_id', customers).del();
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('invoices').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  describe('queueHeldInvoiceForSender', () => {
    test('queues a plain self-pay draft (draft -> scheduled, due now); leaves everything else alone', async () => {
      const c = await newCustomer();
      const draft = await newInvoice(c);
      const paid = await newInvoice(c, { status: 'paid', paid_at: db.fn.now() });
      const sent = await newInvoice(c, { status: 'sent', sent_at: db.fn.now() });
      const deliveredElsewhere = await newInvoice(c, { sms_sent_at: db.fn.now() });
      const payerStamped = await newInvoice(c, { scheduled_send_error: 'payer_billed:7' });
      const renewal = await newInvoice(c, { scheduled_send_error: 'renewal_send_withheld: test' });
      expect(await Hold.queueHeldInvoiceForSender(draft)).toEqual({ queued: true });
      for (const id of [paid, sent, deliveredElsewhere, payerStamped, renewal]) expect(await Hold.queueHeldInvoiceForSender(id)).toEqual({ queued: false });
      expect(await invoice(draft)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, scheduled_send_error: null });
      expect((await invoice(draft)).scheduled_send_at).not.toBeNull();
      expect((await invoice(paid)).status).toBe('paid');
      expect((await invoice(sent)).status).toBe('sent');
      expect(await invoice(deliveredElsewhere)).toMatchObject({ status: 'draft', scheduled_send_at: null });
      expect((await invoice(payerStamped)).scheduled_send_error).toBe('payer_billed:7');
      expect((await invoice(renewal)).scheduled_send_error).toBe('renewal_send_withheld: test');
    });

    test('idempotent and race-safe: however many callers, the invoice is queued once', async () => {
      const c = await newCustomer();
      const draft = await newInvoice(c);
      const results = await Promise.all([1, 2, 3].map(() => Hold.queueHeldInvoiceForSender(draft)));
      expect(results.filter((r) => r.queued)).toHaveLength(1);
      const at = (await invoice(draft)).scheduled_send_at;
      expect((await Hold.queueHeldInvoiceForSender(draft)).queued).toBe(false);
      expect((await invoice(draft)).scheduled_send_at.getTime()).toBe(at.getTime());
    });

    test('inside a caller transaction it rides that transaction (rolls back with it)', async () => {
      const c = await newCustomer();
      const draft = await newInvoice(c);
      await expect(db.transaction(async (trx) => {
        expect((await Hold.queueHeldInvoiceForSender(draft, trx)).queued).toBe(true);
        throw new Error('roll back');
      })).rejects.toThrow('roll back');
      expect((await invoice(draft)).status).toBe('draft');
    });
  });

  describe('the sender under a hold', () => {
    test('a hold that lands between the due read and the send is caught at the delivery boundary: still scheduled, pushed a tick out, NO attempt spent, claim released, nothing sent', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      await queueDue(inv); // clear at the due read
      const real = Hold.dueInvoiceHeldByDisputeHold;
      const race = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockImplementationOnce(async (...args) => {
        await placeHold(c); // the dispute lands after the query selected this invoice, before the send
        return real(...args);
      });
      const before = Date.now();
      try {
        const out = await Invoices.processScheduledSends();
        expect(out.deferred).toBeGreaterThanOrEqual(1);
      } finally { race.mockRestore(); }
      expect(sentIds()).not.toContain(inv);
      const row = await invoice(inv);
      expect(row).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
      expect(row.scheduled_send_at.getTime()).toBeGreaterThan(before + 3 * 60 * 1000);
      expect(row.scheduled_send_at.getTime()).toBeLessThan(before + 5 * 60 * 1000);
    });

    test('an already-held due invoice is skipped by the due query itself: untouched, nothing claimed, nothing sent', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      await queueDue(inv);
      const before = await invoice(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      const after = await invoice(inv);
      expect(after).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
      expect(after.scheduled_send_at.getTime()).toBe(before.scheduled_send_at.getTime());
    });

    test('a deferred invoice keeps deferring, every tick, with attempts still at 0', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      await queueDue(inv);
      for (let i = 0; i < 3; i += 1) {
        await Invoices.processScheduledSends();
        await makeDueNow(inv);
      }
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0 });
    });

    test('a hold placed AFTER the invoice was queued still blocks the send', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      await queueDue(inv); // queued while the customer was clear
      await placeHold(c); // the dispute lands before the tick
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0 });
    });

    test('released through the ops script (releaseFlag directly), the next tick sends it once', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      await queueDue(inv);
      await Invoices.processScheduledSends(); // deferred under the hold
      expect(sentIds()).not.toContain(inv);
      expect(await releaseViaOpsScript(c)).toMatchObject({ ok: true, released: 1 });
      await makeDueNow(inv); // "the next tick": the deferral is under one tick, so it is due again by then
      await Invoices.processScheduledSends();
      expect(sentIds().filter((id) => id === inv)).toHaveLength(1);
      expect(sendSpy).toHaveBeenCalledWith(inv, expect.objectContaining({ allowClaimed: true }));
      expect((await invoice(inv)).status).toBe('sent');
      // and a further tick sends nothing more
      await Invoices.processScheduledSends();
      expect(sentIds().filter((id) => id === inv)).toHaveLength(1);
    });

    test('held invoices never take a page slot: 26 held (older) invoices plus 1 unheld due invoice - the unheld one still sends in the same tick', async () => {
      const held = await newCustomer();
      const clear = await newCustomer();
      await placeHold(held);
      const heldIds = [];
      for (let i = 0; i < 26; i += 1) {
        const id = await newInvoice(held, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 2 * 3600 * 1000 - i * 1000) });
        heldIds.push(id);
      }
      const unheld = await newInvoice(clear, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 3600 * 1000) });
      const out = await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).toContain(unheld);
      for (const id of heldIds) expect(sentIds()).not.toContain(id);
      expect(out.sent).toBeGreaterThanOrEqual(1);
      // the held ones are untouched by the tick: the due query skipped them (nothing claimed, no attempt spent)
      const rows = await db('invoices').whereIn('id', heldIds);
      expect(rows.every((r) => r.status === 'scheduled' && r.scheduled_send_attempts === 0 && r.send_claim_token === null)).toBe(true);
    });

    test('the deferral is shorter than one cron tick, so a release is sent by the very next tick', () => {
      expect(Hold.HOLD_DEFER_MS).toBeLessThan(5 * 60 * 1000);
    });

    test('a hold-lookup failure defers (fail closed, retried next tick) - never sends, never spends an attempt, never parks', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      await queueDue(inv);
      db.__failTables.add('collections_flags');
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      let row = await invoice(inv);
      expect(row).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
      expect(row.scheduled_send_at).not.toBeNull(); // still on the queue: not parked
      // the lookup recovers; no hold exists -> the next tick sends it
      db.__failTables.clear();
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
      row = await invoice(inv);
      expect(row.status).toBe('sent');
    });

    test('a non-dispute (wrong-number fallback) hold does not stop the send', async () => {
      const c = await newCustomer();
      await placeHold(c, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
      const inv = await newInvoice(c);
      await queueDue(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
    });

    test("another customer's hold does not hold this customer's invoice", async () => {
      const held = await newCustomer();
      const clear = await newCustomer();
      await placeHold(held);
      const inv = await newInvoice(clear);
      await queueDue(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
    });
  });

  describe('deferred completion replay: hold -> strip + queue in ONE transaction', () => {
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

    test('the strip queues the invoice; the text stays report-only; the sender holds it, then sends it once after the release', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      const first = await recheckFor(id);
      expect(first).toMatchObject({ eligible: true, stripPayLink: true, reason: 'collections-dispute-hold' });
      const { stripPayLinkLineFromBody } = require('../services/dispatch-completion-deferred');
      const changed = await persistStrippedPayLink({
        msgId: id, strippedBody: stripPayLinkLineFromBody((await smsRow(id)).message_body, PAY_URL), reason: first.reason, invoiceId: inv,
      });
      expect(changed).toBe(1);
      const row = await smsRow(id);
      expect(row.message_body).not.toContain('pay.example.test');
      expect(row.metadata.mark_invoice_delivery).toBeUndefined();
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });

      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv); // held while the dispute stands
      await releaseViaOpsScript(c);
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds().filter((x) => x === inv)).toHaveLength(1);
      // the retried text attempt is still report-only: no second pay link
      const second = await recheckFor(id);
      expect(second.stripPayLink).toBeUndefined();
      expect((await smsRow(id)).message_body).not.toContain('pay.example.test');
    });

    test('a queue failure rolls the strip back (the row keeps its body and its claim); the attempt retries', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_queue() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
      await db.raw(`CREATE TRIGGER b10_fail_queue_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.id = '${inv}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_queue()`);
      try {
        await expect(persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: 'collections-dispute-hold', invoiceId: inv }))
          .rejects.toThrow(/queue down/);
      } finally {
        await db.raw('DROP TRIGGER IF EXISTS b10_fail_queue_trg ON invoices');
        await db.raw('DROP FUNCTION IF EXISTS b10_fail_queue()');
      }
      const row = await smsRow(id);
      expect(row.message_body).toContain('pay.example.test'); // strip rolled back
      expect(row.metadata.pay_link_stripped_reason).toBeUndefined();
      expect((await invoice(inv)).status).toBe('draft');
      // the retry (fresh recheck, fault gone) strips and queues
      const retry = await recheckFor(id);
      expect(await persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: retry.reason, invoiceId: inv })).toBe(1);
      expect((await invoice(inv)).status).toBe('scheduled');
    });

    test('a non-hold strip (invoice already terminal) queues nothing', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      await persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: 'invoice-terminal:paid', invoiceId: inv });
      expect(await invoice(inv)).toMatchObject({ status: 'draft', scheduled_send_at: null });
    });

    test('a lost claim changes nothing on the invoice either', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      await db('sms_log').where({ id }).update({ status: 'sent' });
      expect(await persistStrippedPayLink({ msgId: id, strippedBody: 'x', reason: 'collections-dispute-hold', invoiceId: inv })).toBe(0);
      expect((await invoice(inv)).status).toBe('draft');
    });
  });

  describe('the deferred decline notice, suppressed whole under a hold', () => {
    const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');

    test('queues its invoice onto the sender (the notice was the only pay-link delivery)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const verdict = await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: inv, customer_id: c });
      expect(verdict).toMatchObject({ eligible: false, reason: 'collections-dispute-hold' });
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      await releaseViaOpsScript(c);
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
    });

    test('a queue write failure raises a durable office alert and stays retryable (never swallowed)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_queue2() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
      await db.raw(`CREATE TRIGGER b10_fail_queue2_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.id = '${inv}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_queue2()`);
      let verdict;
      try {
        verdict = await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: inv, customer_id: c });
      } finally {
        await db.raw('DROP TRIGGER IF EXISTS b10_fail_queue2_trg ON invoices');
        await db.raw('DROP FUNCTION IF EXISTS b10_fail_queue2()');
      }
      expect(verdict).toMatchObject({ eligible: false, reason: 'recheck-failed', retryable: true });
      const alerts = await db('dispatch_alerts').where({ type: 'collection_hold_invoice_queue_failed' }).whereRaw("payload->>'invoiceId' = ?", [String(inv)]);
      expect(alerts).toHaveLength(1);
      expect((await invoice(inv)).status).toBe('draft');
      // the retry, fault gone, queues it
      expect(await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: inv, customer_id: c })).toMatchObject({ reason: 'collections-dispute-hold' });
      expect((await invoice(inv)).status).toBe('scheduled');
    });
  });

  describe('a deferred completion replay that dies at the attempt cap with its invoice never queued', () => {
    const { onTerminalDeferredReplay } = require('../services/messaging/deferred-replay-registry');
    const meta = (inv, c) => ({ entry_point: 'dispatch_completion_deferred', invoice_id: inv, customer_id: c, pay_url: 'https://pay.example.test/i/x' });
    const alertsFor = (inv) => db('dispatch_alerts').where({ type: 'collection_hold_invoice_queue_failed' }).whereRaw("payload->>'invoiceId' = ?", [String(inv)]);

    test('the terminal hook raises the queue-failure office alert once (a re-run adds none)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c); // still a draft: the replay never got to queue it
      expect(await onTerminalDeferredReplay('dispatch_completion_deferred', meta(inv, c))).toMatchObject({ ok: true });
      const alerts = await alertsFor(inv);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].payload.customerId).toBe(String(c));
      await onTerminalDeferredReplay('dispatch_completion_deferred', meta(inv, c));
      expect(await alertsFor(inv)).toHaveLength(1);
    });

    test('no alert when the invoice was queued, when there is no hold, or when the row carries no pay link', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const queued = await newInvoice(c);
      await Hold.queueHeldInvoiceForSender(queued);
      await onTerminalDeferredReplay('dispatch_completion_deferred', meta(queued, c));
      expect(await alertsFor(queued)).toHaveLength(0);
      const clear = await newCustomer();
      const draft = await newInvoice(clear);
      await onTerminalDeferredReplay('dispatch_completion_deferred', meta(draft, clear));
      expect(await alertsFor(draft)).toHaveLength(0);
      const noLink = await newInvoice(c);
      await onTerminalDeferredReplay('dispatch_completion_deferred', { ...meta(noLink, c), pay_url: undefined });
      expect(await alertsFor(noLink)).toHaveLength(0);
    });
  });

  describe('a deferred decline notice that dies terminally (completion text disabled or already handled)', () => {
    const { onTerminalDeferredReplay } = require('../services/messaging/deferred-replay-registry');
    const meta = (inv, c) => ({ entry_point: 'autopay_completion_decline_deferred', invoice_id: inv, customer_id: c, pay_url: 'https://pay.example.test/i/x' });
    const alertsFor = (inv) => db('dispatch_alerts').where({ type: 'collection_hold_invoice_queue_failed' }).whereRaw("payload->>'invoiceId' = ?", [String(inv)]);

    test('the terminal hook hands the invoice to the sender; with the hold standing the sender holds it, then sends it after the release', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c); // the notice was its only pay-link delivery: still a draft
      expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', meta(inv, c))).toMatchObject({ ok: true });
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      await releaseViaOpsScript(c);
      await Invoices.processScheduledSends();
      expect(sentIds().filter((x) => x === inv)).toHaveLength(1);
    });

    test('without a hold it queues too (the notice never delivered); a paid, sent or payer-billed invoice is left alone', async () => {
      const c = await newCustomer();
      const draft = await newInvoice(c);
      const paid = await newInvoice(c, { status: 'paid', paid_at: db.fn.now() });
      const payer = await newInvoice(c, { scheduled_send_error: 'payer_billed:7' });
      for (const inv of [draft, paid, payer]) await onTerminalDeferredReplay('autopay_completion_decline_deferred', meta(inv, c));
      expect((await invoice(draft)).status).toBe('scheduled');
      expect((await invoice(paid)).status).toBe('paid');
      expect(await invoice(payer)).toMatchObject({ status: 'draft', scheduled_send_error: 'payer_billed:7' });
    });

    test('a queue write failure raises the office alert once, is reported as a failed hook (so the sweep retries), and a retry queues it', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_queue3() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
      await db.raw(`CREATE TRIGGER b10_fail_queue3_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.id = '${inv}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_queue3()`);
      try {
        expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', meta(inv, c))).toMatchObject({ ok: false });
        expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', meta(inv, c))).toMatchObject({ ok: false });
      } finally {
        await db.raw('DROP TRIGGER IF EXISTS b10_fail_queue3_trg ON invoices');
        await db.raw('DROP FUNCTION IF EXISTS b10_fail_queue3()');
      }
      expect(await alertsFor(inv)).toHaveLength(1);
      expect((await invoice(inv)).status).toBe('draft');
      expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', meta(inv, c))).toMatchObject({ ok: true });
      expect((await invoice(inv)).status).toBe('scheduled');
    });
  });
});
