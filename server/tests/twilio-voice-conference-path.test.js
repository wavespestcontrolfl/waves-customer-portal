/**
 * Conference ring routes (GATE_CALL_CONFERENCE_PATH): the /voice main-ring seam, /conference-enter,
 * the staff-leg screen / accept / status webhooks, and the /call-complete + /call-status wiring.
 * Gate off (the service admits nobody) must leave every TwiML byte as it is today. The service's
 * claims and REST calls are covered in call-conference-path.test.js; here they are stubs.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => false) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));
jest.mock('../services/live-call-transcription', () => ({
  ...jest.requireActual('../services/live-call-transcription'),
  startLiveTranscription: jest.fn(async () => ({ started: true })),
}));
jest.mock('../services/call-conference-path', () => ({
  ...jest.requireActual('../services/call-conference-path'),
  admitsConferencePath: jest.fn(() => false),
  stashCallToken: jest.fn(),
  takeCallToken: jest.fn(() => null),
  claimStart: jest.fn(),
  placeStaffLegs: jest.fn(),
  scheduleNoAnswerBackstop: jest.fn(),
  updateState: jest.fn(async () => 1),
  claimAccept: jest.fn(),
  startCallerRecording: jest.fn(async () => 'started'),
  closeForCallerEnd: jest.fn(async () => 0),
  conferenceRingOn: jest.fn(() => false),
  loadState: jest.fn(async () => ({ legs: {} })),
  endLegs: jest.fn(async () => 0),
  onStaffLegStatus: jest.fn(async () => 'waiting'),
  conferenceDialOutcome: jest.fn(),
}));

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const db = require('../models/db');
const logger = require('../services/logger');
const cp = require('../services/call-conference-path');
const live = require('../services/live-call-transcription');
const { isEnabled } = require('../config/feature-gates');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { appendMainStaffRing, appendStaffRingDial } = voiceRouter._test;

const SID = `CA${'b'.repeat(32)}`;
const LEG = `CA${'c'.repeat(32)}`;
const NUMBERS = ['+19415550001', '+19415550002'];
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
// Today's TwiML, byte for byte (rendered from origin/main before this change).
const CLASSIC_RING_25 = `${XML}<Response><Dial record="record-from-answer-dual" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed" timeout="25" action="/api/webhooks/twilio/call-complete" answerOnBridge="true"><Number url="/api/webhooks/twilio/inbound-forward-screen" method="POST">+19415550001</Number><Number url="/api/webhooks/twilio/inbound-forward-screen" method="POST">+19415550002</Number></Dial></Response>`;
const SCREEN = (action) => `${XML}<Response><Gather numDigits="1" action="${action}" method="POST" timeout="7"><Say voice="Polly.Joanna-Neural">Waves call. Press 1 to connect.</Say></Gather><Say voice="Polly.Joanna-Neural">No input received. Goodbye.</Say><Hangup/></Response>`;
const CALLER_ROOM = `<Dial action="/api/webhooks/twilio/call-complete?conf=1"><Conference startConferenceOnEnter="false" endConferenceOnExit="true" beep="false" waitUrl="/audio/ringback-us.wav" waitMethod="GET" participantLabel="caller">waves-${SID}</Conference></Dial>`;
const GOODBYE = `${XML}<Response><Say voice="Polly.Joanna-Neural">Goodbye.</Say><Hangup/></Response>`;

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
  res.sendStatus = jest.fn((code) => { res.statusCode = code; return res; });
  return res;
}
function primeDb({ row = { metadata: null } } = {}) {
  const update = jest.fn().mockResolvedValue(1);
  const chain = { first: jest.fn().mockResolvedValue(row), update };
  chain.where = jest.fn(() => chain);
  chain.whereRaw = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  db.mockImplementation(() => chain);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { update };
}
const post = async (path, { body = {}, query = {} } = {}) => {
  const res = mockRes();
  await handlerFor(path)({ body, query, headers: {} }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WAVES_FALLBACK_FORWARD_NUMBERS = NUMBERS.join(',');
  cp.admitsConferencePath.mockReset().mockReturnValue(false);
  cp.takeCallToken.mockReset().mockReturnValue(null);
  cp.startCallerRecording.mockReset().mockResolvedValue('started');
  cp.loadState.mockReset().mockResolvedValue({ legs: {} });
  cp.onStaffLegStatus.mockReset().mockResolvedValue('waiting');
  cp.conferenceRingOn.mockReset().mockReturnValue(false);
  primeDb();
});

describe('/voice main ring seam', () => {
  test('gate off: today\'s <Dial>, byte for byte, and no CallToken is kept', () => {
    const twiml = new VoiceResponse();
    appendMainStaffRing(twiml, NUMBERS, 25, { callSid: SID, from: '+19415550100', callToken: 'tok' });
    expect(twiml.toString()).toBe(CLASSIC_RING_25);
    const classic = new VoiceResponse();
    appendStaffRingDial(classic, NUMBERS, 25);
    expect(twiml.toString()).toBe(classic.toString());
    expect(cp.stashCallToken).not.toHaveBeenCalled();
  });

  test('an admission error is the classic ring too', () => {
    cp.admitsConferencePath.mockImplementation(() => { throw new Error('boom'); });
    const twiml = new VoiceResponse();
    appendMainStaffRing(twiml, NUMBERS, 25, { callSid: SID, from: '+19415550100' });
    expect(twiml.toString()).toBe(CLASSIC_RING_25);
  });

  test('admitted: the greeting stays, then a <Redirect> to /conference-enter; the token is kept for it', () => {
    cp.admitsConferencePath.mockReturnValue(true);
    const twiml = new VoiceResponse();
    twiml.play('https://assets.example/greeting.mp3');
    appendMainStaffRing(twiml, NUMBERS, 25, { callSid: SID, from: '+19415550100', callToken: 'tok' });
    expect(twiml.toString()).toBe(`${XML}<Response><Play>https://assets.example/greeting.mp3</Play><Redirect method="POST">/api/webhooks/twilio/conference-enter?ring=25</Redirect></Response>`);
    expect(cp.admitsConferencePath).toHaveBeenCalledWith({ from: '+19415550100' });
    expect(cp.stashCallToken).toHaveBeenCalledWith(SID, 'tok');
  });
});

describe('/inbound-forward-screen + /conference-staff-screen', () => {
  test('today\'s screen is byte-identical after the shared builder', async () => {
    expect((await post('/inbound-forward-screen')).body).toBe(SCREEN('/api/webhooks/twilio/inbound-forward-accept'));
  });

  test('a conference leg hears the same words; only the action differs', async () => {
    expect((await post('/conference-staff-screen', { query: { parent: SID } })).body)
      .toBe(SCREEN(`/api/webhooks/twilio/conference-staff-accept?parent=${SID}`));
    expect((await post('/conference-staff-screen', { query: { parent: 'not-a-sid' } })).body).toBe(`${XML}<Response><Hangup/></Response>`);
  });
});

describe('/conference-enter', () => {
  const body = { CallSid: SID, From: '(941) 555-0100', To: '+19415550000', CallToken: 'tok-body' };
  beforeEach(() => {
    cp.admitsConferencePath.mockReturnValue(true);
    cp.claimStart.mockResolvedValue({ claim: 'claimed', state: {} });
    cp.placeStaffLegs.mockResolvedValue([LEG]);
  });

  test('claimed: rings every number by REST and puts the caller in the room with ringback', async () => {
    const res = await post('/conference-enter', { body, query: { ring: '25' } });
    expect(res.body).toBe(`${XML}<Response>${CALLER_ROOM}</Response>`);
    expect(cp.claimStart).toHaveBeenCalledWith(SID, { legCount: 2, ringTimeoutSec: 25 });
    expect(cp.placeStaffLegs).toHaveBeenCalledWith({
      callSid: SID, numbers: NUMBERS, ringTimeoutSec: 25, callerFrom: '+19415550100', wavesLine: '+19415550000', callToken: 'tok-body',
    });
    expect(cp.scheduleNoAnswerBackstop).toHaveBeenCalledWith(SID, 25);
  });

  test('the ring time is clamped; a token kept by /voice is used when the redirect has none', async () => {
    cp.takeCallToken.mockReturnValue('tok-stash');
    await post('/conference-enter', { body: { ...body, CallToken: undefined }, query: { ring: '999' } });
    expect(cp.placeStaffLegs).toHaveBeenCalledWith(expect.objectContaining({ ringTimeoutSec: 60, callToken: 'tok-stash' }));
    await post('/conference-enter', { body, query: { ring: 'x' } });
    expect(cp.claimStart).toHaveBeenLastCalledWith(SID, { legCount: 2, ringTimeoutSec: 30 });
  });

  test('a redelivered request joins the caller to the room without ringing anyone again', async () => {
    cp.claimStart.mockResolvedValue({ claim: 'retry', state: { legs: {} } });
    const res = await post('/conference-enter', { body, query: { ring: '25' } });
    expect(res.body).toBe(`${XML}<Response>${CALLER_ROOM}</Response>`);
    expect(cp.placeStaffLegs).not.toHaveBeenCalled();
    expect(cp.scheduleNoAnswerBackstop).toHaveBeenCalledWith(SID, 25);
  });

  test.each([
    ['no call_log row', () => cp.claimStart.mockResolvedValue({ claim: 'no_row', state: null })],
    ['a retry of a call that fell back', () => cp.claimStart.mockResolvedValue({ claim: 'retry', state: { fallback: 'classic_ring' } })],
    ['the claim throws', () => cp.claimStart.mockRejectedValue(new Error('pg down'))],
    ['the gate went off during the greeting', () => cp.admitsConferencePath.mockReturnValue(false)],
  ])('%s: today\'s <Dial> ring', async (_label, arrange) => {
    arrange();
    const res = await post('/conference-enter', { body, query: { ring: '25' } });
    expect(res.body).toBe(CLASSIC_RING_25);
    expect(cp.placeStaffLegs).not.toHaveBeenCalled();
  });

  test('a failure is logged by its code, never its message (a Twilio message can carry a phone number)', async () => {
    const leaky = () => Object.assign(new Error('Call from +19415550100 to +19415550001 refused'), { code: 21212 });
    cp.claimStart.mockRejectedValue(leaky());
    await post('/conference-enter', { body, query: { ring: '25' } });
    cp.onStaffLegStatus.mockRejectedValue(leaky());
    await post('/conference-staff-status', { body: { CallSid: LEG, CallStatus: 'completed' }, query: { parent: SID, leg: '0' } });
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls].flat().join(' ');
    expect(logged.match(/21212/g)).toHaveLength(2);
    expect(logged).not.toMatch(/555010|555000|Call from/);
  });

  test('no leg placed: the claim is marked and the caller gets today\'s ring', async () => {
    cp.placeStaffLegs.mockResolvedValue([]);
    const res = await post('/conference-enter', { body, query: { ring: '25' } });
    expect(res.body).toBe(CLASSIC_RING_25);
    expect(cp.updateState).toHaveBeenCalledWith(SID, [[['fallback'], 'classic_ring']]);
    expect(cp.scheduleNoAnswerBackstop).not.toHaveBeenCalled();
  });

  test('no staff number configured: straight to the voicemail path', async () => {
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '';
    for (const k of ['OWNER_PHONE', 'ADAM_PHONE', 'VIRGINIA_PHONE', 'OFFICE_MANAGER_PHONE', 'WAVES_OFFICE_MANAGER_PHONE']) delete process.env[k];
    const res = await post('/conference-enter', { body, query: { ring: '25' } });
    expect(res.body).toBe(`${XML}<Response><Redirect method="POST">/api/webhooks/twilio/call-complete?conf=1&amp;conf_status=failed</Redirect></Response>`);
    expect(cp.claimStart).not.toHaveBeenCalled();
  });
});

describe('/conference-staff-accept', () => {
  const press = (digits = '1', parent = SID) => post('/conference-staff-accept', {
    body: { CallSid: LEG, Digits: digits, To: '+19415550001' },
    query: { parent },
  });
  const STAFF_ROOM = `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false" participantLabel="staff">waves-${SID}</Conference></Dial>`;

  test('the first press 1: recording on the caller call, forward_acceptance as today, other legs end, join the room', async () => {
    const { update } = primeDb({ row: { metadata: { screen_caller_name: 'Pat Example' }, call_outcome: null } });
    cp.claimAccept.mockResolvedValue({ won: true, first: true });
    cp.loadState.mockResolvedValue({ legs: { 0: { sid: LEG }, 1: { sid: 'CA2' } } });
    const res = await press();
    expect(res.body).toBe(`${XML}<Response><Say voice="Polly.Joanna-Neural">Connecting your call from Pat Example.</Say>${STAFF_ROOM}</Response>`);
    expect(cp.claimAccept).toHaveBeenCalledWith(SID, LEG);
    expect(cp.startCallerRecording).toHaveBeenCalledWith(SID);
    expect(cp.updateState).toHaveBeenCalledWith(SID, [[['recording'], 'started']]);
    const acceptance = update.mock.calls.map(([u]) => u.metadata).find((m) => m?.sql?.includes('{forward_acceptance}'));
    expect(JSON.parse(acceptance.bindings[0])).toMatchObject({ accepted: true, parent_call_sid: SID, dial_call_sid: LEG, answered_by_number: '+19415550001' });
    await new Promise(setImmediate);
    expect(cp.endLegs).toHaveBeenCalledWith({ legs: { 0: { sid: LEG }, 1: { sid: 'CA2' } } }, { except: LEG });
  });

  describe('live text (GATE_LIVE_CALL_TRANSCRIPTION), as on today\'s ring', () => {
    afterEach(() => { isEnabled.mockReset().mockReturnValue(false); });

    test('the winning press 1 starts it on the caller call after the TwiML is sent, in the caller\'s language', async () => {
      primeDb({ row: { metadata: { caller_language: 'es' }, call_outcome: null } });
      isEnabled.mockImplementation((gate) => gate === 'liveCallTranscription');
      cp.claimAccept.mockResolvedValue({ won: true, first: true });
      const res = await press();
      expect(res.body).toContain(STAFF_ROOM);
      expect(live.startLiveTranscription).toHaveBeenCalledTimes(1);
      expect(live.startLiveTranscription).toHaveBeenCalledWith({ parentCallSid: SID, language: 'es' });
      expect(res.send.mock.invocationCallOrder[0]).toBeLessThan(live.startLiveTranscription.mock.invocationCallOrder[0]);
      // A redelivered press 1 of the winner asks again, as today's ring does for both cells: the start's own claim
      // (live_transcription IS NULL, pinned in live-call-transcription.test.js) admits one start per call.
      cp.claimAccept.mockResolvedValue({ won: true, first: false });
      await press();
      expect(live.startLiveTranscription).toHaveBeenCalledTimes(2);
      expect(cp.startCallerRecording).toHaveBeenCalledTimes(1);
    });

    test('a start that fails is only logged: the staff still join the room', async () => {
      isEnabled.mockImplementation((gate) => gate === 'liveCallTranscription');
      cp.claimAccept.mockResolvedValue({ won: true, first: true });
      live.startLiveTranscription.mockRejectedValueOnce(new Error('twilio down'));
      const res = await press();
      expect(res.body).toContain(STAFF_ROOM);
      await new Promise(setImmediate);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[live-transcription] start failed'));
    });

    test('gate off, a lost press 1, a caller who left, or a claim error starts nothing', async () => {
      cp.claimAccept.mockResolvedValue({ won: true, first: true });
      await press();
      isEnabled.mockImplementation((gate) => gate === 'liveCallTranscription');
      cp.claimAccept.mockResolvedValue({ won: false, first: false });
      await press();
      cp.claimAccept.mockResolvedValue({ won: true, first: true });
      cp.startCallerRecording.mockResolvedValueOnce('caller_gone');
      await press();
      cp.claimAccept.mockRejectedValueOnce(new Error('pg down'));
      await press();
      expect(live.startLiveTranscription).not.toHaveBeenCalled();
    });
  });

  test('a redelivered press 1 of the winner joins again; nothing is started twice', async () => {
    cp.claimAccept.mockResolvedValue({ won: true, first: false });
    const res = await press();
    expect(res.body).toContain(STAFF_ROOM);
    expect(cp.startCallerRecording).not.toHaveBeenCalled();
    expect(cp.endLegs).not.toHaveBeenCalled();
  });

  test('another staff member won, or the key was not 1, or the parent is bad: Goodbye', async () => {
    cp.claimAccept.mockResolvedValue({ won: false, first: false });
    expect((await press()).body).toBe(GOODBYE);
    expect((await press('2')).body).toBe(GOODBYE);
    expect((await press('1', 'bad')).body).toBe(GOODBYE);
    expect(cp.claimAccept).toHaveBeenCalledTimes(1);
  });

  test('the caller hung up during the press 1: Goodbye, and every leg ends', async () => {
    cp.claimAccept.mockResolvedValue({ won: true, first: true });
    cp.startCallerRecording.mockResolvedValue('caller_gone');
    expect((await press()).body).toBe(GOODBYE);
    expect(cp.closeForCallerEnd).toHaveBeenCalledWith(SID);
  });

  test('the claim cannot be read: <Hangup/> as today, never a join the no-answer clean-up would end', async () => {
    cp.claimAccept.mockRejectedValue(new Error('pg down'));
    expect((await press()).body).toBe(`${XML}<Response><Hangup/></Response>`);
    expect(cp.startCallerRecording).not.toHaveBeenCalled();
    expect(cp.endLegs).not.toHaveBeenCalled();
  });
});

describe('/conference-staff-status', () => {
  test('passes the leg index, SID and status to the service and always answers 200', async () => {
    let res = await post('/conference-staff-status', { body: { CallSid: LEG, CallStatus: 'no-answer' }, query: { parent: SID, leg: '1' } });
    expect(res.statusCode).toBe(200);
    expect(cp.onStaffLegStatus).toHaveBeenCalledWith({ callSid: SID, index: 1, legSid: LEG, status: 'no-answer' });
    cp.onStaffLegStatus.mockRejectedValueOnce(new Error('pg down'));
    res = await post('/conference-staff-status', { body: { CallSid: LEG, CallStatus: 'completed' }, query: { parent: SID, leg: '0' } });
    expect(res.statusCode).toBe(200);
    res = await post('/conference-staff-status', { body: { CallSid: LEG, CallStatus: 'completed' }, query: { parent: 'bad', leg: '0' } });
    expect(res.statusCode).toBe(200);
    expect(cp.onStaffLegStatus).toHaveBeenCalledTimes(2);
  });
});

describe('/call-complete?conf=1', () => {
  test('an answered conference call: completed, human, talk time from the claim, no voicemail', async () => {
    // No forward_acceptance on the row (its stamp failed): the press-1 claim alone marks the call answered.
    const { update } = primeDb({ row: { metadata: {} } });
    cp.conferenceDialOutcome.mockResolvedValue({ status: 'completed', duration: 42, accepted: true });
    const res = await post('/call-complete', { body: { CallSid: SID, DialCallStatus: 'answered' }, query: { conf: '1' } });
    expect(cp.conferenceDialOutcome).toHaveBeenCalledWith(SID, undefined);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', answered_by: 'human' }));
    expect(update.mock.calls[0][0].duration_seconds).toMatchObject({ bindings: [42] });
    expect(res.body).toBe(`${XML}<Response></Response>`);
  });

  test('the no-answer redirect: today\'s voicemail path', async () => {
    const { update } = primeDb();
    cp.conferenceDialOutcome.mockResolvedValue({ status: 'no-answer', duration: 0, accepted: false });
    const res = await post('/call-complete', { body: { CallSid: SID }, query: { conf: '1', conf_status: 'no-answer' } });
    expect(cp.conferenceDialOutcome).toHaveBeenCalledWith(SID, 'no-answer');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'no-answer', answered_by: 'voicemail', call_outcome: 'voicemail' }));
    expect(res.body).toContain('<Record');
  });

  test('without conf=1 the outcome is never read from the claim', async () => {
    primeDb({ row: { metadata: { forward_acceptance: { accepted: true, parent_call_sid: SID } } } });
    await post('/call-complete', { body: { CallSid: SID, DialCallSid: LEG, DialCallStatus: 'completed', DialCallDuration: '30' }, query: {} });
    expect(cp.conferenceDialOutcome).not.toHaveBeenCalled();
  });
});

describe('/call-status', () => {
  function primeStatus(existing) {
    const update = jest.fn().mockResolvedValue(1);
    const where = jest.fn(() => ({ first: jest.fn(async () => existing), update }));
    const trx = jest.fn(() => ({ where }));
    trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    db.transaction = jest.fn(async (fn) => fn(trx));
  }
  const status = (CallStatus) => post('/call-status', {
    body: { CallSid: SID, CallStatus, CallDuration: '61', From: '+19415550100', To: '+19415550000', Direction: 'inbound' },
  });

  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('the caller of a conference ring hung up: every staff leg still up is ended', async () => {
    jest.useFakeTimers();
    primeStatus({ id: 1, status: 'in-progress', metadata: { conference_path: { room: `waves-${SID}` } }, created_at: new Date() });
    expect((await status('completed')).statusCode).toBe(200);
    expect(cp.closeForCallerEnd).toHaveBeenCalledWith(SID);
  });

  test('gate on: a ring claimed after this callback read the row is still closed after the commit', async () => {
    jest.useFakeTimers();
    cp.conferenceRingOn.mockReturnValue(true);
    primeStatus({ id: 1, status: 'in-progress', metadata: {}, created_at: new Date() });
    await status('completed');
    expect(cp.closeForCallerEnd).toHaveBeenCalledWith(SID);
  });

  test('an ordinary call, or a status that is not terminal: nothing to end', async () => {
    jest.useFakeTimers();
    primeStatus({ id: 1, status: 'in-progress', metadata: { forward_acceptance: {} }, created_at: new Date() });
    await status('completed');
    primeStatus({ id: 1, status: 'ringing', metadata: { conference_path: {} }, created_at: new Date() });
    await status('in-progress');
    expect(cp.closeForCallerEnd).not.toHaveBeenCalled();
  });
});
