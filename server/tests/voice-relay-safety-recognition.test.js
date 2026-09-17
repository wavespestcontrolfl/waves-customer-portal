const {
  recognizeSafetyResponse,
  recognizeSafetyQuestion,
} = require('../services/eval/voice-relay-safety-recognition');

test('recognition retains refused and qualified propositions for context policy', () => {
  const text = 'Yes. I cannot confirm whether the bait is safe for dogs. The bait is safe once dry. The technician will confirm timing.';
  const candidates = recognizeSafetyResponse(text);
  expect(candidates.answers[0]).toMatchObject({ text: 'Yes', index: 0, affirmative: true });
  const claims = candidates.guarantees.map(({ match }) => ({ text: match[0], index: match.index }));
  expect(claims).toEqual(expect.arrayContaining([
    { text: 'the bait is safe', index: text.indexOf('the bait is safe') },
    { text: 'The bait is safe', index: text.indexOf('The bait is safe') },
  ]));
  for (const { text: claim, index } of claims) expect(text.slice(index, index + claim.length)).toBe(claim);
});

test('pronoun candidates retain the product prefix and match offset', () => {
  const text = 'Regarding the bait, is it safe for dogs?';
  expect(recognizeSafetyQuestion(text).positive).toMatchObject({
    index: text.indexOf('is it'),
    localAntecedent: 'Regarding the bait, ',
    requiresProductAntecedent: true,
  });
  expect(recognizeSafetyQuestion('Is it safe for dogs?').positive).toMatchObject({ requiresProductAntecedent: true });
  expect(recognizeSafetyQuestion('Is the bait safe for dogs?').positive).not.toHaveProperty('requiresProductAntecedent');
});

test.each([
  ['What about while it is wet?', true],
  ['And while wet?', true],
  ['Even before it dries completely?', true],
  ['While it is wet outside?', true],
  ['While wet, though?', true],
  ['While it is wet where dogs play?', true],
  ['While wet, is that right?', true],
  ['What about an appointment while wet?', false],
  ['And while wet, can we schedule an appointment?', false],
  ['While it is wet outside, can we book an appointment?', false],
])('recognition distinguishes condition evidence from independent questions: %s', (text, dryingFollowup) => {
  expect(recognizeSafetyQuestion(text).dryingFollowup).toBe(dryingFollowup);
});
