/**
 * The caller's words for the phone-yes cards (call-phone-yes-word.js), the parts that need no database: a quote counts
 * only when it is the caller's, found word for word in a caller turn, and the office sees that whole turn. The reads against
 * PostgreSQL are in call-phone-yes-word.db.test.js. Synthetic names and numbers only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const { callerWordsOf } = require('../services/call-phone-yes-word');

test('the module reads only: it writes nothing and sends nothing', () => {
  const source = fs.readFileSync(require.resolve('../services/call-phone-yes-word.js'), 'utf8');
  for (const word of ['.insert(', '.update(', '.del(', '.delete(', 'sendSms', 'sendEmail', 'notifyAdmin', 'sendCustomerMessage', 'twilio']) {
    expect(source).not.toContain(word);
  }
});

describe("the caller's words", () => {
  const evidence = (...entries) => ({ evidence: entries });
  const choice = (quote, speaker = 'caller', fieldPath = '/service_request/billing_choice') => ({ field_path: fieldPath, quote, speaker, transcript_offset_ms: 100 });
  const talk = (callerLine, agentLine = 'You are all set.') => ({ transcript: `Agent: Thanks for calling Waves.\nCaller: ${callerLine}\nAgent: ${agentLine}` });
  const twice = (first, second) => ({ transcript: `Agent: Thanks for calling Waves.\nCaller: ${first}\nAgent: Okay.\nCaller: ${second}\nAgent: Got it.` });

  test("the caller's whole turn that holds the quote; never staff's words, never another field's", () => {
    const transcript = talk('Okay. Just bill me each time, that works.');
    expect(callerWordsOf(evidence(
      choice('We bill after each visit.', 'agent'),
      choice('Bill me each time.', 'caller', '/scheduling/status'),
      choice('  Just   bill me\neach time  '),
    ), transcript)).toBe('Okay. Just bill me each time, that works.');
    expect(callerWordsOf(evidence(choice('just bill me each time', 'caller', 'service_request.billing_choice')), transcript))
      .toBe('Okay. Just bill me each time, that works.');
  });

  // The module judges no words (the call reader does): a condition, a "no" or a question stays in front of the office.
  test.each([
    ['a negated sentence', "Please don't bill me each time."],
    ['a question', 'Can you just bill me each time?'],
    ['a condition', 'If the price is $49.99, bill me each time.'],
    ['a sentence before it', "I don't want the annual. Just bill me each time."],
  ])('a quote inside %s is shown with the whole turn', (_name, line) => {
    expect(callerWordsOf(evidence(choice('bill me each time')), talk(line))).toBe(line);
  });

  test("the caller's latest turn that says it is shown, so a later turn that takes it back is the one the office reads", () => {
    expect(callerWordsOf(evidence(choice('bill me each time')), twice('Bill me each time.', "Actually, don't bill me each time.")))
      .toBe("Actually, don't bill me each time.");
    expect(callerWordsOf(evidence(choice('bill me each time')), twice("Don't bill me each time yet.", 'Okay, bill me each time.')))
      .toBe('Okay, bill me each time.');
    // A short quote is grounded by a whole turn; a longer turn that says it later is found too.
    expect(callerWordsOf(evidence(choice('Per application')), twice('Per application.', 'Actually, not per application.')))
      .toBe('Actually, not per application.');
    expect(callerWordsOf(evidence(choice('Per application')), twice('I guess so.', 'Actually, not per application.'))).toBeNull();
    // The grounding tools' own spelling rule: "9am" and "9 a.m." are the same words.
    expect(callerWordsOf(evidence(choice('bill me each time at 9am')), twice('Bill me each time at 9am.', "Don't bill me each time at 9 a.m.")))
      .toBe("Don't bill me each time at 9 a.m.");
  });

  test('a long turn is shown whole, so a later sentence that takes the choice back is never cut off', () => {
    const line = `Bill me each time.${' So we talked about it and'.repeat(10)} actually, don't bill me each time.`;
    expect(callerWordsOf(evidence(choice('bill me each time')), talk(line))).toBe(line);
    const spelled = `${'so we talked about it and '.repeat(10)}bill me each time at 9 a.m. please.`;
    expect(callerWordsOf(evidence(choice('bill me each time at 9am')), talk(spelled))).toBe(spelled);
  });

  test('a call the voice agent handed to staff is read across its labeled segments; any other unlabeled line is not', () => {
    const segments = (recorded) => ({ transcript: `[AI segment]\nAgent: Thanks for calling Waves.\nCaller: I have a quote from you.\n\n[Staff segment]\n${recorded}` });
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), segments('Agent: This is Sam.\nCaller: Just bill me each time.')))
      .toBe('Just bill me each time.');
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), segments('Just bill me each time.'))).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { transcript: '[Note]\nAgent: Hi.\nCaller: Just bill me each time.' })).toBeNull();
  });

  test('a quote across two sentences is found', () => {
    expect(callerWordsOf(evidence(choice('the quarterly. Bill me each time')), talk("Let's do the quarterly. Bill me each time, please.")))
      .toBe("Let's do the quarterly. Bill me each time, please.");
  });

  test('a quote the transcript does not hold in a caller turn is no words', () => {
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), talk('I need someone out for the bugs.'))).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), talk('Okay.', 'Just bill me each time.'))).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { transcript: 'Just bill me each time. You are all set.' })).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { transcript: 'Caller: Just bill me each time.' })).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), {})).toBeNull();
  });

  test('an outbound call with swapped labels is read the way the triage flags read it', () => {
    const swapped = { transcript: 'Caller: Hi, this is Sam with Waves, calling about your quote.\nAgent: Just bill me each time.\nCaller: Will do.', outbound: true };
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), swapped)).toBe('Just bill me each time.');
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { ...swapped, outbound: false })).toBeNull();
  });

  test('none: null', () => {
    expect(callerWordsOf({}, talk('x'))).toBeNull();
    expect(callerWordsOf(null, talk('x'))).toBeNull();
    expect(callerWordsOf(evidence(choice('   ')), talk('x'))).toBeNull();
    expect(callerWordsOf({ evidence: 'not a list' }, talk('x'))).toBeNull();
  });

  test("the turn's spacing is tidied, never its words", () => {
    expect(callerWordsOf(evidence(choice('bill me each time')), talk('  Just   bill me each time,    please. '))).toBe('Just bill me each time, please.');
  });
});
