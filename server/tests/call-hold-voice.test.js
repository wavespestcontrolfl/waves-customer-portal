/**
 * "Hold please" voice trigger (GATE_CALL_HOLD_VOICE, owner 2026-11-16 "ok build all", live-call suite part 7).
 *
 * Pins: which staff phrases start a hold and which do not ("Hold on a second" and a staff "I'll hold, please take
 * your time" never do; a question is not yet a yes), the gate, the request (requestHold by 'voice'), and that a
 * failed request is swallowed and logged by code only, with the SID masked and no call speech in any log line.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ callHoldVoiceLive: jest.fn(() => true) }));

const mockRequestHold = jest.fn();
jest.mock('../services/call-hold', () => ({ requestHold: (...args) => mockRequestHold(...args) }));

const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const { isHoldPhrase, afterStaffUtterance } = require('../services/call-hold-voice');

const SID = 'CA' + 'd'.repeat(26) + '123456';

describe('isHoldPhrase', () => {
  test.each([
    // The owner's own examples.
    'Please hold.',
    'Let me put you on hold.',
    // The same asks in the words staff use.
    'Okay, please hold while I check.',
    'Please hold for one moment.',
    'Thank you, please hold.',
    "Please hold, I'm transferring you.",
    'Do not hang up, please hold.',
    'Hold, please.',
    'Okay, hold please.',
    'Let me check. Hold, please.',
    'Can I get your address? Please hold while I look it up.',
    'let me place you on a quick hold',
    'Let me just put you on hold real quick.',
    "I'm going to put you on hold for one moment",
    "I'm going to go ahead and put you on a brief hold.",
    "I'll put you on hold",
    'I’ll put you on a brief hold',
    "I'm putting you on hold now.",
    "Give me one second, I'll put you on hold.",
    'Let me put you on hold, okay?',
    // A condition after the ask, a polite "if you could", and words that only look like a question.
    'Please hold while I see if the tech is in.',
    'Let me put you on hold while I see if I can find it.',
    'If you could please hold for one moment.',
    'Will do, please hold.',
    'PLEASE   HOLD',
  ])('starts a hold: %j', (text) => {
    expect(isHoldPhrase(text)).toBe(true);
  });

  test.each([
    // The owner: "'Hold on a second' does not start a hold."
    'Hold on a second.',
    "Please hold on, I'm looking.",
    // The staff waiting for the caller.
    "Sure, I'll hold, please take your time",
    'We can hold please',
    // A question: the caller has not said yes.
    'Can I put you on hold?',
    'May I put you on hold?',
    'Could you hold please',
    'Can you please hold?',
    'Okay, can you hold, please?',
    'Is it okay if I put you on hold?',
    'Before I check that, can you please hold?',
    'Let me put you on hold, is that okay?',
    // A condition makes it a maybe, not a hold.
    'If I need to check with the technician, I will put you on hold.',
    "I'll put you on hold if I need to.",
    'When I am putting you on hold, the recording stops.',
    // Lawn and pest instructions, and account holds.
    'Please hold off on watering for 24 hours.',
    'Please hold off on mowing until Friday.',
    'Please hold onto your receipt.',
    'Please hold the dog inside during the visit.',
    "Your service is on hold, please call us when you're ready.",
    'We put your account on hold.',
    'Hold off on that',
    // Not the staff's own announcement.
    "I'm not going to put you on hold.",
    "If I put you on hold, you'll hear a few pest facts.",
    // Words from two sentences never make one phrase.
    'The tech can hold. Please give me a moment.',
    'one moment',
    '',
    null,
    undefined,
  ])('does not start a hold: %j', (text) => {
    expect(isHoldPhrase(text)).toBe(false);
  });

  // The tail of a script line cut off by the press 1 can be stored as a staff line after the return. No line the
  // hold or the ring plays may read as a hold phrase, or the return would start a new hold.
  test('no line of the hold script or the ring fact reads as a hold phrase', () => {
    const script = jest.requireActual('../services/call-hold-script');
    const lines = [script.OPENING, script.REMINDER, script.STAFF_REMINDER, script.STAFF_VOICEMAIL, script.CALLER_VOICEMAIL, ...script.FACTS];
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect([line, isHoldPhrase(line)]).toEqual([line, false]);
  });
});

describe('afterStaffUtterance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    featureGates.callHoldVoiceLive.mockReturnValue(true);
    mockRequestHold.mockResolvedValue('requested');
  });

  test('gate off: nothing is asked', async () => {
    featureGates.callHoldVoiceLive.mockReturnValue(false);
    await afterStaffUtterance(SID, 'Please hold.');
    expect(mockRequestHold).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('a feature-gates without the reader reads off: nothing is asked and nothing is logged', async () => {
    const reader = featureGates.callHoldVoiceLive;
    delete featureGates.callHoldVoiceLive;
    try {
      await afterStaffUtterance(SID, 'Please hold.');
    } finally {
      featureGates.callHoldVoiceLive = reader;
    }
    expect(mockRequestHold).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('not a hold phrase: nothing is asked', async () => {
    await afterStaffUtterance(SID, 'Hold on a second.');
    expect(mockRequestHold).not.toHaveBeenCalled();
  });

  test("a hold phrase asks for the hold, by 'voice', and logs the answer with the SID masked", async () => {
    await afterStaffUtterance(SID, 'Okay, please hold while I check.');
    expect(mockRequestHold).toHaveBeenCalledTimes(1);
    expect(mockRequestHold).toHaveBeenCalledWith(SID, { by: 'voice' });
    expect(logger.info).toHaveBeenCalledWith('[call-hold-voice] hold asked for …123456 (requested)');
  });

  test('a rejected or throwing request is swallowed and logged by code only', async () => {
    const TEXT = 'Please hold while I read my secret words';
    mockRequestHold.mockRejectedValueOnce(Object.assign(new Error(`failed for ${TEXT}`), { code: 20404 }));
    await expect(afterStaffUtterance(SID, TEXT)).resolves.toBeUndefined();
    mockRequestHold.mockImplementationOnce(() => { throw new Error(`sync ${TEXT}`); });
    await expect(afterStaffUtterance(SID, TEXT)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, '[call-hold-voice] hold request failed for …123456 (20404)');
    expect(logger.warn).toHaveBeenNthCalledWith(2, '[call-hold-voice] hold request failed for …123456 (Error)');
  });

  test('no log line holds the text or the full SID', async () => {
    const TEXT = 'Please hold while I read my secret words';
    await afterStaffUtterance(SID, TEXT);
    mockRequestHold.mockRejectedValueOnce(new Error(TEXT));
    await afterStaffUtterance(SID, TEXT);
    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/secret|please hold/i);
    expect(logged).not.toContain(SID);
  });
});
