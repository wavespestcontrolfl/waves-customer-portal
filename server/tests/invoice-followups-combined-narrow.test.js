// GATE_DUNNING_COMBINED_MESSAGE, narrow rebuild (dunning unification PR 2b).
// No separate send path: the customer's OLDEST due invoice (the anchor)
// fires through the unchanged fireStep/fireTouch single-invoice path —
// every guard, hold, spacing, credit and ledger rule intact — and that
// path's ONLY change is template selection: when resolveCombinedVariant
// finds 2+ open invoices (via the existing buildPayBalanceLink), it
// renders the combined copy instead of the usual per-invoice one. The
// customer's OTHER due invoices this run ("siblings") wait for that one
// touch instead of each firing their own — see runPending's
// fireGroupedRows. Mirrors invoice-followups-email.test.js's mocking
// style.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));
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
// The combined touch's own count/total/pay link — resolveCombinedVariant
// reuses buildPayBalanceLink verbatim (composer-customer-links.js). Its own
// balance-computation and payer-exclusion behavior is proven separately;
// here it is mocked so this suite tests the grouping/template-selection
// wiring, not that function's internals.
jest.mock('../services/composer-customer-links', () => ({
  buildPayBalanceLink: jest.fn(),
}));
// The microdeposit bank-verification email leg (finding #2's mdPending
// diversion) — real implementation untouched by this suite; mocked only so
// the one mdPending test doesn't need to exercise its own internals.
jest.mock('../services/microdeposit-verification-email', () => ({
  sendMicrodepositVerificationEmail: jest.fn(async () => ({ ok: true })),
}));
// The shared collections rail-guard (Codex round-2 P3's aggregate
// re-check) — mocked so the single test that exercises GATE_COLLECTIONS_
// POLICY controls its verdict directly rather than exercising the real
// contact-policy module/DB. Defaults to "always allowed" every test, reset
// in beforeEach — byte-identical to the gate-off short-circuit the real
// module itself applies when GATE_COLLECTIONS_POLICY is unset.
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));

const db = require('../models/db');
const BillingEmailAuthority = require('../services/billing-channel-email-authority');
const smsTemplates = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplates = require('../services/email-template-library');
const ComposerLinks = require('../services/composer-customer-links');
const RailGuard = require('../services/collections/rail-guard');
// NOT mocked via jest.mock — finding #2's test spies on its one method
// directly (StripeService.isInvoiceAwaitingMicrodepositVerification), the
// same way the rest of this suite leaves it untouched: every other test's
// rows carry no stripe_payment_intent_id, so the real implementation
// short-circuits to `false` before any network call.
const StripeService = require('../services/stripe');
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'join', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
    'whereNotExists', 'select', 'orderBy', 'forUpdate',
  ].forEach((method) => { q[method] = jest.fn(() => q); });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

// Defaults sms_templates/email_templates to an active combined-template row
// whenever a test doesn't explicitly queue one — most tests care about the
// grouping mechanism, not template-availability, so this keeps their setup
// down to exactly the original single-invoice tests' shape plus the new
// fields under test.
function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if ((!queue || !queue.length) && table === 'notification_prefs') return chain({ first: undefined });
    if ((!queue || !queue.length) && table === 'collections_contact_ledger') return chain({ result: [] });
    if ((!queue || !queue.length) && table === 'sms_templates') return chain({ first: { id: 'sms-active' } });
    if ((!queue || !queue.length) && table === 'email_templates') return chain({ first: { id: 'email-active' } });
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
    invoice_payer_id: null,
    invoice_send_error: null,
    ...overrides,
  };
}

function customer(overrides = {}) {
  return {
    id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan',
    email: 'taylor@example.com', phone: '+19415550101', ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1', customer_id: 'cust-1', invoice_number: 'WPC-2026-1042',
    status: 'sent', title: 'Quarterly Pest Control', total: '129.00',
    due_date: '2026-05-19', service_date: '2026-05-12', token: 'token-1',
    ...overrides,
  };
}

// The buildPayBalanceLink shape resolveCombinedVariant reads.
// buildPayBalanceLink is called with { deferMint: true }: it answers url
// null plus a mintUrl() the touch calls only once the combined render is
// final.
const mintCombinedUrl = jest.fn(async () => 'https://portal.wavespestcontrol.com/pay/combined-token');
function payLink(overrides = {}) {
  return {
    url: null,
    mintUrl: mintCombinedUrl,
    balance: { total: 258, count: 2 },
    coveredInvoiceIds: ['inv-1', 'inv-2'],
    coveredInvoiceCents: { 'inv-1': 12900, 'inv-2': 12900 },
    ...overrides,
  };
}

// The claim/cadence/claim-clear ifs queue every successfully fired touch
// consumes, in order — shared by every scenario below.
// `combinedCheck: true` for a touch whose resolveCombinedVariant call
// reaches the stopped/paused/autopay_hold re-check (local finding #1) —
// i.e. it resolves 2+ covered invoices including its own — inserting the
// extra `invoice_followup_sequences` SELECT between the touch claim and
// the cadence advance, in the order fireTouch actually issues it. A
// resolveCombinedVariant call that returns null earlier (gate off, link
// unavailable, fewer than 2 covered invoices, …) never reaches that query.
function claimCycle(seq, sequenceUpdateChain, { combinedCheck = false } = {}) {
  return [
    chain({ first: { id: seq.id, customer_id: seq.customer_id, status: 'active', step_index: seq.step_index, next_touch_at: seq.next_touch_at, anchor_at: null } }),
    chain({ result: 1 }), // touch claim
    ...(combinedCheck ? [chain({ first: undefined })] : []), // resolveCombinedVariant's stopped/paused/autopay_hold check — no disqualifying row
    sequenceUpdateChain, // cadence advance
    chain({ result: 1 }), // claim clear
  ];
}

describe('GATE_DUNNING_COMBINED_MESSAGE — narrow rebuild', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
    process.env.GATE_DUNNING_COMBINED_MESSAGE = 'true';
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
    db.transaction = jest.fn(async (fn) => fn(db));
    db.raw = jest.fn((sql) => ({ sql }));
    db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
    ComposerLinks.buildPayBalanceLink.mockReset().mockResolvedValue(payLink());
    RailGuard.collectionsChannelPermitted.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GATE_DUNNING_COMBINED_MESSAGE;
  });

  test('2 open invoices: the touch renders the combined template, with the anchor keeping the SAME ledger key a single touch would use', async () => {
    const sequenceUpdate = chain();
    const seq = followupRow();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [seq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), // claim-txn row lock read
        chain({ first: invoice() }), // liveInvoice (third-party payer re-check)
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant — local findings #2/#3)
        chain({ result: [ // resolveCombinedVariant's per-invoice line lookup
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }), // sendFollowupEmail's own fresh read
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: claimCycle(seq, sequenceUpdate, { combinedCheck: true }),
    });

    await InvoiceFollowUps.runPending();

    expect(ComposerLinks.buildPayBalanceLink).toHaveBeenCalledWith(['cust-1'], { deferMint: true });
    expect(mintCombinedUrl).toHaveBeenCalledTimes(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'invoice_followup_combined_3day',
      expect.objectContaining({ first_name: 'Taylor', invoice_count: '2', total_due: '258.00', pay_url: 'https://portal.wavespestcontrol.com/pay/combined-token' }),
      expect.objectContaining({ workflow: 'invoice_followup_combined' }),
    );
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_combined_3_day',
      // The anchor IS the single touch — same idempotency identity.
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
      payload: expect.objectContaining({
        invoice_count: 2,
        // The email leg gets the '$' prefix the template's shared
        // paragraph text doesn't supply itself; the SMS leg (asserted
        // above) keeps the bare numeric string its own template's literal
        // '$' already supplies.
        total_due: '$258.00',
        pay_url: 'https://portal.wavespestcontrol.com/pay/combined-token',
        invoices: [
          { invoice_number: 'WPC-2026-1042', invoice_title: 'Quarterly Pest Control', amount_due: '$129.00' },
          { invoice_number: 'WPC-2026-1055', invoice_title: 'Lawn Care', amount_due: '$129.00' },
        ],
      }),
    }));
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      // Same followup-sequence notificationEventKey a single touch renders.
      metadata: expect.objectContaining({ notificationEventKey: 'invoice-followup:seq-1:d3_friendly' }),
    }));
  });

  test('gate off: the same 2-invoice customer gets two independent single-invoice touches, byte-identical to before this lane', async () => {
    delete process.env.GATE_DUNNING_COMBINED_MESSAGE;
    const seq1 = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const seq2 = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z' });
    const update1 = chain();
    const update2 = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [seq1, seq2] })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice({ id: 'inv-2', invoice_number: 'WPC-2026-1055' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), chain(), chain()],
      invoice_followup_sequences: [...claimCycle(seq1, update1), ...claimCycle(seq2, update2)],
    });

    await InvoiceFollowUps.runPending();

    expect(ComposerLinks.buildPayBalanceLink).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
    for (const call of EmailTemplates.sendTemplate.mock.calls) {
      expect(call[0].templateKey).toBe('invoice.followup_3_day');
    }
    expect(update1.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    expect(update2.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('2 due rows, same customer: the anchor (oldest invoice) sends combined; the sibling advances its OWN step in lockstep and re-times on its own cadence, plus a best-effort audit row', async () => {
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    // Sibling is the NEWER invoice — never the anchor.
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    const sequenceUpdate = chain();
    // The live re-read under the invoice lock (Codex round-1 P1 + local
    // finding #6) — same shape the batch snapshot carries, proving the
    // advance re-derives from it rather than the stale `sibling` object.
    const siblingLiveRead = chain({ first: {
      id: siblingSeq.id, customer_id: siblingSeq.customer_id, status: 'active',
      step_index: siblingSeq.step_index, next_touch_at: siblingSeq.next_touch_at, anchor_at: null,
    } });
    const siblingUpdate = chain();
    const siblingAudit = chain();
    const siblingInvoiceLock = chain({ first: invoice({ id: 'inv-2' }) });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [siblingSeq, anchorSeq] })], // batch order should not matter
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }),
        chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }),
        siblingInvoiceLock,
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), siblingAudit],
      invoice_followup_sequences: [
        ...claimCycle(anchorSeq, sequenceUpdate, { combinedCheck: true }), siblingLiveRead, siblingUpdate,
      ],
    });

    await InvoiceFollowUps.runPending();

    // Only the anchor actually sent anything.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
    }));

    // The sibling: its OWN step advances by one (lockstep with the anchor)
    // — never left frozen at its original step while real time (and the
    // anchor's cadence) moves on — and re-times to ITS OWN cadence-
    // appropriate interval (d7_reminder, +7 days from ITS OWN
    // invoice_created_at at 10am NY), never a copy of the anchor's own
    // next_touch_at (the two invoices can be on very different cadences).
    // Still active (it has steps left).
    // Advanced under the sibling invoice's row lock, and only from the LIVE
    // re-read's own state (same step, same owner, same next_touch_at,
    // not claimed by a worker) — pinned so a concurrent reschedule between
    // the read and this write makes the advance a no-op.
    expect(siblingInvoiceLock.forUpdate).toHaveBeenCalled();
    expect(siblingUpdate.where).toHaveBeenCalledWith({
      id: 'seq-2', status: 'active', step_index: 0, customer_id: 'cust-1',
      next_touch_at: siblingSeq.next_touch_at,
    });
    const siblingPatch = siblingUpdate.update.mock.calls[0][0];
    expect(siblingPatch.step_index).toBe(1);
    expect(siblingPatch.status).toBe('active');
    expect(siblingPatch.touches_sent).toEqual({ sql: 'touches_sent + 1' });
    expect(siblingPatch.next_touch_at).toEqual(new Date('2026-05-28T14:00:00.000Z'));
    // The pre-visit balance rail's 72h recent-contact guard reads
    // last_touch_at — a covered sibling must stamp it exactly like a
    // normal delivered follow-up would (local finding A).
    expect(siblingPatch.last_touch_at).toBe('CURRENT_TIMESTAMP');
    // Confirms it's independent of the anchor's own new schedule, not a copy.
    expect(sequenceUpdate.update).toHaveBeenCalled();

    // A best-effort audit row records that the sibling was covered by this
    // run's combined touch, even though it never got its own fireTouch.
    expect(siblingAudit.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-1',
      metadata: expect.stringContaining('"invoice_id":"inv-2"'),
    }));
  });

  test('a retry that finds the anchor\'s combined legs already delivered advances the covered sibling instead of sending it its own reminder (Codex round-3 P1)', async () => {
    // Both anchor legs were delivered by an earlier attempt that threw
    // before its sequence update: with explicit billing channels, both
    // ledger claims answer delivered on this run.
    const ContactLedger = require('../services/collections/contact-ledger');
    ContactLedger.claimAttempt
      .mockResolvedValueOnce({ delivered: true })
      .mockResolvedValueOnce({ delivered: true });
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    const sequenceUpdate = chain();
    const siblingLiveRead = chain({ first: {
      id: siblingSeq.id, customer_id: siblingSeq.customer_id, status: 'active',
      step_index: siblingSeq.step_index, next_touch_at: siblingSeq.next_touch_at, anchor_at: null,
    } });
    const siblingUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }),
        chain({ first: invoice() }),
        chain({ first: invoice() }),
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }),
        chain({ first: invoice({ id: 'inv-2' }) }),
        // Spare capacity so a regression that fires the sibling on its own
        // can complete and show up as a send, not a queue error.
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [
        chain({ first: { email_enabled: true, invoice_channels: ['sms', 'email'] } }),
        chain({ first: { email_enabled: true, invoice_channels: ['sms', 'email'] } }),
      ],
      customer_interactions: [chain(), chain(), chain(), chain()],
      invoice_followup_sequences: [
        ...claimCycle(anchorSeq, sequenceUpdate, { combinedCheck: true }), siblingLiveRead, siblingUpdate,
        ...claimCycle(siblingSeq, chain()),
      ],
    });

    await InvoiceFollowUps.runPending();

    // Nothing new reaches the customer: the anchor's legs were deduped and
    // the sibling is advanced as covered, never sent its own reminder.
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(siblingUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('a combined candidate rejected after resolution never mints its pay-balance short link (Codex round-3 P2)', async () => {
    // Rejected by the aggregate collections-policy re-check, the last gate
    // before the mint.
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    RailGuard.collectionsChannelPermitted.mockImplementation(async ({ invoiceIds }) => !invoiceIds);
    try {
      const seq = followupRow();
      setDbQueues({
        'invoice_followup_sequences as s': [chain({ result: [seq] })],
        customers: [chain({ first: customer() })],
        invoices: [
          chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }),
          chain({ result: [
            { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
            { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
          ] }),
          chain({ first: invoice() }), chain({ first: invoice() }),
        ],
        notification_prefs: [chain({ first: { email_enabled: true } })],
        customer_interactions: [chain(), chain()],
        invoice_followup_sequences: claimCycle(seq, chain(), { combinedCheck: true }),
      });

      await InvoiceFollowUps.runPending();

      expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
      expect(mintCombinedUrl).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_COLLECTIONS_POLICY;
    }
  });

  test('a sibling invoice paid after the batch select is neither advanced nor logged as covered', async () => {
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    const sequenceUpdate = chain();
    const siblingAudit = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }),
        chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }),
        chain({ first: invoice({ id: 'inv-2', status: 'paid' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), siblingAudit],
      invoice_followup_sequences: claimCycle(anchorSeq, sequenceUpdate, { combinedCheck: true }),
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    // No sibling sequence write was attempted (the queue would have thrown
    // "Unexpected db table" otherwise) and no audit row claims it was covered.
    expect(siblingAudit.insert).not.toHaveBeenCalled();
  });

  test('the anchor is held (no channel delivered) — the sibling fires through its OWN normal touch instead of being re-timed', async () => {
    // Anchor: no phone, and the billing-email authority read fails —
    // mirrors the existing "retryable email refusal holds the touch"
    // single-invoice case (invoice-followups-email.test.js): the touch is
    // held (step unchanged, re-timed to a retry floor), never sent.
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    const anchorHold = chain();
    const siblingSend = chain();
    // No combined variant this run (link unavailable) — isolates the
    // held/fires-normally grouping behavior from template selection, and
    // doubles as the "link can't be built -> single template" case.
    ComposerLinks.buildPayBalanceLink.mockResolvedValue({ url: null, balance: null, coveredInvoiceIds: null, coveredInvoiceCents: null });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      customers: [chain({ first: customer({ phone: null }) }), chain({ first: customer() })],
      invoices: [
        // anchor: claim lock + liveInvoice + refresh + sendFollowupEmail's own
        // read (reached and refused there, before any provider handoff).
        chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }),
        // sibling: claim lock + liveInvoice + refresh + sendFollowupEmail's own read
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: {} }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: anchorSeq.next_touch_at, anchor_at: null } }),
        chain({ result: 1 }), // anchor touch claim
        anchorHold, // held — next_touch_at only, no step_index/status
        chain({ result: 1 }), // anchor claim clear
        ...claimCycle(siblingSeq, siblingSend),
      ],
    });
    BillingEmailAuthority.loadBillingEmailContext.mockRejectedValueOnce(new Error('connection terminated'));

    await InvoiceFollowUps.runPending();

    // Anchor never sent.
    const anchorPatch = anchorHold.update.mock.calls[0][0];
    expect(anchorPatch).not.toHaveProperty('step_index');
    expect(anchorPatch).not.toHaveProperty('status');

    // Sibling fired through its OWN normal touch (single-invoice template —
    // the link was unavailable), not deferred/re-timed.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
      idempotencyKey: 'invoice_followup_email:inv-2:d3_friendly',
    }));
    expect(siblingSend.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('a sibling already at a HIGHER step than the anchor fires normally even though the anchor sent', async () => {
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z', step_index: 0 });
    // Higher step (d7_reminder) — further along than the anchor.
    const siblingSeq = followupRow({
      id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 1,
    });
    const anchorUpdate = chain();
    const siblingUpdate = chain();
    // No combined variant needed to isolate the step-precedence rule.
    ComposerLinks.buildPayBalanceLink.mockResolvedValue({ url: null, balance: null, coveredInvoiceIds: null, coveredInvoiceCents: null });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), chain(), chain()],
      invoice_followup_sequences: [...claimCycle(anchorSeq, anchorUpdate), ...claimCycle(siblingSeq, siblingUpdate)],
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
    // The higher-step sibling advances its OWN step (1 -> 2), not re-timed
    // in place.
    expect(siblingUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 2 }));
    // Only the anchor may render combined: the sibling's own touch never
    // resolves a combined variant, so the customer cannot get a second
    // "N invoices" message in the same run.
    expect(ComposerLinks.buildPayBalanceLink).toHaveBeenCalledTimes(1);
  });

  test('the Day 90 final notice is never combined: the oldest invoice gets its own final notice and a young sibling fires on its own', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    try {
      const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-02-20T12:00:00.000Z', step_index: 5 });
      const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
      const anchorUpdate = chain();
      const siblingUpdate = chain();
      setDbQueues({
        // First read: the ladder's legacy-finish revival pass (nothing to revive).
        'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [anchorSeq, siblingSeq] })],
        customers: [chain({ first: customer() }), chain({ first: customer() })],
        invoices: [
          chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }),
          chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        ],
        notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
        customer_interactions: [chain(), chain(), chain(), chain()],
        invoice_followup_sequences: [...claimCycle(anchorSeq, anchorUpdate), ...claimCycle(siblingSeq, siblingUpdate)],
      });

      await InvoiceFollowUps.runPending();

      // No combined variant is even resolved for the final notice, and the
      // sibling may never resolve one either.
      expect(ComposerLinks.buildPayBalanceLink).not.toHaveBeenCalled();
      expect(smsTemplates.getTemplate).not.toHaveBeenCalledWith(
        'invoice_followup_combined_90day', expect.anything(), expect.anything(),
      );
      expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
      expect(siblingUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    } finally {
      delete process.env.GATE_DUNNING_LADDER_90;
    }
  });

  test('invoice_count/total_due come from the pay-balance link\'s own snapshot, not from how many rows are due this run', async () => {
    // Only ONE row is due this run, but the customer has 3 open invoices
    // (buildPayBalanceLink's own balance — e.g. a paid or not-yet-due one
    // is excluded/included independent of today's batch).
    const seq = followupRow();
    const sequenceUpdate = chain();
    ComposerLinks.buildPayBalanceLink.mockResolvedValue(payLink({
      balance: { total: 387, count: 3 },
      coveredInvoiceIds: ['inv-1', 'inv-2', 'inv-3'],
      coveredInvoiceCents: { 'inv-1': 12900, 'inv-2': 12900, 'inv-3': 12900 },
    }));
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [seq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }),
        chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-1055', title: 'Lawn Care' },
          { id: 'inv-3', invoice_number: 'WPC-1099', title: 'Tree & Shrub' },
        ] }),
        chain({ first: invoice() }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: claimCycle(seq, sequenceUpdate, { combinedCheck: true }),
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ invoice_count: 3, total_due: '$387.00' }),
    }));
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'invoice_followup_combined_3day',
      expect.objectContaining({ invoice_count: '3', total_due: '387.00' }),
      expect.anything(),
    );
  });

  test('a sibling whose lockstep advance runs it off the end of the ladder completes, same as a normal final touch', async () => {
    // Legacy (gate-off ladder) cadence is 4 steps (d3/d7/d14/d30, indices
    // 0-3) — both rows are on the LAST step this run, so the sibling's
    // lockstep +1 runs off the end (the anchor stays the older invoice).
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z', step_index: 3 });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 3 });
    const sequenceUpdate = chain();
    const siblingLiveRead = chain({ first: {
      id: siblingSeq.id, customer_id: siblingSeq.customer_id, status: 'active',
      step_index: siblingSeq.step_index, next_touch_at: siblingSeq.next_touch_at, anchor_at: null,
    } });
    const siblingUpdate = chain();
    const siblingAudit = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }),
        chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), siblingAudit],
      invoice_followup_sequences: [
        ...claimCycle(anchorSeq, sequenceUpdate, { combinedCheck: true }), siblingLiveRead, siblingUpdate,
      ],
    });

    await InvoiceFollowUps.runPending();

    const siblingPatch = siblingUpdate.update.mock.calls[0][0];
    expect(siblingPatch.step_index).toBe(4);
    expect(siblingPatch.status).toBe('completed');
    expect(siblingPatch.next_touch_at).toBeNull();
    expect(siblingAudit.insert).toHaveBeenCalled();
  });

  test('the anchor sends combined, but the pay-balance link excludes the sibling\'s own invoice — the sibling fires normally, never marked covered', async () => {
    // The customer has a THIRD open invoice (inv-3, not due this run) that
    // buildPayBalanceLink's own eligibility DOES include — e.g. the
    // sibling (inv-2) has a different payer or an ineligible status the
    // link excludes for its own reasons. The anchor's combined message
    // therefore names inv-1 + inv-3, never inv-2: the due sibling must
    // fire through its own normal touch, not be silently marked covered.
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    const sequenceUpdate = chain();
    const siblingSend = chain();
    ComposerLinks.buildPayBalanceLink.mockResolvedValue(payLink({
      coveredInvoiceIds: ['inv-1', 'inv-3'],
      coveredInvoiceCents: { 'inv-1': 12900, 'inv-3': 12900 },
    }));
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-3', invoice_number: 'WPC-2026-1088', title: 'Mosquito' },
        ] }),
        chain({ first: invoice() }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), chain(), chain()],
      invoice_followup_sequences: [
        ...claimCycle(anchorSeq, sequenceUpdate, { combinedCheck: true }), ...claimCycle(siblingSeq, siblingSend),
      ],
    });

    await InvoiceFollowUps.runPending();

    // The anchor rendered combined (naming inv-1 + inv-3)...
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_combined_3_day',
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
    }));
    // ...but the sibling (inv-2, excluded from the link) fired its OWN
    // normal single-invoice touch instead of being deferred/marked covered.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
      idempotencyKey: 'invoice_followup_email:inv-2:d3_friendly',
    }));
    expect(siblingSend.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  // ---------------------------------------------------------------------
  // Correctness-review findings (local #1-#5 + Codex round-1 A/B) — each
  // proven to fail with its own fix reverted.
  // ---------------------------------------------------------------------

  test('a covered sibling on a stopped/paused/autopay-held sequence disqualifies the combined render (finding #1)', async () => {
    // buildPayBalanceLink's own filter (mocked here, per the suite header)
    // still reports inv-2 as covered — only THIS invoice's own
    // invoice_followup_sequences status re-check catches that it is
    // paused. Never filter the set down: fall back to the single template
    // entirely (the pay page would still charge the excluded invoice).
    const seq = followupRow();
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [seq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), // claim-txn row lock read
        chain({ first: invoice() }), // liveInvoice
        chain({ first: invoice() }), // pre-dun refresh
        chain({ first: invoice() }), // sendFollowupEmail's own fresh read
        // No "resolveCombinedVariant per-invoice line lookup" read — the
        // disqualifying status short-circuits before it.
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: seq.id, customer_id: seq.customer_id, status: 'active', step_index: seq.step_index, next_touch_at: seq.next_touch_at, anchor_at: null } }),
        chain({ result: 1 }), // touch claim
        // The stopped/paused/autopay_hold re-check finds inv-2 paused.
        chain({ first: { invoice_id: 'inv-2' } }),
        sequenceUpdate, // cadence advance
        chain({ result: 1 }), // claim clear
      ],
    });

    await InvoiceFollowUps.runPending();

    // The link WAS built (resolveCombinedVariant got that far)...
    expect(ComposerLinks.buildPayBalanceLink).toHaveBeenCalledWith(['cust-1'], { deferMint: true });
    // ...but the touch fell back to the single-invoice template.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
    }));
    expect(smsTemplates.getTemplate).not.toHaveBeenCalledWith(
      'invoice_followup_combined_3day', expect.anything(), expect.anything(),
    );
  });

  test('resolveCombinedVariant runs AFTER the account-credit draw and the pre-dun invoice refresh, never before them (findings #2/#3)', async () => {
    const seq = followupRow();
    const sequenceUpdate = chain();
    const CustomerCredit = require('../services/customer-credit');
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [seq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), // claim-txn row lock read
        chain({ first: invoice() }), // liveInvoice
        chain({ first: invoice() }), // pre-dun refresh (now BEFORE resolveCombinedVariant)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }), // sendFollowupEmail's own fresh read
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: claimCycle(seq, sequenceUpdate, { combinedCheck: true }),
    });

    await InvoiceFollowUps.runPending();

    expect(CustomerCredit.autoApplyAccountCreditIfEnabled).toHaveBeenCalled();
    expect(ComposerLinks.buildPayBalanceLink).toHaveBeenCalled();
    // The credit draw (and, transitively, the pre-dun refresh that follows
    // it) completed strictly BEFORE resolveCombinedVariant read the
    // pay-balance link — reverting findings #2/#3's reordering would put
    // buildPayBalanceLink's call FIRST, failing this comparison.
    expect(CustomerCredit.autoApplyAccountCreditIfEnabled.mock.invocationCallOrder[0])
      .toBeLessThan(ComposerLinks.buildPayBalanceLink.mock.invocationCallOrder[0]);
  });

  test('mdPending (microdeposit diversion) is decided before combinedVariant — a diverted touch never resolves or renders combined copy (finding #2)', async () => {
    const mdSpy = jest.spyOn(StripeService, 'isInvoiceAwaitingMicrodepositVerification').mockResolvedValue(true);
    try {
      const seq = followupRow({ invoice_stripe_pi: 'pi_test_1' });
      const sequenceUpdate = chain();
      setDbQueues({
        'invoice_followup_sequences as s': [chain({ result: [seq] })],
        customers: [chain({ first: customer() })],
        invoices: [
          chain({ first: invoice() }), // claim-txn row lock read
          chain({ first: invoice() }), // liveInvoice
          chain({ first: invoice() }), // pre-dun refresh
          // No combinedVariant-related invoice read at all.
        ],
        notification_prefs: [chain({ first: { email_enabled: true } })],
        customer_interactions: [chain()],
        // No sms_templates/email_templates/invoice_followup_sequences
        // combined-check reads either — resolveCombinedVariant is never
        // even called.
        invoice_followup_sequences: claimCycle(seq, sequenceUpdate),
      });

      await InvoiceFollowUps.runPending();

      // combinedVariant's own resolution never runs while mdPending.
      expect(ComposerLinks.buildPayBalanceLink).not.toHaveBeenCalled();
      // The touch diverted to the bank-verification nudge.
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ original_message_type: 'bank_verification_incomplete' }),
      }));
    } finally {
      mdSpy.mockRestore();
    }
  });

  test('sendNextTouchNow ("send now") never combines — an operator-targeted single invoice never resolves a combined variant (finding #4)', async () => {
    const seq = followupRow();
    const sequenceUpdate = chain();
    setDbQueues({
      invoice_followup_sequences: [
        chain({ first: { id: seq.id, invoice_id: seq.invoice_id, status: 'active' } }), // initial lookup by invoice_id
        chain({ result: 1 }), // temp-activate update
        ...claimCycle(seq, sequenceUpdate), // the normal fireStep claim/cadence cycle — no combinedCheck entry
      ],
      'invoice_followup_sequences as s': [chain({ first: seq })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), // sendNextTouchNow's own terminal check
        chain({ first: invoice() }), // claim-txn row lock read
        chain({ first: invoice() }), // liveInvoice
        chain({ first: invoice() }), // pre-dun refresh
        chain({ first: invoice() }), // sendFollowupEmail's own fresh read
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
    });

    await InvoiceFollowUps.sendNextTouchNow('inv-1');

    // allowCombined:false short-circuits resolveCombinedVariant entirely.
    expect(ComposerLinks.buildPayBalanceLink).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
    }));
  });

  test('a combined touch whose SMS leg is held outside the send window is never queued frozen — the step holds for a fresh re-render instead (finding #5)', async () => {
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', deferred: true,
      nextAllowedAt: '2026-05-27T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED',
    });
    const seq = followupRow();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [seq] })],
      customers: [chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain()], // only the email audit row — the touch never reaches its normal completion
      invoice_followup_sequences: [
        chain({ first: { id: seq.id, customer_id: seq.customer_id, status: 'active', step_index: seq.step_index, next_touch_at: seq.next_touch_at, anchor_at: null } }),
        chain({ result: 1 }), // touch claim
        chain({ first: undefined }), // resolveCombinedVariant's stopped/paused/autopay_hold check
        chain({ result: 1 }), // the held-touch next_touch_at-only update (smsHoldUnowned branch)
        chain({ result: 1 }), // claim clear
      ],
      // A working queue entry so that, if this fix were reverted, the old
      // enqueue attempt would SUCCEED (proving the assertion below catches
      // the regression itself, not an incidental "table not queued" throw).
      sms_log: [chain()],
    });

    await InvoiceFollowUps.runPending();

    expect(db).not.toHaveBeenCalledWith('sms_log');
    // The email leg still delivered the combined copy.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_combined_3_day',
    }));
  });

  test('a partially delivered combined touch (email delivered, SMS held unowned) does not fire the covered sibling individually (Codex round-1 P1, finding B)', async () => {
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', deferred: true,
      nextAllowedAt: '2026-05-27T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED',
    });
    const siblingCadenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      // The 2nd entry is only consumed if this finding were reverted and
      // the sibling fired individually — harmless and unused while the
      // fix holds.
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (anchor)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }), // sendFollowupEmail read (anchor)
        // Only consumed if this finding were reverted and the sibling
        // fired individually — harmless and unused while the fix holds.
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: anchorSeq.id, customer_id: anchorSeq.customer_id, status: 'active', step_index: anchorSeq.step_index, next_touch_at: anchorSeq.next_touch_at, anchor_at: null } }),
        chain({ result: 1 }), // touch claim
        chain({ first: undefined }), // resolveCombinedVariant's stopped/paused/autopay_hold check
        chain({ result: 1 }), // the held-touch next_touch_at-only update (smsHoldUnowned branch)
        chain({ result: 1 }), // claim clear
        // Only consumed if the sibling were fired individually (reverted).
        ...claimCycle(siblingSeq, siblingCadenceUpdate),
      ],
      sms_log: [chain()],
    });

    await InvoiceFollowUps.runPending();

    // Only the anchor's combined email went out — the sibling was never
    // fired individually (a second, single-invoice send for inv-2 would
    // otherwise dun the customer twice in one run for invoices its own
    // combined message already named).
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_combined_3_day',
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
    }));
  });

  // ---------------------------------------------------------------------
  // Codex round 2 (#5270) — each proven to fail with its own fix reverted.
  // ---------------------------------------------------------------------

  test('a covered invoice awaiting microdeposit verification disqualifies the combined render, even when the ANCHOR itself is not the one blocked (round-2 finding #1)', async () => {
    // The anchor (inv-1, row.invoice_id) is NOT itself microdeposit-blocked
    // — its own mdPending check passes — but buildPayBalanceLink's anchor
    // (the oldest open invoice across the account) can legitimately differ
    // from THIS touch's row.invoice_id, and a DIFFERENT covered invoice
    // (inv-2) can be awaiting verification. The combined text must not dun
    // the customer for money inv-2 isn't ready to collect yet.
    const mdSpy = jest.spyOn(StripeService, 'isInvoiceAwaitingMicrodepositVerification')
      .mockImplementation(async ({ id }) => id === 'inv-2');
    try {
      const seq = followupRow();
      const sequenceUpdate = chain();
      setDbQueues({
        'invoice_followup_sequences as s': [chain({ result: [seq] })],
        customers: [chain({ first: customer() })],
        invoices: [
          chain({ first: invoice() }), // claim-txn row lock read
          chain({ first: invoice() }), // liveInvoice
          chain({ first: invoice() }), // pre-dun refresh
          chain({ result: [
            { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control', stripe_payment_intent_id: null },
            { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care', stripe_payment_intent_id: 'pi_inv2' },
          ] }),
          chain({ first: invoice() }), // sendFollowupEmail's own fresh read
        ],
        notification_prefs: [chain({ first: { email_enabled: true } })],
        customer_interactions: [chain(), chain()],
        invoice_followup_sequences: claimCycle(seq, sequenceUpdate, { combinedCheck: true }),
      });

      await InvoiceFollowUps.runPending();

      // The link WAS built (resolveCombinedVariant got that far)...
      expect(ComposerLinks.buildPayBalanceLink).toHaveBeenCalledWith(['cust-1'], { deferMint: true });
      expect(mdSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-2', stripe_payment_intent_id: 'pi_inv2' }));
      // ...but the touch fell back to the single-invoice template.
      expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
        templateKey: 'invoice.followup_3_day',
      }));
    } finally {
      mdSpy.mockRestore();
    }
  });

  test('the anchor throwing after the email delivered does not fire or advance its siblings (round-2 finding #2)', async () => {
    // fireStep/fireTouch can throw AFTER a leg already delivered — here,
    // the FINAL step_index-advance write itself throws. fireOne's own
    // catch would normally swallow this into the same `undefined` outcome
    // an ordinary "nothing delivered" early return produces, and the
    // sibling loop would then fire inv-2 individually — a DUPLICATE
    // collection contact, since the email already told the customer about
    // both invoices. The fix must leave the sibling untouched instead.
    const anchorSeq = followupRow({ id: 'seq-1', invoice_id: 'inv-1', invoice_created_at: '2026-05-20T12:00:00.000Z' });
    const siblingSeq = followupRow({ id: 'seq-2', invoice_id: 'inv-2', invoice_created_at: '2026-05-21T12:00:00.000Z', step_index: 0 });
    const throwingCadenceUpdate = chain();
    throwingCadenceUpdate.update = jest.fn(() => Promise.reject(new Error('DB write failed mid-touch')));
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [anchorSeq, siblingSeq] })],
      // The 2nd entry is only consumed if this finding were reverted and
      // the sibling fired individually — harmless and unused while the
      // fix holds (same discipline as finding B's own test).
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      invoices: [
        chain({ first: invoice() }), chain({ first: invoice() }),
        chain({ first: invoice() }), // pre-dun refresh (anchor)
        chain({ result: [
          { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
          { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
        ] }),
        chain({ first: invoice() }), // sendFollowupEmail read (anchor)
        // Only consumed if this finding were reverted and the sibling
        // fired individually — harmless and unused while the fix holds.
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
        chain({ first: invoice({ id: 'inv-2' }) }), chain({ first: invoice({ id: 'inv-2' }) }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      // Only the email audit log is guaranteed — the final "Log to
      // customer_interactions" insert is never reached for the anchor
      // because the write before it throws; 2 more spare entries are only
      // consumed if the sibling fired individually (reverted).
      customer_interactions: [chain(), chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: anchorSeq.id, customer_id: anchorSeq.customer_id, status: 'active', step_index: anchorSeq.step_index, next_touch_at: anchorSeq.next_touch_at, anchor_at: null } }),
        chain({ result: 1 }), // touch claim
        chain({ first: undefined }), // resolveCombinedVariant's stopped/paused/autopay_hold check
        throwingCadenceUpdate, // the step_index-advance write throws
        chain({ result: 1 }), // claim clear (fireStep's own finally, unconditional)
        // Only consumed if the sibling fired individually (reverted).
        ...claimCycle(siblingSeq, chain()),
      ],
    });

    await InvoiceFollowUps.runPending();

    // Only the anchor's combined email went out — the sibling was never
    // fired individually.
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_combined_3_day',
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
    }));
  });

  test('GATE_COLLECTIONS_POLICY on: an aggregate verdict that denies a covered invoice falls the touch back to the single-invoice template (round-2 finding #3)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    try {
      // The single-invoice verdict (row.invoice_id only) allows every
      // selected channel; the SAME channels' verdict against the full
      // combined set (coveredInvoiceIds) denies — a covered sibling can
      // carry its own collections denial the single-invoice check never
      // sees.
      RailGuard.collectionsChannelPermitted.mockImplementation(async ({ invoiceIds }) => !invoiceIds);
      const seq = followupRow();
      const sequenceUpdate = chain();
      setDbQueues({
        'invoice_followup_sequences as s': [chain({ result: [seq] })],
        customers: [chain({ first: customer() })],
        invoices: [
          chain({ first: invoice() }), // claim-txn row lock read
          chain({ first: invoice() }), // liveInvoice
          chain({ first: invoice() }), // pre-dun refresh
          chain({ result: [
            { id: 'inv-1', invoice_number: 'WPC-2026-1042', title: 'Quarterly Pest Control' },
            { id: 'inv-2', invoice_number: 'WPC-2026-1055', title: 'Lawn Care' },
          ] }), // resolveCombinedVariant's per-invoice line lookup — reached; the fallback happens AFTER
          chain({ first: invoice() }), // sendFollowupEmail's own fresh read
        ],
        notification_prefs: [chain({ first: { email_enabled: true } })],
        customer_interactions: [chain(), chain()],
        invoice_followup_sequences: claimCycle(seq, sequenceUpdate, { combinedCheck: true }),
      });

      await InvoiceFollowUps.runPending();

      // The link WAS built and the single-invoice verdict WAS consulted
      // (row.invoice_id alone)...
      expect(ComposerLinks.buildPayBalanceLink).toHaveBeenCalledWith(['cust-1'], { deferMint: true });
      expect(RailGuard.collectionsChannelPermitted).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: 'inv-1' }),
      );
      // ...and the aggregate re-check against the covered set WAS run...
      expect(RailGuard.collectionsChannelPermitted).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceIds: ['inv-1', 'inv-2'] }),
      );
      // ...but it denied, so the touch fell back to the single template —
      // never a channel silently dropped from an otherwise-combined send.
      expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
        templateKey: 'invoice.followup_3_day',
      }));
    } finally {
      delete process.env.GATE_COLLECTIONS_POLICY;
    }
  });
});
