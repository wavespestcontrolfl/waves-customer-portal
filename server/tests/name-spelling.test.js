/**
 * respellRecordName (server/utils/name-spelling.js): the staff mic puts the record's spelling back
 * on the first name the words greet the on-screen customer by, when the heard word is a listed
 * spelling of that name (spokenFirstNameSpellings, utils/name-match.js). Nothing else changes: an
 * ordinary word, an unlisted spelling, a nickname, a name said in passing or another person's name
 * stays as heard. Synthetic names only.
 */
const { respellRecordName, _private: { greeted, endsGreeting } } = require('../utils/name-spelling');

const sara = { firstName: 'Sara', lastName: 'Exampleton' };
const say = (text, record = sara) => respellRecordName(text, record).text;

describe('respellRecordName', () => {
  test('a greeted listed spelling of the first name gets the record spelling', () => {
    expect(respellRecordName('Hey Sarah. We can come Tuesday.', sara)).toEqual({
      text: 'Hey Sara. We can come Tuesday.',
      fixes: [{ heard: 'Sarah', spelled: 'Sara' }],
    });
    expect(say('Hi, Sarah! See you then.')).toBe('Hi, Sara! See you then.');
    expect(say('Thank you, Sarah')).toBe('Thank you, Sara');
    expect(say('Good morning Sarah, see you at ten.')).toBe('Good morning Sara, see you at ten.');
    expect(say('Hi Sarah Exampleton!')).toBe('Hi Sara Exampleton!');
    expect(say('Hi Miss Sarah, all done.')).toBe('Hi Miss Sara, all done.');
    expect(say('All set!\nHey Sarah')).toBe('All set!\nHey Sara');
    expect(say('Hi Philip.', { firstName: 'Phillip', lastName: 'Sampleroe' })).toBe('Hi Phillip.');
    expect(say('Hello Mark, the gate was open.', { firstName: 'Marc', lastName: 'Sampleroe' })).toBe('Hello Marc, the gate was open.');
  });

  test('only a listed spelling changes: an ordinary word, an unlisted spelling or a nickname stays', () => {
    expect(say('Thanks, See you tomorrow.', { firstName: 'Sue', lastName: 'Sampleroe' })).toBe('Thanks, See you tomorrow.');
    expect(say('Hi Dina.', { firstName: 'Dena', lastName: 'Sampleroe' })).toBe('Hi Dina.');
    expect(say('Hi Erica.', { firstName: 'Eric', lastName: 'Sampleroe' })).toBe('Hi Erica.');
    expect(say('Hi Mark.', { firstName: 'Marcus', lastName: 'Sampleroe' })).toBe('Hi Mark.');
    expect(say('Hi Jen.', { firstName: 'Jennifer', lastName: 'Sampleroe' })).toBe('Hi Jen.');
  });

  test('a name said in passing, mid-sentence, after a sentence end or before another surname stays', () => {
    expect(say('Tell Sarah hi.')).toBe('Tell Sarah hi.');
    expect(say('Sarah, we can come Tuesday.')).toBe('Sarah, we can come Tuesday.');
    expect(say('This morning Sarah called.')).toBe('This morning Sarah called.');
    expect(say('Sounds good, thanks Sarah!')).toBe('Sounds good, thanks Sarah!');
    expect(say('Thanks. Sarah will call you.')).toBe('Thanks. Sarah will call you.');
    expect(say('Good morning Sara, Sarah called.')).toBe('Good morning Sara, Sarah called.');
    expect(say('Hi Sarah Smith!')).toBe('Hi Sarah Smith!');
    expect(say('Hi Sarah how are you')).toBe('Hi Sarah how are you');
    expect(say('Thanks, Mark it down.', { firstName: 'Marc', lastName: 'Sampleroe' })).toBe('Thanks, Mark it down.');
  });

  test("lowercase and ALL CAPS stay; the record's own spelling stays; a flat-case record reads Title Case", () => {
    expect(say('hi sarah')).toBe('hi sarah');
    expect(say('Hi SARAH')).toBe('Hi SARAH');
    expect(respellRecordName('Hey Sara.', sara)).toEqual({ text: 'Hey Sara.', fixes: [] });
    expect(say('Hey Sarah.', { firstName: 'SARA', lastName: 'EXAMPLETON' })).toBe('Hey Sara.');
    expect(say('Hey Sarah Exampleton.', { firstName: 'sara', lastName: 'exampleton' })).toBe('Hey Sara Exampleton.');
  });

  test('no record name or no text: unchanged', () => {
    expect(respellRecordName('Hey Sarah.', {})).toEqual({ text: 'Hey Sarah.', fixes: [] });
    expect(respellRecordName('Hey Sarah.')).toEqual({ text: 'Hey Sarah.', fixes: [] });
    expect(respellRecordName('', sara)).toEqual({ text: '', fixes: [] });
  });
});

describe('greeted', () => {
  const greetsX = (text) => greeted(text, text.lastIndexOf('X'));

  test('a greeting opens a sentence; a title may sit between; "thank you" and "good morning" count', () => {
    expect(greetsX('Hi Mrs. X')).toBe(true);
    expect(greetsX('Thank you X')).toBe(true);
    expect(greetsX('Done. Good evening X')).toBe(true);
    expect(greetsX('All set!\nHey X')).toBe(true);
  });

  test('mid-sentence, a time of day without "Good", a sentence end or a line break between: no greeting', () => {
    expect(greetsX('Sounds good, thanks X')).toBe(false);
    expect(greetsX('Yesterday evening X')).toBe(false);
    expect(greetsX('No thank you X')).toBe(false);
    expect(greetsX('Thanks. X')).toBe(false);
    expect(greetsX('Thanks. Mrs. X')).toBe(false);
    expect(greetsX('Hi\nX')).toBe(false);
    expect(greetsX('X')).toBe(false);
  });
});

describe('endsGreeting', () => {
  const surnames = new Set(['exampleton']);
  const ends = (rest) => endsGreeting(`Sarah${rest}`, 5, surnames);

  test('the end, punctuation, a line break, a dash, a possessive or the record surname close the greeting', () => {
    for (const rest of ['', ',', ' !', '.', '\n', ' — see you', "'s husband", '’s gate', ' Exampleton']) expect(ends(rest)).toBe(true);
  });

  test('another word or another surname does not', () => {
    for (const rest of [' how are you', ' Smith', "'t worry", ' 2pm']) expect(ends(rest)).toBe(false);
  });
});
