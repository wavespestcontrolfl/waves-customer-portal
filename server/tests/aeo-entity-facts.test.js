jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ configured: false, request: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const db = require('../models/db');
const { LLMMentionProber, buildDashboard } = require('../services/seo/llm-mention-prober');
const { ENTITY_COHORT, SCORER_REVISION, scoreEntityAnswer, summarizeEntityObservations, isEntityQuestion } = require('../services/seo/aeo-entity-facts');
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
  expect(score('E4', 'Waves Pest Control was founded on February 6, 2014.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', '2014.').forbidden).toMatchObject({ wrong_founding_year: false, wrong_founding_year_bare: true });
  expect(score('E4', 'Waves was incorporated in 2014.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', '2024.').forbidden).toMatchObject({ wrong_founding_year: false, wrong_founding_year_bare: false });
  expect(score('E4', 'Waves Pest Control holds FDACS license JB351547, renewed in 2026.')).toMatchObject({ expected: { founded_2024: false }, forbidden: { wrong_founding_year: false } });
  expect(score('E4', 'The license was renewed in 2024.').expected.founded_2024).toBe(false);
  expect(score('E4', 'Waves Pest Control was founded on February 6, 2024.')).toMatchObject({ expected: { founded_2024: true }, forbidden: { wrong_founding_year: false } });
  expect(score('E4', 'It was not founded in 2019; it was founded in 2024.').forbidden.wrong_founding_year).toBe(false);
});

test('a bare year is a founding claim only on the founding question; elsewhere the year needs founding context', () => {
  expect(score('E6', '2025 services include pest control, lawn care, termite, mosquito and rodent control.')).toMatchObject({ right: 5, forbidden: { wrong_founding_year: false } });
  expect(score('E6', '2025 services include pest control.').forbidden).not.toHaveProperty('wrong_founding_year_bare');
  expect(score('E4', '2025.').forbidden.wrong_founding_year_bare).toBe(true);
  expect(score('E1', 'Adam Benetti. Founded in 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E11', '2019 review: Waves Pest Control.').forbidden.wrong_founding_year).toBe(false);
});

test('the license question needs the verification path, not just the number', () => {
  expect(score('E3', 'Waves holds FDACS license JB351547.')).toMatchObject({ expected: { fdacs_license: true, fdacs: true, license_verifiable: false }, right: 2, missing: 1 });
  expect(score('E3', 'Waves holds FDACS license JB351547. You can verify the license in the FDACS lookup.')).toMatchObject({ right: 3, missing: 0 });
  expect(score('E3', 'Waves holds FDACS license JB351547, but you cannot verify the license online.').expected.license_verifiable).toBe(false);
});

test('ownership by a competitor is a wrong owner even as a single name; acquisitions count too', () => {
  expect(score('E1', 'Waves is owned by Rentokil.')).toMatchObject({ forbidden: { wrong_founder: true }, wrong: 1 });
  expect(score('E1', 'Orkin owns Waves Pest Control.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves Pest Control was acquired by Terminix.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves is owned by HomeTeam.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves is not owned by Orkin; Waves is owned by Adam Benetti.')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_founder: false } });
  expect(score('E1', 'Orkin is owned by Rollins. Waves is owned by Adam Benetti.').forbidden.wrong_founder).toBe(false);
  expect(score('E1', 'Waves is owned by Adam.').forbidden.wrong_founder).toBe(false);
});

test('any asserted headquarters outside the footprint is a wrong claim; footprint places and the state are not', () => {
  expect(score('E5', 'Waves is headquartered in New York.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is headquartered in Tallahassee, Florida.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is based in Tampa and serves Sarasota.')).toMatchObject({ expected: { sarasota: true }, forbidden: { out_of_footprint_hq: true } });
  expect(score('E5', 'Waves is based in Central Florida.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is based in the Tampa Bay area.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is based in Florida.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'Waves is based in Southwest Florida.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'Waves is based in the Sarasota-Bradenton area.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'Waves is based in Lakewood Ranch (Manatee County), Florida.')).toMatchObject({ expected: { hq_lakewood_ranch: true }, forbidden: { out_of_footprint_hq: false } });
  expect(score('E5', 'Waves is not based in Tampa; it is based in Lakewood Ranch.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'Orkin is headquartered in Atlanta. Waves is based in Lakewood Ranch.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'Offices located in Bradenton, Sarasota, Venice and Parrish.').forbidden.out_of_footprint_hq).toBe(false);
});

test('a qualified service name still reaches its own denial', () => {
  expect(score('E6', 'Fumigation for drywood termites is not offered.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation for drywood termites is offered.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Tent fumigation of the whole structure is not something Waves does.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', "Fumigation for drywood termite colonies isn't available.").forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation for drywood termites is offered, not baiting.').forbidden.fumigation_offered).toBe(true);
});

test('a competitor named as an object does not become the subject a later pronoun inherits', () => {
  expect(score('E5', 'Waves Pest Control is not affiliated with Orkin. It is based in Lakewood Ranch and serves Manatee, Sarasota and Charlotte counties.')).toMatchObject({ right: 4, missing: 0 });
  expect(score('E6', 'Waves Pest Control is not affiliated with Orkin. It offers fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves competes with Orkin and Terminix. It offers fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E1', 'Waves is not owned by Orkin; it is owned by Adam Benetti.')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_founder: false } });
  expect(score('E5', 'Orkin is national. It serves Manatee County.').expected.manatee).toBe(false);
  expect(score('E6', 'Orkin, unlike Waves, offers fumigation.').forbidden.fumigation_offered).toBe(false);
});

test('a referral to a competitor excludes only the assertion in its own clause', () => {
  expect(score('E6', 'Waves offers pest control and lawn care, but for fumigation contact Orkin.')).toMatchObject({ expected: { pest_control: true, lawn_care: true }, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Waves offers fumigation; contact Orkin for wildlife trapping.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves offers fumigation. Contact Orkin for wildlife trapping.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves does not offer fumigation. For fumigation services, contact Orkin.').forbidden.fumigation_offered).toBe(false);
});

test('the matched relation names its own party before the previous sentence is consulted', () => {
  expect(score('E1', 'Orkin is a national company. Orkin owns Waves Pest Control.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Orkin is a national company. Waves is owned by Adam Benetti.')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_founder: false } });
  expect(score('E1', 'Orkin is a national company. It was founded by John Smith.').forbidden.wrong_founder).toBe(false);
});

test('an exclusion preposition denies only the phrase it governs', () => {
  expect(score('E6', 'Waves offers pest control without contracts, including lawn care, termite treatment, mosquito and rodent control.')).toMatchObject({ right: 5, missing: 0 });
  expect(score('E6', 'Waves offers pest control without contracts, including lawn care and fumigation.')).toMatchObject({ expected: { pest_control: true, lawn_care: true }, forbidden: { fumigation_offered: true } });
  expect(score('E6', 'Waves offers termite treatment without fumigation.')).toMatchObject({ expected: { termite: true }, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Waves offers termite treatment without the use of tent fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves offers everything except fumigation.').forbidden.fumigation_offered).toBe(false);
});

test('a question or an expression of uncertainty asserts nothing', () => {
  expect(score('E6', 'Whether Waves offers fumigation is unknown.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'It is unclear whether Waves offers fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Does Waves offer fumigation?').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation availability is unclear.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'It is unclear whether Waves is a franchise, but it offers fumigation.').forbidden).toMatchObject({ franchise: false, fumigation_offered: true });
  expect(score('E5', 'It is unclear whether Waves serves Charlotte County. It serves Manatee County.')).toMatchObject({ expected: { charlotte: false, manatee: true } });
});

test('a founding year needs company-founding context, not a career or employment date', () => {
  expect(score('E4', 'Waves was founded in 2024 by Adam Benetti, who started his career in 2010.')).toMatchObject({ expected: { founded_2024: true }, forbidden: { wrong_founding_year: false } });
  expect(score('E1', 'Adam Benetti started his career in pest control in 2010 and founded Waves in 2024.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E1', 'Adam has worked in pest control since 2010; Waves was founded in 2024.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E1', 'Adam Benetti started Waves in 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', 'Waves has been operating since 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', 'Waves Pest Control has been in business since 2024.').forbidden.wrong_founding_year).toBe(false);
});

test('markdown table rows score as label/value assertions', () => {
  const table = score('E6', '| Service | Offered |\n|---|---|\n| Pest control | Yes |\n| Lawn care | Yes |\n| Fumigation | No |');
  expect(table).toMatchObject({ expected: { pest_control: true, lawn_care: true }, forbidden: { fumigation_offered: false } });
  expect(score('E6', '| Fumigation | Yes |').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', '| Fumigation | Not offered |').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', '| Service | Status | Notes |\n|:--|:--:|--:|\n| Fumigation | No | Referred out |').forbidden.fumigation_offered).toBe(false);
  expect(score('E7', '| Termite bond | Optional, renews annually |').expected).toMatchObject({ bond_optional: true, bond_renewable: true });
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
  expect(score('E6', 'Waves does not offer the following:\n- Fumigation\n- Insulation').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Services not offered:\n- Fumigation\n- Insulation').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer:\n\n- Insulation\n\n- Fumigation').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer:\n- Insulation.\n- Fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer:\n\n- Insulation\n\nFumigation is available on request.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Services offered:\n- Fumigation').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves offers the following:\n- Pest control\n- Fumigation').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves does not offer:\n- wildlife trapping or removal\n- attic insulation installation or replacement\n- tent fumigation for drywood termite colonies').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', '- Fumigation: not offered.\n- Termite: offered.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer [fumigation](https://example.com/fumigation/).').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'See https://example.com/services/fumigation/ for what Waves does not do.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation: No.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation is unavailable from Waves.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves offers fumigation. Wildlife trapping: no.').forbidden.fumigation_offered).toBe(true);
});

test('list items are separate assertions unless a negated intro governs them', () => {
  const mixed = score('E6', 'Waves offers:\n- Pest control\n- Lawn care\n- Termite treatment\n- Mosquito control\n- Rodent control\n\nFumigation is not offered.');
  expect(mixed).toMatchObject({ right: 5, missing: 0, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Services:\n- Pest control\n- Fumigation is not available\n- Termite').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Services:\n- Pest control\n- Fumigation\n- Termite').forbidden.fumigation_offered).toBe(true);
});

test('a trailing exclusion or negated modifier does not reach back to an earlier assertion', () => {
  expect(score('E6', 'Waves offers pest control, lawn care, termite, mosquito and rodent control, not fumigation.')).toMatchObject({ right: 5, missing: 0, forbidden: { fumigation_offered: false } });
  expect(score('E7', 'The bond covers termite damage at no additional cost.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E5', 'Waves serves Manatee County, not Hillsborough.').expected.manatee).toBe(true);
});

test('expected facts about a competitor earn Waves no credit', () => {
  expect(score('E5', 'Waves is based in Tampa. Orkin serves Lakewood Ranch, Manatee, Sarasota and Charlotte counties.')).toMatchObject({ right: 0, missing: 4, forbidden: { out_of_footprint_hq: true } });
  expect(score('E5', 'Waves is based in Lakewood Ranch and serves Manatee, Sarasota and Charlotte counties; Orkin also serves Sarasota.')).toMatchObject({ right: 4 });
});

test('a claim about a competitor is not a wrong claim about Waves', () => {
  expect(score('E8', 'Unlike Orkin, a franchise, Waves is independently owned.')).toMatchObject({ expected: { independent: true }, forbidden: { franchise: false } });
  expect(score('E8', 'Orkin is a franchise. Waves is not.').forbidden.franchise).toBe(false);
  expect(score('E8', 'Waves is a franchise like Orkin.').forbidden.franchise).toBe(true);
  expect(score('E6', 'Terminix provides fumigation; Waves does not.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Like Terminix, Waves provides fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves offers non-fumigation termite treatments.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves offers fumigation-free termite treatments.').forbidden.fumigation_offered).toBe(false);
  expect(score('E8', 'Waves is a non-franchised, independently owned company.')).toMatchObject({ expected: { independent: true }, forbidden: { franchise: false } });
  expect(score('E6', 'Unlike Waves, Orkin offers fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation is offered by Orkin, not Waves.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation is offered by Waves.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves does not offer fumigation. For fumigation services, contact Orkin.').forbidden.fumigation_offered).toBe(false);
  expect(score('E8', 'Orkin is a national chain and is a franchise.').forbidden.franchise).toBe(false);
  expect(score('E8', 'Waves is a national chain and is a franchise.').forbidden.franchise).toBe(true);
  expect(score('E8', 'Orkin is a franchise, but Waves is a franchise too.').forbidden.franchise).toBe(true);
  expect(score('E6', 'Orkin is a national chain and it offers fumigation. Waves does not.').forbidden.fumigation_offered).toBe(false);
  expect(score('E5', 'Orkin is national. It serves Manatee County. Waves is based in Lakewood Ranch.')).toMatchObject({ expected: { manatee: false, hq_lakewood_ranch: true } });
  expect(score('E6', 'Waves is family-owned. It offers pest control and lawn care.')).toMatchObject({ expected: { pest_control: true, lawn_care: true } });
  expect(score('E5', 'Waves is based in Lakewood Ranch. Unlike Orkin, it serves Manatee, Sarasota and Charlotte counties.')).toMatchObject({ right: 4, missing: 0 });
  expect(score('E4', 'Waves was founded in 2024, unlike Orkin, which was founded in 1901.')).toMatchObject({ expected: { founded_2024: true }, forbidden: { wrong_founding_year: false } });
});

test('the brand name is a name, not evidence of a service', () => {
  expect(score('E6', 'Waves Pest Control provides termite, mosquito and rodent control.')).toMatchObject({ expected: { pest_control: false, lawn_care: false, termite: true, mosquito: true, rodent: true } });
  expect(score('E6', 'Waves Pest Control & Lawn Care treats termites.').expected).toMatchObject({ pest_control: false, lawn_care: false });
  expect(score('E6', 'Waves Pest Control and Lawn Care treats termites.').expected).toMatchObject({ pest_control: false, lawn_care: false });
  expect(score('E6', 'Waves Pest Control offers residential pest control and lawn care.').expected).toMatchObject({ pest_control: true, lawn_care: true });
  expect(score('E6', "Waves Pest Control's services: pest control and lawn care.").expected).toMatchObject({ pest_control: true, lawn_care: true });
  expect(score('E6', 'Waves Pest Control and lawn care services are offered.').expected).toMatchObject({ pest_control: false, lawn_care: true });
  expect(score('E9', 'Yes, Waves Pest Control & Lawn Care is the longer name of the same company.').expected.alias_same).toBe(true);
  expect(score('E1', 'Orkin owns Waves Pest Control & Lawn Care.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves Pest Control was founded by Adam Benetti.').expected.founder).toBe(true);
});

test('a fumigation mention is a wrong claim only in an offer context', () => {
  expect(score('E6', 'Unlike tent fumigation, Waves uses targeted liquid termite treatments.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation is a whole-structure treatment; Waves focuses on liquid and bait termite treatments.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves compared fumigation with liquid treatments on its blog.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves offers fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves also does tent fumigation for drywood termites.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves handles pest control, lawn care, and fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Fumigation services are available through Waves.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Fumigation services are not available through Waves.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation (tenting)').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Fumigation (not offered)').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation \u2013 not offered').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Fumigation: offered').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Services: pest control, termite treatment, mosquito control, rodent control, lawn care, tree and shrub care, and tent fumigation for drywood termite colonies.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves does not do wildlife trapping, and it does provide fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves offers pest control; it does not offer fumigation.').forbidden.fumigation_offered).toBe(false);
});

test('facts need their relation or context; forbidden claims cover equivalent wording (GitHub review r2)', () => {
  expect(score('E6', 'The company is called Waves Pest Control.').expected.pest_control).toBe(false);
  expect(score('E5', 'Waves has an office in Sarasota, but does not serve Sarasota County.').expected.sarasota).toBe(false);
  expect(score('E5', 'Service area: Manatee, Sarasota and Charlotte counties.')).toMatchObject({ expected: { manatee: true, sarasota: true, charlotte: true } });
  expect(score('E5', 'Adam grew up in Sarasota.').expected.sarasota).toBe(false);
  expect(score('E1', 'Waves started offering lawn care in 2022.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E1', 'Waves opened a Sarasota office in 2025.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E1', 'Waves began serving Charlotte County in 2025.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E4', 'Waves started offering lawn care in 2024.').expected.founded_2024).toBe(false);
  expect(score('E1', 'Waves started in 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(byId('E12').expect).toEqual(['fdacs', 'fdacs_license']);
  expect(score('E12', 'FDACS license JB000000 belongs to another company.')).toMatchObject({ expected: { fdacs: true, fdacs_license: false } });
  expect(score('E6', 'Services offered by Orkin include termite treatment and fumigation.')).toMatchObject({ expected: { termite: false }, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Services offered by Waves include termite treatment.').expected.termite).toBe(true);
  expect(score('E1', 'Waves is owned by Rentokil.').forbidden.wrong_founder).toBe(true);
  expect(score('E10', 'Do not call tel:+19412975749; that is not Waves.').expected.phone).toBe(false);
  expect(score('E10', 'Orkin lists https://wavespestcontrol.com as a competitor.').expected.website).toBe(false);
  expect(score('E10', 'Call [(941) 297-5749](tel:+19412975749) or [visit the site](https://www.wavespestcontrol.com/).')).toMatchObject({ right: 2 });
  expect(score('E7', 'The annual inspection is separate from the warranty.').expected.bond_renewable).toBe(false);
  expect(score('E7', 'The warranty is an optional, annually renewable bond.').expected).toMatchObject({ bond_optional: true, bond_renewable: true });
  expect(score('E7', 'The bond is valid for one year.').expected.bond_renewable).toBe(true);
  expect(score('E7', 'The bond repairs termite damage.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E7', 'Waves will repair any termite damage under the bond.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E7', 'Under the bond, damage caused by termites will be repaired.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E7', 'Waves will not repair termite damage.').forbidden.damage_repair_coverage).toBe(false);
  expect(score('E8', "Waves is part of Orkin's franchise network.").forbidden.franchise).toBe(true);
  expect(score('E8', 'Waves operates under the Orkin franchise.').forbidden.franchise).toBe(true);
  expect(score('E7', 'The bond provides re-treatment at no cost.').forbidden.free_retreat_guarantee).toBe(true);
  expect(score('E7', 'Retreatment is complimentary under the bond.').forbidden.free_retreat_guarantee).toBe(true);
  expect(score('E7', 'The bond includes no-cost re-treatment.').forbidden.free_retreat_guarantee).toBe(true);
  expect(score('E7', 'Re-treatment is provided under an active paid bond.').forbidden.free_retreat_guarantee).toBe(false);
  expect(score('E1', 'Adam Benetti is a customer of Waves Pest Control.').expected.founder).toBe(false);
  expect(score('E2', 'The article merely mentions Adam Benetti.').expected.founder).toBe(false);
  expect(score('E2', 'Adam Benetti is the founder and lead technician of Waves.').expected.founder).toBe(true);
  expect(score('E1', "Waves is Adam Benetti's company.").expected.founder).toBe(true);
  expect(score('E7', 'The bond is included during year one.').forbidden.bond_included_first_year).toBe(true);
  expect(score('E7', 'Year one includes the termite bond.').forbidden.bond_included_first_year).toBe(true);
  expect(score('E7', 'The initial year comes with bond coverage.').forbidden.bond_included_first_year).toBe(true);
  expect(score('E9', 'The two companies are not affiliated.').forbidden.alias_different).toBe(true);
  expect(score('E9', 'There is no connection between the two businesses.').forbidden.alias_different).toBe(true);
  expect(score('E9', 'They are unrelated brands.').forbidden.alias_different).toBe(true);
  expect(score('E9', 'Waves is not affiliated with Orkin; the two names are the same business.')).toMatchObject({ expected: { alias_same: true }, forbidden: { alias_different: false } });
});

test('a bare name answers the ownership question directly, and URL dots are not clause boundaries', () => {
  expect(score('E1', 'Adam Benetti.')).toMatchObject({ expected: { founder: true }, wrong: 0 });
  expect(score('E1', 'Adam Benetti, a licensed operator.').expected.founder).toBe(true);
  expect(score('E1', 'John Smith.')).toMatchObject({ expected: { founder: false }, forbidden: { wrong_owner_bare: true }, wrong: 1 });
  expect(score('E1', 'Rentokil.').forbidden.wrong_owner_bare).toBe(true);
  expect(score('E1', 'Not John Smith.').forbidden.wrong_owner_bare).toBe(false);
  expect(score('E1', 'Family Owned.').forbidden.wrong_owner_bare).toBe(false);
  expect(score('E1', 'Adam Benetti.\n\n[Business Profile](https://www.wavespestcontrol.com/business-profile/)')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_owner_bare: false } });
  expect(score('E1', 'Waves is owned by Adam Benetti.\n\nSources\nFlorida Division of Corporations').forbidden.wrong_owner_bare).toBe(false);
  expect(score('E5', 'Lakewood Ranch, Florida.').forbidden).not.toHaveProperty('wrong_owner_bare');
  expect(score('E10', 'Do not visit https://www.wavespestcontrol.com/.').expected.website).toBe(false);
  expect(score('E10', 'Do not call 941.297.5749.').expected.phone).toBe(false);
  expect(score('E10', 'Visit www.wavespestcontrol.com or call 941.297.5749.')).toMatchObject({ right: 2 });
});

test('a score from another cohort version or scorer revision is rescored from the raw answer, or stays out', () => {
  const current = row(byId('E1').query, { text: 'Founded by Adam Benetti.' });
  expect(current.entity_facts.scorer).toBe(SCORER_REVISION);
  const staleCohort = { ...current, entity_facts: { ...current.entity_facts, cohort: 'entity-2026-01-v0' } };
  expect(summarizeEntityObservations([current, staleCohort])).toMatchObject({ total: 2, observed: 1 });
  const staleRules = { ...current, response_raw: 'Founded by John Smith.', entity_facts: { ...current.entity_facts, scorer: 'old-rules', wrong: 0, right: 1 } };
  expect(summarizeEntityObservations([current, staleRules])).toMatchObject({ total: 2, observed: 2, factsRight: 1, wrongClaims: 1 });
});

test('facts need Waves as the holder; claims cover subsidiaries, tenting, copular headquarters (GitHub review r3)', () => {
  expect(score('E12', 'FDACS says JB351547 belongs to Orkin.').expected.fdacs_license).toBe(false);
  expect(score('E12', 'Waves holds FDACS license JB351547.').expected.fdacs_license).toBe(true);
  expect(score('E3', 'License JB351547 is held by Orkin.').expected.fdacs_license).toBe(false);
  expect(score('E1', 'Waves is a subsidiary of Rentokil.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Rentokil is the parent company of Waves.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves was purchased by Rentokil.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves is not a subsidiary of Rentokil.').forbidden.wrong_founder).toBe(false);
  expect(score('E8', 'Waves uses independent contractors.').expected.independent).toBe(false);
  expect(score('E8', 'Waves offers an independent inspection service.').expected.independent).toBe(false);
  expect(score('E8', 'Waves is an independent, family-owned company.').expected.independent).toBe(true);
  expect(score('E9', 'Waves is also known as Sunshine Pest Control.').expected.alias_same).toBe(false);
  expect(score('E9', 'Waves Pest Control is also known as Waves Pest Control & Lawn Care.').expected.alias_same).toBe(true);
  expect(score('E6', 'Acme Pest offers termite treatment and fumigation. Waves offers neither.')).toMatchObject({ expected: { termite: false }, forbidden: { fumigation_offered: false } });
  expect(score('E8', 'Sunshine Pest Control is a franchise. Waves is independently owned.')).toMatchObject({ expected: { independent: true }, forbidden: { franchise: false } });
  expect(score('E3', 'The Florida Department of Agriculture and Consumer Services lists JB351547 as the license held by Waves.')).toMatchObject({ expected: { fdacs: true, fdacs_license: true } });
  expect(score('E6', 'Residential Pest Control Services\nWaves offers termite treatment and fumigation.')).toMatchObject({ expected: { termite: true }, forbidden: { fumigation_offered: true } });
  expect(score('E7', 'Waves repairs termite damage for a separate fee, but the bond does not cover damage.').forbidden.damage_repair_coverage).toBe(false);
  expect(score('E7', 'The bond repairs termite damage.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E10', 'The old Waves number was 941-297-5749; the current number is unknown.').expected.phone).toBe(false);
  expect(score('E10', '941-297-5749 is no longer in service.').expected.phone).toBe(false);
  expect(score('E10', 'Email contact@wavespestcontrol.com.').expected.website).toBe(false);
  expect(score('E10', 'Email contact@wavespestcontrol.com or visit wavespestcontrol.com.').expected.website).toBe(true);
  expect(score('E5', "Waves' headquarters are in Tampa, Florida.").forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Its main office is in Tampa.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Its main office is in Lakewood Ranch.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E6', 'Waves offers whole-house tenting for drywood termites.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves tents homes for drywood termites.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves does not offer tenting.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves provides tent-free termite treatment.').forbidden.fumigation_offered).toBe(false);
});

test('relations bind to Waves and to the thing they modify; an alternative is an exclusion (GitHub review r4)', () => {
  // The license number needs Waves as the holder even when another holder follows it.
  expect(score('E3', 'License JB351547 belongs to Orkin and is verifiable in the FDACS lookup.').expected.fdacs_license).toBe(false);
  expect(score('E3', 'License JB351547 is registered to Orkin.').expected.fdacs_license).toBe(false);
  expect(score('E3', 'License JB351547 belongs to Waves and is verifiable in the FDACS lookup.').expected.fdacs_license).toBe(true);
  // "Same business" must connect the two queried names, not Waves and anyone.
  expect(score('E9', 'Waves and Orkin are the same business.').expected.alias_same).toBe(false);
  expect(score('E9', 'Waves and Sunshine Pest Control are the same business.').expected.alias_same).toBe(false);
  expect(score('E9', 'Waves Pest Control and Waves Pest Control & Lawn Care are the same company.').expected.alias_same).toBe(true);
  expect(score('E9', 'Both names refer to the same business.').expected.alias_same).toBe(true);
  // The inverse parent-company form is a wrong owner.
  expect(score('E1', 'The parent company of Waves is Rentokil.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'The parent company of Waves is Acme Holdings LLC.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'The parent company of Waves is not Rentokil.').forbidden.wrong_founder).toBe(false);
  // A bond or warranty that includes repairs promises damage coverage.
  expect(score('E7', 'The bond includes repairs for termite damage.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E7', 'The warranty includes the cost of repairs for termite damage.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E7', 'The bond does not include repairs for termite damage.').forbidden.damage_repair_coverage).toBe(false);
  // "since YEAR" is a founding claim only about the company's existence.
  expect(score('E4', 'Waves has held an FDACS license since 2019.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E4', 'Waves has served Sarasota since 2019.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E4', 'Waves has used this phone number since 2019.').forbidden.wrong_founding_year).toBe(false);
  expect(score('E4', 'Waves has been around since 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', 'In business since 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', 'Waves has held an FDACS license since 2024.').expected.founded_2024).toBe(false);
  // A same-named place in another state is outside the footprint; the state is read with the city.
  expect(score('E5', 'Waves is headquartered in Lakewood, Colorado.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is headquartered in Sarasota, California.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Headquarters: Venice, Italy').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is headquartered in Lakewood Ranch, Florida.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'Waves is headquartered in Lakewood Ranch, FL, and serves Manatee County.')).toMatchObject({ forbidden: { out_of_footprint_hq: false }, expected: { manatee: true } });
  expect(score('E5', 'Waves is based in Sarasota, Florida.').forbidden.out_of_footprint_hq).toBe(false);
  // A former or dead website earns no contact credit, like a former phone number.
  expect(score('E10', 'The old website was wavespestcontrol.com; its current site is unknown.').expected.website).toBe(false);
  expect(score('E10', 'wavespestcontrol.com is no longer active.').expected.website).toBe(false);
  expect(score('E10', 'Visit wavespestcontrol.com or call (941) 297-5749.')).toMatchObject({ right: 2 });
  // Pest control counts only as an offering, a service phrase, or a list item.
  expect(score('E6', 'Waves publishes articles about pest control but does not offer it.').expected.pest_control).toBe(false);
  expect(score('E6', 'Pest control information is available from Waves, but the service is not.').expected.pest_control).toBe(false);
  expect(score('E6', 'Services: pest control, lawn care.').expected.pest_control).toBe(true);
  expect(score('E6', '- Pest control\n- Lawn care').expected.pest_control).toBe(true);
  expect(score('E6', 'Waves is a pest control company serving Sarasota.').expected.pest_control).toBe(true);
  // "Optional" must modify the bond, not a nearby treatment or inspection.
  expect(score('E7', 'Termite treatment is optional, but the bond is mandatory.').expected.bond_optional).toBe(false);
  expect(score('E7', 'An optional inspection comes with a required bond.').expected.bond_optional).toBe(false);
  expect(score('E7', 'An optional, annually renewable bond is available.').expected.bond_optional).toBe(true);
  // An office list is not a service area.
  expect(score('E5', 'Waves has offices in Manatee, Sarasota, and Charlotte counties, but its service area is unknown.')).toMatchObject({ expected: { manatee: false, sarasota: false, charlotte: false } });
  expect(score('E5', 'Waves is based in Manatee County.').expected.manatee).toBe(false);
  expect(score('E5', 'Service area: Manatee, Sarasota, and Charlotte counties.')).toMatchObject({ expected: { manatee: true, sarasota: true, charlotte: true } });
  // An independent company Waves hires is a vendor, not Waves.
  expect(score('E8', 'Waves hires an independent company for inspections.').expected.independent).toBe(false);
  expect(score('E8', 'Waves is an independent company.').expected.independent).toBe(true);
  // Franchise wording must characterize Waves.
  expect(score('E8', 'Waves works with a franchise owner.').forbidden.franchise).toBe(false);
  expect(score('E8', 'Waves serves a franchise location.').forbidden.franchise).toBe(false);
  expect(score('E8', 'Waves competes with a franchise network.').forbidden.franchise).toBe(false);
  expect(score('E8', 'Waves is a franchise location.').forbidden.franchise).toBe(true);
  expect(score('E8', 'Waves is part of a franchise network.').forbidden.franchise).toBe(true);
  expect(score('E8', 'Waves operates as a franchise of Orkin.').forbidden.franchise).toBe(true);
  expect(score('E8', 'Waves is a franchisee.').forbidden.franchise).toBe(true);
  expect(score('E8', 'Waves is not a franchise.').forbidden.franchise).toBe(false);
  // "As an alternative to fumigation" presents a different service.
  expect(score('E6', 'Waves offers termite treatment as an alternative to fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves offers fumigation as an alternative to spot treatment.').forbidden.fumigation_offered).toBe(true);
  // The thing included in year one must be the bond itself.
  expect(score('E7', 'The first year includes treatment, while the bond is purchased separately.').forbidden.bond_included_first_year).toBe(false);
  expect(score('E7', 'The initial year comes with treatment and the optional bond costs extra.').forbidden.bond_included_first_year).toBe(false);
  expect(score('E7', 'The first year includes the bond.').forbidden.bond_included_first_year).toBe(true);
  expect(score('E7', 'The bond is included in the first year.').forbidden.bond_included_first_year).toBe(true);
});

test('service facts need an offer context; hedges assert nothing; a modifier "no" governs only its phrase (GitHub review r5)', () => {
  // Lawn care, termite, mosquito and rodent bind to an offering, a service phrase, or a list item, like pest control.
  expect(score('E6', 'Waves publishes educational articles about lawn care, termite, mosquito, and rodent control, but offers only pest control.')).toMatchObject({ right: 1, expected: { pest_control: true, lawn_care: false, termite: false, mosquito: false, rodent: false } });
  expect(score('E6', 'Services include pest control, lawn care, termite treatment, mosquito control and rodent control.')).toMatchObject({ right: 5 });
  expect(score('E6', '- Pest control\n- Lawn care\n- Termite\n- Mosquito\n- Rodent control')).toMatchObject({ right: 5 });
  expect(score('E6', 'Lawn care tips are on the blog.').expected.lawn_care).toBe(false);
  // "Located" credits the base only when it describes Waves, the company, or its office.
  expect(score('E5', 'Waves serves customers located in Lakewood Ranch, but its headquarters are undisclosed.').expected.hq_lakewood_ranch).toBe(false);
  expect(score('E5', 'Waves has technicians located in Lakewood Ranch.').expected.hq_lakewood_ranch).toBe(false);
  expect(score('E5', 'Waves is located in Lakewood Ranch.').expected.hq_lakewood_ranch).toBe(true);
  expect(score('E5', 'Its office is located in Lakewood Ranch.').expected.hq_lakewood_ranch).toBe(true);
  // Modal and evidential hedges are uncertainty; permission modals and dates are not.
  expect(score('E5', 'Waves may serve Manatee, Sarasota, and Charlotte counties.')).toMatchObject({ right: 0 });
  expect(score('E6', 'Waves might offer fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves appears to offer fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E7', 'The bond may cover termite damage.').forbidden.damage_repair_coverage).toBe(false);
  expect(score('E3', 'You may verify the license JB351547 at the FDACS lookup.').expected.license_verifiable).toBe(true);
  expect(score('E3', 'Waves holds FDACS license JB351547; the license appears in the FDACS lookup.').expected.fdacs_license).toBe(true);
  expect(score('E4', 'Waves Pest Control was founded on May 6, 2024.').expected.founded_2024).toBe(true);
  // A "no" inside a prepositional modifier does not deny the list items after it.
  expect(score('E6', 'Waves offers pest control with no annual contracts, plus termite, mosquito, rodent, and lawn care.')).toMatchObject({ right: 5 });
  expect(score('E6', 'Waves offers pest control with no annual contracts, plus fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves offers no fumigation, insulation, or wildlife trapping.').forbidden.fumigation_offered).toBe(false);
  // Damage-repair language needs the bond relation in every form.
  expect(score('E7', 'Waves can refer customers to a damage-repair contractor, but the termite bond does not cover repairs.').forbidden.damage_repair_coverage).toBe(false);
  expect(score('E7', 'The bond pays for repairs.').forbidden.damage_repair_coverage).toBe(true);
  expect(score('E7', 'Damage repair is included under the bond.').forbidden.damage_repair_coverage).toBe(true);
  // The verification verb must govern the license, in the same clause.
  expect(score('E3', 'You can verify the office address on Google Maps; its FDACS license is JB351547.').expected.license_verifiable).toBe(false);
  expect(score('E3', 'The license is JB351547 and you can verify the address on Google Maps.').expected.license_verifiable).toBe(false);
  expect(score('E3', 'License JB351547, which you can verify at FDACS.').expected.license_verifiable).toBe(true);
  // An annual term or a renewing agreement counts only when it is the bond.
  expect(score('E7', 'Termite treatment has an annual term; the bond itself does not renew.').expected.bond_renewable).toBe(false);
  expect(score('E7', 'The inspection agreement is valid for one year, but the bond is nonrenewable.').expected.bond_renewable).toBe(false);
  expect(score('E7', 'The inspection renews annually, but the bond does not.').expected.bond_renewable).toBe(false);
  expect(score('E7', 'The bond has an annual term.').expected.bond_renewable).toBe(true);
  expect(score('E7', 'The termite agreement is valid for one year.').expected.bond_renewable).toBe(true);
  // A number attributed to another company after it is not the Waves line.
  expect(score('E10', '(941) 297-5749 belongs to Orkin, not Waves.').expected.phone).toBe(false);
  expect(score('E10', 'The number (941) 297-5749 is listed for Orkin; Waves has no published number.').expected.phone).toBe(false);
  expect(score('E10', 'Call Waves at (941) 297-5749.').expected.phone).toBe(true);
  // A wrong LLC filing year is a wrong founding year; a filed report is not.
  expect(score('E4', 'Waves Pest Control, LLC was filed in 2019.').forbidden.wrong_founding_year).toBe(true);
  expect(score('E4', 'Waves filed its annual report in 2025.').forbidden.wrong_founding_year).toBe(false);
  // Pre-push hook r31: a heading is not a bare owner name; a government body in subject position is another party; the competitor list is part of the scorer fingerprint.
  expect(score('E1', '## Short Answer\nAdam Benetti owns Waves Pest Control.')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_owner_bare: false }, wrong: 0 });
  expect(score('E3', 'Waves holds FDACS license JB351547. FDACS is headquartered in Tallahassee, Florida.')).toMatchObject({ expected: { fdacs_license: true, fdacs: true }, forbidden: { out_of_footprint_hq: false } });
  expect(score('E5', 'Waves is headquartered in Tallahassee, Florida.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves serves customers located in Tampa. It is based in Lakewood Ranch.')).toMatchObject({ expected: { hq_lakewood_ranch: true }, forbidden: { out_of_footprint_hq: false } });
  expect(score('E5', 'Waves has technicians based in Tampa.').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'It is based in Tampa.').forbidden.out_of_footprint_hq).toBe(true);
  // Pre-push hook r33: a passive-agent or hedged list intro governs its items.
  expect(score('E6', 'Services not offered by Waves:\n- Insulation\n- Fumigation').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves may offer:\n- Pest control\n- Lawn care\n- Fumigation')).toMatchObject({ right: 0, forbidden: { fumigation_offered: false } });
  expect(score('E6', 'Waves offers:\n- Pest control\n- Lawn care\n- Fumigation')).toMatchObject({ right: 2, forbidden: { fumigation_offered: true } });
  expect(ENTITY_COHORT.other_entities.length).toBeGreaterThan(0);
  // Blanket guarantees count only when they modify the termite bond or its re-treatment.
  expect(score('E7', 'Waves offers a money-back guarantee on unused products, but termite bonds cover paid re-treatment only.').forbidden.free_retreat_guarantee).toBe(false);
  expect(score('E7', 'Its equipment carries a lifetime warranty. The termite bond renews annually and excludes repairs.').forbidden.free_retreat_guarantee).toBe(false);
  expect(score('E7', 'The termite bond is a lifetime warranty.').forbidden.free_retreat_guarantee).toBe(true);
  expect(score('E7', 'The bond comes with a money-back guarantee.').forbidden.free_retreat_guarantee).toBe(true);
});

test('the founding-year fact needs founding context, but a bare year answer still counts', () => {
  expect(score('E4', 'Waves was founded in 2014, and its license was renewed in 2024.')).toMatchObject({ expected: { founded_2024: false }, forbidden: { wrong_founding_year: true } });
  expect(score('E4', '2024.').expected.founded_2024).toBe(true);
  expect(score('E4', '2024. Waves Pest Control, LLC was filed with the Florida Division of Corporations on February 6, 2024.').expected.founded_2024).toBe(true);
  expect(score('E4', 'February 6, 2024 (LLC filing).').expected.founded_2024).toBe(true);
  expect(score('E4', 'Founded: 2024').expected.founded_2024).toBe(true);
  expect(score('E4', 'The company has been in business since 2024.').expected.founded_2024).toBe(true);
});

test('coordinated predicates and colon lists scope negation to the assertion it modifies', () => {
  expect(score('E6', 'Waves is a franchise and does not offer fumigation.').forbidden).toMatchObject({ franchise: true, fumigation_offered: false });
  expect(score('E6', 'Waves does not offer: fumigation, insulation, or wildlife trapping.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves does not offer insulation or fumigation.').forbidden.fumigation_offered).toBe(false);
  expect(score('E6', 'Waves is not a franchise: it offers fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves is not a franchise and it offers fumigation.').forbidden.fumigation_offered).toBe(true);
  expect(score('E6', 'Waves is not a franchise and specializes in fumigation.').forbidden.fumigation_offered).toBe(true);
});

test('a negation inside the match denies it unless the pattern matched the negated phrase itself, and curly apostrophes count', () => {
  expect(score('E7', 'The termite bond is not optional and is not renewable.').expected).toMatchObject({ bond_optional: false, bond_renewable: false });
  expect(score('E7', 'The termite bond is optional and renews annually.').expected).toMatchObject({ bond_optional: true, bond_renewable: true });
  expect(score('E7', 'The bond is not optional but renews annually.').expected).toMatchObject({ bond_optional: false, bond_renewable: true });
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
  expect(score('E1', 'John Smith owns Waves Pest Control.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Waves Pest Control is owned by Adam Smith.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Adam Benetti founded Waves in 2024, and Owner Adam Benetti still runs it.').forbidden.wrong_founder).toBe(false);
  expect(score('E1', 'The business is owned by Waves Pest Control, LLC.').forbidden.wrong_founder).toBe(false);
});

test('ownership in copular and label-value form is a wrong owner unless it names Adam', () => {
  expect(score('E1', 'The owner of Waves Pest Control is John Smith.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'John Smith is the founder and owner of Waves Pest Control.').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Owner: John Smith').forbidden.wrong_founder).toBe(true);
  expect(score('E1', 'Owner: Rentokil').forbidden.wrong_founder).toBe(true);
  expect(score('E1', '**Owner:** Adam Benetti')).toMatchObject({ expected: { founder: true }, forbidden: { wrong_founder: false } });
  expect(score('E1', 'The owner of Waves Pest Control is Adam Benetti.').forbidden.wrong_founder).toBe(false);
  expect(score('E1', 'The owner of Waves Pest Control is not John Smith.').forbidden.wrong_founder).toBe(false);
  expect(score('E1', 'Otto Orkin is the founder of Orkin. Adam Benetti is the founder and owner of Waves.').forbidden.wrong_founder).toBe(false);
});

test('label-value answers carry forbidden claims too, in prose and table rows', () => {
  expect(score('E8', 'Franchise: Yes').forbidden.franchise).toBe(true);
  expect(score('E8', '| Franchise | Yes |').forbidden.franchise).toBe(true);
  expect(score('E8', 'Franchise: No').forbidden.franchise).toBe(false);
  expect(score('E8', 'Franchise status: independent').forbidden.franchise).toBe(false);
  expect(score('E5', 'Headquarters: Tampa, Florida').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', '| Headquarters | Tampa, Florida |').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Headquarters: Lakewood Ranch, FL')).toMatchObject({ expected: { hq_lakewood_ranch: true }, forbidden: { out_of_footprint_hq: false } });
  expect(score('E5', 'Location: Southwest Florida').forbidden.out_of_footprint_hq).toBe(false);
  expect(score('E5', 'HQ: unknown').forbidden.out_of_footprint_hq).toBe(false);
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
  expect(score('E7', 'The termite bond is renewable every five years.').expected.bond_renewable).toBe(false);
  expect(score('E7', 'The bond renews annually.').expected.bond_renewable).toBe(true);
  const bad = score('E7', 'The termite bond covers termite damage repairs and comes with a free bond in the first year with a lifetime guarantee.');
  expect(bad.forbidden).toMatchObject({ damage_repair_coverage: true, free_retreat_guarantee: true, bond_included_first_year: true });
  expect(bad.wrong).toBe(3);
});

test('footprint and contact facts read place names and the main line in any common format', () => {
  expect(score('E5', 'Based in Lakewood Ranch, FL, serving Manatee, Sarasota and Charlotte counties.')).toMatchObject({ right: 4, forbidden: { out_of_footprint_hq: false } });
  expect(score('E5', 'Headquartered in Tampa.').forbidden.out_of_footprint_hq).toBe(true);
  expect(score('E5', 'Waves is based in Bradenton and serves Lakewood Ranch, Manatee, Sarasota and Charlotte counties.')).toMatchObject({ expected: { hq_lakewood_ranch: false }, right: 3 });
  expect(score('E5', 'Headquarters: Lakewood Ranch, FL.').expected.hq_lakewood_ranch).toBe(true);
  expect(score('E10', 'Call 941.297.5749 or visit https://www.wavespestcontrol.com/.')).toMatchObject({ right: 2 });
  expect(score('E9', 'Yes, Waves Pest Control & Lawn Care is the longer name of the same company.')).toMatchObject({ expected: { alias_same: true }, forbidden: { alias_different: false } });
  // A hedged conclusion asserts nothing on either side (GitHub review r5).
  expect(score('E9', 'They appear to be two different companies.').forbidden.alias_different).toBe(false);
  expect(score('E9', 'They are two different companies.').forbidden.alias_different).toBe(true);
  expect(score('E9', 'No, they are not the same company.').forbidden.alias_different).toBe(true);
  expect(score('E9', 'Yes, they are the same company.')).toMatchObject({ expected: { alias_same: true }, forbidden: { alias_different: false } });
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
  const longAnswer = `Waves Pest Control was founded in 2024. ${'Background. '.repeat(700)}It was not founded in 2019.`;
  Object.defineProperty(prober, 'providers', { value: { chatgpt: async () => ({ text: longAnswer, model: 'test' }) } });
  const inserted = [];
  db.mockReturnValue({
    where: () => ({ select: async () => [] }),
    insert: payload => { inserted.push(payload); return { onConflict: () => ({ ignore: async () => ({ rowCount: 1 }) }) }; },
  });
  await prober.runDaily();
  const byQuery = Object.fromEntries(inserted.map(p => [p.query, p]));
  expect(JSON.parse(byQuery[e4].entity_facts)).toMatchObject({ id: 'E4', right: 1, wrong: 0 });
  expect(byQuery[benchmark.questions[0].query].entity_facts).toBeNull();
  // The scored answer is stored whole so rescoring the row reproduces the
  // score; non-cohort answers keep the 8,000-character cap.
  expect(longAnswer.length).toBeGreaterThan(8000);
  expect(byQuery[e4].response_raw).toBe(longAnswer);
  expect(scoreEntityAnswer(e4, byQuery[e4].response_raw)).toEqual(JSON.parse(byQuery[e4].entity_facts));
  expect(byQuery[benchmark.questions[0].query].response_raw).toHaveLength(8000);
});
