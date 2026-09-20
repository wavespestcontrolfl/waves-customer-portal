const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES, _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

// Classifiers receive one bounded treatment frame; coordinator ownership and
// final confirmation (including uncertainty/instructions) are separate concerns.

test('report grammar has no runner or value-rule registration', () => {
  expect(SPOKEN_CHECK_RUNNERS).not.toHaveProperty('report_readback_confirms');
  expect(SPOKEN_CHECK_VALUE_RULES).not.toHaveProperty('report_readback_confirms');
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
  ['We used Talstar P concentrate at the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P liquid to the exterior perimeter.', 'Talstar', true],
  ['We applied Talstar P bottle to the exterior perimeter.', 'Talstar', false],
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
  ['We were hoping to have applied Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We were hoping to have finished applying Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was used for ants reported at the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was used with equipment sitting at the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was used with a sprayer leaning at the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was used for ants observed near equipment at the exterior perimeter.', 'Talstar P', false],
  ['We applied Talstar P after lunch to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P before dinner to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P after treating bait to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was also applied to the exterior perimeter.', 'Talstar P', true],
  ['Talstar P has also been applied to the exterior perimeter.', 'Talstar P', true],
  ['Talstar P was also not applied to the exterior perimeter.', 'Talstar P', false],
  ['Talstar P was also supposed to have been applied to the exterior perimeter.', 'Talstar P', false],
])('completed treatment and product ownership: %s / %s', (text, subject, completed) => {
  const verb = /\b(?:apply|applying|applied|place|placed|placing|use|used|using|treat|treated|treating|spray|sprayed|spraying|put|went|got|received)\b/i.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf('exterior perimeter'), 18, verb)).toBe(completed);
});

test.each(['use', 'spray', 'treat', 'place'])('did %s requires completed emphasis and direct product scope', (action) => {
  for (const [prefix, completed] of [['We did', true], ['We did also', true], ['We', false], ['We did not', false], ['We planned to', false]]) {
    const text = `${prefix} ${action} Talstar P around the exterior perimeter.`;
    expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
      text.indexOf('exterior perimeter'), 18, new RegExp(`\\b${action}\\b`).exec(text))).toBe(completed);
  }
  const text = `We did ${action} a substitute for Talstar P around the exterior perimeter.`;
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, new RegExp(`\\b${action}\\b`).exec(text))).toBe(false);
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
  const [start, end] = grammar.clauseBounds(text, text.indexOf('Talstar P'));
  const assertion = text.slice(start, end);
  expect(grammar.reportHasCompletedFinding(assertion, assertion.indexOf('Talstar P'), 9,
    assertion.indexOf('exterior perimeter'), 18, /applied/.exec(assertion))).toBe(true);
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

test('concise summaries require a direct product-location link', () => {
  const text = 'Talstar P around the exterior perimeter';
  expect(grammar.reportHasConciseFinding(text, 0, 9, text.indexOf('exterior perimeter'), 18, null)).toBe(true);
  const mention = 'Talstar P in a container at the exterior perimeter';
  expect(grammar.reportHasConciseFinding(mention, 0, 9, mention.indexOf('exterior perimeter'), 18, null)).toBe(false);
});

test.each([
  ['Talstar P was applied to the exterior perimeter for ants or roaches.', false],
  ['Talstar P was applied to the exterior perimeter against ants or roaches.', false],
  ['Talstar P was applied to the exterior perimeter to control ants or roaches.', false],
  ['The exterior perimeter was treated with Talstar P for ants or roaches.', false],
  ['We treated the exterior perimeter using Talstar P for either ants or roaches.', false],
  ['Talstar P was applied to the exterior perimeter or the garage for ants.', true],
  ['The exterior perimeter was treated with Talstar P or bait for ants.', true],
  ['Talstar P was applied to the exterior perimeter or indoors.', true],
  ['Talstar P was applied to either the exterior perimeter or garage.', true],
  ['Talstar P was applied to the exterior perimeter for ants or the garage.', false],
  ['Talstar P was applied to the exterior perimeter with a sprayer or equipment.', false],
  ['Talstar P was applied to the exterior perimeter or to the garage.', true],
  ['Talstar P was applied to the exterior perimeter or inside the garage.', true],
  ['Talstar P was applied to the exterior perimeter or near the garage.', false],
  ['The exterior perimeter was treated with talstar p or bait.', true],
  ['The exterior perimeter was treated with talstar p or suspend polyzone.', true],
  ['The exterior perimeter was treated with bait for ants or roaches.', false],
  ['The exterior perimeter was treated with a backpack or hand sprayer.', false],
])('purpose alternatives do not replace a definite treatment target: %s', (text, alternative) => {
  expect(grammar.reportHasAlternativeLocation(text, text.indexOf('exterior perimeter'), '')).toBe(alternative);
});

test.each([
  ['Talstar P was applied by the technician to the exterior perimeter.', true],
  ['Talstar P was applied by technician to the exterior perimeter.', true],
  ['Talstar P was applied by our crew to the exterior perimeter.', true],
  ['Talstar P was applied by hand to the exterior perimeter.', true],
  ['We applied Talstar P by hand to the exterior perimeter.', true],
  ['Talstar P was applied with a backpack sprayer to the exterior perimeter.', true],
  ['Talstar P was applied by the technician standing at the exterior perimeter.', false],
  ['Talstar P was applied with a sprayer stored at the exterior perimeter.', false],
  ['Talstar P was applied for ants observed at the exterior perimeter.', false],
  ['Talstar P was applied by the technician using a sprayer to the exterior perimeter.', true],
  ['Talstar P was applied by the technician using a sprayer stored at the exterior perimeter.', false],
  ['Talstar P was applied without trouble around the exterior perimeter.', true],
  ['Talstar P was applied without further delay around the exterior perimeter.', true],
  ['Bait was applied without Talstar P around the exterior perimeter.', false],
  ['Talstar P was applied without treating the exterior perimeter.', false],
  ['Talstar P was applied without documentation around the exterior perimeter.', false],
])('agent/manner adjunct preserves direct target ownership: %s', (text, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['The garage received Talstar P.', true],
  ['The garage received Talstar P liquid.', true],
  ['The garage got Talstar P.', true],
  ['The garage received Talstar P shipment.', false],
  ['The garage received Talstar P delivery.', false],
  ['The garage received Talstar P inventory.', false],
  ['The garage received Talstar P supplies.', false],
  ['The garage received Talstar P bottle.', false],
  ['The garage received a shipment of Talstar P.', false],
  ['The technician received Talstar P for the garage.', false],
  ['The garage received Talstar P spray.', true],
  ['The garage received Talstar P spray bottles.', false],
  ['The garage received Talstar P liquid spray bottles.', false],
  ['The garage received Talstar P granular bait supplies.', false],
])('location recipient excludes product custody: %s', (text, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('garage'), 6, /\b(?:received|got)\b/.exec(text))).toBe(completed);
});

test.each([
  ['We applied Talstar P outside the garage.', 'garage', true],
  ['We applied Talstar P outside of the garage.', 'garage', true],
  ['We applied Talstar P within the garage.', 'garage', true],
  ['We applied Talstar P near the garage.', 'garage', false],
  ['We applied Talstar P beside the garage.', 'garage', false],
  ['We applied Talstar P adjacent to the garage.', 'garage', false],
  ['We applied Talstar P outside with equipment stored in the garage.', 'garage', false],
  ['We applied Talstar P outside.', 'outside', true],
  ['We applied Talstar P indoors.', 'indoors', true],
])('named outside target remains distinct from nearby mentions: %s', (text, location, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf(location), location.length, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['At the exterior perimeter, Talstar P was applied by hand to the garage.', false],
  ['At the exterior perimeter, Talstar P was applied by the technician outside the garage.', false],
  ['At the exterior perimeter, Talstar P was applied by hand.', true],
  ['At the exterior perimeter, Talstar P was applied with a sprayer stored indoors.', true],
  ['At the exterior perimeter, Talstar P was applied by the technician using a sprayer to the garage.', false],
  ['At the exterior perimeter, Talstar P was applied by the technician using a sprayer.', true],
  ['At the exterior perimeter, Talstar P was applied by the technician using a sprayer stored indoors.', true],
])('fronted target yields to a direct later target: %s', (text, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(completed);
});

test.each([
  ["Talstar P's been applied to the exterior perimeter.", true],
  ["Talstar P'd been applied to the exterior perimeter.", true],
  ["The technician's applied Talstar P to the exterior perimeter.", true],
  ["Talstar P's applied to the exterior perimeter.", false],
  ['Talstar P is applied to the exterior perimeter.', false],
  ['Talstar P was being applied to the exterior perimeter.', false],
  ['Talstar P, not bait, was applied to the exterior perimeter.', true],
  ['The exterior perimeter, not the garage, was treated with Talstar P.', true],
])('single frame composes assertion completion and passive ownership: %s', (text, completed) => {
  const verb = /\b(?:applied|treated)\b/.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, verb)).toBe(completed);
});

test.each([
  'Talstar P and bait were applied to the exterior perimeter.',
  'We applied Talstar P and bait to the exterior perimeter.',
  'We applied Talstar P to the garage and exterior perimeter.',
  'We used Talstar P and walked to the exterior perimeter.',
  'The exterior perimeter and equipment were treated with Talstar P.',
])('single frame does not infer coordinator ownership: %s', (text) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /\b(?:applied|used|treated)\b/.exec(text))).toBe(false);
});

// Preserve established report findings when the product has a reporting aside
// or a completed use names its treatment purpose explicitly.
test.each([
  ['Talstar P, according to the report, was applied to the exterior perimeter.', true],
  ['Talstar P, according to the report, was not applied to the exterior perimeter.', false],
  ['Talstar P, next to the report, was applied to the exterior perimeter.', false],
  ['The technician used Talstar P to treat the exterior perimeter.', true],
  ['The technician used Talstar P to inspect the exterior perimeter.', false],
  ['The technician used Talstar P to plan to treat the exterior perimeter.', false],
])('single finding preserves reporting and treatment complements: %s', (text, completed) => {
  const verb = /\b(?:applied|used)\b/i.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, verb)).toBe(completed);
});

test.each([
  ['Talstar P was applied to likely nesting areas.', 'nesting areas', true],
  ['Talstar P was applied to potentially active areas.', 'active areas', true],
  ['Talstar P was applied to apparently active areas.', 'active areas', true],
  ['Talstar P was applied in a room that may be used by guests.', 'room', true],
  ['Talstar P was applied in a room that could have been used by guests.', 'room', true],
  ['Talstar P was applied where ants were apparently active.', 'where ants were apparently active', true],
  ['Talstar P was applied where the customer thinks ants enter.', 'where the customer thinks ants enter', true],
  ['Talstar P might have been applied to the exterior perimeter.', 'exterior perimeter', false],
  ['Talstar P might have been applied where ants were active.', 'where ants were active', false],
  ['Talstar P was apparently applied to the exterior perimeter.', 'exterior perimeter', false],
  ['Talstar P was apparently applied where ants were active.', 'where ants were active', false],
  ['Talstar P was applied where ants were active, apparently.', 'where ants were active', false],
  ['Talstar P was applied to the exterior perimeter, apparently.', 'exterior perimeter', false],
  ['Talstar P was applied to likely nesting areas, apparently.', 'nesting areas', false],
  ['Talstar P was applied yesterday to the exterior perimeter.', 'exterior perimeter', true],
  ['Talstar P was applied yesterday apparently to the exterior perimeter.', 'exterior perimeter', false],
  ['In a room that guests use we might have applied Talstar P.', 'room', false],
  ['In a room that guests use we applied Talstar P.', 'room', true],
  ['In a room that may be used by guests we might have applied Talstar P.', 'room', false],
  ['In a room that may be used by guests we applied Talstar P.', 'room', false],
  ['In a room that may be used by guests, we applied Talstar P.', 'room', true],
  ['In a room that guests use we might have already applied Talstar P.', 'room', false],
  ['In a room that guests use we would have carefully applied Talstar P.', 'room', false],
  ['Talstar P was applied where the customer thinks ants enter.', 'ants enter', false],
  ['Talstar P was applied where the customer thinks ants enter.', 'where the customer', false],
  ["We'd put Talstar P around the exterior perimeter yesterday.", 'exterior perimeter', true],
  ["We'd put Talstar P around the exterior perimeter using a sprayer yesterday.", 'exterior perimeter', true],
  ["We'd put Talstar P around the exterior perimeter using instructions received yesterday.", 'exterior perimeter', false],
  ["We'd put Talstar P around the exterior perimeter using instructions not received yesterday.", 'exterior perimeter', false],
  ["We'd put Talstar P around the exterior perimeter using instructions almost received yesterday.", 'exterior perimeter', false],
  ["We'd put Talstar P around the exterior perimeter using instructions we received yesterday.", 'exterior perimeter', false],
  ["We'd put Talstar P around the exterior perimeter near a room treated yesterday.", 'exterior perimeter', false],
  ['We had put Talstar P around the exterior perimeter using instructions received yesterday.', 'exterior perimeter', true],
  ['We had put Talstar P around the exterior perimeter using instructions not received yesterday.', 'exterior perimeter', true],
  ['We would put Talstar P around the exterior perimeter yesterday.', 'exterior perimeter', false],
])('matched target context scopes treatment certainty: %s', (text, location, completed) => {
  const verb = /\b(?:applied|put)\b/i.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf(location), location.length, verb)).toBe(completed);
});

test.each([
  ['We finished putting Talstar P around the exterior perimeter.', true],
  ['We completed putting Talstar P around the exterior perimeter.', true],
  ['We did finish putting Talstar P around the exterior perimeter.', true],
  ['We started putting Talstar P around the exterior perimeter.', false],
  ['We were putting Talstar P around the exterior perimeter.', false],
  ['We did not finish putting Talstar P around the exterior perimeter.', false],
  ['We finished putting bait after discussing Talstar P around the exterior perimeter.', false],
])('completed putting retains product and completion ownership: %s', (text, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /putting/.exec(text))).toBe(completed);
});

test.each([
  ['We applied nothing except Talstar P to the exterior perimeter.', true],
  ['We applied nothing except for Talstar P to the exterior perimeter.', true],
  ['We applied no product except Talstar P to the exterior perimeter.', true],
  ['We applied no products except for the diluted Talstar P to the exterior perimeter.', true],
  ['We applied everything except Talstar P to the exterior perimeter.', false],
  ['We applied bait except Talstar P to the exterior perimeter.', false],
  ['We did not apply nothing except Talstar P to the exterior perimeter.', false],
  ['We planned to apply nothing except Talstar P to the exterior perimeter.', false],
  ['We applied no product except bait after discussing Talstar P to the exterior perimeter.', false],
])('negative exceptive focus retains a direct product object: %s', (text, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /\b(?:apply|applied)\b/.exec(text))).toBe(completed);
});

test.each([
  ['Talstar P was applied not without difficulty to the exterior perimeter.', true],
  ['Talstar P was applied without any problems to the exterior perimeter.', true],
  ['Talstar P was applied not without further delays to the exterior perimeter.', true],
  ['Talstar P was not applied without difficulty to the exterior perimeter.', false],
  ['Bait was applied not without difficulty to the exterior perimeter.', false],
  ['Talstar P was applied not without difficulty indoors.', false],
  ['Talstar P was applied without treating the exterior perimeter.', false],
])('benign treatment adjuncts preserve exact product and target ownership: %s', (text, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['We applied no product other than Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied no products other than the diluted Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied no product other than bait after discussing Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We applied every product other than Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We applied bait other than Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We applied Talstar P other than bait to the exterior perimeter.', 'bait', false],
])('negative other-than focus retains only its direct product object: %s', (text, subject, completed) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(completed);
});
