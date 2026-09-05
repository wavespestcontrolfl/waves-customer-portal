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
function primeDb({ rows = 1 } = {}) {
  const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis() };
  const update = jest.fn(async () => rows);
  const builder = { update, where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }), whereRaw: jest.fn(() => builder), first: jest.fn(async () => null), select: jest.fn(() => builder) };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
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
  test('transfer ⇒ the ring is CLAIMED once (ai_transferred stamped only when not terminal) + the staff Dial with the screen URLs and NO query string', async () => {
    const { update, builder } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t1', HandoffData: TRANSFER }, query: {} }, res);
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA-t1');
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_transfer_ring_at'));
    // Owner-bound: the frame's claim owner rides the claim (null for an unclaimed session).
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), [null]);
    const res2 = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t1b', HandoffData: JSON.stringify({ reason: 'transfer', owner: 'nonce-MINE' }) }, query: {} }, res2);
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), ['nonce-MINE']);
    const patch = update.mock.calls[0][0];
    expect(patch.call_outcome.sql).toMatch(/NOT IN \(\?, \?, \?\) THEN \?/);
    expect(patch.call_outcome.bindings).toEqual(['voicemail', 'relay_failed', 'ai_transferred', 'ai_transferred']);
    expect(patch.metadata.sql).toContain('relay_transfer_ring_at');
    expect(res.body).toContain('<Dial record="record-from-answer-dual"');
    expect(res.body).toContain('action="/api/webhooks/twilio/call-complete"');
    expect(res.body).toContain('timeout="30"');
    expect(res.body).toContain('<Number url="/api/webhooks/twilio/inbound-forward-screen" method="POST">+19415550001</Number>');
    expect(res.body).toContain('+19415550002</Number>');
    expect(res.body).not.toMatch(/\?[a-z_]+=/i); // no summary, no id, nothing on any URL
    expect(res.body).not.toContain('<Record');
  });

  test('a Twilio RETRY of the transfer callback (ring already claimed ⇒ 0 rows) gets a bare response, never a second staff ring', async () => {
    primeDb({ rows: 0 });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-retry', HandoffData: TRANSFER }, query: {} }, res);
    expect(res.body).toMatch(/^<\?xml[^>]*\?><Response\/>$/);
  });

  test('a HUNG ring claim never holds the TwiML past the deadline (P1) — and an UNCONFIRMED claim falls to voicemail, never a ring a retry could duplicate', async () => {
    jest.useFakeTimers();
    const { builder } = primeDb();
    builder.update = jest.fn(() => new Promise(() => {})); // pool stalled
    const res = mockRes();
    const p = handlerFor('/relay-complete')({ body: { CallSid: 'CA-hung', HandoffData: TRANSFER }, query: {} }, res);
    await jest.advanceTimersByTimeAsync(4000); // the claim deadline, then the voicemail stamp's own deadline (both bounded)
    await p;
    jest.useRealTimers();
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
    // The row is re-classified as voicemail (bounded, best-effort) — the
    // recorder's /voicemail-complete never does, so an unconfirmed ring
    // must not stay reported as a successful transfer (codex r2 P1).
    expect(builder.update).toHaveBeenLastCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
    // A DB error on the claim takes the same non-duplicating path.
    const { builder: b2 } = primeDb();
    b2.update = jest.fn(async () => { throw new Error('pool down'); });
    const res2 = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-err', HandoffData: TRANSFER }, query: {} }, res2);
    expect(res2.body).toContain('<Record');
    expect(res2.body).not.toContain('<Dial');
    expect(b2.update).toHaveBeenLastCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
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

describe('/call-complete after an unanswered transfer ring', () => {
  test('goes to voicemail — never back to Sandy — and isTransferredRow reads every durable marker', async () => {
    const { isTransferredRow } = voiceRouter._test;
    expect(isTransferredRow(null)).toBe(false);
    expect(isTransferredRow({ metadata: {} })).toBe(false);
    expect(isTransferredRow({ metadata: { relay_handoff: {} } })).toBe(true);
    expect(isTransferredRow({ metadata: JSON.stringify({ relay_transfer_ring_at: 'x' }) })).toBe(true);
    expect(isTransferredRow({ metadata: null, call_outcome: 'ai_transferred' })).toBe(true);

    const { isEnabled } = require('../config/feature-gates');
    isEnabled.mockImplementation(() => true); // voiceAiAgent ON: the backstop would normally re-render the relay
    const callLog = { update: jest.fn(async () => 1), where: jest.fn(() => callLog), whereRaw: jest.fn(() => callLog), select: jest.fn(() => callLog), first: jest.fn(async () => ({ metadata: { relay_transfer_ring_at: '2026-09-05T00:00:00Z' }, call_outcome: 'ai_transferred' })) };
    const other = { update: jest.fn(async () => 1), where: jest.fn(() => other), whereRaw: jest.fn(() => other), first: jest.fn(async () => null), select: jest.fn(() => other), insert: jest.fn(async () => [1]) };
    db.mockImplementation((table) => (table === 'call_log' ? callLog : other));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const res = mockRes();
    await handlerFor('/call-complete')({ body: { CallSid: 'CA-noans', DialCallStatus: 'no-answer', DialCallDuration: '0' }, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('ConversationRelay');
    expect(res.body).not.toContain('<Connect');
    // An UNCONFIRMED marker read (DB error) fails closed to voicemail too.
    callLog.first = jest.fn(async (...cols) => { if (cols[0] === 'metadata' && cols[1] === 'call_outcome') throw new Error('pool down'); return null; });
    const res2 = mockRes();
    await handlerFor('/call-complete')({ body: { CallSid: 'CA-noans2', DialCallStatus: 'no-answer', DialCallDuration: '0' }, query: {} }, res2);
    expect(res2.body).toContain('<Record');
    expect(res2.body).not.toContain('<Connect');
  });
});

describe('press-1 whisper', () => {
  test('a transferred row speaks the ≤20-word whisper; other rows keep today\'s lines', () => {
    const row = { metadata: JSON.stringify({ screen_caller_name: 'Pat Doe', relay_handoff: { context_available: true, caller_name: 'Pat Doe', intent: 'cancel service', unresolved_question: 'refund' } }) };
    expect(connectingAnnouncement(row)).toBe('Sandy transfer from Pat Doe: cancel service; refund.');
    expect(connectingAnnouncement({ metadata: { relay_handoff: { context_available: false } } })).toBe('Sandy transfer. The caller requested assistance; the summary was unavailable.');
    // Both packet writes failed but the outcome stamp landed: still the generic Sandy whisper (P2).
    expect(connectingAnnouncement({ metadata: { screen_caller_name: 'Pat Doe' }, call_outcome: 'ai_transferred' })).toBe('Sandy transfer. The caller requested assistance; the summary was unavailable.');
    expect(connectingAnnouncement({ metadata: { screen_caller_name: 'Pat Doe' } })).toBe('Connecting your call from Pat Doe.');
    expect(connectingAnnouncement(null)).toBe('Connecting your call from an unknown number.');
  });
});
