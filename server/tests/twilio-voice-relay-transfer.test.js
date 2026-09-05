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
jest.mock('../services/call-routing-config', () => ({ getCallRoutingConfig: jest.fn(async () => ({ agentEndpoint: '' })) }));
jest.mock('../services/voice-route-decision', () => ({ decideVoiceRoute: jest.fn(() => ({ action: 'agent', reason: 'test' })) }));

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
  const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis() };
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
    // A Spanish caller: the selection rides the Dial action (the relay leg's own ?lang=es), nothing else.
    primeDb();
    const resEs = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t1es', HandoffData: TRANSFER }, query: { lang: 'es' } }, resEs);
    expect(resEs.body).toContain('action="/api/webhooks/twilio/call-complete?lang=es"');
    expect(resEs.body.match(/\?[a-z_]+=/gi)).toEqual(['?lang=']);
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
    // The deadline cannot cancel the queued claim: when it LANDS later (rows > 0) voicemail is re-stamped, fenced (codex r6 P1).
    jest.useFakeTimers();
    const { builder: bl } = primeDb();
    let settleClaim;
    let calls = 0;
    bl.update = jest.fn(() => (++calls === 1 ? new Promise((r) => { settleClaim = r; }) : Promise.resolve(1)));
    const resL = mockRes();
    const pl = handlerFor('/relay-complete')({ body: { CallSid: 'CA-late', HandoffData: TRANSFER }, query: {} }, resL);
    await jest.advanceTimersByTimeAsync(4000);
    await pl;
    expect(resL.body).toContain('<Record');
    expect(bl.update).toHaveBeenCalledTimes(2); // claim (hung) + the bounded voicemail stamp
    settleClaim(1); // the claim lands after the recorder started
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(bl.update).toHaveBeenCalledTimes(3);
    expect(bl.update).toHaveBeenLastCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
    // A DB error on the claim takes the same non-duplicating path.
    const { builder: b2 } = primeDb();
    b2.update = jest.fn(async () => { throw new Error('pool down'); });
    const res2 = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-err', HandoffData: TRANSFER }, query: {} }, res2);
    expect(res2.body).toContain('<Record');
    expect(res2.body).not.toContain('<Dial');
    expect(b2.update).toHaveBeenLastCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
    // …and that stamp rides the claim's owner fence + an eligible-state guard (NULL or ai_transferred), so a
    // superseded socket's callback can never stamp a reconnect's live row (codex r3 P1).
    const ownerFences = b2.whereRaw.mock.calls.filter(([sql]) => String(sql).includes('relay_session_claim_owner'));
    expect(ownerFences).toHaveLength(2);
    expect(ownerFences[1][1]).toEqual([null]);
    const stateGuard = b2.where.mock.calls.filter(([arg]) => typeof arg === 'function');
    expect(stateGuard.length).toBeGreaterThanOrEqual(1);
  });

  test('transfer with no staff numbers configured ⇒ voicemail (never a stranded caller) — and the stamp is bounded', async () => {
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '';
    for (const k of ['OWNER_PHONE', 'ADAM_PHONE', 'VIRGINIA_PHONE', 'OFFICE_MANAGER_PHONE']) delete process.env[k];
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t2', HandoffData: TRANSFER }, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
    // Re-classified as voicemail — /call-complete never runs on this recorder — behind the claim's owner fence (hook P1).
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
    const { builder: b0 } = primeDb();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-t2b', HandoffData: JSON.stringify({ reason: 'transfer', owner: 'nonce-X' }) }, query: {} }, mockRes());
    expect(b0.whereRaw.mock.calls.filter(([sql, b]) => String(sql).includes('relay_session_claim_owner') && b && b[0] === 'nonce-X')).toHaveLength(2);
    // A stalled pool on the stamp (after a confirmed ring claim) still returns the recorder inside the deadline (hook P1).
    jest.useFakeTimers();
    const { builder } = primeDb();
    let calls = 0;
    builder.update = jest.fn(() => (++calls === 1 ? Promise.resolve(1) : new Promise(() => {})));
    const res2 = mockRes();
    const p = handlerFor('/relay-complete')({ body: { CallSid: 'CA-t3', HandoffData: TRANSFER }, query: {} }, res2);
    await jest.advanceTimersByTimeAsync(2000);
    await p;
    jest.useRealTimers();
    expect(res2.body).toContain('<Record');
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
    // A Spanish caller's unanswered transfer gets SPANISH voicemail (hook P1) — the language rode the Dial action.
    callLog.first = jest.fn(async () => ({ metadata: { relay_transfer_ring_at: '2026-09-05T00:00:00Z' }, call_outcome: 'ai_transferred' }));
    const resEs = mockRes();
    await handlerFor('/call-complete')({ body: { CallSid: 'CA-noans-es', DialCallStatus: 'no-answer', DialCallDuration: '0' }, query: { lang: 'es' } }, resEs);
    expect(resEs.body).toContain('<Record');
    expect(resEs.body).toMatch(/language="es/);
    expect(res.body).not.toMatch(/language="es/);
  });
});

describe('/call-complete AI backstop → Sandy → transfer (codex hook r21)', () => {
  test('the backstop marks the parent call in-progress when it hands the unanswered dial to Sandy, so the transfer packet fence accepts the row', async () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
    process.env.VOICE_RELAY_WS_SECRET = 'test-secret';
    const { getCallRoutingConfig } = require('../services/call-routing-config');
    getCallRoutingConfig.mockResolvedValueOnce({ agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent' });
    const callLog = { update: jest.fn(async () => 1), where: jest.fn(() => callLog), whereRaw: jest.fn(() => callLog), whereNull: jest.fn(() => callLog), select: jest.fn(() => callLog), first: jest.fn(async () => ({ metadata: {}, call_outcome: null })) };
    const other = { update: jest.fn(async () => 1), where: jest.fn(() => other), whereRaw: jest.fn(() => other), first: jest.fn(async () => null), select: jest.fn(() => other), insert: jest.fn(async () => [1]) };
    db.mockImplementation((table) => (table === 'call_log' ? callLog : other));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const res = mockRes();
    await handlerFor('/call-complete')({ body: { CallSid: 'CA-backstop', DialCallStatus: 'no-answer', DialCallDuration: '0' }, query: {} }, res);
    expect(res.body).toContain('ConversationRelay');
    expect(callLog.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'in-progress', answered_by: 'ai_agent', call_outcome: null }));
    // The reset must CONFIRM before Sandy renders: 0 rows / an error ⇒ voicemail, never a live Sandy call on a terminal status (codex r6 P2).
    getCallRoutingConfig.mockResolvedValueOnce({ agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent' });
    callLog.update = jest.fn(async () => 0);
    const res2 = mockRes();
    await handlerFor('/call-complete')({ body: { CallSid: 'CA-backstop-2', DialCallStatus: 'no-answer', DialCallDuration: '0' }, query: {} }, res2);
    expect(res2.body).not.toContain('ConversationRelay');
    expect(res2.body).toContain('<Record');
    // A reset that LANDS after the deadline is put back to voicemail (codex r6 P1).
    jest.useFakeTimers();
    getCallRoutingConfig.mockResolvedValueOnce({ agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent' });
    let settleReset;
    const updates = [];
    callLog.update = jest.fn((patch) => { updates.push(patch); return patch.status === 'in-progress' ? new Promise((r) => { settleReset = r; }) : Promise.resolve(1); });
    const res3 = mockRes();
    const p3 = handlerFor('/call-complete')({ body: { CallSid: 'CA-backstop-3', DialCallStatus: 'no-answer', DialCallDuration: '0' }, query: {} }, res3);
    await jest.advanceTimersByTimeAsync(4000);
    await p3;
    expect(res3.body).toContain('<Record');
    settleReset(1);
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(updates[updates.length - 1]).toEqual(expect.objectContaining({ status: 'no-answer', call_outcome: 'voicemail' }));
    expect(callLog.whereNull).toHaveBeenCalledWith('call_outcome');
    // The packet write's status fence lets a live (in-progress) call through and refuses a closed one.
    const fence = "(status IS NULL OR status NOT IN ('completed', 'failed', 'busy', 'no-answer', 'canceled'))";
    expect(fence).not.toMatch(/in-progress/);
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
