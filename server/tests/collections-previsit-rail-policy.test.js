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
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_name, run) => run()) }));
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
  collectionsChannelVerdict: jest.fn(async () => ({ permitted: true, eligibleInvoiceIds: null })),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
}));

jest.mock('../services/billing-reminder-delivery', () => ({
  reminderProgress: jest.fn(async () => []),
  sendReminderChannels: jest.fn(async (input) => {
    for (const channel of input.channels) await input.send(channel, { id: `ledger-${channel}` });
    return { complete: true, deliveredNow: input.channels };
  }),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AccountMembershipEmail = require('../services/account-membership-email');
const { collectionsChannelVerdict } = require('../services/collections/rail-guard');
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
  queues = { notification_prefs: [chain({ first: null })], ...queues };
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
function armOneVisit({ claimed = 1 } = {}) {
  const claimChain = chain({ result: claimed });
  const releaseChain = chain({ result: 1 });
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [VISIT] }), claimChain, releaseChain],
    invoices: [chain({ result: [OVERDUE_INVOICE] })],
    activity_log: [chain({ result: [] })],
  });
  return { claimChain, releaseChain };
}

function permitChannels(permitted) {
  collectionsChannelVerdict.mockImplementation(async ({ channel }) => ({
    permitted: !!permitted[channel],
    eligibleInvoiceIds: null,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PREVISIT_BALANCE_REMINDER = 'true';
  require('../services/invoice-helpers').invoiceWithdrawnFromCustomer.mockImplementation(() => false);
  collectionsChannelVerdict.mockResolvedValue({ permitted: true, eligibleInvoiceIds: null });
  AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient.mockResolvedValue({ recipient: { email: 'taylor@example.com' } });
  AccountMembershipEmail.sendPrevisitBalanceReminder.mockResolvedValue({ ok: true });
});

test('an incomplete recent-contact snapshot fails closed before claiming or sending', async () => {
  const claimChain = chain({ result: 1 });
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [VISIT] }), claimChain],
    invoices: [chain({ result: [OVERDUE_INVOICE] })],
    activity_log: [chain({ result: Promise.reject(new Error('activity read unavailable')) })],
  });

  await expect(runSweep({ now: new Date('2026-08-14T15:00:00Z') }))
    .resolves.toMatchObject({ sent: 0, skipped: 1 });
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
});

test('the shared fresh selector preserves only the complete eligible balance', async () => {
  permitChannels({ sms: true, email: false });
  require('../services/invoice-helpers').invoiceWithdrawnFromCustomer
    .mockImplementation((invoice) => invoice.id === 'inv-withdrawn');
  const now = new Date('2026-08-14T15:00:00Z');
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [VISIT] }), chain({ result: 1 })],
    invoices: [chain({ result: [
      OVERDUE_INVOICE,
      { ...OVERDUE_INVOICE, id: 'inv-paid', status: 'paid', total: '500.00' },
      { ...OVERDUE_INVOICE, id: 'inv-withdrawn', total: '400.00' },
      { ...OVERDUE_INVOICE, id: 'inv-zero', total: '0.00' },
      { ...OVERDUE_INVOICE, id: 'inv-recent', total: '300.00', last_reminder_at: now },
      { ...OVERDUE_INVOICE, id: 'inv-legacy', total: '200.00' },
    ] })],
    activity_log: [chain({ result: [{ metadata: { invoiceId: 'inv-legacy' } }] })],
  });

  await expect(runSweep({ now })).resolves.toMatchObject({ sent: 1, skipped: 0 });
  expect(require('../services/sms-template-renderer').renderSmsTemplate)
    .toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: '96.60' }));
  expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({ invoiceIds: ['inv-9'] }));
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

test('losing the appointment claim prevents every ledger entry and send', async () => {
  const { claimChain, releaseChain } = armOneVisit({ claimed: 0 });
  await expect(runSweep({ now: new Date('2026-08-14T15:00:00Z') }))
    .resolves.toMatchObject({ sent: 0, skipped: 1 });
  expect(claimChain.whereNull).toHaveBeenCalledWith('balance_reminder_sent_at');
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(releaseChain.update).not.toHaveBeenCalled();
});

test.each([
  [true, true, false],
  [true, false, false],
  [false, true, false],
  [false, false, true],
])('Text delivered=%s, Email delivered=%s leaves claim released=%s', async (smsDelivered, emailDelivered, released) => {
  const { releaseChain } = armOneVisit();
  sendCustomerMessage.mockResolvedValueOnce({ sent: smsDelivered, blocked: !smsDelivered });
  AccountMembershipEmail.sendPrevisitBalanceReminder.mockResolvedValueOnce({ ok: emailDelivered });
  await expect(runSweep({ now: new Date('2026-08-14T15:00:00Z') }))
    .resolves.toMatchObject({ sent: released ? 0 : 1, skipped: released ? 1 : 0 });
  expect(ContactLedger.recordContact.mock.calls.map(([input]) => input.channel)).toEqual(['sms', 'email']);
  expect(releaseChain.update).toHaveBeenCalledTimes(released ? 1 : 0);
  if (released) expect(releaseChain.update).toHaveBeenCalledWith({ balance_reminder_sent_at: null });
});

test.each([
  ['sms', 'payer resolve failed', ['inv-9']],
  ['email', 'candidate bound hit', []],
])('an incomplete %s balance snapshot (%s) skips before the claim', async (incompleteChannel, reason, eligibleInvoiceIds) => {
  const { claimChain } = armOneVisit();
  collectionsChannelVerdict.mockImplementation(async ({ channel }) => ({
    permitted: true,
    eligibleInvoiceIds: channel === incompleteChannel ? eligibleInvoiceIds : ['inv-9'],
    ...(channel === incompleteChannel ? { balanceIncomplete: reason } : {}),
  }));
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

test('late dues do not authorize a reminder from an incomplete empty invoice snapshot', async () => {
  const claimChain = chain({ result: 1 });
  require('../services/billing-lane').resolveBillingLane.mockReturnValueOnce({ mode: 'monthly_membership' });
  require('../services/billing-lane').monthlyDuesCollected.mockResolvedValueOnce(false);
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [{ ...VISIT, monthly_rate: '69.00', billing_day: 1 }] }), claimChain],
    invoices: [chain({ result: [] })],
    activity_log: [chain({ result: [] })],
  });
  collectionsChannelVerdict.mockResolvedValue({
    permitted: true, eligibleInvoiceIds: [], balanceIncomplete: 'payer resolve failed',
  });
  await expect(runSweep({ now: new Date('2026-08-14T15:00:00Z') }))
    .resolves.toMatchObject({ sent: 0, skipped: 1 });
  expect(collectionsChannelVerdict).toHaveBeenCalledTimes(1);
  expect(collectionsChannelVerdict).toHaveBeenCalledWith(expect.objectContaining({ offLedgerBalanceCents: 6900 }));
  expect(claimChain.update).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
});

test('sms allowed + email denied ⇒ SMS only, hasEmailLeg declared false, one sms ledger row recorded before the send', async () => {
  armOneVisit();
  permitChannels({ sms: true, email: false });
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    hasEmailLeg: false,
    withSmsHandoff: expect.any(Function),
    providerPreSendCheck: expect.any(Function),
  }));
  expect(sendCustomerMessage.mock.calls[0][0]).not.toHaveProperty('preSendCheck');
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
  const { releaseChain } = armOneVisit();
  permitChannels({ sms: false, email: true });
  ContactLedger.recordContact.mockRejectedValueOnce(new Error('ledger down'));
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
  expect(collectionsChannelVerdict).toHaveBeenCalledWith(
    expect.objectContaining({ channel: 'sms', offLedgerBalanceCents: 12800 }),
  );
  expect(collectionsChannelVerdict).toHaveBeenCalledWith(
    expect.objectContaining({ channel: 'email', offLedgerBalanceCents: 12800 }),
  );
});

// r8: gate-on, the reminder quotes ONLY policy-eligible debt — an invoice
// the policy excluded must not ride an allowed aggregate.
test('a policy-excluded invoice is filtered out of the quoted amount and the ledger row', async () => {
  collectionsChannelVerdict.mockImplementation(async () => ({
    permitted: true,
    eligibleInvoiceIds: ['inv-9'], // the policy admits inv-9 only
  }));
  const claimChain = chain({ result: 1 });
  setDbQueues({
    sms_templates: [chain({ first: { is_active: true } })],
    scheduled_services: [chain({ result: [VISIT] }), claimChain],
    // Two overdue invoices; inv-77 is excluded by the policy (e.g. it
    // re-resolved as payer-billed or its sequence was stopped).
    invoices: [chain({
      result: [
        OVERDUE_INVOICE,
        { id: 'inv-77', total: '500.00', due_date: '2026-07-01', last_reminder_at: null, followup_last_touch_at: null },
      ],
    })],
    activity_log: [chain({ result: [] })],
  });
  const { renderSmsTemplate } = require('../services/sms-template-renderer');
  const result = await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(result).toMatchObject({ sent: 1 });
  // The quoted amount is inv-9's $96.60 alone — never inv-77's $500.
  expect(renderSmsTemplate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: '96.60' }), );
  expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({ invoiceIds: ['inv-9'] }));
});

function armExplicit(channels, overrides = {}) {
  const claim = chain({ result: 1 });
  setDbQueues({ sms_templates: [chain({ first: { is_active: true } })],
    notification_prefs: [chain({ first: { billing_channels: channels } })],
    scheduled_services: [chain({ result: [VISIT] }), claim, chain({ result: 1 })],
    invoices: [chain({ result: [OVERDUE_INVOICE] })], activity_log: [chain({ result: [] })], ...overrides });
  return claim;
}

test.each([['email'], ['sms'], ['push'], ['email', 'sms', 'push']])('stored explicit methods %j use keyed live delivery with policy gate off', async (...channels) => {
  delete process.env.GATE_COLLECTIONS_POLICY;
  armExplicit(channels);
  await expect(runSweep({ now: new Date('2026-08-14T15:00:00Z') })).resolves.toMatchObject({ sent: 1 });
  const helper = require('../services/billing-reminder-delivery').sendReminderChannels;
  expect(helper).toHaveBeenCalledWith(expect.objectContaining({ channels, eventKey: `previsit-balance:${VISIT.id}` }));
  expect(sendCustomerMessage.mock.calls.map(([input]) => input.metadata.billingDeliveryLeg)).toEqual(channels);
  for (const [input] of sendCustomerMessage.mock.calls) {
    expect(input.metadata).toMatchObject({ invoice_ids: ['inv-9'], invoice_quotes: [{ id: 'inv-9', dueCents: 9660 }],
      dues_cents: 0, appointment_date: VISIT.scheduled_date, collections_ledger_id: expect.any(String) });
    if (input.metadata.billingDeliveryLeg === 'sms') {
      expect(input.withSmsHandoff).toEqual(expect.any(Function));
      expect(input.preSendCheck).toBeUndefined();
    } else expect(input.preSendCheck).toEqual(expect.any(Function));
  }
  expect(AccountMembershipEmail.sendPrevisitBalanceReminder).not.toHaveBeenCalled();
});

test('an explicit empty choice or unreadable preference leaves the appointment unclaimed', async () => {
  let claim = armExplicit([]);
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(claim.update).not.toHaveBeenCalled();
  claim = armExplicit(['email'], { notification_prefs: [chain({ first: Promise.reject(new Error('choice unreadable')) })] });
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(claim.update).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('the first partial explicit policy read stops before reservation and claim', async () => {
  const claim = armExplicit(['email', 'sms']);
  collectionsChannelVerdict.mockImplementation(async ({ channel }) => ({ permitted: true,
    eligibleInvoiceIds: ['inv-9'], ...(channel === 'email' ? { balanceIncomplete: 'read_failed' } : {}) }));
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(claim.update).not.toHaveBeenCalled();
  expect(require('../services/billing-reminder-delivery').sendReminderChannels).not.toHaveBeenCalled();
});

test('explicit quotes intersect selected allowed balances and exclude only this appointment episode', async () => {
  armExplicit(['email', 'sms']);
  require('../services/billing-reminder-delivery').reminderProgress.mockResolvedValueOnce([
    { metadata: { notificationEventKey: 'previsit-balance:unrelated' }, entries: [{ id: 'other' }] },
    { metadata: { notificationEventKey: `previsit-balance:${VISIT.id}` },
      entries: [{ id: 'own-email', metadata: { send_failed: true } }] },
  ]);
  collectionsChannelVerdict.mockImplementation(async ({ channel }) => ({ permitted: true,
    eligibleInvoiceIds: channel === 'email' ? ['inv-9'] : ['inv-9', 'other'] }));
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(collectionsChannelVerdict).toHaveBeenCalledWith(expect.objectContaining({ excludeLedgerIds: ['own-email'] }));
  expect(require('../services/billing-reminder-delivery').sendReminderChannels)
    .toHaveBeenCalledWith(expect.objectContaining({ invoiceIds: ['inv-9'] }));
});

function priorQuoteMetadata(overrides = {}) {
  return { notificationEventKey: `previsit-balance:${VISIT.id}`, scheduled_service_id: VISIT.id,
    appointment_date: VISIT.scheduled_date, appointment_service_type: VISIT.service_type,
    appointment_rendered_on: '2026-08-13', rendered_amount: '96.60',
    invoice_ids: ['inv-9'], invoice_quotes: [{ id: 'inv-9', dueCents: 9660 }],
    dues_cents: 0, selected_channels: ['email', 'sms'], ...overrides };
}

test.each([true, false])('a partial retry retains a delivered=%s sibling quote after the balance changes', async (delivered) => {
  armExplicit(['email', 'sms'], { invoices: [chain({ result: [
    { ...OVERDUE_INVOICE, total: '60.00' }, { ...OVERDUE_INVOICE, id: 'new-invoice', total: '200.00' },
  ] })] });
  const helper = require('../services/billing-reminder-delivery');
  helper.reminderProgress.mockResolvedValueOnce([{
    metadata: priorQuoteMetadata(), delivered: new Set(delivered ? ['email'] : []),
    entries: [
      { id: 'sms', channel: 'sms', metadata: priorQuoteMetadata({ send_failed: true, rendered_amount: '260.00' }) },
      { id: 'email', channel: 'email', metadata: priorQuoteMetadata({ delivered, send_failed: false }) },
    ],
  }]);
  helper.sendReminderChannels.mockImplementationOnce(async (input) => {
    await input.send('sms', { id: 'sms' });
    return { complete: delivered, deliveredNow: ['sms'] };
  });
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(helper.sendReminderChannels).toHaveBeenCalledWith(expect.objectContaining({
    invoiceIds: ['inv-9'], offLedgerBalanceCents: 0,
    metadata: expect.objectContaining({ rendered_amount: '96.60', invoice_quotes: [{ id: 'inv-9', dueCents: 9660 }] }),
  }));
  expect(require('../services/sms-template-renderer').renderSmsTemplate)
    .toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: '96.60' }));
  expect(sendCustomerMessage.mock.calls.map(([input]) => input.metadata.billingDeliveryLeg)).toEqual(['sms']);
});

test('an unreadable delivered quote holds the episode before taking the visit claim', async () => {
  const claim = armExplicit(['email', 'sms']);
  require('../services/billing-reminder-delivery').reminderProgress.mockResolvedValueOnce([{
    metadata: priorQuoteMetadata(), delivered: new Set(['email']),
    entries: [{ id: 'email', channel: 'email', metadata: priorQuoteMetadata({ invoice_quotes: null, delivered: true }) }],
  }]);
  await runSweep({ now: new Date('2026-08-14T15:00:00Z') });
  expect(claim.update).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});
