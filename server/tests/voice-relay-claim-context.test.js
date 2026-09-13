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

test.each([
  ['If the report is correct, Talstar P was applied to the exterior perimeter.', 'Talstar P was applied', true],
  ['If eligible, then your refund was processed.', 'your refund was processed', true],
  ['Unless the report is wrong, Talstar P was applied to the exterior perimeter.', 'Talstar P was applied', true],
  ['If the report is correct, Talstar P and bait were applied.', 'bait were applied', true],
  ["I can't confirm Talstar P or bait was applied.", 'bait was applied', true],
  ['Before leaving, Talstar P was applied to the exterior perimeter.', 'Talstar P was applied', false],
])('governing conditions survive an introductory comma: %s', (text, claim, negated) => {
  const start = text.indexOf(claim);
  expect(clauseIsNegated(claimContext(text, start, text.length))).toBe(negated);
});

test('an introductory epistemic refusal remains attached to its assertion', () => {
  const { clauseIsEpistemicallyHedged } = require('../services/eval/voice-relay-spoken-checks')._internals;
  const text = "I can't confirm this, Talstar P was applied to the exterior perimeter.";
  expect(clauseIsEpistemicallyHedged(claimContext(text, text.indexOf('Talstar'), text.length))).toBe(true);
});

test('a longer epistemic refusal before a comma retains its complement', () => {
  const { clauseIsEpistemicallyHedged } = require('../services/eval/voice-relay-spoken-checks')._internals;
  const text = 'I do not have enough information to confirm this, Talstar P was applied';
  expect(clauseIsEpistemicallyHedged(claimContext(text, text.indexOf('Talstar'), text.length))).toBe(true);
});

test('a refusal with its own object does not govern the assertion after a comma', () => {
  const { clauseIsEpistemicallyHedged } = require('../services/eval/voice-relay-spoken-checks')._internals;
  const text = "I can't confirm the appointment, Talstar P was applied";
  expect(clauseIsEpistemicallyHedged(claimContext(text, text.indexOf('Talstar'), text.length))).toBe(false);
});
