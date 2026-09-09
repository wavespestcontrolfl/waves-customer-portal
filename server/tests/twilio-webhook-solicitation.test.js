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
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => gate === 'webhooks'),
  gateEnvValue: (gate) => process.env[gate] === 'true',
}));
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
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(async () => ({ message: { id: 'saved-inbound-message' } })),
  updateByTwilioSid: jest.fn(async () => ({ id: 'saved-inbound-message' })),
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
jest.mock('../utils/known-caller-phone', () => ({ knownCallerPhoneExists: jest.fn(async () => false) }));
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

async function receive(body, to = numbers.locations.parrish.number) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: {
    From: '+12025550101', To: to,
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

test('the disabled gate does no screening or relationship lookup', async () => {
  delete process.env.GATE_SMS_SPAM_CLASSIFIER;
  await receive('We have exclusive pest leads for you.');
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  expect(knownCallerPhoneExists).not.toHaveBeenCalled();
});

test.each(['shadow', 'true'])('the %s model cannot start until the unified inbox message is durably saved', async (mode) => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = mode;
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

test.each(['shadow', 'true'])('failed unified persistence bypasses %s screening and retains ordinary SMS logging', async (mode) => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = mode;
  recordTouchpoint.mockResolvedValueOnce(null);
  await receive('Our software team wants to discuss a partnership.');
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(knownCallerPhoneExists).not.toHaveBeenCalled();
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.message_body).toBe('Our software team wants to discuss a partnership.');
  expect(JSON.parse(row.metadata).spam_verdict).toBeUndefined();
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'error'])('failed verdict attachment (%s) leaves the message actionable', async (failure) => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  if (failure === 'missing') updateByTwilioSid.mockResolvedValueOnce(null);
  else updateByTwilioSid.mockRejectedValueOnce(new Error('metadata unavailable'));
  await receive('We have exclusive pest leads for you.');
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.is_read).not.toBe(true);
  expect(JSON.parse(row.metadata).spam_verdict.enforced).toBe(false);
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});

test.each([
  ['location', PITCH], ['domain_tracking', PITCH], ['van_tracking', PITCH], ['tech_line', PITCH],
  ['location', 'We can send you more pest-control leads.'],
  ['location', 'We can provide you with more lawn leads.'],
  ['location', 'We provide you with unlimited estimates for local contractors.'],
  ['location', 'I can offer you qualified pest-control customers.'],
])(
  'an enforced pitch on a %s line persists read without replies or downstream work: %s', async (type, body) => {
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    const line = numbers.allNumbers.find((entry) => entry.type === (type === 'domain_tracking' ? 'pest_domain' : type));
    // Turn on tech-line routing only inside this test, using its actual registry.
    const savedTechGate = process.env.GATE_TECH_LINES;
    if (type === 'tech_line') process.env.GATE_TECH_LINES = 'true';
    try {
      const res = await receive(body, line.number);
      expect(res.body).toBe('<Response></Response>');
      expect(recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({
        isRead: false,
      }));
      expect(updateByTwilioSid.mock.calls[0][1]).toMatchObject({ is_read: true, read_at: expect.any(Date) });
      expect(JSON.parse(updateByTwilioSid.mock.calls[0][1].metadata.bindings[0]).spam_verdict.enforced).toBe(true);
      const writes = mockWrites.filter(({ table }) => table === 'sms_log');
      expect(writes).toHaveLength(1);
      expect(writes[0].row.is_read).toBe(true);
      expect(JSON.parse(writes[0].row.metadata).spam_verdict.enforced).toBe(true);
      expect(mockWrites.some(({ table }) => ['customers', 'activity_log'].includes(table))).toBe(false);
      expect(recordSuppression).not.toHaveBeenCalled();
      expect(handleClarifyReply).not.toHaveBeenCalled();
      expect(startSmsThreadDraft).not.toHaveBeenCalled();
      expect(processInboundSms).not.toHaveBeenCalled();
      expect(sendSMS).not.toHaveBeenCalled();
      expect(require('../services/tech-line').notifyTechLineText).not.toHaveBeenCalled();
    } finally {
      if (savedTechGate === undefined) delete process.env.GATE_TECH_LINES;
      else process.env.GATE_TECH_LINES = savedTechGate;
    }
  },
);

test.each([
  "Please stop texting me. I don't have any leads for you.",
  'We have exclusive leads. Please remove me from your list.',
  'I already tried to reply STOP to stop messages about exclusive leads, but you keep texting me.',
  'Your instructions told me to text STOP to stop messages about exclusive leads.',
  'Reply STOP to stop messages about exclusive leads did not work when I tried it.',
  `${PITCH}. Please stop texting me.`,
  'STOP',
])('a real opt-out outranks pitch markers in enforcement mode: %s', async (body) => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  const res = await receive(body);
  expect(res.body).toContain('unsubscribed');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe('opt_out');
  expect(recordTouchpoint.mock.calls[0][0].metadata.spam_verdict).toBeUndefined();
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(startSmsThreadDraft).not.toHaveBeenCalled();
});

test('a rental-service request remains actionable with enforcement enabled', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  await receive('We manage several rentals and can fill your schedule; please quote pest control');
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  expect(JSON.parse(updateByTwilioSid.mock.calls[0][1].metadata.bindings[0]).spam_verdict.enforced).toBe(false);
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});

test.each([
  'I have two leads for you: my neighbors both need pest control. Can you quote them?',
  'I have more lawn leads for you from my neighbors. Can you quote them?',
  'I can send you more pest-control leads from my neighbors. Can you quote them?',
  'We can provide you with more lawn leads from our neighbors who need service.',
  'My neighbors need service. I can send you more pest-control leads; can you quote them?',
  'I can provide you with more lawn leads. They are my neighbors and need quotes.',
])('a genuine referral remains unread and reaches ordinary handling in enforcement mode: %s', async (body) => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  await receive(body);
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.is_read).not.toBe(true);
  expect(JSON.parse(row.metadata).spam_verdict).toMatchObject({ solicitation: false, method: 'model', enforced: false });
  expect(recordSuppression).not.toHaveBeenCalled();
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});
