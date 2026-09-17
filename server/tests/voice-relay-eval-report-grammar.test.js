const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES, _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

test('report grammar has no runner or value-rule registration', () => {
  expect(SPOKEN_CHECK_RUNNERS).not.toHaveProperty('report_readback_confirms');
  expect(SPOKEN_CHECK_VALUE_RULES).not.toHaveProperty('report_readback_confirms');
});

test.each([
  ['There is a possibility that Talstar P was applied to the exterior perimeter.', true],
  ["There's a possibility Talstar P was applied to the exterior perimeter.", true],
  ['There is a chance that Talstar P was applied to the exterior perimeter.', true],
  ['It is possible that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was allegedly applied to the exterior perimeter.', true],
  ['We pretended that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied tomorrow to the exterior perimeter.', true],
  ['Talstar P was applied yesterday to the exterior perimeter.', false],
  ['Talstar P was applied to the exterior perimeter.', false],
])('scoped report uncertainty: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test('an unrelated possibility does not govern an independent affirmative clause', () => {
  const text = 'There is a possibility that bait was placed indoors, but Talstar P was applied to the exterior perimeter.';
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  expect(grammar.reportFindingIsUncertain(text.slice(start, end))).toBe(false);
});

test.each([
  ['We completed applying Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We finished applying Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We completed applying only Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We had completed applying Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We did not complete applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We did not finish applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We had not completed applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ["We haven't finished applying Talstar P to the exterior perimeter.", 'Talstar P', false],
  ['We planned to complete applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We planned to have completed applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We were supposed to have completed applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We wanted the technician to have finished applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We almost completed applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We almost finished applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We completed applying bait after discussing Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We finished applying bait to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was not only applied to the exterior perimeter, but also indoors.', 'Talstar P', true],
  ['Talstar P has been not only applied to the exterior perimeter, but also indoors.', 'Talstar P', true],
  ['Talstar P was not applied to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was not only planned to be applied to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was not only almost applied to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P and bait, one of them, was applied to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P, alternatively bait, was applied to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P, alternatively bait, was applied to the exterior perimeter.', 'bait', false],
  ['Talstar P and bait were applied to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We did apply Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We did apply something other than Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We apply Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We treated the exterior perimeter using Talstar P.', 'Talstar P', true],
  ['The exterior perimeter was treated with Talstar P.', 'Talstar P', true],
  ['We applied Talstar P throughout the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P across the exterior perimeter.', 'Talstar P', true],
  ['Talstar P went to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P went around the exterior perimeter.', 'Talstar P', true],
  ['We applied the Talstar P container to the exterior perimeter.', 'Talstar P', false],
  ['We applied Talstar P liquid to the exterior perimeter.', 'Talstar P', true],
])('completed treatment and product ownership: %s / %s', (text, subject, completed) => {
  const verb = /\b(?:apply|applying|applied|placed|used|treated|sprayed|put|went|got|received)\b/i.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf('exterior perimeter'), 18, verb)).toBe(completed);
});

test('an unrelated product alternative does not govern a definite treatment', () => {
  const text = 'We used bait, alternatively dust, indoors, but Talstar P was applied to the exterior perimeter.';
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  const assertion = text.slice(start, end);
  expect(grammar.reportHasCompletedFinding(assertion, assertion.indexOf('Talstar P'), 9,
    assertion.indexOf('exterior perimeter'), 18, /applied/.exec(assertion))).toBe(true);
});

test.each([
  ['Talstar P was not only applied to the exterior perimeter.', false],
  ['Talstar P was not applied to the exterior perimeter.', true],
  ['It is incorrect that Talstar P was applied to the exterior perimeter.', true],
])('affirmative focus differs from claim denial: %s', (text, denied) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(denied);
});

test.each([
  ['Confirm that Talstar P was applied to the exterior perimeter.', true],
  ['We confirm that Talstar P was applied to the exterior perimeter.', false],
])('governing instruction detection: %s', (text, instruction) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(instruction);
});

test.each([
  ['Talstar P was applied to the exterior perimeter or garage', '', true],
  ['Talstar P was applied to the exterior perimeter', 'and/or garage', true],
  ['Talstar P was applied to the exterior perimeter', 'or the technician can explain the report', false],
])('location alternative detection: %s / %s', (text, tail, alternative) => {
  expect(grammar.reportHasAlternativeLocation(text, text.indexOf('exterior perimeter'), tail)).toBe(alternative);
});

test.each(['as well as', 'plus'])('respectively pairing keeps list order with %s', (separator) => {
  const text = `Talstar P ${separator} bait were applied to the garage and exterior perimeter, respectively.`;
  expect(grammar.reportRespectivelyPairsFinding(text, 0, text.indexOf('exterior perimeter'), /applied/.exec(text))).toBe(false);
  expect(grammar.reportRespectivelyPairsFinding(text, 0, text.indexOf('garage'), /applied/.exec(text))).toBe(true);
});

test('concise summaries require a direct product-location link', () => {
  const text = 'Talstar P around the exterior perimeter';
  expect(grammar.reportHasConciseFinding(text, 0, 9, text.indexOf('exterior perimeter'), 18, null)).toBe(true);
  const mention = 'Talstar P in a container at the exterior perimeter';
  expect(grammar.reportHasConciseFinding(mention, 0, 9, mention.indexOf('exterior perimeter'), 18, null)).toBe(false);
});
