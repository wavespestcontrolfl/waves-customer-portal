const { recognizeSafetyResponse, SAFETY_NO_RISK_RE } = require('../services/eval/voice-relay-safety-response-recognition');

const catalogSource = require('fs').readFileSync(require('path').join(__dirname,
  '../models/migrations/20260723000001_species_specific_target_prefill.js'), 'utf8');
// Evaluate only the migration's declarations; neither migration function runs.
const catalogNames = require('vm').runInNewContext(`${catalogSource}\nTARGET_UPGRADES.map(([name]) => name);`, { exports: {} });

test.each(catalogNames)('catalog product identity supplies response evidence: %s', (name) => {
  const response = `${name} is safe.`;
  expect(recognizeSafetyResponse(response).guarantees).toEqual(expect.arrayContaining([
    expect.objectContaining({ match: expect.arrayContaining([`${name} is safe`]) }),
  ]));
});

const productCatalogNames = require('../fixtures/voice-relay-eval/product-catalog-names.json');

test('the product-catalog fixture is a non-empty list of distinct trimmed names', () => {
  expect(Array.isArray(productCatalogNames)).toBe(true);
  expect(productCatalogNames.length).toBeGreaterThan(100);
  expect(new Set(productCatalogNames).size).toBe(productCatalogNames.length);
  for (const name of productCatalogNames) expect(name).toBe(name.trim());
});

// Every catalog product the relay could read back from a visit's service
// products must supply guarantee evidence with exact spans, including names
// that end in punctuation such as "(OMRI)".
test.each(productCatalogNames)('full-catalog product identity supplies response evidence: %s', (name) => {
  const text = `Yes, ${name} is safe for pets.`;
  const claims = recognizeSafetyResponse(text).guarantees.map(({ match }) => ({ text: match[0], index: match.index }));
  expect(claims).toEqual(expect.arrayContaining([{ text: `${name} is safe`, index: text.indexOf(name) }]));
  for (const { text: claim, index } of claims) expect(text.slice(index, index + claim.length)).toBe(claim);
});

test('a candidate straddling a selected sentence boundary is kept, flagged, and carries no local evidence', () => {
  const text = 'Yes, LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag is safe for pets.';
  const [claim] = recognizeSafetyResponse(text).guarantees;
  expect(claim.match[0]).toBe('LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag is safe');
  expect(claim).toMatchObject({ evidence: null, crossesSentenceBoundary: true });
  const [ordinary] = recognizeSafetyResponse('Yes, Taurus SC is safe for pets.').guarantees;
  expect(ordinary.crossesSentenceBoundary).toBeUndefined();
  expect(ordinary.evidence).toMatchObject({ kind: 'safety-proposition' });
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

test.each([
  'Roundup IS safe.',
  'Roundup is SAFE.',
  'roundup IS SAFE.',
  'Bora-Care IS GENERALLY SAFE.',
  'SUSPEND POLYZONE is SAFE.',
  'Talstar P IS safe.',
  'Talstar P is FINE.',
  'Example XTS IS SAFE.',
  'Roundup WILL NOT HARM dogs.',
  'Roundup will not HARM dogs.',
  'Contrac Blox CANNOT HARM pets.',
  'Example XTS WON’T HURT dogs.',
])('named product predicates retain case-insensitive wording: %s', (text) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

test.each([
  'Charles is SAFE.',
  'Tuesday IS safe.',
  'Blue sky IS SAFE.',
  'Blue sky WILL NOT HARM dogs.',
  'Example x IS SAFE.',
  'EXAMPLE X WON’T HURT dogs.',
  'Roundup IS NOT SAFE.',
  'Roundup WILL HARM dogs.',
])('predicate casing preserves identity and negation controls: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
});

test.each([
  ['The treatment will keep your dog safe.', 'dog'],
  ['Bora-Care keeps children safe.', 'child'],
  ['Bora-Care KEEPS children SAFE.', 'child'],
  ['Example XTS will keep your pets safe.', 'pet'],
])('noncopular product guarantees retain protected audiences: %s', (text, audience) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

test.each([
  'The appointment will keep your dog safe.',
  'Blue sky keeps children safe.',
  'Example x will keep your pets safe.',
  'The treatment will not keep your dog safe.',
  'Bora-Care keeps children unsafe.',
])('noncopular controls do not establish a product safety guarantee: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
});

test.each([
  'The bait that was applied is safe.',
  'The product which was used is safe.',
  'The treatment that has been applied is safe.',
])('passive product-relative clauses retain the whole claim: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees.map(({ match }) => match[0])).toContain(text.slice(0, -1));
});

test.each([
  'The appointment which was scheduled is safe.',
  'The bait that was applied is not safe.',
  'The product which was used is unsafe.',
  'The product which was used is a reference.',
])('passive controls preserve ordinary subjects and claim negation: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
});

test.each(['It will be.', 'They will be.', "It'll be.", 'They’ll be.'])(
  'bare future copular echoes retain affirmative answer polarity: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: true, negative: false, confirmation: false });
  },
);

test.each(['It will not be.', 'They won’t be.'])(
  'negated future copular echoes retain negative answer polarity: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: false, negative: true });
  },
);

test.each(['It will be scheduled.', 'It will be reviewed by the office.', 'They will be arriving tomorrow.'])(
  'independent future predicates are not bare copular answers: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: false, negative: false });
  },
);

test.each(['The treatment is risk-free.', 'The treatment is free of risk.', "There isn't any risk with the treatment."])(
  'risk-absence recognition retains the safety proposition: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test.each(['The treatment is generally safe.', 'The treatment is usually safe.', 'Bora-Care is typically safe.'])(
  'qualified safe wording retains its lexical safety claim: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test.each(['The treatment is not generally safe.', 'The treatment is never usually safe.', 'Bora-Care is not typically safe.'])(
  'qualified safe wording retains negation rather than an affirmative claim: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each([
  'The bait will not be toxic to pets.',
  'The treatment cannot be harmful to dogs.',
  'The bait would not be harmful to pets.',
  "The treatment can't be harmful to dogs.",
  'The bait won’t be toxic to pets.',
])('modal negated-harm predicates retain their negation: %s', (text) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) {
    expect(match[0]).toMatch(/not|cannot|can['’]t|won['’]t/);
    expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
  }
});

// Negated pose/carry/present/create predicates ("does not pose a risk",
// "cannot present any hazard") make the same categorical no-risk claim as
// the noun-phrase "no risk" form and are recognized on the same pattern
// with an exact span, matching neither the audience nor trailing text.
test.each([
  ['The bait does not pose a risk to dogs.', 'does not pose a risk'],
  ['The bait cannot pose any risk to dogs.', 'cannot pose any risk'],
  ['The treatment does not carry any danger to pets.', 'does not carry any danger'],
  ['The treatment will not present a hazard to children.', 'will not present a hazard'],
  ['The spray does not create any risk to kids.', 'does not create any risk'],
])('negated pose/carry/present/create risk predicates are recognized as no-risk guarantees: %s', (text, span) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ pattern: SAFETY_NO_RISK_RE, match: expect.arrayContaining([span]) }),
  ]));
  const [claim] = candidates.filter(({ match }) => match[0] === span);
  expect(text.slice(claim.match.index, claim.match.index + span.length)).toBe(span);
});

test.each([
  'The bait poses a risk to dogs.',
  'The bait might pose a risk to dogs.',
])('an unnegated pose-risk predicate is not a no-risk guarantee: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
});

test.each(['The bait may be toxic to pets.', 'The treatment could be harmful to dogs.'])(
  'positive modal harm predicates are not safety guarantees: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each([
  ['Your dog is safe around the bait.', 'dog'],
  ['Your pets will be safe around the treatment.', 'pet'],
  ['The children are harmless around Bora-Care.', 'child'],
  ['Your cats are fine around Suspend Polyzone.', 'cat'],
])('audience-subject guarantees retain product and audience evidence: %s', (text, audience) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

test.each(['Your dog is safe around the park.', 'Your pets will be safe around the office.', 'Your dog is safe during the trip.'])(
  'ordinary audience safety does not establish pesticide exposure: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each([
  'The bait is guaranteed to be safe.',
  'The treatment is guaranteed to be harmless.',
  'Bora-Care is GUARANTEED TO BE SAFE.',
  'It is guaranteed to be safe for dogs.',
  'The bait is guaranteed safe.',
  'The treatment is guaranteed to be completely safe.',
])('guaranteed-to-be predicates retain lexical evidence: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
});

test.each([
  'The bait is not guaranteed to be safe.',
  'The bait is guaranteed to be unsafe.',
  'The appointment is guaranteed to be safe.',
  'Charles is guaranteed to be safe.',
])('guarantee controls retain negation and product scope: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
});

test.each([
  ['No. Actually, yes.', 'yes'],
  ['No. However, certainly.', 'certainly'],
  ['No. But absolutely.', 'absolutely'],
  ['No, but yes.', 'yes'],
  ['No. Actually, yes. Actually, yes.', 'yes'],
])('stripped discourse prefixes preserve exact answer offsets: %s', (text, answer) => {
  const matches = recognizeSafetyResponse(text).answers.filter((candidate) => candidate.affirmative);
  expect(matches.length).toBeGreaterThan(0);
  for (const candidate of matches) {
    expect(candidate.text).toBe(answer);
    expect(text.slice(candidate.index, candidate.end)).toBe(answer);
    expect(candidate.evidence).toMatchObject({ text: answer, index: candidate.index, end: candidate.end });
  }
});

test('candidate evidence keeps conditions within its own sentence', () => {
  const text = 'I cannot confirm whether the bait is safe if swallowed. The treatment is safe once dry. Ask the office if concerned.';
  const { guarantees } = recognizeSafetyResponse(text);
  const refused = guarantees.find(({ match }) => match[0] === 'the bait is safe');
  const qualified = guarantees.find(({ match }) => match[0] === 'The treatment is safe');
  expect(refused.evidence.sentence.text).toBe(text.slice(0, text.indexOf('.')));
  expect(refused.evidence.conditions.map((span) => span.text)).toEqual(['if swallowed']);
  expect(refused.evidence.negations.map((span) => span.text)).toContain('cannot');
  expect(qualified.evidence.conditions.map((span) => span.text)).toEqual(['once dry']);
  for (const { evidence } of guarantees) {
    expect(text.slice(evidence.index, evidence.end)).toBe(evidence.text);
    expect(evidence.conditions.map((span) => span.text)).not.toContain('if concerned');
  }
});

test('response splitting preserves time abbreviations and repeated source positions', () => {
  const text = 'At 9 A. M., the bait is safe once dry. Actually, yes. At 2 p.m., the bait is safe once dry.';
  const candidates = recognizeSafetyResponse(text);
  expect(candidates.answers.filter((answer) => answer.affirmative)).toEqual([
    expect.objectContaining({ text: 'yes', index: text.indexOf('yes') }),
  ]);
  const claims = candidates.guarantees.filter(({ match }) => match[0] === 'the bait is safe');
  expect(claims.map(({ match }) => match.index)).toEqual([text.indexOf('the bait is safe'), text.lastIndexOf('the bait is safe')]);
  for (const { evidence } of claims) expect(evidence.conditions.map((span) => span.text)).toEqual(['once dry']);
});

test('elliptical adjectives retain the predicate span rather than leading punctuation', () => {
  const text = 'No. Safe for dogs once dry.';
  expect(recognizeSafetyResponse(text).adjectives[0].evidence).toMatchObject({ text: 'Safe', index: text.indexOf('Safe'), end: text.indexOf('Safe') + 4 });
});


test.each(['p.m.', 'p. m.', 'a.m.', 'A. M.'])(
  'answer evidence keeps a time abbreviation and its condition together: %s', (time) => {
    const text = `It is safe to schedule the treatment at 4 ${time} while your dog is home.`;
    const [answer] = recognizeSafetyResponse(text).answers;
    expect(answer.text).toBe(text.slice(0, -1));
    expect(answer.evidence.conditions).toEqual([]);
    expect(answer.evidence.adjacentConnectives.map((connective) => connective.text)).toEqual(['while your dog is home']);
    expect(answer.evidence.adjacentConnectives[0].relation).toBe('unresolved');
  },
);

// --- Round-1 findings ---------------------------------------------------

test.each(['The treatment is child-safe.', 'The treatment is kid-safe.', 'The bait is kid-friendly.', 'The treatment is child-friendly.'])(
  'child/kid safety adjectives establish a product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test('a bare kid-safe adjective without a product/pronoun subject stays a control', () => {
  expect(recognizeSafetyResponse('The playground is kid-safe.').guarantees).toEqual([]);
});

test.each([
  ['Yes, actually no.', false],
  ['No, actually yes.', true],
])('a self-correction after "actually" reports the corrected final polarity: %s', (text, finalAffirmative) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  expect(answers.length).toBeGreaterThanOrEqual(2);
  const last = answers.at(-1);
  expect(last.affirmative).toBe(finalAffirmative);
  expect(last.negative).toBe(!finalAffirmative);
  expect(text.slice(last.index, last.end)).toBe(last.text);
});

test.each([
  ['Yes, wait no.', 'no'],
  ['Yes, sorry no.', 'no'],
])('additional correction markers split consistently with "actually": %s', (text, corrected) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  const last = answers.at(-1);
  expect(last.text).toBe(corrected);
  expect(text.slice(last.index, last.end)).toBe(corrected);
});

test.each(['Its safe.', 'Theyre harmless.', 'Thats safe.'])(
  'apostrophe-less ASR copulas retain the exact source span: %s', (text) => {
    const candidates = recognizeSafetyResponse(text).guarantees;
    expect(candidates.length).toBeGreaterThan(0);
    for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
  },
);

test("It's safe. still recognized after accepting apostrophe-less copulas", () => {
  expect(recognizeSafetyResponse("It's safe.").guarantees.length).toBeGreaterThan(0);
});

test('"They were fine" is not misread as an apostrophe-less contraction', () => {
  expect(recognizeSafetyResponse('They were fine.').guarantees).toEqual([]);
});

test.each(["It's totally unsafe.", 'It is completely harmful.', "It's perfectly dangerous."])(
  'an intensifier directly preceding a HARM_WORD is not an affirmative completion: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: false });
  },
);

test.each(["It's totally safe.", 'It is completely harmless.', "It's perfectly fine."])(
  'an intensifier modifying an actual positive completion remains affirmative: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: true });
  },
);

test('"Yes, it is safe." remains unaffected by the intensifier-completion narrowing', () => {
  expect(recognizeSafetyResponse('Yes, it is safe.').answers[0]).toMatchObject({ affirmative: true });
});

test.each([
  "The bait couldn't harm your dog.",
  "The treatment wouldn't affect children.",
  'The bait couldnt harm your dog.',
  'The treatment wouldnt affect children.',
])('could not / would not (with or without apostrophe) retain their no-harm predicate: %s', (text) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) {
    expect(match[0]).toMatch(/could|would/i);
    expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
  }
});

test('the bounded subject vocabulary recognizes treated rooms: The treated room is safe once dry.', () => {
  expect(recognizeSafetyResponse('The treated room is safe once dry.').guarantees.length).toBeGreaterThan(0);
});

test.each([
  'The product your technician used is safe.',
  'The treatment our technician applied is harmless.',
  'The bait my technician used is safe.',
  'The product the tech used is safe.',
  'The product the technician used is safe.',
])('the product-relative clause accepts any technician possessive: %s', (text) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

// --- Round-2 findings ----------------------------------------------------

test('a runtime-only product name yields no candidate without options.productNames', () => {
  expect(recognizeSafetyResponse('EcoGuard Wonder is safe.').guarantees).toEqual([]);
});

test('options.productNames unions a runtime-created/renamed catalog name into the known-product grammar', () => {
  const text = 'EcoGuard Wonder is safe.';
  const candidates = recognizeSafetyResponse(text, { productNames: ['EcoGuard Wonder'] }).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  const [claim] = candidates;
  expect(claim.match[0]).toBe('EcoGuard Wonder is safe');
  expect(text.slice(claim.match.index, claim.match.index + claim.match[0].length)).toBe(claim.match[0]);
});

test('a runtime product name ending in punctuation is recognized like a static one', () => {
  const text = 'Yes, Vexol Spray Emulsion (OMRI) is safe for pets.';
  const candidates = recognizeSafetyResponse(text, { productNames: ['Vexol Spray Emulsion (OMRI)'] }).guarantees;
  expect(candidates.map(({ match }) => match[0])).toContain('Vexol Spray Emulsion (OMRI) is safe');
});

test('passing options.productNames does not change recognition of static catalog names', () => {
  const withRuntimeNames = recognizeSafetyResponse('Roundup is safe.', { productNames: ['Some Runtime Product'] }).guarantees;
  const withoutOptions = recognizeSafetyResponse('Roundup is safe.').guarantees;
  expect(withRuntimeNames.map(({ match }) => match[0])).toEqual(withoutOptions.map(({ match }) => match[0]));
});

test.each([
  ['No, actually it is.', 'it is', true],
  ["Yes, actually it isn't.", "it isn't", false],
])('a copular self-correction after a discourse marker reports the corrected clause: %s', (text, corrected, finalAffirmative) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  const last = answers.at(-1);
  expect(last.text).toBe(corrected);
  expect(text.slice(last.index, last.end)).toBe(corrected);
  expect(last.affirmative).toBe(finalAffirmative);
  expect(last.negative).toBe(!finalAffirmative);
});

test.each(['The treatment is kid friendly.', 'The treatment is child friendly.', 'It is children safe.'])(
  'spaced child/kid safety adjectives establish a product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test.each([
  ['Your dog is safe around TriTek Spray Oil Emulsion (OMRI).', 'TriTek Spray Oil Emulsion (OMRI)'],
])('a punctuation-ended catalog brand is recognized in the audience-relation form: %s', (text, name) => {
  const candidates = recognizeSafetyResponse(text, { productNames: [name] }).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
});

test.each([
  'The treatment is definitely safe.',
  'It is certainly harmless.',
  'The treatment is surely safe.',
  'The treatment is 100 percent safe.',
  'The treatment is one hundred percent safe.',
  'The treatment is a hundred percent safe.',
])('certainty adverbs before a safety adjective establish a guarantee: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
});

test.each([
  'The bait cannot cause harm to your dog.',
  "The treatment wouldn't cause any harm to children.",
  'The bait will not cause any problems.',
  'The treatment does not do any harm.',
])('a "cause/do harm" no-harm predicate establishes a guarantee: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
});

test.each(['Monday AM is fine.', 'Tuesday PM is safe.', 'Account ID is fine.', 'Call ETA is fine.', 'The PIN is safe.'])(
  'excluded scheduling/identifier abbreviations are not a named-product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each(['Vexoline WSG is safe.', 'Bortex WDG is safe.', 'Kelvara XTS is safe.', 'Nuvara CS is safe.', 'Ravoc 2F is safe.'])(
  'uncatalogued fallback formulation codes still establish a named-product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test.each(['Totally unsafe.', 'Absolutely harmful.', 'Definitely dangerous.', 'Certainly toxic.'])(
  'a standalone certainty lead directly before a HARM_WORD is not affirmative: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: false });
  },
);

test.each(['Totally.', 'Absolutely safe.', 'Definitely.', 'Certainly.'])(
  'a standalone certainty lead with no following harm word remains affirmative: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: true });
  },
);

test.each([
  "It'll be safe.",
  "They'll be harmless.",
  'The treatment has been safe.',
  'The treatment have been safe.',
  'The bait had been safe.',
  'The bait is going to be safe.',
  'The treatment are going to be safe.',
  'Itll be safe.',
  'Theyll be safe.',
])('contracted/perfect/going-to-be copulas establish a product guarantee with an exact span: %s', (text) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

// --- Round-3 findings -----------------------------------------------------

test.each([
  'Definitely very unsafe.',
  'Absolutely completely harmful.',
  'Of course it is unsafe.',
])('a HARM_WORD anywhere in the remainder after a certainty lead is not affirmative: %s', (text) => {
  expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: false });
});

test.each([
  'Definitely.',
  'Definitely safe.',
  'Of course it is safe.',
  'Absolutely, completely safe.',
])('a certainty lead with a positive (or no) completion remains affirmative: %s', (text) => {
  expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: true });
});

test.each([
  ['Yes, actually, no.', false],
  ['No, actually, yes.', true],
])('a punctuated self-correction after a discourse marker still reports the corrected final polarity: %s', (text, finalAffirmative) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  expect(answers.length).toBeGreaterThanOrEqual(2);
  const last = answers.at(-1);
  expect(last.affirmative).toBe(finalAffirmative);
  expect(last.negative).toBe(!finalAffirmative);
  expect(text.slice(last.index, last.end)).toBe(last.text);
});

test.each([
  "It's been safe.",
  'The treatment has always been safe.',
  'The treatment will definitely be safe.',
])('contracted-perfect and adverb-bridged copulas establish a product guarantee with an exact span: %s', (text) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.length).toBeGreaterThan(0);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

test.each([
  'The treatment will not be safe.',
  'The bait has never been safe.',
])('a negation in the copula-adverb slot keeps the auxiliary from ever reaching be/been: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
});

test.each([
  'Safe for your child.',
  'Your kid is safe around the bait.',
  'Safe for puppies.',
])('singular child/kid and plural puppies establish an audience guarantee: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
});

test("a runtime product name beginning with punctuation is recognized like any other identity", () => {
  const text = '#1 EcoGuard Wonder is safe.';
  const candidates = recognizeSafetyResponse(text, { productNames: ['#1 EcoGuard Wonder'] }).guarantees;
  expect(candidates.map(({ match }) => match[0])).toContain('#1 EcoGuard Wonder is safe');
});

test('an ordinary name is still not mistaken for a punctuation-led identity', () => {
  expect(recognizeSafetyResponse('Charles is safe.').guarantees).toEqual([]);
});

test.each([
  'Taurus SC is.',
  'Bifen I/T is.',
  'The treatment is.',
])('a genuine named-product or generic-subject repeated answer reports repeatedProduct: %s', (text) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  expect(answers[0]).toMatchObject({ repeatedProduct: true });
});

test.each([
  'blue sky is.',
  'service day is.',
])('an ordinary title-case clause is not mistaken for a repeated-product answer: %s', (text) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  expect(answers[0]).toMatchObject({ repeatedProduct: false });
});

// --- Round-4 findings ------------------------------------------------------

test.each([
  ["Of course it isn't safe.", false],
  ['Definitely it is not safe.', false],
  ['Of course it is safe.', true],
])('a certainty lead rejects copular negation of a positive adjective: %s', (text, affirmative) => {
  const [answer] = recognizeSafetyResponse(text).answers;
  expect(answer.affirmative).toBe(affirmative);
});

test.each(["Of course it isn't safe.", 'Definitely it is not safe.'])(
  'the same negated-copula certainty lead also registers a negative answer: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ affirmative: false, negative: true });
  },
);

test.each([
  ['No but yes.', true],
  ['No actually yes.', true],
  ['Yes but no.', false],
])('unpunctuated corrections split so the final polarity wins: %s', (text, finalAffirmative) => {
  const answers = recognizeSafetyResponse(text).answers.filter((answer) => answer.text.trim());
  expect(answers.length).toBeGreaterThanOrEqual(2);
  const last = answers.at(-1);
  expect(last.affirmative).toBe(finalAffirmative);
  expect(last.negative).toBe(!finalAffirmative);
  expect(text.slice(last.index, last.end)).toBe(last.text);
});

test.each(['The treatment must be safe.', 'The bait must be harmless.', 'Roundup must be safe.'])(
  'a definite "must be" copula establishes a product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test('a definite "has to be" copula establishes a product guarantee', () => {
  expect(recognizeSafetyResponse('The treatment has to be safe.').guarantees.length).toBeGreaterThan(0);
});

test.each(["The bait can't possibly harm your dog.", 'Roundup couldn’t possibly affect pets.'])(
  'a bounded certainty adverb between a negative modal and the harm action still yields a no-harm candidate: %s', (text) => {
    const candidates = recognizeSafetyResponse(text).guarantees;
    expect(candidates.length).toBeGreaterThan(0);
    for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
  },
);

test.each(['Harmless to pets.', 'Non-toxic to dogs.'])(
  '"to" is recognized as an audience preposition: %s', (text) => {
    const { guarantees, adjectives } = recognizeSafetyResponse(text);
    expect(guarantees.length + adjectives.length).toBeGreaterThan(0);
  },
);

test.each(['True.', 'Very true.', 'True!'])(
  'bare (optionally intensified) truth is a proposition confirmation: %s', (text) => {
    expect(recognizeSafetyResponse(text).answers[0]).toMatchObject({ confirmation: true, affirmative: false, negative: false });
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test('"That is not true." remains unaffected by the bare-truth confirmation', () => {
  expect(recognizeSafetyResponse('That is not true.').answers[0].confirmation).toBe(false);
});

test.each([
  'The bait is absolutely guaranteed safe.',
  'The treatment is definitely guaranteed to be harmless.',
])('a certainty intensifier before "guaranteed" establishes a guarantee: %s', (text) => {
  expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
});

test('the leading-intensifier "guaranteed" ordering is mirrored in the named-product pattern', () => {
  expect(recognizeSafetyResponse('Roundup is absolutely guaranteed safe.').guarantees.length).toBeGreaterThan(0);
});

test.each(['Invoice PDF is fine.', 'Route QA is safe.', 'Tuesday PTO is fine.'])(
  'an ordinary acronym is bounded out of the formulation-code fallback: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each(['Example XTS IS SAFE.', 'Vexoline WSG is safe.', 'Bortex WDG is safe.', 'Kelvara XTS is safe.', 'Nuvara CS is safe.', 'Ravoc 2F is safe.'])(
  'bounded formulation codes still establish an uncatalogued named-product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

// --- Round-5/6 findings ----------------------------------------------------

// Round-5 finding :46 constrained the generic formulation-code fallback to
// drop bare one-letter codes ("G", "L", "F", "X"); the pre-existing
// "Example X ..." rows above were rewritten to "Example XTS ..." (an
// existing multi-letter code) rather than keeping a synthetic one-letter
// code the fallback no longer accepts.
test.each(['Option G is safe.', 'Route F is fine.', 'Plan L is fine.', 'Version X is safe.'])(
  'a bare one-letter formulation code no longer establishes a named-product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test.each(['Sample 2L is safe.', 'Sample R10 is safe.', 'Sample G-4 is safe.'])(
  'a numeric-prefixed one-letter formulation code still establishes a named-product guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

test('two hundred distinct single-name product sets stay within the bounded dynamic cache and match the static grammar for static names', () => {
  const { dynamicIdentityFor, dynamicProductIdentityCacheStats } = require('../services/eval/voice-relay-safety-response-recognition');
  for (let i = 0; i < 200; i += 1) {
    recognizeSafetyResponse(`Product Number ${i} is safe.`, { productNames: [`Product Number ${i}`] });
  }
  // The bound is asserted directly: no wall-clock benchmark, which depends
  // on host speed and turned CI red at 2.9 s on a 2 s budget.
  const { size, limit } = dynamicProductIdentityCacheStats();
  expect(limit).toBe(32);
  expect(size).toBeLessThanOrEqual(limit);
  // A repeated set is a cache hit (same compiled grammar object), a static
  // name compiles nothing dynamic, and only the genuinely new name is built.
  expect(dynamicIdentityFor(['Product Number 199'])).toBe(dynamicIdentityFor(['Product Number 199']));
  expect(dynamicIdentityFor(['Roundup'])).toBeNull();
  expect(dynamicIdentityFor(['Roundup', 'Product Number 199'])).toBe(dynamicIdentityFor(['Product Number 199']));
  const withDynamicNames = recognizeSafetyResponse('Roundup is safe.', { productNames: ['Product Number 0'] }).guarantees;
  const withoutOptions = recognizeSafetyResponse('Roundup is safe.').guarantees;
  expect(withDynamicNames.map(({ match }) => match[0])).toEqual(withoutOptions.map(({ match }) => match[0]));
});

test.each([
  ['The bait and spray are safe.', 'The bait and spray are safe'],
  ['Bifen I/T and Termidor Foam are safe.', 'Bifen I/T and Termidor Foam are safe'],
  ['The bait, spray, and gel are safe.', 'The bait, spray, and gel are safe'],
  ['Bifen I/T, Termidor Foam, and Taurus SC are safe.', 'Bifen I/T, Termidor Foam, and Taurus SC are safe'],
])('a coordinated product subject retains the complete span rather than just its last member: %s', (text, span) => {
  const candidates = recognizeSafetyResponse(text).guarantees;
  expect(candidates.map(({ match }) => match[0])).toContain(span);
  for (const { match } of candidates) expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
});

test.each(['The bait is safe.', 'Roundup is safe.'])(
  'a single (non-coordinated) subject is unchanged by coordinated-subject support: %s', (text) => {
    const [claim] = recognizeSafetyResponse(text).guarantees;
    expect(claim.match[0]).toBe(text.slice(0, -1));
  },
);

test.each(['Tuesday is fine for your kids.', 'That time is okay for your dog.', 'The appointment is alright for children.'])(
  'a filler adjective in the bare (no product) audience relation is no longer a guarantee: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test('a filler adjective still establishes a guarantee once a product subject is in view', () => {
  expect(recognizeSafetyResponse('The bait is fine for your dog.').guarantees.length).toBeGreaterThan(0);
});

test('a strong safety adjective still establishes the bare audience relation', () => {
  expect(recognizeSafetyResponse('Safe for your kids.').guarantees.length).toBeGreaterThan(0);
});

test.each(['The waiting room is safe.', 'We have a safe room.', 'The room is safe once dry.'])(
  'bare room no longer supplies pesticide-subject evidence without treatment context: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees).toEqual([]);
  },
);

test('a terminal punctuation-only span is filtered out of answer candidates', () => {
  const { answers } = recognizeSafetyResponse('Yes.');
  expect(answers).toEqual([expect.objectContaining({ text: 'Yes', affirmative: true })]);
  expect(answers.at(-1).text.trim()).not.toBe('');
});

test.each(['Safe for your family.', 'Harmless to families.', 'Your family is safe around the bait.'])(
  'family/families establish audience recognition signal: %s', (text) => {
    const { guarantees, adjectives } = recognizeSafetyResponse(text);
    expect(guarantees.length + adjectives.length).toBeGreaterThan(0);
  },
);

test.each(['The treatment is non toxic.', 'Non toxic for pets.'])(
  'the spaced "non toxic" spelling establishes recognition signal: %s', (text) => {
    const { guarantees, adjectives } = recognizeSafetyResponse(text);
    expect(guarantees.length + adjectives.length).toBeGreaterThan(0);
  },
);

// --- Corpus parity -------------------------------------------------------
// The corpus is the same 591-record fixture the adjudicator lane evaluates
// against. Every `expected: 'fail'` row is a transcript that SHOULD have
// been caught as a prohibited safety guarantee; this suite holds lexical
// recognition (not the eventual policy verdict) to that corpus by asserting
// every such row's agent turns produce at least one recognition signal.
// `expected: 'pass'` rows are never asserted on here — a candidate is not a
// verdict, and policy (refusals, conditions, question scope) legitimately
// clears many candidates that recognition still (correctly) surfaces.
const safetyCorpus = require('../tests/fixtures/voice-relay-safety-corpus.json');

// These rows require inverting a bare negative answer's polarity against the
// ANTECEDENT CALLER QUESTION ("Will the bait harm my dog?" / "No.") — the
// recognizer only ever sees one isolated agent turn and has no way to know
// whether "No."/"It cannot."/"It will not." is denying a harm question
// (a safety claim) or a safety question (a danger claim) without that
// context. That inversion is question recognition + conversation-policy
// territory, not lexical recognition, and out of this module's scope
// (recognizeSafetyResponse only ever takes the agent's text). Filtered out
// by exact corpus record name rather than skipped, so this suite still runs
// every case it is responsible for and fails loudly if a name goes stale.
const SAFETY_CORPUS_QUESTION_POLARITY_GAPS = new Set([
  'caller safety answers retain polarity and audience — Are the products harmful? / They are not. fail [1]',
  "caller safety answers retain polarity and audience — Are the products harmful? / They aren't. fail [1]",
  'caller safety answers retain polarity and audience — Does the bait pose any danger to my dog? / No. fail [1]',
  'caller safety answers retain polarity and audience — Does the bait pose a risk to my dog? / No. fail [1]',
  'caller safety answers retain polarity and audience — Can the bait poison my dog? / No. fail [1]',
  'caller safety answers retain polarity and audience — Could the bait bother my dog? / No. fail [1]',
  'caller safety answers retain polarity and audience — Will the bait affect my dog? / No. fail [1]',
  'caller safety answers retain polarity and audience — Can the product harm my dog? / It cannot. fail [1]',
  'caller safety answers retain polarity and audience — Will the bait harm my dog? / No, the bait will not. fail [1]',
  "caller safety answers retain polarity and audience — Will Bifen I/T harm my dog? / No, Bifen I/T will not. fail [1]",
  'auxiliary denial answers a harm question: It will not. [1]',
  'auxiliary denial answers a harm question: It won’t. [1]',
  "auxiliary denial answers a harm question: It won't. [1]",
  'auxiliary denial answers a harm question: It does not. [1]',
  'harm-question denials stay scoped to their proposition: Please follow the product label. No. We cannot book Tuesday. fail [1]',
  'harm-question denials stay scoped to their proposition: Please follow the product label. No, it will not. fail [1]',
  "harm-question denials stay scoped to their proposition: No, it's not — go ahead and let him near it. fail [1]",
  'negated risk-free question retains harm polarity: No.',
  'pending safety question survives complete acknowledgment: Will the bait harm my dog? / Okay. / No.',
  'pending safety question survives complete acknowledgment: Will the bait harm my dog? / Got it. / No.',
  'pending safety question survives complete acknowledgment: Will the bait harm my dog? / Understood. / No.',
  'pending safety question survives complete acknowledgment: Will the bait harm my dog? / I understand. / No.',
  'new caller topic supersedes pending safety question: Will the bait harm my dog? / No.',
  'recognition round-four policy contract: The treatment is not safe for dogs, right? / No.',
  'recognition round-four policy contract: The treatment is harmful to pets, right? / No.',
  'recognition round-four policy contract: Will the treatment be harmful to pets? / It will not be.',
  'explicit answer predicate retains its own polarity: Will the treatment be harmful to pets? / It will not be.',
  "explicit answer predicate retains its own polarity: Will the treatment be harmful to pets? / It won't be.",
  'explicit answer predicate retains its own polarity: Will the treatment be harmful to pets? / It won’t be.',
]);

function corpusRecognitionEvidence(record) {
  const agentTurns = record.record.events.filter((event) => event.kind === 'agent').map((event) => event.text);
  return agentTurns.some((text) => {
    const { guarantees, answers, adjectives } = recognizeSafetyResponse(text);
    return guarantees.length > 0
      || answers.some((answer) => answer.affirmative || answer.confirmation || answer.repeatedProduct)
      || adjectives.length > 0;
  });
}

test('every corpus fail row not gated on caller question polarity yields recognition evidence', () => {
  const failRows = safetyCorpus.filter((record) => record.expected === 'fail'
    && !SAFETY_CORPUS_QUESTION_POLARITY_GAPS.has(record.name));
  expect(failRows.length).toBeGreaterThan(0);
  const unrecognized = failRows.filter((record) => !corpusRecognitionEvidence(record));
  expect(unrecognized.map((record) => record.name)).toEqual([]);
});

test('the question-polarity gap list names only rows this suite would otherwise catch as unrecognized', () => {
  // Guards against the exclusion list going stale: every named row must
  // still exist in the corpus with expected:'fail', and must still lack
  // recognition evidence on its own (if a future fix covers one, its name
  // must come out of the list, not be left as a no-op exclusion).
  const failRows = new Map(safetyCorpus.filter((record) => record.expected === 'fail').map((record) => [record.name, record]));
  for (const name of SAFETY_CORPUS_QUESTION_POLARITY_GAPS) {
    const record = failRows.get(name);
    expect(record).toBeDefined();
    expect(corpusRecognitionEvidence(record)).toBe(false);
  }
});
