// Exercise the real webhook, carrier-command detector, and solicitation screen.
// Persistence and providers are mocked; no SMS or customer record is touched.
const mockWrites = [];
const mockWhereRawCalls = [];
// The /sms handler's only reachable db('sms_log')...first() call in an
// unknown-sender flow is the repeat-sender alert-quota check — queueing a
// row here simulates "a prior sms_log row exists" for that one check.
const mockSmsLogFirstQueue = [];
// findSingleCustomerByPhone runs a raw db('customers')... query — set this
// to simulate a matched customer for the sender (null/[] = no match).
let mockCustomersRows = null;
function mockDb(table) {
  const query = { rows: table === 'customers' && mockCustomersRows ? mockCustomersRows : [] };
  for (const method of ['where', 'whereNull', 'whereNot', 'orderBy', 'limit']) {
    query[method] = () => query;
  }
  query.whereRaw = (...args) => { mockWhereRawCalls.push({ table, args }); return query; };
  query.insert = (row) => {
    mockWrites.push({ table, row });
    query.rows = [{ id: '00000000-0000-4000-8000-000000000001', created_at: new Date(), ...row }];
    // notification_prefs upsert (opt-out prefs write) chains onConflict().merge().
    query.onConflict = () => query;
    query.merge = async () => query.rows;
    return query;
  };
  query.first = async () => (table === 'sms_log' && mockSmsLogFirstQueue.length ? mockSmsLogFirstQueue.shift() : null);
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
const { uploadTwilioMedia } = require('../services/sms-media');
const { knownCallerPhoneExists, findKnownCallerCustomer } = require('../utils/known-caller-phone');
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
  mockWhereRawCalls.length = 0;
  mockSmsLogFirstQueue.length = 0;
  mockCustomersRows = null;
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
    // Codex P1 chokepoint fix, 2026-09-11: a regex marker alone is never a
    // terminal enforce verdict — `body` matches the regex fast path (see
    // isSolicitationPitch), but in enforce mode that only routes it to the
    // model below; only the model's OWN confident verdict may enforce.
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: 0.95 } });
    const line = numbers.allNumbers.find((entry) => entry.type === (type === 'domain_tracking' ? 'pest_domain' : type));
    // Turn on tech-line routing only inside this test, using its actual registry.
    const savedTechGate = process.env.GATE_TECH_LINES;
    if (type === 'tech_line') process.env.GATE_TECH_LINES = 'true';
    try {
      const res = await receive(body, line.number);
      expect(res.body).toBe('<Response></Response>');
      // The regex fast path never terminates enforcement on its own — the
      // model is always consulted in enforce mode, and the persisted
      // verdict method is 'model', not 'regex'.
      expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
      expect(recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({
        isRead: false,
      }));
      // Codex P1, 2026-09-11: the unified copy is marked read only in a
      // SECOND call, made after the legacy sms_log row (first call carries
      // only the verdict metadata, with no is_read) — a crash between the
      // two calls must never leave a read unified copy with no legacy row.
      expect(updateByTwilioSid.mock.calls[0][1].is_read).toBeUndefined();
      expect(JSON.parse(updateByTwilioSid.mock.calls[0][1].metadata.bindings[0]).spam_verdict).toMatchObject({ enforced: true, method: 'model' });
      expect(updateByTwilioSid.mock.calls[1][1]).toMatchObject({ is_read: true, read_at: expect.any(Date) });
      const writes = mockWrites.filter(({ table }) => table === 'sms_log');
      expect(writes).toHaveLength(1);
      expect(writes[0].row.is_read).toBe(true);
      expect(JSON.parse(writes[0].row.metadata).spam_verdict).toMatchObject({ enforced: true, method: 'model' });
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

// Codex P1 chokepoint fix, 2026-09-11: the invariant is structural, not
// per-phrasing — a regex-only verdict must never reach the enforce
// threshold on its own, even when the model is never reached because it
// is unavailable. `body` matches the regex fast path; the model call
// fails, so the message stays actionable exactly like any other
// model-unavailable path in this screen.
test('a regex-strength pitch never enforces when the model is unavailable', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  dispatchWithFallback.mockRejectedValue(new Error('timeout'));
  await receive(PITCH);
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.is_read).not.toBe(true);
  expect(JSON.parse(row.metadata).spam_verdict).toMatchObject({ solicitation: false, method: 'model_failed', enforced: false });
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});

// Codex P1 chokepoint fix, 2026-09-11 (pre-push): the screen only ever
// classifies `Body`, the caption text — an attached photo's own content is
// never read. A regex-strength (or model-confirmed) caption must not
// enforce when media is attached, since the decision would be made on
// incomplete context; the message gets ordinary handling instead.
test('an MMS with a regex-strength caption is never screened — media content was never classified', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  uploadTwilioMedia.mockResolvedValueOnce([{ url: 'https://example.com/photo.jpg', contentType: 'image/jpeg' }]);
  dispatchWithFallback.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: 0.95 } });
  await receive(PITCH);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.is_read).not.toBe(true);
  expect(JSON.parse(row.metadata).spam_verdict).toBeUndefined();
  expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  expect(sendSMS).toHaveBeenCalledTimes(1);
});

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
  'I have three qualified leads for you—my neighbors all need pest control. Can you quote them?',
  'I can provide you with more pest-control leads. They are my friends who need quotes. Can you quote them?',
  'We have qualified pest control jobs available at five rental homes we manage. Can you quote all of them?',
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

// Codex P0, 2026-09-11: the footer guard hung off `solicitationEnforced`, so
// every fail-open path in enforcement mode fell back to the legacy detector and
// read the vendor's own "Reply STOP to stop messages" as the sender's request —
// a real suppression row plus an unsubscribe reply from a Waves line, which is
// the 2026-07-23 incident. The guard now follows the MODE.
test.each([
  ['a failed verdict write (missing row)', PITCH, () => updateByTwilioSid.mockResolvedValueOnce(null)],
  ['a failed verdict write (error)', PITCH, () => updateByTwilioSid.mockRejectedValueOnce(new Error('metadata unavailable'))],
  ['a screen that throws', PITCH, () => knownCallerPhoneExists.mockRejectedValueOnce(new Error('lookup down'))],
  ['a non-solicitation model verdict', 'Checking in about last week. Reply STOP to stop messages.', () => {}],
  ['a low-confidence solicitation verdict', 'Checking in about last week. Reply STOP to stop messages.',
    () => dispatchWithFallback.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: 0.5 } })],
])('%s never lets a reply footer become the sender\'s opt-out in enforcement mode', async (_label, body, arrange) => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  arrange();
  const res = await receive(body);
  // The security property: no suppression record, no unsubscribe reply.
  expect(recordSuppression).not.toHaveBeenCalled();
  expect(res.body).not.toContain('unsubscribed');
  expect(sendSMS).not.toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('unsubscribed') }));
  // Fail-open means the text stays ordinary and actionable, not enforced.
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.message_type).not.toBe('opt_out');
  expect(row.is_read).not.toBe(true);
  expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
});

test('shadow mode still honors a reply footer exactly as before the enforcement stage', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'shadow';
  const res = await receive(PITCH);
  expect(res.body).toContain('unsubscribed');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
});

// Codex P1, 2026-09-11: an enforced pitch's own sms_log row was counted as a
// "prior inbound" by the repeat-unknown-sender alert-quota check, so a
// genuine request from the same unknown number within the 4h window lost its
// owner alert to a text that had already been silently screened out.
test('the repeat-sender alert-quota check excludes enforced solicitation rows from its window', async () => {
  // An enforced pitch (like PITCH) returns before this check ever runs for
  // ITS OWN message — the bug, and this exclusion, only matter for the next
  // genuine message from the same unknown sender, which is what this covers.
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  await receive('Can we schedule for Tuesday?');
  const call = mockWhereRawCalls.find(({ table, args }) => table === 'sms_log' && /spam_verdict/.test(args[0]));
  expect(call).toBeDefined();
  expect(call.args[0]).toMatch(/enforced/);
});

test('a genuine prior inbound (not an enforced verdict) still suppresses the repeat owner alert', async () => {
  mockSmsLogFirstQueue.push({ id: 'prior-row' });
  const res = await receive('Can we schedule for Tuesday?');
  expect(res.body).toBe('<Response></Response>');
  expect(sendSMS).not.toHaveBeenCalledWith(process.env.ADAM_PHONE, expect.stringContaining('📩 New SMS'), expect.anything());
});

test('a first-contact unknown sender with no prior row still gets the owner alert', async () => {
  const res = await receive('Can we schedule for Tuesday?');
  expect(res.body).toBe('<Response></Response>');
  expect(sendSMS).toHaveBeenCalledWith(process.env.ADAM_PHONE, expect.stringContaining('📩 New SMS'), expect.anything());
});

// Codex P1, 2026-09-11: the unified copy was marked read at classification
// time, well before the legacy sms_log row existed — a crash in between left
// only a read unified copy, with the durable webhook claim still owned (so a
// Twilio retry was rejected as a duplicate) and no legacy row, alert, or
// downstream handling ever created. The read-mark must land strictly after
// the legacy row is durably persisted.
test('the unified copy is marked read only after the legacy sms_log row is persisted', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  // Codex P1 chokepoint fix, 2026-09-11: PITCH matches the regex fast path,
  // but enforce mode routes it through the model regardless — only the
  // model's own confident verdict enforces (and reaches the read-mark path
  // this test exercises).
  dispatchWithFallback.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: 0.95 } });
  const callOrder = [];
  updateByTwilioSid.mockImplementation(async (sid, patch) => {
    callOrder.push({
      op: 'updateByTwilioSid', isRead: patch.is_read === true,
      smsLogRowsSoFar: mockWrites.filter(({ table }) => table === 'sms_log').length,
    });
    return { id: 'saved-inbound-message' };
  });
  await receive(PITCH);
  const readCall = callOrder.find((c) => c.isRead);
  expect(readCall).toBeDefined();
  // At least one sms_log row already existed when the read-marking call fired.
  expect(readCall.smsLogRowsSoFar).toBeGreaterThanOrEqual(1);
  const metadataOnlyCall = callOrder.find((c) => !c.isRead);
  expect(metadataOnlyCall).toBeDefined();
  expect(metadataOnlyCall.smsLogRowsSoFar).toBe(0);
});

// Claude-fallback P1 (codex out of quota), 2026-09-11: solicitation
// screening only ever runs for !customer senders, but the footer-stripping
// flag was keyed on enforcement mode alone and applied to every
// complianceEligible sender — including a matched customer, who is never a
// solicitation-screening candidate. A real customer's own opt-out phrased
// with reply-instruction grammar must never be silently dropped.
test('a known customer\'s own opt-out is never stripped as a vendor footer, even in enforcement mode', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  mockCustomersRows = [{ id: 'cust-1', first_name: 'Known', last_name: 'Customer', phone: '+12025550101' }];
  const res = await receive('Reply STOP to stop messages');
  expect(res.body).toContain('unsubscribed');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe('opt_out');
  // A matched customer is never a solicitation-screening candidate.
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

// Codex P0, 2026-09-11: `customer` is findSingleCustomerByPhone, a
// customers.phone-only match. A sender known solely through a service-contact
// or secondary-phone column (spouse/tenant/manager slot) is `!customer` but
// still a known relationship per knownCallerPhoneExists — the footer guard
// must be keyed on that full recognition set, not the primary-only match, or
// their own genuine opt-out gets silently dropped as if it were a vendor's
// spoofed compliance footer.
test('a service-contact-only known sender\'s own opt-out is never stripped, even in enforcement mode', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  // No primary customers.phone match — mockCustomersRows stays null — but the
  // sender is known through service_contact_phone/secondary_phone, which is
  // exactly what knownCallerPhoneExists recognizes.
  knownCallerPhoneExists.mockResolvedValue(true);
  const res = await receive('Reply STOP to stop messages');
  expect(res.body).toContain('unsubscribed');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe('opt_out');
  // Known via the relationship lookup, not the primary match — never a
  // solicitation-screening candidate either (mirrors the classifier gate,
  // which already uses this same knownCallerPhoneExists result).
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

// Codex P1 follow-up, 2026-09-11: a failed unified-inbox persistence skips
// the classifier gate entirely (recordTouchpoint's message id never lands),
// so knownCallerPhoneExists/`known` never runs and stays at its default
// false — but the always-on compliance relationship lookup
// (findKnownCallerCustomer, feeding complianceEligible on every message
// regardless of persistence) still resolves this same service contact.
// That already-successful result must still count for the footer decision,
// or a known sender's genuine opt-out is silently dropped by an unrelated
// persistence failure.
test('a failed unified persistence bypass still honors a known service contact\'s own opt-out', async () => {
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
  recordTouchpoint.mockResolvedValueOnce(null);
  findKnownCallerCustomer.mockResolvedValueOnce({ id: 'contact-1', first_name: 'Service', last_name: 'Contact' });
  const res = await receive('Reply STOP to stop messages');
  expect(res.body).toContain('unsubscribed');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe('opt_out');
  // The classifier gate itself never ran — persistence failed before it.
  expect(knownCallerPhoneExists).not.toHaveBeenCalled();
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});
