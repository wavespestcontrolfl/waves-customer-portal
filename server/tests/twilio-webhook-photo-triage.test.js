// The inbound SMS webhook runs the photo-text triage in two steps after the
// TwiML ack: the candidacy check is awaited BEFORE the legacy AI draft step
// (whose gate reads it), and the triage run is detached after it. Real
// webhook control flow and the REAL triage service; the assessment pipeline,
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
jest.mock('../services/context-aggregator', () => ({ getFullCustomerContext: async () => ({ summary: 'synthetic', flags: [] }) }));
jest.mock('../services/response-drafter', () => ({ draftResponse: jest.fn(async () => ({ draft: 'Legacy synthetic draft' })) }));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
const mockCreate = jest.fn();
jest.mock('../services/photo-assessment-create', () => ({
  MAX_PHOTOS: 5,
  MESSAGE_PHOTO_ALLOWED_MIME: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  createAdminAssessment: (...args) => mockCreate(...args),
}));

const { EventEmitter } = require('node:events');
const logger = require('../services/logger');
const { uploadTwilioMedia } = require('../services/sms-media');
const numbers = require('../config/twilio-numbers');
const triage = require('../services/photo-text-triage');
const handler = require('../routes/twilio-webhook').stack.find((l) => l.route?.path === '/sms').route.stack[0].handle;

const sender = '+12025550101';
const locationLine = Object.values(numbers.locations).map((l) => l.number)
  .find((n) => numbers.findByNumber(n)?.type === 'location' && n !== numbers.tollFree.number);
const CUSTOMER = { id: 'ffffffff-0000-4111-8222-333333333333', first_name: 'Dana', last_name: 'Reed', phone: sender };

async function settle(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 20));
}

async function receive(body) {
  const res = new EventEmitter();
  mockState.res = res;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: sender, To: locationLine, Body: body, MessageSid: `SM-photo-${Date.now()}`, NumMedia: '1' } }, res);
  await settle(() => mockState.drafts.length > 0 || logger.error.mock.calls.length > 0);
  return res;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetState();
  process.env = { ...savedEnv, GATE_PHOTO_TRIAGE: 'true' };
  delete process.env.ADAM_PHONE;
  mockState.customer = CUSTOMER;
  uploadTwilioMedia.mockResolvedValue([{ key: 'sms-media/inbound/k1', contentType: 'image/jpeg', size: 10 }]);
  mockCreate.mockResolvedValue({
    id: 'assess-1',
    type: 'lawn',
    analysis: { report_contract: JSON.stringify({ diagnosis: { findings: [] } }), overall_score: 50, created_at: new Date() },
  });
  mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'none' } });
});
afterAll(() => { process.env = savedEnv; });

test('both gates on + diagnostic photo text from a known customer → exactly one photo_triage draft, no legacy draft', async () => {
  const res = await receive('what is this in my lawn?');
  expect(res.body).toBe('<Response></Response>');
  expect(mockState.drafts).toHaveLength(1);
  expect(mockState.drafts[0]).toMatchObject({ intent: 'photo_triage', status: 'pending', customer_id: CUSTOMER.id });
  expect(require('../services/response-drafter').draftResponse).not.toHaveBeenCalled();
  expect(mockCreate).toHaveBeenCalledTimes(1);
  // Fast-path caption: the paid classifier never ran.
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('[photo-triage] legacy AI draft deferred to photo triage for message synthetic-message');
});

test('both gates on + non-diagnostic photo text → legacy draft as before, classifier run once, no triage', async () => {
  await receive('Here is the receipt you asked for');
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockState.drafts).toHaveLength(1);
  expect(mockState.drafts[0].draft_response).toBe('Legacy synthetic draft');
  expect(mockState.drafts[0].intent).not.toBe('photo_triage');
});

test('GATE_PHOTO_TRIAGE off → legacy behavior untouched, no triage work at all', async () => {
  delete process.env.GATE_PHOTO_TRIAGE;
  await receive('what is this in my lawn?');
  expect(mockState.drafts).toHaveLength(1);
  expect(mockState.drafts[0].draft_response).toBe('Legacy synthetic draft');
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

test('legacy gate off: the triage still drafts; legacyAiDraftsAllowed stays false', async () => {
  mockState.legacyGate = false;
  await receive('what is this in my lawn?');
  expect(mockState.drafts.map((d) => d.intent)).toEqual(['photo_triage']);
  expect(triage.legacyAiDraftsAllowed({ candidate: false })).toBe(false);
  mockState.legacyGate = true;
  expect(triage.legacyAiDraftsAllowed({ candidate: false })).toBe(true);
  expect(triage.legacyAiDraftsAllowed({ candidate: true, messageId: 'm' })).toBe(false);
});

test('vision failure after paid analysis → one legacy fallback draft, no photo_triage draft, slot stays spent', async () => {
  const err = new Error('vision exploded');
  err.analysisStarted = true;
  mockCreate.mockRejectedValue(err);
  const res = await receive('what is this in my lawn?');
  expect(res.body).toBe('<Response></Response>');
  expect(res.statusCode).toBeUndefined();
  await settle(() => mockState.drafts.length > 0);
  expect(logger.error).toHaveBeenCalledWith(
    '[photo-triage] assessment failed for message synthetic-message; vision slot kept (analysis started): vision exploded',
  );
  expect(mockState.drafts.map((d) => d.draft_response)).toEqual(['Legacy synthetic draft']);
  expect(mockState.drafts.filter((d) => d.intent === 'photo_triage')).toHaveLength(0);
  expect(mockState.messageUpdates).toEqual([{ photo_triage_at: 'NOW' }]);
});

test('failure before paid analysis → stamp released AND legacy fallback draft parked', async () => {
  mockCreate.mockRejectedValue(new Error('S3 timeout'));
  await receive('what is this in my lawn?');
  await settle(() => mockState.drafts.length > 0);
  expect(logger.error).toHaveBeenCalledWith(
    '[photo-triage] assessment failed for message synthetic-message; vision slot released: S3 timeout',
  );
  expect(mockState.messageUpdates).toEqual([{ photo_triage_at: 'NOW' }, { photo_triage_at: null }]);
  expect(mockState.drafts.map((d) => d.draft_response)).toEqual(['Legacy synthetic draft']);
});

test('fallback goes through the contact dedupe: a pending draft that appeared meanwhile blocks it', async () => {
  // A concurrent text from the same contact parked its draft while this
  // one's assessment ran, then this assessment failed terminally.
  mockCreate.mockImplementation(async () => {
    mockState.drafts.push({ id: 'concurrent', status: 'pending', intent: 'photo_triage' });
    throw new Error('S3 timeout');
  });
  await receive('what is this in my lawn?');
  await settle(() => logger.info.mock.calls.some(([m]) => String(m).includes('a pending draft already exists')));
  expect(mockState.drafts.map((d) => d.id)).toEqual(['concurrent']);
  expect(require('../services/response-drafter').draftResponse).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith(`[sms-intent] legacy AI draft skipped for customer ${CUSTOMER.id}: a pending draft already exists`);
});

test('legacy gate off: a failed triage parks nothing (the fallback honors the gate)', async () => {
  mockState.legacyGate = false;
  mockCreate.mockRejectedValue(new Error('S3 timeout'));
  await receive('what is this in my lawn?');
  await settle(() => logger.info.mock.calls.some(([m]) => String(m).includes('parking the legacy AI draft instead')));
  expect(mockState.drafts).toHaveLength(0);
});

test('a lost vision reservation is not a candidate: the legacy draft still goes out', async () => {
  mockState.visionTaken = true;
  await receive('what is this in my lawn?');
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockState.drafts.map((d) => d.draft_response)).toEqual(['Legacy synthetic draft']);
});

test('a candidacy check failure is logged and falls back to the legacy draft', async () => {
  mockState.techLookupFails = true;
  const res = await receive('what is this in my lawn?');
  expect(res.body).toBe('<Response></Response>');
  await settle(() => mockState.drafts.length > 0);
  expect(logger.error).toHaveBeenCalledWith('[photo-triage] candidacy check failed: technicians unavailable');
  expect(mockState.drafts.map((d) => d.draft_response)).toEqual(['Legacy synthetic draft']);
  expect(mockCreate).not.toHaveBeenCalled();
});
