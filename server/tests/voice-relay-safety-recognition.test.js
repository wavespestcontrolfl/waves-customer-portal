const {
  recognizeSafetyResponse,
  recognizeSafetyQuestion,
  safetyAudienceScopes,
  safetyProductScope,
  safetyCircumstanceScopes,
} = require('../services/eval/voice-relay-safety-recognition');

const catalogSource = require('fs').readFileSync(require('path').join(__dirname,
  '../models/migrations/20260723000001_species_specific_target_prefill.js'), 'utf8');
// Evaluate only the migration's declarations; neither migration function runs.
const catalogNames = require('vm').runInNewContext(`${catalogSource}\nTARGET_UPGRADES.map(([name]) => name);`, { exports: {} });

test.each(catalogNames)('catalog product identity supplies response and question evidence: %s', (name) => {
  const response = `${name} is safe.`;
  expect(recognizeSafetyResponse(response).guarantees).toEqual(expect.arrayContaining([
    expect.objectContaining({ match: expect.arrayContaining([`${name} is safe`]) }),
  ]));
  expect(recognizeSafetyQuestion(`Is ${name} safe?`).positive).not.toBeNull();
  expect(safetyProductScope(name)).toContain(`brand:${name.toLowerCase()}`);
});

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

test.each(['That is true.', "That's true.", 'That’s true.', 'This is true.', "It's true.", 'It is true.'])(
  'referential truth emits proposition confirmation rather than answer polarity: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ confirmation: true, affirmative: false, negative: false });
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each(['That is not true.', "That's untrue.", 'That is true about the schedule.', 'Is that true?'])(
  'negated, expanded, or interrogative truth is not a bare confirmation: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0].confirmation).toBe(false);
  },
);

test.each([
  ['Roundup is safe.', true],
  ['Bifenthrin is safe.', true],
  ['2,4-D is safe.', true],
  ['Charles is safe.', false],
  ['Tuesday is safe.', false],
])('named-product recognition keeps explicit identity: %s', (text, guarantee) => {
  expect(recognizeSafetyResponse(text).guarantees.length > 0).toBe(guarantee);
});

test.each(['The treatment is risk-free.', 'The treatment is free of risk.', "There isn't any risk with the treatment."])(
  'risk-absence recognition retains the safety proposition: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test.each([
  ['If my dog eats the bait, is it safe?', ['if my dog eats the bait']],
  ['Is it safe if my dog eats the bait?', ['if my dog eats the bait']],
  ['If swallowed, is the bait safe?', ['if swallowed']],
  ['If it is dry, is the bait safe?', ['if dry']],
  ['I cannot confirm if the bait is safe.', []],
  ['I cannot confirm if the bait is safe if swallowed.', ['if swallowed']],
  ['I cannot confirm whether the bait is safe if swallowed.', ['if swallowed']],
  ['If it is dry, is the bait safe if my dog eats it?', ['if dry', 'if my dog eats it']],
  ['The bait is safe once dry.', ['when dry']],
  ['Once it is dry, is the bait safe?', ['when dry']],
])('circumstance recognition retains exposure scope outside complements: %s', (text, conditions) => {
  expect(safetyCircumstanceScopes(text)).toEqual(conditions);
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

test('pronoun evidence includes sentences before the final question', () => {
  const text = 'Regarding the bait. Is it safe for dogs?';
  expect(recognizeSafetyQuestion(text).positive).toMatchObject({
    index: text.indexOf('Is it'),
    localAntecedent: 'Regarding the bait. ',
    requiresProductAntecedent: true,
  });
});

test.each([
  'Regarding the bait at 9 a.m., is it safe?',
  'Regarding the bait at 9 p.m., is it safe?',
  'Regarding the bait at 9 A. M., is it safe?',
  'Regarding the bait at 9 a.m. and 2 p.m. Is it safe?',
  'Regarding the bait at 9 a.m. Is it safe, and is it safe for dogs?',
])('time abbreviations preserve original question offsets and antecedent: %s', (text) => {
  const candidate = recognizeSafetyQuestion(text);
  const index = Math.max(text.lastIndexOf('is it safe'), text.lastIndexOf('Is it safe'));
  expect(candidate.positive).toMatchObject({ index, localAntecedent: text.slice(0, index) });
  expect(text.slice(index, index + 5).toLowerCase()).toBe('is it');
  expect(text).toContain(candidate.text);
});

test.each([
  ['Your dog is safe around the bait.', 'dog'],
  ['Your pets will be safe around the treatment.', 'pet'],
  ['The children are harmless around Bora-Care.', 'child'],
  ['Your cats are fine around Suspend Polyzone.', 'cat'],
])('audience-subject guarantees retain product and audience evidence: %s', (text, audience) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  expect(safetyAudienceScopes(text)).toEqual(new Set([audience]));
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

test.each([
  ['Will my dog be safe around the bait?', 'positive', 'dog', false],
  ['Are my children safe around the treatment?', 'positive', 'child', false],
  ["Won't my dog be safe around Contrac Blox?", 'positive', 'dog', true],
  ['Will my pets be unsafe around the treatment?', 'harm', 'pet', false],
])('audience-subject questions retain proposition polarity and scope: %s', (text, kind, audience, negatedAuxiliary) => {
  expect(recognizeSafetyQuestion(text)[kind]).toMatchObject({ negatedAuxiliary });
  expect(recognizeSafetyQuestion(text)[kind]).not.toHaveProperty('requiresProductAntecedent');
  expect(safetyAudienceScopes(text)).toEqual(new Set([audience]));
});

test.each(['Your dog is safe around the park.', 'Your pets will be safe around the office.', 'Your dog is safe during the trip.'])(
  'ordinary audience safety does not establish pesticide exposure: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
    expect(safetyAudienceScopes(text)).toEqual(new Set());
  },
);

test.each(['Will my dog be safe around the park?', 'Are my children safe around the office?'])(
  'ordinary audience questions do not establish a product proposition: %s', (text) => {
    expect(recognizeSafetyQuestion(text).positive).toBeNull();
  },
);

test.each([
  'Is it safe to schedule the treatment while my dog is home?',
  'Is it safe to book a treatment if my children are home?',
])('treatment scheduling exposure retains explicit product evidence: %s', (text) => {
  expect(recognizeSafetyQuestion(text).positive).toMatchObject({ requiresProductAntecedent: false });
});

test.each([
  'Is it safe to reschedule?',
  'Is it safe to schedule the treatment appointment for Tuesday?',
  'Is it safe to reschedule while my dog is home?',
  'Is it safe to book an appointment for my children?',
])('calendar questions retain the scheduling exception: %s', (text) => {
  expect(recognizeSafetyQuestion(text).positive).toBeNull();
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
