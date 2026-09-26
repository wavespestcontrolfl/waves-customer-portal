// Explicit per-customer billing-channel selection for the annual-prepay
// payment reminder (router core, PR #4843 — dark until
// GATE_BILLING_NOTIFICATION_CHANNELS). This suite exercises the REAL
// billing-reminder-delivery.js / billing-delivery-channels.js plumbing
// (event key, per-leg ledger row, replay-hold retry) against an in-memory
// fake of the collections_contact_ledger table, so the assertions prove the
// actual router-core contract rather than a mocked pass-through.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipRenewalReminder: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../utils/portal-url', () => ({
  publicPortalUrl: jest.fn(() => 'https://portal.wavespestcontrol.com'),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn().mockResolvedValue(null),
  reverseAppliedCredit: jest.fn().mockResolvedValue(0),
}));
// Trivial pass-through, exactly like the sibling payment-reminder suite —
// real ContactPolicy consult only fires when GATE_COLLECTIONS_POLICY==='true'
// (unset in this suite), so this mock only removes that env coupling.
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));

// A realistic in-memory collections_contact_ledger, shared between the
// ContactLedger mock (the writer) and the fake db table (the reader
// billing-reminder-delivery.js's reminderProgress() queries) — this is what
// lets the REAL sendReminderChannels / reminderProgress code run unmodified
// against test data, including the reused-reservation retry semantics
// (claimAttempt) a replay-hold test needs.
global.__ledgerStore = [];
global.__ledgerSeq = 1;
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async ({
    customerId, channel, purpose, invoiceIds = [], source, metadata = null,
    occurredAt = new Date(), idempotencyKey = null,
  }) => {
    if (idempotencyKey) {
      const existing = global.__ledgerStore.find((r) => r.idempotency_key === idempotencyKey);
      if (existing) {
        existing.occurred_at = occurredAt;
        return { id: existing.id, metadata: existing.metadata || {}, reused: true };
      }
    }
    const row = {
      id: `led-${global.__ledgerSeq++}`,
      customer_id: customerId,
      channel,
      purpose,
      invoice_ids: invoiceIds,
      occurred_at: occurredAt,
      source,
      metadata: metadata || {},
      idempotency_key: idempotencyKey,
    };
    global.__ledgerStore.push(row);
    return { id: row.id, metadata: row.metadata };
  }),
  claimAttempt: jest.fn(async (entry) => {
    const row = global.__ledgerStore.find((r) => r.id === entry.id);
    if (!row) return { allowed: false, held: true };
    if (row.metadata?.delivered === true) return { allowed: false, delivered: true };
    if (!entry.reused) return { allowed: true };
    if (row.metadata?.send_failed !== true) return { allowed: false, held: true };
    row.metadata = { ...row.metadata, send_failed: false };
    return { allowed: true };
  }),
  markDelivered: jest.fn(async (target) => {
    const row = global.__ledgerStore.find((r) => r.id === target?.id);
    if (!row) return false;
    row.metadata = { ...row.metadata, delivered: true };
    return true;
  }),
  markSendFailed: jest.fn(async (entry, extra = {}) => {
    const row = global.__ledgerStore.find((r) => r.id === entry?.id);
    if (!row) return false;
    row.metadata = { ...row.metadata, send_failed: true, ...extra };
    return true;
  }),
}));

const db = require('../models/db');
const { autoApplyAccountCreditIfEnabled, reverseAppliedCredit } = require('../services/customer-credit');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

const REMINDER_COLS = {
  payment_reminder_3d_sent_at: {},
  payment_reminder_3d_claimed_at: {},
  payment_reminder_1d_sent_at: {},
  payment_reminder_1d_claimed_at: {},
};

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn', 'whereBetween', 'whereNotIn', 'whereNotNull', 'orderBy', 'select', 'join',
  ].forEach((method) => { q[method] = jest.fn(() => q); });
  q.whereNull = jest.fn(() => q);
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.orWhere = jest.fn(() => q);
  q.orWhereNotNull = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.columnInfo = jest.fn(async () => columnInfo || {});
  q.catch = jest.fn(() => Promise.resolve());
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

// Lives outside the per-table FIFO queue: reminderProgress() re-reads this
// table on every call, and a replay test needs it to reflect rows the
// (mocked) ContactLedger wrote earlier in the SAME test.
function ledgerChain() {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.whereIn = jest.fn(() => q);
  q.update = jest.fn(async () => 0);
  q.then = (resolve, reject) => Promise.resolve(global.__ledgerStore.map((r) => ({ ...r }))).then(resolve, reject);
  q.catch = () => Promise.resolve([]);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    if (table === 'collections_contact_ledger') return ledgerChain();
    if (table === 'email_messages') return query({ rows: [] });
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  return tableQueues;
}

const BASE_TERM = {
  id: 'term-1',
  customer_id: 'cust-1',
  prepay_invoice_id: 'inv-1',
  status: 'payment_pending',
  term_start: '2026-07-11',
  term_end: '2027-07-11',
  payment_reminder_3d_sent_at: null,
  payment_reminder_1d_sent_at: null,
};

const UNPAID_INVOICE = { id: 'inv-1', status: 'sent', total: '392.04', token: 'tok-1', payer_id: null };
const CUSTOMER = { id: 'cust-1', first_name: 'Aaron', phone: '+15550001111' };

// Standard db-queue rig any single-attempt scenario needs, up through the
// customer read and prefs lookup — the same tables the legacy path already
// touches, plus notification_prefs for the new explicit-channel check.
function standardQueues({ prefs, extraTermRows } = {}) {
  return {
    annual_prepay_terms: [
      query({ columnInfo: REMINDER_COLS }),
      query({ returning: [{ ...BASE_TERM }] }),
      // The explicit-channel path always issues a THIRD annual_prepay_terms
      // update after attempting delivery: either the sentCol stamp (episode
      // complete) or the claim release (still pending) — a caller who cares
      // which one fired passes its own extraTermRows to inspect it.
      ...(extraTermRows || [query()]),
    ],
    invoices: [
      query({ first: { ...UNPAID_INVOICE } }),
      query({ first: { ...UNPAID_INVOICE } }),
    ],
    invoice_followup_sequences: [query({ first: undefined })],
    customers: [query({ first: { ...CUSTOMER } })],
    notification_prefs: [query({ first: prefs })],
    customer_interactions: [query(), query(), query()],
  };
}

describe('annual prepay payment reminder — explicit billing-channel selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    global.__ledgerStore = [];
    global.__ledgerSeq = 1;
    _private.resetCachesForTests();
    renderSmsTemplate.mockResolvedValue('pay reminder body');
  });

  test('(a) no explicit selection (no notification_prefs row) — byte-identical legacy SMS send', async () => {
    setDbQueues(standardQueues({ prefs: undefined, extraTermRows: [query()] }));
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: true, termId: 'term-1' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', purpose: 'payment_link' }));
    // The legacy path's OWN pre-existing ContactLedger.recordContact call
    // (unrelated to the new explicit-channel rail) writes exactly one row —
    // proves the legacy path took over, not the new dispatcher (which would
    // key its row's metadata with a notificationEventKey; this one has none).
    expect(global.__ledgerStore).toHaveLength(1);
    expect(global.__ledgerStore[0]).toEqual(expect.objectContaining({ channel: 'sms' }));
    expect(global.__ledgerStore[0].metadata.notificationEventKey).toBeUndefined();
  });

  test('(a2) explicit array present but empty (gate off / no channels saved) — same legacy behavior', async () => {
    setDbQueues(standardQueues({ prefs: { billing_channels: null } }));
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: true, termId: 'term-1' });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  });

  test("(b) ['email'] — email leg only, ledger channel 'email', leg stays pending (no invented copy)", async () => {
    setDbQueues(standardQueues({ prefs: { billing_channels: ['email'] } }));

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(global.__ledgerStore).toHaveLength(1);
    expect(global.__ledgerStore[0]).toEqual(expect.objectContaining({
      channel: 'email',
      customer_id: 'cust-1',
      source: 'annual_prepay_payment_reminder',
    }));
    expect(global.__ledgerStore[0].metadata).toEqual(expect.objectContaining({ send_failed: true }));
    // No suitable email template exists yet — never delivered, and the term
    // is NOT stamped sent, so tomorrow's scan retries it.
    expect(result).toEqual({ sent: false, termId: 'term-1', complete: false });
  });

  test("(c) ['sms','email'] — two ledger rows share one event key; sms delivers, email leg stays pending", async () => {
    setDbQueues(standardQueues({ prefs: { billing_channels: ['email', 'sms'] } }));
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(global.__ledgerStore).toHaveLength(2);
    const byChannel = Object.fromEntries(global.__ledgerStore.map((r) => [r.channel, r]));
    expect(byChannel.email).toBeTruthy();
    expect(byChannel.sms).toBeTruthy();
    const emailKey = byChannel.email.metadata.notificationEventKey;
    const smsKey = byChannel.sms.metadata.notificationEventKey;
    expect(emailKey).toBe(smsKey);
    expect(emailKey).toBe(_private.paymentReminderEventKey('term-1', 1));
    expect(byChannel.sms.metadata.delivered).toBe(true);
    expect(byChannel.email.metadata.delivered).not.toBe(true);
    // sms delivered ⇒ a customer-visible touch happened ⇒ sent:true, but the
    // episode is not complete (email leg still open) ⇒ not stamped, retried.
    expect(result).toEqual({ sent: true, termId: 'term-1', complete: false });
  });

  test('(d) replay hold on sms leg — not delivered, retried next run under the SAME event key, then delivers', async () => {
    // Run 1: sms leg comes back as a deferred hold (e.g. quiet hours) — must
    // NOT be recorded delivered, and the reminder stays retryable.
    setDbQueues(standardQueues({ prefs: { billing_channels: ['sms'] } }));
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, deferred: true, retryable: true, deliveryOutcome: 'not_sent', code: 'QUIET_HOURS_HOLD',
    });

    const run1 = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);
    expect(run1).toEqual({ sent: false, termId: 'term-1', complete: false });
    expect(global.__ledgerStore).toHaveLength(1);
    expect(global.__ledgerStore[0].metadata.delivered).not.toBe(true);
    expect(global.__ledgerStore[0].metadata.send_failed).toBe(true);
    const eventKeyAfterRun1 = global.__ledgerStore[0].metadata.notificationEventKey;

    // Run 2 ("next run", claim released + sentCol still null): sms now
    // succeeds. Same term row (still unsent), fresh claim + invoice reads.
    // (Column-existence/schema caches are process-lifetime inside the
    // module — a real second cron tick is a fresh process; this test
    // clears them the same way to get a fresh DB read, not to change what's
    // under test.)
    _private.resetCachesForTests();
    setDbQueues(standardQueues({ prefs: { billing_channels: ['sms'] } }));
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' });

    const run2 = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(global.__ledgerStore).toHaveLength(1); // reused reservation, not a duplicate row
    expect(global.__ledgerStore[0].metadata.notificationEventKey).toBe(eventKeyAfterRun1);
    expect(global.__ledgerStore[0].metadata.delivered).toBe(true);
    expect(run2).toEqual({ sent: true, termId: 'term-1', complete: true });
  });

  test('(e) one leg failing terminally does not mark the other delivered, and vice versa', async () => {
    setDbQueues(standardQueues({ prefs: { billing_channels: ['email', 'sms'] } }));
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' }); // sms
    // email leg always returns the honest no-template stub (never invented copy)

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    const byChannel = Object.fromEntries(global.__ledgerStore.map((r) => [r.channel, r]));
    expect(byChannel.sms.metadata.delivered).toBe(true);
    expect(byChannel.email.metadata.delivered).not.toBe(true);
    expect(result).toEqual({ sent: true, termId: 'term-1', complete: false });
  });

  test('collections policy denial on every selected channel reverses the credit and releases the claim (no ledger write)', async () => {
    const railGuard = require('../services/collections/rail-guard');
    railGuard.collectionsChannelPermitted.mockResolvedValue(false);
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 40 });
    const releaseQ = query();
    setDbQueues(standardQueues({ prefs: { billing_channels: ['sms'] }, extraTermRows: [releaseQ] }));

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'collections_policy_denied' });
    expect(global.__ledgerStore).toHaveLength(0);
    expect(reverseAppliedCredit).toHaveBeenCalledWith(expect.objectContaining({ amount: 40 }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
