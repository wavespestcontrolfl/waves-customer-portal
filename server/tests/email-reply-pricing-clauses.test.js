const { recognizeEmailReplyPricingClauses: recognize } = require('../services/email/email-reply-pricing-clauses');

const tokens = (text) => recognize(text).clauses[0] || [];
const kinds = (text) => tokens(text).map(({ kind }) => kind);
const words = (text) => tokens(text).map(({ text }) => text);

describe('bounded email reply pricing clause recognition', () => {
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
