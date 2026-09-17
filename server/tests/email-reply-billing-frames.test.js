jest.mock('../services/email/email-reply-price-evidence', () => ({
  recognizeEmailReplyPriceEvidence: jest.fn(jest.requireActual('../services/email/email-reply-price-evidence').recognizeEmailReplyPriceEvidence),
}));
const { recognizeEmailReplyPriceEvidence: upstream } = require('../services/email/email-reply-price-evidence');
const { recognizeEmailReplyBillingFrames: recognize } = require('../services/email/email-reply-billing-frames');
const clause = (text) => recognize(text).clauses[0];
const action = (text, head = 'charge') => clause(text).predicateFrames.find((frame) => frame.predicate.head === head);

beforeEach(() => upstream.mockClear());

describe('inactive shared billing frames', () => {
  test.each(['you', 'them', 'the customer', 'each client', 'our customers', 'your account', 'any customer'])(
    'retains a recognized recipient and original head: %s', (recipient) => {
      const result = clause(`We charge ${recipient} a fee.`);
      const frame = result.predicateFrames.find((entry) => entry.predicate.head === 'charge');
      expect(frame.recipient.text).toBe(recipient);
      expect(frame.object.nominal.head.head).toBe('fee');
      expect(result.phrases).toContain(frame.predicate);
      expect(result.phrases).toContain(frame.recipient);
      expect(result.phrases).toContain(frame.object.nominal.head);
    },
  );

  test.each(['a fee', 'a $98 fee', '$98 charge', 'an invoice $98', '$98',
    'a fee of $98', 'a fee at $98', 'a separate $98 fee', '$98 individual charge'])(
    'retains exact bounded billing objects: %s', (object) => {
      const result = clause(`We charge you ${object} per application.`);
      const frame = result.predicateFrames.find((entry) => entry.predicate.head === 'charge');
      expect(frame.object).not.toBeNull();
      expect(result.tokens[frame.end].kind).toBe('application');
      if (object.includes('$98')) {
        expect(result.amountRelations.map((entry) => entry.amount)).toContain(frame.object.amount);
      }
    },
  );

  test.each(['separately you', 'you separately', 'individually the customer', 'the customer individually'])(
    'retains separation around recipients: %s', (middle) => {
      const frame = action(`We charge ${middle} a fee.`);
      expect(frame.separate).toHaveLength(1);
      expect(frame.recipient).not.toBeNull();
      expect(frame.object.nominal.head.head).toBe('fee');
    },
  );

  test.each(['payment reminder fee', 'invoice status fee', 'payment method fee',
    'invoice details surcharge', 'amount of product fee', 'payment receipt fee'])(
    'retains terminal billing heads in compounds: %s', (compound) => {
      const result = clause(`For each visit, the ${compound} is due.`);
      const frame = result.nominalFrames[0];
      expect(frame.head.head).toBe(compound.endsWith('surcharge') ? 'surcharge' : 'fee');
      expect(result.tokens[frame.end].kind).toBe('be');
    },
  );

  test.each(['payment receipt', 'invoice pdf', 'price quote', 'payment reminder',
    'invoice status', 'amount of product'])(
    'leaves unknown terminal modifiers outside a nominal frame: %s', (compound) => {
      const result = clause(`For each visit, the ${compound} is available.`);
      const frame = result.nominalFrames[0];
      expect(result.tokens[frame.end].kind).toBe('word');
      expect(result.tokens[frame.end].text).toBe(compound.split(' ')[1]);
      expect(recognize(compound).disposition).toBe('needs_review');
    },
  );

  test.each(['its own', 'their own', 'a separate', 'an individual'])(
    'retains nominal separation without consuming unknown objects: %s', (modifier) => {
      const frame = action(`Each visit incurs ${modifier} fee.`, 'incur');
      expect(frame.object.nominal.head.head).toBe('fee');
      expect(frame.object.separate).toHaveLength(1);
      expect(action(`Each visit incurs ${modifier} reminder.`, 'incur').object).toBeNull();
    },
  );

  test.each(['own', 'a own', 'the own'])(
    'leaves unsupported own prefixes unresolved: %s', (modifier) => {
      expect(action(`We charge ${modifier} fee.`).object).toBeNull();
    },
  );

  test.each(['not', 'never'])('retains original progressive negation: %s', (negation) => {
    const frame = action(`Fees were ${negation} being applied per visit.`, 'apply');
    expect(frame.predicate.negated).toBe(true);
    expect(frame.predicate.prefix.map((part) => part.text)).toEqual(['were', negation, 'being']);
    expect(frame.object).toBeNull();
  });

  test.each(['Please pay a visit fee.', 'You pay a visit charge.', 'Please pay a separate visit fee.'])(
    'retains a visit object followed by an explicit fee head: %s', (text) => {
      const result = clause(text);
      const frame = result.predicateFrames.find((entry) => entry.predicate.head === 'pay');
      expect(frame.object.visit).not.toBeNull();
      expect(frame.object.nominal).not.toBeNull();
      expect(result.unitRelations.map((entry) => entry.unit)).toContain(frame.object.visit);
    },
  );

  test.each(['a $98 fee', 'a separate $98 fee', '$98 individual fee'])(
    'retains an amount and fee after a visit object: %s', (object) => {
      const result = clause(`We bill every visit ${object} per application.`);
      const frame = result.predicateFrames.find((entry) => entry.predicate.head === 'bill');
      expect(frame.object.visit).not.toBeNull();
      expect(frame.object.amount.text).toBe('$98');
      expect(frame.object.nominal.head.head).toBe('fee');
      expect(result.tokens[frame.end].kind).toBe('application');
    },
  );

  test.each(['Please pay a visit.', 'Please pay us a quick visit.', 'We pay you a courtesy visit tomorrow.'])(
    'retains the visit idiom without inventing a fee: %s', (text) => {
      expect(action(text, 'pay').object.nominal).toBeNull();
    },
  );

  test.each(['We charge you a the fee.', 'We charge you a an fee.',
    'We charge you a separate individual fee.',
    'We charge attention to access instructions.', 'Each visit generates a report.',
    'Every visit incurs a review step.', 'Your visit has a reminder.'])(
    'does not invent an object from unknown words: %s', (text) => {
      const frames = clause(text).predicateFrames;
      expect(frames).not.toHaveLength(0);
      expect(frames.every((frame) => frame.object === null)).toBe(true);
    },
  );

  test.each([';', '.', '?', '!', ',', ':', '—', '[unknown]'])(
    'does not attach an object across syntax: %s', (boundary) => {
      expect(action(`We charge ${boundary} a fee.`).object).toBeNull();
    },
  );

  test('bounds compound scanning and respects action/participant boundaries', () => {
    const long = clause('Payment one two three four five six seven fee.').nominalFrames[0];
    expect(long.head.head).toBe('payment');
    expect(clause('Payment and fee.').nominalFrames[0].head.head).toBe('payment');
    expect(clause('Payment applies fee.').nominalFrames[0].head.head).toBe('payment');
    expect(clause('Payment you charge.').nominalFrames[0].head.head).toBe('payment');
  });

  test('calls upstream once and preserves all evidence references', () => {
    const result = recognize('We charge you $98 per visit.');
    expect(upstream).toHaveBeenCalledTimes(1);
    const before = upstream.mock.results[0].value;
    for (const [key, value] of Object.entries(before.clauses[0])) expect(result.clauses[0][key]).toBe(value);
    expect(result.disposition).toBe('needs_review');
    expect(result).not.toHaveProperty('violations');
  });

  test.each([{}, 'x'.repeat(8193), 'x '.repeat(513)])('forwards scan failures by identity', (text) => {
    const result = recognize(text);
    expect(result.ok).toBe(false);
    expect(result).toBe(upstream.mock.results[0].value);
  });

  test.each(['', 'unknown wording', 'We bill per application.'])('never grants approval: %s', (text) => {
    expect(recognize(text).disposition).toBe('needs_review');
  });
});
