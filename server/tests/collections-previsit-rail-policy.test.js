/**
 * previsit-balance-reminder runSweep × collections policy (PR A wiring).
 *
 * Pins: both channels denied ⇒ the visit is skipped BEFORE the
 * one-per-appointment claim (a policy hold never churns the claim); each
 * channel's verdict binds ITS OWN leg (sms allowed/email denied sends only
 * the SMS and declares hasEmailLeg:false; sms denied/email allowed sends
 * only the email); every delivered leg records its ledger row BEFORE the
 * send. The rail-guard itself (gate-off no-consult, fail-closed) is pinned
 * in collections-rail-guard.test.js; it is mocked per-channel here.
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
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'previsit balance sms body'),
}));
jest.mock('../services/account-membership-email', () => ({
  resolvePrevisitBalanceEmailRecipient: jest.fn(async () => ({ recipient: { email: 'taylor@example.com' } })),
  sendPrevisitBalanceReminder: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AccountMembershipEmail = require('../services/account-membership-email');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const ContactLedger = require('../services/collections/contact-ledger');
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

// One overdue recurring invoice: $96.60 (per_visit lane ⇒ eligibility rides
// overdueRecurringDue alone).
const OVERDUE_INVOICE = {
  id: 'inv-9', total: '96.60', due_date: '2026-07-01',
  last_reminder_at: null, followup_last_touch_at: null,
};

// { claimChain } so tests can assert the claim was or wasn't attempted.
function armOneVisit() {
  const claimChain = chain({ result: 1 });
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [VISIT] }), claimChain],
    invoices: [chain({ result: [OVERDUE_INVOICE] })],
    activity_log: [chain({ result: [] })],
  });
  return { claimChain };
}

function permitChannels(permitted) {
  collectionsChannelPermitted.mockImplementation(async ({ channel }) => !!permitted[channel]);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PREVISIT_BALANCE_REMINDER = 'true';
  collectionsChannelPermitted.mockResolvedValue(true);
  AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient.mockResolvedValue({ recipient: { email: 'taylor@example.com' } });
  AccountMembershipEmail.sendPrevisitBalanceReminder.mockResolvedValue({ ok: true });
});
afterEach(() => {
  delete process.env.PREVISIT_BALANCE_REMINDER;
});

test('both channels policy-denied ⇒ skipped BEFORE the one-per-appointment claim', async () => {
  const { claimChain } = armOneVisit();
  permitChannels({ sms: false, email: false });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

test('sms allowed + email denied ⇒ SMS only, hasEmailLeg declared false, one sms ledger row recorded before the send', async () => {
  armOneVisit();
  permitChannels({ sms: true, email: false });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ hasEmailLeg: false }));
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  const channels = ContactLedger.recordContact.mock.calls.map(([args]) => args.channel);
  expect(channels).toEqual(['sms']);
  expect(ContactLedger.recordContact.mock.invocationCallOrder[0])
    .toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
});

test('sms denied + email allowed ⇒ email only, its own ledger row recorded before the send', async () => {
  armOneVisit();
  permitChannels({ sms: false, email: true });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).toHaveBeenCalledTimes(1);
  const channels = ContactLedger.recordContact.mock.calls.map(([args]) => args.channel);
  expect(channels).toEqual(['email']);
  expect(ContactLedger.recordContact.mock.invocationCallOrder[0])
    .toBeLessThan(AccountMembershipEmail.sendPrevisitBalanceReminder.mock.invocationCallOrder[0]);
});

test('an unavailable ledger on the email leg skips that email (record-then-send), and the claim releases when no leg lands', async () => {
  armOneVisit();
  permitChannels({ sms: false, email: true });
  ContactLedger.recordContact.mockRejectedValueOnce(new Error('ledger down'));
  // The failed-visit release re-queries scheduled_services once more.
  const releaseChain = chain({ result: 1 });
  const originalImpl = db.getMockImplementation();
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      try { return originalImpl(table); } catch { return releaseChain; }
    }
    return originalImpl(table);
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(releaseChain.update).toHaveBeenCalledWith({ balance_reminder_sent_at: null });
});

test('dues-only visit (monthly membership, no overdue invoices) supplies offLedgerBalanceCents to the policy consult', async () => {
  const { resolveBillingLane, monthlyDuesCollected } = require('../services/billing-lane');
  resolveBillingLane.mockReturnValue({ mode: 'monthly_membership' });
  monthlyDuesCollected.mockResolvedValue(false);
  const claimChain = chain({ result: 1 });
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    // billing_day 1 + 3 grace days is long past on Aug 14 ⇒ dues late.
    scheduled_services: [
      chain({ result: [{ ...VISIT, monthly_rate: '128.00', billing_day: 1 }] }),
      claimChain,
    ],
    invoices: [chain({ result: [] })], // dues-only: ZERO overdue invoices
    activity_log: [chain({ result: [] })],
  });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 1 });
  expect(collectionsChannelPermitted).toHaveBeenCalledWith(
    expect.objectContaining({ channel: 'sms', offLedgerBalanceCents: 12800 }),
  );
  expect(collectionsChannelPermitted).toHaveBeenCalledWith(
    expect.objectContaining({ channel: 'email', offLedgerBalanceCents: 12800 }),
  );
});
