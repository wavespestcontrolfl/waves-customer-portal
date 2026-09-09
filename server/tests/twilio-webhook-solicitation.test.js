// Exercise the real webhook, carrier-command detector, and solicitation screen.
// Persistence and providers are mocked; no SMS or customer record is touched.
const mockWrites = [];
function mockDb(table) {
  const query = { rows: [] };
  for (const method of ['where', 'whereNull', 'whereRaw', 'whereNot', 'orderBy', 'limit']) {
    query[method] = () => query;
  }
  query.insert = (row) => {
    mockWrites.push({ table, row });
    query.rows = [{ id: '00000000-0000-4000-8000-000000000001', created_at: new Date(), ...row }];
    return query;
  };
  query.first = async () => null;
  query.returning = async () => query.rows;
  query.then = (resolve, reject) => Promise.resolve(query.rows).then(resolve, reject);
  query.catch = (reject) => Promise.resolve(query.rows).catch(reject);
  return query;
}
mockDb.raw = jest.fn(async () => ({ rows: [] }));
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((gate) => gate === 'webhooks') }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { fastStructured: 'test-policy' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(async () => ({})), clearSuppression: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/inbound-dedupe', () => ({
  tryClaimInboundWebhook: jest.fn(async () => ({ processable: true, owned: true })),
  releaseInboundWebhook: jest.fn(async () => ({})),
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({})), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => ({})), isFailureStatus: jest.fn() }));
jest.mock('../services/sms-intent', () => ({
  hasSchedulingIntent: jest.fn(() => false), isSmsReaction: jest.fn(() => false),
  isQuietSmsReaction: jest.fn(() => false), isCourtesyOnly: jest.fn(() => false),
  hasRescheduleOrAwayIntent: jest.fn(() => false),
}));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: jest.fn(async () => ({ blocked: false })) }));
jest.mock('../services/contact-correction', () => ({ detectContactCorrectionIntent: jest.fn(() => false) }));
jest.mock('../services/contact-correction-queue', () => ({}));
jest.mock('../services/recipient-optin', () => ({ markRecipientOptin: jest.fn(async () => true) }));
jest.mock('../utils/known-caller-phone', () => ({ findKnownCallerCustomer: jest.fn(async () => null) }));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => true, startSmsThreadDraft: jest.fn(async () => ({})) }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: jest.fn(async () => ({})) }));
jest.mock('../services/tech-line', () => ({ notifyTechLineText: jest.fn(async () => ({})) }));

const { EventEmitter } = require('node:events');
const { dispatchWithFallback } = require('../services/llm/call');
const { recordTouchpoint } = require('../services/conversations');
const { recordSuppression, clearSuppression } = require('../services/messaging/validators/suppression');
const { handleClarifyReply } = require('../services/estimate-clarify-asks');
const { startSmsThreadDraft } = require('../services/estimator-engine/sms-thread');
const { processInboundSms } = require('../services/estimate-conversion-agent');
const { sendSMS } = require('../services/twilio');
const { findKnownCallerCustomer } = require('../utils/known-caller-phone');
const numbers = require('../config/twilio-numbers');
const router = require('../routes/twilio-webhook');
const handler = router.stack.find((layer) => layer.route?.path === '/sms').route.stack[0].handle;
const PITCH = 'Are you open to more booked jobs? Reply "NO" if you need me to stop texting';
const savedGate = process.env.GATE_SMS_SPAM_CLASSIFIER;
const savedOwner = process.env.ADAM_PHONE;

async function receive(body) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: {
    From: '+12025550101', To: numbers.locations.parrish.number,
    Body: body, MessageSid: 'SM-synthetic-solicitation',
  } }, res);
  await new Promise(setImmediate);
  expect(require('../services/logger').error).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(200);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  process.env.ADAM_PHONE = '+12025550199';
  dispatchWithFallback.mockResolvedValue({ ok: true, json: { solicitation: false, confidence: 0.97 } });
  findKnownCallerCustomer.mockResolvedValue(null);
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_SMS_SPAM_CLASSIFIER;
  else process.env.GATE_SMS_SPAM_CLASSIFIER = savedGate;
  if (savedOwner === undefined) delete process.env.ADAM_PHONE;
  else process.env.ADAM_PHONE = savedOwner;
});

test('an enforced pitch footer stays read, retains its verdict, and never receives an opt-out reply', async () => {
  const res = await receive(PITCH);
  expect(res.body).toBe('<Response></Response>');
  expect(recordSuppression).not.toHaveBeenCalled();
  expect(clearSuppression).not.toHaveBeenCalled();
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({
    isRead: true, metadata: expect.objectContaining({ spam_verdict: expect.objectContaining({ enforced: true }) }),
  }));
  const writes = mockWrites.filter(({ table }) => table === 'sms_log');
  expect(writes).toHaveLength(1);
  expect(writes[0].row).toMatchObject({ message_type: 'inbound', is_read: true });
  expect(JSON.parse(writes[0].row.metadata).spam_verdict).toMatchObject({ enforced: true, method: 'regex' });
  expect(handleClarifyReply).not.toHaveBeenCalled();
  expect(startSmsThreadDraft).not.toHaveBeenCalled();
  expect(processInboundSms).not.toHaveBeenCalled();
  expect(sendSMS).not.toHaveBeenCalled();
});

test('shadow mode records a pitch verdict while retaining ordinary opt-out handling', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'shadow';
  const res = await receive(PITCH);
  expect(res.body).toContain('<Message>');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  const writes = mockWrites.filter(({ table }) => table === 'sms_log');
  expect(writes).toHaveLength(1);
  expect(writes[0].row.message_type).toBe('opt_out');
  expect(JSON.parse(writes[0].row.metadata).spam_verdict).toMatchObject({
    solicitation: true, mode: 'shadow', enforced: false,
  });
});

test.each([
  ['STOP', 'opt_out', 'unsubscribed'],
  ['START', 'opt_in', 're-subscribed'],
  ['HELP', 'help_request', 'support'],
  ['Please stop texting me', 'opt_out', 'unsubscribed'],
])('the %s command still reaches carrier handling', async (body, messageType, reply) => {
  const res = await receive(body);
  expect(res.body).toContain('<Message>');
  expect(res.body).toContain(reply);
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe(messageType);
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  if (messageType === 'opt_out') expect(recordSuppression).toHaveBeenCalledTimes(1);
  if (messageType === 'opt_in') expect(clearSuppression).toHaveBeenCalledTimes(1);
  if (body !== 'Please stop texting me') expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(sendSMS).not.toHaveBeenCalled();
});

test('a genuine pricing inquiry keeps its unread state, estimator handling, and owner alert', async () => {
  const res = await receive('Do you offer exclusive rates for new customers?');
  expect(res.body).toBe('<Response></Response>');
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  expect(handleClarifyReply).toHaveBeenCalledTimes(1);
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(processInboundSms).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});
