/**
 * Sandy PR 2A — /relay-complete on a transfer end frame rings the staff
 * simul-ring (same screen URLs as /voice, no query string), a sandbox
 * transfer hangs up, no HandoffData ⇒ today's bare Response, a failure ⇒
 * today's voicemail; press-1 speaks the whisper.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false), maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));

const db = require('../models/db');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { connectingAnnouncement, parseHandoffData } = voiceRouter._test;

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  if (!layer) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.type = jest.fn(() => res);
  res.send = jest.fn((body) => { res.body = body; return res; });
  return res;
}
function primeDb() {
  const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis() };
  const update = jest.fn(async () => 1);
  const builder = { update, where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }), first: jest.fn(async () => null), select: jest.fn(() => builder) };
  db.mockReturnValue(builder);
  return { builder, update, guardQ };
}

const TRANSFER = JSON.stringify({ reason: 'transfer', captured: false });
let savedNumbers;
beforeEach(() => {
  savedNumbers = process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
  process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '+19415550001,+19415550002';
  jest.clearAllMocks();
});
afterEach(() => {
  if (savedNumbers === undefined) delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS; else process.env.WAVES_FALLBACK_FORWARD_NUMBERS = savedNumbers;
});

describe('parseHandoffData', () => {
  test.each([[undefined], [''], ['not json'], ['[1,2]'], ['null']])('%j ⇒ {}', (raw) => {
    expect(parseHandoffData(raw)).toEqual({});
  });
  test('a JSON object string parses', () => {
    expect(parseHandoffData(TRANSFER)).toEqual({ reason: 'transfer', captured: false });
  });
});

describe('/relay-complete', () => {
  test('transfer ⇒ ai_transferred stamped (idempotent, terminal-guarded) + the staff Dial with the screen URLs and NO query string', async () => {
    const { update, guardQ, builder } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t1', HandoffData: TRANSFER }, query: {} }, res);
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA-t1');
    expect(guardQ.orWhereNotIn).toHaveBeenCalledWith('call_outcome', ['voicemail', 'relay_failed', 'ai_transferred']);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ call_outcome: 'ai_transferred' }));
    expect(res.body).toContain('<Dial record="record-from-answer-dual"');
    expect(res.body).toContain('action="/api/webhooks/twilio/call-complete"');
    expect(res.body).toContain('timeout="30"');
    expect(res.body).toContain('<Number url="/api/webhooks/twilio/inbound-forward-screen" method="POST">+19415550001</Number>');
    expect(res.body).toContain('+19415550002</Number>');
    expect(res.body).not.toMatch(/\?[a-z_]+=/i); // no summary, no id, nothing on any URL
    expect(res.body).not.toContain('<Record');
  });

  test('transfer with no staff numbers configured ⇒ voicemail (never a stranded caller)', async () => {
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '';
    for (const k of ['OWNER_PHONE', 'ADAM_PHONE', 'VIRGINIA_PHONE', 'OFFICE_MANAGER_PHONE']) delete process.env[k];
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t2', HandoffData: TRANSFER }, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
    // Re-classified as voicemail — /call-complete never runs on this recorder.
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
  });

  test('a sandbox transfer hangs up — a test call never rings staff', async () => {
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-sb', HandoffData: TRANSFER }, query: { sandbox: '1' } }, res);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Dial');
    expect(update).not.toHaveBeenCalled();
  });

  test('no HandoffData (caller hung up / agent finished) ⇒ today\'s bare Response', async () => {
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t3' }, query: {} }, res);
    expect(res.body).toMatch(/^<\?xml[^>]*\?><Response\/>$/);
    expect(update).not.toHaveBeenCalled();
  });

  test('a failed session with a transfer frame is still a failure ⇒ voicemail, not a staff ring', async () => {
    primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t4', ErrorCode: '64105', HandoffData: TRANSFER }, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
  });
});

describe('press-1 whisper', () => {
  test('a transferred row speaks the ≤20-word whisper; other rows keep today\'s lines', () => {
    const row = { metadata: JSON.stringify({ screen_caller_name: 'Pat Doe', relay_handoff: { context_available: true, caller_name: 'Pat Doe', intent: 'cancel service', unresolved_question: 'refund' } }) };
    expect(connectingAnnouncement(row)).toBe('Sandy transfer from Pat Doe: cancel service; refund.');
    expect(connectingAnnouncement({ metadata: { relay_handoff: { context_available: false } } })).toBe('Sandy transfer. The caller requested assistance; the summary was unavailable.');
    expect(connectingAnnouncement({ metadata: { screen_caller_name: 'Pat Doe' } })).toBe('Connecting your call from Pat Doe.');
    expect(connectingAnnouncement(null)).toBe('Connecting your call from an unknown number.');
  });
});
