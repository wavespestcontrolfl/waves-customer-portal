/**
 * The caller's words for the phone-yes cards (call-phone-yes-word.js), the parts that need no database: a quote counts
 * only when it is the caller's, found word for word in a caller turn, inside a plain statement. The reads against
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
  const plain = (words) => ({ words, plain: true });
  const notPlain = (words) => ({ words, plain: false });

  test("the caller's whole turn that holds the quote; never staff's words, never another field's", () => {
    const transcript = talk('Okay. Just bill me each time, that works.');
    expect(callerWordsOf(evidence(
      choice('We bill after each visit.', 'agent'),
      choice('Bill me each time.', 'caller', '/scheduling/status'),
      choice('  Just   bill me\neach time  '),
    ), transcript)).toEqual(plain('Okay. Just bill me each time, that works.'));
    expect(callerWordsOf(evidence(choice('just bill me each time', 'caller', 'service_request.billing_choice')), transcript))
      .toEqual(plain('Okay. Just bill me each time, that works.'));
  });

  test.each([
    ['a negated sentence', "Please don't bill me each time."],
    ['a hedge', 'Maybe just bill me each time.'],
    ['a question', 'Can you just bill me each time?'],
    ['a condition with a price', 'If the price is $49.99, bill me each time.'],
    ['a condition with a time', 'If you come at 8 a.m. bill me each time.'],
    ['a condition with a time and a day', 'If you come at 8 a.m. Thursday, bill me each time.'],
    // The shared screen as it is: any "when" fails closed, and the office reads the words (by design, no phrase list).
    ['a "when"', 'Just bill me each time when you come out.'],
    ['a turn with a condition after it', 'Bill me each time. Only if the price stays the same.'],
    ['a turn with a question before it', 'Can you just bill me each time? Okay then. Yes, just bill me each time.'],
    ['a turn that turns down another plan first', "I don't want the annual. Just bill me each time."],
  ])('a quote inside %s is shown, and is not plain', (_name, line) => {
    expect(callerWordsOf(evidence(choice('bill me each time')), talk(line))).toEqual(notPlain(line));
  });

  test('a price in the turn is fine', () => {
    expect(callerWordsOf(evidence(choice('just bill me each time')), talk("It's $49.99 a visit. Just bill me each time.")))
      .toEqual(plain("It's $49.99 a visit. Just bill me each time."));
  });

  test('every caller turn that says it must be plain; the office sees the one that is not', () => {
    const twice = (first, second) => ({ transcript: `Agent: Thanks for calling Waves.\nCaller: ${first}\nAgent: Okay.\nCaller: ${second}\nAgent: Got it.` });
    expect(callerWordsOf(evidence(choice('bill me each time')), twice('Bill me each time.', "Actually, don't bill me each time.")))
      .toEqual(notPlain("Actually, don't bill me each time."));
    expect(callerWordsOf(evidence(choice('bill me each time')), twice("Don't bill me each time yet.", 'Okay, bill me each time.')))
      .toEqual(notPlain("Don't bill me each time yet."));
    expect(callerWordsOf(evidence(choice('bill me each time')), twice('Bill me each time.', 'Yes, bill me each time.')))
      .toEqual(plain('Yes, bill me each time.'));
  });

  test('a quote across two sentences is screened with both', () => {
    expect(callerWordsOf(evidence(choice('the quarterly. Bill me each time')), talk("Let's do the quarterly. Bill me each time, please.")))
      .toEqual(plain("Let's do the quarterly. Bill me each time, please."));
    expect(callerWordsOf(evidence(choice('the quarterly. Bill me each time')), talk("Maybe the quarterly. Bill me each time, please.")))
      .toEqual(notPlain("Maybe the quarterly. Bill me each time, please."));
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
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), swapped)).toEqual(plain('Just bill me each time.'));
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { ...swapped, outbound: false })).toBeNull();
  });

  test('none: null', () => {
    expect(callerWordsOf({}, talk('x'))).toBeNull();
    expect(callerWordsOf(null, talk('x'))).toBeNull();
    expect(callerWordsOf(evidence(choice('   ')), talk('x'))).toBeNull();
    expect(callerWordsOf({ evidence: 'not a list' }, talk('x'))).toBeNull();
  });

  test('a long turn is cut around the quote, so the choice always shows', () => {
    const line = `${'so we talked about it and '.repeat(10)}just bill me each time${' and that is fine'.repeat(6)}.`;
    const { words, plain: isPlain } = callerWordsOf(evidence(choice('just bill me each time')), talk(line));
    expect(isPlain).toBe(true);
    expect(words).toContain('just bill me each time');
    expect(words.length).toBeLessThanOrEqual(202);
    expect(words.startsWith('…')).toBe(true);
    expect(words.endsWith('…')).toBe(true);
  });

  test('a quote longer than the cut is shown whole', () => {
    const long = `${'word '.repeat(80)}done`;
    expect(callerWordsOf(evidence(choice(long)), talk(long))).toEqual(plain(long));
  });
});
