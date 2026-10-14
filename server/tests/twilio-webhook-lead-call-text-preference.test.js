// Inbound SMS webhook plumbing for GATE_LEAD_CALL_TEXT_PREFERENCE: when the
// intake machine reports a bare CALL / TEXT choice (it consumes nothing), the
// reply still takes the ordinary known-sender bell path and that bell is told
// the choice. Without the choice the bell call is exactly as before. Real
// webhook control flow; the intake machine, bell delivery and persistence are
// synthetic (the machine itself is covered in lead-intake-call-text-preference).
// suppression read, legacy drafter and persistence are synthetic.
const mockState = {};
function resetState() {
  Object.assign(mockState, {
    sms: [], drafts: [], sequence: 0, res: null, legacyGate: true, customer: null, techLookupFails: false, visionTaken: false, messageUpdates: [],
  });
}
resetState();

function mockDb(table) {
  const q = { rows: [] };
  for (const method of ['where', 'whereNot', 'whereIn', 'whereRaw', 'orWhereRaw', 'orWhere', 'whereNull', 'orderBy', 'limit', 'select', 'leftJoin']) q[method] = () => q;
  q.insert = (row) => {
    const stored = { id: `synthetic-${++mockState.sequence}`, created_at: new Date(Date.now() + mockState.sequence), ...row };
    if (table === 'sms_log') mockState.sms.push(stored);
    if (table === 'message_drafts') mockState.drafts.push(stored);
    q.rows = [stored]; return q;
  };
  q.update = async (patch) => {
    if (table !== 'messages') return 0;
    mockState.messageUpdates.push(patch);
    // visionTaken: a concurrent text won this message's vision reservation.
    return mockState.visionTaken && patch.photo_triage_at ? [] : [{ id: 'synthetic-message' }];
  };
  q.count = async () => [{ n: 0 }];
  q.first = async () => {
    if (table === 'messages') return { is_read: false };
    if (table === 'technicians' && mockState.techLookupFails) throw new Error('technicians unavailable');
    // hasPendingDraft: any pending draft already parked (one contact here).
    if (table === 'message_drafts as md') return mockState.drafts.find((d) => d.status === 'pending') || null;
    return null;
  };
  q.returning = async () => q.rows;
  q.then = (resolve, reject) => Promise.resolve(table === 'customers' && mockState.customer ? [mockState.customer] : q.rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(q.rows).catch(reject);
  return q;
}
mockDb.raw = async (sql) => ({ sql, rows: [] });
mockDb.fn = { now: () => 'NOW' };
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({
  isEnabled: (key) => key === 'webhooks' || (key === 'legacyAiDrafts' && mockState.legacyGate),
  gateEnvValue: (gate) => process.env[gate] === 'true',
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(),
  clearSuppression: jest.fn(),
  loadSuppressionState: async (_input, state) => Object.assign(state, { suppressionLoaded: true }),
  checkSuppression: async () => ({ ok: true }),
}));
jest.mock('../services/messaging/inbound-dedupe', () => ({ tryClaimInboundWebhook: async () => ({ processable: true, owned: true }), releaseInboundWebhook: jest.fn() }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({ message: { id: 'synthetic-message' } })), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({
  uploadTwilioMedia: jest.fn(async () => []),
  isSignableStoredMediaKey: (key) => String(key || '').startsWith('sms-media/inbound/'),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: () => false }));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: async () => ({ blocked: false }) }));
jest.mock('../services/contact-correction', () => ({ detectContactCorrectionIntent: () => false }));
jest.mock('../services/contact-correction-queue', () => ({}));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: async () => ({ handled: false }) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => false }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: async () => ({}) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } })) }));
jest.mock('../services/sms-reply-alert-delivery', () => ({ ringSmsReplyBell: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/reschedule-sms', () => ({ handleRescheduleReply: async () => ({ handled: false }) }));
jest.mock('../services/customer-intelligence/event-rescore', () => ({ rescoreOnInboundMessage: async () => ({}) }));
jest.mock('../services/recruiting-inbound', () => ({ matchApplicantReply: async () => null }));
jest.mock('../services/context-aggregator', () => ({ getFullCustomerContext: async () => ({ summary: 'synthetic', flags: [] }), getContextForCustomer: async () => ({ summary: 'synthetic', flags: [] }) }));
jest.mock('../services/response-drafter', () => ({ draftResponse: jest.fn(async () => ({ draft: 'Legacy synthetic draft' })) }));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
const mockCreate = jest.fn();
jest.mock('../services/photo-assessment-create', () => ({
  MAX_PHOTOS: 5,
  MESSAGE_PHOTO_ALLOWED_MIME: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  createAdminAssessment: (...args) => mockCreate(...args),
}));


const mockIntake = jest.fn();
jest.mock('../services/lead-intake', () => ({ handleIntakeReply: (...args) => mockIntake(...args) }));

const { EventEmitter } = require('node:events');
const numbers = require('../config/twilio-numbers');
const TwilioService = require('../services/twilio');
const { ringSmsReplyBell } = require('../services/sms-reply-alert-delivery');
const handler = require('../routes/twilio-webhook').stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;

const sender = '+12025550101';
const locationLine = Object.values(numbers.locations).map((l) => l.number)
  .find((n) => numbers.findByNumber(n)?.type === 'location' && n !== numbers.tollFree.number);
const CUSTOMER = { id: 'ffffffff-0000-4111-8222-333333333333', first_name: 'Dana', last_name: 'Reed', phone: sender, lead_intake_status: 'awaiting_service' };

async function receive(body) {
  const res = new EventEmitter();
  mockState.res = res;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: sender, To: locationLine, Body: body, MessageSid: `SM-pref-${Date.now()}`, NumMedia: '0' } }, res);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetState();
  process.env = { ...savedEnv };
  delete process.env.ADAM_PHONE;
  mockState.customer = { ...CUSTOMER };
  mockState.legacyGate = false;
});
afterAll(() => { process.env = savedEnv; });

test.each(['call', 'text'])('intake reports a %s choice: the bell is told, nothing is sent, the ack is empty', async (choice) => {
  mockIntake.mockResolvedValue({ handled: false, callTextPreference: choice });
  const res = await receive(choice);
  expect(res.body).toBe('<Response></Response>');
  expect(mockIntake).toHaveBeenCalledTimes(1);
  expect(ringSmsReplyBell).toHaveBeenCalledTimes(1);
  expect(ringSmsReplyBell.mock.calls[0][0]).toMatchObject({ customer: { id: CUSTOMER.id }, message: choice, leadPreference: choice });
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('no choice from intake (gate off, or an ordinary reply): the bell call carries no leadPreference key', async () => {
  mockIntake.mockResolvedValue({ handled: false });
  await receive('ants in the kitchen');
  expect(ringSmsReplyBell).toHaveBeenCalledTimes(1);
  expect(ringSmsReplyBell.mock.calls[0][0]).not.toHaveProperty('leadPreference');
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('an intake failure is swallowed and the bell still rings without a choice', async () => {
  mockIntake.mockRejectedValue(new Error('intake down'));
  await receive('call');
  expect(ringSmsReplyBell).toHaveBeenCalledTimes(1);
  expect(ringSmsReplyBell.mock.calls[0][0]).not.toHaveProperty('leadPreference');
});
