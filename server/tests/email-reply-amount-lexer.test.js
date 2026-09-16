const { matchEmailReplyAmountAt: matchAt } = require('../services/email/email-reply-amount-lexer');

const token = (kind, text, start = 0) => ({ kind, text, start, end: start + text.length });

describe('bounded anchored email reply amount lexer', () => {
  test.each(["98'99", '98’99', '98‘99', "$98'99", '$98’99', '$98‘99'])(
    'rejects internal straight and curly apostrophe joins: %s', (text) => {
      expect(matchAt(text)).toBeNull();
    },
  );
  test.each(["'$98'", '‘$98’'])(
    'preserves legitimate closing quote delimiters: %s', (source) => {
      expect(matchAt(source, 1)).toEqual(token('money', '$98', 1));
    },
  );

  test.each(['$98 and update me', '$98 or moreover we can discuss it'])(
    'preserves money before ordinary prose resembling a minimum suffix: %s', (text) => {
      expect(matchAt(text)).toEqual(token('money', '$98'));
    },
  );
  test.each(['$98 and up-front', '$98 or more-or-less', '$98 and up-é', '$98 and up-𐐀'])(
    'keeps the base money before a hyphenated non-minimum suffix: %s', (source) => {
      expect(matchAt(source)).toEqual(token('money', '$98'));
    },
  );
  test.each(['$1,,000', '$98..50', '$98.,50', '$98,.50', '1,,000', '98..50'])(
    'rejects partial amounts before numeric punctuation runs: %s', (text) => {
      expect(matchAt(text)).toBeNull();
    },
  );
  test('preserves punctuation without a joined numeric continuation', () => {
    expect(matchAt('$98...')).toEqual(token('money', '$98'));
    expect(matchAt('$98... 2 visits')).toEqual(token('money', '$98'));
  });
  test.each(['$98 and up to 2 follow-ups', '$98 AND UP TO 2 follow-ups'])(
    'keeps up-to prose outside the amount: %s', (text) => {
      expect(matchAt(text)).toEqual(token('money', '$98'));
    },
  );
  test.each(['$1234,567', '1234,567', '$12345,678', '$12,34,567'])(
    'rejects malformed grouped amounts: %s', (text) => {
      expect(matchAt(text)).toBeNull();
    },
  );

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

  test('rejects a joined second dollar sign but preserves distinct amounts', () => {
    expect(matchAt('$98$120')).toBeNull();
    expect(matchAt('98$120')).toBeNull();
    expect(matchAt('$98 $120')).toEqual(token('money', '$98'));
    expect(matchAt('$98 $120', 4)).toEqual(token('money', '$120', 4));
    expect(matchAt('$98,$120')).toEqual(token('money', '$98'));
    expect(matchAt('$98,$120', 4)).toEqual(token('money', '$120', 4));
  });
  test('checks full Unicode code points at the right edge', () => {
    expect(matchAt('$98𐐀')).toBeNull();
    expect(matchAt('98𐐀')).toBeNull();
    expect(matchAt('$98-𐐀')).toBeNull();
    expect(matchAt('$98e\u0301')).toBeNull();
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
    expect(matchAt('𐐀98', 2)).toBeNull();
    expect(matchAt('e\u030198', 2)).toBeNull();
    expect(matchAt('𐐀$98', 2)).toEqual(token('money', '$98', 2));
  });

  test.each([
    '90 to 120', '90 - 120', 'between 90 and 120 minutes',
    'from 90 to 120 minutes',
  ])('does not start at a spaced range endpoint: %s', (source) => {
    expect(matchAt(source, source.indexOf('120'))).toBeNull();
  });
  test.each(['between 90 and 120 minutes', 'from 90 to 120 minutes'])(
    'does not start at the first endpoint of a complete prose range: %s', (source) => {
      expect(matchAt(source, source.indexOf('90'))).toBeNull();
    },
  );
  test('does not let an invalid earlier start hide an independent later amount', () => {
    expect(matchAt('A90 - 120 dollars', 1)).toBeNull();
    expect(matchAt('A90 - 120 dollars', 6)).toEqual(token('money', '120 dollars', 6));
    expect(matchAt('A90 to 120 dollars', 1)).toBeNull();
    expect(matchAt('A90 to 120 dollars', 7)).toEqual(token('money', '120 dollars', 7));
  });
  test.each([
    ['one hundred and twenty dollars', 'twenty', 'money'],
    ['one hundred twenty minutes', 'twenty', 'measurement'],
    ['one-hundred and twenty dollars', 'twenty', 'money'],
    ['one hundred-and twenty dollars', 'twenty', 'money'],
    ['ninety eight dollars', 'eight', 'money'],
    ['twenty one dollars', 'one', 'money'],
    ['one hundred and twenty eight dollars', 'eight', 'money'],
  ])('does not start inside a complete written amount: %s', (source, interior, kind) => {
    expect(matchAt(source)).toEqual(token(kind, source));
    expect(matchAt(source, source.lastIndexOf(interior))).toBeNull();
  });
  test('keeps later written amounts separate when no enclosing token covers them', () => {
    const separate = 'one hundred dollars and twenty dollars';
    expect(matchAt(separate, separate.lastIndexOf('twenty')))
      .toEqual(token('money', 'twenty dollars', separate.lastIndexOf('twenty')));
    const invalidPrefix = 'Aone hundred twenty dollars';
    expect(matchAt(invalidPrefix, invalidPrefix.indexOf('one'))).toBeNull();
    expect(matchAt(invalidPrefix, invalidPrefix.indexOf('twenty')))
      .toEqual(token('money', 'twenty dollars', invalidPrefix.indexOf('twenty')));
  });
  test.each([
    ['$90 to $120', 7], ['$90 - $120', 6],
    ['USD 90 to USD 120', 10], ['USD 90 to USD 120', 14],
  ])('does not start at an explicit-currency endpoint inside a full range: %s', (source, at) => {
    expect(matchAt(source, at)).toBeNull();
  });
  test('keeps amounts after a conjunction or separator distinct from ranges', () => {
    expect(matchAt('90 and 120', 7)).toEqual(token('number', '120', 7));
    expect(matchAt('between 90 and 120', 8)).toEqual(token('number', '90', 8));
    expect(matchAt('between 90 and 120', 15)).toEqual(token('number', '120', 15));
    expect(matchAt('$90 and $120', 8)).toEqual(token('money', '$120', 8));
    expect(matchAt('We paid 90, then 120', 17)).toEqual(token('number', '120', 17));
    expect(matchAt('USD 90 and USD 120', 11)).toEqual(token('money', 'USD 120', 11));
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
