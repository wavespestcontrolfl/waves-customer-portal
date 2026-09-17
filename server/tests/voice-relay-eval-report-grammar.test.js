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
  ['It is likely that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was likely applied to the exterior perimeter.', true],
  ['Talstar P likely was applied to the exterior perimeter.', true],
  ['Talstar P has likely been applied to the exterior perimeter.', true],
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
  ['We used Talstar P and drove to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and then drove to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and quickly walked to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and then quickly returned to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and walked to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and went to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and returned to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and moved to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and sat at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and stood at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and met the technician at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and took equipment to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and sent the technician to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and then sat at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and saw ants at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and heard noises at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and bought equipment at the exterior perimeter.', 'Talstar P', false],
  ['We applied Talstar P and freshly mixed bait to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P and suspend polyzone to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and sprayed the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and applied bait to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and bait to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P and granular bait to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P and Suspend PolyZone to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P, bait, and dust to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P to the garage and exterior perimeter.', 'Talstar P', true],
  ['At the exterior perimeter, Talstar P was applied indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied only indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied primarily indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied yesterday only indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied at 9 AM indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied at 9 AM only indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied at 9 AM.', 'Talstar P', true],
  ['At the exterior perimeter, Talstar P was applied at 9 AM in the garage.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied on Monday inside the garage.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied at 9 AM with a backpack sprayer stored indoors.', 'Talstar P', true],
  ['At the exterior perimeter, Talstar P was applied outdoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied inside.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied outside.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied yesterday indoors.', 'Talstar P', false],
  ['At the exterior perimeter, Talstar P was applied on Monday.', 'Talstar P', true],
  ['At the exterior perimeter, Talstar P was applied yesterday.', 'Talstar P', true],
  ['At the exterior perimeter, the technician applied Talstar P with a backpack sprayer.', 'Talstar P', true],
  ['At the exterior perimeter, the technician applied Talstar P with a backpack sprayer stored indoors.', 'Talstar P', true],
  ['At the exterior perimeter, Talstar P was applied to the garage.', 'Talstar P', false],
  ['We applied diluted Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied liquid Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied freshly mixed Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied only the diluted Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied bait while mixing Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We applied a container of diluted Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was used with equipment stored at the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was used for ants found at the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was applied with a backpack sprayer at the exterior perimeter.', 'Talstar P', true],
  ['We attempted to have applied Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We tried to have applied Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We hoped to have applied Talstar P to the exterior perimeter.', 'Talstar P', false],
])('completed treatment and product ownership: %s / %s', (text, subject, completed) => {
  const verb = /\b(?:apply|applying|applied|placed|placing|used|using|treated|treating|sprayed|spraying|put|went|got|received)\b/i.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf('exterior perimeter'), 18, verb)).toBe(completed);
});

test.each(['spraying', 'treating', 'placing', 'using'])('completed %s retains governor and product scope', (action) => {
  for (const [prefix, completed] of [['We finished', true], ['We completed', true], ['We were supposed to have finished', false], ['We almost finished', false], ['We did not finish', false], ['We tried to have finished', false], ['We are', false]]) {
    const text = `${prefix} ${action} Talstar P to the exterior perimeter.`;
    expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
      text.indexOf('exterior perimeter'), 18, new RegExp(action).exec(text))).toBe(completed);
  }
  const text = `We finished ${action} bait after discussing Talstar P to the exterior perimeter.`;
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, new RegExp(action).exec(text))).toBe(false);
});

test.each(['inside', 'within'])('%s introduces a named treatment target', (link) => {
  const text = `We applied Talstar P ${link} the garage.`;
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('garage'), 6, /applied/.exec(text))).toBe(true);
  const unrelated = `We applied Talstar P with equipment stored ${link} the garage.`;
  expect(grammar.reportHasCompletedFinding(unrelated, unrelated.indexOf('Talstar P'), 9,
    unrelated.indexOf('garage'), 6, /applied/.exec(unrelated))).toBe(false);
});

test('an unrelated product alternative does not govern a definite treatment', () => {
  const text = 'We used bait, alternatively dust, indoors, but Talstar P was applied to the exterior perimeter.';
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  const assertion = text.slice(start, end);
  expect(grammar.reportHasCompletedFinding(assertion, assertion.indexOf('Talstar P'), 9,
    assertion.indexOf('exterior perimeter'), 18, /applied/.exec(assertion))).toBe(true);
});

test.each([['Talstar P', 'exterior perimeter', true], ['Talstar P', 'garage', false], ['bait', 'garage', true], ['bait', 'exterior perimeter', false]])('active respectively pairs %s with %s', (subject, location, completed) => {
  const text = 'We applied Talstar P and bait to the exterior perimeter and garage, respectively.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf(location), location.length, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['Talstar P was not only applied to the exterior perimeter.', false],
  ['Talstar P was not applied to the exterior perimeter.', true],
  ['It is incorrect that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied without issue to the exterior perimeter.', false],
  ['Talstar P was applied without delay to the exterior perimeter.', false],
  ['Talstar P was applied without interruption to the exterior perimeter.', false],
  ['Talstar P was not applied without issue to the exterior perimeter.', true],
  ['We left without applying Talstar P to the exterior perimeter.', true],
])('affirmative focus differs from claim denial: %s', (text, denied) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(denied);
});

test.each([
  ['Confirm that Talstar P was applied to the exterior perimeter.', true],
  ['Okay, confirm that Talstar P was applied to the exterior perimeter.', true],
  ['Okay, verify that Talstar P was applied to the exterior perimeter.', true],
  ['Okay, check that Talstar P was applied to the exterior perimeter.', true],
  ['Okay, tell me whether Talstar P was applied to the exterior perimeter.', true],
  ['  Confirm that Talstar P was applied to the exterior perimeter.', true],
  ['Check the invoice, Talstar P was applied to the exterior perimeter.', false],
  ['Okay, we confirm that Talstar P was applied to the exterior perimeter.', false],
  ['Please confirm that bait, Talstar P, and dust were applied to the exterior perimeter.', true],
  ['Confirm that bait, Talstar P were applied to the exterior perimeter.', true],
  ['Please confirm that, Talstar P was applied to the exterior perimeter.', true],
  ['We confirm that bait, Talstar P, and dust were applied to the exterior perimeter.', false],
  ['Confirm that the invoice is paid, Talstar P was applied to the exterior perimeter.', false],
  ['We confirm that Talstar P was applied to the exterior perimeter.', false],
])('governing instruction detection: %s', (text, instruction) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(instruction);
});

test('unrelated likelihood remains outside a definite finding clause', () => {
  const text = 'Bait was likely placed indoors, but Talstar P was applied to the exterior perimeter.';
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  expect(grammar.reportFindingIsUncertain(text.slice(start, end))).toBe(false);
});

test('a later instruction is outside the treatment evidence span', () => {
  const text = 'Talstar P was applied to the exterior perimeter, confirm the invoice.';
  expect(grammar.reportFindingIsInstruction(text, 0, text.indexOf('exterior perimeter'),
    /applied/.exec(text), text.indexOf(','))).toBe(false);
});

test('coordinated products preserve their respective treatment location', () => {
  const text = 'We applied Talstar P and bait to the exterior perimeter and garage, respectively.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(true);
});

test.each([
  ['Talstar P was applied to the exterior perimeter or garage', '', true],
  ['Talstar P was applied to the exterior perimeter', 'and/or garage', true],
  ['Talstar P was applied to the exterior perimeter', 'or the technician can explain the report', false],
  ['Talstar P was applied to the exterior perimeter before or after lunch', '', false],
  ['Talstar P was applied to the exterior perimeter before', 'or after lunch', false],
  ['Talstar P was applied to the exterior perimeter with either a backpack or a hand sprayer', '', false],
  ['Talstar P was applied to the exterior perimeter at 9 AM or 10 AM', '', false],
  ['Talstar P was applied to the exterior perimeter or the foundation before lunch', '', true],
  ['We treated the exterior perimeter using Talstar P or bait.', '', true],
  ['The exterior perimeter was treated with Talstar P or bait.', '', true],
  ['We treated the exterior perimeter using either a backpack or a hand sprayer.', '', false],
  ['The exterior perimeter was treated with either a backpack or a hand sprayer.', '', false],
  ['We treated the exterior perimeter using Talstar P', 'or the technician can explain', false],
  ['The exterior perimeter was treated with Talstar P', 'or the office can explain', false],
])('location alternative detection: %s / %s', (text, tail, alternative) => {
  expect(grammar.reportHasAlternativeLocation(text, text.indexOf('exterior perimeter'), tail)).toBe(alternative);
});

test.each([
  ['around', 'along', 'Talstar P', 'exterior perimeter', true], ['around', 'along', 'Talstar P', 'garage', false],
  ['around', 'along', 'bait', 'garage', true], ['around', 'along', 'bait', 'exterior perimeter', false],
  ['along', 'around', 'Talstar P', 'exterior perimeter', true], ['along', 'around', 'Talstar P', 'garage', false],
])('respectively maps %s / %s: %s to %s', (first, second, subject, location, completed) => {
  const text = `Talstar P and bait were applied ${first} the exterior perimeter and ${second} the garage, respectively.`;
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf(location), location.length, /applied/.exec(text))).toBe(completed);
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
