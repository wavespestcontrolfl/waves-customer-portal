// GATE_RING_NEW_CONTACTS (owner 2026-11-04, "ring new"): a text from a number with no customer record to a location or
// Google profile line rings the one-row-per-sender new_lead bell, and the quiet Activity row is skipped only when the
// ring landed. Real webhook control flow; synthetic persistence and inert delivery seams (as in
// twilio-webhook-tracking-no-shell.test.js).
const mockState = { sms: [], sequence: 0, read: false, pending: 0 };
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
  q.whereRaw = (sql) => { if (sql.includes('sms_reply_alerted')) filters.push((r) => JSON.parse(r.metadata || '{}').sms_reply_alerted === true); return q; };
  for (const method of ['whereNull', 'orderBy', 'limit', 'select']) q[method] = () => q;
  const matches = () => mockState.sms.filter((r) => filters.every((f) => f(r)));
  q.insert = (row) => {
    const stored = { id: `synthetic-${++mockState.sequence}`, created_at: new Date(Date.now() + mockState.sequence), ...row };
    if (table === 'customers' || table === 'customer_accounts') throw new Error('An unknown sender must not mint customer rows');
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
jest.mock('../config/feature-gates', () => ({
  isEnabled: (key) => key === 'webhooks', gateEnvValue: () => false, smsCourtesyAfterTemplateLive: () => false,
  ringNewContactsLive: () => process.env.GATE_RING_NEW_CONTACTS === 'true',
}));
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
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/owner-alerts', () => ({ recordOwnerAlert: jest.fn(async () => ({})) }));
jest.mock('../services/admin-alert-names', () => ({ nameOnFileForPhone: jest.fn(async () => null) }));

const { EventEmitter } = require('node:events');
const { triggerNotification } = require('../services/notification-triggers');
const { recordOwnerAlert } = require('../services/owner-alerts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const numbers = require('../config/twilio-numbers');
const handler = require('../routes/twilio-webhook').stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;
const sender = '+12025550101';
const parrish = numbers.locations.parrish.number;
const sarasotaGbp = numbers.gbpTracking.sarasota.number;

async function receive(body, to, from = sender) {
  const sid = `SM-synthetic-${mockState.sequence + 1}`;
  const res = new EventEmitter();
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: from, To: to, Body: body, MessageSid: sid } }, res);
  // The route acknowledges before its notification work: let the detached part finish.
  let stable = 0;
  const deadline = Date.now() + 3000;
  while (stable < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    stable = mockState.pending ? 0 : stable + 1;
  }
  expect(res.body).toBe('<Response></Response>');
  expect(require('../services/logger').error.mock.calls).toEqual([]);
  return sid;
}
const leadRings = () => triggerNotification.mock.calls.filter(([key]) => key === 'new_lead');
const quietRows = () => recordOwnerAlert.mock.calls.filter(([kind]) => kind === 'inbound-text');

beforeEach(() => {
  jest.clearAllMocks();
  mockState.sms = []; mockState.sequence = 0; mockState.read = false;
  process.env.GATE_RING_NEW_CONTACTS = 'true';
  sendCustomerMessage.mockResolvedValue({ sent: true });
  triggerNotification.mockResolvedValue({ bellWritten: true, push: { sent: 1 } });
});
afterEach(() => { delete process.env.GATE_RING_NEW_CONTACTS; });

test.each([
  ['a location line', parrish, 'the Parrish (Pest) line'],
  ['a Google profile line', sarasotaGbp, 'the Sarasota Google profile line'],
])('an unknown sender on %s rings the one-row-per-sender bell and writes no quiet row', async (_name, to, source) => {
  const first = await receive('Do you treat for ants?', to);
  expect(mockState.sms[0].customer_id).toBeNull();
  expect(leadRings()).toHaveLength(1);
  expect(leadRings()[0][1]).toMatchObject({ twilioSid: first, source, message: 'Do you treat for ants?', textCount: 1 });
  expect(leadRings()[0][2]).toMatchObject({ dedupeKey: expect.stringMatching(/^sms-tracking-thread:[0-9a-f]{32}$/), refreshOnDedupe: true, bumpOnRefresh: true });
  expect(quietRows()).toHaveLength(0);
  // A second text from the same number keys the same row (refresh and push again), still no quiet row.
  await receive('Also spiders.', to);
  expect(leadRings()).toHaveLength(2);
  expect(leadRings()[1][2].dedupeKey).toBe(leadRings()[0][2].dedupeKey);
  expect(quietRows()).toHaveLength(0);
});

test('a ring that did not land, or threw, leaves the quiet row as the fallback', async () => {
  triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 0 } });
  await receive('Do you treat for ants?', parrish);
  expect(leadRings()).toHaveLength(1);
  expect(quietRows()).toHaveLength(1);
  triggerNotification.mockRejectedValueOnce(new Error('bell down'));
  await receive('Hello?', parrish, '+12025550102');
  expect(quietRows()).toHaveLength(2);
});

test('gate off: no ring, the quiet row as before', async () => {
  delete process.env.GATE_RING_NEW_CONTACTS;
  await receive('Do you treat for ants?', parrish);
  expect(leadRings()).toHaveLength(0);
  expect(quietRows()).toHaveLength(1);
});

test('a courtesy closer after our text neither rings nor writes a quiet row', async () => {
  mockState.sms.push({ direction: 'outbound', to_phone: sender, from_phone: parrish,
    status: 'sent', message_type: 'manual', message_body: 'We will take care of it.', created_at: new Date() });
  await receive('Thanks!', parrish);
  expect(leadRings()).toHaveLength(0);
  expect(quietRows()).toHaveLength(0);
});

test('a tech line is not rung (the tech-line text keeps its own path)', async () => {
  await receive('Running late?', numbers.fieldTech[0].number);
  expect(leadRings()).toHaveLength(0);
});
