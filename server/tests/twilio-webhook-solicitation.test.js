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
mockDb.raw = jest.fn((sql, bindings) => ({ rows: [], sql, bindings }));
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((gate) => gate === 'webhooks') }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { fastStructured: 'test-policy' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})), isKnownOwnerPhone: jest.fn(() => false) }));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(async () => ({})), clearSuppression: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/inbound-dedupe', () => ({
  tryClaimInboundWebhook: jest.fn(async () => ({ processable: true, owned: true })),
  releaseInboundWebhook: jest.fn(async () => ({})),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(async () => ({ message: { id: 'saved-inbound-message' } })),
  updateByTwilioSid: jest.fn(async () => ({})),
}));
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
jest.mock('../utils/known-caller-phone', () => ({
  knownCallerPhoneExists: jest.fn(async () => false),
  // The STOP/HELP/START compliance gate (twilio-webhook.js, merged from
  // fix/sms-compliance-known-senders) also calls this — unrelated to this
  // file's solicitation-classifier scenarios, but a missing export makes
  // that gate's `.catch()` handler unreachable (a synchronous throw on a
  // non-function skips it), erroring every request through this handler.
  findKnownCallerCustomer: jest.fn(async () => null),
}));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => true, startSmsThreadDraft: jest.fn(async () => ({})) }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: jest.fn(async () => ({})) }));
jest.mock('../services/tech-line', () => ({ notifyTechLineText: jest.fn(async () => ({})) }));

const { EventEmitter } = require('node:events');
const { dispatchWithFallback } = require('../services/llm/call');
const { recordTouchpoint, updateByTwilioSid } = require('../services/conversations');
const { recordSuppression } = require('../services/messaging/validators/suppression');
const { handleClarifyReply } = require('../services/estimate-clarify-asks');
const { startSmsThreadDraft } = require('../services/estimator-engine/sms-thread');
const { processInboundSms } = require('../services/estimate-conversion-agent');
const { sendSMS } = require('../services/twilio');
const { knownCallerPhoneExists } = require('../utils/known-caller-phone');
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
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'shadow';
  process.env.ADAM_PHONE = '+12025550199';
  dispatchWithFallback.mockResolvedValue({ ok: true, json: { solicitation: false, confidence: 0.97 } });
  knownCallerPhoneExists.mockResolvedValue(false);
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_SMS_SPAM_CLASSIFIER;
  else process.env.GATE_SMS_SPAM_CLASSIFIER = savedGate;
  if (savedOwner === undefined) delete process.env.ADAM_PHONE;
  else process.env.ADAM_PHONE = savedOwner;
});

test('a shadow pitch stays unread, records its verdict, and follows ordinary estimator and alert handling', async () => {
  const res = await receive('We have exclusive pest leads for you.');
  expect(res.body).toBe('<Response></Response>');
  expect(recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({
    isRead: false,
  }));
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
  expect(updateByTwilioSid.mock.calls[0][0]).toBe('SM-synthetic-solicitation');
  expect(JSON.parse(updateByTwilioSid.mock.calls[0][1].metadata.bindings[0]).spam_verdict)
    .toMatchObject({ solicitation: true, mode: 'shadow' });
  expect(updateByTwilioSid.mock.calls[0][1].is_read).toBeUndefined();
  const writes = mockWrites.filter(({ table }) => table === 'sms_log');
  expect(writes).toHaveLength(1);
  expect(writes[0].row.is_read).not.toBe(true);
  expect(JSON.parse(writes[0].row.metadata).spam_verdict).toMatchObject({ solicitation: true, mode: 'shadow', method: 'regex' });
  expect(handleClarifyReply).toHaveBeenCalledTimes(1);
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(processInboundSms).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});

test.each([[PITCH, true], ["Please stop texting me. I don't have any leads for you.", null]])(
  'shadow metadata preserves the existing opt-out response and suppression: %s', async (body, solicitation) => {
    const res = await receive(body);
    expect(res.body).toContain('<Message>');
    expect(res.body).toContain('unsubscribed');
    expect(recordSuppression).toHaveBeenCalledTimes(1);
    expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
    const row = mockWrites.find(({ table }) => table === 'sms_log').row;
    expect(row.message_type).toBe('opt_out');
    if (solicitation === null) expect(JSON.parse(row.metadata).spam_verdict).toBeUndefined();
    else expect(JSON.parse(row.metadata).spam_verdict).toMatchObject({ solicitation, mode: 'shadow' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  },
);

test.each([
  ['STOP', 'opt_out'], ['START', 'opt_in'], ['HELP', 'help_request'],
])('standalone %s retains its carrier response without classification', async (body, messageType) => {
  const res = await receive(body);
  expect(res.body).toContain('<Message>');
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe(messageType);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
});

test('known service contacts keep ordinary handling without a verdict', async () => {
  knownCallerPhoneExists.mockResolvedValue(true);
  await receive('We have exclusive pest leads for you.');
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(sendSMS).toHaveBeenCalledTimes(1);
});

test('a failed relationship lookup bypasses classification and keeps the message actionable', async () => {
  knownCallerPhoneExists.mockRejectedValueOnce(new Error('database unavailable'));
  await receive('Can you quote pest control?');
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
});

test('the unsupported true gate does no screening or relationship lookup', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  await receive('We have exclusive pest leads for you.');
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  expect(knownCallerPhoneExists).not.toHaveBeenCalled();
});

test('the model cannot start until the unified inbox message is durably saved', async () => {
  let finishSave;
  recordTouchpoint.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  const delivery = receive('Our software team wants to discuss a partnership.');
  await new Promise(setImmediate);
  try {
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(knownCallerPhoneExists).not.toHaveBeenCalled();
  } finally {
    finishSave({ message: { id: 'saved-inbound-message' } });
    await delivery;
  }
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
});

test('failed unified persistence bypasses screening and retains ordinary SMS logging', async () => {
  recordTouchpoint.mockResolvedValueOnce(null);
  await receive('Our software team wants to discuss a partnership.');
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(knownCallerPhoneExists).not.toHaveBeenCalled();
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.message_body).toBe('Our software team wants to discuss a partnership.');
  expect(JSON.parse(row.metadata).spam_verdict).toBeUndefined();
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
});
