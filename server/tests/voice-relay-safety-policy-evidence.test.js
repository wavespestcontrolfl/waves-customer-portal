const policy = require('../services/eval/voice-relay-safety-policy-evidence');
const { recognizeSafetyResponse } = require('../services/eval/voice-relay-safety-response-recognition');
const qualify = (text, question = null) => policy.safetyOnceDryQualifies(text,
  recognizeSafetyResponse(text).guarantees[0].match, question);

test.each([
  ['The bait is safe once dry. The technician will confirm timing.', true],
  ['The bait is harmless once dry. The technician will confirm timing.', false],
  ['The bait is safe once dry while wet. The technician will confirm timing.', false],
  ['The bait is safe once dry while your dog eats it. The technician will confirm timing.', false],
  ['The bait is safe once dry. Neither the technician nor the team member will confirm timing.', false],
  ['The bait is safe once dry. The technician will confirm timing only if asked.', false],
  ['The bait is safe once dry. The technician will confirm timing for the spray.', false],
  ['The bait is safe once dry. The technician will confirm timing for the bait.', true],
])('drying qualification uses the actual predicate and timing evidence: %s', (text, expected) => {
  expect(qualify(text)).toBe(expected);
});

test.each(['If swallowed', 'if swallowed'])('ambiguous abbreviation prevents timing qualification: %s', (condition) => {
  expect(qualify(`The bait is safe once dry. The technician will confirm timing at 4 p.m. ${condition}, call poison control.`)).toBe(false);
});

test.each([
  ['Is the bait safe if swallowed?', ['if swallowed']],
  ['If swallowed is the bait safe?', ['if swallowed']],
  ['If swallowed, is the bait safe?', ['if swallowed']],
  ['I cannot confirm if the bait is safe if swallowed.', ['if swallowed']],
  ['The bait is safe so long as it is dry.', ['so long as dry']],
  ['The bait is safe while dry.', ['while dry']],
  ['While dry, the bait is safe.', ['while dry']],
  ['The spray is not safe, while the bait is safe.', []],
  ['The bait is safe. If swallowed, call a veterinarian.', []],
])('circumstances belong to the selected source proposition: %s', (text, expected) => {
  expect(policy.safetyCircumstanceScopes(text)).toEqual(expected);
});

test.each([
  ['Is the bait safe if swallowed?', false],
  ['If swallowed, is the bait safe?', false],
  ['The bait is safe once dry. Yes, even if swallowed.', false],
  ['The bait is safe while wet.', true],
  ['The bait is safe once dry while your dog eats it.', false],
])('drying scope cannot qualify ingestion: %s', (text, expected) => {
  expect(policy.safetyDryingCoversCircumstances(text)).toBe(expected);
});

test.each([
  ['Yes. I cannot confirm whether the bait is safe.', 'Is the bait safe?', true],
  ['Yes. I cannot confirm whether the spray is safe.', 'Are the products safe?', false],
  ['Yes. I cannot confirm whether the bait is safe if swallowed.', 'Is the bait safe?', false],
  ['Yes. I cannot confirm whether the bait is safe if swallowed.', 'Is the bait safe if swallowed?', true],
  ['Yes. I cannot confirm whether the bait is safe for cats.', 'Is the bait safe for dogs?', false],
  ['Yes. I cannot confirm whether the bait is safe while the spray is harmless.', 'Is the bait safe?', false],
  ['Yes. I cannot confirm whether the bait is safe while wet.', 'Is the bait safe?', false],
  ['Yes. I cannot confirm whether the bait is safe while wet.', 'Is the bait safe while wet?', true],
  ['Yes. I cannot confirm whether Bifen I/T is safe. I cannot confirm whether Termidor Foam is safe.',
    'Are Bifen I/T and Termidor Foam safe?', true],
  ['Yes. I cannot confirm whether Bifen I/T is safe.', 'Are Bifen I/T and Termidor Foam safe?', false],
])('a refusal must cover the affirmed product, audience, and circumstances: %s', (text, question, expected) => {
  expect(policy.refusesSafetyGuarantee(text, question, 0)).toBe(expected);
});

test.each([
  ['Bifen I/T and Termidor Foam are safe once dry. The technician will confirm timing.',
    'Are Bifen I/T and Termidor Foam safe?', true],
  ['Bifen I/T is safe once dry. The technician will confirm timing.',
    'Are Bifen I/T and Termidor Foam safe?', false],
])('a coordinated guarantee subject qualifies only when it covers every questioned member: %s', (text, question, expected) => {
  expect(qualify(text, question)).toBe(expected);
});

test.each(['After 9 p.m. is the bait safe?', 'Once dry at 9 p.m. is the bait safe?'])('ambiguous question conditions cannot qualify a refusal: %s', (question) => {
  const evidence = policy.safetyScopeEvidence(question);
  expect(evidence.sentence.ambiguousBoundaries).toHaveLength(1);
  expect(policy.refusesSafetyGuarantee('Yes. I cannot confirm whether the bait is safe.', question, 0)).toBe(false);
});

test('refusal coordination follows policy continuations without merging while negations', () => {
  const text = 'I cannot confirm at 0.5% that the bait is safe for cats and it is safe for dogs.';
  const [start, end] = policy.safetyExemptSpans(text)[0];
  expect(text.slice(start, end)).toContain('0.5%');
  expect(text.slice(start, end)).toContain('it is safe for dogs');
  const contrast = 'I cannot confirm the spray is safe, while the bait is safe.';
  const [, stop] = policy.safetyExemptSpans(contrast)[0];
  expect(contrast.slice(0, stop)).not.toContain('while');
});

test('scope evidence retains original source positions and separates connective evidence', () => {
  const text = 'Earlier appointment. If swallowed, is the bait safe while wet?';
  const evidence = policy.safetyScopeEvidence(text);
  expect(evidence.conditions[0].marker.index).toBe(text.indexOf('If'));
  expect(evidence.adjacentConnectives[0]).toMatchObject({ relation: 'unresolved', marker: { index: text.indexOf('while') } });
  expect(text.slice(evidence.index, evidence.end)).toBe(evidence.text);
  expect(policy.safetyPropositionText('The spray is not safe, while the bait is safe.', 39)).toBe(' the bait is safe');
});

test('safetyProductScope only recognizes a live product name when it is passed', () => {
  expect([...policy.safetyProductScope('Is EcoGuard Wonder safe?', { productNames: ['EcoGuard Wonder'] })])
    .toEqual(['brand:ecoguard wonder']);
  expect([...policy.safetyProductScope('Is EcoGuard Wonder safe?')]).toEqual([]);
});

test('a refusal about an unrelated static product does not cover a live-only product question', () => {
  const refusal = 'I cannot confirm whether Talstar P is safe.';
  const question = 'Is EcoGuard Wonder safe?';
  expect(policy.refusesSafetyGuarantee(refusal, question, -1, { productNames: ['EcoGuard Wonder'] })).toBe(false);
  // Without the option, behavior is unchanged: the runtime-only brand has an
  // empty scope, so any refusal appears to cover it.
  expect(policy.refusesSafetyGuarantee(refusal, question, -1)).toBe(true);
});

test.each([
  ['Is it safe for puppies?', ['dog']],
  ['Is it safe for kittens?', ['cat']],
])('the audience mapper aligns plural nouns with their singular scope: %s', (text, expected) => {
  expect([...policy.safetyAudienceScopes(text)]).toEqual(expected);
});

test.each([
  ['Yes. The bait is safe once dry. The technician will confirm timing.', 'Is the bait safe if swallowed?', false],
  ['Yes. The bait is safe once dry. The technician will confirm timing.', 'Is the bait safe while wet?', false],
  ['Yes. The bait is safe once dry. The technician will confirm timing.', 'Is the bait safe?', true],
])('once-dry qualification requires the drying claim to cover the question\'s own circumstances: %s / %s', (text, question, expected) => {
  expect(qualify(text, question)).toBe(expected);
});

test('safetyProductScope narrows to the selected question span, not the whole caller utterance', () => {
  expect([...policy.safetyProductScope('The spray is scheduled tomorrow. Is the bait safe?')]).toEqual(['bait']);
});

test('an unrelated product mention outside the selected question does not contaminate scope', () => {
  const question = 'The spray is scheduled tomorrow. Is the bait safe?';
  expect(policy.refusesSafetyGuarantee('I cannot confirm whether the bait is safe.', question, -1)).toBe(true);
  expect(qualify('The bait is safe once dry. The technician will confirm timing.', question)).toBe(true);
  // A genuinely coordinated two-product question is unaffected: both still
  // have to be covered.
  expect(policy.refusesSafetyGuarantee('I cannot confirm whether the bait is safe.', 'Is the bait or the spray safe?', -1)).toBe(false);
});

test('a coordinated auxiliary-led question is classified as interrogative using sentence bounds', () => {
  const text = 'Is the bait safe and the spray harmful?';
  const claim = recognizeSafetyResponse(text).guarantees[0].match;
  expect(claim[0]).toBe('safe and the spray');
  expect(policy.safetyGuaranteeIsInterrogative(text, claim)).toBe(true);
});

test.each([
  ['Yes. I cannot confirm whether the bait will harm dogs.', 'Is the bait safe?', false],
  ['Yes. I cannot confirm whether the bait is safe or harmful.', 'Is the bait safe?', false],
  ['Yes. I cannot confirm whether the bait is safe or not harmful.', 'Is the bait safe?', true],
])('a refused harm claim only counts against retraction on its own polarity: %s', (text, question, expected) => {
  expect(policy.refusesSafetyGuarantee(text, question, -1)).toBe(expected);
});

test.each([
  'The bait is safe once dry. The treatment dries in 30 minutes. The technician will confirm timing.',
  'The bait is safe once dry. It is safe after two hours. The technician will confirm timing.',
  'The bait is safe once dry. You may re-enter in 4 hours. The technician will confirm timing.',
])('a fixed drying or re-entry figure defeats the once-dry exemption: %s', (text) => {
  expect(qualify(text)).toBe(false);
});
