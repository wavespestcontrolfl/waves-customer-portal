jest.mock('../services/email/email-reply-billing-frames', () => ({
  recognizeEmailReplyBillingFrames: jest.fn(jest.requireActual('../services/email/email-reply-billing-frames').recognizeEmailReplyBillingFrames),
}));
const { recognizeEmailReplyBillingFrames: upstream } = require('../services/email/email-reply-billing-frames');
const { recognizeEmailReplyBillingRelations: recognize } = require('../services/email/email-reply-billing-relations');
const clause = (text) => recognize(text).clauses[0];
const edges = (text, head) => clause(text).billingRelations.flatMap((record) => record.candidates
  .filter((edge) => (edge.frame.head?.head ?? edge.frame.predicate.head) === head));

beforeEach(() => upstream.mockClear());

describe('inactive shared billing relationships', () => {
  test.each(['The fee is per visit.', 'The fee will be per visit.', 'The fee may not be per visit.',
    'The fee is due per visit.', 'The fee is required per visit.', 'The fee is payable per visit.',
    'The fee does apply per visit.', 'The fee was being applied per visit.',
    'The fee: — per visit.', 'The fee is: (per visit).', 'The fee is $98 per visit.'])(
    'links finite nominal complements: %s', (text) => {
      expect(edges(text, 'fee').some((edge) => edge.relation === 'frame_unit')).toBe(true);
    },
  );
  test.each(['The fee was not being applied per visit.', 'The fee may never apply per visit.',
    'The fee is not per visit.', 'The fee: not per visit.', 'The fee is (not per visit).'])(
    'retains negated connectors: %s', (text) => {
      expect(edges(text, 'fee').some((edge) => edge.connector.negated)).toBe(true);
    },
  );
  test.each(['Per visit, the fee is due.', 'For each visit, a fee applies.',
    'Each visit, our fee is payable.', "Each visit's fee applies.", "All visits' fee applies."])(
    'links fronted and possessive nouns: %s', (text) => {
      expect(edges(text, 'fee').some((edge) => edge.relation === 'unit_frame')).toBe(true);
    },
  );
  test.each(['Each visit incurs a fee.', 'Each visit, we incur a fee.',
    'Every visit, the customer incurs a fee.', 'For each visit, customers incur a fee.'])(
    'links original predicate frames after units: %s', (text) => {
      expect(edges(text, 'incur').some((edge) => edge.relation === 'unit_frame')).toBe(true);
    },
  );
  test.each(['We charge you per visit.', 'We charge you a fee per visit.',
    'We charge each visit a fee.', 'Please pay a visit fee.'])(
    'links trailing or object visit units: %s', (text) => {
      const result = clause(text);
      expect(result.billingRelations.some((record) => record.candidates.some((edge) => (
        edge.frameType === 'predicate' && ['frame_unit', 'frame_object'].includes(edge.relation)
      )))).toBe(true);
    },
  );
  test.each(['and', 'or'])('retains both coordinated units with %s', (join) => {
    const result = clause(`Each visit incurs a fee per application ${join} per visit.`);
    const [front, application, visit] = result.billingRelations;
    expect(front.candidates.some((edge) => edge.relation === 'unit_frame')).toBe(true);
    const edge = visit.candidates.find((entry) => entry.frameType === 'predicate');
    expect(edge.via).toBe(application.unit);
    expect(edge.frame).toBe(application.candidates.find((entry) => entry.frameType === 'predicate').frame);
    expect(edge.end).toBe(visit.unit.end);
  });
  test.each([['', false], ['not', true], ['never', true], ['not more than', false], ['no more than', false]])(
    'retains amount bridge polarity for %s', (prefix, negated) => {
      const result = clause(`The fee is ${prefix} $98 per application and per visit.`);
      const direct = result.billingRelations[0].candidates.find((edge) => edge.amountRelation);
      expect(direct.connector.negated).toBe(negated);
      expect(result.amountRelations[0].candidates).toContain(direct.amountRelation);
      const coordinated = result.billingRelations[1].candidates.find((edge) => edge.amountRelation);
      expect(coordinated.amountRelation).toBe(direct.amountRelation);
      expect(coordinated.connector.negated).toBe(negated);
    },
  );
  test('represents the supported billing frequency construction explicitly', () => {
    const result = clause('The billing frequency is per visit.');
    const edge = result.billingRelations[0].candidates.find((item) => item.frameType === 'nominal');
    expect(edge.frame.frequency.token).toBe(result.tokens[edge.frame.frequency.start]);
    expect(edge.frame.frequency.token.text).toBe('frequency');
    expect(edge.connector.start).toBe(edge.frame.frequency.end);
  });
  test('preserves connector negation through coordination', () => {
    const result = clause('The fee is not per application and per visit.');
    expect(result.billingRelations[1].candidates.find((edge) => edge.frameType === 'nominal').connector.negated).toBe(true);
  });
  test.each(['and unknown per visit', 'and visits are scheduled', '; per visit',
    'after service per visit', ', per visit'])(
    'does not invent unsupported coordination: %s', (tail) => {
      const result = clause(`The fee is per application ${tail}.`);
      expect(result.billingRelations.every((record) => record.candidates.every((edge) => edge.via === null))).toBe(true);
    },
  );
  test.each(['The fee will per visit.', 'The fee may not per visit.', 'The fee frequency per visit.',
    'The fee is pending per visit.', 'The fee is is per visit.',
    'The fee is (per visit.', 'The fee is ((per visit).', 'The fee is ) per visit.', 'The fee: : : : per visit.',
    'The fee to your account per visit.', 'The fee was refunded — each visit remains included.'])(
    'does not skip unsupported trailing connectors: %s', (text) => {
      expect(edges(text, 'fee')).toHaveLength(0);
    },
  );
  test.each(['For each visit, we send a fee.', 'For each visit, unknown fee applies.',
    'For each visit: the fee is due.'])(
    'does not skip unknown fronted syntax: %s', (text) => {
      expect(edges(text, 'fee')).toHaveLength(0);
    },
  );
  test('operational nominal tails remain unresolved', () => {
    expect(edges('Payment receipt is available per visit.', 'payment')).toHaveLength(0);
    // The fronted lexical edge exists, but its frame stops before the unknown tail.
    const result = clause('For each visit, the payment receipt is available.');
    const edge = result.billingRelations[0].candidates[0];
    expect(result.tokens[edge.frame.end].text).toBe('receipt');
    expect(recognize('For each visit, the payment receipt is available.').disposition).toBe('needs_review');
  });
  test('retains original evidence and frame identities with one upstream call', () => {
    const result = recognize('We charge you a fee per application and per visit.');
    const before = upstream.mock.results[0].value;
    expect(upstream).toHaveBeenCalledTimes(1);
    for (const [key, value] of Object.entries(before.clauses[0])) expect(result.clauses[0][key]).toBe(value);
    const item = result.clauses[0];
    expect(item.billingRelations[0].unit).toBe(item.unitRelations[0].unit);
    for (const record of item.billingRelations) {
      for (const edge of record.candidates) expect([...item.nominalFrames, ...item.predicateFrames]).toContain(edge.frame);
    }
    expect(result.disposition).toBe('needs_review');
    expect(result).not.toHaveProperty('violations');
  });
  test.each([{}, 'x'.repeat(8193), 'x '.repeat(513)])('forwards scanner failures by identity', (text) => {
    expect(recognize(text)).toBe(upstream.mock.results[0].value);
  });
});
