// The shared number evaluator, extended for things named by number in lists
// (a station, a bay): numbersStatedIn. The call reader's own spokenNumbersIn
// reads as it always has.
const { groundingTools: { numbersStatedIn, spokenNumbersIn, spokenFiguresIn } } = require('../services/call-reschedule-agreement');

describe('numbersStatedIn', () => {
  test.each([
    ['Stations 2,3 were inaccessible', [2, 3]],
    ['Stations 2, 3 and 5', [2, 3, 5]],
    ['Stations 2/3', [2, 3]],
    ['stations 2 & 3', [2, 3]],
    ['stations 2,3,4', [2, 3, 4]],
    ['stations 2-4', [2, 3, 4]],
    ['stations 2 through 4', [2, 3, 4]],
    ['stations 2 to 4', [2, 3, 4]],
    ['station seven', [7]],
    ['stations two, three and five', [2, 3, 5]],
    ['stations two/three', [2, 3]],
    ['station 12', [12]],
  ])('%s', (text, expected) => {
    expect(numbersStatedIn(text).sort((a, b) => a - b)).toEqual(expected);
  });

  test('a decimal and an ordinal state no whole number, 1,000 is a thousand, and a backwards range is not a range', () => {
    expect(numbersStatedIn('about 4.5 ounces')).toEqual([]);
    expect(numbersStatedIn('the 4th box')).toEqual([]);
    expect(numbersStatedIn('1,000 feet')).toEqual([1000]);
    expect(numbersStatedIn('4-2')).toEqual([4, 2]);
  });

  test('adjacent number words with no separator stay ambiguous', () => {
    expect(numbersStatedIn('two three').every(Number.isNaN)).toBe(true);
  });
});

describe('spokenNumbersIn is unchanged without lists', () => {
  test('one thousand, two hundred reads whole; with lists it is two numbers', () => {
    expect(spokenNumbersIn('one thousand, two hundred')).toEqual([1200]);
    expect(spokenNumbersIn('one thousand, two hundred', { lists: true })).toEqual([1000, 200]);
    expect(spokenFiguresIn('about one thousand two hundred dollars')).toEqual([1200]);
  });
});
