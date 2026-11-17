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
    'Please hold.',
    'Okay, please hold while I check.',
    'Hold, please.',
    'Could you hold please',
    'Let me put you on hold.',
    'let me place you on a quick hold',
    "I'm going to put you on hold for one moment",
    "I'll put you on hold",
    'I’ll put you on a brief hold',
    'PLEASE   HOLD',
  ])('starts a hold: %j', (text) => {
    expect(isHoldPhrase(text)).toBe(true);
  });

  test.each([
    'Hold on a second.',
    "Please hold on, I'm looking.",
    "Sure, I'll hold, please take your time",
    'We can hold please',
    'Can I put you on hold?',
    'May I put you on hold?',
    'Hold off on that',
    'one moment',
    '',
    null,
    undefined,
  ])('does not start a hold: %j', (text) => {
    expect(isHoldPhrase(text)).toBe(false);
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
    const TEXT = 'Please hold, my secret words';
    mockRequestHold.mockRejectedValueOnce(Object.assign(new Error(`failed for ${TEXT}`), { code: 20404 }));
    await expect(afterStaffUtterance(SID, TEXT)).resolves.toBeUndefined();
    mockRequestHold.mockImplementationOnce(() => { throw new Error(`sync ${TEXT}`); });
    await expect(afterStaffUtterance(SID, TEXT)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, '[call-hold-voice] hold request failed for …123456 (20404)');
    expect(logger.warn).toHaveBeenNthCalledWith(2, '[call-hold-voice] hold request failed for …123456 (Error)');
  });

  test('no log line holds the text or the full SID', async () => {
    const TEXT = 'Please hold, my secret words';
    await afterStaffUtterance(SID, TEXT);
    mockRequestHold.mockRejectedValueOnce(new Error(TEXT));
    await afterStaffUtterance(SID, TEXT);
    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/secret|please hold/i);
    expect(logged).not.toContain(SID);
  });
});
