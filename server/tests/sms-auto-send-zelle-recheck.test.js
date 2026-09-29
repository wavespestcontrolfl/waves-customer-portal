/**
 * Auto-send Zelle send-time recheck (pre-push audit P1, finding 2). Same
 * harness as sms-auto-send-open-times.test.js: full maybeAutoSend round trip
 * with the DB and provider mocked, exercising claimAutoSend's threading of
 * zelleInvoiceId onto the claim and dispatchClaimedSend's pre-send recheck
 * of it — the auto-send choke point, distinct from the /sms and
 * /schedule-sms choke point (agent-decision-send-checks.js) and the
 * scheduler's queued-send fire-time recheck, which cover the same fact via
 * the same sms-amount-recheck.js primitives.
 */
jest.mock('../models/db', () => {
  const db = jest.fn((table) => db.trx(table));
  db.transaction = jest.fn(async (work) => work(db.trx));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/sms-suggest-mode', () => ({
  suggestionEligible: jest.fn(() => true), getIntentMode: jest.fn(async () => 'auto_send'),
  hasRedactionPlaceholder: jest.fn(() => false), hasPriceQuote: jest.fn(() => false),
  lockSuggestThread: jest.fn(async () => {}), threadHasLiveAnswer: jest.fn(async () => null),
  parkThreadSuggestions: jest.fn(async () => ['parked-1']),
  createReplyHoldingReservation: jest.fn(async () => '33333333-3333-4333-8333-333333333333'),
  settleReplyHoldingReservation: jest.fn(async () => true),
  reopenScheduledSuggestions: jest.fn(async () => 1),
  ignoreParkedSuggestions: jest.fn(async () => 1),
}));
jest.mock('../services/sms-shadow-drafter', () => ({
  resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })),
  openTimesStillOffered: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/sms-graduation', () => ({ evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-amount-recheck', () => ({
  outgoingZelleStale: jest.fn(),
  zelleBodyContacts: jest.fn(),
  zelleInvoiceStillEligible: jest.fn(),
}));

const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const drafter = require('../services/sms-shadow-drafter');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const amountRecheck = require('../services/sms-amount-recheck');
const autoSend = require('../services/sms-auto-send');
let decisions;

function chain(overrides = {}) {
  const q = {};
  for (const method of ['where', 'whereRaw', 'leftJoin', 'insert', 'onConflict', 'ignore']) q[method] = jest.fn(() => q);
  q.first = jest.fn(async () => null);
  q.returning = jest.fn(async () => [{ id: 'claim-1' }]);
  q.update = jest.fn(async () => 1);
  return Object.assign(q, overrides);
}

beforeEach(() => {
  jest.clearAllMocks();
  const inbound = chain({ first: jest.fn(async () => ({
    created_at: new Date(), from_phone: '+12025550101', to_phone: '+19413529161',
  })) });
  const activeClaim = chain();
  decisions = chain();
  const drafts = chain();
  db.trx = jest.fn((table) => {
    if (table === 'sms_log') return inbound;
    if (table === 'agent_decisions as ad') return activeClaim;
    if (table === 'agent_decisions') return decisions;
    if (table === 'message_drafts') return drafts;
    return chain();
  });
  db.trx.raw = jest.fn(async () => undefined);
  suggest.createReplyHoldingReservation.mockResolvedValue('33333333-3333-4333-8333-333333333333');
  suggest.settleReplyHoldingReservation.mockResolvedValue(true);
  suggest.ignoreParkedSuggestions.mockResolvedValue(1);
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  amountRecheck.zelleBodyContacts.mockReturnValue([]);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const attempt = (overrides = {}) => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'How do I pay?',
  reply: 'You can Zelle to payments@wavespestcontrol.com.',
  intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
  ...overrides,
});

test('a reply with no Zelle contact never triggers the recheck', async () => {
  amountRecheck.zelleBodyContacts.mockReturnValue([]);
  await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.outgoingZelleStale).not.toHaveBeenCalled();
  expect(amountRecheck.zelleInvoiceStillEligible).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a Zelle reply with a CURRENT recipient and an ELIGIBLE invoice sends normally', async () => {
  amountRecheck.zelleBodyContacts.mockReturnValue([{ kind: 'email', value: 'payments@wavespestcontrol.com' }]);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
  await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.zelleInvoiceStillEligible).toHaveBeenCalledWith({
    customerId: '00000000-0000-4000-8000-000000000002', zelleInvoiceId: 'inv-1',
  });
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a stale Zelle recipient blocks the send, fails the claim, reopens parked suggestions — eligibility never even checked', async () => {
  amountRecheck.zelleBodyContacts.mockReturnValue([{ kind: 'email', value: 'old@wavespestcontrol.com' }]);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: true, reason: 'zelle_recipient_stale' });
  await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_recipient_stale' });
  expect(amountRecheck.zelleInvoiceStillEligible).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
});

test('a recipient still current but the invoice was paid off / charge started since the draft blocks the send', async () => {
  amountRecheck.zelleBodyContacts.mockReturnValue([{ kind: 'email', value: 'payments@wavespestcontrol.com' }]);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: false, reason: 'zelle_invoice_ineligible' });
  await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_ineligible' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('no zelleInvoiceId on the claim (missing snapshot) blocks the send — fail closed', async () => {
  amountRecheck.zelleBodyContacts.mockReturnValue([{ kind: 'email', value: 'payments@wavespestcontrol.com' }]);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: false, reason: 'zelle_invoice_unresolved' });
  await expect(attempt({})).resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_unresolved' });
  expect(amountRecheck.zelleInvoiceStillEligible).toHaveBeenCalledWith({
    customerId: '00000000-0000-4000-8000-000000000002', zelleInvoiceId: null,
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});
