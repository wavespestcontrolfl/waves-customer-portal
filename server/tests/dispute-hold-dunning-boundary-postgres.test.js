/**
 * Owner ruling 2026-09-30 (PR #5424 round 9): while a customer has an ACTIVE collections DISPUTE
 * hold, no AUTOMATED billing follow-up carrying a pay / update-card link reaches them. The dunning
 * senders consult the hold early (rail-guard) and then await credit application, link shortening,
 * ledger writes and rendering before they send, so a hold placed in that window must still stop the
 * send. It is stopped at the two provider-side chokepoints, once per reminder family:
 *
 *   - Text / App: the customer-message boundary (send-customer-message.js step 1.5), keyed on the
 *     dunning entry points because their purpose ('payment_link' / 'billing') is shared with
 *     non-dunning senders;
 *   - Email: the billing email authority, keyed on the dunning template keys, re-read on the locked
 *     handle before dispatch and again at the final provider check.
 *
 * Exempt: a deliberate operator send ("send now"), a send the customer asked for, and payer-billed.
 * A hold is a WAIT, never terminal: the same send goes through after the release.
 *
 * Real Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's REPAIR_TEST_DATABASE_URL; skipped
 * without either). Synthetic names only; nothing here can reach a real provider (every held case is
 * refused before one, and the provider modules are stubs).
 */
const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;

jest.mock('../models/db', () => require('knex')({
  client: 'pg', connection: process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 4 },
}));
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'm1' } })),
}));
jest.mock('../services/sendgrid-mail', () => ({
  ...jest.requireActual('../services/sendgrid-mail'),
  isConfigured: jest.fn(() => true),
  serviceGroupId: jest.fn(() => 222),
  sendOne: jest.fn(async () => ({ messageId: 'sg-synthetic-1' })),
  isDefiniteRejection: jest.fn(() => false),
}));

const { randomUUID } = require('crypto');

jest.setTimeout(30000);

const run = connection ? describe : describe.skip;
const DISPUTE_REASON = 'dispute on call: synthetic billing question';

// One row per reminder family: what its sender passes to the customer-message boundary.
const TEXT_FAMILIES = [
  ['Day 3-90 invoice follow-up ladder', { purpose: 'payment_link', entryPoint: 'invoice_followup_sequence', message: 'invoice_followup' }],
  ['late-payment checker', { purpose: 'payment_link', entryPoint: 'late_payment_checker', message: 'late_payment' }],
  ['late-payment checker bank-verification re-nudge', { purpose: 'payment_link', entryPoint: 'late_payment_checker_microdeposit', message: 'bank_verification_incomplete' }],
  ['balance reminder (upcoming-visit workflow)', { purpose: 'payment_link', entryPoint: 'balance_reminder_workflow', message: 'balance_reminder' }],
  ['balance reminder (late-payment check)', { purpose: 'payment_link', entryPoint: 'balance_reminder_late_payment_check', message: 'late_payment' }],
  ['previsit balance reminder', { purpose: 'billing', entryPoint: 'previsit_balance_reminder', message: 'balance_reminder' }],
];
// One row per email family: the template its sender hands the billing email authority.
const EMAIL_FAMILIES = [
  ['Day 3 invoice follow-up', 'invoice.followup_3_day', 'invoice'],
  ['Day 90 invoice follow-up', 'invoice.followup_90_day', 'invoice'],
  ['late-payment reminder (balance-reminder / late-payment-checker)', 'billing_late_payment_7_day', 'billing'],
  ['bank-verification re-nudge', 'payment.microdeposit_verification', 'payment_issue'],
  ['previsit balance reminder', 'billing.previsit_balance', 'billing'],
];

run('dispute hold at the dunning send boundaries (postgres)', () => {
  let db;
  let sendCustomerMessage;
  let RailGuard;
  let dispatchUnderBillingEmailAuthority;
  let loadBillingEmailContext;
  const customers = [];

  async function newCustomer() {
    const [row] = await db('customers').insert({
      first_name: 'Synthetic', last_name: 'Dunningtest', phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
      email: `${randomUUID()}@example.invalid`,
    }).returning('id');
    customers.push(row.id);
    return row.id;
  }
  const placeHold = async (c, reason = DISPUTE_REASON) => (await db('collections_flags')
    .insert({ customer_id: c, flag: 'collection_hold', reason, created_by: 'test' }).returning('id'))[0].id;
  const release = (id) => db('collections_flags').where({ id }).update({ released_at: db.fn.now() });

  beforeAll(() => {
    db = require('../models/db');
    ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
    RailGuard = require('../services/collections/rail-guard');
    ({ dispatchUnderBillingEmailAuthority, loadBillingEmailContext } = require('../services/billing-channel-email-authority'));
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => {
    if (customers.length) {
      await db('notification_prefs').whereIn('customer_id', customers).del().catch(() => {});
      await db('activity_log').whereIn('customer_id', customers).del().catch(() => {});
      await db('sms_log').whereIn('customer_id', customers).del().catch(() => {});
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  describe.each(TEXT_FAMILIES)('Text / App: %s', (_label, { purpose, entryPoint, message }) => {
    const send = (customerId, extra = {}) => sendCustomerMessage({
      to: '+15551230100', body: 'Reminder: your balance is open. Pay here: https://portal.example.test/pay/tok', channel: 'sms',
      audience: 'customer', purpose, customerId, entryPoint, invoiceId: randomUUID(),
      metadata: { original_message_type: message, billingDeliveryCategory: 'billing' }, ...extra,
    });

    test('a hold placed AFTER the preflight consult, before the send, suppresses it at the boundary - a wait, never a failure', async () => {
      const c = await newCustomer();
      // The sender's preflight: not held yet, so it proceeds to render / draw credit / write its ledger row.
      await expect(RailGuard.collectionsChannelPermitted({ customerId: c, channel: 'sms', purpose: 'late_payment', logTag: 'test' })).resolves.toBe(true);
      const holdId = await placeHold(c); // ... and the hold commits during those awaits
      const out = await send(c);
      expect(out).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'COLLECTION_HOLD_SUPPRESSED' });
      expect(await db('sms_log').where({ customer_id: c }).count('* as n').first()).toMatchObject({ n: '0' });
      // the same send goes through the boundary again once the hold is released (a WAIT, nothing terminal)
      await release(holdId);
      expect((await send(c)).code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
    });

    test('an unanswerable hold lookup holds it too (fail closed)', async () => {
      const Hold = require('../services/collections/collection-hold');
      const c = await newCustomer();
      const lookup = jest.spyOn(Hold, 'messagingHeldByCollectionHold').mockResolvedValue({ held: true, reason: 'lookup_failed', error: new Error('db down') });
      try {
        expect(await send(c)).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
      } finally { lookup.mockRestore(); }
    });

    test('a deliberate operator send, and a send the customer asked for, are exempt from a DISPUTE hold (the read ignores it)', async () => {
      const Hold = require('../services/collections/collection-hold');
      const c = await newCustomer();
      await placeHold(c);
      const lookup = jest.spyOn(Hold, 'messagingHeldByCollectionHold');
      try {
        expect((await send(c, { holdExempt: 'operator', operatorInitiated: true })).code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
        expect((await send(c, { holdExempt: 'customer' })).code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
        expect((await send(c, { customerInitiated: true })).code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
        for (const call of lookup.mock.calls) expect(call[2]).toEqual({ ignoreDisputeHold: true });
        // an unrecognised exemption value does not exempt
        expect(await send(c, { holdExempt: 'system' })).toMatchObject({ code: 'COLLECTION_HOLD_SUPPRESSED' });
      } finally { lookup.mockRestore(); }
    });

    test('a wrong-number FALLBACK hold stops the notice, and NO exemption skips it; after its release it sends (Codex #5424 r13)', async () => {
      const c = await newCustomer();
      const holdId = await placeHold(c, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
      expect(await send(c)).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
      for (const extra of [{ holdExempt: 'operator', operatorInitiated: true }, { holdExempt: 'customer' }, { customerInitiated: true }]) {
        expect(await send(c, extra)).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
      }
      await release(holdId);
      expect((await send(c)).code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
    });
  });

  test('the shared purposes alone are NOT gated: a non-dunning payment_link sender (an operator project link) is untouched', async () => {
    const c = await newCustomer();
    await placeHold(c);
    const out = await sendCustomerMessage({
      to: '+15551230101', body: 'Here is your project payment link: https://portal.example.test/pay/tok', channel: 'sms',
      audience: 'customer', purpose: 'payment_link', customerId: c, entryPoint: 'admin_project_payment_link',
      metadata: { original_message_type: 'project_payment_link' },
    });
    expect(out.code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
  });

  describe('releasing a held reservation (the wait a suppressed leg leaves behind)', () => {
    let ContactLedger;
    beforeAll(() => { ContactLedger = require('../services/collections/contact-ledger'); });
    afterAll(async () => { await db('collections_contact_ledger').whereIn('customer_id', customers).del(); });
    const reserve = (c, key) => ContactLedger.recordContact({
      customerId: c, channel: 'sms', purpose: 'invoice_followup', invoiceIds: [], source: 'invoice_followups',
      metadata: { step_id: 'd3_friendly' }, idempotencyKey: key,
    });

    test('an unsettled reservation is deleted - no failed row, no spacing-window contact - and can be reserved afresh after the release', async () => {
      const c = await newCustomer();
      const key = `test:${randomUUID()}`;
      const entry = await reserve(c, key);
      await expect(ContactLedger.releaseHeldReservation(entry)).resolves.toBe(true);
      expect(await db('collections_contact_ledger').where({ customer_id: c }).count('* as n').first()).toMatchObject({ n: '0' });
      const again = await reserve(c, key); // the leg goes out on the first run after the release
      expect(again.reused).toBeUndefined();
      expect((await ContactLedger.claimAttempt(again)).allowed).toBe(true);
    });

    test('a delivered reservation is never deleted (it falls back to the retryable stamp path and stays)', async () => {
      const c = await newCustomer();
      const entry = await reserve(c, `test:${randomUUID()}`);
      await ContactLedger.markDelivered(entry);
      await ContactLedger.releaseHeldReservation(entry);
      const [row] = await db('collections_contact_ledger').where({ customer_id: c });
      expect(row).toBeTruthy();
      expect(row.metadata).toMatchObject({ delivered: true });
    });
  });

  describe.each(EMAIL_FAMILIES)('Email: %s', (_label, templateKey, category) => {
    async function preflight(c) {
      const input = { customerId: c, channel: 'email', metadata: { billingDeliveryCategory: category } };
      const context = await loadBillingEmailContext(input);
      expect(context.error).toBeUndefined();
      return { input, context };
    }
    const attempt = async ({ input, context }, extra = {}) => {
      const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
      const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
        const verdict = await providerBoundaryCheck({ database });
        return verdict.ok === true ? { messageId: 'provider-1' } : null;
      });
      const outcome = await dispatchUnderBillingEmailAuthority({
        input, recipientEmail: context.recipientEmail, templateKey, dispatch, state,
        // The sender's own suppression check stands in for the template-library read, so this suite
        // does not depend on which email templates the test database has migrated in.
        emailSuppression: async () => null, ...extra,
      });
      return { outcome, state, dispatch };
    };

    test('a hold placed AFTER the preflight, before dispatch, refuses the send as a retryable wait', async () => {
      const c = await newCustomer();
      const prepared = await preflight(c); // sender's preflight: no hold
      const holdId = await placeHold(c); // hold commits during rendering / credit / ledger awaits
      const { outcome, state, dispatch } = await attempt(prepared);
      expect(outcome).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'COLLECTION_HOLD_DEFER', retryable: true, deliveryOutcome: 'not_sent' });
      expect(state.handoffStarted).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      // the same send is not refused for the hold once it is released (a WAIT, nothing terminal)
      await release(holdId);
      const again = await attempt(prepared);
      expect(again.state.boundaryBlock?.code).not.toBe('COLLECTION_HOLD_DEFER');
    });

    test('a hold that commits while the provider request is prepared stops it at the final provider-boundary check', async () => {
      const c = await newCustomer();
      const prepared = await preflight(c);
      const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
      const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
        // The hold row lands on the authority's own locked handle (a separate connection would wait
        // on the customer-row lock the authority holds), so the boundary check reads it.
        await database('collections_flags').insert({ customer_id: c, flag: 'collection_hold', reason: DISPUTE_REASON, created_by: 'test' });
        await providerBoundaryCheck({ database });
        return { messageId: 'provider-1' };
      });
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: prepared.input, recipientEmail: prepared.context.recipientEmail, templateKey, dispatch, state,
        emailSuppression: async () => null,
      });
      expect(outcome).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'COLLECTION_HOLD_DEFER', retryable: true });
      expect(state.handoffStarted).toBe(false);
    });

    test('the operator and customer exemptions skip the hold', async () => {
      const c = await newCustomer();
      const prepared = await preflight(c);
      await placeHold(c);
      for (const holdExempt of ['operator', 'customer']) {
        const { state } = await attempt(prepared, { holdExempt });
        expect(state.boundaryBlock?.code).not.toBe('COLLECTION_HOLD_DEFER');
      }
    });
  });
});
