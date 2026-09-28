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
const { listFacts, findUnverifiedClaims } = require('../services/email-division/fact-register');

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

  test('flags brown/large patch mis-described as a summer disease', () => {
    const claims = findUnverifiedClaims('Watch for large patch this summer as temperatures climb.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('flags a generalized "do not vacuum" window outside a flea context', () => {
    const claims = findUnverifiedClaims('Avoid vacuuming for 14 days after your ant treatment.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('does NOT flag the same vacuuming window when it is actually about fleas', () => {
    const claims = findUnverifiedClaims('For fleas, avoid vacuuming for 14 days so pupae hatch into the residual.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(false);
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
