/**
 * previsit-balance-reminder × explicit per-channel billing delivery choice
 * (PR #4843 router-core activation checklist item for this file: "records
 * ledger per channel but the sidecar Email ignores the explicit selection;
 * same per-channel ledger issue as annual-prepay — any acceptance read as
 * delivered").
 *
 * Scope: this file pins ONLY the explicit-selection branch — which channels
 * `sendReminderChannels` (billing-reminder-delivery.js) is invoked with, the
 * deterministic per-appointment eventKey, the `send` callback's per-channel
 * dispatch (email vs sms/push), and how the one-per-appointment claim reacts
 * to a delivered / held / terminal episode. `sendReminderChannels` itself —
 * its ledger-episode bookkeeping, replay-hold semantics, and per-channel
 * independence — is a shared module previsit-balance-reminder.js does not
 * own; it is mocked at the module boundary here and exercised for real in
 * billing-reminder-delivery.test.js. The legacy no-explicit-selection sms+
 * email path (byte-identical to before this lane) stays pinned in
 * collections-previsit-rail-policy.test.js.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/billing-lane', () => ({
  resolveBillingLane: jest.fn(() => ({ mode: 'per_visit' })),
  monthlyDuesCollected: jest.fn(async () => false),
}));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn((inv) => Number(inv.total)),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'previsit balance sms body'),
}));
jest.mock('../services/account-membership-email', () => ({
  resolvePrevisitBalanceEmailRecipient: jest.fn(async () => ({ recipient: { email: 'taylor@example.com' } })),
  sendPrevisitBalanceReminder: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelVerdict: jest.fn(async () => ({ permitted: true, eligibleInvoiceIds: null })),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
}));
jest.mock('../services/billing-reminder-delivery', () => ({
  sendReminderChannels: jest.fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AccountMembershipEmail = require('../services/account-membership-email');
const { sendReminderChannels } = require('../services/billing-reminder-delivery');
const { runSweep } = require('../services/previsit-balance-reminder');

function chain({ result = [], first } = {}) {
  const q = {};
  [
    'where', 'whereIn', 'whereNull', 'whereNotNull', 'whereBetween',
    'join', 'leftJoin', 'orderBy', 'select', 'count', 'limit',
  ].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

const VISIT = {
  id: 'ss-1',
  customer_id: 'cust-1',
  service_type: 'Pest Control',
  scheduled_date: '2026-08-20',
  payer_id: null,
  first_name: 'Sandy',
  phone: '+19415550100',
  billing_mode: null,
  waveguard_tier: null,
  monthly_rate: null,
  billing_day: null,
};

const OVERDUE_INVOICE = {
  id: 'inv-9', total: '96.60', due_date: '2026-07-01',
  last_reminder_at: null, followup_last_touch_at: null,
};

function armOneVisit({ notificationPrefs = {} } = {}) {
  const claimChain = chain({ result: 1 });
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [VISIT] }), claimChain],
    invoices: [chain({ result: [OVERDUE_INVOICE] })],
    activity_log: [chain({ result: [] })],
    notification_prefs: [chain({ first: notificationPrefs })],
  });
  return { claimChain };
}

// Overrides scheduled_services' queue so a THIRD call to that table (the
// released-claim update) resolves instead of throwing "Unexpected db table".
function armReleaseChain() {
  const releaseChain = chain({ result: 1 });
  const originalImpl = db.getMockImplementation();
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      try { return originalImpl(table); } catch { return releaseChain; }
    }
    return originalImpl(table);
  });
  return releaseChain;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PREVISIT_BALANCE_REMINDER = 'true';
  sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
  AccountMembershipEmail.sendPrevisitBalanceReminder.mockResolvedValue({ ok: true });
});
afterEach(() => {
  delete process.env.PREVISIT_BALANCE_REMINDER;
});

// (a) No explicit selection ⇒ the new router path is never touched at all;
// the legacy sms+email sidecar runs exactly as it did before this lane.
test('no explicit billing_channels ⇒ sendReminderChannels is never called', async () => {
  armOneVisit({ notificationPrefs: {} });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
});

// (b) selection ['email'] ⇒ no SMS at all; email sent with its own ledger row.
test("explicit selection ['email'] ⇒ only the email leg is attempted, keyed to the visit", async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['email'] } });
  sendReminderChannels.mockImplementation(async ({ send }) => {
    const outcome = await send('email', { id: 'led-77' });
    return { complete: true, deliveredNow: outcome.ok ? ['email'] : [], results: { email: outcome } };
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels).toHaveBeenCalledWith(expect.objectContaining({
    customerId: 'cust-1',
    invoiceId: null,
    source: 'previsit_balance_reminder',
    purpose: 'balance_reminder',
    eventKey: 'previsit-balance:ss-1',
    channels: ['email'],
  }));
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).toHaveBeenCalledTimes(1);
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).toHaveBeenCalledWith(
    expect.objectContaining({ customerId: 'cust-1', idempotencyKey: 'billing.previsit_balance:ss-1' }),
  );
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
});

// (c) selection ['sms'] ⇒ no email sidecar; SMS carries the router-core leg
// metadata (billingDeliveryLeg + notificationEventKey + collections_ledger_id).
test("explicit selection ['sms'] ⇒ only the sms leg is attempted, with router-core leg metadata", async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['sms'] } });
  sendReminderChannels.mockImplementation(async ({ send }) => {
    const outcome = await send('sms', { id: 'led-88' });
    return { complete: true, deliveredNow: outcome.sent ? ['sms'] : [], results: { sms: outcome } };
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    channel: 'sms',
    to: VISIT.phone,
    hasEmailLeg: true,
    metadata: expect.objectContaining({
      billingDeliveryCategory: 'billing',
      billingDeliveryLeg: 'sms',
      notificationEventKey: 'previsit-balance:ss-1',
      collections_ledger_id: 'led-88',
    }),
  }));
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
});

// (d) A replay hold (nothing delivered, episode still open) must leave the
// claim retryable — the NEXT sweep re-selects the same visit and drives
// sendReminderChannels again under the exact same deterministic event key,
// never a fresh one, so the shared module resumes the same reservation set.
test('a replay hold releases the claim and the next sweep reuses the same event key', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['email'] } });
  const releaseChain = armReleaseChain();
  sendReminderChannels.mockResolvedValueOnce({
    complete: false,
    deliveredNow: [],
    results: { email: { deferred: true, retryable: true, code: 'BILLING_EMAIL_PREPARATION_HOLD' } },
  });
  const firstResult = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(firstResult).toMatchObject({ sent: 0, skipped: 1 });
  expect(releaseChain.update).toHaveBeenCalledWith({ balance_reminder_sent_at: null });
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();

  // Next day: the claim was released, so the visit is picked up again.
  armOneVisit({ notificationPrefs: { billing_channels: ['email'] } });
  sendReminderChannels.mockResolvedValueOnce({ complete: true, deliveredNow: ['email'], results: {} });
  const secondResult = await runSweep({ now: new Date('2026-08-15T15:00:00Z') });
  expect(secondResult).toMatchObject({ sent: 1, skipped: 0 });

  expect(sendReminderChannels).toHaveBeenCalledTimes(2);
  const firstKey = sendReminderChannels.mock.calls[0][0].eventKey;
  const secondKey = sendReminderChannels.mock.calls[1][0].eventKey;
  expect(firstKey).toBe('previsit-balance:ss-1');
  expect(secondKey).toBe(firstKey);
});

// A COMPLETE episode where nothing ever delivered (e.g. every selected leg
// resolved as a terminal refusal) must NOT churn the claim daily forever —
// it is settled, not a reason to keep retrying.
test('a complete episode with nothing delivered keeps the claim (no infinite daily retry)', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['email'] } });
  sendReminderChannels.mockResolvedValueOnce({
    complete: true,
    deliveredNow: [],
    results: { email: { ok: false, skipped: true, reason: 'missing_email' } },
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
  // scheduled_services was only queried twice (select + claim) — no release.
  expect(db).toHaveBeenCalledWith('scheduled_services');
});

// (e) A failed leg must never mark a sibling leg delivered — each channel is
// attempted independently through its own `send` invocation, and the sweep's
// own sent/skipped accounting follows `deliveredNow` (the sibling's success),
// never inferred from the failed leg's own outcome.
test('a failed sms leg does not prevent an independently delivered email leg from counting as sent', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['sms', 'email'] } });
  sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'BILLING_CHANNEL_FAILED' });
  sendReminderChannels.mockImplementation(async ({ send }) => {
    const smsOutcome = await send('sms', { id: 'led-sms' });
    const emailOutcome = await send('email', { id: 'led-email' });
    return {
      complete: true,
      deliveredNow: emailOutcome.ok ? ['email'] : [],
      results: { sms: smsOutcome, email: emailOutcome },
    };
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
});
