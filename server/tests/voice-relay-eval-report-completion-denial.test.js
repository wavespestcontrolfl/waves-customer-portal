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
