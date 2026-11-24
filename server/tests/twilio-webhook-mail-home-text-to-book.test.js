// Inbound SMS webhook plumbing for the new-home postcard text ("Text 101 EXAMPLE to (941) 297-2817", mailer step 2d-3):
// where services/mail/home-text-to-book.js is called (after STOP/HELP/START and the lead-intake machine, office location
// lines only), and what a reply that went out does to the rest of the handling. Real webhook control flow; the service,
// intake machine, bell delivery and persistence are synthetic (the service has its own suite).
const mockState = {};
function resetState() {
  Object.assign(mockState, {
    sms: [], smsRetypes: [], priorInbound: false, drafts: [], sequence: 0, res: null, customer: null, techLookupFails: false, visionTaken: false, messageUpdates: [],
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
    if (table === 'sms_log' && patch.message_type) mockState.smsRetypes.push(patch);
    if (table !== 'messages') return 0;
    mockState.messageUpdates.push(patch);
    // visionTaken: a concurrent text won this message's vision reservation.
    return mockState.visionTaken && patch.photo_triage_at ? [] : [{ id: 'synthetic-message' }];
  };
  q.count = async () => [{ n: 0 }];
  q.first = async () => {
    if (table === 'messages') return { is_read: false };
    if (table === 'sms_log' && mockState.priorInbound) return { id: 'synthetic-prior' }; // the 4-hour repeat-sender read
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
  isEnabled: (key) => key === 'webhooks',
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
const mockAwaitingClarify = jest.fn(async () => false);
jest.mock('../services/estimate-clarify-asks', () => ({
  handleClarifyReply: async () => ({ handled: false }),
  hasAwaitingClarifyAsk: (...args) => mockAwaitingClarify(...args),
}));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => false }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: async () => ({}) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } })) }));
jest.mock('../services/sms-reply-alert-delivery', () => ({ ringSmsReplyBell: jest.fn(async () => ({ bellWritten: true })), ringUnknownOfficeText: jest.fn(async () => false) }));
jest.mock('../services/reschedule-sms', () => ({ handleRescheduleReply: async () => ({ handled: false }) }));
jest.mock('../services/customer-intelligence/event-rescore', () => ({ rescoreOnInboundMessage: async () => ({}) }));
jest.mock('../services/recruiting-inbound', () => ({ matchApplicantReply: async () => null }));
jest.mock('../services/context-aggregator', () => ({ getFullCustomerContext: async () => ({ summary: 'synthetic', flags: [] }), getContextForCustomer: async () => ({ summary: 'synthetic', flags: [] }) }));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
const mockCreate = jest.fn();
jest.mock('../services/photo-assessment-create', () => ({
  MAX_PHOTOS: 5,
  MESSAGE_PHOTO_ALLOWED_MIME: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  createAdminAssessment: (...args) => mockCreate(...args),
}));


const mockIntake = jest.fn();
const mockRecord = jest.fn();
jest.mock('../services/lead-intake', () => ({
  handleIntakeReply: (...args) => mockIntake(...args),
  recordCallTextReply: (...args) => mockRecord(...args),
}));

const mockRing = jest.fn(async () => ({ rang: true }));
jest.mock('../services/lead-call-reply-ring', () => ({ ringForCallReply: (...args) => mockRing(...args) }));


const mockOwnerAlert = jest.fn(async () => ({}));
jest.mock('../services/owner-alerts', () => ({ recordOwnerAlert: (...args) => mockOwnerAlert(...args) }));
const mockHomeText = jest.fn();
jest.mock('../services/mail/home-text-to-book', () => ({ handleHomeTextToBook: (...args) => mockHomeText(...args) }));

const { EventEmitter } = require('node:events');
const numbers = require('../config/twilio-numbers');
const TwilioService = require('../services/twilio');
const { ringSmsReplyBell, ringUnknownOfficeText } = require('../services/sms-reply-alert-delivery');
const handler = require('../routes/twilio-webhook').stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;

const sender = '+12025550101';
const parrishLine = numbers.locations.parrish.number;
const CUSTOMER = { id: 'ffffffff-0000-4111-8222-333333333333', first_name: 'Dana', last_name: 'Reed', phone: sender, lead_intake_status: 'awaiting_service' };

async function receive(body, to = parrishLine) {
  const res = new EventEmitter();
  mockState.res = res;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: sender, To: to, Body: body, MessageSid: `SM-home-${Date.now()}-${Math.random()}`, NumMedia: '0' } }, res);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetState();
  process.env = { ...savedEnv };
  delete process.env.ADAM_PHONE;
  mockState.customer = null; // a stranger who read the postcard
  mockIntake.mockResolvedValue({ handled: false });
  mockRecord.mockResolvedValue(undefined);
  mockHomeText.mockResolvedValue({ handled: false });
  mockAwaitingClarify.mockResolvedValue(false);
});
afterAll(() => { process.env = savedEnv; });

test('an office line text goes to the service with the line, the sender and the body', async () => {
  await receive('101 EXAMPLE');
  expect(mockHomeText).toHaveBeenCalledTimes(1);
  expect(mockHomeText.mock.calls[0][0]).toMatchObject({ from: sender, to: parrishLine, body: '101 EXAMPLE', customer: null });
});

test('the webhook\'s matched customer goes to the service (so that customer\'s SMS consent is checked)', async () => {
  mockState.customer = { ...CUSTOMER, lead_intake_status: null };
  await receive('101 EXAMPLE');
  expect(mockHomeText.mock.calls[0][0].customer).toMatchObject({ id: CUSTOMER.id });
});

test('an estimate address question waiting on this sender stands the postcard reply aside (read-only check, answer left to handleClarifyReply)', async () => {
  mockAwaitingClarify.mockResolvedValue(true);
  let standsAside;
  mockHomeText.mockImplementation(async ({ standAside }) => { standsAside = await standAside(); return { handled: false }; });
  await receive('101 EXAMPLE');
  expect(standsAside).toBe(true);
  expect(mockAwaitingClarify).toHaveBeenCalledWith({ phone: sender });
});

test('a reply that went out consumes the text: empty ack, inbound retyped, no ring, no AI reply, and the office bell rings once', async () => {
  mockHomeText.mockResolvedValue({ handled: true, prospectId: 'prospect-1' });
  mockState.customer = { ...CUSTOMER, lead_intake_status: null };
  const res = await receive('101 EXAMPLE');
  expect(res.body).toBe('<Response></Response>');
  expect(mockState.smsRetypes).toContainEqual({ message_type: 'mail_home_text_to_book' });
  // The same thread bell any text to an office line gets: once, for the known customer.
  expect(ringSmsReplyBell).toHaveBeenCalledTimes(1);
  expect(ringSmsReplyBell.mock.calls[0][0]).toMatchObject({ customer: { id: CUSTOMER.id }, message: '101 EXAMPLE' });
  expect(ringUnknownOfficeText).toHaveBeenCalledTimes(1);
  res.emit('finish');
  expect(mockRing).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('a stranger\'s consumed postcard text rings the unknown-sender office bell once and nothing else', async () => {
  mockHomeText.mockResolvedValue({ handled: true, prospectId: 'prospect-1' });
  ringUnknownOfficeText.mockResolvedValueOnce(true);
  const res = await receive('101 EXAMPLE');
  expect(res.body).toBe('<Response></Response>');
  expect(ringUnknownOfficeText).toHaveBeenCalledTimes(1);
  expect(ringUnknownOfficeText.mock.calls[0][0]).toMatchObject({ customer: null, From: sender, To: parrishLine, message: '101 EXAMPLE' });
  expect(ringSmsReplyBell).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('a consumed stranger text keeps the Activity fallback when the unknown-sender bell did not land', async () => {
  mockHomeText.mockResolvedValue({ handled: true, prospectId: 'prospect-1' });
  await receive('101 EXAMPLE'); // ringUnknownOfficeText resolves false (the default mock)
  expect(mockOwnerAlert).toHaveBeenCalledTimes(1);
});

test('a consumed stranger text keeps the 4-hour per-sender limit: a repeat sender gets no fallback alert', async () => {
  mockHomeText.mockResolvedValue({ handled: true, prospectId: 'prospect-1' });
  mockState.priorInbound = true; // this sender texted within the last 4 hours
  const res = await receive('101 EXAMPLE');
  expect(res.body).toBe('<Response></Response>');
  expect(ringUnknownOfficeText).toHaveBeenCalledTimes(1);
  expect(mockOwnerAlert).not.toHaveBeenCalled();
});

test('a text the service did not answer is handled as any other text', async () => {
  mockState.customer = { ...CUSTOMER, lead_intake_status: null };
  const res = await receive('101 EXAMPLE');
  expect(mockState.smsRetypes).toEqual([]);
  expect(ringSmsReplyBell).toHaveBeenCalledTimes(1);
  res.emit('finish');
  expect(mockRing).toHaveBeenCalledTimes(1);
});

test('a text the lead-intake machine consumed never reaches the service', async () => {
  mockState.customer = { ...CUSTOMER };
  mockIntake.mockResolvedValue({ handled: true, next: 'awaiting_address' });
  const res = await receive('101 EXAMPLE');
  expect(res.body).toBe('<Response></Response>');
  expect(mockHomeText).not.toHaveBeenCalled();
});

test.each([
  ['STOP', 'STOP'],
  ['HELP', 'HELP'],
  ['START', 'START'],
])('%s is handled first and never reaches the service', async (_label, body) => {
  await receive(body);
  expect(mockHomeText).not.toHaveBeenCalled();
});

test('the AI line, a technician line, the main line and a tracking line never reach the service', async () => {
  const techLine = numbers.fieldTech[0]?.number;
  expect(techLine).toBeTruthy();
  for (const to of [numbers.tollFree.number, techLine, numbers.mainLine.number, numbers.gbpTracking.parrish.number]) {
    await receive('101 EXAMPLE', to);
  }
  expect(mockHomeText).not.toHaveBeenCalled();
});

test('a reschedule ask never reaches the service', async () => {
  await receive("I won't be home Tuesday");
  expect(mockHomeText).not.toHaveBeenCalled();
});
