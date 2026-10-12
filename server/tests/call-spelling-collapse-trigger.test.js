/**
 * GATE_CALL_SPELLING_COLLAPSE_TRIGGER: a spelling the primary transcript collapsed
 * ("Serov, Serov") still buys the spelling-preserving second pass and the decoder. Dark by
 * default. Synthetic names only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../utils/triage-locks', () => ({
  lockTriageCall: jest.fn(),
  syncCallReviewStatus: jest.fn(),
}));

const logger = require('../services/logger');
const { _test } = require('../services/call-recording-processor');
const {
  spellingLikelyCollapsed,
  spellingCollapseSignals,
  detectContactDictationSignals,
  sanitizeNameEntries,
  nameSpellingDifferences,
} = require('../services/contact-dictation');

const { contactPassTrigger, contactPassTriggerLogged, contactDecoderGate } = _test;
const GATE = 'GATE_CALL_SPELLING_COLLAPSE_TRIGGER';
const COLLAPSED = 'Agent: Can I get your last name?\nCaller: Serov, Serov.\nAgent: Thanks, and the best number to reach you?';
const SPELLED_SECOND_PASS = 'Agent: Can I get your last name?\nCaller: Serov, S-E-R-O-V.\nAgent: Thanks, and the best number to reach you?';

afterEach(() => { delete process.env[GATE]; jest.clearAllMocks(); });

describe('spellingLikelyCollapsed', () => {
  test.each([
    ['a repeated name token', 'Caller: My last name is Serov, Serov.'],
    ['a repeat across a full stop', 'Caller: It is Tarnow. Tarnow.'],
    ['a repeat across a speaker label', 'Caller: Marlowe.\nAgent: Marlowe? Marlowe.'],
    ['spelled, no letters after', 'Caller: Yes, it is spelled the usual way, nothing odd about it at all.'],
    ['"that\'s S" with no letters after', "Caller: Yes that's S and then the rest of it is simple enough, ok?"],
    ['"with a C" with no letters after', 'Caller: It begins with a C, like the sea. Then a long ending that I never say.'],
    ['a letter then "as in" with no word after', 'Caller: T as in, you know, the usual way people say it for the office.'],
  ])('fires on %s', (_label, text) => {
    expect(spellingLikelyCollapsed(text)).toBe(true);
  });

  test.each([
    ['filler repeats', 'Caller: Okay. Okay. Yes, yes, that works. Very very good.'],
    ['a plain greeting', 'Caller: Hi, I have ants in my kitchen and I would like a quote.'],
    ['a dry spell', 'Caller: We had a dry spell and the lawn is brown.'],
    ['a stutter without punctuation', 'Caller: The the garage side is the worst.'],
    ['"with a" and a lowercase word', 'Caller: I need a plan with a bait station around the house.'],
    ['empty', ''],
    ['null', null],
  ])('stays quiet on %s', (_label, text) => {
    expect(spellingLikelyCollapsed(text)).toBe(false);
  });

  test('an announcement followed by its letters is the detector\'s job, not this one', () => {
    const t = 'Caller: that\'s S, E, R, O, V.';
    expect(spellingCollapseSignals(t).announced).toBe(false);
    expect(detectContactDictationSignals(t).any).toBe(true);
  });

  test('near miss: the extracted last name is the stored one off by one or two letters, same first letter', () => {
    const known = { last_name: 'Serov' };
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Serof' }, knownCustomer: known })).toBe(true);
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Sarow' }, knownCustomer: known })).toBe(true);
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'serov' }, knownCustomer: known })).toBe(false); // same name
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Perov' }, knownCustomer: known })).toBe(false); // first letter differs
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Sorokin' }, knownCustomer: known })).toBe(false); // too far
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Lam' }, knownCustomer: { last_name: 'Lee' } })).toBe(false); // short name: one letter only
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Lea' }, knownCustomer: { last_name: 'Lee' } })).toBe(true);
    expect(spellingLikelyCollapsed('x', { extracted: { last_name: 'Serof' }, knownCustomer: null })).toBe(false);
    expect(spellingLikelyCollapsed('x', { extracted: null, knownCustomer: known })).toBe(false);
  });

  test('reports which signal fired', () => {
    expect(spellingCollapseSignals('Caller: Serov, Serov.')).toEqual({ repeated: true, announced: false, nearMiss: false, any: true });
    expect(spellingCollapseSignals('x', { extracted: { last_name: 'Serof' }, knownCustomer: { last_name: 'Serov' } }))
      .toEqual({ repeated: false, announced: false, nearMiss: true, any: true });
  });
});

describe('contactPassTrigger (the gate for the second pass)', () => {
  test('dark by default: a collapsed transcript buys nothing', () => {
    expect(contactPassTrigger(COLLAPSED)).toBeNull();
  });

  test('gate on: the collapsed transcript buys the pass and says which signal', () => {
    process.env[GATE] = 'true';
    expect(contactPassTrigger(COLLAPSED)).toBe('collapse:repeated');
  });

  test('gate on: only the exact string true turns it on', () => {
    process.env[GATE] = '1';
    expect(contactPassTrigger(COLLAPSED)).toBeNull();
  });

  test('the old detector keeps its own label and wins even with the gate on', () => {
    process.env[GATE] = 'true';
    expect(contactPassTrigger('Caller: my email is jay at gmail dot com')).toBe('signals');
    process.env[GATE] = 'false';
    expect(contactPassTrigger('Caller: my email is jay at gmail dot com')).toBe('signals');
  });

  test('gate on, nothing suspicious: no pass', () => {
    process.env[GATE] = 'true';
    expect(contactPassTrigger('Caller: I have ants in the kitchen.')).toBeNull();
    expect(contactPassTrigger('')).toBeNull();
  });
});

describe('the log line names the signal and masks the call sid', () => {
  test('logs only when the new trigger is what buys the pass', () => {
    process.env[GATE] = 'true';
    const call = { twilio_call_sid: 'CAabcdef0123456789abcdef0123456789' };
    expect(contactPassTriggerLogged(COLLAPSED, call, 'second_pass')).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0];
    expect(line).toContain('spelling collapse trigger (second_pass): repeated');
    expect(line).not.toContain(call.twilio_call_sid);
    logger.info.mockClear();
    expect(contactPassTriggerLogged('Caller: my email is jay at gmail dot com', call, 'second_pass')).toBe(true);
    expect(contactPassTriggerLogged('Caller: ants.', call, 'second_pass')).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('contactDecoderGate', () => {
  const base = { call: { recording_url: null, customer_id: null }, contactPhone: '+15555550100', callSid: 'CA1234567890abcdef', extracted: { last_name: 'Serof' } };

  test('unchanged paths: a second-pass transcript or a dictation signal runs the decoder with the gate off', async () => {
    expect(await contactDecoderGate({ ...base, transcription: COLLAPSED, contactPassTranscript: 'second' })).toEqual({ run: true, lateContactPass: null });
    expect(await contactDecoderGate({ ...base, transcription: 'my email is jay at gmail dot com', contactPassTranscript: null })).toEqual({ run: true, lateContactPass: null });
    expect(await contactDecoderGate({ ...base, transcription: COLLAPSED, contactPassTranscript: null })).toEqual({ run: false, lateContactPass: null });
  });

  test('gate on, no recording left: fails open to no decoder', async () => {
    process.env[GATE] = 'true';
    expect(await contactDecoderGate({ ...base, transcription: 'Caller: hello', contactPassTranscript: null })).toEqual({ run: false, lateContactPass: null });
  });
});

describe('downstream: a collapsed primary plus a spelled second pass grounds a spelling', () => {
  const entry = { raw_spoken: 'S-E-R-O-V', spelled_value: 'Serov', field: 'last_name', whose: 'caller', confidence: 0.92 };

  test('the primary alone grounds nothing, so no card could be filed', () => {
    expect(sanitizeNameEntries([entry], [COLLAPSED])).toEqual([]);
  });

  test('the second pass holds the letters: the same functions #6106 used ground the spelling and report the difference', () => {
    const names = sanitizeNameEntries([entry], [COLLAPSED, SPELLED_SECOND_PASS]);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({ spelled_value: 'Serov', field: 'last_name', whose: 'caller' });
    expect(names[0].turn).toContain('S-E-R-O-V');
    const diffs = nameSpellingDifferences({ dictation: { names }, saved: { last_name: 'Serof' } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: 'last_name', spelled_value: 'Serov', saved_value: 'Serof' });
  });

  test('the logger is unused by the pure detector', () => {
    spellingLikelyCollapsed(COLLAPSED);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
