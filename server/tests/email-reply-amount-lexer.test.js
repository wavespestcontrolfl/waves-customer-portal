const { matchEmailReplyAmountAt: matchAt } = require('../services/email/email-reply-amount-lexer');

const token = (kind, text, start = 0) => ({ kind, text, start, end: start + text.length });

describe('bounded anchored email reply amount lexer', () => {
  test.each([
    '$98', '$1,298.50', 'USD 98-120', '$90-$120', '98 dollars', '98 bucks',
    '98 cents', 'Ninety-eight dollars', 'One hundred dollars',
    'one-hundred-and-twenty-eight-dollar', 'ninety-eight-cent', '98-cent',
    '$98+', '$98 and up', '$98 or more', 'USD 98 to 120',
    '98¢', '$.98', 'USD .98',
  ])('recognizes explicit bounded money: %s', (text) => {
    expect(matchAt(text)).toEqual(token('money', text));
  });

  test.each([
    '30-45 minutes', 'between 90 and 120 minutes',
    'from 90 to 120 minutes', '1.5 hours', '98mins', '2 hrs',
    'one-hundred-and-twenty-eight minutes', '2 photos', '2 points',
    '2 reminders', '2 gallons',
  ])('recognizes a complete measurement: %s', (text) => {
    expect(matchAt(text)).toEqual(token('measurement', text));
  });

  test.each(['98', '1,298.50', '90-120', '90 to 120'])('recognizes a bounded bare number: %s', (text) => {
    expect(matchAt(text)).toEqual(token('number', text));
  });

  test('chooses the longest anchored kind and keeps offsets in the original source', () => {
    expect(matchAt('98 cents')).toEqual(token('money', '98 cents'));
    expect(matchAt('98 minutes')).toEqual(token('measurement', '98 minutes'));
    expect(matchAt('Please pay $98 per visit', 11)).toEqual(token('money', '$98', 11));
    expect(matchAt('Please pay $98 per visit', 12)).toBeNull();
    expect(matchAt('is$98', 2)).toEqual(token('money', '$98', 2));
    expect(matchAt("Your visit's fee is$98", 19)).toEqual(token('money', '$98', 19));
    expect(matchAt('$98 per visit')).toEqual(token('money', '$98'));
    expect(matchAt('per visit')).toBeNull();
  });

  test('keeps punctuation boundaries without absorbing unrelated words', () => {
    expect(matchAt('($98),', 1)).toEqual(token('money', '$98', 1));
    expect(matchAt('98.')).toEqual(token('number', '98'));
    expect(matchAt('98, next')).toEqual(token('number', '98'));
    expect(matchAt('USD .98!')).toEqual(token('money', 'USD .98'));
    expect(matchAt('$98,$120 per visit', 4)).toEqual(token('money', '$120', 4));
    expect(matchAt('98,12', 3)).toBeNull();
    expect(matchAt('$98 + tax')).toEqual(token('money', '$98'));
    expect(matchAt('98¢ + tax')).toEqual(token('money', '98¢'));
    expect(matchAt('$$98', 1)).toBeNull();
  });

  test('allows opening straight and curly quotes before an amount', () => {
    expect(matchAt("'$98 per visit'", 1)).toEqual(token('money', '$98', 1));
    expect(matchAt("'98 dollars per visit'", 1)).toEqual(token('money', '98 dollars', 1));
    expect(matchAt("('98 dollars')", 2)).toEqual(token('money', '98 dollars', 2));
    expect(matchAt('‘$98 per visit’', 1)).toEqual(token('money', '$98', 1));
    expect(matchAt('“‘98 dollars’”', 2)).toEqual(token('money', '98 dollars', 2));
  });

  test('still rejects an apostrophe inside a word or malformed number', () => {
    expect(matchAt("visit'98", 6)).toBeNull();
    expect(matchAt("98'99", 3)).toBeNull();
    expect(matchAt('visit’98', 6)).toBeNull();
  });

  test.each([
    '98th', 'x98', '98x', '98_foo', '98-foo', '90-120foo',
    '98.123', '98,12', '$98.123', '$98,12', 'USD .987',
    '98-dollarx', '9999999999', '$$98', '98cent',
  ])('does not return a partial amount in malformed input: %s', (text) => {
    expect(matchAt(text)).toBeNull();
  });

  test('does not start inside an identifier, numeric range, or currency token', () => {
    expect(matchAt('a98', 1)).toBeNull();
    expect(matchAt('90-120', 3)).toBeNull();
    expect(matchAt('$98', 1)).toBeNull();
    expect(matchAt('ninety-eight cents', 7)).toBeNull();
  });

  test.each([
    [null, 0], [98, 0], ['', 0], ['98', -1], ['98', 1.5],
    ['98', NaN], ['98', 2], ['98', 99],
  ])('rejects invalid source or offset: %#', (source, at) => {
    expect(matchAt(source, at)).toBeNull();
  });

  test('enforces the 8192-byte raw source bound before matching', () => {
    expect(matchAt(`98${' '.repeat(8190)}`)).toEqual(token('number', '98'));
    expect(matchAt(`98${' '.repeat(8191)}`)).toBeNull();
    expect(matchAt(`98${'é'.repeat(4095)}`)).toBeNull();
  });
});
