// The dispute-hold read is not what this suite exercises (its db is a queue of
// canned chains): no active hold. The hold behavior has its own suites.
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  dueInvoiceHeldByDisputeHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
// The follow-up email rides the shared billing email authority (owner ruling
// 2026-09-27). Its own locks, rechecks and suppression reads are pinned in
// billing-channel-email-authority.test.js and the Postgres suite; here it is
// mocked so this suite tests the sequence's wiring and outcome mapping.
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));
// Collections contact ledger (record-then-send, codex 2026-08-14): the rails
// now insert a ledger row BEFORE each delivery attempt and SKIP the send if
// the insert fails. Mock it as always-succeeding so this suite keeps testing
// its own concern; the ledger discipline itself is pinned in
// collections-rails-policy.test.js.
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
  reverseAppliedCredit: jest.fn(async () => ({ reversed: 0 })),
}));

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'invoice follow-up sms'),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/inv123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-1', sent_at: '2026-05-26T14:00:00.000Z' },
  })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor' }]),
}));

const db = require('../models/db');
const BillingEmailAuthority = require('../services/billing-channel-email-authority');
const smsTemplates = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplates = require('../services/email-template-library');
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'join',
    'where',
    'whereIn',
    'whereNotIn',
    'whereNull',
    'whereNotNull',
    'whereNotExists',
    'select',
    'orderBy',
    'forUpdate',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if ((!queue || !queue.length) && table === 'notification_prefs') return chain({ first: undefined });
    if ((!queue || !queue.length) && table === 'collections_contact_ledger') return chain({ result: [] });
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  return tableQueues;
}

function followupRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    step_index: 0,
    // Mirrors the batch select (s.*): due an hour before the frozen clock —
    // same-day, inside the stale grace, so runPending routes to fireStep.
    next_touch_at: '2026-05-26T13:00:00.000Z',
    touches_sent: 0,
    token: 'token-1',
    title: 'Quarterly Pest Control',
    total: '129.00',
    status: 'active',
    service_date: '2026-05-12',
    due_date: '2026-05-19',
    invoice_number: 'WPC-2026-1042',
    invoice_created_at: '2026-05-20T12:00:00.000Z',
    // runPending() selects `i.payer_id as invoice_payer_id` and
    // `i.scheduled_send_error as invoice_send_error`; mirror both so
    // fireStep's Bill-To guard reads the row instead of an extra lookup.
    invoice_payer_id: null,
    invoice_send_error: null,
    ...overrides,
  };
}

function customer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Morgan',
    email: 'taylor@example.com',
    phone: '+19415550101',
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'WPC-2026-1042',
    status: 'sent',
    title: 'Quarterly Pest Control',
    total: '129.00',
    due_date: '2026-05-19',
    service_date: '2026-05-12',
    // fireTouch's post-claim fresh read refreshes token/title/etc onto the
    // cron row — keep the fixture carrying the same token the row uses.
    token: 'token-1',
    ...overrides,
  };
}

describe('invoice follow-up email sidecar', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
    require('../services/collections/contact-ledger').claimAttempt.mockReset().mockResolvedValue({ allowed: true });
    BillingEmailAuthority.loadBillingEmailContext.mockReset().mockResolvedValue({
      category: 'invoice',
      recipient: { email: 'billing@example.com', name: 'Taylor' },
      recipientEmail: 'billing@example.com',
    });
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockReset()
      .mockImplementation(async ({ dispatch, state }) => {
        state.handoffStarted = true;
        await dispatch('authority-trx');
        state.providerAccepted = true;
        return { ok: true };
      });
    // fireStep claims inside a transaction that locks the invoice row —
    // pass-through so the queued table chains serve it.
    db.transaction = jest.fn(async (fn) => fn(db));
    // Every sequence UPDATE stamps updated_at via knex's `.fn.now()` (the
    // ownership-change checks read that column), so the stub connection
    // needs the same surface the real knex instance exposes.
    db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('sends the 3-day email sidecar with the invoice follow-up SMS', async () => {
    const emailInteraction = chain();
    const finalInteraction = chain();
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: customer() })],
      // fireStep re-reads the invoice after the account-credit draw-down
      // (total/credit_applied/status), THEN sendFollowupEmail fetches it
      // again for the eligibility check — two reads per fired step.
      // Claim-txn row lock read + the credit path's own invoice read (it
      // bails at its payment_plans probe in this harness) + the pre-dun
      // refresh + fireTouch's live ownership re-read + the email-eligibility
      // read.
      invoices: [chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [emailInteraction, finalInteraction],
      // fireStep now claims the sequence (touch_claimed_at) before sending
      // and clears it after — the cadence advance is the middle entry.
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }), // post-lock revalidation (customer_id is NOT NULL in schema — fireStep's ownership gate reads it)
        chain({ result: 1 }), // touch claim
        sequenceUpdate, // cadence advance
        chain({ result: 1 }), // claim clear
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
      to: 'billing@example.com',
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        invoice_number: 'WPC-2026-1042',
        amount_due: '$129.00',
        pay_url: 'https://portal.wavespestcontrol.com/l/inv123',
      }),
    }));
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith('invoice_followup_3day', expect.objectContaining({
      first_name: 'Taylor',
      pay_url: 'https://portal.wavespestcontrol.com/l/inv123',
    }), expect.objectContaining({
      workflow: 'invoice_followup',
      entity_id: 'inv-1',
    }));
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'invoice follow-up sms',
      entryPoint: 'invoice_followup_sequence',
      metadata: expect.objectContaining({
        original_message_type: 'invoice_followup',
        notificationEventKey: 'invoice-followup:seq-1:d3_friendly',
        followup_sequence_id: 'seq-1',
        rendered_amount: '129.00',
        collections_ledger_id: 'led-1',
      }),
    }));
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 1,
      status: 'active',
    }));
    expect(finalInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({
      interaction_type: 'sms_outbound',
      metadata: expect.stringContaining('"email_sent":true'),
    }));
  });

  // The customer's choice is read by the shared authority, first at
  // preparation and again under its locks at the provider handoff. Its
  // refusals map onto the reasons the sequence already settles on.
  // A terminal refusal the shared authority can actually still produce (the
  // portal-wide email switch no longer can — owner ruling 2026-09-26).
  const noRecipient = { code: 'NO_EMAIL_RECIPIENT', blocked: true, reason: 'No billing email on file' };
  test.each([
    ['enabled', { email_enabled: true }, {}, null],
    ['missing row', undefined, {}, null],
    ['missing flag', {}, {}, null],
    ['portal-wide switch off (legacy)', { email_enabled: false }, {}, null],
    ['portal-wide switch off with explicit Email and Text', { email_enabled: false, invoice_channels: ['email', 'sms'] }, {}, null],
    ['no recipient email, legacy', { email_enabled: true }, { firstRead: noRecipient }, 'missing_email'],
    ['no recipient email, Email only', { email_enabled: true, invoice_channels: ['email'] }, { firstRead: noRecipient, noSms: true }, 'missing_email'],
    ['operator-initiated', { email_enabled: false, invoice_channels: ['sms'] }, { operator: true }, null],
    ['unreadable authority context', {}, { readFailure: true }, 'billing_email_context_unavailable'],
    ['no recipient email at handoff', { email_enabled: true, invoice_channels: ['email', 'sms'] }, { handoff: noRecipient }, 'missing_email'],
  ])('%s: the email outcome, SMS delivery, and sequence progress', async (_label, prefs, options, emailReason) => {
    const emailSent = emailReason === null;
    // A send or a handoff refusal writes its own email audit row first.
    const reachedHandoff = emailSent || !!options.handoff;
    const interaction = chain();
    const sequenceUpdate = chain();
    const sequence = followupRow();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [sequence], first: sequence })],
      customers: [chain({ first: customer() })],
      invoices: Array.from({ length: options.operator ? 6 : 5 }, () => chain({ first: invoice() })),
      notification_prefs: [
        ...(!options.operator ? [chain({ first: prefs })] : []),
        ...(options.operator ? [chain({ first: prefs })] : []),
      ],
      customer_interactions: reachedHandoff ? [chain(), interaction] : [interaction],
      invoice_followup_sequences: [
        ...(options.operator ? [chain({ first: sequence }), chain()] : []),
        chain({ first: sequence }), chain({ result: 1 }), sequenceUpdate, chain({ result: 1 }),
      ],
    });
    if (options.readFailure) BillingEmailAuthority.loadBillingEmailContext.mockRejectedValueOnce(new Error('prefs unavailable'));
    if (options.firstRead) BillingEmailAuthority.loadBillingEmailContext.mockResolvedValueOnce({ error: options.firstRead });
    if (options.handoff) {
      BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
        state.boundaryBlock = options.handoff;
        return { ok: false };
      });
    }
    const dispatch = jest.fn(async () => {});
    const invoiceHelpers = require('../services/invoice-helpers');
    const ownership = jest.spyOn(invoiceHelpers, 'selfPayAtDispatch').mockReturnValue(async () => ({ ok: true }));
    if (reachedHandoff) {
      EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
        const verdict = await withProviderHandoff(dispatch);
        return verdict.ok ? { sent: true } : { sent: false, aborted: true, reason: 'aborted_before_dispatch' };
      });
    }
    let ownershipCalls;
    try {
      if (options.operator) await InvoiceFollowUps.sendNextTouchNow('inv-1', { operatorInitiated: true });
      else await InvoiceFollowUps.runPending();
      ownershipCalls = ownership.mock.calls.slice();
    } finally {
      ownership.mockRestore();
    }

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(reachedHandoff ? 1 : 0);
    if (options.operator) {
      // An operator's explicit send skips the customer's choices; it
      // rechecks ownership only.
      expect(BillingEmailAuthority.loadBillingEmailContext).not.toHaveBeenCalled();
      expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
      expect(ownershipCalls).toContainEqual(['inv-1', db]);
      expect(dispatch).toHaveBeenCalledWith();
    } else {
      const input = {
        customerId: 'cust-1', invoiceId: 'inv-1', channel: 'email', metadata: { billingDeliveryCategory: 'invoice' },
      };
      expect(BillingEmailAuthority.loadBillingEmailContext).toHaveBeenCalledWith(input);
      if (reachedHandoff) {
        expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(expect.objectContaining({
          input, recipientEmail: 'billing@example.com', templateKey: 'invoice.followup_3_day',
        }));
      }
      if (emailSent) expect(dispatch).toHaveBeenCalledWith('authority-trx');
      else expect(dispatch).not.toHaveBeenCalled();
    }
    expect(sendCustomerMessage).toHaveBeenCalledTimes(options.noSms ? 0 : 1);
    if (options.noSms) {
      expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }));
      expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
      expect(interaction.insert).not.toHaveBeenCalled();
    } else {
      expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
      expect(JSON.parse(interaction.insert.mock.calls[0][0].metadata)).toMatchObject({
        email_sent: emailSent, sms_sent: true, ...(!emailSent ? { email_reason: emailReason } : {}),
      });
    }
    if (!emailSent) {
      const terminal = emailReason === 'missing_email' && !!prefs?.invoice_channels;
      expect(require('../services/collections/contact-ledger').markSendFailed).toHaveBeenCalledWith(
        expect.anything(), expect.objectContaining({
          reason: emailReason,
          ...(terminal ? { resolved: true, resolution: 'email_terminal_refusal' } : {}),
        }),
      );
    }
  });

  // An Email-only customer who switches to Text-only after fireTouch read
  // the choice: the handoff's preference-change hold keeps the touch due for
  // a re-fan-out on the current choice; the sequence is never paused on the
  // stale Email-only snapshot.
  // The cron fires once a day (10:16 NY, Tue–Fri), so a held step must land on
  // a time the NEXT tick still treats as due and fresh, or skipStaleTouches
  // passes it by. A Friday hold rolls to Tuesday's anchor.
  test('a Friday hold is retried, not stale-skipped, at the Tuesday tick', async () => {
    jest.setSystemTime(new Date('2026-05-29T14:16:00.000Z')); // Fri 10:16 NY
    const sequence = followupRow({ next_touch_at: '2026-05-29T14:00:00.000Z' });
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [sequence], first: sequence })],
      customers: [chain({ first: customer({ phone: null }) })],
      invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: {} })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [chain({ first: sequence }), chain({ result: 1 }), sequenceUpdate, chain({ result: 1 })],
    });
    BillingEmailAuthority.loadBillingEmailContext.mockRejectedValueOnce(new Error('connection terminated'));
    await InvoiceFollowUps.runPending();
    const heldAt = sequenceUpdate.update.mock.calls[0][0].next_touch_at;
    const tuesdayTick = new Date('2026-06-02T14:16:00.000Z'); // Tue 10:16 NY
    expect(heldAt <= tuesdayTick).toBe(true);
    expect(tuesdayTick - InvoiceFollowUps.firstEligibleFireAt(heldAt)).toBeLessThanOrEqual(InvoiceFollowUps.STALE_TOUCH_GRACE_MS);
  });

  // No explicit channel choice and no phone: the email is the only leg, so a
  // retryable refusal from the shared check must hold the touch rather than
  // fall to the pause branch and end every remaining follow-up.
  test('a retryable email refusal holds the touch for a customer with no channel choice and no phone', async () => {
    const sequence = followupRow();
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [sequence], first: sequence })],
      customers: [chain({ first: customer({ phone: null }) })],
      invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: {} })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [chain({ first: sequence }), chain({ result: 1 }), sequenceUpdate, chain({ result: 1 })],
    });
    BillingEmailAuthority.loadBillingEmailContext.mockRejectedValueOnce(new Error('connection terminated'));
    await InvoiceFollowUps.runPending();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const [update] = sequenceUpdate.update.mock.calls[0];
    expect(update).not.toHaveProperty('status');
    // The next NY calendar day: tomorrow's tick retries it, not a stale-skip.
    expect(update.next_touch_at).toEqual(new Date('2026-05-27T04:00:00.000Z'));
    // The attempt never left, so its unkeyed ledger row must not fill the
    // collections window the held retry is judged by.
    expect(require('../services/collections/contact-ledger').markSendFailed).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ reason: 'billing_email_context_unavailable', never_contacted: true }),
    );
  });

  test.each([
    ['a preference change', { code: 'BILLING_PREFERENCES_CHANGED', blocked: true, retryable: true, deferred: true,
      deliveryOutcome: 'not_sent', reason: 'Email is not selected for this billing category' }],
    // A profile merge that moves the invoice to the winner after fireTouch
    // loaded this customer: the next run reloads the owner.
    ['an invoice moved to another customer', { code: 'INVOICE_CUSTOMER_MISMATCH', blocked: true,
      deliveryOutcome: 'not_sent', reason: 'Invoice does not belong to this customer' }],
  ])('%s at the handoff holds the touch instead of pausing the sequence', async (_label, block) => {
    const sequence = followupRow();
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [sequence], first: sequence })],
      customers: [chain({ first: customer() })],
      invoices: Array.from({ length: 5 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: { invoice_channels: ['email'] } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [chain({ first: sequence }), chain({ result: 1 }), sequenceUpdate, chain({ result: 1 })],
    });
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
      state.boundaryBlock = block;
      return { ok: false };
    });
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(jest.fn());
      return verdict.ok ? { sent: true } : { sent: false, aborted: true, reason: 'aborted_before_dispatch' };
    });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const [update] = sequenceUpdate.update.mock.calls[0];
    expect(update).not.toHaveProperty('status');
    // The next NY calendar day: tomorrow's tick retries it, not a stale-skip.
    expect(update.next_touch_at).toEqual(new Date('2026-05-27T04:00:00.000Z'));
    // An explicit selection's keyed reservation is excluded from its own
    // step's consult, so it is not stamped never_contacted.
    const [[, stamp]] = require('../services/collections/contact-ledger').markSendFailed.mock.calls;
    expect(stamp).not.toHaveProperty('resolved');
    expect(stamp).not.toHaveProperty('never_contacted');
  });

  test.each([
    ['a billing address changed before dispatch', { code: 'EMAIL_RECIPIENT_CHANGED', blocked: true, retryable: true, reason: 'changed' },
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'EMAIL_RECIPIENT_CHANGED' }],
    ['Email deselected before dispatch', { code: 'BILLING_PREFERENCES_CHANGED', blocked: true, retryable: true, deferred: true },
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'BILLING_PREFERENCES_CHANGED' }],
    ['a staff do-not-contact', { code: 'SUPPRESSED_MANUAL_DNC', blocked: true, reason: 'Recipient was manually added to the do-not-contact list by an operator' },
      { ok: false, blocked: true, reason: 'Suppressed: Recipient was manually added to the do-not-contact list by an operator' }],
    ['an address suppression', { code: 'EMAIL_SUPPRESSED', blocked: true, reason: 'Suppressed: bounce' },
      { ok: false, blocked: true, reason: 'Suppressed: bounce' }],
    ['a payer assigned before dispatch', { code: 'INVOICE_PAYER_BILLED', blocked: true, reason: 'payer' },
      { ok: false, skipped: true, reason: 'invoice_payer_billed' }],
    ['an invoice moved to another customer before dispatch', { code: 'INVOICE_CUSTOMER_MISMATCH', blocked: true, reason: 'moved' },
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'INVOICE_CUSTOMER_MISMATCH' }],
    // A profile merge soft-deletes the loser the sequence was loaded for.
    ['the loaded customer merged away before dispatch', { code: 'CUSTOMER_NOT_FOUND', blocked: true, reason: 'gone' },
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'CUSTOMER_NOT_FOUND' }],
  ])('%s at the handoff maps onto the sequence outcome', async (_label, block, expected) => {
    const sequence = followupRow();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [sequence], first: sequence })],
      customers: [chain({ first: customer() })],
      invoices: Array.from({ length: 5 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: { invoice_channels: ['email', 'sms'] } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [chain({ first: sequence }), chain({ result: 1 }), chain(), chain({ result: 1 })],
    });
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
      state.boundaryBlock = block;
      return { ok: false };
    });
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(jest.fn());
      return verdict.ok ? { sent: true } : { sent: false, aborted: true, reason: 'aborted_before_dispatch' };
    });
    await InvoiceFollowUps.runPending();
    expect(require('../services/collections/contact-ledger').markSendFailed).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ reason: expected.reason }),
    );
  });

  test('skips a touch whose sequence was postponed between the batch select and the claim', async () => {
    // A delivered-invoice due-date edit (rescheduleForInvoiceEdit) can move
    // next_touch_at into the future after runPending materialized its batch —
    // the post-lock revalidation must drop the stale snapshot unsent (no
    // claim is taken, so there is nothing to clear).
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      invoices: [chain({ first: invoice() })], // claim-txn row lock read
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', status: 'active', step_index: 0, next_touch_at: '2026-05-30T14:00:00.000Z', anchor_at: null } }), // postponed
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('refuses the touch when the sequence was repointed under the claim lock', async () => {
    // The batch row is a snapshot. An ownership change that committed between
    // runPending's SELECT and fireStep's FOR UPDATE (a customer merge repoints
    // both the invoice and its sequence) leaves row.customer_id naming the
    // previous owner — sending from it would mail one customer's invoice, and
    // its bearer /pay/:token, to another. The post-lock ownership gate drops
    // the touch; the sequence stays active and due for the next run.
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      invoices: [chain({ first: invoice({ customer_id: 'cust-restored' }) })], // repointed under the lock
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-restored', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('refuses the touch when only the INVOICE moved — sequence/invoice split fails closed (r19)', async () => {
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      invoices: [chain({ first: invoice({ customer_id: 'cust-restored' }) })],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('arms a new sequence from the LOCKED invoice owner, not the pre-lock read (r19)', async () => {
    // scheduleForInvoice used to capture customer_id from an unlocked read and
    // carry it through several awaits into the INSERT. If another writer held
    // the invoice lock across that window, the insert landed a sequence owned
    // by the previous customer on an invoice that had moved. Ownership now
    // comes from the row read under FOR UPDATE.
    const sequenceInsert = chain({ returning: [{ id: 'seq-new' }] });
    setDbQueues({
      invoices: [
        chain({ first: invoice({ created_at: '2026-05-20T12:00:00.000Z' }) }), // unlocked preview (prior owner)
        // post-lock truth: the invoice was repointed while we waited
        chain({ first: invoice({ customer_id: 'cust-restored', created_at: '2026-05-20T12:00:00.000Z' }) }),
      ],
      invoice_followup_sequences: [
        chain({ first: undefined }), // no existing sequence
        sequenceInsert,
      ],
      payment_plans: [chain({ first: undefined })], // no active plan
      customers: [chain({ first: customer({ id: 'cust-restored' }) })],
      payment_methods: [chain({ first: undefined })],
    });

    await InvoiceFollowUps.scheduleForInvoice('inv-1');

    expect(sequenceInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'inv-1',
      customer_id: 'cust-restored',
    }));
  });

  test('never arms a sequence while the invoice has an ACTIVE payment plan (codex r7 P1)', async () => {
    // A payment-plan cancel's absent-sequence path calls scheduleForInvoice
    // post-commit; a concurrent plan creation may have taken the invoice lock
    // first. The in-trx payment_plans check must refuse to arm dunning.
    const sequenceInsert = chain({ returning: [{ id: 'seq-new' }] });
    setDbQueues({
      invoices: [
        chain({ first: invoice() }),
        chain({ first: invoice() }),
      ],
      invoice_followup_sequences: [
        chain({ first: undefined }), // no existing sequence
        sequenceInsert,
      ],
      payment_plans: [chain({ first: { id: 'plan-1' } })], // ACTIVE plan
    });

    const res = await InvoiceFollowUps.scheduleForInvoice('inv-1');

    expect(res).toBeNull();
    expect(sequenceInsert.insert).not.toHaveBeenCalled();
  });

  test('cron excludes every non-sendable invoice status', async () => {
    const pendingQuery = chain({ result: [] });
    setDbQueues({
      'invoice_followup_sequences as s': [pendingQuery],
    });

    await InvoiceFollowUps.runPending();

    expect(pendingQuery.whereNotIn).toHaveBeenCalledWith('i.status', [
      'paid',
      'prepaid',
      'void',
      'processing',
      'refunded',
      'canceled',
      'cancelled',
    ]);
    // Payer-billed invoices are excluded from the homeowner dunning queue.
    expect(pendingQuery.whereNull).toHaveBeenCalledWith('i.payer_id');
  });

  test('does not schedule a sequence for terminal or draft invoices', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice({ status: 'refunded' }) })],
    });

    await expect(InvoiceFollowUps.scheduleForInvoice('inv-1')).resolves.toBeNull();
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('does not resume terminal invoices into the active queue', async () => {
    setDbQueues({
      invoice_followup_sequences: [chain({ first: followupRow() })],
      invoices: [chain({ first: invoice({ status: 'paid' }) })],
    });

    await expect(InvoiceFollowUps.resumeSequence('inv-1')).resolves.toBeUndefined();
  });

  test.each([false, true, 'prior', 'bell', 'prior+old-email', 'prior+old-text', 'prior+fresh-email', 'legacy-old-email'])('advances a selected App (%s) or legacy email sequence', async (appSelected) => {
    const visibleAt = new Date('2026-05-20T14:00:00Z');
    const textAt = new Date('2026-05-21T14:00:00Z');
    const prior = String(appSelected).startsWith('prior');
    const oldText = appSelected === 'prior+old-text';
    const legacyOldEmail = appSelected === 'legacy-old-email';
    const withEmail = String(appSelected).includes('email');
    const repaired = legacyOldEmail || (prior && appSelected !== 'prior+fresh-email');
    if (legacyOldEmail) EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
    if (prior) sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', reason: 'app_event_already_visible', eventVisibleAt: visibleAt });
    if (oldText) sendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', deduped: true, sentAt: textAt });
    if (appSelected === 'prior+old-email') {
      const ledger = require('../services/collections/contact-ledger');
      ledger.claimAttempt.mockResolvedValueOnce({ allowed: false, delivered: true });
      ledger.recordContact.mockResolvedValueOnce({ id: 'email-old', metadata: {}, occurred_at: visibleAt });
    }
    if (appSelected === 'bell') sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', bellPersisted: true });
    const prefs = { email_enabled: true, ...(appSelected && !legacyOldEmail
      ? { invoice_channels: withEmail ? ['email', 'push'] : oldText ? ['push', 'sms'] : ['push'] } : {}) };
    const emailInteraction = chain();
    const finalInteraction = chain();
    const sequenceUpdate = chain();
    const credit = require('../services/customer-credit');
    const creditCase = legacyOldEmail || appSelected === 'prior+fresh-email';
    if (creditCase) credit.autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 50 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(legacyOldEmail ? { last_touch_at: visibleAt } : {})] })],
      customers: [chain({ first: customer({ phone: oldText ? '+19415550101' : null }) })],
      // Two invoice reads per fired step: credit re-read + email eligibility.
      // Claim-txn row lock read + the credit path's own invoice read (it
      // bails at its payment_plans probe in this harness) + the pre-dun
      // refresh + the email-eligibility read.
      invoices: [chain({ first: invoice(legacyOldEmail ? { credit_applied: '70.00' } : {}) }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: prefs }), chain({ first: prefs })],
      customer_interactions: [emailInteraction, finalInteraction],
      // Claim → cadence advance → claim clear (see the sidecar test above).
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }), // post-lock revalidation (customer_id is NOT NULL in schema — fireStep's ownership gate reads it)
        chain({ result: 1 }), // touch claim
        sequenceUpdate, // cadence advance
        chain({ result: 1 }), // claim clear
      ],
    });

    await InvoiceFollowUps.runPending();

    if (appSelected && !legacyOldEmail) {
      if (appSelected === 'prior+fresh-email') expect(EmailTemplates.sendTemplate).toHaveBeenCalled();
      else expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1', to: oldText ? '+19415550101' : null,
      }));
    } else {
      expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'invoice.followup_3_day' }));
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    }
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 1,
      status: 'active',
    }));
    expect(sequenceUpdate.update.mock.calls[0][0].last_touch_at).toEqual(repaired ? (oldText ? textAt : visibleAt) : new Date());
    if (oldText) expect(require('../services/collections/contact-ledger').markDelivered)
      .toHaveBeenCalledWith(expect.anything(), { occurredAt: textAt });
    if (appSelected === 'prior+fresh-email') expect(finalInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({ interaction_type: 'email_outbound' }));
    if (legacyOldEmail) {
      expect(credit.autoApplyAccountCreditIfEnabled).toHaveBeenCalled();
      expect(credit.reverseAppliedCredit).toHaveBeenCalledWith({ invoiceId: 'inv-1', amount: 50, createdBy: 'system:dun_undelivered' });
    }
    if (appSelected === 'prior+fresh-email') expect(credit.reverseAppliedCredit).not.toHaveBeenCalled();
    if (repaired) {
      if (!legacyOldEmail) expect(require('../services/collections/contact-ledger').markDelivered).toHaveBeenCalled();
      expect(emailInteraction.insert).not.toHaveBeenCalled();
      expect(finalInteraction.insert).not.toHaveBeenCalled();
      expect(require('../services/collections/contact-ledger').markSendFailed).not.toHaveBeenCalled();
    }
  });

  test.each([['selected', ['email']], ['legacy', null]])('%s provider-deduped Email repairs this step and contact from stored sentAt', async (_kind, channels) => {
    const priorStepAt = new Date('2026-05-10T14:00:00Z');
    const acceptedAt = new Date('2026-05-20T14:00:00Z');
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true,
      message: { provider_message_id: 'sg-original', sent_at: acceptedAt } });
    const sequenceUpdate = chain();
    const interaction = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({ last_touch_at: priorStepAt })] })],
      customers: [chain({ first: customer({ phone: null }) })],
      invoices: Array.from({ length: 5 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: channels ? { invoice_channels: channels } : { email_enabled: true } }),
        chain({ first: channels ? { invoice_channels: channels } : { email_enabled: true } })],
      customer_interactions: [interaction],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0,
          next_touch_at: '2026-05-26T13:00:00Z', anchor_at: null } }),
        chain({ result: 1 }), sequenceUpdate, chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 1, last_touch_at: acceptedAt,
    }));
    expect(require('../services/collections/contact-ledger').markDelivered)
      .toHaveBeenCalledWith(expect.anything(), { occurredAt: acceptedAt });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(interaction.insert).not.toHaveBeenCalled();
  });

  test('a prior App bell with uncertain Email keeps this credit draw held for replay', async () => {
    const credit = require('../services/customer-credit');
    credit.autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 50 });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent',
      reason: 'app_event_already_visible', eventVisibleAt: new Date('2026-05-20T14:00:00Z') });
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('provider timeout'),
      { providerOutcome: { deliveryOutcome: 'uncertain' } }));
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: customer({ phone: null }) })],
      invoices: Array.from({ length: 5 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: { invoice_channels: ['email', 'push'] } }), chain({ first: { invoice_channels: ['email', 'push'] } })],
      customer_interactions: [chain()],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0,
          next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }), sequenceUpdate, chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ next_touch_at: expect.any(Date) }));
    expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
    expect(credit.reverseAppliedCredit).not.toHaveBeenCalled();
  });

  test('a prior Email with a newly queued SMS keeps the credit for the owed text', async () => {
    const credit = require('../services/customer-credit');
    credit.autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 50 });
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true,
      code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-05-27T12:00:00.000Z' });
    const smsLog = chain();
    const sequenceUpdate = chain();
    const priorAt = new Date('2026-05-20T14:00:00Z');
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({ last_touch_at: priorAt })] })],
      customers: [chain({ first: customer() })],
      invoices: [chain({ first: invoice({ credit_applied: '70.00' }) }),
        chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain()],
      sms_log: [smsLog],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0,
          next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }), sequenceUpdate, chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(smsLog.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'scheduled', scheduled_for: new Date('2026-05-27T12:00:00.000Z'),
    }));
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1, last_touch_at: priorAt }));
    expect(credit.reverseAppliedCredit).not.toHaveBeenCalled();
  });

  test('a prior Email with uncertain legacy SMS keeps the credit for a possibly delivered text', async () => {
    const credit = require('../services/customer-credit');
    credit.autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 50 });
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: false,
      deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', retryable: false, deferred: false });
    const sequenceUpdate = chain();
    const priorAt = new Date('2026-05-20T14:00:00Z');
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({ last_touch_at: priorAt })] })],
      customers: [chain({ first: customer() })],
      invoices: [chain({ first: invoice({ credit_applied: '70.00' }) }),
        chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain()],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0,
          next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }), sequenceUpdate, chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', customerId: 'cust-1' }));
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1, last_touch_at: priorAt }));
    expect(credit.reverseAppliedCredit).not.toHaveBeenCalled();
  });

  test.each(['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT'])('%s with a failed enqueue holds the current follow-up step for retry', async (code) => {
    // Email delivered, the text crossed the 20:00 ET cutoff, and the
    // scheduled-rail insert then failed — nothing durable owns the
    // pay-link SMS, so step_index must NOT advance (the email's per-step
    // idempotency key dedupes its leg when the touch re-fires at 8 AM).
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false,
      blocked: true,
      code,
      deferred: true,
      nextAllowedAt: '2026-05-27T12:00:00.000Z',
    });
    const emailInteraction = chain();
    const sequenceUpdate = chain();
    const failingSmsLog = chain();
    failingSmsLog.insert = jest.fn(async () => { throw new Error('sms_log insert failed'); });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: customer() })],
      invoices: [chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [emailInteraction],
      sms_log: [failingSmsLog],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }), // touch claim
        sequenceUpdate, // held-step defer (NOT a cadence advance)
        chain({ result: 1 }), // claim clear
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(failingSmsLog.insert).toHaveBeenCalled();
    expect(JSON.parse(failingSmsLog.insert.mock.calls[0][0].metadata)).toMatchObject({
      billingDeliveryCategory: 'invoice',
      hasEmailLeg: true,
      notificationEventKey: 'invoice-followup:seq-1:d3_friendly',
    });
    const patch = sequenceUpdate.update.mock.calls[0][0];
    expect(patch.next_touch_at).toEqual(new Date('2026-05-27T12:00:00.000Z'));
    expect(patch).not.toHaveProperty('step_index');
    expect(patch).not.toHaveProperty('status');
  });
});
