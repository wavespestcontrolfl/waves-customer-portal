/**
 * Email division fact register: listFacts tag filtering + the
 * findUnverifiedClaims deterministic rule list newsletter-validator.js
 * wires in as a hard block.
 */

function chain(rows) {
  const q = {};
  ['where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  // await-able: resolves to `rows` when the query itself is awaited.
  q.then = (resolve) => resolve(rows);
  return q;
}

jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { listFacts, findUnverifiedClaims, factsPromptBlock } = require('../services/email-division/fact-register');

const FACTS = [
  { id: 'f1', title: 'Native subterranean termite swarm season', tags: ['termites', 'swarm-season'], active: true },
  { id: 'f2', title: 'Southern chinch bug', tags: ['chinch-bugs', 'lawn'], active: true },
  { id: 'f3', title: 'Fire ant mating flights', tags: ['fire-ants', 'swarm-season'], active: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => chain(FACTS));
});

describe('listFacts', () => {
  test('returns every active fact when no tags are given', async () => {
    const facts = await listFacts();
    expect(facts).toHaveLength(3);
    expect(db).toHaveBeenCalledWith('knowledge_base');
  });

  test('reads only facts that are active AND in status active, so a flagged or archived fact never reaches a writer', async () => {
    await listFacts();
    const q = db.mock.results[db.mock.results.length - 1].value;
    expect(q.where).toHaveBeenCalledWith({ category: 'facts', active: true, status: 'active' });
  });

  test('filters to facts carrying ANY of the given tags', async () => {
    const facts = await listFacts({ tags: ['swarm-season'] });
    expect(facts.map((f) => f.id).sort()).toEqual(['f1', 'f3']);
  });

  test('accepts a single tag string as well as an array', async () => {
    const facts = await listFacts({ tags: 'lawn' });
    expect(facts.map((f) => f.id)).toEqual(['f2']);
  });

  test('respects limit after filtering', async () => {
    const facts = await listFacts({ tags: ['swarm-season'], limit: 1 });
    expect(facts).toHaveLength(1);
  });
});

describe('findUnverifiedClaims', () => {
  test('flags a storm-triggered "second swarm" termite claim', () => {
    const claims = findUnverifiedClaims('Termites will throw a second swarm event after significant rain and storm activity.');
    expect(claims).toEqual([{ rule: 'termite_second_swarm', excerpt: expect.stringContaining('second') }]);
  });

  test('does NOT flag the correct, verified swarm-season fact', () => {
    const claims = findUnverifiedClaims('Native subterranean termites swarm January through May, on warm days after rain.');
    expect(claims).toEqual([]);
  });

  test('does NOT flag a correctly-negated denial of the false swarm claim', () => {
    const claims = findUnverifiedClaims('Termites do not have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('does NOT flag a LEADING negation before the claim\'s subject', () => {
    const claims = findUnverifiedClaims('No native subterranean termites have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('a trailing, unrelated "not" after a comma does NOT exempt the real false claim', () => {
    const claims = findUnverifiedClaims('Termites will have a second swarm after storms, not that anyone believes it.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('does NOT flag a correctly-scoped drywood swarm claim (a different species, a real wide window)', () => {
    const claims = findUnverifiedClaims('Western drywood termites can have another round of late-summer swarms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('a contrastive drywood clause does NOT exempt a false claim about a DIFFERENT species in the same sentence', () => {
    const claims = findUnverifiedClaims('Unlike drywood termites, native subterranean termites have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('still flags an unscoped "termites" claim naming the same false shape', () => {
    const claims = findUnverifiedClaims('Termites will throw a second swarm event after significant rain and storm activity.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('a correct drywood sentence does NOT exempt a false claim about a DIFFERENT sentence/species', () => {
    const claims = findUnverifiedClaims('Drywood termites may fly in fall. Native subterranean termites have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('flags the natural word order "swarm again after storms"', () => {
    const claims = findUnverifiedClaims('After a wet week, termites swarm again after storms roll through.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('exempts an explicit denial in that word order', () => {
    expect(findUnverifiedClaims('Termites do not swarm again after storms.')).toEqual([]);
    expect(findUnverifiedClaims('For termites, there is no second swarm after storms.')).toEqual([]);
  });

  test.each([
    ['no doubt', 'There is no doubt termites will swarm a second time after storms.'],
    ['not only', 'Not only do termites swarm in spring, termites swarm again after storms.'],
    ['never fail to', 'Termites never fail to swarm again after a storm.'],
    ['a negated aside inside the match', 'Termites, which are not picky, have a second swarm after storms.'],
    ['a negated different verb', 'Termites do not eat concrete, yet termites have a second swarm after storms.'],
  ])('a negation idiom or unrelated negation (%s) does NOT exempt the false claim', (_label, sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('a correct denial earlier in the sentence does NOT exempt a later false claim in it', () => {
    const claims = findUnverifiedClaims('Large patch is not a summer disease up north, but here large patch thrives in summer heat.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('"no joke" is not a denial of the large-patch claim', () => {
    const claims = findUnverifiedClaims('Brown patch is no joke in summer heat.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test.each([
    'Expect a second termite swarm after the next storm.',
    'Storms can trigger another termite swarm.',
    'A second subterranean termite swarm follows hurricanes.',
    'No doubt a second termite swarm is coming.',
  ])('flags the claim when the modifier comes before "termite swarm": %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test.each([
    'There is no second termite swarm after storms.',
    'UF documents no second termite swarm.',
    'This is not a second termite swarm.',
    'A second drywood termite swarm is possible in fall.',
  ])('does NOT flag a denial or a drywood subject in that word order: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('flags brown/large patch mis-described as a summer disease', () => {
    const claims = findUnverifiedClaims('Watch for large patch this summer as temperatures climb.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('UF\'s own wording about large patch passes: warm humid weather, and not observed in summer', () => {
    expect(findUnverifiedClaims('Large patch occurs in warm, humid weather and is encouraged by excessive nitrogen.')).toEqual([]);
    expect(findUnverifiedClaims('Large patch is normally not observed in the summer months.')).toEqual([]);
    expect(findUnverifiedClaims('Large patch is most likely from November through May when temperatures are below 80°F.')).toEqual([]);
  });

  test('flags large patch placed above 80 degrees', () => {
    const claims = findUnverifiedClaims('Large patch takes off once temperatures climb above 80 degrees.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('does NOT flag the correct, negated large-patch explanation', () => {
    const claims = findUnverifiedClaims('Large patch appears in spring and fall; it is not a summer disease.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(false);
  });

  test('flags a generalized "do not vacuum" instruction — never correct, any context', () => {
    expect(findUnverifiedClaims('Avoid vacuuming for 14 days after your ant treatment.')
      .some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
    // Even in a flea context, telling customers to AVOID vacuuming is wrong
    // — the actual guidance says to vacuum, so this is flagged too.
    expect(findUnverifiedClaims('For fleas, avoid vacuuming for 14 days so pupae hatch into the residual.')
      .some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('flags the affirmative "vacuum for N days" instruction generalized outside fleas', () => {
    const claims = findUnverifiedClaims('Vacuum daily for 14 days after your ant treatment.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('does NOT flag the correct affirmative flea vacuuming guidance', () => {
    const claims = findUnverifiedClaims('For fleas, vacuum daily for about 14 days so pupae hatch into the residual.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(false);
  });

  test('a later non-exempt occurrence still blocks after an earlier exempt one', () => {
    const claims = findUnverifiedClaims('For fleas, vacuum daily for 14 days. For fleas, avoid vacuuming for 14 days.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('correct flea guidance in one sentence does NOT exempt a false claim about a DIFFERENT pest in another', () => {
    const claims = findUnverifiedClaims('For fleas, vacuum daily for about 14 days so pupae hatch into the residual. Vacuum daily for 14 days after your ant treatment.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test.each([
    'Our family-safe treatment keeps everyone comfortable.',
    'It is safe for the whole family.',
    'Kid-safe once it dries.',
    'Safe for children and pets.',
    'A child-safe barrier.',
  ])('flags family, kid and child safety claims: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'absolute_safety_claim')).toBe(true);
  });

  test('the label\'s own re-entry wording is not a safety claim', () => {
    expect(findUnverifiedClaims('Do not allow people or pets on treated surfaces until the spray has dried.')).toEqual([]);
  });

  test('flags absolute "bee-safe" / "pet-safe" claims', () => {
    expect(findUnverifiedClaims('Our spray is completely bee-safe.').some((c) => c.rule === 'absolute_safety_claim')).toBe(true);
    expect(findUnverifiedClaims('This treatment is pet-safe for the whole family.').some((c) => c.rule === 'absolute_safety_claim')).toBe(true);
  });

  test('a clean draft with no known-false claim shapes returns nothing', () => {
    expect(findUnverifiedClaims('Mosquito season is here. Call us for a quote.')).toEqual([]);
  });

  test('empty/undefined input returns an empty array', () => {
    expect(findUnverifiedClaims('')).toEqual([]);
    expect(findUnverifiedClaims(undefined)).toEqual([]);
  });
});

describe('factsPromptBlock', () => {
  function wire(rows) {
    const q = {};
    ['where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    db.mockImplementation(() => q);
  }

  test('lists every fact with its source text, its limits and its source, then binds the writer to the list', async () => {
    wire([
      {
        title: 'Aedes mosquitoes: containers and the 7–10 day life cycle',
        summary: '"A mosquito egg takes 7–10 days to develop into an adult mosquito."',
        content: 'Per CDC, an egg takes 7 to 10 days to develop into an adult.',
        metadata: JSON.stringify({ source_url: 'https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html' }),
        tags: ['mosquitoes'],
      },
      {
        title: 'Taurus SC: non-repellent',
        summary: '"Taurus SC is a non-repellent insecticide"',
        content: 'The manufacturer states no time to control.',
        metadata: { source_url: 'https://www.controlsolutionsinc.com/csi-pest/products/taurus-sc' },
        tags: ['products'],
      },
    ]);

    const block = await factsPromptBlock();

    expect(block).toContain('VERIFIED FACTS');
    expect(block).toContain('A mosquito egg takes 7–10 days');
    expect(block).toContain('https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html');
    expect(block).toContain('The manufacturer states no time to control.');
    expect(block).toContain('If the list does not cover a claim, leave the claim out');
    expect(block).toContain('Never write a number of days, weeks or months that does not appear in the list');
  });

  test('throws when the register is empty, so a draft is never written ungrounded', async () => {
    wire([]);
    await expect(factsPromptBlock()).rejects.toThrow(/fact register is empty/);
  });
});
