/**
 * The ONE shared send claim, driven against a migrated database (Codex round
 * 16 P1 ×2 #4131).
 *
 *  1. Every collectible invoice is delivered under claimInvoiceForSend —
 *     including one the completion minted ITSELF. The mint commits before
 *     sendCustomerMessage runs, so an admin "send now" can claim and deliver
 *     the fresh draft in that gap; the completion must then go report-only
 *     instead of texting the same pay link a second time, and must never
 *     touch the admin's claim.
 *  2. A preclaimed row (processScheduledSends flips 'scheduled' → 'sending'
 *     itself, then sends with allowClaimed) keeps its claim token
 *     (updated_at) through a nested pre-claimed refusal: a transient throw
 *     from the queued-pay-link lookup must not re-stamp the row, or the
 *     scheduler's own token-matched restore finds nothing and the invoice is
 *     stranded under 'sending' until stale recovery parks it for manual
 *     review — the send is retried, never parked.
 */
jest.mock('../models/db', () => {
  const db = (table, ...args) => {
    if (table === 'sms_log' && mockFault.smsLogOnce) {
      mockFault.smsLogOnce = false;
      // Rejects a few ms later, not synchronously: the claim token is a
      // millisecond timestamp, so a same-instant re-stamp would be
      // indistinguishable from the original and hide the very bug under
      // test.
      const failing = {
        whereRaw() { return failing; },
        first: () => new Promise((_, reject) => setTimeout(() => reject(new Error('transient sms_log lookup failure (injected)')), 5)),
      };
      return failing;
    }
    // Fires once, on the SECOND scheduled_services lookup in a
    // sendViaSMSAndEmail flow — the nested this.sendViaSMS(allowClaimed:true)
    // call's own visitInvoiceRefusalUnderClaim recheck (pre-push P1 #4131,
    // finding 1 follow-on). The outer claim's own recheck (the FIRST lookup)
    // must succeed normally so the claim is taken before this fires.
    if (table === 'scheduled_services' && mockFault.scheduledServicesLookupOnce) {
      mockFault.scheduledServicesLookupOnce = false;
      const failing = {
        where() { return failing; },
        first: () => new Promise((_, reject) => setTimeout(() => reject(new Error('transient scheduled_services lookup failure (injected)')), 5)),
      };
      return failing;
    }
    return mockPg(table, ...args);
  };
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({
  // Real savedCardChargeSuppressesAlternateCollection/NeedsReconciliation
  // (pure classifiers complete-scheduled-service.js calls on the mocked
  // charge's rejection) — round-17 finding-3 fixture needs the real decline
  // classification; only the network-calling charge itself is mocked.
  ...jest.requireActual('../services/stripe'),
  chargeInvoiceWithSavedCard: jest.fn(),
}));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/invoice-email', () => ({ sendInvoiceEmail: jest.fn(async () => ({ ok: false, error: 'email disabled in test' })) }));
jest.mock('../services/review-request', () => {
  const actual = jest.requireActual('../services/review-request');
  return { ...actual, enrollPostService: jest.fn(async () => null) };
});
jest.mock('../services/completion-recap', () => {
  const actual = jest.requireActual('../services/completion-recap');
  return { ...actual, generateRecap: jest.fn(async () => null) };
});
// Race injection for the completion: the pay-URL shortener is the first
// call the completion makes with the freshly minted invoice's id AFTER the
// mint committed and BEFORE the delivery lane — exactly the gap an admin
// send can land in.
const mockRace = { afterMint: null };
jest.mock('../services/short-url', () => {
  const actual = jest.requireActual('../services/short-url');
  return {
    ...actual,
    shortenOrPassthrough: async (url, opts = {}) => {
      if (mockRace.afterMint && opts.kind === 'invoice' && opts.entityType === 'invoices') {
        const hook = mockRace.afterMint; mockRace.afterMint = null; await hook(opts.entityId);
      }
      return url;
    },
  };
});

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const mockFault = { smsLogOnce: false, scheduledServicesLookupOnce: false };
let database;
let mockPg; // the per-test transaction while a test runs; the pool between tests
jest.setTimeout(90000);

postgres('the shared send claim on a migrated database', () => {
  let f;
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    mockPg = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockFault.smsLogOnce = false;
    mockFault.scheduledServicesLookupOnce = false;
    mockRace.afterMint = null;
    sendCustomerMessage.mockImplementation(async () => ({ sent: true, channel: 'sms', providerMessageId: `SM${randomUUID().slice(0, 8)}` }));
    mockPg = await database.transaction();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  const readInvoice = (id) => mockPg('invoices').where({ id }).first();

  // A confirmed pest visit dated yesterday with NO invoice yet: the
  // completion mints one itself (create_invoice_on_complete).
  async function visitFixture() {
    f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), key: `fixture_${randomUUID().slice(0, 8)}` };
    const serviceType = 'Fixture Quarterly Pest Control Service';
    const day = etDateString(addETDays(new Date(), -1));
    await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Claim', phone: '+12025550123',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
    await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
    await mockPg('services').insert({ id: f.catalogId, name: serviceType, service_key: f.key, category: 'pest_control', is_active: true });
    await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
      service_type: serviceType, scheduled_date: day, window_start: '09:00', window_end: '10:00', status: 'confirmed',
      estimated_price: 117, estimated_duration_minutes: 60, create_invoice_on_complete: true });
    return f;
  }

  // The same visit, on Auto Pay with a chargeable saved card — the charge
  // attempted at completion is mocked to DECLINE, arming paymentFailedSmsContext
  // and this visit's payment_failed decline notice (round-17 #4131 finding 3).
  async function autopayDeclineVisitFixture() {
    await visitFixture();
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: f.customerId, processor: 'stripe',
      method_type: 'card', stripe_payment_method_id: 'pm_fixture_decline', is_default: true, autopay_enabled: true,
      exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: f.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    const declineErr = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError', code: 'card_declined', decline_code: 'generic_decline',
      wavesCardDecline: { attemptedAmount: 117, cardBrand: 'visa', cardLast4: '4242', declineCode: 'generic_decline' },
    });
    chargeInvoiceWithSavedCard.mockRejectedValue(declineErr);
    return f;
  }

  function complete() {
    return completeScheduledService({
      serviceId: f.serviceId,
      idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', sendCompletionSms: true, requestReview: false, products: [], areasTreated: [],
        customerRecap: 'The scheduled service was completed.', idempotencyKey: randomUUID() },
      actor: { techRole: 'technician', technicianId: f.techId, technician: { id: f.techId, name: 'Fixture Technician' } },
    });
  }

  const payLinkTexts = () => sendCustomerMessage.mock.calls.filter(([input]) => /\/pay\//.test(String(input?.body || input?.message || '')));

  describe('the completion claims the invoice it minted itself (round 16 P1)', () => {
    test('control: with nobody racing, the completion claims its own fresh draft, texts ONE pay link and finalizes it sent', async () => {
      await visitFixture();
      const result = await complete();
      expect(result.status).toBe(200);
      const [invoice] = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoice).toBeTruthy();
      expect(payLinkTexts()).toHaveLength(1);
      expect(invoice.status).toBe('sent');
      expect(invoice.sms_sent_at).not.toBeNull();
    });

    test('an admin send that claims the fresh draft between the mint commit and the completion delivery owns it: the completion goes report-only, texts no second pay link, and leaves the admin claim untouched', async () => {
      await visitFixture();
      let adminClaim = null;
      mockRace.afterMint = async (invoiceId) => {
        // The admin "send now" claims the row the mint just committed…
        adminClaim = await InvoiceService.claimInvoiceForSend(invoiceId, { operatorInitiated: true });
        expect(adminClaim).toMatchObject({ previousStatus: 'draft', claimed: true });
        expect((await readInvoice(invoiceId)).status).toBe('sending');
      };

      const result = await complete();
      expect(adminClaim).not.toBeNull();
      // The completion's own claim lost, so its text carries no pay link —
      // and it is NOT the resumable 503: a live send holding the claim is
      // "delivery owned elsewhere" only once it delivers, so the completion
      // keeps a retryable obligation. Either outcome is acceptable to the
      // customer; what is NOT acceptable is a second pay-link text.
      expect(payLinkTexts()).toHaveLength(0);
      expect([200, 503]).toContain(result.status);

      // The admin's claim is intact — still 'sending', never restored to
      // draft by the completion's release (its claim was refused, so it
      // holds nothing to give back) and never finalized to sent by it.
      const invoice = await readInvoice(adminClaim.invoice.id);
      expect(invoice.status).toBe('sending');
      expect(invoice.sent_at).toBeNull();
      expect(invoice.sms_sent_at).toBeNull();
      // …and the admin send finishes its delivery exactly once.
      await InvoiceService.markDeliverySent(adminClaim.invoice.id, { sms: true, source: 'admin_send_now' });
      expect((await readInvoice(adminClaim.invoice.id)).status).toBe('sent');
    });
  });

  describe('a preclaimed scheduled send keeps its claim token through a nested pre-claimed refusal (round 16 P1)', () => {
    async function scheduledInvoice() {
      f = { customerId: randomUUID(), invoiceId: randomUUID() };
      await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Scheduled', phone: '+12025550124',
        email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
      await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, invoice_number: `TST-${f.invoiceId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''), status: 'scheduled', total: 117, subtotal: 117,
        scheduled_send_at: new Date(Date.now() - 60 * 1000), scheduled_send_attempts: 0,
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]) });
      return f;
    }

    test('a transient throw from the queued-pay-link lookup under allowClaimed: the row returns to scheduled with its due time kept (retried), not stranded under sending', async () => {
      await scheduledInvoice();
      // The first sms_log lookup after the scheduler's own claim is the
      // pre-claimed branch's queued-obligation check — make it throw once.
      mockFault.smsLogOnce = true;

      const summary = await InvoiceService.processScheduledSends({ limit: 5 });
      expect(mockFault.smsLogOnce).toBe(false); // the fault fired
      expect(summary).toMatchObject({ sent: 0, failed: 1 });

      const invoice = await readInvoice(f.invoiceId);
      // The scheduler's token-matched restore found its own row: the
      // invoice is back to 'scheduled', still due, one attempt consumed,
      // the failure recorded — NOT left under 'sending' for the 10-minute
      // stale sweep to park with scheduled_send_at cleared.
      expect(invoice.status).toBe('scheduled');
      expect(invoice.scheduled_send_at).not.toBeNull();
      expect(invoice.scheduled_send_attempts).toBe(1);
      expect(invoice.scheduled_send_error).toMatch(/transient sms_log lookup failure/);
      expect(invoice.scheduled_send_error).not.toMatch(/Recovered from stale sending claim/);
      expect(sendCustomerMessage).not.toHaveBeenCalled();

      // The next pass, with the lookup healthy, delivers it.
      const again = await InvoiceService.processScheduledSends({ limit: 5 });
      expect(again).toMatchObject({ sent: 1 });
      expect((await readInvoice(f.invoiceId)).status).toBe('sent');
      expect(payLinkTexts()).toHaveLength(1);
    });

    test('restoreSendClaim never writes the invoice row for a previousStatus of sending — the preclaimer owns that token', async () => {
      await scheduledInvoice();
      const [claimed] = await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'sending', updated_at: new Date() }).returning(['id', 'updated_at']);
      await new Promise((resolve) => setTimeout(resolve, 5)); // a re-stamp must land on a later millisecond to be visible
      await InvoiceService.restoreSendClaim(f.invoiceId, 'sending', true);
      const after = await readInvoice(f.invoiceId);
      expect(after.status).toBe('sending');
      expect(new Date(after.updated_at).getTime()).toBe(new Date(claimed.updated_at).getTime());
      // A real previous status still restores exactly as before.
      await InvoiceService.restoreSendClaim(f.invoiceId, 'scheduled', true);
      expect((await readInvoice(f.invoiceId)).status).toBe('scheduled');
    });
  });

  describe('a preclaimed scheduled send re-checks the visit billing guards too (pre-push Codex P1 #4131, this round)', () => {
    async function scheduledZeroDueVisitInvoice() {
      f = { customerId: randomUUID(), visitId: randomUUID(), invoiceId: randomUUID() };
      await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'ZeroDue', phone: '+12025550127',
        email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
      await mockPg('scheduled_services').insert({ id: f.visitId, customer_id: f.customerId,
        service_type: 'Fixture Quarterly Pest Control Service', scheduled_date: etDateString(), status: 'confirmed' });
      await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.visitId,
        invoice_number: `TST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'scheduled',
        total: 0, subtotal: 0, credit_applied: 0,
        scheduled_send_at: new Date(Date.now() - 60 * 1000), scheduled_send_attempts: 0,
        line_items: JSON.stringify([]) });
      return f;
    }

    test('a visit-linked invoice retotalled to $0 before its scheduled send tick: no pay link, no follow-ups armed, and the scheduler keeps its own claim/token handling', async () => {
      await scheduledZeroDueVisitInvoice();

      const summary = await InvoiceService.processScheduledSends({ limit: 5 });
      expect(summary).toMatchObject({ sent: 0, failed: 1 });
      // THE bug: without the fix, processScheduledSends' own preclaim
      // ('scheduled' -> 'sending') makes both the pre-check in
      // sendViaSMSAndEmail (zeroDueOpenVisitSendOutcome) and claimInvoiceForSend's
      // allowClaimed branch skip the zero-due guard (SEND_CLAIMABLE_STATUSES
      // excludes 'sending'), and a live $0 pay-link text goes out.
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(payLinkTexts()).toHaveLength(0);

      const invoice = await readInvoice(f.invoiceId);
      // The scheduler's own token-matched restore recovered its row exactly
      // like any other pre-delivery refusal in the allowClaimed branch —
      // back to 'scheduled', still due, one attempt consumed — never
      // stranded under 'sending' for the 10-minute stale sweep to park, and
      // never silently re-armed either.
      expect(invoice.status).toBe('scheduled');
      expect(invoice.scheduled_send_at).not.toBeNull();
      expect(invoice.scheduled_send_attempts).toBe(1);
      expect(invoice.scheduled_send_error).toMatch(/not sent/i);
      expect(invoice.sent_at).toBeNull();
      expect(invoice.sms_sent_at).toBeNull();
    });

    test('control: a visit-linked invoice with a real balance due still sends normally through the same preclaimed path', async () => {
      await scheduledZeroDueVisitInvoice();
      await mockPg('invoices').where({ id: f.invoiceId }).update({ total: 117, subtotal: 117 });

      const summary = await InvoiceService.processScheduledSends({ limit: 5 });
      expect(summary).toMatchObject({ sent: 1 });
      expect(payLinkTexts()).toHaveLength(1);
      expect((await readInvoice(f.invoiceId)).status).toBe('sent');
    });
  });

  describe('the autopay decline notice acquires the shared claim too (round-17 P1 #4131 finding 3)', () => {
    test('control: with nobody racing, the decline notice claims the invoice, texts the pay link, and finalizes it sent — the later completion-SMS block goes report-only', async () => {
      await autopayDeclineVisitFixture();
      const result = await complete();
      expect(result.status).toBe(200);
      const [invoice] = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoice).toBeTruthy();
      // Exactly ONE pay-link text — the decline notice's — even though the
      // completion-SMS block runs right after it in the same request.
      expect(payLinkTexts()).toHaveLength(1);
      expect(String(payLinkTexts()[0][0].purpose)).toBe('payment_failure');
      expect(invoice.status).toBe('sent');
      expect(invoice.sms_sent_at).not.toBeNull();
    });

    test('an admin send that claims the invoice between the mint and the decline notice owns it: the decline notice is skipped (no pay link, no notes stamp), the completion-SMS block also goes report-only, and the admin claim is untouched', async () => {
      await autopayDeclineVisitFixture();
      let adminClaim = null;
      // shortenOrPassthrough for this invoice fires once, right after the
      // mint, well before the autopay charge attempt (and therefore well
      // before the decline notice) — the admin claims it in that gap.
      mockRace.afterMint = async (invoiceId) => {
        adminClaim = await InvoiceService.claimInvoiceForSend(invoiceId, { operatorInitiated: true });
        expect(adminClaim).toMatchObject({ previousStatus: 'draft', claimed: true });
        expect((await readInvoice(invoiceId)).status).toBe('sending');
      };

      const result = await complete();
      expect(adminClaim).not.toBeNull();
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalled(); // the decline still happens — claiming doesn't block the charge attempt
      // Neither the decline notice nor the completion-SMS block could
      // acquire the claim the admin is holding — the whole completion
      // texts NO pay link at all, from either sender.
      expect(payLinkTexts()).toHaveLength(0);
      expect([200, 503]).toContain(result.status);

      // The admin's claim is untouched — still 'sending', never restored
      // to draft and never finalized to sent by either sender that lost
      // the race for it.
      const invoice = await readInvoice(adminClaim.invoice.id);
      expect(invoice.status).toBe('sending');
      expect(invoice.sent_at).toBeNull();
      expect(invoice.sms_sent_at).toBeNull();
      // …and the admin send finishes its delivery exactly once.
      await InvoiceService.markDeliverySent(adminClaim.invoice.id, { sms: true, source: 'admin_send_now' });
      expect((await readInvoice(adminClaim.invoice.id)).status).toBe('sent');
    });

    // Round-20 P1 (#4131, second claim-mode bug — same shape as the payer AP
    // email two rounds ago): the decline claim used to call
    // claimInvoiceForSend with NO mode at all. Default mode treats
    // 'sent'/'viewed'/'overdue' as claimable (the deliberate resend
    // allowance every genuine resend caller needs), so an office Immediate
    // send that finalizes to 'sent' between the mint and the decline
    // notice's own claim attempt would still be granted here as an
    // "intentional resend" and text the SAME pay link a second time.
    // firstDeliveryOnly closes that gap.
    test('an office send that finalizes the invoice to sent BEFORE the decline notice claims it: the decline notice is skipped, not treated as a resend — exactly ONE pay-link text goes out, from the office send', async () => {
      await autopayDeclineVisitFixture();
      let officeSendResult = null;
      // shortenOrPassthrough for this invoice fires once, right after the
      // mint, well before the autopay charge attempt (and therefore well
      // before the decline notice) — the office send completes end-to-end
      // in that gap, exactly like a real Immediate send racing the
      // completion.
      mockRace.afterMint = async (invoiceId) => {
        officeSendResult = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
        expect(officeSendResult.sent).toBe(true);
        const delivered = await readInvoice(invoiceId);
        expect(delivered.status).toBe('sent');
        expect(delivered.sms_sent_at).not.toBeNull();
      };

      const result = await complete();
      expect(officeSendResult).not.toBeNull();
      expect([200, 503]).toContain(result.status);
      // THE bug: without firstDeliveryOnly, the decline claim's default mode
      // reads the now-'sent' row as a resendable claim and texts the pay
      // link again — payLinkTexts() would be 2 (office send + decline
      // notice). The fix refuses the decline claim outright
      // (already_delivered) and skips the notice for this attempt.
      expect(payLinkTexts()).toHaveLength(1);
      expect(String(payLinkTexts()[0][0].purpose)).not.toBe('payment_failure');

      const [invoice] = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoice.status).toBe('sent');
      // The decline notice never marked itself sent — it was skipped, not
      // delivered.
      const [record] = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
      expect(record?.structured_notes?.paymentFailedNoticeStatus).not.toBe('sent');
    });

    test('the provider ACCEPTS the decline notice but the post-send audit-row write then throws (providerOutcome.sent === true): recorded delivered — the invoice finalizes sent, not restored to draft (pre-push Codex P1 #4131, third instance of the send-then-bookkeeping-throw shape)', async () => {
      await autopayDeclineVisitFixture();
      sendCustomerMessage.mockImplementation(async (input) => {
        if (input.purpose === 'payment_failure') {
          const err = new Error('audit row insert failed (injected)');
          err.providerOutcome = { sent: true, providerMessageId: `SM${randomUUID().slice(0, 8)}` };
          throw err;
        }
        return { sent: true, channel: 'sms', providerMessageId: `SM${randomUUID().slice(0, 8)}` };
      });

      const result = await complete();
      expect([200, 503]).toContain(result.status);
      const [invoice] = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoice).toBeTruthy();
      // Exactly ONE call carried the pay link — the decline notice's, which
      // THREW but was still accepted by the provider. Not erased, not
      // restored to draft: the claim finalizes sent, same as the control.
      expect(payLinkTexts()).toHaveLength(1);
      expect(String(payLinkTexts()[0][0].purpose)).toBe('payment_failure');
      expect(invoice.status).toBe('sent');
      expect(invoice.sms_sent_at).not.toBeNull();

      const [record] = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
      expect(record?.structured_notes?.paymentFailedNoticeStatus).toBe('sent');
      expect(record?.structured_notes?.paymentFailedNoticeAuditError).toMatch(/audit row insert failed/);
    });
  });

  describe('a PARTIAL cash/Zelle prepayment against a visit with an already-linked draft (round-19 P1 #4131 finding 1, partial-payment follow-on)', () => {
    // The office's open-visit picker (admin-invoices.js) already linked a
    // full-balance draft to this visit BEFORE any prepayment was recorded —
    // exactly the round-17 mint-vs-stamp ordering, just with a partial
    // amount this time.
    async function linkedDraftVisitFixture() {
      f = { customerId: randomUUID(), techId: randomUUID(), serviceId: randomUUID(), invoiceId: randomUUID() };
      await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Partial', phone: '+12025550125',
        email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
      await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
      await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId,
        service_type: 'Fixture Quarterly Pest Control Service', scheduled_date: etDateString(), window_start: '09:00',
        window_end: '10:00', status: 'confirmed', estimated_price: 117 });
      await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
        invoice_number: `TST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
        total: 117, subtotal: 117, credit_applied: 0,
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]) });
      return f;
    }

    test('recording a partial prepay against the linked draft, then attempting an Immediate send: the customer is not asked for the full (or any) balance — the send is refused until the reconciler settles a top-up or the visit completes', async () => {
      await linkedDraftVisitFixture();
      // The office's POST /:id/prepaid write itself: a direct
      // scheduled_services.prepaid_amount stamp, no row lock of its own.
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 50, prepaid_method: 'cash', prepaid_note: null, prepaid_at: new Date(),
      });
      // The route's own reconciler runs right after the stamp in the same
      // request. For a PARTIAL amount it deliberately leaves the invoice
      // untouched (never writes a partial payment row — a later top-up to
      // the full amount must apply cleanly against the ORIGINAL total).
      const { reconcileExistingLinkedInvoiceOnPrepaidStamp } = require('../routes/admin-schedule')._test;
      await reconcileExistingLinkedInvoiceOnPrepaidStamp(f.serviceId, { skip: false, actorTechnicianId: f.techId, actorRole: 'technician' });
      expect((await readInvoice(f.invoiceId))).toMatchObject({ status: 'draft', total: '117.00' });

      // An office Immediate send now must NOT collect the full $117 on top
      // of the $50 already taken — nor any stale amount at all: refuse the
      // claim outright until the cash is reconciled with this invoice.
      await expect(InvoiceService.claimInvoiceForSend(f.invoiceId, { operatorInitiated: true }))
        .rejects.toMatchObject({ code: 'visit_prepaid_covered', message: expect.stringMatching(/Invoice is not sendable/) });

      // Nothing was texted, and the invoice sits exactly where it started
      // — no claim left dangling under 'sending'.
      expect(payLinkTexts()).toHaveLength(0);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await readInvoice(f.invoiceId)).status).toBe('draft');
    });

    test('once the office tops the prepayment up to the FULL amount, the reconciler finalizes the invoice paid and the send-claim guard is moot — no pay link, no over-collection', async () => {
      await linkedDraftVisitFixture();
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 117, prepaid_method: 'cash', prepaid_note: null, prepaid_at: new Date(),
      });
      const { reconcileExistingLinkedInvoiceOnPrepaidStamp } = require('../routes/admin-schedule')._test;
      await reconcileExistingLinkedInvoiceOnPrepaidStamp(f.serviceId, { skip: false, actorTechnicianId: f.techId, actorRole: 'technician' });
      const invoice = await readInvoice(f.invoiceId);
      expect(invoice.status).toBe('paid');
      expect(invoice.payment_method).toBe('cash');
      // Paid is no longer send-claimable at all — no pay link ever goes out.
      await expect(InvoiceService.claimInvoiceForSend(f.invoiceId, { operatorInitiated: true })).rejects.toThrow(/paid/i);
      expect(payLinkTexts()).toHaveLength(0);
    });
  });

  describe('the payer AP invoice email records delivery before markDeliverySent (pre-push Codex P1 #4131 — third instance of the send-then-bookkeeping-throw shape)', () => {
    async function payerVisitFixture() {
      await visitFixture();
      const [payerId] = await mockPg('payers').insert({
        display_name: 'Fixture GC', company_name: 'Fixture GC LLC',
        ap_email: 'ap@fixture-gc.example.invalid', active: true,
      }).returning('id').then((r) => r.map((x) => x.id ?? x));
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({ payer_id: payerId });
      f.payerId = payerId;
      return f;
    }

    test('sendInvoiceEmail succeeds, then markDeliverySent throws: the invoice is NOT restored to a state that permits another first delivery, and a following attempt does not email the payer again', async () => {
      await payerVisitFixture();
      const { sendInvoiceEmail } = require('../services/invoice-email');
      sendInvoiceEmail.mockResolvedValueOnce({ ok: true, recipient: { email: 'ap@fixture-gc.example.invalid' } });
      const markDeliverySentSpy = jest.spyOn(InvoiceService, 'markDeliverySent')
        .mockRejectedValueOnce(new Error('injected finalize failure'));

      const result = await complete();
      expect([200, 503]).toContain(result.status);
      expect(sendInvoiceEmail).toHaveBeenCalledTimes(1);

      const minted = await mockPg('invoices').where({ customer_id: f.customerId }).first();
      expect(minted).toBeTruthy();
      expect(minted.payer_id).toBe(f.payerId);
      // NOT restored to draft (or any other claimable status) — the accepted
      // send stays parked under its 'sending' claim for operator review,
      // exactly like the completion SMS's own accepted-but-unaudited path.
      expect(minted.status).toBe('sending');

      markDeliverySentSpy.mockRestore();

      // A following first-delivery attempt on this same invoice (a resumed
      // completion, or the Invoices-page immediate send) must be refused —
      // never a second AP email, whether refused for still being claimed or
      // for already carrying first-delivery evidence.
      await expect(InvoiceService.claimInvoiceForSend(minted.id, { firstDeliveryOnly: true })).rejects.toThrow();
      expect(sendInvoiceEmail).toHaveBeenCalledTimes(1);
      expect((await readInvoice(minted.id)).status).toBe('sending');
    });
  });

  describe('sendViaSMSAndEmail treats an invoice-WIDE under-claim refusal as a whole-send refusal — email must not run (pre-push P1 #4131, this round)', () => {
    // sendViaSMSAndEmail's own claim succeeds (draft -> sending) BEFORE this
    // fixture's race fires, exactly like the office's Immediate send: the
    // customer's visit is cancelled in the ONE real await between that
    // claim and the inner sendViaSMS call — autoApplyAccountCreditIfEnabled.
    async function draftInvoiceFixture() {
      await visitFixture();
      f.invoiceId = randomUUID();
      await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
        invoice_number: `TST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
        total: 117, subtotal: 117, credit_applied: 0,
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]) });
      return f;
    }

    test('a visit cancelled in the gap refuses the SMS leg as visit_cancelled, skips the email leg entirely, and restores the claim — WITHOUT the fix, sendInvoiceEmail (which never checks visit status) still fires and finalizes the invoice sent', async () => {
      await draftInvoiceFixture();
      const { sendInvoiceEmail } = require('../services/invoice-email');
      sendInvoiceEmail.mockClear();
      const CustomerCredit = require('../services/customer-credit');
      const applySpy = jest.spyOn(CustomerCredit, 'autoApplyAccountCreditIfEnabled').mockImplementationOnce(async () => {
        // The race: a prepayment/cancellation landing after THIS wrapper's
        // own claim, before the inner sendViaSMS call's under-claim recheck.
        await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'cancelled' });
        return { applied: 0, fullyCovered: false };
      });
      try {
        const result = await InvoiceService.sendViaSMSAndEmail(f.invoiceId);
        expect(result.ok).toBe(false);
        expect(result.sms).toMatchObject({ ok: false, code: 'visit_cancelled', invoiceWideRefusal: true });
        expect(result.email.ok).toBe(false);
        // THE bug: without the fix, nothing here distinguishes "the whole
        // invoice is refused" from "only SMS failed" — the email leg below
        // runs anyway, and sendInvoiceEmail has no visit-status guard of its
        // own, so it delivers a full invoice email for a visit that never
        // ran (and would finalize the row 'sent' in the process).
        expect(sendInvoiceEmail).not.toHaveBeenCalled();
        const invoice = await readInvoice(f.invoiceId);
        // The claim is restored, not finalized on the email leg — still
        // exactly where it started.
        expect(invoice.status).toBe('draft');
        expect(invoice.sent_at).toBeNull();
        expect(invoice.sms_sent_at).toBeNull();
      } finally {
        applySpy.mockRestore();
      }
    });

    test('the nested coverage-lookup THROWS (not a found refusal) under the inner allowClaimed recheck: both channels are skipped and the claim is restored — WITHOUT the fix this reads as an ordinary SMS failure and the email leg still fires (pre-push P1 #4131, this round, finding 1 follow-on)', async () => {
      await draftInvoiceFixture();
      const { sendInvoiceEmail } = require('../services/invoice-email');
      sendInvoiceEmail.mockClear();
      const CustomerCredit = require('../services/customer-credit');
      const applySpy = jest.spyOn(CustomerCredit, 'autoApplyAccountCreditIfEnabled').mockImplementationOnce(async () => {
        // The race: the outer claim's own under-claim recheck (the FIRST
        // scheduled_services lookup, inside reverifyClaimedVisitInvoice)
        // already ran and found nothing wrong. Arm the fault so the NEXT
        // scheduled_services lookup — the nested this.sendViaSMS's own
        // allowClaimed recheck — throws instead of returning a status. This
        // is deliberately NOT a found refusal (visit cancelled, prepaid,
        // etc.) — it is the check itself failing to complete, which tells
        // us nothing about whether the customer owes money.
        mockFault.scheduledServicesLookupOnce = true;
        return { applied: 0, fullyCovered: false };
      });
      try {
        const result = await InvoiceService.sendViaSMSAndEmail(f.invoiceId);
        expect(result.ok).toBe(false);
        expect(result.sms).toMatchObject({ ok: false, invoiceWideRefusal: true });
        expect(result.sms.error).toMatch(/transient scheduled_services lookup failure/);
        expect(result.email.ok).toBe(false);
        // THE bug: without the fix, the lookup failure is marked only
        // deliveryNeverAttempted (not invoiceWideRefusal), so
        // sendViaSMSAndEmail's catch reads it as an ordinary channel-specific
        // SMS failure and falls through to the email leg — which has no
        // equivalent visit-prepayment/coverage check of its own — instead of
        // failing the whole send closed.
        expect(sendInvoiceEmail).not.toHaveBeenCalled();
        const invoice = await readInvoice(f.invoiceId);
        // The claim is restored, not finalized on the email leg — still
        // exactly where it started.
        expect(invoice.status).toBe('draft');
        expect(invoice.sent_at).toBeNull();
        expect(invoice.sms_sent_at).toBeNull();
      } finally {
        applySpy.mockRestore();
      }
    });
  });

  describe('the completion delivery claim treats an email-delivered draft as already delivered (pre-push P1 #4131, this round — mechanism diff)', () => {
    // completionInvoiceAlreadyDelivered (invoice-helpers.js) reads ONLY
    // sent_at + status IN ('sent','paid','prepaid') — it has no idea
    // email_sent_at exists. The completion's OWN claim.invoice, checked
    // against that helper, is furthermore always status='sending' the
    // instant a plain claimInvoiceForSend succeeds (the UPDATE that
    // returned it just set that), so the status half of that helper could
    // never fire there either way — sent_at was the only thing that check
    // ever actually caught. firstDeliveryOnly's alreadyDeliveredForFirstSend
    // checks sent_at OR email_sent_at OR status IN
    // ('sent','viewed','overdue','paid','prepaid'), evaluated on the PRE-flip
    // row — a strict superset, and it fires before any claim is taken at all.
    async function preDeliveredLinkedDraftFixture() {
      await visitFixture();
      f.invoiceId = randomUUID();
      await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
        invoice_number: `TST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
        total: 117, subtotal: 117, credit_applied: 0, email_sent_at: new Date(),
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]) });
      return f;
    }

    test('a linked draft carrying ONLY email_sent_at (status still draft, sent_at still null) is not re-delivered by the completion — no second pay-link text, and the pre-existing invoice is left exactly as it was, never claimed', async () => {
      await preDeliveredLinkedDraftFixture();
      const result = await complete();
      expect(result.status).toBe(200);
      // THE bug: without the fix, the plain claim (draft -> sending)
      // succeeds — nothing about this invoice looks unsendable to
      // SEND_CLAIMABLE_STATUSES — and completionInvoiceAlreadyDelivered on
      // the now-'sending' claim.invoice sees neither a matching status nor
      // sent_at, so the completion proceeds to text a SECOND pay link and
      // finalizes the row 'sent' on top of the email delivery it already had.
      expect(payLinkTexts()).toHaveLength(0);
      const invoice = await readInvoice(f.invoiceId);
      expect(invoice.status).toBe('draft'); // never claimed — firstDeliveryOnly refused pre-flip
      expect(invoice.sent_at).toBeNull();
      expect(invoice.sms_sent_at).toBeNull();
    });
  });
});
