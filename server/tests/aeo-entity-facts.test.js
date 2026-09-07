jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ configured: false, request: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const db = require('../models/db');
const { LLMMentionProber, buildDashboard } = require('../services/seo/llm-mention-prober');
const { ENTITY_COHORT, scoreEntityAnswer, summarizeEntityObservations, isEntityQuestion } = require('../services/seo/aeo-entity-facts');
const benchmark = require('../data/aeo-benchmark-v1.json');

const byId = id => ENTITY_COHORT.questions.find(q => q.id === id);
const score = (id, text) => scoreEntityAnswer(byId(id).query, text);
const row = (query, extra = {}) => ({
  query, llm_platform: 'chatgpt', model_version: 'test-search', check_date: '2026-09-08',
  measurement_version: 2, answer_available: true, citations_complete: true,
  waves_mentioned: true, waves_cited_urls: [], entity_facts: scoreEntityAnswer(query, extra.text || ''), ...extra,
});

afterEach(() => jest.clearAllMocks());

test('every cohort question names only defined facts and claims, and no prompt collides with the citation benchmark', () => {
  const prompts = new Set(benchmark.questions.map(q => q.query));
  for (const question of ENTITY_COHORT.questions) {
    expect(prompts.has(question.query)).toBe(false);
    expect(question.approved_answer.length).toBeGreaterThan(20);
    expect(question.source.length).toBeGreaterThan(5);
  }
  expect(isEntityQuestion(benchmark.questions[0].query)).toBe(false);
  expect(scoreEntityAnswer('custom prospect question', 'Waves Pest Control')).toBeNull();
});

test('every approved answer scores its own facts as right and carries zero wrong claims', () => {
  for (const question of ENTITY_COHORT.questions) {
    const result = scoreEntityAnswer(question.query, question.approved_answer);
    expect([question.id, result.wrong]).toEqual([question.id, 0]);
    if (question.kind === 'question') expect([question.id, result.missing]).toEqual([question.id, 0]);
  }
});

test('founding year: 2024 is right; any other asserted year, earlier or later, is a wrong claim', () => {
  expect(score('E4', 'Waves Pest Control was founded in 2024 by Adam Benetti.')).toMatchObject({ expected: { founded_2024: true }, forbidden: { wrong_founding_year: false }, right: 1, missing: 0, wrong: 0 });
  expect(score('E4', 'The company has been serving since 2014.')).toMatchObject({ expected: { founded_2024: false }, forbidden: { wrong_founding_year: true }, right: 0, missing: 1, wrong: 1 });
  expect(score('E4', 'Waves was founded in 2025.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', 'It was not founded in 2019; it was founded in 2024.').forbidden.wrong_founding_year).toBe(false);
});

test('a denial in the same clause is not a wrong claim, whether it comes before or after the claim', () => {
  expect(score('E7', 'The bond does not cover termite damage repairs. Re-treatment is not free.').forbidden).toMatchObject({ damage_repair_coverage: false, free_retreat_guarantee: false });
  expect(score('E6', 'Fumigation is not offered by Waves Pest Control.').forbidden.fumigation_offered).toBe(false);
  expect(score('E8', 'Waves is not an Orkin location, rather than a franchise of anyone.').forbidden.franchise).toBe(false);
});

test('a negation in another sentence or a contrasting clause does not launder a claim', () => {
  expect(score('E7', 'Waves is not a national chain. The bond covers termite damage repairs.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E6', 'Waves is not a franchise, but it offers fumigation.').forbidden).toMatchObject({ franchise: false, fumigation_offered: true });
  expect(score('E6', 'Waves does not do wildlife trapping; however, it does provide fumigation.').forbidden.fumigation_offered).toBe(true);
});

test('markdown, bulleted lists and label-value answers score like plain prose', () => {
  expect(score('E4', 'Waves Pest Control was founded in **2014**.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', '**Founded:** 2014').forbidden.wrong_founding_year).toBe(true);
  expect(score('E1', '**Adam Benetti** founded [Waves Pest Control](https://www.wavespestcontrol.com/).')).toMatchObject({ expected: { founder: true }, wrong: 0 });
  expect(score('E10', 'Call [(941) 297-5749](tel:+19412975749) or [visit the site](https://www.wavespestcontrol.com/).')).toMatchObject({ right: 2 });
  expect(score('E6', 'Waves does not offer:\n- Fumigation\n- Insulation\n- Wildlife trapping').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Services include:\n1. Pest control\n2. Fumigation').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Fumigation: not offered by Waves Pest Control.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer:\n* Insulation\n* Fumigation').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer:\n- wildlife trapping or removal\n- attic insulation installation or replacement\n- tent fumigation for drywood termite colonies').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', '- Fumigation: not offered.\n- Termite: offered.').forbidden.fumigation_offered).toBe(false);
});

test('list items are separate assertions unless a negated intro governs them', () => {
  const mixed = score('E6', 'Waves offers:\n- Pest control\n- Lawn care\n- Termite treatment\n- Mosquito control\n- Rodent control\n\nFumigation is not offered.');
  expect(mixed).toMatchObject({ right: 5, missing: 0, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Services:\n- Pest control\n- Fumigation is not available\n- Termite').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Services:\n- Pest control\n- Fumigation\n- Termite').forbidden.fumigation_offered).toBe(true);
});

test('a claim about a competitor is not a wrong claim about Waves', () => {
  expect(score('E8', 'Unlike Orkin, a franchise, Waves is independently owned.')).toMatchObject({ expected: { independent: true }, forbidden: { franchise: false } });
  expect(score('E8', 'Orkin is a franchise. Waves is not.').forbidden.franchise).toBe(false);
  expect(score('E8', 'Waves is a franchise like Orkin.').forbidden.franchise).toBe(true);
  expect(score('E6', 'Terminix provides fumigation; Waves does not.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Like Terminix, Waves provides fumigation.').forbidden.fumigation_offered).toBe(true);
});

test('coordinated predicates and colon lists scope negation to the assertion it modifies', () => {
  expect(score('E6', 'Waves is a franchise and does not offer fumigation.').forbidden).toMatchObject({ franchise: true, fumigation_offered: false });
  expect(score('E6', 'Waves does not offer: fumigation, insulation, or wildlife trapping.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer insulation or fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves is not a franchise: it offers fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves is not a franchise and it offers fumigation.').forbidden.fumigation_offered).toBe(true);
});

test('a negation inside the match denies it unless the pattern matched the negated phrase itself, and curly apostrophes count', () => {
  expect(score('E7', 'The termite bond is not optional and is not renewable.').expected).toMatchObject({ bond_optional: false, bond_renewable: false });
  expect(score('E7', 'The termite bond is optional and renews annually.').expected).toMatchObject({ bond_optional: true, bond_renewable: true });
  expect(score('E8', 'Waves is not a franchise.').expected.independent).toBe(true);
  expect(score('E6', 'Waves doesn\u2019t offer fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E8', 'Waves isn\u2019t a franchise.').forbidden.franchise).toBe(false);
});

test('a denied expected fact earns no credit; "no-contract" and "not only" are not denials', () => {
  expect(score('E4', 'Waves Pest Control was not founded in 2024.')).toMatchObject({ expected: { founded_2024: false }, forbidden: { wrong_founding_year: false }, missing: 1, wrong: 0 });
  expect(score('E1', 'Adam Benetti does not own Waves Pest Control.')).toMatchObject({ expected: { founder: false }, missing: 1 });
  expect(score('E1', 'Waves Pest Control is not a franchise; it is owned by Adam Benetti.').expected.founder).toBe(true);
  expect(score('E6', 'Waves offers no-contract pest control and not only lawn care but termite and mosquito and rodent work.')).toMatchObject({ right: 5, missing: 0 });
});

test('ownership: another capitalized name is a wrong founder; Adam is not', () => {
  expect(score('E1', 'Waves Pest Control was founded by Adam Benetti.')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_founder: false } });
  expect(score('E1', 'It was founded by John Smith in Bradenton.')).toMatchObject({ expected: { founder: false }, forbidden: { wrong_founder: true } });
  expect(score('E1', 'It is owned by a family and run by its founder.').forbidden.wrong_founder).toBe(false);
});

test('franchise: a negated mention is fine, an affirmative one is a wrong claim', () => {
  expect(score('E8', 'Waves is independently owned and not a franchise.')).toMatchObject({ expected: { independent: true }, forbidden: { franchise: false }, wrong: 0 });
  expect(score('E8', 'Waves Pest Control operates as a franchise of a national brand.')).toMatchObject({ forbidden: { franchise: true }, wrong: 1 });
  expect(score('E8', "It isn't a franchise; it is family-owned.").forbidden.franchise).toBe(false);
});

test('fumigation: excluded-service phrasing passes, offered-service phrasing fails', () => {
  expect(score('E6', 'Services: pest control, lawn care, termite, mosquito and rodent control. Waves does not offer fumigation.')).toMatchObject({ right: 5, missing: 0, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Licensed in every category except fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'They provide tent fumigation for drywood termites.').forbidden.fumigation_offered).toBe(true);
});

test('termite bond: optional AND annual renewal are separate facts; repair coverage, free re-treat and first-year inclusion are wrong', () => {
  const good = score('E7', 'Waves offers termite treatment; the warranty is an optional bond that renews annually.');
  expect(good).toMatchObject({ expected: { termite: true, bond_optional: true, bond_renewable: true }, missing: 0, wrong: 0 });
  expect(score('E7', 'The termite bond is annual.')).toMatchObject({ expected: { bond_optional: false, bond_renewable: true }, missing: 1 });
  const bad = score('E7', 'The termite bond covers termite damage repairs and comes with a free bond in the first year with a lifetime guarantee.');
  expect(bad.forbidden).toMatchObject({ damage_repair_coverage: true, free_retreat_guarantee: true, bond_included_first_year: true });
  expect(bad.wrong).toBe(3);
});

test('footprint and contact facts read place names and the main line in any common format', () => {
  expect(score('E5', 'Based in Lakewood Ranch, FL, serving Manatee, Sarasota and Charlotte counties.')).toMatchObject({ right: 4, forbidden: { out_of_footprint_hq: false } });
  expect(score('E5', 'Headquartered in Tampa.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E10', 'Call 941.297.5749 or visit https://www.wavespestcontrol.com/.')).toMatchObject({ right: 2 });
  expect(score('E9', 'Yes, Waves Pest Control & Lawn Care is the longer name of the same company.')).toMatchObject({ expected: { alias_same: true }, forbidden: { alias_different: false } });
  expect(score('E9', 'They appear to be two different companies.').forbidden.alias_different).toBe(true);
});

test('search-query tests score only the global forbidden claims', () => {
  const result = score('E11', 'Adam Benetti runs Waves Pest Control in Sarasota.');
  expect(result).toMatchObject({ right: 0, missing: 0, wrong: 0 });
  expect(Object.keys(result.forbidden).sort()).toEqual([...ENTITY_COHORT.global_forbid].sort());
});

test('summaries count facts over scored answers only and name what is missing most', () => {
  const e4 = byId('E4').query;
  const e8 = byId('E8').query;
  const summary = summarizeEntityObservations([
    row(e4, { text: 'Founded in 2024.' }),
    row(e4, { text: 'Founded in 2014.', llm_platform: 'gemini' }),
    row(e8, { text: 'It is a franchise of a national chain.' }),
    row(e4, { text: '', answer_available: false, entity_facts: null }),
    row(e4, { text: 'Founded in 2024.', measurement_version: null }),
  ]);
  expect(summary).toMatchObject({ total: 5, observed: 3, factsRight: 1, factsMissing: 2, factAccuracy: 33, wrongClaims: 2, wrongClaimRate: 67 });
  expect(summary.missingMostOften.map(f => f.key)).toEqual(['founded_2024', 'independent']);
  expect(summary.wrongMostOften.map(f => f.key)).toEqual(['wrong_founding_year', 'franchise']);
});

test('the dashboard keeps the entity cohort out of the citation benchmark and reads stored JSON scores', () => {
  const e1 = byId('E1').query;
  const queries = [{ query: benchmark.questions[0].query, city: 'Sarasota' }, ...ENTITY_COHORT.questions.map(q => ({ query: q.query, city: null, service: 'brand' }))];
  const rows = [
    row(benchmark.questions[0].query, { entity_facts: null }),
    { ...row(e1, { text: 'Founded by Adam Benetti.' }), entity_facts: JSON.stringify(scoreEntityAnswer(e1, 'Founded by Adam Benetti.')) },
    row(e1, { text: 'Founded by John Smith.', llm_platform: 'claude' }),
  ];
  const dash = buildDashboard(rows, queries);
  expect(dash.benchmark).toMatchObject({ total: 1, measured: 1 });
  expect(dash.grid.find(r => r.query === e1).intent).toBe('entity');
  expect(dash.entity).toMatchObject({ version: ENTITY_COHORT.version, questions: 12, activeQuestions: 12, observedQuestions: 1, observed: 2, factAccuracy: 50, wrongClaims: 1 });
  expect(dash.entity.byPlatform.map(g => [g.key, g.factAccuracy])).toEqual([['chatgpt · test-search', 100], ['claude · test-search', 0]]);
  expect(dash.entity.byQuestion.find(q => q.id === 'E1')).toMatchObject({ observed: 2, wrongClaims: 1 });
  expect(dash.entity.byQuestion.find(q => q.id === 'E2')).toMatchObject({ observed: 0, factAccuracy: null });
});

test('the prober stores a fact score for cohort questions and null for everything else', async () => {
  const prober = new LLMMentionProber();
  const e4 = byId('E4').query;
  jest.spyOn(prober, 'getQueries').mockResolvedValue([{ id: 1, query: e4 }, { id: 2, query: benchmark.questions[0].query }]);
  Object.defineProperty(prober, 'providers', { value: { chatgpt: async () => ({ text: 'Waves Pest Control was founded in 2024.', model: 'test' }) } });
  const inserted = [];
  db.mockReturnValue({
    where: () => ({ select: async () => [] }),
    insert: payload => { inserted.push(payload); return { onConflict: () => ({ ignore: async () => ({ rowCount: 1 }) }) }; },
  });
  await prober.runDaily();
  const byQuery = Object.fromEntries(inserted.map(p => [p.query, p.entity_facts]));
  expect(JSON.parse(byQuery[e4])).toMatchObject({ id: 'E4', right: 1, wrong: 0 });
  expect(byQuery[benchmark.questions[0].query]).toBeNull();
});
