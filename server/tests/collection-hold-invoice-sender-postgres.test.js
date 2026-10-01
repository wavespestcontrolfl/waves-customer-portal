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
  let realSend;
  const customers = [];
  const packetFixtures = { packets: [], visits: [], services: [], payers: [] };

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
    realSend = Invoices.sendViaSMSAndEmail;
    // The provider handoff is out of scope: finalize the way a real delivery would.
    sendSpy = jest.spyOn(Invoices, 'sendViaSMSAndEmail').mockImplementation(fakeDelivery);
  });
  async function fakeDelivery(invoiceId, opts = {}) {
    await db('invoices').where({ id: invoiceId }).update({
      status: 'sent', sent_at: db.fn.now(), scheduled_send_at: null, send_claim_token: null, updated_at: db.fn.now(),
    });
    return { ok: true, opts };
  }
  // Run the REAL sender entry (its own Bill-To fence + hold guard) with a provider that must never be reached.
  async function withRealSender(fn) {
    sendSpy.mockImplementation((...args) => realSend.apply(Invoices, args));
    try { return await fn(); } finally { sendSpy.mockImplementation(fakeDelivery); }
  }
  beforeEach(() => { jest.clearAllMocks(); db.__failTables.clear(); });
  afterAll(async () => {
    sendSpy.mockRestore();
    if (customers.length) {
      await db('invoices').whereIn('customer_id', customers).del();
      await db('visit_completion_packets').whereIn('id', packetFixtures.packets).del();
      await db('service_visits').whereIn('id', packetFixtures.visits).del();
      await db('scheduled_services').whereIn('id', packetFixtures.services).del();
      await db('payers').whereIn('id', packetFixtures.payers).del();
      await db('service_records').whereIn('customer_id', customers).del();
      await db('dispatch_alerts').whereRaw("payload->>'customerId' = ANY(?)", [customers.map(String)]).del();
      await db('sms_log').whereIn('customer_id', customers).del();
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('invoices').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  async function packetInvoiceFor(customerId, { payer = false } = {}) {
    const [visit] = await db('service_visits').insert({
      customer_id: customerId, scheduled_date: '2040-03-04', stop_base_key: `pkt-${randomUUID().slice(0, 8)}`, created_by: 'fixture',
    }).returning('id');
    const [svc] = await db('scheduled_services').insert({
      customer_id: customerId, status: 'confirmed', scheduled_date: '2040-03-04', service_type: 'Pest Control',
    }).returning('id');
    const [packet] = await db('visit_completion_packets').insert({
      visit_id: visit.id, idempotency_key: `pkt-${randomUUID()}`, request_hash: 'fixture', status: 'processing',
      payload: JSON.stringify({ billingSnapshot: { billedServiceIds: [svc.id] } }),
    }).returning('id');
    packetFixtures.visits.push(visit.id); packetFixtures.services.push(svc.id); packetFixtures.packets.push(packet.id);
    let payerId = null;
    if (payer) {
      // The Bill-To is assigned AFTER the invoice was queued: invoices.payer_id stays NULL until
      // the claim-time fence resolves it.
      const [p] = await db('payers').insert({ display_name: 'Synthetic Bill-To', ap_email: 'ap@example.invalid' }).returning('id');
      packetFixtures.payers.push(p.id);
      payerId = p.id;
      await db('scheduled_services').where({ id: svc.id }).update({ payer_id: p.id });
    }
    const inv = await newInvoice(customerId, { visit_completion_packet_id: packet.id });
    return { inv, payerId };
  }

  async function renewalInvoice(customerId) {
    const inv = await newInvoice(customerId);
    const [parent] = await db('annual_prepay_terms').insert({
      customer_id: customerId, term_start: '2039-01-01', term_end: '2039-12-31', status: 'renewed', renewal_decision: 'renew',
    }).returning('id');
    const [successor] = await db('annual_prepay_terms').insert({
      customer_id: customerId, term_start: '2040-01-01', term_end: '2040-12-31', status: 'payment_pending',
      renewed_from_term_id: parent.id, annual_plan_version: 'v3', prepay_invoice_id: inv,
    }).returning('id');
    await db('invoices').where({ id: inv }).update({ annual_prepay_term_id: successor.id });
    return { inv, parent: parent.id, successor: successor.id };
  }

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
      for (const id of [paid, sent, deliveredElsewhere, payerStamped, renewal]) expect(await Hold.queueHeldInvoiceForSender(id)).toMatchObject({ queued: false, settled: true });
      expect(await invoice(draft)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, scheduled_send_error: null });
      expect((await invoice(draft)).scheduled_send_at).not.toBeNull();
      expect((await invoice(paid)).status).toBe('paid');
      expect((await invoice(sent)).status).toBe('sent');
      expect(await invoice(deliveredElsewhere)).toMatchObject({ status: 'draft', scheduled_send_at: null });
      expect((await invoice(payerStamped)).scheduled_send_error).toBe('payer_billed:7');
      expect((await invoice(renewal)).scheduled_send_error).toBe('renewal_send_withheld: test');
    });

    test('a zero-row result is success ONLY when verifiably handled; a transient sending (or anything else) is a retryable refusal', async () => {
      const c = await newCustomer();
      const scheduled = await newInvoice(c, { status: 'scheduled', scheduled_send_at: new Date() });
      const voided = await newInvoice(c, { status: 'void' });
      expect(await Hold.queueHeldInvoiceForSender(scheduled)).toMatchObject({ queued: false, settled: true });
      expect(await Hold.queueHeldInvoiceForSender(voided)).toMatchObject({ queued: false, settled: true });
      // a concurrent sender holds the claim: it may still restore the invoice to draft -> NOT settled
      const sending = await newInvoice(c, { status: 'sending', send_claim_token: randomUUID() });
      await expect(Hold.queueHeldInvoiceForSender(sending)).rejects.toMatchObject({ code: 'QUEUE_INVOICE_NOT_SETTLED', retryable: true });
      // once the sender gives the claim back as a draft, the very same call queues it
      await db('invoices').where({ id: sending }).update({ status: 'draft', send_claim_token: null });
      expect(await Hold.queueHeldInvoiceForSender(sending)).toEqual({ queued: true });
    });

    // Codex #5424 r16 P2: an already-'scheduled' invoice at the sender's attempt cap is NOT runnable
    // (processScheduledSends selects scheduled_send_attempts < 5), so the handoff must not call it settled.
    test('a scheduled invoice that exhausted its attempts is RE-ARMED by the hold handoff (fresh budget, due now) and sends after the release; a runnable one, a delivered one and a live claim are left alone', async () => {
      const c = await newCustomer();
      const past = new Date(Date.now() - 3600 * 1000);
      const exhausted = await newInvoice(c, { status: 'scheduled', scheduled_send_at: past, scheduled_send_attempts: 5, scheduled_send_error: 'sms: synthetic carrier failure' });
      const runnable = await newInvoice(c, { status: 'scheduled', scheduled_send_at: past, scheduled_send_attempts: 4, scheduled_send_error: 'sms: synthetic carrier failure' });
      const exhaustedDelivered = await newInvoice(c, { status: 'scheduled', scheduled_send_at: past, scheduled_send_attempts: 5, sms_sent_at: db.fn.now() });
      const liveClaim = await newInvoice(c, { status: 'sending', scheduled_send_attempts: 5, send_claim_token: randomUUID() });

      expect(await Hold.queueHeldInvoiceForSender(exhausted)).toEqual({ queued: true, rearmed: true });
      expect(await invoice(exhausted)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, scheduled_send_error: null, send_claim_token: null });
      expect((await invoice(exhausted)).scheduled_send_at.getTime()).toBeGreaterThan(past.getTime());

      // runnable: the sender still owns it as-is (untouched: attempts and time kept)
      expect(await Hold.queueHeldInvoiceForSender(runnable)).toMatchObject({ queued: false, settled: true });
      expect(await invoice(runnable)).toMatchObject({ scheduled_send_attempts: 4, scheduled_send_error: 'sms: synthetic carrier failure' });
      expect((await invoice(runnable)).scheduled_send_at.getTime()).toBe(past.getTime());
      // delivered on a channel already: not re-armed
      expect(await Hold.queueHeldInvoiceForSender(exhaustedDelivered)).toMatchObject({ queued: false, settled: true });
      expect((await invoice(exhaustedDelivered)).scheduled_send_attempts).toBe(5);
      // a live claim is never reset: still the transient-sending refusal, claim token and attempts intact
      const before = await invoice(liveClaim);
      await expect(Hold.queueHeldInvoiceForSender(liveClaim)).rejects.toMatchObject({ code: 'QUEUE_INVOICE_NOT_SETTLED', retryable: true });
      expect(await invoice(liveClaim)).toMatchObject({ status: 'sending', scheduled_send_attempts: 5, send_claim_token: before.send_claim_token });
      // idempotent: the re-armed row is now runnable, so a second handoff is settled and changes nothing
      const rearmedAt = (await invoice(exhausted)).scheduled_send_at.getTime();
      expect(await Hold.queueHeldInvoiceForSender(exhausted)).toMatchObject({ queued: false, settled: true });
      expect((await invoice(exhausted)).scheduled_send_at.getTime()).toBe(rearmedAt);
    });

    test('end to end: a completion hand-over (handOverHeldInvoiceToSender) of an exhausted scheduled invoice records the sender as owner AND the invoice is delivered by the first tick after the release', async () => {
      const Deferred = require('../services/dispatch-completion-deferred');
      const c = await newCustomer();
      const holdId = await placeHold(c);
      const inv = await newInvoice(c, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 3600 * 1000), scheduled_send_attempts: 5 });
      const [rec] = await db('service_records').insert({ customer_id: c, service_date: '2040-03-04', service_type: 'Pest Control', status: 'completed' }).returning('id');
      expect(await Deferred.handOverHeldInvoiceToSender({ invoiceId: inv, serviceRecordId: rec.id })).toMatchObject({ queued: true, rearmed: true });
      expect((await db('service_records').where({ id: rec.id }).first()).structured_notes).toMatchObject({ invoiceSenderOwnsPayLinkFor: String(inv) });
      // under the hold the tick defers it (no attempt spent) ...
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).not.toContain(inv);
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0 });
      // ... and the release delivers it
      await db('collections_flags').where({ id: holdId }).update({ released_at: db.fn.now() });
      await makeDueNow(inv);
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).toContain(inv);
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

  describe('combined-visit (packet) invoices reach the live Bill-To fence before the hold exclusion (#5424 round 10)', () => {

    test('a packet invoice for a held homeowner who now has a payer is routed to the payer (withdrawn), never held behind the homeowner\'s dispute, never texted', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const { inv, payerId } = await packetInvoiceFor(c, { payer: true });
      await queueDue(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      expect(await invoice(inv)).toMatchObject({ status: 'draft', scheduled_send_at: null, send_claim_token: null });
      expect((await invoice(inv)).scheduled_send_error).toMatch(new RegExp(`^payer_billed:${payerId}`));
    });

    test('a truly self-pay packet invoice for a held homeowner still waits: claimed by the fence, released at the delivery-boundary hold check, no attempt spent, then sends after the release', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const { inv } = await packetInvoiceFor(c);
      await queueDue(inv);
      const before = Date.now();
      const out = await Invoices.processScheduledSends();
      expect(out.deferred).toBeGreaterThanOrEqual(1);
      expect(sentIds()).not.toContain(inv);
      const row = await invoice(inv);
      expect(row).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
      expect(row.scheduled_send_at.getTime()).toBeGreaterThan(before + 3 * 60 * 1000);

      await releaseViaOpsScript(c);
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
    });
  });

  describe('termite renewal invoices reach the live Bill-To fence before the sender\'s hold check (#5424 round 11)', () => {
    afterEach(async () => {
      await db('annual_prepay_terms').whereIn('customer_id', customers).update({ prepay_invoice_id: null, renewed_from_term_id: null });
      await db('annual_prepay_terms').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).update({ payer_id: null });
    });

    test('a held homeowner whose renewal invoice belongs to the customer default payer is withdrawn to that payer (payer_billed), never parked behind the dispute, never sent to the homeowner', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const [payer] = await db('payers').insert({ display_name: 'Synthetic Bill-To', ap_email: 'ap@example.invalid' }).returning('id');
      packetFixtures.payers.push(payer.id);
      await db('customers').where({ id: c }).update({ payer_id: payer.id });
      const { inv } = await renewalInvoice(c);
      await queueDue(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      const row = await invoice(inv);
      expect(row).toMatchObject({ status: 'draft', scheduled_send_at: null, send_claim_token: null });
      expect(row.scheduled_send_error).toBe(`payer_billed:${payer.id}`);
    });

    test('a truly self-pay renewal invoice for a held homeowner still waits (deferred, no attempt spent) and sends after the release', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const { inv } = await renewalInvoice(c);
      await queueDue(inv);
      const before = Date.now();
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      const row = await invoice(inv);
      expect(row).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
      expect(row.scheduled_send_at.getTime()).toBeGreaterThan(before + 3 * 60 * 1000);
      await releaseViaOpsScript(c);
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
    });

    describe('the sender entry itself resolves Bill-To before the hold guard (#5424 round 12)', () => {
      async function heldHomeownerWithDefaultPayer() {
        const c = await newCustomer();
        await placeHold(c);
        const [payer] = await db('payers').insert({ display_name: 'Synthetic Bill-To', ap_email: 'ap@example.invalid' }).returning('id');
        packetFixtures.payers.push(payer.id);
        await db('customers').where({ id: c }).update({ payer_id: payer.id });
        return { c, payerId: payer.id };
      }

      test('a DIRECT renewal send (sendViaSMSAndEmail, no worker) for a held homeowner with a default payer is routed to the payer: payer_billed, never the hold deferral, never sent', async () => {
        const { c, payerId } = await heldHomeownerWithDefaultPayer();
        const { inv } = await renewalInvoice(c);
        const out = await withRealSender(() => Invoices.sendViaSMSAndEmail(inv, {}));
        expect(out).toMatchObject({ ok: false, code: 'payer_billed' });
        expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
        // An unclaimed direct send has no claim to withdraw: the invoice is left exactly as found, unclaimed.
        expect(await invoice(inv)).toMatchObject({ status: 'draft', scheduled_send_at: null, send_claim_token: null, sms_sent_at: null });
        expect(payerId).toBeTruthy();
      });

      test('the direct sendViaSMS entry takes the same order: a held homeowner\'s renewal with a default payer is payer_billed', async () => {
        const { c, payerId } = await heldHomeownerWithDefaultPayer();
        const { inv } = await renewalInvoice(c);
        const out = await Invoices.sendViaSMS(inv, {});
        expect(out).toMatchObject({ sent: false, code: 'payer_billed' });
        expect(await invoice(inv)).toMatchObject({ status: 'draft', send_claim_token: null });
        expect(payerId).toBeTruthy();
      });

      test('the renewal pay-link clearance (deliverRenewalInvoice) reads Bill-To before the hold too: a payer-owned renewal routes to the payer (payer_billed), a self-pay one still waits (delivery_refused, deferred)', async () => {
        const Renewal = require('../services/termite-annual-renewal-charge');
        const { c } = await heldHomeownerWithDefaultPayer();
        const { successor } = await renewalInvoice(c);
        const term = await db('annual_prepay_terms').where({ id: successor }).first();
        const routed = await withRealSender(() => Renewal._private.deliverRenewalInvoice(term));
        expect(routed).toMatchObject({ ok: false, code: 'payer_billed' });

        const own = await newCustomer();
        await placeHold(own);
        const selfPay = await renewalInvoice(own);
        const row = await db('annual_prepay_terms').where({ id: selfPay.successor }).first();
        const waited = await withRealSender(() => Renewal._private.deliverRenewalInvoice(row));
        expect(waited).toMatchObject({ ok: false, code: 'delivery_refused', outcome: 'deferred' });
        expect(await invoice(selfPay.inv)).toMatchObject({ status: 'draft', send_claim_token: null, sms_sent_at: null });
      });

      test('a direct packet invoice send for a held homeowner whose visit now has a payer is payer_billed on both sender entries', async () => {
        const c = await newCustomer();
        await placeHold(c);
        const { inv, payerId } = await packetInvoiceFor(c, { payer: true });
        const out = await withRealSender(() => Invoices.sendViaSMSAndEmail(inv, {}));
        expect(out).toMatchObject({ ok: false, code: 'payer_billed' });
        expect(await invoice(inv)).toMatchObject({ status: 'draft', send_claim_token: null });
        expect(payerId).toBeTruthy();
        const { inv: inv2 } = await packetInvoiceFor(c, { payer: true });
        expect(await Invoices.sendViaSMS(inv2, {})).toMatchObject({ sent: false, code: 'payer_billed' });
      });

      test('a truly self-pay renewal / packet invoice for a held homeowner is still refused with the retryable hold deferral, the fence claim handed straight back (untouched, unclaimed, nothing sent)', async () => {
        const c = await newCustomer();
        await placeHold(c);
        const { inv } = await renewalInvoice(c);
        const out = await withRealSender(() => Invoices.sendViaSMSAndEmail(inv, {}));
        expect(out).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER' });
        expect(await invoice(inv)).toMatchObject({ status: 'draft', send_claim_token: null, scheduled_send_error: null });
        const sms = await Invoices.sendViaSMS(inv, {});
        expect(sms).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_DEFER' });
        expect(await invoice(inv)).toMatchObject({ status: 'draft', send_claim_token: null });

        const { inv: pkt } = await packetInvoiceFor(c);
        const pktOut = await withRealSender(() => Invoices.sendViaSMSAndEmail(pkt, {}));
        expect(pktOut).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER' });
        expect(await invoice(pkt)).toMatchObject({ status: 'draft', send_claim_token: null });
        expect(await Invoices.sendViaSMS(pkt, {})).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_DEFER' });
        expect(await invoice(pkt)).toMatchObject({ status: 'draft', send_claim_token: null });
      });

      // Codex #5424 r15 P2: a direct send that took its Bill-To-fenced claim and then found a hold handed the claim
      // back and IGNORED a failed restore, returning the ordinary retryable hold defer for an invoice left in
      // 'sending' (ten minutes on, stale-claim recovery parks it with no scheduled send time).
      describe('a hold found after the Bill-To-fenced claim whose restore FAILS (Codex #5424 r15 P2)', () => {
        const notifications = () => require('../services/notification-service');
        // The claim is lost between the claim and its hand-back: the token no longer matches, so the token-scoped restore fails.
        function stealClaimBeforeRestore(inv) {
          const real = Hold.messagingHeldByCollectionHold;
          return jest.spyOn(Hold, 'messagingHeldByCollectionHold').mockImplementation(async (...args) => {
            await db('invoices').where({ id: inv, status: 'sending' }).update({ send_claim_token: randomUUID() });
            return real(...args);
          });
        }

        test('both direct sender entries return a distinct held + manual-recovery outcome (not the ordinary defer) and raise a durable office alert', async () => {
          const notify = jest.spyOn(notifications(), 'notifyAdmin').mockResolvedValue({ id: 'synthetic' });
          try {
            const c = await newCustomer();
            await placeHold(c);
            const { inv: viaWrapper } = await packetInvoiceFor(c);
            const spy = stealClaimBeforeRestore(viaWrapper);
            let out;
            try { out = await withRealSender(() => Invoices.sendViaSMSAndEmail(viaWrapper, {})); } finally { spy.mockRestore(); }
            expect(out).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_CLAIM_STRANDED', held: true, manualRecovery: true, retryable: false, deferred: false, deliveryOutcome: 'not_sent' });
            expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
            expect(out.sms).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_CLAIM_STRANDED' });
            expect(out.nextAllowedAt).toBeUndefined();
            expect(await invoice(viaWrapper)).toMatchObject({ status: 'sending' }); // stranded, exactly what the alert says
            expect(notify).toHaveBeenCalledTimes(1);
            expect(notify).toHaveBeenCalledWith('alert', expect.stringMatching(/^Billing/), expect.any(String),
              expect.objectContaining({ dedupeKey: `hold-claim-stranded:${viaWrapper}`, link: `/admin/invoices?invoice=${viaWrapper}` }));

            const { inv: viaSms } = await packetInvoiceFor(c);
            const spy2 = stealClaimBeforeRestore(viaSms);
            let smsOut;
            try { smsOut = await Invoices.sendViaSMS(viaSms, {}); } finally { spy2.mockRestore(); }
            expect(smsOut).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_CLAIM_STRANDED', held: true, manualRecovery: true, retryable: false, deferred: false });
            expect(notify).toHaveBeenCalledTimes(2);
            expect(notify).toHaveBeenLastCalledWith('alert', expect.any(String), expect.any(String), expect.objectContaining({ dedupeKey: `hold-claim-stranded:${viaSms}` }));
          } finally { notify.mockRestore(); }
        });

        test('control: a restore that lands keeps the ordinary retryable hold defer and raises no alert', async () => {
          const notify = jest.spyOn(notifications(), 'notifyAdmin').mockResolvedValue({ id: 'synthetic' });
          try {
            const c = await newCustomer();
            await placeHold(c);
            const { inv } = await packetInvoiceFor(c);
            const out = await withRealSender(() => Invoices.sendViaSMSAndEmail(inv, {}));
            expect(out).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true });
            expect(out.manualRecovery).toBeUndefined();
            expect(await invoice(inv)).toMatchObject({ status: 'draft', send_claim_token: null });
            expect(notify).not.toHaveBeenCalled();
          } finally { notify.mockRestore(); }
        });
      });

      // Codex #5424 r13 P2: claimBillToFencedSend used to call withRenewalSendClearance without the
      // trusted exemption, so the admin Send / a customer-requested link threw collectionHoldDeferral for
      // a renewal invoice under a DISPUTE hold. The exemption is now threaded in (dispute only).
      test('the renewal send clearance honours the trusted exemption for a DISPUTE hold, never for a wrong-number FALLBACK hold', async () => {
        const Renewal = require('../services/termite-annual-renewal-charge');
        const claim = jest.fn(async () => 'claimed');
        const release = jest.fn(async () => {});

        const disputed = await newCustomer();
        await placeHold(disputed);
        const d = await renewalInvoice(disputed);
        // automated: parked behind the dispute (a hold deferral, nothing claimed)
        await expect(Renewal.withRenewalSendClearance(d.successor, { claim, release })).rejects.toMatchObject({ code: 'renewal_send_withheld', collectionHoldDeferral: true });
        expect(claim).not.toHaveBeenCalled();
        // operator / customer: the dispute is exempt, the clearance proceeds to the claim
        expect(await Renewal.withRenewalSendClearance(d.successor, { claim, release, ignoreDisputeHold: true })).toBe('claimed');
        expect(claim).toHaveBeenCalledTimes(1);

        const fallback = await newCustomer();
        await placeHold(fallback, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
        const f = await renewalInvoice(fallback);
        claim.mockClear();
        // even the exempt sender waits on a fallback hold
        await expect(Renewal.withRenewalSendClearance(f.successor, { claim, release, ignoreDisputeHold: true })).rejects.toMatchObject({ code: 'renewal_send_withheld', collectionHoldDeferral: true });
        expect(claim).not.toHaveBeenCalled();
      });

      test('the exemption reaches the clearance from the sender entry: an operator / customer renewal send for a FALLBACK-held homeowner is still the retryable hold deferral', async () => {
        const c = await newCustomer();
        await placeHold(c, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
        const { inv } = await renewalInvoice(c);
        for (const holdExempt of ['operator', 'customer']) {
          const out = await withRealSender(() => Invoices.sendViaSMSAndEmail(inv, { operatorInitiated: holdExempt === 'operator', holdExempt }));
          expect(out).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER' });
          expect(await invoice(inv)).toMatchObject({ status: 'draft', send_claim_token: null, sms_sent_at: null });
        }
        const src = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice.js'), 'utf8');
        expect(src).toMatch(/claimBillToFencedSend\(invoiceId, pre, \{ firstDeliveryOnly, overridesReviewHold, adoptsQueuedInvoiceSend, holdExempt \}\)/);
        expect(src).toMatch(/ignoreDisputeHold = HOLD_EXEMPT_CALLERS\.has\(options\.holdExempt\)/);
      });
    });
  });

  describe('the sender under a hold', () => {
    test('a hold that lands between the due read and the send is caught at the delivery boundary: still scheduled, pushed a tick out, NO attempt spent, claim released, nothing sent', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      await queueDue(inv); // clear at the due read
      const real = Hold.messagingHeldByCollectionHold;
      const race = jest.spyOn(Hold, 'messagingHeldByCollectionHold').mockImplementationOnce(async (...args) => {
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

    test('held PACKET rows stop taking page slots once the Bill-To fence confirms them self-pay (Codex #5424 r14): 26 held packet invoices plus 1 ordinary invoice - the ordinary one sends on the first tick, and from the second tick on the cohort is skipped by the due query', async () => {
      const held = await newCustomer();
      const clear = await newCustomer();
      await placeHold(held);
      const heldIds = [];
      for (let i = 0; i < 26; i += 1) {
        const { inv } = await packetInvoiceFor(held);
        await db('invoices').where({ id: inv }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 2 * 3600 * 1000 - i * 1000) });
        heldIds.push(inv);
      }
      const ordinary = await newInvoice(clear, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 3600 * 1000) });
      // Tick 1: the ordinary invoice sorts ahead of the unchecked cohort (older though it is), so it sends on the FIRST tick ...
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).toContain(ordinary);
      // ... the page's remaining slots fence the oldest 24 held rows (retimed a hold tick out and stamped) ...
      const afterFirst = await db('invoices').whereIn('id', heldIds);
      expect(afterFirst.filter((r) => r.hold_bill_to_checked_at !== null).length).toBeLessThanOrEqual(25);
      // ... and once the cohort is stamped no tick re-admits it.
      await db('invoices').whereIn('id', heldIds).update({ scheduled_send_at: new Date(Date.now() - 1000) });
      await Invoices.processScheduledSends({ limit: 25 });
      await db('invoices').whereIn('id', heldIds).update({ scheduled_send_at: new Date(Date.now() - 1000) });
      await Invoices.processScheduledSends({ limit: 25 });
      for (const id of heldIds) expect(sentIds()).not.toContain(id);
      const rows = await db('invoices').whereIn('id', heldIds);
      expect(rows.every((r) => r.status === 'scheduled' && r.scheduled_send_attempts === 0 && r.send_claim_token === null)).toBe(true);
      expect(rows.every((r) => r.hold_bill_to_checked_at !== null)).toBe(true);
    });

    test('the packet Bill-To fence ITSELF confirms a held self-pay packet row (Codex #5424 r15): 26 held packet rows plus 1 ordinary invoice over two ticks - every held row is stamped, retimed a hold tick out with no attempt spent, and no stamped row is claimed again', async () => {
      const held = await newCustomer();
      const clear = await newCustomer();
      await placeHold(held);
      const heldIds = [];
      for (let i = 0; i < 26; i += 1) {
        const { inv } = await packetInvoiceFor(held);
        await db('invoices').where({ id: inv }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 2 * 3600 * 1000 - i * 1000) });
        heldIds.push(inv);
      }
      const ordinary = await newInvoice(clear, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 3600 * 1000) });
      const rows = () => db('invoices').whereIn('id', heldIds).select('id', 'status', 'scheduled_send_at', 'scheduled_send_attempts', 'send_claim_token', 'hold_bill_to_checked_at', 'updated_at');

      // Tick 1: the page is 25 rows - the ordinary invoice, then the 24 oldest held packet rows.
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).toContain(ordinary);
      const afterFirst = await rows();
      const stampedFirst = afterFirst.filter((r) => r.hold_bill_to_checked_at !== null);
      expect(stampedFirst).toHaveLength(24);
      for (const r of stampedFirst) {
        expect(r).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
        expect(r.scheduled_send_at.getTime()).toBeGreaterThan(Date.now());
      }
      // Tick 2: every held row is due again. The 24 stamped rows are invisible to the due query (untouched); the
      // 2 the first page never reached are fenced now and stamped, so the cohort has left the sender page.
      await db('invoices').whereIn('id', heldIds).update({ scheduled_send_at: new Date(Date.now() - 1000) });
      const beforeSecond = Object.fromEntries((await rows()).map((r) => [r.id, r]));
      await Invoices.processScheduledSends({ limit: 25 });
      const afterSecond = await rows();
      expect(afterSecond.every((r) => r.hold_bill_to_checked_at !== null)).toBe(true);
      for (const r of afterSecond) {
        expect(r).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
        if (beforeSecond[r.id].hold_bill_to_checked_at !== null) expect(r.updated_at.getTime()).toBe(beforeSecond[r.id].updated_at.getTime());
      }
      for (const id of heldIds) expect(sentIds()).not.toContain(id);
    });

    test('a confirmed-held packet row with a fresh stamp is invisible to the due query: 26 of them plus 1 ordinary invoice - the ordinary one sends on the FIRST tick, nothing held is claimed', async () => {
      const held = await newCustomer();
      const clear = await newCustomer();
      await placeHold(held);
      const heldIds = [];
      for (let i = 0; i < 26; i += 1) {
        const { inv } = await packetInvoiceFor(held);
        await db('invoices').where({ id: inv }).update({
          status: 'scheduled', scheduled_send_at: new Date(Date.now() - 2 * 3600 * 1000 - i * 1000), hold_bill_to_checked_at: new Date(),
        });
        heldIds.push(inv);
      }
      const ordinary = await newInvoice(clear, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 3600 * 1000) });
      const before = await db('invoices').whereIn('id', heldIds).select('id', 'scheduled_send_at', 'updated_at');
      const out = await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).toContain(ordinary);
      expect(out.sent).toBeGreaterThanOrEqual(1);
      const after = await db('invoices').whereIn('id', heldIds).select('id', 'scheduled_send_at', 'updated_at', 'status');
      const byId = Object.fromEntries(before.map((r) => [r.id, r]));
      for (const r of after) {
        expect(r.status).toBe('scheduled');
        expect(r.scheduled_send_at.getTime()).toBe(byId[r.id].scheduled_send_at.getTime()); // untouched: never selected
        expect(r.updated_at.getTime()).toBe(byId[r.id].updated_at.getTime());
      }
    });

    test('the stamp is a recheck interval, not a park: a STALE stamp re-enters the fence (a payer assigned since is routed to the payer), and a release sends at the next tick even with a fresh stamp', async () => {
      const held = await newCustomer();
      await placeHold(held);
      const { inv, payerId } = await packetInvoiceFor(held, { payer: true });
      await db('invoices').where({ id: inv }).update({
        status: 'scheduled', scheduled_send_at: new Date(Date.now() - 1000),
        hold_bill_to_checked_at: new Date(Date.now() - (Hold.HOLD_BILL_TO_RECHECK_MS + 60 * 1000)),
      });
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).not.toContain(inv);
      expect((await invoice(inv)).scheduled_send_error).toMatch(new RegExp(`^payer_billed:${payerId}`));

      const c2 = await newCustomer();
      await placeHold(c2);
      const { inv: inv2 } = await packetInvoiceFor(c2);
      await db('invoices').where({ id: inv2 }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 1000), hold_bill_to_checked_at: new Date() });
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).not.toContain(inv2);
      await releaseViaOpsScript(c2);
      await Invoices.processScheduledSends({ limit: 25 });
      expect(sentIds()).toContain(inv2);
    });

    test('the sender stamps the marker only when the fence actually confirmed the hold (deferral), and a renewal row is stamped too', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const { inv } = await packetInvoiceFor(c);
      await queueDue(inv);
      await Invoices.processScheduledSends({ limit: 25 });
      const stamped = await invoice(inv);
      expect(stamped.hold_bill_to_checked_at).not.toBeNull();
      expect(stamped).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0 });
      const c2 = await newCustomer();
      await placeHold(c2);
      const { inv: renewal } = await renewalInvoice(c2);
      await queueDue(renewal);
      await Invoices.processScheduledSends({ limit: 25 });
      expect((await invoice(renewal)).hold_bill_to_checked_at).not.toBeNull();
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

    // Codex #5424 r13: a wrong-number / wrong-party FALLBACK collection_hold is an all-channel outreach
    // block. The sender waits on it exactly as on a dispute (deferred, nothing spent, never terminal).
    const FALLBACK = 'wrong-number report on billing follow-up call; wrong_number flag write failed';

    test('a wrong-number FALLBACK hold stops the send too (deferred, no attempt spent); once the fallback is released it sends', async () => {
      const c = await newCustomer();
      const holdId = await placeHold(c, FALLBACK);
      const inv = await newInvoice(c);
      await queueDue(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, send_claim_token: null });
      await db('collections_flags').where({ id: holdId }).update({ released_at: db.fn.now() });
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).toContain(inv);
    });

    test('a released DISPUTE that restores a wrong-number fallback keeps the queued invoice waiting; only the fallback release sends it (Codex #5424 r13 P1)', async () => {
      const c = await newCustomer();
      await placeHold(c, FALLBACK);
      // the dispute lands on the active fallback row: one row, upgraded, the fallback rides in the trailer
      const { placeDisputeHold } = require('../services/collections/outbound-voice/flags');
      await placeDisputeHold(c, { summary: 'synthetic billing question' });
      const inv = await newInvoice(c);
      await queueDue(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv);
      // releasing the DISPUTE (the admin path) puts the fallback back: still an active all-channel outreach block
      const { releaseCollectionHold } = require('../services/collections/collection-hold-admin');
      const disputeRow = await db('collections_flags').where({ customer_id: c, flag: 'collection_hold' }).whereNull('released_at').first('id');
      expect(await releaseCollectionHold(c, { holdId: disputeRow.id })).toMatchObject({ ok: true });
      const restored = await db('collections_flags').where({ customer_id: c, flag: 'collection_hold' }).whereNull('released_at').select('id', 'reason');
      expect(restored).toHaveLength(1);
      expect(restored[0].reason).toBe(FALLBACK);
      await makeDueNow(inv);
      await Invoices.processScheduledSends();
      expect(sentIds()).not.toContain(inv); // the wrong party is NOT sent the invoice / pay link
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0 });
      // the fallback itself released: the queued invoice goes out
      await releaseViaOpsScript(c);
      await makeDueNow(inv);
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

    // #5424 round 10: the strip + queue also persists the handover's ownership marker on the
    // completion's service record, in the SAME transaction, so a retried closeout sees the sender
    // owns the pay link (report-only) even after the report-only replay dies terminally.
    async function newRecord(customerId) {
      const [r] = await db('service_records').insert({
        customer_id: customerId, service_date: '2040-03-04', service_type: 'Pest Control', status: 'completed', structured_notes: JSON.stringify({ keep: 'me' }),
      }).returning('id');
      return r.id;
    }
    const recordNotes = async (id) => {
      const n = (await db('service_records').where({ id }).first('structured_notes')).structured_notes;
      return typeof n === 'string' ? JSON.parse(n) : n;
    };

    test('the strip + queue persists invoiceSenderOwnsPayLinkFor on the service record (existing notes kept), atomically', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const rec = await newRecord(c);
      const id = await queueRow(c, inv);
      expect(await persistStrippedPayLink({
        msgId: id, strippedBody: 'Your service is complete.', reason: 'collections-dispute-hold', invoiceId: inv, serviceRecordId: rec,
      })).toBe(1);
      expect(await recordNotes(rec)).toMatchObject({ keep: 'me', invoiceSenderOwnsPayLinkFor: String(inv) });
      expect((await invoice(inv)).status).toBe('scheduled');
    });

    test('a queue failure rolls the marker back with the strip (no ownership claimed for an invoice that was never queued)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const rec = await newRecord(c);
      const id = await queueRow(c, inv);
      await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_queue2() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
      await db.raw(`CREATE TRIGGER b10_fail_queue2_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.id = '${inv}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_queue2()`);
      try {
        await expect(persistStrippedPayLink({ msgId: id, strippedBody: 'x', reason: 'collections-dispute-hold', invoiceId: inv, serviceRecordId: rec }))
          .rejects.toThrow(/queue down/);
      } finally {
        await db.raw('DROP TRIGGER IF EXISTS b10_fail_queue2_trg ON invoices');
        await db.raw('DROP FUNCTION IF EXISTS b10_fail_queue2()');
      }
      expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBeUndefined();
    });

    test('a non-hold strip records no ownership; the pay-link-only sibling hand-over records it with the queue', async () => {
      const { handOverHeldInvoiceToSender } = require('../services/dispatch-completion-deferred');
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const rec = await newRecord(c);
      const id = await queueRow(c, inv);
      await persistStrippedPayLink({ msgId: id, strippedBody: 'x', reason: 'invoice-terminal:paid', invoiceId: inv, serviceRecordId: rec });
      expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBeUndefined();

      await placeHold(c);
      expect(await handOverHeldInvoiceToSender({ invoiceId: inv, serviceRecordId: rec })).toMatchObject({ queued: true });
      expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBe(String(inv));
      expect((await invoice(inv)).status).toBe('scheduled');
    });

    test('a non-hold strip (invoice already terminal) queues nothing', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const id = await queueRow(c, inv);
      await persistStrippedPayLink({ msgId: id, strippedBody: 'Your service is complete.', reason: 'invoice-terminal:paid', invoiceId: inv });
      expect(await invoice(inv)).toMatchObject({ status: 'draft', scheduled_send_at: null });
    });

    // Codex #5424 r13 P1: the pay-link-ONLY branch used to hand the invoice over (queue + marker) in one
    // transaction and terminalize the sms_log row in a SECOND one. blockPayLinkOnlyReplay is ONE transaction.
    describe('the pay-link-only replay hand-over is atomic (blockPayLinkOnlyReplay)', () => {
      const { blockPayLinkOnlyReplay, handOverHeldInvoiceToSender } = require('../services/dispatch-completion-deferred');

      test('one transaction: hand-over + ownership marker + the blocked terminal update all land together', async () => {
        const c = await newCustomer();
        await placeHold(c);
        const inv = await newInvoice(c);
        const rec = await newRecord(c);
        const id = await queueRow(c, inv);
        expect(await blockPayLinkOnlyReplay({
          msgId: id, blockedReason: 'stale_replay:collections-dispute-hold', terminalPending: true, invoiceId: inv, serviceRecordId: rec, handOver: true,
        })).toBe(1);
        expect((await smsRow(id)).status).toBe('blocked');
        expect((await smsRow(id)).metadata).toMatchObject({ blocked_reason: 'stale_replay:collections-dispute-hold', terminal_pending: true });
        expect((await invoice(inv)).status).toBe('scheduled');
        expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBe(String(inv));
      });

      test('a failure in ANY step rolls back ALL of them: the row stays claimed, the invoice unqueued, no marker (crash-between-steps cannot happen)', async () => {
        const c = await newCustomer();
        await placeHold(c);
        const inv = await newInvoice(c);
        const rec = await newRecord(c);
        const id = await queueRow(c, inv);
        // (a) the queue write fails: nothing else may land
        await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_queue3() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
        await db.raw(`CREATE TRIGGER b10_fail_queue3_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.id = '${inv}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_queue3()`);
        try {
          await expect(blockPayLinkOnlyReplay({ msgId: id, blockedReason: 'stale_replay:x', invoiceId: inv, serviceRecordId: rec, handOver: true })).rejects.toThrow(/queue down/);
        } finally {
          await db.raw('DROP TRIGGER IF EXISTS b10_fail_queue3_trg ON invoices');
          await db.raw('DROP FUNCTION IF EXISTS b10_fail_queue3()');
        }
        expect((await smsRow(id)).status).toBe('sending');
        expect((await invoice(inv)).status).toBe('draft');
        expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBeUndefined();
        // (b) the MARKER write fails AFTER the queue write: the queue write and the terminal update roll back too
        await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_marker() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'marker down (synthetic)'; END $$ LANGUAGE plpgsql`);
        await db.raw(`CREATE TRIGGER b10_fail_marker_trg BEFORE UPDATE ON service_records FOR EACH ROW WHEN (OLD.id = '${rec}') EXECUTE FUNCTION b10_fail_marker()`);
        try {
          await expect(blockPayLinkOnlyReplay({ msgId: id, blockedReason: 'stale_replay:x', invoiceId: inv, serviceRecordId: rec, handOver: true })).rejects.toThrow(/marker down/);
        } finally {
          await db.raw('DROP TRIGGER IF EXISTS b10_fail_marker_trg ON service_records');
          await db.raw('DROP FUNCTION IF EXISTS b10_fail_marker()');
        }
        expect((await smsRow(id)).status).toBe('sending');
        expect((await invoice(inv)).status).toBe('draft');
      });

      test('a lost claim hands nothing over', async () => {
        const c = await newCustomer();
        await placeHold(c);
        const inv = await newInvoice(c);
        const rec = await newRecord(c);
        const id = await queueRow(c, inv);
        await db('sms_log').where({ id }).update({ status: 'sent' });
        expect(await blockPayLinkOnlyReplay({ msgId: id, blockedReason: 'stale_replay:x', invoiceId: inv, serviceRecordId: rec, handOver: true })).toBe(0);
        expect((await invoice(inv)).status).toBe('draft');
        expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBeUndefined();
      });

      test('crash AFTER the hand-over committed but BEFORE the row terminalized: the replay consults the ownership marker and goes report-only, even after the release and after the sender delivered', async () => {
        const c = await newCustomer();
        await placeHold(c);
        const inv = await newInvoice(c);
        const rec = await newRecord(c);
        const id = await queueRow(c, inv);
        // the crash window (only reachable when the two writes were separate): hand-over committed, row still 'sending'
        await handOverHeldInvoiceToSender({ invoiceId: inv, serviceRecordId: rec });
        const replay = async () => {
          const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
          const row = await smsRow(id);
          return recheckDeferredReplay('dispatch_completion_deferred', { ...row.metadata, customer_id: row.customer_id, service_record_id: rec });
        };
        // hold still standing: stripped (the ordinary hold reason wins nothing the marker does not already say)
        expect(await replay()).toMatchObject({ eligible: true, stripPayLink: true });
        // the hold is released and the invoice SENDER delivers first: the link-bearing replay must NOT re-send it
        await releaseViaOpsScript(c);
        await makeDueNow(inv);
        await Invoices.processScheduledSends();
        expect(sentIds()).toContain(inv);
        expect((await invoice(inv)).status).toBe('sent');
        expect(await replay()).toEqual({ eligible: true, stripPayLink: true, reason: 'invoice-sender-owns-pay-link' });
        // with no marker the same replay (hold released, invoice 'sent' and still collectible) would have kept the link
        await db('service_records').where({ id: rec }).update({ structured_notes: JSON.stringify({ keep: 'me' }) });
        expect(await replay()).toEqual({ eligible: true });
      });
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

    // Codex #5424 r15 P1: the terminal hand-over writes the queue AND the completion's ownership marker in
    // ONE transaction, so a retried closeout sees the sender owns the pay link and texts no second one.
    const newRecord = async (customerId) => (await db('service_records').insert({
      customer_id: customerId, service_date: '2040-03-04', service_type: 'Pest Control', status: 'completed', structured_notes: JSON.stringify({ keep: 'me' }),
    }).returning('id'))[0].id;
    const recordNotes = async (id) => {
      const n = (await db('service_records').where({ id }).first('structured_notes')).structured_notes;
      return typeof n === 'string' ? JSON.parse(n) : n;
    };

    test('the terminal hand-over also persists invoiceSenderOwnsPayLinkFor on the completion\'s service record (existing notes kept)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const rec = await newRecord(c);
      expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', { ...meta(inv, c), service_record_id: rec })).toMatchObject({ ok: true });
      expect(await invoice(inv)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      expect(await recordNotes(rec)).toMatchObject({ keep: 'me', invoiceSenderOwnsPayLinkFor: String(inv) });
      // idempotent on a sweep retry
      expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', { ...meta(inv, c), service_record_id: rec })).toMatchObject({ ok: true });
      expect(await recordNotes(rec)).toMatchObject({ keep: 'me', invoiceSenderOwnsPayLinkFor: String(inv) });
    });

    test('a failed marker write rolls the queue write back (one transaction), alerts, and a retry lands both', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const rec = await newRecord(c);
      await db.raw(`CREATE OR REPLACE FUNCTION b10_fail_marker4() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'marker down (synthetic)'; END $$ LANGUAGE plpgsql`);
      await db.raw(`CREATE TRIGGER b10_fail_marker4_trg BEFORE UPDATE ON service_records FOR EACH ROW WHEN (OLD.id = '${rec}') EXECUTE FUNCTION b10_fail_marker4()`);
      try {
        expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', { ...meta(inv, c), service_record_id: rec })).toMatchObject({ ok: false });
      } finally {
        await db.raw('DROP TRIGGER IF EXISTS b10_fail_marker4_trg ON service_records');
        await db.raw('DROP FUNCTION IF EXISTS b10_fail_marker4()');
      }
      expect((await invoice(inv)).status).toBe('draft');
      expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBeUndefined();
      expect(await alertsFor(inv)).toHaveLength(1);
      expect(await onTerminalDeferredReplay('autopay_completion_decline_deferred', { ...meta(inv, c), service_record_id: rec })).toMatchObject({ ok: true });
      expect((await invoice(inv)).status).toBe('scheduled');
      expect((await recordNotes(rec)).invoiceSenderOwnsPayLinkFor).toBe(String(inv));
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

  // The structural sweep (owner ruling 2026-09-30): EVERY path that can deliver an
  // invoice pay link later than the original send re-checks the live dispute hold.
  // A hold placed after queueing keeps the leg retryable/deferred (never terminal),
  // and the leg sends after the release.
  describe('delayed pay-link legs: a hold placed after queueing blocks each leg, and it sends after the release', () => {
    const accepted = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1' };
    const sentInvoice = (c) => newInvoice(c, { status: 'sent', sent_at: db.fn.now() });
    const queuedMeta = (inv, c, extra = {}) => ({ entry_point: 'invoice_send_deferred', invoice_id: inv, customer_id: c, ...extra });
    const expectHoldDefer = (outcome) => expect(outcome).toMatchObject({
      blocked: true, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true, deliveryOutcome: 'not_sent',
      nextAllowedAt: expect.any(String),
    });

    test('invoice_send_deferred Text/App legs (the shared locked provider handoff)', async () => {
      const c = await newCustomer();
      const inv = await sentInvoice(c);
      const dispatch = jest.fn(async () => accepted);
      await placeHold(c); // placed after the notice was queued
      expectHoldDefer(await Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c), dispatch));
      expect(dispatch).not.toHaveBeenCalled();
      await releaseViaOpsScript(c);
      await expect(Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c), dispatch)).resolves.toEqual(accepted);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('invoice_send_deferred Email leg (the Email authority check on its held transaction)', async () => {
      const c = await newCustomer();
      const inv = await sentInvoice(c);
      const check = () => db.transaction(async (trx) => {
        await trx('invoices').where({ id: inv }).forUpdate().first('id');
        return Invoices.checkDeferredInvoiceEmailDelivery(queuedMeta(inv, c), { channel: 'email', database: trx });
      });
      await placeHold(c);
      expect(await check()).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true });
      await releaseViaOpsScript(c);
      expect(await check()).toEqual({ ok: true });
    });

    test('a hold lookup that cannot answer defers the same way (fail closed, never terminal)', async () => {
      const c = await newCustomer();
      const inv = await sentInvoice(c);
      const dispatch = jest.fn(async () => accepted);
      const lookup = jest.spyOn(Hold, 'messagingHeldByCollectionHold').mockResolvedValueOnce({ held: true, reason: 'lookup_failed', error: new Error('db down') });
      try { expectHoldDefer(await Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c), dispatch)); } finally { lookup.mockRestore(); }
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('a payer-billed invoice is exempt from the hold check (its own refusal stands, never a hold deferral)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c, { status: 'sent', sent_at: db.fn.now(), payer_id: null });
      await db('invoices').where({ id: inv }).update({ scheduled_send_error: 'payer_billed:7' });
      const dispatch = jest.fn(async () => accepted);
      const out = await Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c), dispatch);
      expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('billing Email provider retry of an invoice notice (billingEmailReplayEligible) waits, then is eligible after the release', async () => {
      const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
      const c = await newCustomer();
      const inv = await sentInvoice(c);
      const meta = { source_entry_point: 'invoice_send_via_sms', invoice_id: inv, customer_id: c, category: 'invoice' };
      await placeHold(c);
      expect(await billingEmailReplayEligible(meta, db)).toMatchObject({ eligible: false, retryable: true, holdDefer: true });
      await releaseViaOpsScript(c);
      expect(await billingEmailReplayEligible(meta, db)).toEqual({ eligible: true });
    });

    test('dunning rails (Day 3-90 ladder, late-payment, balance reminders) consult rail-guard: a hold waits with the gate OFF, and lifts on release', async () => {
      const guard = require('../services/collections/rail-guard');
      const before = process.env.GATE_COLLECTIONS_POLICY;
      delete process.env.GATE_COLLECTIONS_POLICY;
      try {
        const c = await newCustomer();
        const inv = await sentInvoice(c);
        const ask = (detail) => guard.collectionsChannelPermitted({ customerId: c, invoiceId: inv, channel: 'sms', purpose: 'late_payment', detail });
        await placeHold(c);
        expect(await ask(false)).toBe(false);
        expect(await ask(true)).toMatchObject({ allowed: false, durable: false, hold: true });
        expect(await guard.collectionsChannelVerdict({ customerId: c, channel: 'email', purpose: 'balance_reminder' })).toMatchObject({ permitted: false, hold: true });
        await releaseViaOpsScript(c);
        expect(await ask(false)).toBe(true);
        expect(await guard.collectionsChannelVerdict({ customerId: c, channel: 'email', purpose: 'balance_reminder' })).toMatchObject({ permitted: true });
        // a wrong-number fallback hold waits too (it is an all-channel outreach block), exempt or not
        const other = await newCustomer();
        await placeHold(other, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
        expect(await guard.collectionsChannelPermitted({ customerId: other, channel: 'sms', purpose: 'late_payment' })).toBe(false);
        expect(await guard.collectionsChannelPermitted({ customerId: other, channel: 'sms', purpose: 'late_payment', holdExempt: 'operator' })).toBe(false);
      } finally { if (before === undefined) delete process.env.GATE_COLLECTIONS_POLICY; else process.env.GATE_COLLECTIONS_POLICY = before; }
    });

    test('dunning rails: the billing Email replay of a follow-up/late-payment source waits on a hold with the gate off', async () => {
      const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
      const before = process.env.GATE_COLLECTIONS_POLICY;
      delete process.env.GATE_COLLECTIONS_POLICY;
      try {
        const c = await newCustomer();
        const inv = await sentInvoice(c);
        const meta = { source_entry_point: 'invoice_followup_sequence', invoice_id: inv, customer_id: c, category: 'invoice' };
        await placeHold(c);
        expect(await billingEmailReplayEligible(meta, db)).toMatchObject({ eligible: false, retryable: true, holdDefer: true });
      } finally { if (before === undefined) delete process.env.GATE_COLLECTIONS_POLICY; else process.env.GATE_COLLECTIONS_POLICY = before; }
    });

    test('queued reminder/notice texts (invoice_followup_deferred, stripe_webhook_billing_deferred) wait with a named retry time, never terminal', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const c = await newCustomer();
      const inv = await sentInvoice(c);
      const followup = { invoice_id: inv, customer_id: c };
      const ach = { invoice_id: inv, customer_id: c, original_message_type: 'ach_retry_notice' };
      await placeHold(c);
      for (const [entry, meta] of [['invoice_followup_deferred', followup], ['stripe_webhook_billing_deferred', ach]]) {
        const verdict = await recheckDeferredReplay(entry, meta);
        expect(verdict).toMatchObject({ eligible: false, reason: 'collection-hold', retryable: true });
        expect(new Date(verdict.retryAt).getTime()).toBeGreaterThan(Date.now());
      }
      await releaseViaOpsScript(c);
      for (const [entry, meta] of [['invoice_followup_deferred', followup], ['stripe_webhook_billing_deferred', ach]]) {
        expect((await recheckDeferredReplay(entry, meta)).eligible).not.toBe(false);
      }
    });

    describe('a queued invoice notice keeps the trusted exemption its immediate send carried (Codex #5424 r14)', () => {
      const FALLBACK = 'wrong-number report on billing follow-up call; wrong_number flag write failed';

      test('the queued row persists hold_exempt (operator | customer only) - and nothing else', async () => {
        for (const [exempt, expected] of [['customer', 'customer'], ['operator', 'operator'], ['system', undefined], [null, undefined]]) {
          const c = await newCustomer();
          const inv = await sentInvoice(c);
          await Invoices._queuePendingChannelReplay({
            invoiceId: inv, customerId: c, toPhone: '+15551230000', body: 'Synthetic invoice text',
            scheduledFor: new Date(Date.now() + 3600 * 1000), originalBlockCode: 'QUIET_HOURS_HOLD', holdExempt: exempt,
          });
          const row = await db('sms_log').where({ customer_id: c }).first();
          expect(row.metadata.entry_point).toBe('invoice_send_deferred');
          expect(row.metadata.hold_exempt).toBe(expected);
        }
      });

      test('Text/App leg: a customer / operator exemption skips a plain dispute hold; a fallback hold and an unexempted row still wait', async () => {
        const c = await newCustomer();
        const inv = await sentInvoice(c);
        const dispatch = jest.fn(async () => accepted);
        await placeHold(c);
        expectHoldDefer(await Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c), dispatch));
        expect(dispatch).not.toHaveBeenCalled();
        for (const exempt of ['customer', 'operator']) {
          dispatch.mockClear();
          await expect(Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c, { hold_exempt: exempt }), dispatch)).resolves.toEqual(accepted);
          expect(dispatch).toHaveBeenCalledTimes(1);
        }
        dispatch.mockClear();
        expectHoldDefer(await Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(inv, c, { hold_exempt: 'system' }), dispatch));
        const other = await newCustomer();
        const otherInv = await sentInvoice(other);
        await placeHold(other, FALLBACK);
        expectHoldDefer(await Invoices.withDeferredInvoiceProviderHandoff(queuedMeta(otherInv, other, { hold_exempt: 'customer' }), dispatch));
        expect(dispatch).not.toHaveBeenCalled();
      });

      test('Email leg and the billing Email replay eligibility honour it the same way', async () => {
        const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
        const c = await newCustomer();
        const inv = await sentInvoice(c);
        const check = (meta) => db.transaction(async (trx) => {
          await trx('invoices').where({ id: inv }).forUpdate().first('id');
          return Invoices.checkDeferredInvoiceEmailDelivery(meta, { channel: 'email', database: trx });
        });
        await placeHold(c);
        expect(await check(queuedMeta(inv, c))).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER' });
        expect(await check(queuedMeta(inv, c, { hold_exempt: 'customer' }))).toEqual({ ok: true });
        const ctx = { source_entry_point: 'invoice_send_deferred', invoice_id: inv, customer_id: c, category: 'invoice' };
        expect(await billingEmailReplayEligible(ctx, db)).toMatchObject({ eligible: false, holdDefer: true });
        expect(await billingEmailReplayEligible({ ...ctx, hold_exempt: 'customer' }, db)).toEqual({ eligible: true });
        const other = await newCustomer();
        const otherInv = await sentInvoice(other);
        await placeHold(other, FALLBACK);
        expect(await billingEmailReplayEligible({ ...ctx, invoice_id: otherInv, customer_id: other, hold_exempt: 'customer' }, db))
          .toMatchObject({ eligible: false, holdDefer: true });
      });
    });

    describe('EVERY billing.notice replay waits on the messaging hold, whatever source produced it (Codex #5424 r14)', () => {
      const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
      const { etDateString, addETDays } = require('../utils/datetime-et');

      test('autopay pre-charge reminder, both expiry workflows and the previsit reminder: held -> wait (retryable + holdDefer), released -> past the hold gate', async () => {
        const c = await newCustomer();
        const held = await placeHold(c);
        const contexts = [
          { source_entry_point: 'autopay_pre_charge_reminder', customer_id: c, category: 'billing', charge_date: etDateString(addETDays(new Date(), 2)) },
          { source_entry_point: 'autopay_card_expiry_warning', customer_id: c, category: 'billing', payment_method_id: 'pm', expiry_month: '1', expiry_year: '2099' },
          { source_entry_point: 'payment_expiry_workflow', customer_id: c, category: 'billing', payment_method_id: 'pm', expiry_month: '1', expiry_year: '2099' },
          { source_entry_point: 'previsit_balance_reminder', customer_id: c, category: 'billing' },
        ];
        const { replayHoldRefusal } = require('../services/messaging/billing-email-replay-eligibility');
        for (const meta of contexts) {
          // the source's own producer checks run first and may refuse for their own reasons on synthetic
          // rows; the hold gate itself is the same function every source reaches
          expect(await replayHoldRefusal(meta, db)).toMatchObject({ eligible: false, retryable: true, holdDefer: true });
        }
        // previsit: its quote check is stubbed out so the ONLY open question is the hold
        const previsit = require('../services/previsit-balance-reminder');
        const quote = jest.spyOn(previsit, 'previsitReplayQuoteEligible').mockResolvedValue({ ok: true });
        try {
          expect(await billingEmailReplayEligible(contexts[3], db)).toMatchObject({ eligible: false, retryable: true, holdDefer: true });
          await db('collections_flags').where({ id: held }).update({ resolved_at: new Date() }).catch(() => null);
          await releaseViaOpsScript(c);
          expect(await billingEmailReplayEligible(contexts[3], db)).toEqual({ eligible: true });
        } finally { quote.mockRestore(); }
        for (const meta of contexts) expect(await replayHoldRefusal(meta, db)).toBeNull();
      });

      test('a payment receipt (no pay link) and a payer-billed invoice are exempt; a trusted hold_exempt skips a plain dispute hold only', async () => {
        const { replayHoldRefusal } = require('../services/messaging/billing-email-replay-eligibility');
        const c = await newCustomer();
        await placeHold(c);
        expect(await replayHoldRefusal({ customer_id: c, category: 'payment_receipt', source_entry_point: 'autopay_pre_charge_reminder' }, db)).toBeNull();
        expect(await replayHoldRefusal({ customer_id: c, category: 'payment_issue' }, db)).toMatchObject({ holdDefer: true });
        expect(await replayHoldRefusal({ customer_id: c, category: 'payment_issue', hold_exempt: 'customer' }, db)).toBeNull();
        const [p] = await db('payers').insert({ display_name: 'Synthetic Bill-To', ap_email: 'ap@example.invalid' }).returning('id');
        packetFixtures.payers.push(p.id);
        const payerInv = await newInvoice(c, { status: 'sent', sent_at: db.fn.now(), payer_id: p.id });
        expect(await replayHoldRefusal({ customer_id: c, category: 'invoice', invoice_id: payerInv }, db)).toBeNull();
        const other = await newCustomer();
        await placeHold(other, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
        expect(await replayHoldRefusal({ customer_id: other, category: 'payment_issue', hold_exempt: 'operator' }, db)).toMatchObject({ holdDefer: true });
      });

      test('a lookup that cannot answer holds the stored notice too (fail closed)', async () => {
        const { replayHoldRefusal } = require('../services/messaging/billing-email-replay-eligibility');
        const c = await newCustomer();
        const lookup = jest.spyOn(Hold, 'messagingHeldByCollectionHold').mockResolvedValueOnce({ held: true, reason: 'lookup_failed', error: new Error('db down') });
        try { expect(await replayHoldRefusal({ customer_id: c, category: 'payment_issue' }, db)).toMatchObject({ holdDefer: true, retryable: true }); } finally { lookup.mockRestore(); }
      });
    });

    test('the payment-retry notice replay (billing_retry_email_deferred) waits while the hold stands', async () => {
      const { replayPaymentRetryNotice } = require('../services/billing-retry-email-obligation');
      const c = await newCustomer();
      const [{ id: paymentId }] = await db('payments').insert({
        customer_id: c, amount: 100, status: 'failed', payment_date: new Date(), next_retry_at: new Date(Date.now() + 86400000), retry_count: 0, description: 'synthetic',
      }).returning('id');
      try {
        await placeHold(c);
        const { etDateString } = require('../utils/datetime-et');
        const out = await replayPaymentRetryNotice({ customer_id: c, payment_id: paymentId, retry_date: etDateString(new Date(Date.now() + 86400000)) });
        expect(out).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true });
      } finally { await db('payments').where({ id: paymentId }).del(); }
    });
  });
});
