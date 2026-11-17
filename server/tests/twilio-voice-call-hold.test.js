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
  transferOn: jest.fn(() => false),
  transferAvailable: jest.fn(() => false),
  startTransfer: jest.fn(),
  acceptTransfer: jest.fn(),
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
  callHold.transferOn.mockReset().mockReturnValue(false);
  callHold.transferAvailable.mockReset().mockReturnValue(false);
  callHold.startTransfer.mockReset();
  callHold.acceptTransfer.mockReset();
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
    expect(callHold.endHold).toHaveBeenCalledWith(SID, { legSid: null });
    expect(res.body).toBe(response(STAFF_ROOM_ON));
    // The role is decided under the hold's lock: no extra read for it.
    expect(callHold.holdState).not.toHaveBeenCalled();
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

// =========================================================================================================
// The warm transfer (GATE_CALL_WARM_TRANSFER, part 6)
// =========================================================================================================

const TLEG = `CA${'7'.repeat(32)}`;
const OWNER_LINE = '+19415550150';
const WAIT_URL = `/api/webhooks/twilio/conference-transfer-wait?parent=${SID}`;
const ANSWER_URL = (n) => `/api/webhooks/twilio/conference-transfer-answer?parent=${SID}&amp;n=${n}`;
const ACCEPT_URL = (n) => `/api/webhooks/twilio/conference-transfer-accept?parent=${SID}&amp;n=${n}`;
const OFFER_LINE = `${MENU_LINE} Press 2 to transfer the call.`;
const SECOND_STAFF = `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false" participantLabel="staff-2">waves-${SID}</Conference></Dial>`;
const VIEW = (transfer, extra = {}) => ({ found: true, closed: false, phase: 'held', applied: 'held', remind: false, transfer, ...extra });
const RING = { n: 1, status: 'ringing', ringing: true, legSid: TLEG, fromName: 'Virginia' };

describe('the hold menu offers the transfer', () => {
  const GATHER = `<Gather numDigits="1" timeout="15" action="${CHOICE_URL}" method="POST">`;
  const MENU_LOOP = `<Redirect method="POST">${MENU_URL}</Redirect>`;

  test('available: the first line also offers option 2, and the menu leg number is what availability is asked about', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    const res = await post('/conference-staff-menu', { query: { first: '1' }, body: { To: '+19415550123', Called: '+19415550124' } });
    expect(res.body).toBe(response(`${GATHER}${say(OFFER_LINE)}</Gather>${MENU_LOOP}`));
    expect(callHold.transferAvailable).toHaveBeenLastCalledWith('+19415550123');
    await post('/conference-staff-menu', { query: { first: '1' }, body: { Called: '+19415550124' } });
    expect(callHold.transferAvailable).toHaveBeenLastCalledWith('+19415550124');
  });

  test('not available (gate off, number unset, or the menu leg is the number): today\'s menu, byte for byte', async () => {
    const today = response(`${GATHER}${say(MENU_LINE)}</Gather>${MENU_LOOP}`);
    callHold.transferAvailable.mockReturnValue(false);
    expect((await post('/conference-staff-menu', { query: { first: '1' }, body: { To: OWNER_LINE } })).body).toBe(today);
    expect((await post('/conference-staff-menu', { query: { first: '1' } })).body).toBe(today);
  });

  test('a later loop stays silent; the reminder follows the offer line on the first entry', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    expect((await post('/conference-staff-menu')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${MENU_LOOP}`));
    callHold.checkHold.mockResolvedValueOnce({ ...HELD, remind: true });
    expect((await post('/conference-staff-menu', { query: { first: '1' } })).body)
      .toBe(response(`${GATHER}${say(OFFER_LINE)}${say(STAFF_REMINDER)}</Gather>${MENU_LOOP}`));
  });
});

describe('/conference-staff-menu-choice: 2 starts the transfer', () => {
  const body = { Digits: '2', CallSid: LEG, To: '+19415550123' };
  const WAIT_FIRST = response(`<Redirect method="POST">${WAIT_URL}&amp;first=1</Redirect>`);

  test('available: the transfer starts with the pressing leg and the CSR name of the number that pressed 2', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    callHold.startTransfer.mockResolvedValue('ringing');
    process.env.VIRGINIA_PHONE = '+19415550123';
    try {
      expect((await post('/conference-staff-menu-choice', { body })).body).toBe(WAIT_FIRST);
    } finally {
      delete process.env.VIRGINIA_PHONE;
    }
    expect(callHold.transferAvailable).toHaveBeenCalledWith('+19415550123');
    expect(callHold.startTransfer).toHaveBeenCalledWith(SID, { legSid: LEG, fromName: 'Virginia' });
    expect(callHold.endHold).not.toHaveBeenCalled();
  });

  test('an unmapped number passes a null name (the whisper says "A team member"); Called is read when To is missing', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    callHold.startTransfer.mockResolvedValue('ringing');
    await post('/conference-staff-menu-choice', { body: { Digits: '2', CallSid: LEG, Called: '+19415550177' } });
    expect(callHold.startTransfer).toHaveBeenCalledWith(SID, { legSid: LEG, fromName: null });
  });

  test('busy goes to the same wait; voicemail is the staff goodbye; anything else says it did not start and goes back to the menu', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    callHold.startTransfer.mockResolvedValue('busy');
    expect((await post('/conference-staff-menu-choice', { body })).body).toBe(WAIT_FIRST);
    callHold.startTransfer.mockResolvedValue('voicemail');
    expect((await post('/conference-staff-menu-choice', { body })).body).toBe(response(`${say(STAFF_VOICEMAIL)}<Hangup/>`));
    for (const answer of ['failed', 'not_held']) {
      callHold.startTransfer.mockResolvedValue(answer);
      expect((await post('/conference-staff-menu-choice', { body })).body)
        .toBe(response(`${say('Sorry, the transfer did not start.')}<Redirect method="POST">${MENU_URL}</Redirect>`));
    }
  });

  test('not available: a 2 is any other key: back to the menu, nothing started, no hold ended', async () => {
    callHold.transferAvailable.mockReturnValue(false);
    expect((await post('/conference-staff-menu-choice', { body })).body).toBe(response(`<Redirect method="POST">${MENU_URL}</Redirect>`));
    expect(callHold.startTransfer).not.toHaveBeenCalled();
    expect(callHold.endHold).not.toHaveBeenCalled();
  });

  test('1 is the press 1 return as today, even while the transfer is offered', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockResolvedValue('returned');
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1' } })).body).toBe(response(STAFF_ROOM_ON));
    expect(callHold.startTransfer).not.toHaveBeenCalled();
  });

  test('a thrown error hangs up rather than a 500', async () => {
    callHold.transferAvailable.mockReturnValue(true);
    callHold.startTransfer.mockRejectedValue(new Error('boom'));
    expect((await post('/conference-staff-menu-choice', { body })).body).toBe(response('<Hangup/>'));
  });
});

describe('/conference-staff-menu-choice from the transfer wait (wait=1)', () => {
  const BACK_TO_WAIT = response(`<Redirect method="POST">${WAIT_URL}</Redirect>`);
  const choose = (Digits, query = { wait: '1' }) => post('/conference-staff-menu-choice', { body: { Digits, CallSid: LEG }, query });

  test('a key other than 1 or 2 goes back to the transfer wait, never to the hold menu (which would not take the caller back)', async () => {
    for (const digit of ['3', '9', '*', '#', '']) expect((await choose(digit)).body).toBe(BACK_TO_WAIT);
    expect(callHold.endHold).not.toHaveBeenCalled();
    expect(callHold.startTransfer).not.toHaveBeenCalled();
  });

  test('without wait=1 the same key goes to the hold menu, as before', async () => {
    expect((await choose('3', {})).body).toBe(response(`<Redirect method="POST">${MENU_URL}</Redirect>`));
  });

  test('1 from the wait is the press 1 return; 2 with the transfer not offered goes back to the wait', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockResolvedValue('returned');
    expect((await choose('1')).body).toBe(response(STAFF_ROOM_ON));
    expect((await choose('2')).body).toBe(BACK_TO_WAIT);
    expect(callHold.startTransfer).not.toHaveBeenCalled();
  });
});

describe('/conference-transfer-wait (the staff while it rings)', () => {
  const GATHER = `<Gather numDigits="1" timeout="5" action="${CHOICE_URL}&amp;wait=1" method="POST">`;
  const LOOP = `<Redirect method="POST">${WAIT_URL}</Redirect>`;

  test('ringing: a 5 s gather whose key 1 is the press 1 route; first=1 says "Calling now"; the loop is silent after', async () => {
    callHold.checkHold.mockResolvedValue(VIEW(RING));
    expect((await post('/conference-transfer-wait', { query: { first: '1' } })).body)
      .toBe(response(`${GATHER}${say('Calling now. Press 1 to go back to the caller.')}</Gather>${LOOP}`));
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${LOOP}`));
    expect(callHold.checkHold).toHaveBeenLastCalledWith(SID, { remind: true });
  });

  test('the 3 minute reminder is said once when the hold check asks for it', async () => {
    callHold.checkHold.mockResolvedValue(VIEW(RING, { remind: true }));
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${GATHER}${say(STAFF_REMINDER)}</Gather>${LOOP}`));
  });

  test('a state read error keeps the loop: the caller stays held, and the next fetch decides', async () => {
    callHold.checkHold.mockResolvedValue({ found: false, closed: false, error: true, phase: 'held', applied: 'held', remind: false });
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${GATHER.replace(/>$/, '/>')}${LOOP}`));
  });

  test('taken: they hear it, then join the room as a second staff (no star, no action); a room that is gone hangs up', async () => {
    callHold.checkHold.mockResolvedValue(VIEW({ ...RING, status: 'accepted', ringing: false }, { phase: 'returned', applied: 'returned' }));
    const said = say('Your call is transferred. Stay on to introduce the caller, or hang up.');
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${said}${SECOND_STAFF}`));
    expect(callHold.roomIsOpen).toHaveBeenCalledWith(SID);
    callHold.roomIsOpen.mockResolvedValue(false);
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${said}<Hangup/>`));
  });

  test.each(['failed', 'canceled'])('%s while the hold is held: "No answer." and the press 1 return (the same four answers)', async (status) => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.checkHold.mockResolvedValue(VIEW({ ...RING, status, ringing: false }));
    callHold.endHold.mockResolvedValue('returned');
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${say('No answer.')}${STAFF_ROOM_ON}`));
    expect(callHold.endHold).toHaveBeenCalledWith(SID, { legSid: null });
    callHold.endHold.mockResolvedValue('voicemail');
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${say('No answer.')}${say(STAFF_VOICEMAIL)}<Hangup/>`));
    callHold.endHold.mockResolvedValue('no_room');
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${say('No answer.')}${say('The caller hung up.')}<Hangup/>`));
    callHold.endHold.mockResolvedValue('failed');
    expect((await post('/conference-transfer-wait')).body)
      .toBe(response(`${say('No answer.')}${say('Sorry, that did not work.')}<Redirect method="POST">${MENU_URL}</Redirect>`));
  });

  test('the voicemail decided (the limit): the staff hear it and hang up, even after the caller left; a closed call says so', async () => {
    callHold.checkHold.mockResolvedValue(VIEW({ ...RING, status: 'failed', ringing: false }, { phase: 'voicemail', voicemailAt: '2026-11-17T15:05:00Z' }));
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${say(STAFF_VOICEMAIL)}<Hangup/>`));
    callHold.checkHold.mockResolvedValue(VIEW(RING, { closed: true }));
    expect((await post('/conference-transfer-wait')).body).toBe(response(`${say('The caller hung up.')}<Hangup/>`));
  });

  test('anything else (the hold is over, no transfer) rejoins an open room or hangs up', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.checkHold.mockResolvedValue(VIEW(null, { phase: 'returned', applied: 'returned' }));
    expect((await post('/conference-transfer-wait')).body).toBe(response(STAFF_ROOM_ON));
    callHold.roomIsOpen.mockResolvedValue(false);
    expect((await post('/conference-transfer-wait')).body).toBe(response('<Hangup/>'));
  });

  test('a bad parent hangs up with no hold check; a thrown error hangs up', async () => {
    expect((await post('/conference-transfer-wait', { query: { parent: 'nope' } })).body).toBe(response(`${say('The caller hung up.')}<Hangup/>`));
    expect(callHold.checkHold).not.toHaveBeenCalled();
    callHold.checkHold.mockRejectedValue(new Error('boom'));
    expect((await post('/conference-transfer-wait')).body).toBe(response('<Hangup/>'));
  });
});

describe('after the owner took the transfer, only his leg rejoins with star', () => {
  // The staff who pressed 2 (LEG) press a key just as the owner (TLEG) takes the call, or come back by a loop: they join
  // as a second staff (no star, no staff-left action). The owner's own leg rejoins as the call's staff.
  const TAKEN = VIEW({ ...RING, status: 'accepted', ringing: false }, { phase: 'returned', applied: 'returned', winnerLegSid: TLEG });
  // He took the call, then pressed star himself: a new hold, which starts with no transfer. His leg is still the winner.
  const HIS_HOLD = VIEW(null, { phase: 'held', applied: 'held', winnerLegSid: TLEG });
  const SAID = say('Your call is transferred. Stay on to introduce the caller, or hang up.');

  test('a press 1 from the staff who pressed 2: the decision point answers second_staff, and they join as staff-2; the owner rejoins with star', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockImplementation(async (sid, { legSid } = {}) => (legSid === TLEG ? 'returned' : 'second_staff'));
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1', CallSid: LEG } })).body).toBe(response(`${SAID}${SECOND_STAFF}`));
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1', CallSid: TLEG } })).body).toBe(response(STAFF_ROOM_ON));
    expect(callHold.endHold.mock.calls).toEqual([[SID, { legSid: LEG }], [SID, { legSid: TLEG }]]);
    // The stored winner decides under the hold's lock: the route reads no gate (transferOn is false here, as when the
    // gate is turned off after he took the call) and no view for the role.
    expect(callHold.transferOn).not.toHaveBeenCalled();
    expect(callHold.holdState).not.toHaveBeenCalled();
  });

  test('second_staff from their wait loop (wait=1) joins them too; a room that is gone hangs up', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.endHold.mockResolvedValue('second_staff');
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1', CallSid: LEG }, query: { wait: '1' } })).body).toBe(response(`${SAID}${SECOND_STAFF}`));
    callHold.roomIsOpen.mockResolvedValue(false);
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '1', CallSid: LEG } })).body).toBe(response(`${SAID}<Hangup/>`));
  });

  test('a press 2 from the staff who pressed 2 after he took the call: no call is placed, and they join as staff-2', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.transferAvailable.mockReturnValue(true);
    callHold.startTransfer.mockResolvedValue('second_staff');
    expect((await post('/conference-staff-menu-choice', { body: { Digits: '2', CallSid: LEG }, query: { wait: '1' } })).body).toBe(response(`${SAID}${SECOND_STAFF}`));
    expect(callHold.startTransfer).toHaveBeenCalledWith(SID, { legSid: LEG, fromName: null });
  });

  test('a new hold of his before their wait loop returns: the staff who pressed 2 join as staff-2 and never hear his hold menu', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.transferOn.mockReturnValue(true);
    callHold.checkHold.mockResolvedValue(HIS_HOLD);
    expect((await post('/conference-transfer-wait', { body: { CallSid: LEG } })).body).toBe(response(`${SAID}${SECOND_STAFF}`));
    expect((await post('/conference-staff-menu', { body: { CallSid: LEG } })).body).toBe(response(`${SAID}${SECOND_STAFF}`));
    // His own menu on that hold is the hold menu, as for any staff. (A key of theirs on it changes nothing: call-hold.test.js.)
    expect((await post('/conference-staff-menu', { body: { CallSid: TLEG }, query: { first: '1' } })).body).toContain(say(MENU_LINE));
  });

  test('the transfer failed while the staff who pressed 2 are still the winner: "No answer." and the press 1 return', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.checkHold.mockResolvedValue(VIEW({ ...RING, status: 'failed', ringing: false }, { winnerLegSid: LEG }));
    callHold.endHold.mockResolvedValue('returned');
    expect((await post('/conference-transfer-wait', { body: { CallSid: LEG } })).body).toBe(response(`${say('No answer.')}${STAFF_ROOM_ON}`));
  });

  test('the menu loop of the staff who pressed 2 (any other key leads there): the second staff join; the owner rejoins with star', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.checkHold.mockResolvedValue(TAKEN);
    expect((await post('/conference-staff-menu', { body: { CallSid: LEG } })).body).toBe(response(`${SAID}${SECOND_STAFF}`));
    expect((await post('/conference-staff-menu', { body: { CallSid: TLEG } })).body).toBe(response(STAFF_ROOM_ON));
  });
});

describe('/conference-transfer-answer (the whisper on the owner phone)', () => {
  const body = { CallSid: TLEG };
  const query = { n: '1' };
  const GATHER = (n) => `<Gather numDigits="1" timeout="8" action="${ACCEPT_URL(n)}" method="POST">`;
  const whisper = (name) => `<Say ${VOICE} loop="2">${name} is transferring a caller. Press 1 to take the call.</Say>`;
  const GOODBYE = `${say('Goodbye.')}<Hangup/>`;
  const OVER = response(`${say('The transfer ended. Goodbye.')}<Hangup/>`);
  const hs = (extra) => callHold.holdState.mockResolvedValue({ found: true, closed: false, phase: 'held', applied: 'held', ...extra });

  test('ringing: the name of the transferring staff member, said twice, a gather for 1, then Goodbye', async () => {
    hs({ transfer: RING });
    expect((await post('/conference-transfer-answer', { body, query })).body).toBe(response(`${GATHER(1)}${whisper('Virginia')}</Gather>${GOODBYE}`));
  });

  test('an unmapped number: "A team member"', async () => {
    hs({ transfer: { ...RING, fromName: null } });
    expect((await post('/conference-transfer-answer', { body, query })).body).toBe(response(`${GATHER(1)}${whisper('A team member')}</Gather>${GOODBYE}`));
  });

  test('the SID is not recorded yet: still answered; another call than the recorded one is over', async () => {
    hs({ transfer: { ...RING, legSid: null } });
    expect((await post('/conference-transfer-answer', { body, query })).body).toContain('transferring a caller');
    hs({ transfer: RING });
    expect((await post('/conference-transfer-answer', { body: { CallSid: `CA${'8'.repeat(32)}` }, query })).body).toBe(OVER);
  });

  test('not ringing, another n, a decided transfer or none: The transfer ended. Goodbye.', async () => {
    for (const transfer of [{ ...RING, ringing: false }, { ...RING, n: 2 }, { ...RING, status: 'failed', ringing: false }, null]) {
      hs({ transfer });
      expect((await post('/conference-transfer-answer', { body, query })).body).toBe(OVER);
    }
    callHold.holdState.mockResolvedValue({ found: false, open: true, closed: false, phase: 'held', error: true });
    expect((await post('/conference-transfer-answer', { body, query })).body).toBe(OVER);
  });

  test('a closed call: The caller hung up.', async () => {
    hs({ closed: true, transfer: RING });
    expect((await post('/conference-transfer-answer', { body, query })).body).toBe(response(`${say('The caller hung up.')}<Hangup/>`));
  });

  test('a bad parent, a missing or bad n, or a thrown error: Hangup', async () => {
    hs({ transfer: RING });
    expect((await post('/conference-transfer-answer', { body, query: { n: '1', parent: 'nope' } })).body).toBe(response('<Hangup/>'));
    for (const bad of [undefined, '', 'x', '0', '-1']) {
      expect((await post('/conference-transfer-answer', { body, query: { n: bad } })).body).toBe(response('<Hangup/>'));
    }
    callHold.holdState.mockRejectedValue(new Error('boom'));
    expect((await post('/conference-transfer-answer', { body, query })).body).toBe(response('<Hangup/>'));
  });
});

describe('/conference-transfer-accept (the owner pressed 1)', () => {
  const body = { Digits: '1', CallSid: TLEG };
  const query = { n: '1' };
  const accept = (extra = {}) => post('/conference-transfer-accept', { body: { ...body, ...extra.body }, query: { ...query, ...extra.query } });

  test('returned: "Connecting." and the ordinary staff <Dial> (his star holds the caller, his hang-up ends the room)', async () => {
    callHold.isEnabled.mockReturnValue(true);
    callHold.acceptTransfer.mockResolvedValue('returned');
    expect((await accept()).body).toBe(response(`${say('Connecting.')}${STAFF_ROOM_ON}`));
    expect(callHold.acceptTransfer).toHaveBeenCalledWith(SID, { n: 1, legSid: TLEG });
  });

  test('voicemail, no_room and over each end the call with their words', async () => {
    callHold.acceptTransfer.mockResolvedValue('voicemail');
    expect((await accept()).body).toBe(response(`${say(STAFF_VOICEMAIL)}<Hangup/>`));
    callHold.acceptTransfer.mockResolvedValue('no_room');
    expect((await accept()).body).toBe(response(`${say('The caller hung up.')}<Hangup/>`));
    callHold.acceptTransfer.mockResolvedValue('over');
    expect((await accept()).body).toBe(response(`${say('The transfer ended. Goodbye.')}<Hangup/>`));
  });

  test('failed (the unhold not confirmed in time): a short loop back to the accept, never a hang-up, until it settles', async () => {
    // His leg is already the winning leg, so a hang-up here would end the room under the caller.
    const RETRY = `<Pause length="1"/><Redirect method="POST">${ACCEPT_URL(1)}&amp;retry=1</Redirect>`;
    callHold.isEnabled.mockReturnValue(true);
    callHold.acceptTransfer.mockResolvedValue('failed');
    expect((await accept()).body).toBe(response(`${say('One moment.')}${RETRY}`));
    // The loop's own fetch has no Digits: it settles again (no second "One moment."), then joins once confirmed.
    expect((await accept({ body: { Digits: undefined }, query: { retry: '1' } })).body).toBe(response(RETRY));
    callHold.acceptTransfer.mockResolvedValue('returned');
    expect((await accept({ body: { Digits: undefined }, query: { retry: '1' } })).body).toBe(response(`${say('Connecting.')}${STAFF_ROOM_ON}`));
    expect(callHold.acceptTransfer).toHaveBeenCalledTimes(3);
    expect(callHold.acceptTransfer).toHaveBeenLastCalledWith(SID, { n: 1, legSid: TLEG });
  });

  test('any other key goes back to the whisper; nothing is accepted', async () => {
    expect((await accept({ body: { Digits: '5' } })).body).toBe(response(`<Redirect method="POST">${ANSWER_URL(1)}</Redirect>`));
    expect((await accept({ body: { Digits: '' } })).body).toBe(response(`<Redirect method="POST">${ANSWER_URL(1)}</Redirect>`));
    expect(callHold.acceptTransfer).not.toHaveBeenCalled();
  });

  test('a bad parent, a bad n, a missing call SID, or a thrown error: Hangup, nothing accepted', async () => {
    expect((await accept({ query: { parent: 'nope' } })).body).toBe(response('<Hangup/>'));
    expect((await accept({ query: { n: 'x' } })).body).toBe(response('<Hangup/>'));
    expect((await accept({ body: { CallSid: undefined } })).body).toBe(response('<Hangup/>'));
    expect(callHold.acceptTransfer).not.toHaveBeenCalled();
    callHold.acceptTransfer.mockRejectedValue(new Error('boom'));
    expect((await accept()).body).toBe(response('<Hangup/>'));
  });
});

describe('/conference-transfer-status (statusCallback of the owner call)', () => {
  const sent = [];
  let spy;
  beforeEach(() => {
    sent.length = 0;
    spy = jest.spyOn(conferencePath, 'onTransferLegStatus').mockImplementation(async (args) => { sent.push(args); return 'ok'; });
  });
  afterEach(() => spy.mockRestore());
  const status = async (extra = {}) => {
    const res = { code: null };
    res.sendStatus = jest.fn((code) => { res.code = code; return res; });
    await handlerFor('/conference-transfer-status')({ body: { CallSid: TLEG, CallStatus: 'no-answer', ...extra.body }, query: { parent: SID, n: '2', ...extra.query }, headers: {} }, res);
    return res.code;
  };

  test('the leg end is handed to the service with the n from the query, and answered 200', async () => {
    expect(await status()).toBe(200);
    expect(sent).toEqual([{ callSid: SID, n: 2, legSid: TLEG, status: 'no-answer' }]);
  });

  test('a bad parent or n is answered 200 with nothing handled; a throw is logged and still 200', async () => {
    expect(await status({ query: { parent: 'nope' } })).toBe(200);
    expect(await status({ query: { n: '' } })).toBe(200);
    expect(await status({ query: { n: '0' } })).toBe(200);
    expect(sent).toEqual([]);
    spy.mockRejectedValue(new Error('boom'));
    expect(await status()).toBe(200);
  });
});
