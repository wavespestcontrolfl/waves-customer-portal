const { recognizeSafetyQuestion } = require('../services/eval/voice-relay-safety-question-recognition');

const catalogSource = require('fs').readFileSync(require('path').join(__dirname,
  '../models/migrations/20260723000001_species_specific_target_prefill.js'), 'utf8');
// Evaluate only the migration's declarations; neither migration function runs.
const catalogNames = require('vm').runInNewContext(`${catalogSource}\nTARGET_UPGRADES.map(([name]) => name);`, { exports: {} });

test.each(catalogNames)('catalog product identity supplies question evidence: %s', (name) => {
  expect(recognizeSafetyQuestion(`Is ${name} safe?`).positive).not.toBeNull();
});

const productCatalogNames = require('../fixtures/voice-relay-eval/product-catalog-names.json');
const abbreviatedCatalogName = productCatalogNames.find((name) => name.includes('50 lb. Bag'));

test('a catalog name with an internal abbreviation period still yields question evidence', () => {
  expect(abbreviatedCatalogName).toBe(
    'LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag',
  );
  const question = recognizeSafetyQuestion(`Is ${abbreviatedCatalogName} safe?`);
  expect(question.positive).not.toBeNull();
  expect(question.positive.evidence).toBeNull();
  expect(question.positive.crossesSentenceBoundary).toBe(true);
});

test.each([
  ['The treatment is safe for dogs, right?', 'positive', 'safe', 'dog'],
  ['Bora-Care is harmless to children, isn’t it?', 'positive', 'harmless', 'child'],
  // A multi-letter formulation code: bare one-letter codes are no longer a
  // product identity in the shared brand grammar (#4596).
  ['Example XTS is safe for cats, right?', 'positive', 'safe', 'cat'],
  ['The treatment is not safe for dogs, right?', 'positive', 'not safe', 'dog'],
  ['The treatment is harmful to pets, right?', 'harm', 'harmful', 'pet'],
  ['The treatment is not harmful to pets, isn’t it?', 'harm', 'not harmful', 'pet'],
])('declarative tags retain assertion polarity independently of the tag: %s', (text, kind, predicate, audience) => {
  expect(recognizeSafetyQuestion(text)[kind]).toMatchObject({ predicate, negatedAuxiliary: false });
});

test.each(['Blue sky is safe, right?', 'The appointment is safe, right?', 'It is safe to reschedule, right?'])(
  'declarative tag controls preserve product identity and calendar scope: %s', (text) => {
    expect(recognizeSafetyQuestion(text).positive).toBeNull();
  },
);

test('declarative pronoun tags retain antecedent and source offset', () => {
  const text = 'Regarding the bait. It is safe for dogs, right?';
  expect(recognizeSafetyQuestion(text).positive).toMatchObject({
    index: text.indexOf('It is'), localAntecedent: 'Regarding the bait. ', requiresProductAntecedent: true,
  });
});

test.each([
  ['Is the treatment risk-free?', 'risk'],
  ['Does the treatment pose no risk to dogs?', 'pose no risk'],
])('risk-absence candidates retain the full proposition for polarity policy: %s', (text, predicate) => {
  expect(recognizeSafetyQuestion(text)).toMatchObject({
    text: text.slice(0, -1), positive: null, harm: { predicate, negatedAuxiliary: false },
  });
});

test.each([
  'Should the treatment be safe for dogs?',
  'Was the bait safe for pets?',
  'Were the treatments safe for dogs?',
  'May the treatment be safe for dogs?',
  'Might the treatment be safe for dogs?',
  'Has the treatment been safe for dogs?',
  'Have the treatments been safe for dogs?',
  'Had the treatment been safe for dogs?',
  'Shall the treatment be safe for dogs?',
  'Must the treatment be safe for dogs?',
])(
  'shared question auxiliary retains product-safety evidence: %s', (text) => {
    expect(recognizeSafetyQuestion(text).positive)
      .toMatchObject({ negatedAuxiliary: false });
  },
);

test.each(["Wasn't the bait safe for pets?", "Weren't the treatments safe for dogs?", "Shouldn't the treatment be safe for dogs?"])(
  'negated shared auxiliary retains its own polarity: %s', (text) => {
    expect(recognizeSafetyQuestion(text).positive).toMatchObject({ negatedAuxiliary: true });
  },
);

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
  ['Will my dog be safe around the bait?', 'positive', 'dog', false],
  ['Are my children safe around the treatment?', 'positive', 'child', false],
  ["Won't my dog be safe around Contrac Blox?", 'positive', 'dog', true],
  ['Will my pets be unsafe around the treatment?', 'harm', 'pet', false],
])('audience-subject questions retain proposition polarity and scope: %s', (text, kind, audience, negatedAuxiliary) => {
  expect(recognizeSafetyQuestion(text)[kind]).toMatchObject({ negatedAuxiliary });
  expect(recognizeSafetyQuestion(text)[kind]).not.toHaveProperty('requiresProductAntecedent');
});

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

test.each([
  ['The treatment is safe for dogs right', 'positive', 'safe'],
  ['The treatment is safe for dogs right?', 'positive', 'safe'],
  ['Bora-Care is harmless to children isn’t it', 'positive', 'harmless'],
  ['The treatment is not safe for dogs right', 'positive', 'not safe'],
  ['The treatment is harmful to pets correct', 'harm', 'harmful'],
  ['The treatment is not harmful to pets right', 'harm', 'not harmful'],
  ['Your dog is safe around the bait right', 'positive', 'safe'],
])('unpunctuated declarative tags retain their predicate: %s', (text, kind, predicate) => {
  const candidate = recognizeSafetyQuestion(text)[kind];
  expect(candidate).toMatchObject({ predicate, negatedAuxiliary: false });
  expect(text.slice(candidate.evidence.index, candidate.evidence.end)).toBe(candidate.evidence.text);
});

test.each([
  'Blue sky is safe right',
  'The appointment is safe right',
  'It is safe to reschedule right',
  'The treatment is safe right away',
  'The treatment is safe if the schedule is correct',
])('tag controls retain product identity and complete tag boundaries: %s', (text) => {
  expect(recognizeSafetyQuestion(text).positive).toBeNull();
});

test('a later unpunctuated tag replaces an unrelated earlier question', () => {
  const text = 'Are you open? Regarding the bait. It is safe for dogs right';
  expect(recognizeSafetyQuestion(text)).toMatchObject({
    text: ' It is safe for dogs right',
    positive: {
      predicate: 'safe', negatedAuxiliary: false, requiresProductAntecedent: true,
      index: text.indexOf('It is'), localAntecedent: text.slice(0, text.indexOf('It is')),
    },
  });
});

test.each([
  'Is the bait safe? Call the office if swallowed.',
  'Is the bait safe. Call the office if swallowed.',
  'Regarding the bait. Is it safe? Call the office if swallowed.',
])('conditions in a following sentence stay outside question evidence: %s', (text) => {
  expect(recognizeSafetyQuestion(text).positive.evidence.conditions).toEqual([]);
});

test.each([
  ['If swallowed, is the bait safe?', ['If swallowed']],
  ['If swallowed is the bait safe?', ['If swallowed']],
  ['If my dog eats the bait is it safe?', ['If my dog eats the bait']],
  ['If it is dry is the bait safe?', ['If it is dry']],
  ['Is the bait safe if swallowed?', ['if swallowed']],
  ['If it is dry, is the bait safe if swallowed?', ['If it is dry', 'if swallowed']],
  ['At 9 a.m., is the bait safe once dry?', ['once dry']],
])('question conditions retain exact marker and body offsets: %s', (text, conditions) => {
  const evidence = recognizeSafetyQuestion(text).positive.evidence;
  expect(evidence.conditions.map((condition) => condition.text)).toEqual(conditions);
  for (const condition of evidence.conditions) {
    for (const span of [condition, condition.marker, condition.body]) {
      expect(text.slice(span.index, span.end)).toBe(span.text);
    }
    expect(condition.index).toBeGreaterThanOrEqual(evidence.sentence.index);
    expect(condition.end).toBeLessThanOrEqual(evidence.sentence.end);
  }
});

test('drying followup evidence retains its original conditional phrase', () => {
  const text = 'The bait was applied at 4 p.m. What about while it is wet?';
  const question = recognizeSafetyQuestion(text);
  expect(question.dryingFollowup).toBe(true);
  expect(question.dryingEvidence.adjacentConnectives[0].marker).toMatchObject({ text: 'while', index: text.indexOf('while') });
  expect(question.dryingEvidence.adjacentConnectives[0].body.text).toBe(' it is wet');
  expect(question.dryingEvidence.adjacentConnectives[0].relation).toBe('unresolved');
  expect(question.dryingEvidence.conditions).toEqual([]);
  expect(text.slice(question.dryingEvidence.index, question.dryingEvidence.end)).toBe(question.dryingEvidence.text);
});


test.each(['Yes. I cannot confirm whether the bait is safe. Actually, yes.', 'That is correct.', 'Let me check. Yes.'])(
  'an ordinary answer ending in a tag word retains its original turn: %s', (text) => {
    expect(recognizeSafetyQuestion(text)).toMatchObject({ text, positive: null, harm: null, dryingFollowup: false });
  },
);

test('an unpunctuated leading condition ends at the actual question auxiliary', () => {
  const text = 'If it is dry is the bait safe?';
  const evidence = recognizeSafetyQuestion(text).positive.evidence;
  expect(evidence).toMatchObject({ text: 'is the bait safe', index: text.indexOf('is the bait') });
  expect(evidence.conditions[0]).toMatchObject({ text: 'If it is dry', position: 'before', end: text.indexOf(' is the bait') });
});

test.each([
  ['Regarding the bait. Is the credit safe?', true],
  ['Regarding the bait. Is it safe?', false],
])('a pronoun subject requires its own leading word boundary, not a bare tail match: %s', (text, expectNull) => {
  const positive = recognizeSafetyQuestion(text).positive;
  if (expectNull) expect(positive).toBeNull();
  else expect(positive).not.toBeNull();
});

test.each([
  'Is it dangerous to reschedule?',
  'Would it be harmful to cancel?',
])('the scheduling exception also applies to harm predicates: %s', (text) => {
  expect(recognizeSafetyQuestion(text).harm).toBeNull();
});

test('a harm question outside the scheduling exception still yields a candidate', () => {
  expect(recognizeSafetyQuestion('Is it dangerous to use?').harm).not.toBeNull();
});

test.each([
  ["If the bait isn't dry, is the spray safe?", false],
  ["If the bait is dry, isn't the spray safe?", true],
])('negatedAuxiliary reflects the actual question auxiliary, not a leading condition: %s', (text, negatedAuxiliary) => {
  expect(recognizeSafetyQuestion(text).positive).toMatchObject({ negatedAuxiliary });
});

test('options.productNames recognizes a live product not in the static catalog', () => {
  expect(recognizeSafetyQuestion('Is EcoGuard Wonder safe?', { productNames: ['EcoGuard Wonder'] }).positive).not.toBeNull();
});

test('a live product name is not recognized without options.productNames', () => {
  expect(recognizeSafetyQuestion('Is EcoGuard Wonder safe?').positive).toBeNull();
});

test('static catalog names are unaffected by options.productNames', () => {
  expect(recognizeSafetyQuestion('Is the bait safe?', { productNames: ['EcoGuard Wonder'] }).positive).not.toBeNull();
});

test.each([
  'Can you please confirm whether the bait is safe?',
  'Would you please check whether the bait is safe?',
  'Can you please let me know whether the bait is safe?',
])('the polite modifier is accepted on every indirect-question verb: %s', (text) => {
  expect(recognizeSafetyQuestion(text).positive).not.toBeNull();
});

test.each([
  'Can you confirm whether the bait is safe?',
  'Would you check whether the bait is safe?',
])('the polite modifier remains optional: %s', (text) => {
  expect(recognizeSafetyQuestion(text).positive).not.toBeNull();
});
