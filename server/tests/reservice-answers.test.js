/**
 * Re-service answers (step S2a, GATE_RESERVICE_ASKS): the pure checker for the
 * tech's answer to each thing the customer told us, and the builder of the block
 * that freezes onto the service record. No database.
 */
const {
  validateReserviceAnswers, buildReserviceAsksFreeze, MAX_ANSWERS, MAX_REASON_CHARS, MAX_TEXT_CHARS,
} = require('../services/reservice-answers');

const PRODUCTS = ['prod-a', 'prod-b'];
const check = (items, productIds = PRODUCTS) => validateReserviceAnswers({ items }, { productIds });
const one = (entry) => check([{ itemId: 'booking:1', ...entry }]);

describe('validateReserviceAnswers: the shape', () => {
  test('no field at all is fine and means no answers', () => {
    expect(validateReserviceAnswers(undefined, { productIds: PRODUCTS })).toEqual({ ok: true, answers: [] });
    expect(validateReserviceAnswers(null, { productIds: PRODUCTS })).toEqual({ ok: true, answers: [] });
  });

  test('an empty list is fine', () => {
    expect(check([])).toEqual({ ok: true, answers: [] });
  });

  test.each([
    ['a string', 'treated'],
    ['an array', []],
    ['an object with no items array', { items: 'x' }],
  ])('%s is refused', (_label, raw) => {
    const out = validateReserviceAnswers(raw, { productIds: PRODUCTS });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not readable/);
  });

  test('20 answers pass and 21 are refused', () => {
    const make = (n) => Array.from({ length: n }, (_, i) => ({ itemId: `item-${i}`, answer: 'noted' }));
    expect(check(make(MAX_ANSWERS)).ok).toBe(true);
    const over = check(make(MAX_ANSWERS + 1));
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/Too many answers/);
  });

  test('an entry that is not an object is refused', () => {
    expect(check([null]).ok).toBe(false);
    expect(check(['noted']).ok).toBe(false);
    expect(check([['noted']]).ok).toBe(false);
  });

  test('item ids: required, trimmed, at most 120 characters, unique', () => {
    expect(check([{ answer: 'noted' }]).ok).toBe(false);
    expect(check([{ itemId: '   ', answer: 'noted' }]).ok).toBe(false);
    expect(check([{ itemId: 42, answer: 'noted' }]).ok).toBe(false);
    expect(check([{ itemId: 'x'.repeat(121), answer: 'noted' }]).ok).toBe(false);
    expect(check([{ itemId: 'x'.repeat(120), answer: 'noted' }]).ok).toBe(true);
    const dup = check([{ itemId: 'a', answer: 'noted' }, { itemId: ' a ', answer: 'hidden' }]);
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/more than one answer/);
    expect(check([{ itemId: ' a ', answer: 'noted' }])).toEqual({ ok: true, answers: [{ itemId: 'a', answer: 'noted' }] });
  });

  test('an unknown answer kind is refused', () => {
    expect(one({ answer: 'fixed' }).ok).toBe(false);
    expect(one({}).ok).toBe(false);
    expect(one({ answer: 'TREATED' }).ok).toBe(false);
  });
});

describe('validateReserviceAnswers: each answer kind', () => {
  test.each(['checked_none', 'noted', 'hidden'])('%s needs nothing and drops extra keys', (answer) => {
    const out = one({ answer, productIds: ['prod-a'], reason: 'r', text: 't', other: 1 });
    expect(out).toEqual({ ok: true, answers: [{ itemId: 'booking:1', answer }] });
  });

  describe('treated', () => {
    test('needs a non-empty product list', () => {
      expect(one({ answer: 'treated' }).ok).toBe(false);
      expect(one({ answer: 'treated', productIds: [] }).ok).toBe(false);
      expect(one({ answer: 'treated', productIds: 'prod-a' }).ok).toBe(false);
    });

    test('every id must be on this completion', () => {
      const out = one({ answer: 'treated', productIds: ['prod-a', 'prod-z'] });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/not one of the products on this visit/);
    });

    test('a visit with no products can never carry treated', () => {
      expect(check([{ itemId: 'a', answer: 'treated', productIds: ['prod-a'] }], []).ok).toBe(false);
      expect(validateReserviceAnswers({ items: [{ itemId: 'a', answer: 'treated', productIds: ['prod-a'] }] }).ok).toBe(false);
    });

    test('empty and non-string ids are refused', () => {
      expect(one({ answer: 'treated', productIds: [''] }).ok).toBe(false);
      expect(one({ answer: 'treated', productIds: [null] }).ok).toBe(false);
    });

    test('valid ids pass, trimmed and de-duplicated; a Set of ids works too', () => {
      expect(one({ answer: 'treated', productIds: [' prod-a ', 'prod-b', 'prod-a'], reason: 'ignored' })).toEqual({
        ok: true, answers: [{ itemId: 'booking:1', answer: 'treated', productIds: ['prod-a', 'prod-b'] }],
      });
      expect(check([{ itemId: 'a', answer: 'treated', productIds: ['prod-a'] }], new Set(['prod-a'])).ok).toBe(true);
    });

    test('numeric ids on the completion match the same ids as strings', () => {
      expect(check([{ itemId: 'a', answer: 'treated', productIds: ['7'] }], [7]).ok).toBe(true);
    });

    test('more than 20 ids are refused', () => {
      const ids = Array.from({ length: 21 }, (_, i) => `p${i}`);
      expect(check([{ itemId: 'a', answer: 'treated', productIds: ids }], ids).ok).toBe(false);
    });
  });

  describe('not_today', () => {
    test('needs a reason', () => {
      expect(one({ answer: 'not_today' }).ok).toBe(false);
      expect(one({ answer: 'not_today', reason: '   ' }).ok).toBe(false);
      expect(one({ answer: 'not_today', reason: 7 }).ok).toBe(false);
    });

    test('the reason is trimmed and capped at 160 characters', () => {
      expect(one({ answer: 'not_today', reason: '  Gate was locked  ' }))
        .toEqual({ ok: true, answers: [{ itemId: 'booking:1', answer: 'not_today', reason: 'Gate was locked' }] });
      expect(one({ answer: 'not_today', reason: 'x'.repeat(MAX_REASON_CHARS) }).ok).toBe(true);
      expect(one({ answer: 'not_today', reason: 'x'.repeat(MAX_REASON_CHARS + 1) }).ok).toBe(false);
    });

    test('an office reason may hold a web link or a number: it never reaches the customer', () => {
      expect(one({ answer: 'not_today', reason: 'Called 941 555 0142 and see www.example.invalid' }).ok).toBe(true);
    });
  });

  describe('answered', () => {
    test('needs text', () => {
      expect(one({ answer: 'answered' }).ok).toBe(false);
      expect(one({ answer: 'answered', text: '  ' }).ok).toBe(false);
    });

    test('the text is trimmed and capped at 200 characters', () => {
      expect(one({ answer: 'answered', text: '  We sealed the gap by the garage door.  ' }))
        .toEqual({ ok: true, answers: [{ itemId: 'booking:1', answer: 'answered', text: 'We sealed the gap by the garage door.' }] });
      expect(one({ answer: 'answered', text: 'a'.repeat(MAX_TEXT_CHARS) }).ok).toBe(true);
      expect(one({ answer: 'answered', text: 'a'.repeat(MAX_TEXT_CHARS + 1) }).ok).toBe(false);
    });

    test.each([
      'See https://example.invalid/x for more',
      'See http://example.invalid',
      'Details at www.example.invalid',
      'HTTPS://EXAMPLE.INVALID',
    ])('a web link is refused: %s', (text) => {
      const out = one({ answer: 'answered', text });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/links/);
    });

    test.each([
      'Call us at 941-555-0142',
      'Call (941) 555 0142 today',
      'Text 9415550142',
      '+1 941.555.0142',
      'Dial 555-0142 for the office',
    ])('a phone number is refused: %s', (text) => {
      const out = one({ answer: 'answered', text });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/phone numbers/);
    });

    test('short numbers in ordinary talk pass', () => {
      expect(one({ answer: 'answered', text: 'We treated 3 areas and checked 12 spots.' }).ok).toBe(true);
    });

    test('banned customer wording is refused', () => {
      const out = one({ answer: 'answered', text: 'It is safe to enter after 2 hours, so you may return after 4 PM' });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/cannot go to a customer/);
    });

    // The complete report-copy screen, not the banned-list subset: these pass the subset but must never print.
    test.each([
      'This pesticide is safe.',
      'No signs of an infestation in the garage.',
      'The gate code is 4821.',
    ])('the full report-copy screen refuses: %s', (text) => {
      const out = one({ answer: 'answered', text });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/cannot go to a customer/);
    });
  });

  test('a good batch keeps its order and only its own keys', () => {
    const out = check([
      { itemId: 'booking:1', answer: 'treated', productIds: ['prod-a'], junk: true },
      { itemId: 'call:2', answer: 'noted' },
      { itemId: 'sms:3', answer: 'not_today', reason: 'Dog in yard' },
      { itemId: 'email:4', answer: 'answered', text: 'Done.' },
    ]);
    expect(out).toEqual({ ok: true, answers: [
      { itemId: 'booking:1', answer: 'treated', productIds: ['prod-a'] },
      { itemId: 'call:2', answer: 'noted' },
      { itemId: 'sms:3', answer: 'not_today', reason: 'Dog in yard' },
      { itemId: 'email:4', answer: 'answered', text: 'Done.' },
    ] });
  });

  test('the first bad entry stops the batch', () => {
    expect(check([{ itemId: 'a', answer: 'noted' }, { itemId: 'b', answer: 'bogus' }]).ok).toBe(false);
  });
});

describe('buildReserviceAsksFreeze', () => {
  const gathered = {
    ok: true,
    lane: 'pest',
    window: { from: '2026-10-20T00:00:00.000Z', to: '2026-11-02T12:00:00.000Z' },
    items: [
      { id: 'booking:1', kind: 'booking', text: 'Ants in the kitchen' },
      { id: 'sms:2', kind: 'sms', text: 'Still seeing them' },
      { id: 'call:3', kind: 'call', text: 'Wasps by the door' },
    ],
  };
  const gatheredAt = new Date('2026-11-02T12:00:00.000Z');

  test('freezes the asks, the answers and the office notes apart', () => {
    const { freeze, dropped } = buildReserviceAsksFreeze({
      gathered, gatheredAt,
      answers: [
        { itemId: 'booking:1', answer: 'treated', productIds: ['prod-a'] },
        { itemId: 'sms:2', answer: 'not_today', reason: 'Dog in yard' },
        { itemId: 'call:3', answer: 'answered', text: 'Nest removed.' },
      ],
    });
    expect(dropped).toBe(0);
    expect(freeze).toEqual({
      version: 2,
      gatheredAt: '2026-11-02T12:00:00.000Z',
      lane: 'pest',
      items: gathered.items.map((item) => ({ ...item, printable: true })),
      answers: {
        'booking:1': { answer: 'treated', productIds: ['prod-a'] },
        'sms:2': { answer: 'not_today' },
        'call:3': { answer: 'answered', text: 'Nest removed.' },
      },
      officeNotes: { 'sms:2': 'Dog in yard' },
    });
  });

  test('the office reason never appears in the answers', () => {
    const { freeze } = buildReserviceAsksFreeze({
      gathered, gatheredAt, answers: [{ itemId: 'sms:2', answer: 'not_today', reason: 'Dog in yard' }],
    });
    expect(JSON.stringify(freeze.answers)).not.toMatch(/Dog in yard/);
  });

  test('an id the gather did not return is dropped and counted', () => {
    const { freeze, dropped } = buildReserviceAsksFreeze({
      gathered, gatheredAt,
      answers: [
        { itemId: 'booking:1', answer: 'noted' },
        { itemId: 'sms:999', answer: 'not_today', reason: 'Gone' },
        { itemId: 'ghost', answer: 'hidden' },
      ],
    });
    expect(dropped).toBe(2);
    expect(Object.keys(freeze.answers)).toEqual(['booking:1']);
    expect(freeze.officeNotes).toEqual({});
  });

  test('items with no answer stay in the frozen items', () => {
    const { freeze } = buildReserviceAsksFreeze({ gathered, gatheredAt, answers: [{ itemId: 'booking:1', answer: 'checked_none' }] });
    expect(freeze.items.map((item) => item.id)).toEqual(['booking:1', 'sms:2', 'call:3']);
    expect(freeze.answers).toEqual({ 'booking:1': { answer: 'checked_none' } });
  });

  test('no answers at all still freezes what the customer said', () => {
    const { freeze, dropped } = buildReserviceAsksFreeze({ gathered, gatheredAt, answers: [] });
    expect(dropped).toBe(0);
    expect(freeze).toMatchObject({ version: 2, lane: 'pest', answers: {}, officeNotes: {} });
    expect(freeze.items).toHaveLength(3);
    expect(buildReserviceAsksFreeze({ gathered, gatheredAt }).freeze.answers).toEqual({});
  });

  test('a gather with no items drops every answer', () => {
    const { freeze, dropped } = buildReserviceAsksFreeze({
      gathered: { lane: 'lawn', items: [] }, gatheredAt: '2026-11-02T12:00:00.000Z', answers: [{ itemId: 'a', answer: 'noted' }],
    });
    expect(dropped).toBe(1);
    expect(freeze).toMatchObject({ lane: 'lawn', items: [], answers: {}, gatheredAt: '2026-11-02T12:00:00.000Z' });
  });

  test.each([
    ['Is the spray safe for my cat?', false],
    ['The gate code is 4821, the ants are by the pool', false],
    ['Ants in the kitchen window again', true],
  ])('each item carries the full report-copy verdict: %s', (text, printable) => {
    const { freeze } = buildReserviceAsksFreeze({ gathered: { lane: 'pest', items: [{ id: 'text:9', text }] }, gatheredAt });
    expect(freeze.items).toEqual([{ id: 'text:9', text, printable }]);
  });

  test('the frozen block survives a JSON round trip unchanged', () => {
    const { freeze } = buildReserviceAsksFreeze({ gathered, gatheredAt, answers: [{ itemId: 'booking:1', answer: 'noted' }] });
    expect(JSON.parse(JSON.stringify(freeze))).toEqual(freeze);
  });
});
