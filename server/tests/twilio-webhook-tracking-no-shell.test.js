// Real webhook control flow; synthetic persistence and inert delivery seams.
const mockState = { sms: [], sequence: 0, ai: true, read: false, pending: 0 };
function mockDb(table) {
  const filters = [];
  const q = { rows: [] };
  q.where = (key, op, value) => {
    if (key && typeof key === 'object') filters.push((r) => Object.entries(key).every(([k, v]) => r[k] === v));
    else if (typeof key === 'string') filters.push((r) => value === undefined ? r[key] === op : op === '<' ? r[key] < value : r[key] > value);
    return q;
  };
  q.whereNot = (key, value) => { filters.push((r) => r[key] !== value); return q; };
  q.whereIn = (key, values) => { filters.push((r) => values.includes(r[key])); return q; };
  q.whereRaw = (sql) => { if (sql.includes("sms_reply_alerted")) filters.push((r) => JSON.parse(r.metadata || '{}').sms_reply_alerted === true); return q; };
  for (const method of ['whereNull', 'orderBy', 'limit', 'select']) q[method] = () => q;
  const matches = () => mockState.sms.filter((r) => filters.every((f) => f(r)));
  q.insert = (row) => {
    const stored = { id: `synthetic-${++mockState.sequence}`, created_at: new Date(Date.now() + mockState.sequence), ...row };
    if (table === 'customers' || table === 'customer_accounts') throw new Error('Tracking must not mint customer rows');
    if (table === 'sms_log') mockState.sms.push(stored);
    q.rows = [stored]; return q;
  };
  q.update = async (patch) => {
    if (table === 'sms_log') for (const row of matches()) {
      if (patch.metadata?.merge) row.metadata = JSON.stringify({ ...JSON.parse(row.metadata || '{}'), ...patch.metadata.merge });
    }
    return matches().length;
  };
  q.first = async () => table === 'messages' ? { is_read: mockState.read }
    : table === 'sms_log' ? matches()[0] || null : null;
  q.returning = async () => q.rows;
  q.then = (resolve, reject) => Promise.resolve(q.rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(q.rows).catch(reject);
  return q;
}
mockDb.raw = (sql) => ({ sql });
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ isEnabled: (key) => key === 'webhooks' || (key === 'aiAssistantAutoReply' && mockState.ai) }));
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
jest.mock('../services/recipient-optin', () => ({ markRecipientOptin: async () => true }));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: async () => ({ handled: false }) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => false }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: async () => ({}) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } })) }));
jest.mock('../services/ai-assistant/assistant', () => ({ processMessage: jest.fn(async () => ({ reply: 'Synthetic answer', escalated: false })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));

const { EventEmitter } = require('node:events');
const { triggerNotification } = require('../services/notification-triggers');
const { processMessage } = require('../services/ai-assistant/assistant');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { uploadTwilioMedia } = require('../services/sms-media');
const numbers = require('../config/twilio-numbers');
const handler = require('../routes/twilio-webhook').stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;
const aiLine = '+18559260203';
const sender = '+12025550101';
async function receive(body = 'What services do you offer?', to = aiLine) {
  const sid = `SM-synthetic-${mockState.sequence + 1}`;
  const res = new EventEmitter();
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: sender, To: to, Body: body, MessageSid: sid } }, res);
  // The real route acknowledges before its notification work. Drain the
  // tracked PostgreSQL promises rather than asserting immediately after ACK.
  let stable = 0;
  const deadline = Date.now() + 3000;
  while (stable < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    stable = mockState.pending ? 0 : stable + 1;
  }
  expect(mockState.pending).toBe(0);
  expect(res.body).toBe('<Response></Response>');
  const errors = require('../services/logger').error.mock.calls.filter(([message]) => !String(message).startsWith('AI '));
  expect(errors).toEqual([]);
  return sid;
}
beforeEach(async () => {
  jest.clearAllMocks();
  mockState.sms = []; mockState.sequence = 0; mockState.ai = false; mockState.read = false;
  processMessage.mockResolvedValue({ reply: 'Synthetic answer', escalated: false });
  sendCustomerMessage.mockResolvedValue({ sent: true });
  triggerNotification.mockResolvedValue({ bellWritten: true, push: { sent: 1 } });
  uploadTwilioMedia.mockResolvedValue([]);
});

test.each([0, 1])('tracking line %s logs unknown senders without creating customers and passes a message tag', async (kind) => {
  const to = kind === 0 ? numbers.domainTracking[0].number : numbers.tracking.vanWrap.number;
  const sid = await receive('Please quote service for the garden shed.', to);
  expect(mockState.sms[0].customer_id).toBeNull();
  expect(triggerNotification).toHaveBeenCalledWith('new_lead', expect.objectContaining({
    twilioSid: sid, name: 'Unknown sender', link: '/admin/communications',
  }));
  expect(require('../services/conversations').recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({ customerId: undefined }));
});

test('a courtesy-only tracking reply stays read and does not alert', async () => {
  const to = numbers.domainTracking[0].number;
  mockState.sms.push({ direction: 'outbound', to_phone: sender, from_phone: to,
    status: 'sent', message_type: 'manual', message_body: 'We will take care of it.', created_at: new Date() });
  await receive('Thanks!', to);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(mockState.sms.at(-1).is_read).toBe(true);
});
