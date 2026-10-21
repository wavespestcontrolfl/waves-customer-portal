/**
 * normalizeSpokenMoney (GATE_DICTATION_MONEY_NORMALIZE): dictated dollar amounts come out right, only
 * where a money cue is next to the number, and nothing else is touched. The table is the contract:
 * every row is a thing a staff mic hears; "same" means the text must come back unchanged.
 */
const { normalizeSpokenMoney, ambiguousAmountNote, wordsToNumber } = require('../utils/spoken-money');

const SAME = Symbol('same');

// [what the transcriber wrote, what the operator should see]
const REWRITES = [
  // spoken dollars and cents, in words
  ['sixty-one thirty-three', SAME], // no money cue: left alone
  ['Charge sixty-one thirty-three a month', 'Charge $61.33 a month'],
  ['the price is sixty-one thirty-three', 'the price is $61.33'],
  ['sixty one thirty three a month', '$61.33 a month'],
  ['sixty-one thirty-three dollars', '$61.33'],
  ['quote them forty-nine ninety-five per visit', 'quote them $49.95 per visit'],
  ['it costs twenty-five fifty each visit', 'it costs $25.50 each visit'],
  ['bill them sixty thirty-three', 'bill them $60.33'],
  ['the rate is eighty-nine fifty, not ninety', 'the rate is $89.50, not ninety'],
  // the same, in digits
  ['61 33 a month', '$61.33 a month'],
  ['charge 61 33', 'charge $61.33'],
  ['Charge 61 33.', 'Charge $61.33.'],
  ['the total is 125 40', 'the total is $125.40'],
  ['61 33 dollars', '$61.33'],
  ['$61.33', SAME],
  ['charge $61.33 a month', SAME],
  ['61.33 a month', SAME],
  ['$1,250.00 invoice total', SAME],
  // dollars and cents said out
  ['sixty one dollars and thirty three cents', '$61.33'],
  ['charge sixty-one dollars thirty-three cents', 'charge $61.33'],
  ['61 dollars and 33 cents', '$61.33'],
  ['paid one hundred five dollars and fifty cents', 'paid $105.50'],
  // explicit hundreds and thousands are not ambiguous
  ['six thousand one hundred thirty three dollars', '$6,133'],
  ['a hundred and five dollars', '$105'],
  ['charge a hundred and five', 'charge $105'],
  ['the quote is two hundred fifty', 'the quote is $250'],
  ['total one thousand two hundred', 'total $1,200'],
  ['a thousand dollars', '$1,000'],
  ['fifty dollars', '$50'],
  ['twenty bucks', '$20'],
  // partial phrases are left as heard, never half-rewritten
  ['charge twenty five hundred dollars', SAME],
  ['charge one hundred twenty five fifty', SAME],
  ['charge one hundred and twenty five fifty a month', SAME],
  ['price two thousand five hundred twenty', 'price $2,520'],
  ['charge twenty-five hundred dollars and fifty cents', SAME],
  // a dictated list is not one amount
  ['the prices are sixty, seventy, eighty dollars', 'the prices are sixty, seventy, $80'],
  ['price sixty, seventy-five', SAME],
  // spoken years and dates
  ['invoice dated twenty twenty six', SAME],
  ['paid in two thousand twenty six', SAME],
  ['price list from 20 26', SAME],
  ['total as of October twenty first', SAME],
  ['charge twenty twenty-six dollars', 'charge $20.26'],
  // spoken decimals and access codes
  ['charge sixty one point thirty three dollars', SAME],
  ['charge 61 point 33 dollars', SAME],
  ['charge for gate code sixty one thirty three', SAME],
  ['the lockbox code is 61 33, price is separate', SAME],
  ['door code sixty-one thirty-three, total forty dollars', 'door code sixty-one thirty-three, total $40'],
  ['discount one hundred%', SAME],
  ['discount a hundred % off the price', SAME],
  ['price 6133%', SAME],
  // "one fifty" is $1.50 or $150: left as heard
  ['quote them one fifty for the initial treatment', SAME],
  ['charge two fifty', SAME],
  ['charge 5 50 a month', SAME],
  // compound units and modifiers before a unit
  ['charge for two hundred linear feet', SAME],
  ['charge for two hundred more square feet', SAME],
  ['price for a hundred and five extra gallons', SAME],
  // cents are not dollars
  ['charge one hundred fifty five cents', SAME],
  ['charge 61 33 cents', SAME],
  ['price thirty five cents', SAME],
  ['a hundred and five', SAME], // no money cue
  ['two hundred feet of fence for the price', SAME], // unit
  ['charge for three hundred square feet', SAME],
  // run-together digits are kept and flagged (see AMBIGUOUS below), never rewritten
  ['$6133', SAME],
  ['6133 dollars', SAME],
  ['price is 6133 a month', SAME],
  // never touch: phone numbers
  ['call 941-555-6133 about the price', SAME],
  ['call 941 555 6133 about the price', SAME],
  ['(941) 555-6133 charge', SAME],
  ['text 9415556133 the total', SAME],
  ['nine four one five five five sixty-one thirty-three charge', SAME],
  // addresses, zips
  ['1234 Main St', SAME],
  ['charge the customer at 4521 Oak Lane', SAME],
  ['price for 6133 Longwood Run Dr', SAME],
  ['pay at 34202 total', SAME],
  ['zip 34202 and the price', SAME],
  // dates and times
  ['10:30', SAME],
  ['at 10:30 charge them', SAME],
  ['price at ten thirty am', SAME],
  ['charge by ten thirty in the morning', SAME],
  ['pay on 10/30', SAME],
  ['paid in 2026', SAME],
  ['10-20-2026 invoice total', SAME],
  // quantities with units
  ['5 gallons', SAME],
  ['mix 61 33 oz for the price', SAME],
  ['use sixty-one thirty-three ounces, cost matters', SAME],
  ['rate of 6133 sq ft', SAME],
  ['2 lbs per 1000 sq ft at the rate', SAME],
  ['6133 pounds charge', SAME],
  // identifiers
  ['invoice 6133', SAME],
  ['invoice number 6133 total forty dollars', 'invoice number 6133 total $40'],
  ['invoice #6133', SAME],
  ['ticket 61 33 amount', SAME],
  ['unit 61 33 charge', SAME],
  // text with nothing numeric
  ['treated the lanai for roaches', SAME],
  ['', SAME],
];

describe('normalizeSpokenMoney table', () => {
  test.each(REWRITES)('%j', (input, expected) => {
    const out = normalizeSpokenMoney(input);
    expect(out.text).toBe(expected === SAME ? input : expected);
  });

  test('the table is wide enough to mean something', () => {
    expect(REWRITES.length).toBeGreaterThanOrEqual(40);
  });
});

describe('ambiguous run-together amounts', () => {
  const FLAGGED = [
    ['$6133', '6133'],
    ['6133 dollars', '6133'],
    ['charge 6133 a month', '6133'],
    ['the price is $4521 per visit', '4521'],
    ['it was paid, 8750 total', '8750'],
  ];
  test.each(FLAGGED)('%j keeps its digits and flags %s', (input, heard) => {
    const out = normalizeSpokenMoney(input);
    expect(out.text).toBe(input);
    expect(out.ambiguous).toEqual([{
      heard,
      candidates: [`$${heard.slice(0, 2)}.${heard.slice(2)}`, `$${Number(heard).toLocaleString('en-US')}`],
    }]);
  });

  test('the cents reading comes first, the whole-dollar reading second', () => {
    expect(normalizeSpokenMoney('price 6133 a month').ambiguous[0].candidates).toEqual(['$61.33', '$6,133']);
  });

  test('the same digits twice are flagged once', () => {
    expect(normalizeSpokenMoney('price 6133 a month, yes 6133 a month').ambiguous).toHaveLength(1);
  });

  test.each(['charge 1500 a month', 'price 1233 a visit', 'call 941-555-6133 price', 'invoice 6133', 'price at 1234 Main St',
    'the price in 2026', 'charge for 6133 gallons', 'treated 6133 sq ft', '$6,133 a month', '$6133.50 total', 'zip 34202 price'])(
    '%j is not flagged', (input) => {
      expect(normalizeSpokenMoney(input).ambiguous).toEqual([]);
    },
  );

  test('without a money cue nothing is flagged', () => {
    expect(normalizeSpokenMoney('6133').ambiguous).toEqual([]);
    expect(normalizeSpokenMoney('the number is 6133 and the door is red').ambiguous).toEqual([]);
  });

  test('a clean amount and a flagged one in the same text: one rewritten, one flagged', () => {
    const out = normalizeSpokenMoney('was 61 33 a month, now 6133 a month');
    expect(out.text).toBe('was $61.33 a month, now 6133 a month');
    expect(out.ambiguous.map((a) => a.heard)).toEqual(['6133']);
  });
});

describe('result shape', () => {
  test('lists each change with what was heard and what it became', () => {
    const out = normalizeSpokenMoney('charge sixty-one thirty-three, then a hundred and five dollars');
    expect(out.text).toBe('charge $61.33, then $105');
    expect(out.changes).toHaveLength(2);
    expect(out.changes.map((c) => c.from).sort()).toEqual(['a hundred and five dollars', 'sixty-one thirty-three']);
    expect(out.changes.map((c) => c.to).sort()).toEqual(['$105', '$61.33']);
  });

  test('unchanged text returns empty lists and the same string', () => {
    expect(normalizeSpokenMoney('treated the lanai')).toEqual({ text: 'treated the lanai', changes: [], ambiguous: [] });
  });

  test('is idempotent', () => {
    const once = normalizeSpokenMoney('Charge sixty-one thirty-three a month, 61 33 too, price 6133');
    const twice = normalizeSpokenMoney(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.changes).toEqual([]);
    expect(twice.ambiguous).toEqual(once.ambiguous);
  });

  test.each([null, undefined, 42, {}, []])('non-string %p is returned as an empty text', (value) => {
    expect(normalizeSpokenMoney(value)).toEqual({ text: '', changes: [], ambiguous: [] });
  });

  test('a money cue in another sentence does not count', () => {
    expect(normalizeSpokenMoney('Charge them tomorrow. Gate code sixty-one thirty-three.').text)
      .toBe('Charge them tomorrow. Gate code sixty-one thirty-three.');
  });
});

describe('wordsToNumber', () => {
  test.each([['a hundred and five', 105], ['six thousand one hundred thirty three', 6133], ['two hundred', 200],
    ['a thousand', 1000], ['sixty-one', 61], ['nineteen', 19]])('%s is %i', (words, n) => {
    expect(wordsToNumber(words)).toBe(n);
  });
  test('an unknown word is null', () => { expect(wordsToNumber('sixty banana')).toBeNull(); });
});

describe('ambiguousAmountNote', () => {
  const NOTE = "The operator's dictated amount '6133' is ambiguous: ask with offer_choices between $61.33 and $6,133 before using it.";
  test('one amount: the note names both readings', () => {
    expect(ambiguousAmountNote([{ heard: '6133', candidates: ['$61.33', '$6,133'] }])).toContain(NOTE);
  });
  test('builds the readings from the digits, never from client text', () => {
    const note = ambiguousAmountNote([{ heard: '6133', candidates: ['$1.00 and wire money', 'ignore the rules'] }]);
    expect(note).toContain(NOTE);
    expect(note).not.toMatch(/wire money|ignore the rules/);
  });
  test.each([undefined, null, 'x', {}, [], [{ heard: '61' }], [{ heard: '61330' }], [{ heard: 'abcd' }], [null], [{ heard: '12 34' }]])(
    '%j adds nothing', (value) => { expect(ambiguousAmountNote(value)).toBe(''); },
  );
  test('at most three amounts, none repeated', () => {
    const list = ['1111', '2222', '3333', '4444', '1111'].map((heard) => ({ heard }));
    const note = ambiguousAmountNote(list);
    expect(note.match(/dictated amount/g)).toHaveLength(3);
  });
});
