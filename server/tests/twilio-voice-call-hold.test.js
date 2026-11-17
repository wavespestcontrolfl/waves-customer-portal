/**
 * Star-key hold routes (GATE_CALL_HOLD): the staff <Dial> with and without the gate, /conference-staff-left,
 * the staff menu and its choice, and the holdUrl facts TwiML. services/call-hold.js is stubbed here (its
 * claims and REST calls are covered in call-hold.test.js).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => false) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));
jest.mock('../services/call-hold', () => ({
  isEnabled: jest.fn(() => false),
  startHold: jest.fn(),
  endHold: jest.fn(),
  holdState: jest.fn(),
  roomIsOpen: jest.fn(async () => true),
  HOLD_REMINDER_SEC: 180,
  HOLD_LIMIT_SEC: 300,
  heldSeconds: jest.fn(() => 0),
  startHoldVoicemail: jest.fn(),
  resumeRecording: jest.fn(async () => {}),
}));

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const db = require('../models/db');
const callHold = require('../services/call-hold');
const conferencePath = require('../services/call-conference-path');
const { OPENING, REMINDER, FACTS, STAFF_REMINDER, STAFF_VOICEMAIL, CALLER_VOICEMAIL } = require('../services/call-hold-script');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { appendStaffConference } = voiceRouter._test;

const SID = `CA${'b'.repeat(32)}`;
const LEG = `CA${'c'.repeat(32)}`;
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const VOICE = 'voice="Polly.Joanna-Neural"';
// Today's staff join, byte for byte (rendered before this change).
const STAFF_ROOM_OFF = `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false" participantLabel="staff">waves-${SID}</Conference></Dial>`;
const STAFF_ROOM_ON = `<Dial hangupOnStar="true" action="/api/webhooks/twilio/conference-staff-left?parent=${SID}" method="POST"><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false" participantLabel="staff">waves-${SID}</Conference></Dial>`;
const MENU_URL = `/api/webhooks/twilio/conference-staff-menu?parent=${SID}`;
const CHOICE_URL = `/api/webhooks/twilio/conference-staff-menu-choice?parent=${SID}`;
const MENU_LINE = 'Your caller is on hold. Press 1 to go back to the caller.';
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const say = (text) => `<Say ${VOICE}>${esc(text)}</Say>`;

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  if (!layer) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}
async function post(path, { body = {}, query = {} } = {}) {
  const res = { body: null };
  res.type = jest.fn(() => res);
  res.send = jest.fn((b) => { res.body = b; return res; });
  await handlerFor(path)({ body, query: { parent: SID, ...query }, headers: {} }, res);
  return res;
}
const response = (inner) => `${XML}<Response>${inner}</Response>`;

beforeEach(() => {
  jest.clearAllMocks();
  callHold.isEnabled.mockReset().mockReturnValue(false);
  callHold.startHold.mockReset();
  callHold.endHold.mockReset();
  callHold.holdState.mockReset().mockResolvedValue({ found: true, open: true, closed: false });
  callHold.roomIsOpen.mockReset().mockResolvedValue(true);
  callHold.heldSeconds.mockReset().mockReturnValue(0);
  callHold.startHoldVoicemail.mockReset();
  callHold.resumeRecording.mockReset().mockResolvedValue(undefined);
});

describe('staff join <Dial>', () => {
  test('gate off: byte-identical to today (no star, no action)', () => {
    const twiml = new VoiceResponse();
    appendStaffConference(twiml, SID);
    expect(twiml.toString()).toBe(response(STAFF_ROOM_OFF));
  });

  test('gate on: hangupOnStar and the staff-left action', () => {
    callHold.isEnabled.mockReturnValue(true);
    const twiml = new VoiceResponse();
    appendStaffConference(twiml, SID);
    expect(twiml.toString()).toBe(response(STAFF_ROOM_ON));
  });
});

describe('/conference-staff-left', () => {
  const body = { CallSid: LEG };

  test('held: the menu, entered with first=1', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.startHold.mockResolvedValue('held');
    const res = await post('/conference-staff-left', { body });
    expect(callHold.startHold).toHaveBeenCalledWith(SID, { by: 'star', legSid: LEG });
    expect(res.body).toBe(response(`<Redirect method="POST">${MENU_URL}&amp;first=1</Redirect>`));
  });

  test('no_room (the caller left): Hangup', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.startHold.mockResolvedValue('no_room');
    expect((await post('/conference-staff-left', { body })).body).toBe(response('<Hangup/>'));
  });

  test('failed: the staff go straight back into the room, star enabled', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.startHold.mockResolvedValue('failed');
    expect((await post('/conference-staff-left', { body })).body).toBe(response(STAFF_ROOM_ON));
  });

  test('a thrown error rejoins when the room is open, else hangs up', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.startHold.mockRejectedValue(new Error('boom'));
    expect((await post('/conference-staff-left', { body })).body).toBe(response(STAFF_ROOM_ON));
    callHold.roomIsOpen.mockResolvedValue(false);
    expect((await post('/conference-staff-left', { body })).body).toBe(response('<Hangup/>'));
  });

  test('gate off (flipped mid-call): rejoin an open room with no star, else Hangup; no hold starts', async () => {
    expect((await post('/conference-staff-left', { body })).body).toBe(response(STAFF_ROOM_OFF));
    callHold.roomIsOpen.mockResolvedValue(false);
    expect((await post('/conference-staff-left', { body })).body).toBe(response('<Hangup/>'));
    expect(callHold.startHold).not.toHaveBeenCalled();
  });

  test('a bad parent SID hangs up', async () => {
    callHold.isEnabled.mockReturnValue(true);
    expect((await post('/conference-staff-left', { body, query: { parent: 'nope' } })).body).toBe(response('<Hangup/>'));
    expect(callHold.startHold).not.toHaveBeenCalled();
  });
});

describe('/conference-staff-menu', () => {
  const GATHER = `<Gather numDigits="1" timeout="15" action="${CHOICE_URL}" method="POST">`;

  test('first entry says the menu line, then loops back to the menu', async () => {
    expect((await post('/conference-staff-menu', { query: { first: '1' } })).body)
      .toBe(response(`${GATHER}${say(MENU_LINE)}</Gather><Redirect method="POST">${MENU_URL}</Redirect>`));
  });

  test('a later loop is silent', async () => {
    expect((await post('/conference-staff-menu')).body)
      .toBe(response(`${GATHER.replace(/>$/, '/>')}<Redirect method="POST">${MENU_URL}</Redirect>`));
  });

  describe('hold timer', () => {
    const REMINDED_GATHER = `<Gather numDigits="1" timeout="15" action="${CHOICE_URL}&amp;reminded=1" method="POST">`;
    const REMINDED_MENU = `<Redirect method="POST">${MENU_URL}&amp;reminded=1</Redirect>`;
    const VOICEMAIL_GOODBYE = response(`${say(STAFF_VOICEMAIL)}<Hangup/>`);

    test('the words are the owner-approved ones', () => {
      expect(STAFF_REMINDER).toBe('Your caller has been on hold for 3 minutes.');
      expect(STAFF_VOICEMAIL).toBe('Your caller went to voicemail.');
      expect(CALLER_VOICEMAIL).toBe('Sorry for the wait. Please leave a message after the tone, and we will call you right back.');
    });

    test('before 3 minutes the loop is today\'s, byte for byte, with no reminded flag', async () => {
      callHold.heldSeconds.mockReturnValue(179);
      expect((await post('/conference-staff-menu')).body)
        .toBe(response(`${GATHER.replace(/>$/, '/>')}<Redirect method="POST">${MENU_URL}</Redirect>`));
      expect(callHold.startHoldVoicemail).not.toHaveBeenCalled();
    });

    test('at 3 minutes the gather says the reminder once, in the computer voice, and the URLs carry reminded=1', async () => {
      callHold.heldSeconds.mockReturnValue(180);
      expect((await post('/conference-staff-menu')).body)
        .toBe(response(`${REMINDED_GATHER}${say(STAFF_REMINDER)}</Gather>${REMINDED_MENU}`));
    });

    test('the reminded loop is silent from then on', async () => {
      callHold.heldSeconds.mockReturnValue(250);
      expect((await post('/conference-staff-menu', { query: { reminded: '1' } })).body)
        .toBe(response(`${REMINDED_GATHER.replace(/>$/, '/>')}${REMINDED_MENU}`));
      expect(callHold.startHoldVoicemail).not.toHaveBeenCalled();
    });

    test('first=1 keeps the menu line, and the reminder follows it when the hold is already old', async () => {
      callHold.heldSeconds.mockReturnValue(200);
      expect((await post('/conference-staff-menu', { query: { first: '1' } })).body)
        .toBe(response(`${REMINDED_GATHER}${say(MENU_LINE)}${say(STAFF_REMINDER)}</Gather>${REMINDED_MENU}`));
    });

    test('at 5 minutes the caller goes to voicemail and the staff hear it, then Hangup', async () => {
      callHold.heldSeconds.mockReturnValue(300);
      callHold.startHoldVoicemail.mockResolvedValue('started');
      expect((await post('/conference-staff-menu', { query: { reminded: '1' } })).body).toBe(VOICEMAIL_GOODBYE);
      expect(callHold.startHoldVoicemail).toHaveBeenCalledWith(SID, 'timeout');
      callHold.startHoldVoicemail.mockResolvedValue('caller_gone');
      expect((await post('/conference-staff-menu')).body).toBe(VOICEMAIL_GOODBYE);
    });

    test('a voicemail that did not start (failed, or another request holds the claim) keeps the menu; the next loop decides', async () => {
      callHold.heldSeconds.mockReturnValue(300);
      for (const result of ['failed', 'not_needed']) {
        callHold.startHoldVoicemail.mockResolvedValue(result);
        expect((await post('/conference-staff-menu', { query: { reminded: '1' } })).body)
          .toBe(response(`${REMINDED_GATHER.replace(/>$/, '/>')}${REMINDED_MENU}`));
      }
    });

    test('a hold already sent to voicemail: the staff hear it and Hangup, even after the caller left', async () => {
      callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: '2026-11-17T15:05:00Z' });
      expect((await post('/conference-staff-menu')).body).toBe(VOICEMAIL_GOODBYE);
      callHold.holdState.mockResolvedValue({ found: true, open: false, closed: true, voicemailAt: '2026-11-17T15:05:00Z' });
      expect((await post('/conference-staff-menu')).body).toBe(VOICEMAIL_GOODBYE);
      expect(callHold.startHoldVoicemail).not.toHaveBeenCalled();
    });
  });

  test('a closed call: the caller hung up, then Hangup', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: true });
    expect((await post('/conference-staff-menu')).body).toBe(response(`${say('The caller hung up.')}<Hangup/>`));
  });

  test('a hold closed with the room still open: the staff rejoin; room gone: Hangup', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false });
    callHold.isEnabled.mockReturnValue(true);
    expect((await post('/conference-staff-menu')).body).toBe(response(STAFF_ROOM_ON));
    callHold.roomIsOpen.mockResolvedValue(false);
    expect((await post('/conference-staff-menu')).body).toBe(response('<Hangup/>'));
  });
});

describe('/conference-staff-menu-choice', () => {
  test('1: caller returned, the staff rejoin with star enabled', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockResolvedValue('returned');
    const res = await post('/conference-staff-menu-choice', { body: { Digits: '1' } });
    expect(callHold.endHold).toHaveBeenCalledWith(SID);
    expect(res.body).toBe(response(STAFF_ROOM_ON));
  });

  test('1: the caller left -> The caller hung up. + Hangup', async () => {
    callHold.endHold.mockResolvedValue('no_room');
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1' } })).body)
      .toBe(response(`${say('The caller hung up.')}<Hangup/>`));
  });

  test('1: the caller went to voicemail (hold timer) -> the staff hear that, not "The caller hung up."', async () => {
    callHold.endHold.mockResolvedValue('no_room');
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: '2026-11-17T15:05:00Z' });
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1' } })).body)
      .toBe(response(`${say(STAFF_VOICEMAIL)}<Hangup/>`));
  });

  test('1: the hold timer sent the caller to voicemail first -> "Your caller went to voicemail." + Hangup, never the room', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockResolvedValue('voicemail');
    const res = await post('/conference-staff-menu-choice', { body: { Digits: '1' } });
    expect(res.body).toBe(response(`${say(STAFF_VOICEMAIL)}<Hangup/>`));
    expect(res.body).not.toContain('<Conference');
  });

  test('another key after the reminder goes back to the menu with reminded=1, so it is not said again', async () => {
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '5' }, query: { reminded: '1' } })).body)
      .toBe(response(`<Redirect method="POST">${MENU_URL}&amp;reminded=1</Redirect>`));
  });

  test('1: failed -> a short apology and back to the menu', async () => {
    callHold.endHold.mockResolvedValue('failed');
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1' } })).body)
      .toBe(response(`${say('Sorry, that did not work.')}<Redirect method="POST">${MENU_URL}</Redirect>`));
  });

  test('any other key goes back to the menu and ends no hold', async () => {
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '5' } })).body)
      .toBe(response(`<Redirect method="POST">${MENU_URL}</Redirect>`));
    expect(callHold.endHold).not.toHaveBeenCalled();
  });

  test('a thrown error hangs up rather than a 500', async () => {
    callHold.endHold.mockRejectedValue(new Error('boom'));
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1' } })).body).toBe(response('<Hangup/>'));
  });
});

describe('/conference-hold-facts (holdUrl)', () => {
  const factsUrl = (n) => `/api/webhooks/twilio/conference-hold-facts?parent=${SID}&amp;step=${n}`;
  const stepBody = async (n) => (await post('/conference-hold-facts', { query: { step: String(n) } })).body;

  test('step 0: the opening, then the first fact, then step 1', async () => {
    expect(await stepBody(0)).toBe(response([
      say(OPENING), '<Pause length="2"/>', say(FACTS[0]), `<Redirect method="POST">${factsUrl(1)}</Redirect>`,
    ].join('')));
  });

  test('a later step: a pause, the next fact in order, then the next step; no opening', async () => {
    expect(await stepBody(1)).toBe(response([
      '<Pause length="3"/>', say(FACTS[1]), `<Redirect method="POST">${factsUrl(2)}</Redirect>`,
    ].join('')));
  });

  test('the reminder plays before every fifth fact, about once a minute, and never on other steps', async () => {
    expect(await stepBody(5)).toBe(response([
      '<Pause length="3"/>', say(REMINDER), '<Pause length="2"/>', say(FACTS[5]),
      `<Redirect method="POST">${factsUrl(6)}</Redirect>`,
    ].join('')));
    expect(await stepBody(10)).toContain(esc(REMINDER));
    for (const n of [0, 1, 4, 6, 9, 11]) expect(await stepBody(n)).not.toContain(esc(REMINDER));
  });

  test('the facts cycle through all twelve in order', async () => {
    const spoken = [];
    for (let n = 0; n < 24; n += 1) {
      const body = await stepBody(n);
      spoken.push(FACTS.findIndex((fact) => body.includes(esc(fact))));
    }
    expect(spoken).toEqual([...FACTS.keys(), ...FACTS.keys()]);
  });

  test('uses only Say, Pause and Redirect, and no customer data', async () => {
    for (const n of [0, 1, 5, 12]) {
      const body = await stepBody(n);
      const tags = [...body.matchAll(/<([A-Za-z]+)[ />]/g)].map((m) => m[1]).filter((t) => t !== 'Response');
      expect(new Set(tags)).toEqual(new Set(['Say', 'Pause', 'Redirect']));
      expect(body).not.toMatch(/\+1\d{10}/);
    }
  });

  test('a bad step starts at 0', async () => {
    for (const bad of ['-3', 'abc', '']) {
      expect((await post('/conference-hold-facts', { query: { step: bad } })).body).toContain(esc(OPENING));
    }
  });

  test('at 5 minutes the caller goes to voicemail: one second of silence is the answer', async () => {
    callHold.heldSeconds.mockReturnValue(300);
    callHold.startHoldVoicemail.mockResolvedValue('started');
    expect(await stepBody(7)).toBe(response('<Pause length="1"/>'));
    expect(callHold.startHoldVoicemail).toHaveBeenCalledWith(SID, 'timeout');
  });

  test('a voicemail that failed to start answers silence too; the next fetch tries again', async () => {
    callHold.heldSeconds.mockReturnValue(450);
    callHold.startHoldVoicemail.mockResolvedValue('failed');
    expect(await stepBody(8)).toBe(response('<Pause length="1"/>'));
  });

  test('a pending voicemail (the staff phone hung up and the room would not end) starts at once with its reason', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: true, closed: false, voicemailPending: 'staff_left' });
    callHold.heldSeconds.mockReturnValue(40);
    callHold.startHoldVoicemail.mockResolvedValue('started');
    expect(await stepBody(3)).toBe(response('<Pause length="1"/>'));
    expect(callHold.startHoldVoicemail).toHaveBeenCalledWith(SID, 'staff_left');
    callHold.startHoldVoicemail.mockResolvedValue('failed');
    expect(await stepBody(4)).toBe(response('<Pause length="1"/>')); // a failed try: silence, the next fetch tries again
  });

  test('just under 5 minutes still speaks the script and starts nothing', async () => {
    callHold.heldSeconds.mockReturnValue(299);
    expect(await stepBody(1)).toContain(esc(FACTS[1]));
    expect(callHold.startHoldVoicemail).not.toHaveBeenCalled();
  });

  test('a closed hold answers one second of silence', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false });
    expect(await stepBody(2)).toBe(response('<Pause length="1"/>'));
  });

  test('a bad parent answers silence; a state error still speaks the script', async () => {
    expect((await post('/conference-hold-facts', { query: { parent: 'nope', step: '0' } })).body).toBe(response('<Pause length="1"/>'));
    callHold.holdState.mockResolvedValue({ found: false, open: true, closed: false, error: true });
    expect(await stepBody(0)).toContain(esc(OPENING));
  });
});

describe('/call-complete?conf=1 after a hold voicemail', () => {
  const EMPTY = response('');
  const VOICEMAIL = response(`${say(CALLER_VOICEMAIL)}<Play>/audio/voicemail-tone.wav</Play><Pause length="120"/><Hangup/>`);
  let update;

  beforeEach(() => {
    update = jest.fn().mockResolvedValue(1);
    const chain = { first: jest.fn().mockResolvedValue({ metadata: { forward_acceptance: { accepted: true, parent_call_sid: SID } } }), update };
    chain.where = jest.fn(() => chain);
    chain.whereRaw = jest.fn(() => chain);
    chain.select = jest.fn(() => chain);
    db.mockImplementation(() => chain);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    jest.spyOn(conferencePath, 'conferenceDialOutcome').mockResolvedValue({ status: 'completed', duration: 300 });
  });
  afterEach(() => jest.restoreAllMocks());

  const complete = (query = { conf: '1' }, body = { CallSid: SID, DialCallStatus: 'answered' }) => post('/call-complete', { body, query });

  test('a hold voicemail: the recording resumes, the caller hears the one line and a tone, then 2 minutes to speak', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: '2026-11-17T15:05:00Z' });
    const res = await complete();
    expect(res.body).toBe(VOICEMAIL);
    expect(callHold.holdState).toHaveBeenCalledWith(SID);
    expect(callHold.resumeRecording).toHaveBeenCalledWith(SID);
    // Still an answered call: the usual bookkeeping, no call_outcome.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', answered_by: 'human' }));
    expect(update.mock.calls[0][0]).not.toHaveProperty('call_outcome');
    expect(res.body).not.toContain('<Record');
  });

  test('no hold voicemail: today\'s empty answer, byte for byte, and the recording is left alone', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: null });
    expect((await complete()).body).toBe(EMPTY);
    expect(callHold.resumeRecording).not.toHaveBeenCalled();
  });

  test('a state read error is today\'s empty answer', async () => {
    callHold.holdState.mockResolvedValue({ found: false, open: true, closed: false, error: true });
    expect((await complete()).body).toBe(EMPTY);
    callHold.holdState.mockRejectedValue(new Error('boom'));
    expect((await complete()).body).toBe(EMPTY);
  });

  test('any other path never reads the hold: no conf=1 is today\'s answer', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: '2026-11-17T15:05:00Z' });
    expect((await complete({}, { CallSid: SID, DialCallSid: LEG, DialCallStatus: 'completed', DialCallDuration: '30' })).body).toBe(EMPTY);
    expect(callHold.holdState).not.toHaveBeenCalled();
  });
});
