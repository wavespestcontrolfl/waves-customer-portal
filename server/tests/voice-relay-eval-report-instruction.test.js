const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES, _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

// Each classifier receives bounded evidence selected by its consumer. Passing
// completion alone does not confirm a product, target, date or report readback.

test('report grammar has no runner or value-rule registration', () => {
  expect(SPOKEN_CHECK_RUNNERS).not.toHaveProperty('report_readback_confirms');
  expect(SPOKEN_CHECK_VALUE_RULES).not.toHaveProperty('report_readback_confirms');
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

test.each([
  'We requested that invoice, Talstar P was applied to the exterior perimeter.',
  'At your request that morning, Talstar P was applied to the exterior perimeter.',
  'We received your request that morning, Talstar P was applied to the exterior perimeter.',
])('demonstrative that does not create a request complement: %s', (text) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(false);
});

test('active request-that subjunctive governs the invariant put verb', () => {
  const text = 'We requested that Sam put Talstar P around the exterior perimeter.';
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /put/.exec(text), text.length)).toBe(true);
});

test('asked-for confirmation governs only its own finding', () => {
  const requested = 'We asked for confirmation that Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportFindingIsInstruction(requested, requested.indexOf('Talstar P'),
    requested.indexOf('exterior perimeter'), /applied/.exec(requested), requested.length)).toBe(true);

  const received = 'We received confirmation that Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportFindingIsInstruction(received, received.indexOf('Talstar P'),
    received.indexOf('exterior perimeter'), /applied/.exec(received), received.length)).toBe(false);

  const unrelated = 'We asked for confirmation that the invoice was paid, Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportFindingIsInstruction(unrelated, unrelated.indexOf('Talstar P'),
    unrelated.indexOf('exterior perimeter'), /applied/.exec(unrelated), unrelated.length)).toBe(false);
});

test.each([
  'We, according to the report, have applied Talstar P to the exterior perimeter.',
  'We, as documented, have had Talstar P applied to the exterior perimeter.',
  'We, according to the report, have already applied Talstar P to the exterior perimeter.',
])('perfect auxiliary after an aside is not an imperative: %s', (text) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(false);
});

test.each(['succeeded in applying', 'finished applying', 'completed applying', 'managed to apply'])('perfect completion governor %s after an aside is not an imperative', (completion) => {
  const text = `We, as documented, have ${completion} Talstar P to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /\b(?:apply|applying)\b/.exec(text), text.length)).toBe(false);
});

test.each(['only', 'just', 'merely', 'simply'])('perfect affirmative focus %s after an aside is not an imperative', (focus) => {
  const text = `We, as documented, have not ${focus} applied Talstar P to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /applied/.exec(text), text.length)).toBe(false);
});

test.each([
  ['We asked the technician to confirm that', 'We asked the technician to confirm the invoice was paid,'],
  ['We requested our crew to verify that', 'We requested our crew to verify the invoice was paid,'],
  ['I asked Sam Jones to check whether', 'I asked Sam Jones to check the invoice,'],
])('request to another recipient governs only its own finding: %s', (governor, unrelatedGovernor) => {
  const requested = `${governor} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(requested, requested.indexOf('Talstar P'),
    requested.indexOf('exterior perimeter'), /applied/.exec(requested), requested.length)).toBe(true);

  const unrelated = `${unrelatedGovernor} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsInstruction(unrelated, unrelated.indexOf('Talstar P'),
    unrelated.indexOf('exterior perimeter'), /applied/.exec(unrelated), unrelated.length)).toBe(false);
});

test.each([
  ['Check the invoice, we managed to apply Talstar P around the exterior perimeter.', false],
  ['Check that we managed to apply Talstar P around the exterior perimeter.', true],
  ['Check the invoice, we applied Talstar P around the exterior perimeter.', false],
  ['Check the invoice, we succeeded in applying Talstar P around the exterior perimeter.', false],
  ['Check that we succeeded in applying Talstar P around the exterior perimeter.', true],
  ['Please apply Talstar P around the exterior perimeter.', true],
  ['We managed to apply Talstar P around the exterior perimeter.', false],
  ['Please confirm that, as we had discussed, Talstar P was applied to the exterior perimeter.', true],
  ['Please confirm whether, as we were told, Talstar P was applied to the exterior perimeter.', true],
  ['Please confirm that, as we previously discussed, Talstar P was applied to the exterior perimeter.', true],
  ['Please confirm that, as we had agreed, Talstar P was applied to the exterior perimeter.', true],
  ['Please confirm that, as discussed, Talstar P was applied to the exterior perimeter.', true],
  ['Please confirm that we had discussed the invoice, Talstar P was applied to the exterior perimeter.', false],
  ['Please confirm whether we were told the invoice was paid, Talstar P was applied to the exterior perimeter.', false],
  ['Check that invoice, we managed to apply Talstar P around the exterior perimeter.', false],
  ['Check that invoice, we were able to apply Talstar P around the exterior perimeter.', false],
  ['Please check that invoice, Talstar P was applied to the exterior perimeter.', false],
  ['Confirm that bait, Talstar P were applied to the exterior perimeter.', true],
  ['We, according to the report, have confirmed that Talstar P was applied to the exterior perimeter.', false],
  ['We, as documented, have verified that Talstar P was applied to the exterior perimeter.', false],
  ['We, according to the report, have checked that Talstar P was applied to the exterior perimeter.', false],
  ['Please have the technician confirm that Talstar P was applied to the exterior perimeter.', true],
  ['Please have Talstar P applied to the exterior perimeter.', true],
  ['Please confirm, after reviewing the report, that Talstar P was applied to the exterior perimeter.', true],
  ['Please verify, according to the report, whether Talstar P was applied to the exterior perimeter.', true],
  ['Please confirm the invoice, after reviewing the report, Talstar P was applied to the exterior perimeter.', false],
  ['Please confirm the invoice, after reviewing the report, that technician applied Talstar P around the exterior perimeter.', false],
  ['Check the invoice, according to the report, that technician applied Talstar P around the exterior perimeter.', false],
  ['Check the invoice, we, according to the report, applied Talstar P around the exterior perimeter.', false],
  ['Check that we, according to the report, applied Talstar P around the exterior perimeter.', true],
  ['We, according to the report, applied Talstar P around the exterior perimeter.', false],
  ['We, according to the report, put Talstar P around the exterior perimeter yesterday.', false],
  ['Please, according to the report, put Talstar P around the exterior perimeter.', true],
  ['Put Talstar P around the exterior perimeter.', true],
])('resultative comma boundary keeps instruction scope: %s', (text, instruction) => {
  expect(grammar.reportFindingIsInstruction(text, text.indexOf('Talstar P'),
    text.indexOf('exterior perimeter'), /\b(?:applied?|applying)\b/.exec(text), text.length)).toBe(instruction);
});
