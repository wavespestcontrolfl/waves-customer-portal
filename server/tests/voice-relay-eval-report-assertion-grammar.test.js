const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES, _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

// Each classifier receives bounded evidence selected by its consumer. Passing
// completion alone does not confirm a product, target, date or report readback.

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
  ['The technician Will applied Talstar P to the exterior perimeter.', false],
  ['The technician May applied Talstar P to the exterior perimeter.', false],
  ['The technician Will may have applied Talstar P to the exterior perimeter.', true],
  ['The technician May will apply Talstar P to the exterior perimeter.', true],
  ['Talstar P could already have been applied to the exterior perimeter.', true],
  ['Talstar P should be applied to the exterior perimeter.', true],
  ['The report might show that Talstar P was applied to the exterior perimeter.', true],
  ['We pretended that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied tomorrow to the exterior perimeter.', true],
  ['Talstar P was applied yesterday to the exterior perimeter.', false],
  ['Talstar P was applied to the exterior perimeter.', false],
])('scoped report uncertainty: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
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
  ['I need you to confirm that Talstar P was applied to the exterior perimeter.', true],
  ['I want you to verify that Talstar P was applied to the exterior perimeter.', true],
  ['Please let me know whether Talstar P was applied to the exterior perimeter.', true],
  ['I need you to confirm the invoice, Talstar P was applied to the exterior perimeter.', false],
  ['I need you at the office, Talstar P was applied to the exterior perimeter.', false],
  ['We confirm that Talstar P was applied to the exterior perimeter.', false],
])('governing instruction detection: %s', (text, instruction) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(instruction);
});

test.each([
  "I'd like you to confirm that",
  'I would like you to verify that',
  'I ask you to confirm that',
  'We request you to check whether',
])('declarative request governor: %s', (governor) => {
  const text = `${governor} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(true);
  const unrelated = `${governor} the invoice is paid, Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(unrelated, unrelated.indexOf('Talstar P'),
    unrelated.indexOf('exterior perimeter'), /applied/.exec(unrelated), unrelated.length)).toBe(false);
});

test.each([
  'Talstar P appears to have been applied to the exterior perimeter.',
  'Talstar P seems to have been applied to the exterior perimeter.',
  'Talstar P is believed to have been applied to the exterior perimeter.',
  'Talstar P was thought to have been applied to the exterior perimeter.',
  'Talstar P is assumed to have been applied to the exterior perimeter.',
])('epistemic raising does not establish definite treatment: %s', (text) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
});

test.each([
  ['We completed applying Talstar P to the exterior perimeter.', true],
  ['We finished applying Talstar P to the exterior perimeter.', true],
  ['We had completed applying Talstar P to the exterior perimeter.', true],
  ['We did not complete applying Talstar P to the exterior perimeter.', false],
  ['We did not finish applying Talstar P to the exterior perimeter.', false],
  ['We had not completed applying Talstar P to the exterior perimeter.', false],
  ["We haven't finished applying Talstar P to the exterior perimeter.", false],
  ['We planned to complete applying Talstar P to the exterior perimeter.', false],
  ['We planned to have completed applying Talstar P to the exterior perimeter.', false],
  ['We were supposed to have completed applying Talstar P to the exterior perimeter.', false],
  ['We wanted the technician to have finished applying Talstar P to the exterior perimeter.', false],
  ['We almost completed applying Talstar P to the exterior perimeter.', false],
  ['We almost finished applying Talstar P to the exterior perimeter.', false],
  ['Talstar P was not only applied to the exterior perimeter, but also indoors.', true],
  ['Talstar P has been not only applied to the exterior perimeter, but also indoors.', true],
  ['Talstar P was not applied to the exterior perimeter.', false],
  ['Talstar P was not only planned to be applied to the exterior perimeter.', false],
  ['Talstar P was not only almost applied to the exterior perimeter.', false],
  ['We applied Talstar P to the exterior perimeter.', true],
  ['We attempted to have applied Talstar P to the exterior perimeter.', false],
  ['We tried to have applied Talstar P to the exterior perimeter.', false],
  ['We hoped to have applied Talstar P to the exterior perimeter.', false],
  ['We were hoping to have applied Talstar P to the exterior perimeter.', false],
  ['We were hoping to have finished applying Talstar P to the exterior perimeter.', false],
  ['Talstar P was also applied to the exterior perimeter.', true],
  ['Talstar P has also been applied to the exterior perimeter.', true],
  ['Talstar P was also not applied to the exterior perimeter.', false],
  ['Talstar P was also supposed to have been applied to the exterior perimeter.', false],
])('completion predicate has no product or location ownership: %s', (text, completed) => {
  const verb = /\b(?:applying|applied)\b/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, verb)).toBe(completed);
});

test.each(['apply', 'use', 'spray', 'treat', 'place'])('emphatic did %s establishes completed predicate', (action) => {
  for (const [prefix, completed] of [['We did', true], ['We did also', true], ['We', false], ['We did not', false], ['We planned to', false]]) {
    const text = `${prefix} ${action} Talstar P around the exterior perimeter.`;
    expect(grammar.reportHasCompletedPredicate(text, new RegExp(`\\b${action}\\b`).exec(text))).toBe(completed);
  }
});

test.each(['applying', 'spraying', 'treating', 'placing', 'using'])('completed %s retains its governor', (action) => {
  for (const [prefix, completed] of [['We finished', true], ['We completed', true], ['We were supposed to have finished', false], ['We almost finished', false], ['We did not finish', false], ['We tried to have finished', false], ['We are', false]]) {
    const text = `${prefix} ${action} Talstar P to the exterior perimeter.`;
    expect(grammar.reportHasCompletedPredicate(text, new RegExp(action).exec(text))).toBe(completed);
  }
});

test.each(["'s", "'d", "'ve", '’s', '’d', '’ve'])('perfect passive contraction %s retains completion', (auxiliary) => {
  const text = `Talstar P${auxiliary} been applied to the exterior perimeter.`;
  expect(grammar.REPORT_COMPLETED_PASSIVE_RE.test(`${auxiliary} been `)).toBe(true);
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
  const negative = `Talstar P${auxiliary} not been applied to the exterior perimeter.`;
  expect(grammar.REPORT_COMPLETED_PASSIVE_RE.test(`${auxiliary} not been `)).toBe(false);
  expect(grammar.reportHasCompletedPredicate(negative, /applied/.exec(negative))).toBe(false);
});

test.each(['was ', 'were also ', 'has been ', 'have also been ', 'had been '])('uncontracted completed passive prefix: %s', (prefix) => {
  expect(grammar.REPORT_COMPLETED_PASSIVE_RE.test(prefix)).toBe(true);
});

test.each(['perhaps been ', 'unwashed been ', 'is ', 'will be ', 'was not '])('incomplete passive prefix: %s', (prefix) => {
  expect(grammar.REPORT_COMPLETED_PASSIVE_RE.test(prefix)).toBe(false);
});

test.each(['We were unable', 'We refused', 'We declined', 'We forgot', 'We neglected'])('noncompletion perfect infinitive governor: %s', (governor) => {
  for (const predicate of ['applied', 'finished applying', 'completed spraying']) {
    const text = `${governor} to have ${predicate} Talstar P to the exterior perimeter.`;
    const verb = /\b(?:applied|applying|spraying)\b/.exec(text);
    expect(grammar.reportHasCompletedPredicate(text, verb)).toBe(false);
  }
});

test.each([
  ['Talstar P, not bait, was applied to the exterior perimeter.', 'Talstar P', 'exterior perimeter', false],
  ['Talstar P, not bait, was applied to the exterior perimeter.', 'bait', 'exterior perimeter', true],
  ['The exterior perimeter, not the garage, was treated with Talstar P.', 'Talstar P', 'exterior perimeter', false],
  ['The exterior perimeter, not the garage, was treated with Talstar P.', 'Talstar P', 'garage', true],
  ['Talstar P, not bait, was not applied to the exterior perimeter.', 'Talstar P', 'exterior perimeter', true],
  ['Talstar P, not bait, has not been applied to the exterior perimeter.', 'Talstar P', 'exterior perimeter', true],
  ['Talstar P was not, according to the report, applied to the exterior perimeter.', 'Talstar P', 'exterior perimeter', true],
  ['Talstar P, not bait was applied, was applied to the exterior perimeter.', 'Talstar P', 'exterior perimeter', true],
])('nominal contrast preserves matched claim scope: %s / %s / %s', (text, subject, location, denied) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf(subject), text.indexOf(location),
    /\b(?:applied|treated)\b/.exec(text), '')).toBe(denied);
});

test('nominal contrast retains completion of the main predicate', () => {
  const text = 'Talstar P, not bait, was applied to the exterior perimeter.';
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
});

test('completion predicate alone does not establish product or location ownership', () => {
  const text = 'We applied bait after discussing Talstar P near the exterior perimeter.';
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
  expect(grammar.reportHasCompletedPredicate(text, null)).toBe(false);
});

test('a later modal does not govern a completed treatment predicate', () => {
  const text = 'We applied Talstar P to the exterior perimeter, which should help control ants.';
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
  const findingEvidence = text.slice(0, text.indexOf(','));
  expect(grammar.reportFindingIsUncertain(findingEvidence)).toBe(false);
});

test.each([
  ['Talstar P is applied to the exterior perimeter.', false],
  ['Talstar P is regularly applied to the exterior perimeter.', false],
  ['Talstar P is being applied to the exterior perimeter.', false],
  ['Talstar P was being applied to the exterior perimeter.', false],
  ['Talstar P has been being applied to the exterior perimeter.', false],
  ['Talstar P was getting applied to the exterior perimeter.', false],
  // 's may mean has; consumers must establish active versus passive ownership.
  ["The technician's applied Talstar P to the exterior perimeter.", true],
  ['The technician has applied Talstar P to the exterior perimeter.', true],
  ['Talstar P is not only applied to the exterior perimeter.', false],
  ['Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was regularly applied to the exterior perimeter.', true],
  ['Talstar P has been applied to the exterior perimeter.', true],
  ['Talstar P had been applied to the exterior perimeter.', true],
  ["Talstar P's been applied to the exterior perimeter.", true],
  ["Talstar P'd been applied to the exterior perimeter.", true],
  ['We applied Talstar P to the exterior perimeter.', true],
  ['We have applied Talstar P to the exterior perimeter.', true],
  ['We finished applying Talstar P to the exterior perimeter.', true],
])('completion predicate distinguishes present/progressive passive: %s', (text, completed) => {
  const verb = /\b(?:applying|applied)\b/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, verb)).toBe(completed);
});

test.each([
  ['We almost did apply Talstar P to the exterior perimeter.', false],
  ['We nearly did also apply Talstar P to the exterior perimeter.', false],
  ['We did apply Talstar P to the exterior perimeter.', true],
  ['We did not only apply Talstar P to the exterior perimeter.', true],
  ['We did not apply Talstar P to the exterior perimeter.', false],
  ['We expected Sam to have applied Talstar P to the exterior perimeter.', false],
  ['We expected Sam Jones to have applied Talstar P to the exterior perimeter.', false],
  ['We expected the technician to have applied Talstar P to the exterior perimeter.', false],
  ['Sam applied Talstar P to the exterior perimeter.', true],
  ['Sam Jones applied Talstar P to the exterior perimeter.', true],
])('completion retains near-miss governors, recipients and affirmative focus: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /\b(?:apply|applied)\b/.exec(text))).toBe(completed);
});

test.each([
  ['It is possible Talstar P was applied to the exterior perimeter.', true],
  ['It is possible that Talstar P was applied to the exterior perimeter.', true],
  ['We think that Talstar P was applied to the exterior perimeter.', true],
  ['We believe Talstar P was applied to the exterior perimeter.', true],
  ['We confirm that Talstar P was applied to the exterior perimeter.', false],
  ['Talstar P was applied to the exterior perimeter.', false],
])('uncertainty does not require an explicit that complement: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['I need confirmation that Talstar P was applied to the exterior perimeter.', true],
  ['I want verification that Talstar P was applied to the exterior perimeter.', true],
  ['We request your confirmation whether Talstar P was applied to the exterior perimeter.', true],
  ['I need confirmation that the invoice is paid, Talstar P was applied to the exterior perimeter.', false],
  ['We received confirmation that Talstar P was applied to the exterior perimeter.', false],
  ['The report documents confirmation that Talstar P was applied to the exterior perimeter.', false],
])('nominal request governs its own finding: %s', (text, instruction) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(instruction);
});

test.each(['even once', 'yet', 'ever', 'always', 'usually', 'again', 'at all'])('temporal/frequency denial is not nominal contrast: not %s', (modifier) => {
  const text = `The exterior perimeter, not ${modifier}, was treated with Talstar P.`;
  const verb = /treated/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, verb)).toBe(false);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), verb, '')).toBe(true);
});

// A past-tense finding embedded in an imagined assertion remains hypothetical.
test.each([
  'The technician imagined that Talstar P was applied to the exterior perimeter.',
  'We imagine that Talstar P was applied to the exterior perimeter.',
])('imagined assertions retain uncertainty: %s', (text) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
});

test.each(['sprayed', 'treated', 'used'])('an unrelated instruction does not govern a past-tense %s finding', (action) => {
  const asserted = `Check the invoice, we ${action} Talstar P around the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(asserted, asserted.indexOf('Talstar P'),
    asserted.indexOf('exterior perimeter'), new RegExp(action).exec(asserted), asserted.length)).toBe(false);

  const requested = `Check that we ${action} Talstar P around the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(requested, requested.indexOf('Talstar P'),
    requested.indexOf('exterior perimeter'), new RegExp(action).exec(requested), requested.length)).toBe(true);
});

test.each([
  ['I asked you to confirm that', 'I asked you to confirm the invoice is paid,'],
  ['We requested confirmation that', 'We requested confirmation the invoice is paid,'],
])('past-tense declarative request governs only its own finding: %s', (governor, unrelatedGovernor) => {
  const requested = `${governor} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(requested, requested.indexOf('Talstar P'),
    requested.indexOf('exterior perimeter'), /applied/.exec(requested), requested.length)).toBe(true);

  const unrelated = `${unrelatedGovernor} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(unrelated, unrelated.indexOf('Talstar P'),
    unrelated.indexOf('exterior perimeter'), /applied/.exec(unrelated), unrelated.length)).toBe(false);
});

test.each(['finish', 'complete'])('emphatic did %s establishes completed gerund predicate', (completion) => {
  const completed = `We did ${completion} applying Talstar P to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(completed, /applying/.exec(completed))).toBe(true);

  const negated = `We did not ${completion} applying Talstar P to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(negated, /applying/.exec(negated))).toBe(false);
});

test.each([
  ['Talstar P gets applied every month to the exterior perimeter.', 'Talstar P got applied last month to the exterior perimeter.', /applied/],
  ['We get treated every month around the exterior perimeter.', 'We got treated yesterday around the exterior perimeter.', /treated/],
])('habitual get-passive is not a completed event: %s', (habitual, completed, verb) => {
  expect(grammar.reportHasCompletedPredicate(habitual, verb.exec(habitual))).toBe(false);
  expect(grammar.reportHasCompletedPredicate(completed, verb.exec(completed))).toBe(true);
});

test.each([
  ['We expect Sam to have applied Talstar P to the exterior perimeter.', 'Sam has applied Talstar P to the exterior perimeter.'],
  ['We are expecting to have applied Talstar P to the exterior perimeter by noon.', 'We have applied Talstar P to the exterior perimeter.'],
])('present expectation does not establish perfect-infinitive completion: %s', (expected, completed) => {
  expect(grammar.reportHasCompletedPredicate(expected, /applied/.exec(expected))).toBe(false);
  expect(grammar.reportHasCompletedPredicate(completed, /applied/.exec(completed))).toBe(true);
});

test.each([
  ['Talstar P might get applied to the exterior perimeter.', 'Talstar P did get applied to the exterior perimeter.'],
  ['It is unlikely that Talstar P was applied to the exterior perimeter.', 'It is confirmed that Talstar P was applied to the exterior perimeter.'],
  ['We thought Talstar P was applied to the exterior perimeter.', 'We confirmed Talstar P was applied to the exterior perimeter.'],
])('uncertain construction differs from definite evidence: %s', (uncertain, definite) => {
  expect(grammar.reportFindingIsUncertain(uncertain)).toBe(true);
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test.each([
  [
    'The exterior perimeter, not the family room, was treated with Talstar P.',
    'The exterior perimeter, not usually, was treated with Talstar P.',
    'Talstar P',
    'exterior perimeter',
    /treated/,
  ],
  [
    'Talstar P, not EcoVia Fly Bait, was applied to the exterior perimeter.',
    'Talstar P, not recently, was applied to the exterior perimeter.',
    'Talstar P',
    'exterior perimeter',
    /applied/,
  ],
])('words ending in ly remain valid nominal contrasts: %s', (contrast, temporalDenial, subject, location, verb) => {
  const contrastVerb = verb.exec(contrast);
  expect(grammar.reportHasCompletedPredicate(contrast, contrastVerb)).toBe(true);
  expect(grammar.reportClaimIsDenied(contrast, contrast, contrast.indexOf(subject),
    contrast.indexOf(location), contrastVerb, '')).toBe(false);

  const deniedVerb = verb.exec(temporalDenial);
  expect(grammar.reportHasCompletedPredicate(temporalDenial, deniedVerb)).toBe(false);
  expect(grammar.reportClaimIsDenied(temporalDenial, temporalDenial, temporalDenial.indexOf(subject),
    temporalDenial.indexOf(location), deniedVerb, '')).toBe(true);
});

test.each(['incident', 'a problem', 'complications'])('affirmative without %s does not deny treatment', (modifier) => {
  const affirmative = `Talstar P was applied without ${modifier} to the exterior perimeter.`;
  expect(grammar.reportClaimIsDenied(affirmative, affirmative, affirmative.indexOf('Talstar P'),
    affirmative.indexOf('exterior perimeter'), /applied/.exec(affirmative), '')).toBe(false);

  const negated = `Talstar P was not applied without ${modifier} to the exterior perimeter.`;
  expect(grammar.reportClaimIsDenied(negated, negated, negated.indexOf('Talstar P'),
    negated.indexOf('exterior perimeter'), /applied/.exec(negated), '')).toBe(true);
});

test.each([
  ['We sprayed Talstar P around the exterior perimeter until noon.', /sprayed/, true, false, false],
  ['We did not spray Talstar P around the exterior perimeter until noon.', /spray/, false, true, false],
  ['We will spray Talstar P around the exterior perimeter until noon.', /spray/, false, false, true],
  ["We won't spray Talstar P around the exterior perimeter until noon.", /spray/, false, true, null],
])('temporal until preserves the predicate controls: %s', (text, verb, completed, denied, uncertain) => {
  const findingVerb = verb.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(completed);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb, '')).toBe(denied);
  if (uncertain !== null) expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each(['only', 'just', 'merely', 'simply'])('contracted affirmative focus retains completion: was not %s', (focus) => {
  const affirmative = `Talstar P wasn't ${focus} applied to the exterior perimeter; it was also applied indoors.`;
  expect(grammar.reportHasCompletedPredicate(affirmative, /applied/.exec(affirmative))).toBe(true);

  const negated = "Talstar P wasn't applied to the exterior perimeter.";
  expect(grammar.reportHasCompletedPredicate(negated, /applied/.exec(negated))).toBe(false);
});

test.each([
  ['did get ', true],
  ['did not get ', false],
  ['will get ', false],
])('completed passive prefix recognizes emphatic get: %s', (prefix, completed) => {
  expect(grammar.REPORT_COMPLETED_PASSIVE_RE.test(prefix)).toBe(completed);
});


test.each(['already', 'actually'])('emphatic get-passive retains an intervening %s adverb', (adverb) => {
  const text = `Talstar P did ${adverb} get applied to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
  expect(grammar.REPORT_COMPLETED_PASSIVE_RE.test(text.slice(0, text.indexOf('applied')))).toBe(true);
});

test.each(['necessarily', 'actually', 'very carefully'])('negated adverb %s is not a nominal contrast', (adverb) => {
  const text = `Talstar P, not ${adverb}, was applied to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(false);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(true);
});

test.each(['finish', 'complete'])('nearly completing %s is not a completed treatment', (completion) => {
  const text = `We did nearly ${completion} applying Talstar P to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(text, /applying/.exec(text))).toBe(false);
});


test('nearly getting applied is not completed by an emphatic auxiliary', () => {
  const text = 'Talstar P did nearly get applied to the exterior perimeter.';
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(false);
});


test.each([
  "We won't just have applied Talstar P to the exterior perimeter.",
  "We wouldn't merely have applied Talstar P to the exterior perimeter.",
  "Talstar P can't merely have been applied to the exterior perimeter.",
  "Talstar P won't just be applied to the exterior perimeter.",
  "Talstar P wouldn't only be applied to the exterior perimeter.",
])('modal contracted focus does not establish completion: %s', (text) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(false);
});
