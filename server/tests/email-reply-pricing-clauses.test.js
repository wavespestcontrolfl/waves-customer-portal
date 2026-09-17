const { recognizeEmailReplyPricingClauses: recognize } = require('../services/email/email-reply-pricing-clauses');

const tokens = (text) => recognize(text).clauses[0] || [];
const kinds = (text) => tokens(text).map(({ kind }) => kind);
const words = (text) => tokens(text).map(({ text }) => text);

describe('bounded email reply pricing clause recognition', () => {
  test.each(['—', '–', '‒', '―', '&mdash;', '&#8211;'])(
    'preserves pricing units before punctuation dash %s', (dash) => {
      expect(kinds(`$98 per visit${dash}plus tax`)).toEqual(['money', 'unit', 'sep', 'word', 'word']);
      expect(kinds(`Billing is per visit${dash}plus tax`)).toContain('unit');
      expect(kinds(`$98 per application${dash}plus tax`)).toContain('application');
      expect(kinds(`$98/mo${dash}plus tax`)).toContain('period');
      expect(kinds(`Price${dash}$98 per visit`)).toEqual(['word', 'sep', 'money', 'unit']);
    },
  );

  test.each(['—', '–'])(
    'preserves amount and duration ranges separated by %s', (dash) => {
      expect(kinds(`$98${dash}120 per visit`)).toEqual(['money', 'unit']);
      expect(kinds(`Each visit takes 30${dash}45 minutes`)).toEqual(['eachVisit', 'word', 'measurement']);
    },
  );

  test('fails closed when lowercasing expands accepted copy beyond the lexer limit', () => {
    const text = `${'İ'.repeat(2730)} $98 per visit`;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(8192);
    expect(Buffer.byteLength(text.toLowerCase(), 'utf8')).toBeGreaterThan(8192);
    expect(recognize(text)).toEqual({ ok: false, reason: 'copy_size' });
  });

  test('retains trailing pricing evidence when lowercase expansion stays within bounds', () => {
    const text = `${'İ'.repeat(2700)} $98 per visit`;
    expect(recognize(text).ok).toBe(true);
    expect(tokens(text).slice(-2)).toEqual([
      { kind: 'money', text: '$98' }, { kind: 'unit', text: 'per visit' },
    ]);
  });

  test.each(['98¢ per visit', '$.98 per visit', 'USD .98 per visit'])(
    'keeps sub-dollar money ahead of a visit unit: %s', (text) => {
      expect(kinds(text)).toEqual(['money', 'unit']);
    },
  );
  test.each(['$98/mo', '$1,176/yr'])(
    'keeps plan period evidence out of the barrier fallback: %s', (text) => {
      expect(kinds(text)).toEqual(['money', 'period']);
    },
  );

  test.each([
    ['$98 per visit', ['money', 'unit']],
    ['Billing is per visit', ['word', 'be', 'unit']],
    ['Each visit costs $98', ['eachVisit', 'word', 'money']],
    ["Your visit's price is $98", ['visit', 'possessive', 'word', 'be', 'money']],
    ['Please pay $98 on your next visit', ['word', 'word', 'money', 'timing']],
    ['Visit fee: $98', ['visit', 'word', 'sep', 'money']],
    ['Each visit runs 30-45 minutes', ['eachVisit', 'word', 'measurement']],
    ['Price per application and access for each visit', ['word', 'application', 'word', 'word', 'unit']],
  ])('classifies representative pricing evidence: %s', (text, expected) => {
    expect(kinds(text)).toEqual(expected);
  });

  test.each([
    ['$98 for each visit', ['money', 'unit']],
    ['$98 for first visit', ['money', 'forVisit']],
    ['USD 98 on your routine visits', ['money', 'unit']],
    ['$98 at every scheduled visit', ['money', 'unit']],
    ['$98 at your next visit', ['money', 'timing']],
    ['Visits are $98', ['visits', 'be', 'money']],
    ['Each visit is 98 minutes long', ['eachVisit', 'be', 'measurement', 'word']],
    ['30 minute visit', ['visit']],
    ['per 30 minute visit', ['unit']],
    ['on a visit-by-visit basis', ['unit']],
    ['by the visit', ['unit']],
    ['/visit', ['unit']],
  ])('chooses longest anchored unit or measurement: %s', (text, expected) => {
    expect(kinds(text)).toEqual(expected);
  });

  test.each([
    ['Each visit costs between 90 and 120 minutes.', 'between 90 and 120 minutes'],
    ['Each visit costs from 90 to 120 minutes.', 'from 90 to 120 minutes'],
  ])('keeps a complete prose duration range as one measurement: %s', (text, range) => {
    expect(tokens(text)).toEqual([
      { kind: 'eachVisit', text: 'each visit' },
      { kind: 'word', text: 'cost' },
      { kind: 'measurement', text: range },
    ]);
  });

  test('keeps currency prose ranges as money, not measurement', () => {
    expect(kinds('Each visit costs between $90 and $120.')).toEqual([
      'eachVisit', 'word', 'word', 'money', 'word', 'money',
    ]);
    expect(kinds('Each visit costs from $90 to $120.')).toEqual([
      'eachVisit', 'word', 'word', 'money',
    ]);
  });

  test.each([
    ['$98 pay-per-visit', 'pay', 'unit', '-per-visit'],
    ['$98 billed-per-visit', 'bill', 'unit', '-per-visit'],
    ['$98 pay-per-application', 'pay', 'application', '-per-application'],
  ])('preserves the predicate and embedded unit in %s', (text, predicate, kind, unit) => {
    expect(tokens(text)).toEqual([
      { kind: 'money', text: '$98' },
      { kind: 'word', text: predicate },
      { kind, text: unit },
    ]);
  });
  test('keeps an amountless pay-per-visit predicate visible', () => {
    expect(tokens('We use pay-per-visit')).toEqual([
      { kind: 'word', text: 'we' }, { kind: 'word', text: 'use' },
      { kind: 'word', text: 'pay' }, { kind: 'unit', text: '-per-visit' },
    ]);
  });

  test.each([
    ['per the application', 'application'],
    ['per each application', 'application'],
    ['/ the application', 'application'],
    ['/ each application', 'application'],
    ['per the visit', 'unit'],
    ['/ each visit', 'unit'],
  ])('accepts bounded determiners after a per/slash prefix: %s', (unit, kind) => {
    expect(tokens(`$98 ${unit}`)).toEqual([
      { kind: 'money', text: '$98' }, { kind, text: unit },
    ]);
  });

  test.each([
    ['We credited $98 for application-related damage', 'application-related'],
    ['$98 for visit-related damage', 'visit-related'],
    ['$98 per-visit-fee', 'per-visit-fee'],
  ])('does not classify a partial hyphenated noun: %s', (text, noun) => {
    expect(tokens(text).some(({ kind }) => ['application', 'forVisit', 'unit'].includes(kind))).toBe(false);
    expect(tokens(text)).toContainEqual({ kind: 'word', text: noun });
  });

  test('recognizes bounded numeric ordinal modifiers', () => {
    expect(tokens('$98 for the 1st visit')).toEqual([
      { kind: 'money', text: '$98' }, { kind: 'forVisit', text: 'for the 1st visit' },
    ]);
    expect(tokens('$98 for the 2nd application')).toEqual([
      { kind: 'money', text: '$98' }, { kind: 'application', text: 'for the 2nd application' },
    ]);
  });

  test.each([
    ['98 cents per visit', '98 cents'],
    ['ninety-eight cents per visit', 'ninety-eight cents'],
  ])('recognizes explicit cents before a recurring visit unit: %s', (text, amount) => {
    expect(tokens(text)).toEqual([
      { kind: 'money', text: amount }, { kind: 'unit', text: 'per visit' },
    ]);
  });
  test.each(['98-cent', 'ninety-eight-cent'])('keeps cent adjectives out of visit modifiers: %s', (amount) => {
    expect(tokens(`a ${amount} visit fee`)).toEqual([
      { kind: 'word', text: 'a' }, { kind: 'money', text: amount },
      { kind: 'visit', text: 'visit' }, { kind: 'word', text: 'fee' },
    ]);
  });

  test('recognizes application subjects without a unit prefix', () => {
    expect(tokens('Each application costs $98')).toEqual([
      { kind: 'application', text: 'each application' },
      { kind: 'word', text: 'cost' }, { kind: 'money', text: '$98' },
    ]);
    expect(tokens("This application's price is $98")).toEqual([
      { kind: 'application', text: 'this application' },
      { kind: 'possessive', text: "'s" }, { kind: 'word', text: 'price' },
      { kind: 'be', text: 'is' }, { kind: 'money', text: '$98' },
    ]);
    expect(tokens('for each application')).toEqual([
      { kind: 'application', text: 'for each application' },
    ]);
  });

  test('recognizes abbreviated visit duration modifiers and compact measurements', () => {
    expect(tokens('$98 per 30-min visit')).toEqual([
      { kind: 'money', text: '$98' }, { kind: 'unit', text: 'per 30-min visit' },
    ]);
    expect(tokens('$98 for each 1-hr visit')).toEqual([
      { kind: 'money', text: '$98' }, { kind: 'unit', text: 'for each 1-hr visit' },
    ]);
    expect(tokens('Each visit costs 98mins')).toEqual([
      { kind: 'eachVisit', text: 'each visit' }, { kind: 'word', text: 'cost' },
      { kind: 'measurement', text: '98mins' },
    ]);
  });

  test('keeps inherited object property names as ordinary string tokens', () => {
    expect(tokens('constructor')).toEqual([{ kind: 'word', text: 'constructor' }]);
  });

  test.each([
    'for this application', 'for my next application',
    'for their application', 'for his application', 'for her application',
  ])('recognizes complete application determiners: %s', (unit) => {
    expect(tokens(`$98 ${unit}`)).toEqual([
      { kind: 'money', text: '$98' }, { kind: 'application', text: unit },
    ]);
  });

  test.each([
    ['a ninety-eight-dollar visit fee', 'ninety-eight-dollar', 'visit', 'fee'],
    ['a 98-dollar visit', '98-dollar', 'visit', null],
  ])('retains hyphenated currency before visit: %s', (text, amount, visit, noun) => {
    expect(tokens(text)).toEqual([
      { kind: 'word', text: 'a' }, { kind: 'money', text: amount },
      { kind: 'visit', text: visit },
      ...(noun ? [{ kind: 'word', text: noun }] : []),
    ]);
  });

  test.each([
    'one-hundred-dollar',
    'one-hundred-and-twenty-eight-dollar',
    'one-hundred-twenty-eight-dollar',
  ])('keeps a fully hyphenated written amount out of the visit phrase: %s', (amount) => {
    expect(tokens(`a ${amount} visit fee`)).toEqual([
      { kind: 'word', text: 'a' }, { kind: 'money', text: amount },
      { kind: 'visit', text: 'visit' }, { kind: 'word', text: 'fee' },
    ]);
  });

  test('preserves written-number measurements and spaced currency', () => {
    expect(tokens('One-hundred-and-twenty-eight minutes')).toEqual([
      { kind: 'measurement', text: 'one-hundred-and-twenty-eight minutes' },
    ]);
    expect(kinds('Each visit costs one hundred dollars')).toEqual([
      'eachVisit', 'word', 'money',
    ]);
  });

  test.each([
    ["Please pay $98 at today's visit", "at today's visit"],
    ["Please pay $98 on tomorrow's visit", "on tomorrow's visit"],
    ["We received $98 on Monday's scheduled visit", "on monday's scheduled visit"],
    ["We received $98 at next Tuesday's visit", "at next tuesday's visit"],
    ['Please pay $98 at today’s visit', "at today's visit"],
  ])('classifies temporal possessive visit timing: %s', (text, timing) => {
    expect(tokens(text).at(-1)).toEqual({ kind: 'timing', text: timing });
  });
  test('keeps recurring on every visit as a unit', () => {
    expect(tokens('$98 on every visit').at(-1)).toEqual({ kind: 'unit', text: 'on every visit' });
  });

  test.each([
    '$1,298.50 per visit', 'USD 98-120 for each visit',
    '98 dollars per visit', 'Ninety-eight dollars per visit',
    'One hundred dollars per visit', '$98+ per visit',
    '$98 and up per visit', '$98 or more per visit',
  ])('recognizes an explicit amount before the unit: %s', (text) => {
    expect(kinds(text)).toEqual(['money', 'unit']);
  });

  test('keeps a tax operator distinct from a minimum-price suffix', () => {
    expect(tokens('$98 + tax per visit')).toEqual([
      { kind: 'money', text: '$98' },
      { kind: 'word', text: 'plus' },
      { kind: 'word', text: 'tax' },
      { kind: 'unit', text: 'per visit' },
    ]);
    expect(words('$98+ per visit')).toEqual(['$98+', 'per visit']);
  });

  test('normalizes billing verbs and noun plurals while retaining feedback rate', () => {
    expect(recognize('Prices are billed; fees and payments are invoiced').clauses.map(
      (clause) => clause.map(({ text }) => text),
    )).toEqual([
      ['price', 'are', 'bill'], ['fee', 'and', 'payment', 'are', 'invoice'],
    ]);
    expect(words('Please rate each visit')).toEqual(['please', 'rate', 'each visit']);
    expect(words('Rates apply on each visit')).toEqual(['rate', 'apply', 'on each visit']);
  });

  test('stops visit modifiers at pricing predicates and subjects', () => {
    expect(tokens('We charge scheduled visit $98')).toEqual([
      { kind: 'word', text: 'we' }, { kind: 'word', text: 'charge' },
      { kind: 'visit', text: 'scheduled visit' }, { kind: 'money', text: '$98' },
    ]);
    expect(words('Customers are billed for every on-site visit')).toEqual([
      'customers', 'are', 'bill', 'for every on-site visit',
    ]);
    expect(words('Please price the in-home visit')).toEqual([
      'please', 'price', 'the in-home visit',
    ]);
    expect(words('Our fees for your plan include routine visits')).toEqual([
      'our', 'fee', 'for', 'your', 'plan', 'include', 'routine visits',
    ]);
  });

  test('keeps written currency evidence ahead of a visit fee noun phrase', () => {
    expect(tokens('There is a ninety-eight dollar visit fee.')).toEqual([
      { kind: 'word', text: 'there' }, { kind: 'be', text: 'is' },
      { kind: 'word', text: 'a' }, { kind: 'money', text: 'ninety-eight dollar' },
      { kind: 'visit', text: 'visit' }, { kind: 'word', text: 'fee' },
    ]);
    expect(tokens('There is a one hundred dollar service-visit charge.')).toEqual([
      { kind: 'word', text: 'there' }, { kind: 'be', text: 'is' },
      { kind: 'word', text: 'a' }, { kind: 'money', text: 'one hundred dollar' },
      { kind: 'visit', text: 'service-visit' }, { kind: 'word', text: 'charge' },
    ]);
  });

  test('recognizes finite auxiliaries and leaves separate-payment adverbs intact', () => {
    expect(kinds('Visits would be billed separately')).toEqual(['visits', 'be', 'word', 'word']);
    expect(words('Visits would be billed separately')).toEqual(['visits', 'would be', 'bill', 'separately']);
    expect(words('Each visit has been invoiced individually')).toEqual([
      'each visit', 'has been', 'invoice', 'individually',
    ]);
    expect(kinds('Each visit may incur a charge')).toEqual([
      'eachVisit', 'modal', 'word', 'word', 'word',
    ]);
  });

  test('splits sentences after decimal monetary and measurement tokens', () => {
    expect(recognize('$98.50 per visit. Each visit lasts 1.5 hours!')).toEqual({
      ok: true,
      clauses: [
        [{ kind: 'money', text: '$98.50' }, { kind: 'unit', text: 'per visit' }],
        [{ kind: 'eachVisit', text: 'each visit' }, { kind: 'word', text: 'lasts' },
          { kind: 'measurement', text: '1.5 hours' }],
      ],
    });
  });

  test('keeps payment timing and distinct application prices separate', () => {
    expect(kinds('We received $98 for your account before the next visit')).toEqual([
      'word', 'word', 'money', 'word', 'word', 'word', 'word', 'visit',
    ]);
    expect(kinds('Your $98 payment is pending, and we will arrange a visit')).toEqual([
      'word', 'money', 'word', 'be', 'word', 'sep', 'word', 'word', 'modal', 'word', 'visit',
    ]);
    expect(recognize('$98 per application; we send one reminder per visit').clauses.map(
      (clause) => clause.map(({ kind }) => kind),
    )).toEqual([
      ['money', 'application'], ['word', 'word', 'measurement', 'unit'],
    ]);
    expect(recognize('Your balance is $98; per visit, we send a reminder').clauses.map(
      (clause) => clause.map(({ kind }) => kind),
    )).toEqual([
      ['word', 'word', 'be', 'money'],
      ['unit', 'sep', 'word', 'word', 'word', 'word'],
    ]);
  });

  test('retains unmatched backticks and unknown symbols as barriers', () => {
    expect(kinds('USD ``98` per visit')).toEqual([
      'word', 'barrier', 'barrier', 'number', 'barrier', 'unit',
    ]);
    expect(tokens('x @ y')[1]).toEqual({ kind: 'barrier', text: '@' });
  });

  test.each([
    [null, 'copy_type'],
    ['a'.repeat(8193), 'copy_size'],
    ['a '.repeat(513), 'copy_tokens'],
  ])('returns the normalizer failure without scanning: %#', (text, reason) => {
    expect(recognize(text)).toEqual({ ok: false, reason });
  });

  test('fails closed on normalization depth and accepts empty input', () => {
    const wrap = Array.from({ length: 80 }, (_, i) => (i % 2 ? '_' : '*'));
    const text = wrap.join('') + '$98 per visit' + [...wrap].reverse().join('');
    expect(recognize(text)).toEqual({ ok: false, reason: 'copy_format_depth' });
    expect(recognize()).toEqual({ ok: true, clauses: [] });
  });

  test('keeps maximum-size malformed numeric and punctuation input bounded', () => {
    const giant = '$' + '1,'.repeat(4095) + 'x';
    expect(Buffer.byteLength(giant, 'utf8')).toBe(8192);
    const result = recognize(giant);
    expect(result.ok).toBe(true);
    expect(result.clauses.length).toBe(1);
    expect(result.clauses[0].length).toBeGreaterThan(0);
  });
});
