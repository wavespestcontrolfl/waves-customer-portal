'use strict';

const mockGate = { enabled: false };
const mockSendCustomerMessage = jest.fn();
const mockDeriveOutboundNumber = jest.fn();
const mockReserveHumanReply = jest.fn();
const mockSettleHumanReply = jest.fn();

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'smsGratitudeReplies' && mockGate.enabled),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
  classifyDeliveryCertainty: (outcome) => {
    if (outcome?.deliveryOutcome === 'accepted') return 'sent';
    if (outcome?.deliveryOutcome === 'not_sent' || (outcome?.blocked && !outcome?.deliveryOutcome)) return 'not_sent';
    return 'unknown';
  },
}));
jest.mock('../services/twilio', () => ({
  deriveOutboundNumber: (...args) => mockDeriveOutboundNumber(...args),
}));
jest.mock('../services/sms-suggest-mode', () => ({
  reserveHumanReply: (...args) => mockReserveHumanReply(...args),
  settleHumanReply: (...args) => mockSettleHumanReply(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  sendManualCustomerSms,
  manualSmsDeliveryState,
} = require('../services/messaging/send-manual-customer-sms');

const input = () => ({
  to: '+19415550100',
  body: 'Our pleasure!',
  channel: 'sms',
  audience: 'customer',
  purpose: 'conversational',
  customerId: 'customer-1',
  entryPoint: 'fixture',
  metadata: { adminUserId: 'admin-1' },
});

const reservation = () => ({
  phoneLast10: '9415550100',
  startedAt: new Date('2026-09-24T12:00:00Z'),
  parkedDecisionIds: ['decision-1'],
  heldDecisionIds: ['decision-1'],
  reservationId: 'reservation-1',
  autoSendInFlight: false,
});

beforeEach(() => {
  mockGate.enabled = false;
  jest.clearAllMocks();
  mockDeriveOutboundNumber.mockResolvedValue('+19413529161');
  mockReserveHumanReply.mockResolvedValue(reservation());
  mockSettleHumanReply.mockResolvedValue(undefined);
  mockSendCustomerMessage.mockResolvedValue({
    sent: true,
    deliveryOutcome: 'accepted',
    providerMessageId: 'SM-accepted',
  });
});

test('gate off is an exact canonical-send pass-through', async () => {
  const original = input();
  const result = await sendManualCustomerSms(original);

  expect(result).toBe(await mockSendCustomerMessage.mock.results[0].value);
  expect(mockSendCustomerMessage).toHaveBeenCalledWith(original);
  expect(mockDeriveOutboundNumber).not.toHaveBeenCalled();
  expect(mockReserveHumanReply).not.toHaveBeenCalled();
  expect(mockSettleHumanReply).not.toHaveBeenCalled();
  expect(manualSmsDeliveryState(result)).toBeNull();
});

test('an existing gratitude auto-send claim blocks before canonical delivery', async () => {
  mockGate.enabled = true;
  mockReserveHumanReply.mockResolvedValue({ ...reservation(), reservationId: null, autoSendInFlight: true });

  const result = await sendManualCustomerSms(input());

  expect(result).toMatchObject({ sent: false, deliveryOutcome: 'not_sent', code: 'AUTO_REPLY_IN_FLIGHT' });
  expect(manualSmsDeliveryState(result)).toBe('not_sent');
  expect(mockSendCustomerMessage).not.toHaveBeenCalled();
});

test('the durable reservation and actual derived endpoint precede canonical delivery', async () => {
  mockGate.enabled = true;
  const order = [];
  mockReserveHumanReply.mockImplementation(async () => { order.push('reserve'); return reservation(); });
  mockSendCustomerMessage.mockImplementation(async () => {
    order.push('send');
    return { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-accepted' };
  });

  await sendManualCustomerSms(input());

  expect(order).toEqual(['reserve', 'send']);
  expect(mockDeriveOutboundNumber).toHaveBeenCalledWith({ customerLocationId: undefined, customerId: 'customer-1' });
  expect(mockReserveHumanReply).toHaveBeenCalledWith(expect.objectContaining({
    to: '+19415550100',
    fromNumber: '+19413529161',
    customerId: 'customer-1',
    blockOnActiveManualReservation: true,
  }));
  expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    metadata: expect.objectContaining({
      fromNumber: '+19413529161',
      parkedDecisionIds: ['decision-1'],
    }),
  }));
  expect(mockSettleHumanReply).toHaveBeenCalledWith(expect.objectContaining({
    reservationId: 'reservation-1', sent: true, reviewedBy: 'admin-1',
  }));
});

test('an accepted provider outcome on a thrown audit error finalizes as accepted', async () => {
  mockGate.enabled = true;
  mockSendCustomerMessage.mockRejectedValue(Object.assign(new Error('audit insert failed'), {
    providerOutcome: {
      sent: true,
      providerMessageId: 'SM-after-audit-error',
    },
  }));

  const result = await sendManualCustomerSms(input());

  expect(result).toMatchObject({
    sent: true,
    deliveryOutcome: 'accepted',
    providerMessageId: 'SM-after-audit-error',
    acceptedAfterError: true,
  });
  expect(manualSmsDeliveryState(result)).toBe('accepted');
  expect(mockSettleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ sent: true }));
});

test.each([
  ['returned', async () => ({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE' })],
  ['thrown', async () => { throw Object.assign(new Error('provider timeout'), { providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } }); }],
])('an uncertain %s outcome keeps the reservation and parked linkage', async (_kind, implementation) => {
  mockGate.enabled = true;
  mockSendCustomerMessage.mockImplementation(implementation);

  let outcome;
  try {
    outcome = await sendManualCustomerSms(input());
  } catch (err) {
    outcome = err;
  }

  expect(manualSmsDeliveryState(outcome)).toBe('uncertain');
  expect(mockSettleHumanReply).toHaveBeenCalledWith(expect.objectContaining({
    reservationId: 'reservation-1',
    heldDecisionIds: ['decision-1'],
    parkedDecisionIds: [],
    ambiguous: true,
    sent: false,
  }));
});

test('explicit uncertainty stays uncertain even when the thrown outcome says sent', async () => {
  mockGate.enabled = true;
  mockSendCustomerMessage.mockRejectedValue(Object.assign(new Error('provider receipt ambiguous'), {
    providerOutcome: {
      sent: true,
      deliveryOutcome: 'uncertain',
      providerMessageId: 'SM-ambiguous',
    },
  }));

  let outcome;
  try {
    await sendManualCustomerSms(input());
  } catch (err) {
    outcome = err;
  }

  expect(manualSmsDeliveryState(outcome)).toBe('uncertain');
  expect(mockSettleHumanReply).toHaveBeenCalledWith(expect.objectContaining({
    reservationId: 'reservation-1', parkedDecisionIds: [], ambiguous: true, sent: false,
  }));
});

test('a definite refusal releases the reservation and parked suggestion normally', async () => {
  mockGate.enabled = true;
  mockSendCustomerMessage.mockResolvedValue({
    sent: false,
    blocked: true,
    deliveryOutcome: 'not_sent',
    code: 'SMS_OPTED_OUT',
  });

  const result = await sendManualCustomerSms(input());

  expect(manualSmsDeliveryState(result)).toBe('not_sent');
  expect(mockSettleHumanReply).toHaveBeenCalledWith(expect.objectContaining({
    parkedDecisionIds: ['decision-1'], sent: false,
  }));
});

test('reservation failure prevents provider entry', async () => {
  mockGate.enabled = true;
  mockReserveHumanReply.mockResolvedValue({ ...reservation(), reservationId: null });

  const result = await sendManualCustomerSms(input());

  expect(result).toMatchObject({
    sent: false,
    deliveryOutcome: 'not_sent',
    code: 'MANUAL_REPLY_RESERVATION_FAILED',
  });
  expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  expect(mockSettleHumanReply).toHaveBeenCalledWith(expect.objectContaining({
    parkedDecisionIds: ['decision-1'], sent: false,
  }));
});

test('a prior unresolved manual attempt blocks retry before provider entry', async () => {
  mockGate.enabled = true;
  mockReserveHumanReply.mockResolvedValue({
    ...reservation(),
    reservationId: null,
    manualReplyInFlight: true,
  });

  const result = await sendManualCustomerSms(input());

  expect(result).toMatchObject({
    sent: false,
    deliveryOutcome: 'uncertain',
    code: 'MANUAL_REPLY_OUTCOME_UNRESOLVED',
    mayHaveSent: true,
    retryable: false,
  });
  expect(manualSmsDeliveryState(result)).toBe('uncertain');
  expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  expect(mockSettleHumanReply).not.toHaveBeenCalled();
});
