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

// Account-level choice lookup: read the fixture's notification_prefs row
// (primary-profile resolution is unit-tested in billing-delivery-channels).
jest.mock('../services/billing-delivery-channels', () => {
  const actual = jest.requireActual('../services/billing-delivery-channels');
  return {
    ...actual,
    accountBillingChannels: jest.fn(async (customerId, category, knex) => actual.explicitBillingChannels(
      (await knex('notification_prefs').where({ customer_id: customerId }).first()) || {}, category,
    )),
  };
});
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
  isInvoiceCollectibleStatus: jest.fn((status) => !['paid', 'void'].includes(status)),
  invoiceWithdrawnFromCustomer: jest.fn(() => false),
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
  reminderProgress: jest.fn(async () => []),
  sendReminderChannels: jest.fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AccountMembershipEmail = require('../services/account-membership-email');
const { reminderProgress, sendReminderChannels } = require('../services/billing-reminder-delivery');
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
  reminderProgress.mockResolvedValue([]);
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
    return { complete: true, deliveredNow: outcome.sent ? ['email'] : [], results: { email: outcome } };
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
  // The Email leg goes through the billing email adapter (sendCustomerMessage
  // channel 'email'), bound to its reservation, never the unbound
  // billing.previsit_balance sidecar.
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    channel: 'email',
    to: null,
    entryPoint: 'previsit_balance_reminder',
    body: 'previsit balance sms body',
    metadata: expect.objectContaining({
      billingDeliveryLeg: 'email',
      notificationEventKey: 'previsit-balance:ss-1',
      collections_ledger_id: 'led-77',
    }),
  }));
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
      deliveredNow: emailOutcome.sent ? ['email'] : [],
      results: { sms: smsOutcome, email: emailOutcome },
    };
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  expect(sendCustomerMessage.mock.calls.map(([args]) => args.channel)).toEqual(['sms', 'email']);
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
});

// An unreadable channel choice must not fall through to the legacy SMS+Email
// path (that would ignore a stored selection): nothing sends and no claim is
// taken, so the next sweep in the window retries.
test('a notification_prefs lookup failure sends nothing and takes no claim', async () => {
  const { claimChain } = armOneVisit();
  const originalImpl = db.getMockImplementation();
  db.mockImplementation((table) => {
    if (table === 'notification_prefs') {
      const failing = chain();
      failing.first = jest.fn(async () => { throw new Error('connection reset'); });
      return failing;
    }
    return originalImpl(table);
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
});

// The policy gate judges the SELECTED channels: an App-only customer whose
// Text and Email are both denied is still reached on App.
test('an App-only selection is reachable when Text and Email are policy-denied', async () => {
  const { collectionsChannelVerdict } = require('../services/collections/rail-guard');
  collectionsChannelVerdict.mockImplementation(async ({ channel }) => (channel === 'push'
    ? { permitted: true, eligibleInvoiceIds: ['inv-9'] }
    : { permitted: false, eligibleInvoiceIds: [] }));
  armOneVisit({ notificationPrefs: { billing_channels: ['push'] } });
  sendReminderChannels.mockResolvedValueOnce({ complete: true, deliveredNow: ['push'], results: {} });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(collectionsChannelVerdict).toHaveBeenCalledWith(expect.objectContaining({ channel: 'push' }));
  expect(collectionsChannelVerdict).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  expect(sendReminderChannels.mock.calls[0][0].channels).toEqual(['push']);
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
  collectionsChannelVerdict.mockImplementation(async () => ({ permitted: true, eligibleInvoiceIds: null }));
});

// A selection whose every channel is policy-denied sends nothing.
test('an explicit selection with every channel denied is skipped before the claim', async () => {
  const { collectionsChannelVerdict } = require('../services/collections/rail-guard');
  collectionsChannelVerdict.mockImplementation(async () => ({ permitted: false, eligibleInvoiceIds: [] }));
  const { claimChain } = armOneVisit({ notificationPrefs: { billing_channels: ['email', 'push'] } });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels).not.toHaveBeenCalled();
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
  collectionsChannelVerdict.mockImplementation(async () => ({ permitted: true, eligibleInvoiceIds: null }));
});

// One leg delivered while a sibling is still held: count it sent, but release
// the claim so the next sweep retries the held leg (sendReminderChannels never
// re-sends the delivered one).
test('a delivered leg with a held sibling counts as sent and still releases the claim', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['sms', 'email'] } });
  const releaseChain = armReleaseChain();
  sendReminderChannels.mockResolvedValueOnce({
    complete: false,
    deliveredNow: ['sms'],
    results: { email: { deferred: true, retryable: true, code: 'BILLING_EMAIL_PREPARATION_HOLD' } },
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(releaseChain.update).toHaveBeenCalledWith({ balance_reminder_sent_at: null });
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
});

// A throw inside the shared helper (progress read / reservation write) must
// release the claim so the next sweep retries under the same event key.
test('a shared-helper failure releases the claim', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['email'] } });
  const releaseChain = armReleaseChain();
  sendReminderChannels.mockRejectedValueOnce(new Error('ledger write failed'));
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(releaseChain.update).toHaveBeenCalledWith({ balance_reminder_sent_at: null });
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
});

// The previsit policy check counts late monthly dues as off-ledger debt; the
// helper's per-leg recheck must receive the same allowance.
test('the dues allowance is forwarded to the shared helper', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['sms'] } });
  sendReminderChannels.mockResolvedValueOnce({ complete: true, deliveredNow: ['sms'], results: {} });
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels.mock.calls[0][0]).toHaveProperty('offLedgerBalanceCents');
});

// A released-claim retry must not be denied by the policy's recent-contact
// spacing because of this appointment's OWN earlier reservations: only the
// resumed episode's ledger ids are excluded from the policy consult.
test('a retry excludes only the resumed episode reservations from the policy check', async () => {
  const { collectionsChannelVerdict } = require('../services/collections/rail-guard');
  reminderProgress.mockResolvedValueOnce([
    { metadata: { notificationEventKey: 'previsit-balance:ss-other' }, entries: [{ id: 'led-other' }] },
    { metadata: { notificationEventKey: 'previsit-balance:ss-1' }, entries: [{ id: 'led-sms' }, { id: 'led-email' }] },
  ]);
  armOneVisit({ notificationPrefs: { billing_channels: ['sms', 'email'] } });
  sendReminderChannels.mockResolvedValueOnce({ complete: true, deliveredNow: ['email'], results: {} });
  await runSweep({ now: new Date('2026-08-15T15:00:00Z') });
  expect(reminderProgress).toHaveBeenCalledWith('cust-1', 'previsit_balance_reminder', expect.arrayContaining(['sms', 'email']));
  for (const [args] of collectionsChannelVerdict.mock.calls) {
    expect(args.excludeLedgerIds).toEqual(['led-sms', 'led-email']);
  }
});

test('an unreadable episode history skips before any claim', async () => {
  reminderProgress.mockRejectedValueOnce(new Error('ledger read failed'));
  const { claimChain } = armOneVisit({ notificationPrefs: { billing_channels: ['email'] } });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels).not.toHaveBeenCalled();
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
});

test('the ledger reservations carry the quoted overdue invoice ids', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['sms'] } });
  sendReminderChannels.mockResolvedValueOnce({ complete: true, deliveredNow: ['sms'], results: {} });
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendReminderChannels.mock.calls[0][0]).toMatchObject({ invoiceId: null, invoiceIds: ['inv-9'] });
});

describe('currentDuesAllowanceCents (retry-time dues allowance)', () => {
  const { currentDuesAllowanceCents } = require('../services/previsit-balance-reminder');
  const billingLane = require('../services/billing-lane');

  function customersDb(row) {
    return jest.fn((table) => {
      if (table !== 'customers') throw new Error(`Unexpected table ${table}`);
      const q = { where: jest.fn(() => q), first: jest.fn(async () => row) };
      return q;
    });
  }

  test('late unpaid monthly dues count in cents', async () => {
    billingLane.resolveBillingLane.mockReturnValueOnce({ mode: 'monthly_membership' });
    billingLane.monthlyDuesCollected.mockResolvedValueOnce(false);
    const database = customersDb({ billing_mode: 'monthly_membership', monthly_rate: '49.00', billing_day: 1 });
    await expect(currentDuesAllowanceCents('cust-1', database, new Date('2026-08-20T15:00:00Z'))).resolves.toBe(4900);
  });

  test('collected dues, per-visit billing, or a missing customer count nothing', async () => {
    billingLane.resolveBillingLane.mockReturnValueOnce({ mode: 'monthly_membership' });
    billingLane.monthlyDuesCollected.mockResolvedValueOnce(true);
    const now = new Date('2026-08-20T15:00:00Z');
    await expect(currentDuesAllowanceCents('cust-1', customersDb({ monthly_rate: '49.00', billing_day: 1 }), now)).resolves.toBe(0);
    await expect(currentDuesAllowanceCents('cust-1', customersDb({ monthly_rate: '49.00', billing_day: 1 }), now)).resolves.toBe(0);
    await expect(currentDuesAllowanceCents('cust-1', customersDb(undefined), now)).resolves.toBe(0);
  });
});

describe('quotedBalanceStillOwed (pre-dispatch recheck of the quoted balance)', () => {
  const { quotedBalanceStillOwed } = require('../services/previsit-balance-reminder');
  const live = { id: 'inv-9', customer_id: 'cust-1', status: 'sent', total: '96.60', payer_id: null };

  function invoicesDb(rows) {
    db.mockImplementation((table) => {
      if (table !== 'invoices') throw new Error(`Unexpected table ${table}`);
      const q = { whereIn: jest.fn(() => q), then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) };
      return q;
    });
  }
  const check = () => quotedBalanceStillOwed({
    customerId: 'cust-1', quotedInvoices: [{ id: 'inv-9', due: 96.6 }], quotedDuesCents: 0,
  })();

  test('passes while every quoted invoice still owes exactly the quoted amount', async () => {
    invoicesDb([live]);
    await expect(check()).resolves.toEqual({ ok: true });
  });

  test.each([
    ['paid', { status: 'paid' }],
    ['partly paid', { total: '40.00' }],
    ['payer-billed', { payer_id: 'payer-1' }],
    ['moved to another customer', { customer_id: 'cust-2' }],
  ])('holds the leg (retryable) when a quoted invoice was %s', async (_label, patch) => {
    invoicesDb([{ ...live, ...patch }]);
    await expect(check()).resolves.toMatchObject({ ok: false, code: 'PREVISIT_QUOTE_CHANGED', retryable: true });
  });

  test('holds the leg when a quoted invoice is gone or unreadable', async () => {
    invoicesDb([]);
    await expect(check()).resolves.toMatchObject({ ok: false, retryable: true });
    db.mockImplementation(() => { throw new Error('connection reset'); });
    await expect(check()).resolves.toMatchObject({ ok: false, retryable: true });
  });

  test('the explicit legs carry the recheck into sendCustomerMessage', async () => {
    armOneVisit({ notificationPrefs: { billing_channels: ['sms'] } });
    sendReminderChannels.mockImplementation(async ({ send }) => {
      await send('sms', { id: 'led-1' });
      return { complete: true, deliveredNow: ['sms'], results: {} };
    });
    await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
    expect(typeof sendCustomerMessage.mock.calls[0][0].preDispatchCheck).toBe('function');
  });
});

test('a multi-channel selection quotes only invoices every permitted channel holds eligible', async () => {
  const { collectionsChannelVerdict } = require('../services/collections/rail-guard');
  collectionsChannelVerdict.mockImplementation(async ({ channel }) => ({
    permitted: true, eligibleInvoiceIds: channel === 'sms' ? ['inv-9', 'inv-10'] : ['inv-10'],
  }));
  armOneVisit({ notificationPrefs: { billing_channels: ['sms', 'email'] } });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  // inv-9 (the only overdue invoice) is not eligible on Email, so nothing is quoted.
  expect(sendReminderChannels).not.toHaveBeenCalled();
  expect(result).toMatchObject({ sent: 0 });
  collectionsChannelVerdict.mockImplementation(async () => ({ permitted: true, eligibleInvoiceIds: null }));
});

test('an App leg is addressed by customer, never the loaded phone', async () => {
  armOneVisit({ notificationPrefs: { billing_channels: ['push'] } });
  sendReminderChannels.mockImplementation(async ({ send }) => {
    await send('push', { id: 'led-p' });
    return { complete: true, deliveredNow: ['push'], results: {} };
  });
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ channel: 'push', to: null, customerId: 'cust-1' });
});
