/**
 * The shared send step's SMS offer ledger hook (GATE_SMS_OFFER_LEDGER, dark):
 * after the provider accepts a text that came from an agent decision, the
 * ledger is handed the approved body. Gate off, the ledger is never loaded.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRecord = jest.fn();
jest.mock('../services/sms-offers', () => ({ recordOfferForSend: (...args) => mockRecord(...args) }));

const { recordSmsOfferAfterSend } = require('../services/messaging/send-customer-message')._internals;

const GATE = 'GATE_SMS_OFFER_LEDGER';
const input = { body: 'Approved text with portal.example/long-link', metadata: { agentDecisionId: 'd-1' } };
const sendInput = { to: '+19415550100', body: 'Approved text with wvs.example/x' };
const SID = `SM${'a'.repeat(32)}`;
const accepted = { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID, sentAt: '2026-10-02T15:00:00.000Z' };

beforeEach(() => { mockRecord.mockReset().mockResolvedValue({ recorded: true }); });
afterEach(() => { delete process.env[GATE]; });

test('gate off: the ledger is not called', async () => {
  await recordSmsOfferAfterSend(input, sendInput, accepted);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('gate on: the ledger gets the decision, the approved body and the destination', async () => {
  process.env[GATE] = 'true';
  await recordSmsOfferAfterSend(input, sendInput, accepted);
  expect(mockRecord).toHaveBeenCalledWith({
    agentDecisionId: 'd-1', outgoingBody: input.body, providerMessageId: SID, to: '+19415550100', sentAt: new Date('2026-10-02T15:00:00.000Z'),
    preSendVisitSnapshot: null,
  });
});

test('gate on: a send with no agent decision, or delivered as a push, records nothing', async () => {
  process.env[GATE] = 'true';
  await recordSmsOfferAfterSend({ body: 'x', metadata: {} }, sendInput, accepted);
  await recordSmsOfferAfterSend(input, sendInput, { ...accepted, provider: 'push' });
  expect(mockRecord).not.toHaveBeenCalled();
});

test('gate on: a suppressed or sentinel send (sent:true, nothing reached the customer) records nothing', async () => {
  process.env[GATE] = 'true';
  await recordSmsOfferAfterSend(input, sendInput, { ...accepted, deliveryOutcome: 'not_sent', providerMessageId: 'owner-silence' });
  await recordSmsOfferAfterSend(input, sendInput, { ...accepted, deliveryOutcome: 'uncertain' });
  await recordSmsOfferAfterSend(input, sendInput, { ...accepted, providerMessageId: 'gate-blocked' });
  await recordSmsOfferAfterSend(input, sendInput, { ...accepted, sent: false });
  expect(mockRecord).not.toHaveBeenCalled();
});

test('gate on: a ledger failure never reaches the send result', async () => {
  process.env[GATE] = 'true';
  mockRecord.mockRejectedValue(new Error('boom'));
  await expect(recordSmsOfferAfterSend(input, sendInput, accepted)).resolves.toBeUndefined();
});

test('the visit snapshot read before the send is handed to the ledger', async () => {
  process.env[GATE] = 'true';
  const snap = { scheduled_service_id: 'v-1', date: '2026-10-05', start: '08:00', end: '10:00', status: 'confirmed', pre_send: true };
  await recordSmsOfferAfterSend(input, sendInput, accepted, snap);
  expect(mockRecord.mock.calls[0][0].preSendVisitSnapshot).toBe(snap);
});
