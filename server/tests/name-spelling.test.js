/**
 * respellRecordName (server/utils/name-spelling.js): the staff mic puts the record's spelling back
 * on the name the words greet the on-screen customer by, and changes nothing else. The guards keep
 * it from rewriting a name said in passing, another person's name, months, staff or place names.
 * Synthetic names only.
 */
const { respellRecordName, nameLetters, _private: { soundCode, spellingEdits, greeted } } = require('../utils/name-spelling');

const dena = { firstName: 'Dena', lastName: 'Exampleton' };
const say = (text, record = dena) => respellRecordName(text, record).text;

describe('respellRecordName', () => {
  test('the greeted first name gets the record spelling', () => {
    expect(respellRecordName('Hey Dina. We can come Tuesday.', dena)).toEqual({
      text: 'Hey Dena. We can come Tuesday.',
      fixes: [{ heard: 'Dina', spelled: 'Dena' }],
    });
    expect(say('Hi, Dina! See you then.')).toBe('Hi, Dena! See you then.');
    expect(say('Thank you, Dina')).toBe('Thank you, Dena');
    expect(say('Good morning Dina, see you at ten.')).toBe('Good morning Dena, see you at ten.');
    expect(say("Hi Dina's on the list.")).toBe("Hi Dena's on the list.");
  });

  test('the surname after a greeted first name, or after a greeting and a title, is fixed too', () => {
    expect(respellRecordName('Hi Dina Exampletin!', dena).fixes).toEqual([
      { heard: 'Dina', spelled: 'Dena' }, { heard: 'Exampletin', spelled: 'Exampleton' },
    ]);
    expect(say('Hi Mrs. Exampletin, all done.')).toBe('Hi Mrs. Exampleton, all done.');
  });

  test('a name said in passing is left as heard: it may be someone else', () => {
    expect(say('Tell Dina Exampletin hi.')).toBe('Tell Dina Exampletin hi.');
    expect(say('Dina, we can come Tuesday.')).toBe('Dina, we can come Tuesday.');
    expect(say('Good morning Dena, Dina called.')).toBe('Good morning Dena, Dina called.');
    expect(say('This morning Dina called about the appointment.')).toBe('This morning Dina called about the appointment.');
    expect(say('Yes, I said hi Dina would like that.')).toBe('Yes, I said hi Dina would like that.');
    expect(say('Hi Tom, and Tom will be there too.', { firstName: 'Tim', lastName: 'Sampleroe' })).toBe('Hi Tim, and Tom will be there too.');
  });

  test('a period ends the greeting, except after a title; a contraction is never a name', () => {
    const dan = { firstName: 'Dan', lastName: 'Sampleroe' };
    expect(say("Thanks. Don't worry about it.", dan)).toBe("Thanks. Don't worry about it.");
    expect(say("Thanks, Don't worry about it.", dan)).toBe("Thanks, Don't worry about it.");
    expect(say('Thanks, Don\u2019t worry about it.', dan)).toBe('Thanks, Don\u2019t worry about it.');
    expect(say('Good morning. Dina called.')).toBe('Good morning. Dina called.');
    expect(say('Thanks. Mrs. Exampletin called.')).toBe('Thanks. Mrs. Exampletin called.');
    expect(say('Hi, Mrs. Exampletin.')).toBe('Hi, Mrs. Exampleton.');
  });

  test('a greeted first name followed by a different surname greets someone else', () => {
    expect(say('Hi Dina Smith')).toBe('Hi Dina Smith');
    expect(say('Hi Dina Exampleton')).toBe('Hi Dena Exampleton');
  });

  test('adding or dropping a letter counts only for an h or a doubled letter', () => {
    expect(say('Hi Sarah', { firstName: 'Sara', lastName: 'Sampleroe' })).toBe('Hi Sara');
    expect(say('Hi Phillip', { firstName: 'Philip', lastName: 'Sampleroe' })).toBe('Hi Philip');
    // another name, not another spelling
    expect(say('Hi Erica', { firstName: 'Eric', lastName: 'Sampleroe' })).toBe('Hi Erica');
    expect(say('Hi Paula', { firstName: 'Paul', lastName: 'Sampleroe' })).toBe('Hi Paula');
    expect(spellingEdits('stephens', 'stevens', 2)).toBe(true);
    expect(spellingEdits('ab', 'ba', 1)).toBe(true);
  });

  test('one edit for a short name, two for a name of 6+ letters', () => {
    expect(say('Hi Dinna')).toBe('Hi Dinna');
    expect(say('Hi Mrs Examplitan')).toBe('Hi Mrs Exampleton');
  });

  test('a different first letter or a different sound is left as heard', () => {
    expect(say('Hi Tina')).toBe('Hi Tina');
    expect(say('Hi Brian', { firstName: 'Bryant', lastName: 'Sampleroe' })).toBe('Hi Brian');
    expect(soundCode('dena')).toBe(soundCode('dina'));
    // the whole word is coded: a 4-character cut would make these equal
    expect(soundCode('exampleton')).not.toBe(soundCode('example'));
  });

  test('lowercase words, ALL CAPS, months, the greeting\'s own words, group words and keep words are never changed', () => {
    expect(say('hi dina')).toBe('hi dina');
    expect(say('Hi DINA')).toBe('Hi DINA');
    expect(say('Hi June', { firstName: 'Jane', lastName: 'Sampleroe' })).toBe('Hi June');
    const moss = { firstName: 'Dena', lastName: 'Moss' };
    expect(say('Hi Miss Moss, see you Tuesday.', moss)).toBe('Hi Miss Moss, see you Tuesday.');
    expect(say('Hi Miss Mass, see you Tuesday.', moss)).toBe('Hi Miss Moss, see you Tuesday.');
    expect(say('Hi All, the gate is locked.', { firstName: 'Ali', lastName: 'Sampleroe' })).toBe('Hi All, the gate is locked.');
    const joy = { firstName: 'Joy', lastName: 'Sampleroe' };
    expect(say('Hi Joe', joy)).toBe('Hi Joy');
    expect(say('Hi Joe', { ...joy, keep: new Set(nameLetters('Joe Staffington')) })).toBe('Hi Joe');
  });

  test("the record's own words never change, and a flat-case record reads Title Case", () => {
    expect(respellRecordName('Hey Dena.', dena)).toEqual({ text: 'Hey Dena.', fixes: [] });
    expect(say('Hey Dina.', { firstName: 'DENA', lastName: 'EXAMPLETON' })).toBe('Hey Dena.');
    expect(say('Hi Mr Mcdonnald', { firstName: 'Ann', lastName: 'McDonald' })).toBe('Hi Mr McDonald');
  });

  test('greetings open a sentence; a title may sit between; "thank you" and "good morning" count', () => {
    const greetsX = (text) => greeted(text, text.lastIndexOf('X'));
    expect(greetsX('Hi Mrs. X')).toBe(true);
    expect(greetsX('Thank you X')).toBe(true);
    expect(greetsX('Done. Good evening X')).toBe(true);
    expect(greetsX('All set!\nHey X')).toBe(true);
    // mid-sentence, a time of day without "Good", a sentence end or a line break in between: left alone
    expect(greetsX('Sounds good, thanks X')).toBe(false);
    expect(greetsX('Yesterday evening X')).toBe(false);
    expect(greetsX('No thank you X')).toBe(false);
    expect(greetsX('Thanks. X')).toBe(false);
    expect(greetsX('Hi\nX')).toBe(false);
    expect(greetsX('X')).toBe(false);
  });

  test('no record name or no text: unchanged', () => {
    expect(respellRecordName('Hey Dina.', {})).toEqual({ text: 'Hey Dina.', fixes: [] });
    expect(respellRecordName('Hey Dina.')).toEqual({ text: 'Hey Dina.', fixes: [] });
    expect(respellRecordName('', dena)).toEqual({ text: '', fixes: [] });
  });
});
