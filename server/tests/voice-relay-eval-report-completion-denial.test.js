const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES, _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

// Each classifier receives bounded evidence selected by its consumer. Passing
// completion alone does not confirm a product, target, date or report readback.

test('report grammar has no runner or value-rule registration', () => {
  expect(SPOKEN_CHECK_RUNNERS).not.toHaveProperty('report_readback_confirms');
  expect(SPOKEN_CHECK_VALUE_RULES).not.toHaveProperty('report_readback_confirms');
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

test.each([
  ['We tried to ensure that Talstar P was applied to the exterior perimeter.', false],
  ['We attempted to make sure Talstar P was applied to the exterior perimeter.', false],
  ['We failed to ensure Talstar P had been applied to the exterior perimeter.', false],
  ['We worked hard to make sure Talstar P and bait were applied to the exterior perimeter.', false],
  ['We made an effort to ensure Talstar P was applied to the exterior perimeter.', false],
  ['We took care to ensure that Talstar P was applied to the exterior perimeter.', true],
  ['We managed to ensure that Talstar P was applied to the exterior perimeter.', true],
  ['We did ensure that Talstar P was applied to the exterior perimeter.', true],
  ['We made sure that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied to the exterior perimeter.', true],
  ['We tried to ensure the invoice was paid, but Talstar P was applied to the exterior perimeter.', true],
  ['We worked to ensure access after Talstar P was applied to the exterior perimeter.', true],
  ['We worked to ensure access because Talstar P was applied to the exterior perimeter.', true],
])('assurance effort does not establish completed treatment: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
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

test.each(['even once', 'yet', 'ever', 'always', 'usually', 'again', 'at all'])('temporal/frequency denial is not nominal contrast: not %s', (modifier) => {
  const text = `The exterior perimeter, not ${modifier}, was treated with Talstar P.`;
  const verb = /treated/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, verb)).toBe(false);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), verb, '')).toBe(true);
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

test.each(['requested', 'asked'])('%s-that subjunctive does not assert completed treatment', (request) => {
  const requested = `We ${request} that Talstar P be applied to the exterior perimeter.`;
  const requestedVerb = /applied/.exec(requested);
  expect(grammar.reportFindingIsInstruction(requested, requested.indexOf('Talstar P'),
    requested.indexOf('exterior perimeter'), requestedVerb, requested.length)).toBe(true);
  expect(grammar.reportHasCompletedPredicate(requested, requestedVerb)).toBe(false);

  const confirmed = 'We confirmed that Talstar P was applied to the exterior perimeter.';
  const confirmedVerb = /applied/.exec(confirmed);
  expect(grammar.reportFindingIsInstruction(confirmed, confirmed.indexOf('Talstar P'),
    confirmed.indexOf('exterior perimeter'), confirmedVerb, confirmed.length)).toBe(false);
  expect(grammar.reportHasCompletedPredicate(confirmed, confirmedVerb)).toBe(true);
});

test('but-not nominal contrast preserves the asserted product and denies the excluded product', () => {
  const contrast = 'Talstar P, but not bait, was applied to the exterior perimeter.';
  const verb = /applied/.exec(contrast);
  expect(grammar.reportHasCompletedPredicate(contrast, verb)).toBe(true);
  expect(grammar.reportClaimIsDenied(contrast, contrast, contrast.indexOf('Talstar P'),
    contrast.indexOf('exterior perimeter'), verb, '')).toBe(false);
  expect(grammar.reportClaimIsDenied(contrast, contrast, contrast.indexOf('bait'),
    contrast.indexOf('exterior perimeter'), verb, '')).toBe(true);

  const denied = 'Talstar P, but not bait, was not applied to the exterior perimeter.';
  expect(grammar.reportClaimIsDenied(denied, denied, denied.indexOf('Talstar P'),
    denied.indexOf('exterior perimeter'), /applied/.exec(denied), '')).toBe(true);
});

test('without difficulty differs from a true treatment denial', () => {
  const affirmative = 'Talstar P was applied without difficulty to the exterior perimeter.';
  expect(grammar.reportClaimIsDenied(affirmative, affirmative, affirmative.indexOf('Talstar P'),
    affirmative.indexOf('exterior perimeter'), /applied/.exec(affirmative), '')).toBe(false);

  const denied = 'We left without applying Talstar P to the exterior perimeter.';
  expect(grammar.reportClaimIsDenied(denied, denied, denied.indexOf('Talstar P'),
    denied.indexOf('exterior perimeter'), /applying/.exec(denied), '')).toBe(true);
});

test.each([
  ['We managed to apply Talstar P to the exterior perimeter.', true],
  ['We failed to manage to apply Talstar P to the exterior perimeter.', false],
  ['We expected to manage to apply Talstar P to the exterior perimeter.', false],
  ['We did not manage to apply Talstar P to the exterior perimeter.', false],
  ['We almost managed to apply Talstar P to the exterior perimeter.', false],
])('successful resultative governor distinguishes completion: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /apply/.exec(text))).toBe(completed);
});

test.each([
  ['were unable', 'We had Talstar P applied to the exterior perimeter.'],
  ['failed', 'We have had Talstar P applied to the exterior perimeter.'],
  ['forgot', 'We had Talstar P applied to the exterior perimeter.'],
  ['neglected', 'We have had Talstar P applied to the exterior perimeter.'],
  ['refused', 'We had Talstar P applied to the exterior perimeter.'],
])('%s-to-have causative remains incomplete', (governor, completedCausative) => {
  const incomplete = `We ${governor} to have Talstar P applied to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(incomplete, /applied/.exec(incomplete))).toBe(false);
  expect(grammar.reportHasCompletedPredicate(completedCausative, /applied/.exec(completedCausative))).toBe(true);
});

test('causative object scope stops before a separate completed assertion', () => {
  const text = 'We wanted the technician to have finished the report after he applied Talstar P to the exterior perimeter.';
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
});

test.each(['seemed', 'appeared'])('past tentative raising %s does not confirm managed completion', (raising) => {
  const text = `We ${raising} to have managed to apply Talstar P to the exterior perimeter.`;
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
  const completed = 'We have managed to apply Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(completed)).toBe(false);
  expect(grammar.reportHasCompletedPredicate(completed, /apply/.exec(completed))).toBe(true);
});

test.each([
  ['Please have Talstar P applied to the exterior perimeter.', 'I have had Talstar P applied to the exterior perimeter.'],
  ['Get Talstar P applied to the exterior perimeter.', 'I got Talstar P applied to the exterior perimeter.'],
])('causative imperative is an instruction while completed causative is evidence: %s', (imperative, completed) => {
  expect(grammar.reportFindingIsInstruction(imperative, imperative.indexOf('Talstar P'),
    imperative.indexOf('exterior perimeter'), /applied/.exec(imperative), imperative.length)).toBe(true);
  expect(grammar.reportFindingIsInstruction(completed, completed.indexOf('Talstar P'),
    completed.indexOf('exterior perimeter'), /applied/.exec(completed), completed.length)).toBe(false);
  expect(grammar.reportHasCompletedPredicate(completed, /applied/.exec(completed))).toBe(true);
});

test.each([
  ['We succeeded in applying Talstar P to the exterior perimeter.', true],
  ['We did succeed in applying Talstar P to the exterior perimeter.', true],
  ['We failed to succeed in applying Talstar P to the exterior perimeter.', false],
  ['We expected to succeed in applying Talstar P to the exterior perimeter.', false],
  ['We nearly succeeded in applying Talstar P to the exterior perimeter.', false],
  ["We didn't succeed in applying Talstar P to the exterior perimeter.", false],
])('successful gerund governor distinguishes completion: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applying/.exec(text))).toBe(completed);
});

test.each([
  "We can't confirm that Talstar P was applied to the exterior perimeter.",
  'I cannot verify that Talstar P was applied to the exterior perimeter.',
])('refused confirmation remains denied: %s', (text) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(true);

  const confirmed = 'We can confirm that Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportClaimIsDenied(confirmed, confirmed, confirmed.indexOf('Talstar P'),
    confirmed.indexOf('exterior perimeter'), /applied/.exec(confirmed), '')).toBe(false);
});

test.each([
  ['We succeeded at applying Talstar P to the exterior perimeter.', true],
  ['We did succeed at applying Talstar P to the exterior perimeter.', true],
  ["We didn't succeed at applying Talstar P to the exterior perimeter.", false],
  ['We nearly succeeded at applying Talstar P to the exterior perimeter.', false],
  ['We expected to succeed at applying Talstar P to the exterior perimeter.', false],
])('succeeded-at gerund governor distinguishes completion: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applying/.exec(text))).toBe(completed);
});

test.each([
  ['We applied Talstar P to the exterior perimeter after checking if the gate was locked.', false],
  ['If the gate was locked, we applied Talstar P to the exterior perimeter.', true],
  ['We applied Talstar P to the exterior perimeter whether or not it rained.', false],
  ['We checked whether Talstar P was applied to the exterior perimeter.', true],
])('conditional marker is scoped to the treatment proposition: %s', (text, denied) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(denied);
});

test.each([
  ['We were done applying Talstar P to the exterior perimeter.', true],
  ['We were not done applying Talstar P to the exterior perimeter.', false],
  ['We were almost done applying Talstar P to the exterior perimeter.', false],
  ['We completed applying Talstar P to the exterior perimeter.', true],
  ['Although we did not enter the home, we applied Talstar P to the exterior perimeter.', true],
  ['Although we did not enter the home, we did not apply Talstar P to the exterior perimeter.', false],
  ['We did not apply Talstar P to the exterior perimeter.', false],
  ['We are about to put Talstar P around the exterior perimeter.', false],
  ['We are ready to put Talstar P around the exterior perimeter.', false],
  ['We are preparing to put Talstar P around the exterior perimeter.', false],
  ['We are about to be done applying Talstar P to the exterior perimeter.', false],
  ['We are ready to be done applying Talstar P to the exterior perimeter.', false],
  ['We are preparing to be done applying Talstar P to the exterior perimeter.', false],
  ['We put Talstar P around the exterior perimeter.', true],
  ['We managed to put Talstar P around the exterior perimeter.', true],
  ['We did, according to the report, apply Talstar P to the exterior perimeter.', true],
  ['We did not, according to the report, apply Talstar P to the exterior perimeter.', false],
  ['We could, according to the report, apply Talstar P to the exterior perimeter.', false],
  ['According to the report, apply Talstar P to the exterior perimeter.', false],
])('carried completion repair: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /\b(?:apply|applying|applied|put)\b/.exec(text))).toBe(completed);
});

test.each([
  ['We applied Talstar P to the exterior perimeter whether it rained or not.', false, ''],
  ['After checking whether Talstar P was applied to the exterior perimeter, we left.', true, ''],
  ['Whether it rained or not, we applied Talstar P to the exterior perimeter.', true, ''],
  ['We applied Talstar P to the exterior perimeter if it rained.', true, ''],
  ['We applied everything except Talstar P to the exterior perimeter.', true, 'subject'],
  ['We applied Talstar P everywhere except the exterior perimeter.', true, 'location'],
  ['We applied Talstar P to the exterior perimeter.', false, ''],
  ['We applied all but bait to the exterior perimeter.', true, 'subject', 'bait'],
  ['We applied everything but bait to the exterior perimeter.', true, 'subject', 'bait'],
  ['Even if Talstar P was applied to the exterior perimeter, we treated the lawn.', true, ''],
  ['Even if, according to the report, Talstar P was applied to the exterior perimeter, we treated the lawn.', true, ''],
  ['Even if, according to the report, it rained, Talstar P was applied to the exterior perimeter.', false, ''],
  ['Even if it rained, Talstar P was applied to the exterior perimeter.', false, ''],
  ['Talstar P was applied to the exterior perimeter even if it rained.', false, ''],
])('carried denial repair: %s', (text, denied, precedingOwner, subject = 'Talstar P') => {
  const subjectAt = text.indexOf(subject);
  const locationAt = text.indexOf('exterior perimeter');
  const findingVerb = /\b(?:applied|treated)\b/.exec(text);
  const precedingAt = precedingOwner === 'subject' ? subjectAt : locationAt;
  const precedingText = precedingOwner ? text.slice(0, precedingAt) : '';
  expect(grammar.reportClaimIsDenied(text, text, subjectAt, locationAt,
    findingVerb, precedingText)).toBe(denied);
});

test.each([
  ['Talstar P was due to be applied to the exterior perimeter.', false],
  ['Talstar P was due to have been applied to the exterior perimeter.', false],
  ['Due to dry weather, Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P, not during this visit, was applied to the exterior perimeter.', false],
  ['Talstar P was not exclusively applied to the exterior perimeter; it was also applied indoors.', true],
  ["Talstar P wasn't solely applied to the exterior perimeter.", true],
  ['We almost immediately applied Talstar P to the exterior perimeter.', true],
  ['Talstar P was almost applied to the exterior perimeter.', false],
  ['We almost finished applying Talstar P to the exterior perimeter.', false],
])('review completion boundary: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /\b(?:applied|applying)\b/.exec(text))).toBe(completed);
});

test.each([
  ['Talstar P, not during this visit, was applied to the exterior perimeter.', true, ''],
  ['Talstar P, not bait, was applied to the exterior perimeter.', false, ''],
  ['We applied all products except for Talstar P to the exterior perimeter.', true, 'subject'],
  ['We applied Talstar P everywhere except for the exterior perimeter.', true, 'location'],
  ['Talstar P was not exclusively applied to the exterior perimeter; it was also applied indoors.', false, ''],
  ["Talstar P wasn't solely applied to the exterior perimeter.", false, ''],
  ['Talstar P was not applied to the exterior perimeter.', true, ''],
  ['Talstar P was applied without trouble around the exterior perimeter.', false, ''],
  ['Talstar P was applied without further delay to the exterior perimeter.', false, ''],
  ['We treated the exterior perimeter without Talstar P.', true, ''],
  ['We left without applying Talstar P to the exterior perimeter.', true, ''],
  ['We applied Talstar P to the exterior perimeter, if anything, more thoroughly than usual.', false, ''],
  ['If anything, including Talstar P, was applied to the exterior perimeter, it should be in the report.', true, ''],
  ['If it rained, Talstar P was applied to the exterior perimeter.', true, ''],
])('review denial boundary: %s', (text, denied, precedingOwner) => {
  const subjectAt = text.indexOf('Talstar P');
  const locationAt = text.indexOf('exterior perimeter');
  const precedingAt = precedingOwner === 'subject' ? subjectAt : locationAt;
  const precedingText = precedingOwner ? text.slice(0, precedingAt) : '';
  expect(grammar.reportClaimIsDenied(text, text, subjectAt, locationAt,
    /\b(?:applied|applying|treated)\b/.exec(text), precedingText)).toBe(denied);
});

test.each([
  ['We failed to get Talstar P applied to the exterior perimeter.', false],
  ['We attempted to get Talstar P applied to the exterior perimeter.', false],
  ['We asked the technician to get Talstar P applied to the exterior perimeter.', false],
  ['We managed to get Talstar P applied to the exterior perimeter.', true],
  ['We got Talstar P applied to the exterior perimeter.', true],
])('causative get retains its completion governor: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['We applied everything but bait to the exterior perimeter.', 'bait', true, 'subject'],
  ['We applied everything, including bait, to the exterior perimeter.', 'bait', false, ''],
  ['We applied Talstar P to the exterior perimeter regardless of whether it rained.', 'Talstar P', false, ''],
  ['Regardless of whether it rained, we applied Talstar P to the exterior perimeter.', 'Talstar P', false, ''],
  ['We applied Talstar P to the exterior perimeter regardless of whether it rained but only if we had access.', 'Talstar P', true, ''],
  ['We applied Talstar P to the exterior perimeter regardless of whether it rained and unless the gate was locked.', 'Talstar P', true, ''],
  ['We applied Talstar P to the exterior perimeter regardless of whether it rained but also only if we had access.', 'Talstar P', true, ''],
  ['We applied Talstar P to the exterior perimeter regardless of whether it rained but also treated indoors.', 'Talstar P', false, ''],
  ['We applied Talstar P to the exterior perimeter regardless of whether it rained and instead used bait indoors.', 'Talstar P', false, ''],
  ['We applied Talstar P to the exterior perimeter only if it did not rain.', 'Talstar P', true, ''],
])('exclusions and concessive conditions retain finding scope: %s', (text, subject, denied, precedingOwner) => {
  const subjectAt = text.indexOf(subject);
  const locationAt = text.indexOf('exterior perimeter');
  const precedingText = precedingOwner === 'subject' ? text.slice(0, subjectAt) : '';
  expect(grammar.reportClaimIsDenied(text, text, subjectAt, locationAt,
    /applied/.exec(text), precedingText)).toBe(denied);
});

test('a relative report-access assumption does not condition completed treatment', () => {
  const text = 'Talstar P was applied to the exterior perimeter, which you can see in the report, assuming you have it.';
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(false);
});

test.each([
  ['We promised to have applied Talstar P to the exterior perimeter by noon.', false],
  ['We agreed to have applied Talstar P to the exterior perimeter by noon.', false],
  ['We planned to end up applying Talstar P to the exterior perimeter.', false],
  ['We almost ended up applying Talstar P to the exterior perimeter.', false],
  ['We did not end up applying Talstar P to the exterior perimeter.', false],
  ['We ended up applying Talstar P to the exterior perimeter.', true],
  ['We wound up applying Talstar P to the exterior perimeter.', true],
])('commitment and resultative governors retain completion scope: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /\b(?:applied|applying)\b/.exec(text))).toBe(completed);
});

test.each([
  ['Talstar P was only partially applied to the exterior perimeter.', false],
  ['Talstar P was partially applied to the exterior perimeter.', false],
  ['Talstar P was incompletely applied to the exterior perimeter.', false],
  ['Talstar P was fully applied to the exterior perimeter.', true],
])('partial completion modifiers retain predicate scope: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test('bare provided condition differs from the provided treatment verb', () => {
  const conditional = 'Provided Talstar P was applied to the exterior perimeter, the report is ready.';
  expect(grammar.reportFindingIsUncertain(conditional)).toBe(true);

  const treatment = 'We provided Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(treatment)).toBe(false);
});

test('other-than exclusion denies only the excluded product', () => {
  const excluded = 'We applied every product other than Talstar P to the exterior perimeter.';
  expect(grammar.reportClaimIsDenied(excluded, excluded, excluded.indexOf('Talstar P'),
    excluded.indexOf('exterior perimeter'), /applied/.exec(excluded),
    excluded.slice(0, excluded.indexOf('Talstar P')))).toBe(true);

  const included = 'We applied Talstar P and every other product to the exterior perimeter.';
  expect(grammar.reportClaimIsDenied(included, included, included.indexOf('Talstar P'),
    included.indexOf('exterior perimeter'), /applied/.exec(included), '')).toBe(false);

  for (const spacing of [' ', '  ']) {
    const focused = `We applied nothing${spacing}other than Talstar P to the exterior perimeter.`;
    expect(grammar.reportClaimIsDenied(focused, focused, focused.indexOf('Talstar P'),
      focused.indexOf('exterior perimeter'), /applied/.exec(focused),
      focused.slice(0, focused.indexOf('Talstar P')))).toBe(false);
  }
});

test('negated doubt remains a completed certainty assertion', () => {
  const certain = 'We do not doubt that Talstar P was applied to the exterior perimeter.';
  const certainVerb = /applied/.exec(certain);
  expect(grammar.reportHasCompletedPredicate(certain, certainVerb)).toBe(true);
  expect(grammar.reportFindingIsUncertain(certain)).toBe(false);
  expect(grammar.reportClaimIsDenied(certain, certain, certain.indexOf('Talstar P'),
    certain.indexOf('exterior perimeter'), certainVerb, '')).toBe(false);

  const doubtful = 'We doubt that Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(doubtful)).toBe(true);
  expect(grammar.reportClaimIsDenied(doubtful, doubtful, doubtful.indexOf('Talstar P'),
    doubtful.indexOf('exterior perimeter'), /applied/.exec(doubtful), '')).toBe(true);
});

test('emphatic imperative put differs from a completed past put', () => {
  const imperative = 'Please do put Talstar P around the exterior perimeter.';
  expect(grammar.reportFindingIsInstruction(imperative, imperative.indexOf('Talstar P'),
    imperative.indexOf('exterior perimeter'), /put/.exec(imperative), imperative.length)).toBe(true);

  const completed = 'We did put Talstar P around the exterior perimeter.';
  expect(grammar.reportFindingIsInstruction(completed, completed.indexOf('Talstar P'),
    completed.indexOf('exterior perimeter'), /put/.exec(completed), completed.length)).toBe(false);
  expect(grammar.reportHasCompletedPredicate(completed, /put/.exec(completed))).toBe(true);
});

test.each(['claimed', 'purported'])('%s perfect treatment remains an epistemic claim', (governor) => {
  const claimed = `The technician ${governor} to have applied Talstar P to the exterior perimeter.`;
  expect(grammar.reportHasCompletedPredicate(claimed, /applied/.exec(claimed))).toBe(false);

  const confirmed = 'The technician confirmed that Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportHasCompletedPredicate(confirmed, /applied/.exec(confirmed))).toBe(true);

  const completed = 'The technician has applied Talstar P to the exterior perimeter.';
  expect(grammar.reportHasCompletedPredicate(completed, /applied/.exec(completed))).toBe(true);
});

test.each([
  ['The exterior perimeter, not the supply closet, was treated with Talstar P.', true, false],
  ['The exterior perimeter, not the early service area, was treated with Talstar P.', true, false],
  ['The exterior perimeter, not recently, was treated with Talstar P.', false, true],
  ['The exterior perimeter, not very carefully, was treated with Talstar P.', false, true],
  ['The exterior perimeter, not a little early, was treated with Talstar P.', false, true],
  ['The exterior perimeter, not a terribly long time ago, was treated with Talstar P.', false, true],
  ['The exterior perimeter, not a particularly long time ago, was treated with Talstar P.', false, true],
  ['The exterior perimeter, not a terribly short time ago, was treated with Talstar P.', false, true],
])('article-led nominal contrasts distinguish -ly modifiers: %s', (text, completed, denied) => {
  const findingVerb = /treated/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(completed);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb, '')).toBe(denied);
});

test.each([
  ['We fail to get Talstar P applied to the exterior perimeter.', false],
  ['The technician fails to get Talstar P applied to the exterior perimeter.', false],
  ['We are failing to get Talstar P applied to the exterior perimeter.', false],
  ['We failed to get Talstar P applied to the exterior perimeter.', false],
  ['We managed to get Talstar P applied to the exterior perimeter.', true],
  ['We got Talstar P applied to the exterior perimeter.', true],
])('inflected fail governors retain causative completion scope: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['We applied Talstar P to the exterior perimeter as if painting a line.', false],
  ['As if Talstar P was applied to the exterior perimeter, the report would show it.', true],
  ['We applied Talstar P to the exterior perimeter as if painting a line but only if the gate was open.', true],
  ['We applied Talstar P to the exterior perimeter as if painting a line unless it rained.', true],
  ['We applied Talstar P to the exterior perimeter as if painting a line only if the gate was open.', true],
  ['We applied Talstar P to the exterior perimeter if the gate was open.', true],
  ['We checked if Talstar P was applied to the exterior perimeter.', true],
])('post-finding as-if manner differs from a governing condition: %s', (text, denied) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(denied);
});

test.each([
  ['We were authorized to have Talstar P applied to the exterior perimeter.', false],
  ['We were allowed to have Talstar P applied to the exterior perimeter.', false],
  ['We received permission to have Talstar P applied to the exterior perimeter.', false],
  ['We had permission to have Talstar P applied to the exterior perimeter.', false],
  ['The technician has permission to have Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We were authorized to apply bait later, but we applied Talstar P to the exterior perimeter.', true],
])('permission governors do not establish completed treatment: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['We were set to have Talstar P applied to the exterior perimeter.', false],
  ['We decided to have Talstar P applied to the exterior perimeter.', false],
  ['We were deciding to have Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We decided yesterday, and we had Talstar P applied to the exterior perimeter.', true],
])('prospective causative governors remain incomplete: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['On condition that the gate was open, Talstar P was applied to the exterior perimeter.', true],
  ['As long as the gate was open, Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied to the exterior perimeter, as long as the gate was open.', true],
  ['We applied Talstar P to the exterior perimeter for as long as the visit lasted.', false],
  ['We documented the property condition, then applied Talstar P to the exterior perimeter.', false],
])('conditional clause markers differ from duration and target words: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We decided against having Talstar P applied to the exterior perimeter.', false],
  ['We avoided having Talstar P applied to the exterior perimeter.', false],
  ['We are avoiding having Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We avoided having bait applied indoors, but we had Talstar P applied to the exterior perimeter.', true],
])('negative gerund governors do not establish completed treatment: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied(?![\s\S]*applied)/.exec(text))).toBe(completed);
});

test.each([
  ['We applied nothing except Talstar P to the exterior perimeter.', false, 'subject'],
  ['We applied nothing  except Talstar P to the exterior perimeter.', false, 'subject'],
  ['We applied nothing except for Talstar P to the exterior perimeter.', false, 'subject'],
  ['We applied no product except Talstar P to the exterior perimeter.', false, 'subject'],
  ['We applied no product  except Talstar P to the exterior perimeter.', false, 'subject'],
  ['We applied no products except Talstar P to the exterior perimeter.', false, 'subject'],
  ['We applied everything except Talstar P to the exterior perimeter.', true, 'subject'],
  ['We applied Talstar P everywhere except the exterior perimeter.', true, 'location'],
])('negative exceptives distinguish focused products from exclusions: %s', (text, denied, owner) => {
  const subjectAt = text.indexOf('Talstar P');
  const locationAt = text.indexOf('exterior perimeter');
  const ownerAt = owner === 'subject' ? subjectAt : locationAt;
  expect(grammar.reportClaimIsDenied(text, text, subjectAt, locationAt,
    /applied/.exec(text), text.slice(0, ownerAt))).toBe(denied);
});

test.each([
  ['We finished putting Talstar P around the exterior perimeter.', true],
  ['We completed putting Talstar P around the exterior perimeter.', true],
  ['We started putting Talstar P around the exterior perimeter.', false],
  ['We were putting Talstar P around the exterior perimeter.', false],
  ['We put Talstar P around the exterior perimeter.', true],
])('putting uses the existing completed-gerund grammar: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /\b(?:putting|put)\b/.exec(text))).toBe(completed);
});

test.each(['putting green', 'golf green', 'putting area'])(
  'article-led nominal contrasts preserve gerund modifiers: %s', (place) => {
    const text = `The exterior perimeter, not the ${place}, was treated with Talstar P.`;
    const verb = /treated/.exec(text);
    expect(grammar.reportHasCompletedPredicate(text, verb)).toBe(true);
    expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
      text.indexOf('exterior perimeter'), verb, '')).toBe(false);
  },
);

test.each([
  ['We started to put Talstar P around the exterior perimeter.', false],
  ['We began to put Talstar P around the exterior perimeter.', false],
  ['We were beginning to put Talstar P around the exterior perimeter.', false],
  ['We put Talstar P around the exterior perimeter.', true],
  ['We started the visit and put Talstar P around the exterior perimeter.', true],
])('starting an invariant treatment predicate does not establish completion: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /\bput\b/.exec(text))).toBe(completed);
});

test.each([
  ['Talstar P was applied not without difficulty to the exterior perimeter.', false],
  ['Talstar P was applied not without trouble to the exterior perimeter.', false],
  ['Talstar P was not applied without difficulty to the exterior perimeter.', true],
  ['Talstar P was applied without difficulty to the exterior perimeter.', false],
  ['Talstar P was applied without treating the exterior perimeter.', true],
])('affirmative not-without adjuncts retain their full polarity: %s', (text, denied) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(denied);
});

test.each([
  ['We considered having Talstar P applied to the exterior perimeter.', false],
  ['We discussed having Talstar P applied to the exterior perimeter.', false],
  ['We considered having applied Talstar P to the exterior perimeter.', false],
  ['We are considering having Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We discussed bait, then had Talstar P applied to the exterior perimeter.', true],
])('deliberating about a gerund complement does not establish completion: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['We applied Talstar P, but not bait, to the exterior perimeter.', 'Talstar P', 'exterior perimeter', false],
  ['We applied Talstar P, but not bait, to the exterior perimeter.', 'bait', 'exterior perimeter', true],
  ['We applied Talstar P, but not the exterior perimeter, to the garage.', 'Talstar P', 'exterior perimeter', true],
  ['We applied Talstar P, but not during this visit, to the exterior perimeter.', 'Talstar P', 'exterior perimeter', true],
])('post-object nominal contrast preserves matched finding scope: %s / %s / %s',
  (text, subject, location, denied) => {
    const findingVerb = /applied/.exec(text);
    expect(grammar.reportClaimIsDenied(text, text, text.indexOf(subject), text.indexOf(location),
      findingVerb, '')).toBe(denied);
  });

test.each([
  'We applied Talstar P, but not on this visit, to the exterior perimeter.',
  'We applied Talstar P, but not this time, to the exterior perimeter.',
  'We applied Talstar P, but not at every service, to the exterior perimeter.',
])('temporal post-object exclusions remain denied: %s', (text) => {
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), '')).toBe(true);
});

test.each([
  ['We disputed having applied Talstar P to the exterior perimeter.', false],
  ['We dispute having Talstar P applied to the exterior perimeter.', false],
  ['We are disputing having Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We disputed bait, then applied Talstar P to the exterior perimeter.', true],
])('disputing a gerund complement does not establish completion: %s', (text, completed) => {
  const verbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, verbs.at(-1))).toBe(completed);
});

test.each([
  ['Talstar P is always applied to the exterior perimeter.', false],
  ['Talstar P is still applied to the exterior perimeter.', false],
  ['Talstar P and bait are always applied to the exterior perimeter.', false],
  ['Talstar P is routinely applied to the exterior perimeter.', false],
  ['Talstar P was always applied to the exterior perimeter.', true],
  ['Talstar P was still applied to the exterior perimeter.', true],
  ['Talstar P has always been applied to the exterior perimeter.', true],
  ['Talstar P is not always applied to the exterior perimeter.', false],
])('present habitual passive differs from past or perfect completion: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  ['Before noon, we applied Talstar P to the exterior perimeter.', true],
  ['Before 2 PM, we applied Talstar P to the exterior perimeter.', true],
  ['Before Tuesday, we applied Talstar P to the exterior perimeter.', true],
  ['Before lunch, we applied Talstar P to the exterior perimeter.', true],
  ['Before applying bait, we applied Talstar P to the exterior perimeter.', false],
  ['Before the visit, we applied Talstar P to the exterior perimeter.', false],
  ['Before noon, we planned to have applied Talstar P to the exterior perimeter.', false],
  ['Before noon, we did not apply Talstar P to the exterior perimeter.', false],
  ['Before noon, Talstar P was not applied to the exterior perimeter.', false],
])('fronted before-time adjuncts retain completion polarity: %s', (text, completed) => {
  const verbs = [...text.matchAll(/\b(?:apply|applied)\b/g)];
  expect(grammar.reportHasCompletedPredicate(text, verbs.at(-1))).toBe(completed);
});

test.each([
  'We aim to have applied Talstar P to the exterior perimeter.',
  'The technician aims to have applied Talstar P to the exterior perimeter.',
  'We aimed to have applied Talstar P to the exterior perimeter.',
  'We are aiming to have applied Talstar P to the exterior perimeter.',
  'We seek to have applied Talstar P to the exterior perimeter.',
  'The technician seeks to have applied Talstar P to the exterior perimeter.',
  'We sought to have applied Talstar P to the exterior perimeter.',
  'We are seeking to have applied Talstar P to the exterior perimeter.',
  'We propose to have applied Talstar P to the exterior perimeter.',
  'The technician proposes to have applied Talstar P to the exterior perimeter.',
  'We proposed to have applied Talstar P to the exterior perimeter.',
  'We are proposing to have applied Talstar P to the exterior perimeter.',
])('purpose and proposal governors do not establish completion: %s', (text) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(false);
});

test.each([
  'We sought approval, then applied Talstar P to the exterior perimeter.',
  'We proposed a schedule, then applied Talstar P to the exterior perimeter.',
  'We aimed at the marked area, then applied Talstar P to the exterior perimeter.',
])('an unrelated purpose verb does not deny a later completed finding: %s', (text) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
});

test.each([
  ['Kindly have Talstar P applied to the exterior perimeter.', true],
  ['Immediately get Talstar P applied to the exterior perimeter.', true],
  ['Please immediately have Talstar P applied to the exterior perimeter.', true],
  ['We promptly had Talstar P applied to the exterior perimeter.', false],
  ['Yesterday we had Talstar P applied to the exterior perimeter.', false],
  ['Have already applied Talstar P to the exterior perimeter.', false],
])('command adverbs preserve causative instruction scope: %s', (text, instruction) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(instruction);
});

test.each([
  ['Talstar P was applied only partially to the exterior perimeter.', false],
  ['Talstar P was applied incompletely to the exterior perimeter.', false],
  ['Talstar P was fully applied to the exterior perimeter.', true],
  ['We applied Talstar P completely to the exterior perimeter.', true],
  ['We applied Talstar P to the partially shaded exterior perimeter.', true],
  ['Talstar P was applied to the exterior perimeter, and bait was only partially applied indoors.', true],
])('post-verb completion modifiers retain their predicate scope: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(completed);
});

test.each([
  'We applied bait and watered plants incompletely.',
  'Talstar P was applied but worked only partially.',
  'Talstar P was applied and bait only partially.',
  'Talstar P was applied not only partially to the exterior perimeter.',
])('a later or negated partial modifier does not deny the selected predicate: %s', (text) => {
  expect(grammar.reportHasCompletedPredicate(text, /applied/.exec(text))).toBe(true);
});

test.each(["don't", "didn't", 'didn’t'])('contracted %s doubt remains a completed certainty assertion', (doubt) => {
  const text = `We ${doubt} doubt that Talstar P was applied to the exterior perimeter.`;
  const findingVerb = /applied/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(true);
  expect(grammar.reportFindingIsUncertain(text)).toBe(false);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb, '')).toBe(false);
});

test('actual doubt remains uncertain and denied', () => {
  const text = 'We doubt that Talstar P was applied to the exterior perimeter.';
  const findingVerb = /applied/.exec(text);
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb, '')).toBe(true);
});

test.each([
  ['We finished carefully applying Talstar P to the exterior perimeter.', true],
  ['We finished fully applying Talstar P to the exterior perimeter.', true],
  ['We did finish carefully applying Talstar P to the exterior perimeter.', true],
  ['We planned to have finished carefully applying Talstar P to the exterior perimeter.', false],
  ['We attempted to finish fully applying Talstar P to the exterior perimeter.', false],
  ['We did not finish carefully applying Talstar P to the exterior perimeter.', false],
  ['We almost finished carefully applying Talstar P to the exterior perimeter.', false],
  ['We finished almost applying Talstar P to the exterior perimeter.', false],
])('bounded manner adverbs retain their completion governor: %s', (text, completed) => {
  expect(grammar.reportHasCompletedPredicate(text, /applying/.exec(text))).toBe(completed);
});

test.each([
  ['We applied no product other than Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['No product other than Talstar P was applied to the exterior perimeter.', 'Talstar P', false],
  ['We applied no products other than Talstar P to the exterior perimeter.', 'Talstar P', false],
  ['We applied every product other than Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied bait other than Talstar P to the exterior perimeter.', 'Talstar P', true],
  ['We applied no product other than bait to the exterior perimeter.', 'bait', false],
])('no-product other-than focus differs from a selected exclusion: %s', (text, subject, denied) => {
  const subjectAt = text.indexOf(subject);
  expect(grammar.reportClaimIsDenied(text, text, subjectAt, text.indexOf('exterior perimeter'),
    /applied/.exec(text), text.slice(0, subjectAt))).toBe(denied);
});

test.each([
  ['We were prevented from having Talstar P applied to the exterior perimeter.', false],
  ['We were prohibited from having Talstar P applied to the exterior perimeter.', false],
  ['We were forbidden from having Talstar P applied to the exterior perimeter.', false],
  ['We were forbidden to have Talstar P applied to the exterior perimeter.', false],
  ['We forbade the technician to have Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We were prevented from having bait applied indoors, but Talstar P was applied to the exterior perimeter.', true],
])('prevention and prohibition governors do not establish completion: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ['The report incorrectly claimed that Talstar P was applied to the exterior perimeter.', true],
  ['The reports erroneously claim that Talstar P was applied to the exterior perimeter.', true],
  ['The report falsely claims that Talstar P was applied to the exterior perimeter.', true],
  ['The report is mistakenly claiming that Talstar P was applied to the exterior perimeter.', true],
  ['The report incorrectly stated that Talstar P was applied to the exterior perimeter.', true],
  ['The report correctly claimed that Talstar P was applied to the exterior perimeter.', false],
  ['The report accurately claims that Talstar P was applied to the exterior perimeter.', false],
  ['The report claimed that Talstar P was applied to the exterior perimeter.', false],
])('false attribution differs from a genuine report claim: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test('an unrelated false claim stays outside bounded treatment evidence', () => {
  const text = 'The report incorrectly claimed that the invoice was paid, but Talstar P was applied to the exterior perimeter.';
  const findingEvidence = grammar.claimContext(text, text.indexOf('Talstar P'), text.length);
  expect(findingEvidence).not.toMatch(/incorrectly claimed/i);
  expect(grammar.reportFindingIsUncertain(findingEvidence)).toBe(false);
});

test.each([
  ['We postponed having Talstar P applied to the exterior perimeter.', false],
  ['We are postponing having Talstar P applied to the exterior perimeter.', false],
  ['We called off having Talstar P applied to the exterior perimeter.', false],
  ['We are calling off having Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We called off the meeting, then had Talstar P applied to the exterior perimeter.', true],
  ['We postponed having bait applied indoors, but Talstar P was applied to the exterior perimeter.', true],
])('postponed or called-off causatives do not establish completion: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ['Talstar P was barely applied to the exterior perimeter.', false],
  ['Talstar P was hardly applied to the exterior perimeter.', false],
  ['Talstar P was scarcely applied to the exterior perimeter.', false],
  ['Talstar P was halfway applied to the exterior perimeter.', false],
  ['We barely applied Talstar P to the exterior perimeter.', false],
  ['We barely managed to apply Talstar P to the exterior perimeter.', true],
  ['We barely finished applying Talstar P to the exterior perimeter.', true],
  ['We barely arrived, then applied Talstar P to the exterior perimeter.', true],
  ['Talstar P was applied after we barely arrived at the property.', true],
  ['We applied Talstar P to the barely shaded exterior perimeter.', true],
  ['We applied Talstar P to the halfway point of the exterior perimeter.', true],
])('degree modifiers retain their immediate treatment-predicate scope: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/\b(?:applied|apply|applying)\b/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ['Be sure to have Talstar P applied to the exterior perimeter.', true],
  ['Please be sure to have Talstar P applied to the exterior perimeter.', true],
  ['Kindly be sure to have Talstar P applied to the exterior perimeter.', true],
  ['We were sure to have Talstar P applied to the exterior perimeter.', false],
  ['I was sure that Talstar P was applied to the exterior perimeter.', false],
  ['We made sure Talstar P was applied to the exterior perimeter.', false],
  ['Be sure to have bait applied indoors, but Talstar P was applied to the exterior perimeter.', false],
])('be-sure causative imperative differs from a completed assertion: %s', (text, instruction) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  const findingVerb = findingVerbs.at(-1);
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb, text.length)).toBe(instruction);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(true);
});

test.each([
  ['We almost got Talstar P applied to the exterior perimeter.', false],
  ['We nearly had Talstar P applied to the exterior perimeter.', false],
  ['We almost had Talstar P applied to the exterior perimeter.', false],
  ['We nearly got Talstar P applied to the exterior perimeter.', false],
  ['We actually got Talstar P applied to the exterior perimeter.', true],
  ['We actually had Talstar P applied to the exterior perimeter.', true],
  ['We already got Talstar P applied to the exterior perimeter.', true],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We almost got access, then had Talstar P applied to the exterior perimeter.', true],
  ['We nearly had lunch, then got Talstar P applied to the exterior perimeter.', true],
])('near causative completion retains its bounded governor: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  'Talstar P has been partially applied to the exterior perimeter.',
  'Talstar P had almost been applied to the exterior perimeter.',
  'We had Talstar P partially applied to the exterior perimeter.',
  'We have nearly finished applying Talstar P to the exterior perimeter.',
  'We have almost finished carefully applying Talstar P to the exterior perimeter.',
])('causative normalization retains direct noncompletion modifiers: %s', (text) => {
  const findingVerb = /\b(?:applied|applying)\b/.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(false);
});

test.each([
  ['We canceled getting Talstar P applied to the exterior perimeter.', false],
  ['We cancelled having Talstar P applied to the exterior perimeter.', false],
  ['We cancel getting Talstar P applied to the exterior perimeter.', false],
  ['We are cancelling having Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We canceled the visit, then had Talstar P applied to the exterior perimeter.', true],
  ['We canceled getting bait applied indoors, but Talstar P was applied to the exterior perimeter.', true],
])('canceled causatives do not establish completion: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ["The technician doesn't doubt that Talstar P was applied to the exterior perimeter.", true, false, false],
  ['The technician doesn’t doubt that Talstar P was applied to the exterior perimeter.', true, false, false],
  ['She does not doubt that Talstar P was applied to the exterior perimeter.', true, false, false],
  ['They did not doubt that Talstar P was applied to the exterior perimeter.', true, false, false],
  ['We doubt that Talstar P was applied to the exterior perimeter.', true, true, true],
  ["The technician doesn't doubt that Talstar P was not applied to the exterior perimeter.", false, false, true],
])('negated doubt remains certainty for supported report actors: %s',
  (text, completed, uncertain, denied) => {
    const findingVerb = /applied/g.exec(text);
    expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(completed);
    expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
    expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
      text.indexOf('exterior perimeter'), findingVerb)).toBe(denied);
  });

test.each([
  ['We lack evidence that Talstar P was applied to the exterior perimeter.', true, false],
  ['There is insufficient evidence that Talstar P was applied to the exterior perimeter.', true, false],
  ['The evidence fails to show that Talstar P was applied to the exterior perimeter.', true, false],
  ['We have evidence that Talstar P was applied to the exterior perimeter.', false, false],
  ['There is sufficient evidence that Talstar P was applied to the exterior perimeter.', false, false],
  ['The evidence shows that Talstar P was applied to the exterior perimeter.', false, false],
])('evidence absence remains an epistemic hedge: %s', (text, uncertain, denied) => {
  const findingVerb = /applied/g.exec(text);
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb)).toBe(denied);
});

test('an unrelated evidence-absence clause stays outside bounded finding evidence', () => {
  const text = 'We lack evidence that the invoice was paid, but Talstar P was applied to the exterior perimeter.';
  const findingEvidence = grammar.claimContext(text, text.indexOf('Talstar P'), text.length);
  expect(findingEvidence).not.toMatch(/lack evidence/i);
  expect(grammar.reportFindingIsUncertain(findingEvidence)).toBe(false);
});

test('unrelated evidence absence does not hedge a completed treatment', () => {
  const text = 'We lack evidence of ants and Talstar P was applied to the exterior perimeter.';
  const findingVerb = /applied/g.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(true);
  expect(grammar.reportFindingIsUncertain(text)).toBe(false);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb)).toBe(false);
});

test.each([
  ['We almost instantly applied Talstar P to the exterior perimeter.', true],
  ['We nearly instantly applied Talstar P to the exterior perimeter.', true],
  ['Talstar P was almost instantly applied to the exterior perimeter.', true],
  ['We almost immediately applied Talstar P to the exterior perimeter.', true],
  ['We almost applied Talstar P to the exterior perimeter.', false],
  ['Talstar P was nearly applied to the exterior perimeter.', false],
  ['Talstar P had nearly been applied to the exterior perimeter.', false],
  ['We nearly finished applying Talstar P to the exterior perimeter.', false],
  ['We almost instantly arrived, then applied Talstar P to the exterior perimeter.', true],
  ['We nearly applied bait indoors, but Talstar P was applied to the exterior perimeter.', true],
])('near timing differs from near treatment completion: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/\b(?:applied|applying)\b/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ['We were permitted to have Talstar P applied to the exterior perimeter.', false],
  ['They permitted us to have Talstar P applied to the exterior perimeter.', false],
  ['The customer permits the technician to have Talstar P applied to the exterior perimeter.', false],
  ['We received approval to have Talstar P applied to the exterior perimeter.', false],
  ['We got approval to have Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We were permitted access, then had Talstar P applied to the exterior perimeter.', true],
  ['We permitted bait indoors, but Talstar P was applied to the exterior perimeter.', true],
])('permission and approval governors do not establish completion: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ['Talstar P seems applied to the exterior perimeter.', true],
  ['Talstar P appeared applied to the exterior perimeter.', true],
  ['Talstar P seems already applied to the exterior perimeter.', true],
  ['Talstar P seems to have been applied to the exterior perimeter.', true],
  ['Talstar P was applied to the exterior perimeter.', false],
  ['The technician seemed tired, then Talstar P was applied to the exterior perimeter.', false],
  ['Talstar P appeared on the invoice after being applied to the exterior perimeter.', false],
])('bare seem and appear treatment complements remain uncertain: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ["Let's have Talstar P applied to the exterior perimeter.", true],
  ['Let’s have Talstar P applied to the exterior perimeter.', true],
  ['Let us have Talstar P applied to the exterior perimeter.', true],
  ['Please let us have Talstar P applied to the exterior perimeter.', true],
  ['We let the technician have Talstar P applied to the exterior perimeter.', false],
  ['Let us have lunch, then Talstar P was applied to the exterior perimeter.', false],
])('hortative causatives retain instruction scope: %s', (text, instruction) => {
  const findingVerb = /applied/g.exec(text);
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb, text.length)).toBe(instruction);
});

test.each([
  ['Purportedly, Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was purportedly applied to the exterior perimeter.', true],
  ['Talstar P was applied to the exterior perimeter.', false],
])('purportedly remains a report uncertainty marker: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test('an unrelated purported statement stays outside bounded finding evidence', () => {
  const text = 'The invoice was purportedly paid, but Talstar P was applied to the exterior perimeter.';
  const findingEvidence = grammar.claimContext(text, text.indexOf('Talstar P'), text.length);
  expect(findingEvidence).not.toMatch(/purportedly/i);
  expect(grammar.reportFindingIsUncertain(findingEvidence)).toBe(false);
});

test.each([
  ['On the condition that the gate was open, Talstar P was applied to the exterior perimeter.', true],
  ['So long as the gate was open, Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied to the exterior perimeter, so long as the gate was open.', true],
  ['We kept the gate open for so long as the visit lasted, then applied Talstar P to the exterior perimeter.', false],
  ['We documented the property condition, then applied Talstar P to the exterior perimeter.', false],
  ['We applied Talstar P along the long exterior perimeter.', false],
])('conditional variants remain bounded to a finite condition: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P, not this morning, was applied to the exterior perimeter.', false, true],
  ['Talstar P, not last night, was applied to the exterior perimeter.', false, true],
  ['Talstar P, not this week, was applied to the exterior perimeter.', false, true],
  ['Talstar P, not last Monday, was applied to the exterior perimeter.', false, true],
  ['Talstar P, not bait, was applied to the exterior perimeter.', true, false],
  ['The exterior perimeter, not the Monday room, was treated with Talstar P.', true, false],
  ['The exterior perimeter, not the This Morning room, was treated with Talstar P.', true, false],
])('calendar nominal contrasts retain treatment polarity: %s', (text, completed, denied) => {
  const findingVerb = /\b(?:applied|treated)\b/g.exec(text);
  expect(grammar.reportHasCompletedPredicate(text, findingVerb)).toBe(completed);
  expect(grammar.reportClaimIsDenied(text, text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), findingVerb)).toBe(denied);
});

test.each([
  ['We arranged to have Talstar P applied to the exterior perimeter.', false],
  ['We arrange to have Talstar P applied to the exterior perimeter.', false],
  ['The customer arranges for us to have Talstar P applied to the exterior perimeter.', false],
  ['We are arranging to have Talstar P applied to the exterior perimeter.', false],
  ['We had Talstar P applied to the exterior perimeter.', true],
  ['We arranged access, then had Talstar P applied to the exterior perimeter.', true],
  ['We arranged to have bait applied indoors, but Talstar P was applied to the exterior perimeter.', true],
])('arranged causatives do not establish completion: %s', (text, completed) => {
  const findingVerbs = [...text.matchAll(/applied/g)];
  expect(grammar.reportHasCompletedPredicate(text, findingVerbs.at(-1))).toBe(completed);
});

test.each([
  ['We applied Talstar P anywhere but the exterior perimeter.', 'location', true],
  ['We applied Talstar P everywhere but exterior perimeter.', 'location', true],
  ['We applied anything but Talstar P to the exterior perimeter.', 'subject', true],
  ['We applied Talstar P everywhere, including the exterior perimeter.', '', false],
  ['We applied Talstar P anywhere but the garage, including the exterior perimeter.', '', false],
  ['Anything but ordinary, Talstar P was applied to the exterior perimeter.', 'subject', false],
  ['We applied Talstar P all but perfectly to the exterior perimeter.', 'location', false],
])('spatial but-exclusions retain selected finding scope: %s', (text, precedingOwner, denied) => {
  const subjectAt = text.indexOf('Talstar P');
  const locationAt = text.indexOf('exterior perimeter');
  const precedingAt = precedingOwner === 'subject' ? subjectAt : locationAt;
  const precedingText = precedingOwner ? text.slice(0, precedingAt) : '';
  expect(grammar.reportClaimIsDenied(text, text, subjectAt, locationAt,
    /applied/g.exec(text), precedingText)).toBe(denied);
});

test.each([
  ["The technician'd have applied Talstar P to the exterior perimeter.", true],
  ['The technician’d already have applied Talstar P to the exterior perimeter.', true],
  ["Talstar P'd have been applied to the exterior perimeter.", true],
  ['EcoVia WSG’d have been applied to the exterior perimeter.', true],
  ["The technician'd applied Talstar P to the exterior perimeter.", false],
  ["Talstar P'd been applied to the exterior perimeter.", false],
  ['The technician had applied Talstar P to the exterior perimeter.', false],
])('noun-subject would-have contractions remain uncertain: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test('noun-subject had contraction retains completed perfect meaning without have', () => {
  const text = "Talstar P'd been applied to the exterior perimeter.";
  expect(grammar.reportHasCompletedPredicate(text, /applied/g.exec(text))).toBe(true);
  expect(grammar.reportFindingIsUncertain(text)).toBe(false);
});

test('an unrelated noun-subject modal stays outside bounded finding evidence', () => {
  const text = "The invoice'd have been paid, but Talstar P was applied to the exterior perimeter.";
  const findingEvidence = grammar.claimContext(text, text.indexOf('Talstar P'), text.length);
  expect(findingEvidence).not.toMatch(/invoice/i);
  expect(grammar.reportFindingIsUncertain(findingEvidence)).toBe(false);
});
