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
  checkHold: jest.fn(),
  holdState: jest.fn(),
  roomIsOpen: jest.fn(async () => true),
  resumeRecording: jest.fn(async () => true),
  voicemailAnswered: jest.fn(async () => {}),
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
  callHold.checkHold.mockReset().mockResolvedValue({ found: true, closed: false, phase: 'held', applied: 'held', remind: false });
  callHold.holdState.mockReset().mockResolvedValue({ found: true, closed: false, phase: 'held', applied: 'held' });
  callHold.roomIsOpen.mockReset().mockResolvedValue(true);
  callHold.resumeRecording.mockReset().mockResolvedValue(true);
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

  test("by=button (the Hold button's REST move) and by=voice (the spoken \"please hold\") are recorded as such; every other by is a star", async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.startHold.mockResolvedValue('held');
    const res = await post('/conference-staff-left', { body, query: { by: 'button' } });
    expect(callHold.startHold).toHaveBeenLastCalledWith(SID, { by: 'button', legSid: LEG });
    expect(res.body).toBe(response(`<Redirect method="POST">${MENU_URL}&amp;first=1</Redirect>`));
    await post('/conference-staff-left', { body, query: { by: 'voice' } });
    expect(callHold.startHold).toHaveBeenLastCalledWith(SID, { by: 'voice', legSid: LEG });
    for (const by of ['BUTTON', 'VOICE', 'star', '', ['button'], ['voice']]) {
      await post('/conference-staff-left', { body, query: { by } });
      expect(callHold.startHold).toHaveBeenLastCalledWith(SID, { by: 'star', legSid: LEG });
    }
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

const HELD = { found: true, closed: false, phase: 'held', applied: 'held', remind: false };

describe('/conference-staff-menu', () => {
  const GATHER = `<Gather numDigits="1" timeout="15" action="${CHOICE_URL}" method="POST">`;
  const MENU_LOOP = `<Redirect method="POST">${MENU_URL}</Redirect>`;
  const VOICEMAIL_GOODBYE = response(`${say(STAFF_VOICEMAIL)}<Hangup/>`);

  test('first entry says the menu line, then loops back to the menu', async () => {
    expect((await post('/conference-staff-menu', { query: { first: '1' } })).body)
      .toBe(response(`${GATHER}${say(MENU_LINE)}</Gather>${MENU_LOOP}`));
  });

  test('a later loop is silent, and the loop records its event with the reminder asked for', async () => {
    expect((await post('/conference-staff-menu')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${MENU_LOOP}`));
    expect(callHold.checkHold).toHaveBeenCalledWith(SID, { remind: true });
  });

  describe('hold timer', () => {
    test('the words are the owner-approved ones', () => {
      expect(STAFF_REMINDER).toBe('Your caller has been on hold for 3 minutes.');
      expect(STAFF_VOICEMAIL).toBe('Your caller went to voicemail.');
      expect(CALLER_VOICEMAIL).toBe('Sorry for the wait. Please leave a message after the tone, and we will call you right back.');
    });

    test('the decision point answers remind once: the gather says the reminder in the computer voice, and no URL carries a flag', async () => {
      callHold.checkHold.mockResolvedValueOnce({ ...HELD, remind: true });
      const body = (await post('/conference-staff-menu')).body;
      expect(body).toBe(response(`${GATHER}${say(STAFF_REMINDER)}</Gather>${MENU_LOOP}`));
      expect(body).not.toContain('reminded');
      // The next loop (a redelivery included) is told remind:false, so it stays silent.
      expect((await post('/conference-staff-menu')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${MENU_LOOP}`));
    });

    test('first=1 keeps the menu line, and the reminder follows it when the hold is already old', async () => {
      callHold.checkHold.mockResolvedValueOnce({ ...HELD, remind: true });
      expect((await post('/conference-staff-menu', { query: { first: '1' } })).body)
        .toBe(response(`${GATHER}${say(MENU_LINE)}${say(STAFF_REMINDER)}</Gather>${MENU_LOOP}`));
    });

    test('the voicemail decided (the 5 minute limit, or the staff phone hung up): the staff hear it, then Hangup, even after the caller left', async () => {
      callHold.checkHold.mockResolvedValue({ found: true, closed: false, phase: 'voicemail', applied: 'held', voicemailAt: '2026-11-17T15:05:00Z' });
      expect((await post('/conference-staff-menu')).body).toBe(VOICEMAIL_GOODBYE);
      callHold.checkHold.mockResolvedValue({ found: true, closed: true, phase: 'voicemail', applied: 'voicemail', voicemailAt: '2026-11-17T15:05:00Z' });
      expect((await post('/conference-staff-menu')).body).toBe(VOICEMAIL_GOODBYE);
    });
  });

  test('a return the press 1 could not confirm keeps the staff on the menu loop (silent); the loop finishes it', async () => {
    callHold.checkHold.mockResolvedValue({ found: true, closed: false, phase: 'returned', applied: 'held', remind: false });
    expect((await post('/conference-staff-menu')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${MENU_LOOP}`));
  });

  test('the caller is confirmed back (or no hold): the staff rejoin; room gone: Hangup', async () => {
    callHold.isEnabled.mockReturnValue(true);
    for (const state of [{ phase: 'returned', applied: 'returned' }, { phase: null, applied: null }]) {
      callHold.checkHold.mockResolvedValue({ found: true, closed: false, remind: false, ...state });
      callHold.roomIsOpen.mockResolvedValue(true);
      expect((await post('/conference-staff-menu')).body).toBe(response(STAFF_ROOM_ON));
      callHold.roomIsOpen.mockResolvedValue(false);
      expect((await post('/conference-staff-menu')).body).toBe(response('<Hangup/>'));
    }
  });

  test('a closed call: the caller hung up, then Hangup', async () => {
    callHold.checkHold.mockResolvedValue({ found: true, closed: true, phase: 'held', applied: 'held' });
    expect((await post('/conference-staff-menu')).body).toBe(response(`${say('The caller hung up.')}<Hangup/>`));
  });

  test('a state read error keeps the staff on the menu: the caller keeps the script', async () => {
    callHold.checkHold.mockResolvedValue({ found: false, closed: false, error: true, phase: 'held', applied: 'held', remind: false });
    expect((await post('/conference-staff-menu')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${MENU_LOOP}`));
  });

  test('a thrown error hangs up rather than a 500', async () => {
    callHold.checkHold.mockRejectedValue(new Error('boom'));
    expect((await post('/conference-staff-menu')).body).toBe(response('<Hangup/>'));
  });
});

describe('/conference-staff-menu-choice', () => {
  test('1: caller returned (confirmed), the staff rejoin with star enabled', async () => {
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

  test('1: the voicemail was decided first (the limit, or the staff phone hanging up) -> "Your caller went to voicemail." + Hangup, never the room', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockResolvedValue('voicemail');
    const res = await post('/conference-staff-menu-choice', { body: { Digits: '1' } });
    expect(res.body).toBe(response(`${say(STAFF_VOICEMAIL)}<Hangup/>`));
    expect(res.body).not.toContain('<Conference');
  });

  test('1: not confirmed in time -> a short apology and back to the menu, whose loop finishes the return', async () => {
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
  const REDIRECT = (n) => `<Redirect method="POST">${factsUrl(n)}</Redirect>`;

  test('step 0: the opening, then the first fact, then step 1', async () => {
    expect(await stepBody(0)).toBe(response([say(OPENING), '<Pause length="2"/>', say(FACTS[0]), REDIRECT(1)].join('')));
    expect(callHold.checkHold).toHaveBeenCalledWith(SID);
  });

  test('a later step: a pause, the next fact in order, then the next step; no opening', async () => {
    expect(await stepBody(1)).toBe(response(['<Pause length="3"/>', say(FACTS[1]), REDIRECT(2)].join('')));
  });

  test('the reminder plays before every fifth fact, about once a minute, and never on other steps', async () => {
    expect(await stepBody(5)).toBe(response(['<Pause length="3"/>', say(REMINDER), '<Pause length="2"/>', say(FACTS[5]), REDIRECT(6)].join('')));
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

  // Every answer while the hold is held, or a step is still wanted, ends with a <Redirect> to a next fetch, so a
  // failed voicemail handoff, a restored state and an error all keep the loop that retries them.
  describe('always a next fetch while anything is still wanted', () => {
    const SCRIPT = (n) => response(['<Pause length="3"/>', say(FACTS[n % FACTS.length]), REDIRECT(n + 1)].join(''));
    const RETRY = (n) => response(`<Pause length="2"/>${REDIRECT(n)}`);
    test.each([
      ['held and confirmed', { phase: 'held', applied: 'held' }, SCRIPT(3)],
      ['held, the hold request not confirmed yet', { phase: 'held', applied: null }, SCRIPT(3)],
      ['voicemail decided and the room end failed (retryable)', { phase: 'voicemail', applied: 'held' }, RETRY(3)],
      ['voicemail decided, the caller re-held after a failed room end', { phase: 'voicemail', applied: 'returned' }, RETRY(3)],
      ['a return the press 1 could not confirm', { phase: 'returned', applied: 'held' }, RETRY(3)],
      ['a state read error', { error: true, phase: 'held', applied: 'held' }, SCRIPT(3)],
    ])('%s', async (_name, state, expected) => {
      callHold.checkHold.mockResolvedValue({ found: true, closed: false, remind: false, ...state });
      expect(await stepBody(3)).toBe(expected);
    });

    test('a thrown error answers a pause and a redirect to the same step, never a bare pause', async () => {
      callHold.checkHold.mockRejectedValue(new Error('boom'));
      expect(await stepBody(4)).toBe(RETRY(4));
    });

    test.each([
      ['the voicemail is done (the room ended)', { phase: 'voicemail', applied: 'voicemail' }],
      ['the caller is confirmed back', { phase: 'returned', applied: 'returned' }],
      ['no hold', { phase: null, applied: null }],
      ['the call is closed', { closed: true, phase: 'held', applied: 'held' }],
    ])('over: %s -> one second of silence and no redirect', async (_name, state) => {
      callHold.checkHold.mockResolvedValue({ found: true, closed: false, remind: false, ...state });
      expect(await stepBody(2)).toBe(response('<Pause length="1"/>'));
    });

    test('a bad parent answers silence and never reads the hold', async () => {
      expect((await post('/conference-hold-facts', { query: { parent: 'nope', step: '0' } })).body).toBe(response('<Pause length="1"/>'));
      expect(callHold.checkHold).not.toHaveBeenCalled();
    });
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
    expect(callHold.voicemailAnswered).toHaveBeenCalledWith(SID); // the caller is in the voicemail: the one bell is wanted
    // Still an answered call: the usual bookkeeping, no call_outcome.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', answered_by: 'human' }));
    expect(update.mock.calls[0][0]).not.toHaveProperty('call_outcome');
    expect(res.body).not.toContain('<Record');
  });

  const NO_MESSAGE = response(`${say('Sorry, we could not take a message right now. We will call you right back.')}<Hangup/>`);
  const withVoicemail = () => callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: '2026-11-17T15:05:00Z' });
  // The webhook waits between resume tries: run it on fake time so the suite stays fast.
  const completeOnFakeTime = async () => {
    jest.useFakeTimers();
    try {
      const pending = complete();
      await jest.advanceTimersByTimeAsync(5000);
      return await pending;
    } finally {
      jest.useRealTimers();
    }
  };

  test('a resume that fails once then succeeds still plays the normal voicemail', async () => {
    withVoicemail();
    callHold.resumeRecording.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const res = await completeOnFakeTime();
    expect(res.body).toBe(VOICEMAIL);
    expect(callHold.resumeRecording).toHaveBeenCalledTimes(2);
  });

  test('a resume that keeps failing never invites a message: the no-message line and a hangup, no tone, no pause', async () => {
    withVoicemail();
    callHold.resumeRecording.mockResolvedValue(false);
    const res = await completeOnFakeTime();
    expect(res.body).toBe(NO_MESSAGE);
    expect(callHold.resumeRecording).toHaveBeenCalledTimes(3); // bounded: one try and two more
    expect(res.body).not.toContain(CALLER_VOICEMAIL);
    expect(res.body).not.toContain('voicemail-tone');
    expect(res.body).not.toContain('<Pause');
    expect(res.body).not.toContain('<Record');
    expect(callHold.checkHold).not.toHaveBeenCalled(); // the route decides nothing here
    expect(callHold.voicemailAnswered).toHaveBeenCalledWith(SID); // and the one bell is still wanted
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', answered_by: 'human' })); // still an answered call
  });

  test('a resume try that hangs is cut off, and the answer still comes within the webhook limit', async () => {
    withVoicemail();
    callHold.resumeRecording.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    try {
      const pending = complete();
      await jest.advanceTimersByTimeAsync(12000);
      expect((await pending).body).toBe(NO_MESSAGE);
    } finally {
      jest.useRealTimers();
    }
  });

  test('no hold voicemail: today\'s empty answer, byte for byte, and the recording is left alone', async () => {
    callHold.holdState.mockResolvedValue({ found: true, open: false, closed: false, voicemailAt: null });
    expect((await complete()).body).toBe(EMPTY);
    expect(callHold.resumeRecording).not.toHaveBeenCalled();
    expect(callHold.voicemailAnswered).not.toHaveBeenCalled();
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
