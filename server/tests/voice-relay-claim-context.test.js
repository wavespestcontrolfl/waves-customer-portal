const { claimContext, clauseIsNegated } = require('../services/eval/voice-relay-spoken-checks')._internals;

test.each([
  ['Before you go, the office will call her.', 'the office will call her', false],
  ['The office will not, under any circumstances, call her.', 'The office will not, under any circumstances, call her', true],
  ["I can't share account details, so the office will call her.", 'the office will call her', false],
  ['The office will call her before noon.', 'The office will call her', false],
])('claim context preserves only the negation governing the assertion: %s', (text, claim, negated) => {
  const start = text.indexOf(claim);
  expect(clauseIsNegated(claimContext(text, start, start + claim.length))).toBe(negated);
});
