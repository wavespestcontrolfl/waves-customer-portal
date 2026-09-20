const { recognizeSafetyResponse } = require('../services/eval/voice-relay-safety-response-recognition');

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
  'Example X IS SAFE.',
  'Roundup WILL NOT HARM dogs.',
  'Roundup will not HARM dogs.',
  'Contrac Blox CANNOT HARM pets.',
  'Example X WON’T HURT dogs.',
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
  ['Example X will keep your pets safe.', 'pet'],
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

test.each(['The treated room is safe once dry.', 'The room is safe once dry.'])(
  'the bounded subject vocabulary recognizes rooms: %s', (text) => {
    expect(recognizeSafetyResponse(text).guarantees.length).toBeGreaterThan(0);
  },
);

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
