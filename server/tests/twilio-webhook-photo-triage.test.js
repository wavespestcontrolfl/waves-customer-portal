// The inbound SMS webhook hands every persisted ordinary inbound to the
// photo-text triage AFTER the TwiML ack, with the source rows it needs, and a
// triage failure can never touch the response. The triage's own guards
// (gate, media, sender, opt-out, claim, cap) are pinned in
// photo-text-triage.test.js.
const mockState = { sms: [], sequence: 0, ackedBeforeTriage: null, res: null };
function mockDb(table) {
  const q = { rows: [] };
  for (const method of ['where', 'whereNot', 'whereIn', 'whereRaw', 'whereNull', 'orderBy', 'limit', 'select']) q[method] = () => q;
  q.insert = (row) => {
    const stored = { id: `synthetic-${++mockState.sequence}`, created_at: new Date(Date.now() + mockState.sequence), ...row };
    if (table === 'sms_log') mockState.sms.push(stored);
    q.rows = [stored]; return q;
  };
  q.update = async () => 0;
  q.first = async () => (table === 'messages' ? { is_read: false } : null);
  q.returning = async () => q.rows;
  q.then = (resolve, reject) => Promise.resolve(q.rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(q.rows).catch(reject);
  return q;
}
mockDb.raw = (sql) => ({ sql });
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ isEnabled: (key) => key === 'webhooks', gateEnvValue: () => false }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(), clearSuppression: jest.fn() }));
jest.mock('../services/messaging/inbound-dedupe', () => ({ tryClaimInboundWebhook: async () => ({ processable: true, owned: true }), releaseInboundWebhook: jest.fn() }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({ message: { id: 'synthetic-message' } })), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: () => false }));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: async () => ({ blocked: false }) }));
jest.mock('../services/contact-correction', () => ({ detectContactCorrectionIntent: () => false }));
jest.mock('../services/contact-correction-queue', () => ({}));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: async () => ({ handled: false }) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => false }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: async () => ({}) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } })) }));
jest.mock('../services/recruiting-inbound', () => ({ matchApplicantReply: async () => null }));
const mockTriage = jest.fn();
jest.mock('../services/photo-text-triage', () => ({
  triageInboundPhotoText: (...args) => {
    mockState.ackedBeforeTriage = mockState.res?.body === '<Response></Response>';
    return mockTriage(...args);
  },
}));

const { EventEmitter } = require('node:events');
const logger = require('../services/logger');
const { uploadTwilioMedia } = require('../services/sms-media');
const numbers = require('../config/twilio-numbers');
const handler = require('../routes/twilio-webhook').stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;

const sender = '+12025550101';
const locationLine = Object.values(numbers.locations).map((l) => l.number)
  .find((n) => numbers.findByNumber(n)?.type === 'location' && n !== numbers.tollFree.number);

async function receive(body) {
  const res = new EventEmitter();
  mockState.res = res;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: sender, To: locationLine, Body: body, MessageSid: 'SM-photo-1', NumMedia: '1' } }, res);
  const deadline = Date.now() + 2000;
  while (!mockTriage.mock.calls.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 5));
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.sms = []; mockState.sequence = 0; mockState.ackedBeforeTriage = null;
  uploadTwilioMedia.mockResolvedValue([{ key: 'sms-media/inbound/k1', contentType: 'image/jpeg', size: 10 }]);
  mockTriage.mockResolvedValue({ status: 'skipped', reason: 'gate_off' });
});

test('a location-line photo text reaches the triage after the ack, with its source rows', async () => {
  expect(locationLine).toBeTruthy();
  const res = await receive('what is this in my yard');
  expect(res.body).toBe('<Response></Response>');
  expect(mockTriage).toHaveBeenCalledTimes(1);
  expect(mockState.ackedBeforeTriage).toBe(true);
  const [args] = mockTriage.mock.calls[0];
  expect(args).toMatchObject({
    body: 'what is this in my yard',
    from: sender,
    numberType: 'location',
    isAiNumber: false,
    customer: null,
    media: [{ key: 'sms-media/inbound/k1', contentType: 'image/jpeg', size: 10 }],
    inboundTouchpoint: { message: { id: 'synthetic-message' } },
  });
  expect(args.smsLogEntry.id).toBe(mockState.sms.find((r) => r.direction === 'inbound').id);
});

test('a triage failure is logged and never changes the response', async () => {
  mockTriage.mockRejectedValue(new Error('vision exploded'));
  const res = await receive('bugs');
  expect(res.body).toBe('<Response></Response>');
  expect(res.statusCode).toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[photo-triage] inbound triage failed: vision exploded');
});
