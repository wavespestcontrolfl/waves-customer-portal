/**
 * The five chemical area add-ons are a governed one-time program in protocols.json
 * (`area_addon`), routed by catalog service key through the same matcher as the fire ant,
 * flea, tick and bed bug treatments (Codex round 6 on #6135). This file proves the program
 * is well formed and that every consumer of protocols.json handles it without a
 * recurring-program assumption, a name-based leak into another program, or a catalog-default
 * rate.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const protocols = require('../config/protocols.json');
const { AREA_ADDONS } = require('../services/pricing-engine/constants');
const { matchServiceProtocol, MATCH_RULES } = require('../services/protocol-matcher');
const { resolveCompletionDefaultProductNames } = require('../services/completion-product-defaults');
const jobCard = require('../services/job-card');
const KnowledgeBase = require('../services/knowledge-base');

const CHEMICAL = Object.values(AREA_ADDONS.items).filter((cfg) => cfg.serviceKey !== 'area_addon_web_sweep');
const program = protocols.area_addon;

describe('the area_addon program', () => {
  test('is a one-time program with one visit per chemical add-on and none for the web sweep', () => {
    expect(program.one_time).toBe(true);
    expect(program.visits).toHaveLength(CHEMICAL.length);
    expect(program.visits.map((v) => v.visit)).toEqual([1, 2, 3, 4, 5]);
    expect(MATCH_RULES.filter((r) => r.programKey === 'area_addon').map((r) => r.serviceKeys[0]).sort())
      .toEqual(CHEMICAL.map((cfg) => cfg.serviceKey).sort());
  });

  test.each(CHEMICAL.map((cfg) => [cfg.serviceKey, cfg]))('%s: matcher routes its key to its own visit, never by name', (serviceKey, cfg) => {
    const match = matchServiceProtocol(protocols, cfg.name, { serviceKey });
    expect(match).toMatchObject({ programKey: 'area_addon', matched: true, reason: serviceKey });
    expect(match.matchedVisit.labelFacts.rate).toEqual(expect.any(String));
    // The same display name WITHOUT the key falls to the program it always did (fire ant: pest ant visit),
    // and no other service reaches this program.
    expect(matchServiceProtocol(protocols, cfg.name).programKey).not.toBe('area_addon');
  });

  test('no recurring-program fields: no tiers, no month, no yearly cost tokens', () => {
    for (const visit of program.visits) {
      expect(visit.month).toBe('Any');
      expect(visit.tiers).toBeUndefined();
      expect(visit.completionDefaultProducts).toBeUndefined();
      expect(Object.keys(visit.lineMeta)).toEqual([visit.primary]);
      expect(visit.labelFacts).toMatchObject({ rate: expect.any(String), area: expect.any(String), limit: expect.any(String) });
    }
  });

  test('the label facts are exactly the numbers the owner rulings fixed', () => {
    const facts = Object.fromEntries(program.visits.map((v) => [Object.values(v.lineMeta)[0].catalogProductHints[0], v.labelFacts]));
    expect(facts['Snapshot 2.5TG']).toMatchObject({ rate: expect.stringContaining('3.45 lb per 1,000 sq ft of bed'), limit: expect.stringMatching(/600 lb per acre.*12 months.*60 days/) });
    expect(facts['Arena 50 WDG']).toMatchObject({ rate: expect.stringContaining('0.147 oz per 1,000 sq ft'), limit: expect.stringMatching(/8 weeks.*2 applications/), safety: expect.stringContaining('2028-12-31'), requiresGrass: 'st_augustine' });
    expect(facts['Arena 50 WDG'].rate).toContain('4 gal of water per 1,000 sq ft');
    expect(facts['Topchoice Granular Insecticide']).toMatchObject({ rate: expect.stringContaining('2 lb per 1,000 sq ft'), limit: 'Once per 12 months.', safety: expect.stringMatching(/Restricted-use/) });
    expect(facts['Acelepryn Insecticide']).toMatchObject({ rate: expect.stringContaining('0.184 fl oz per 1,000 sq ft'), limit: 'Once in 12 months.', safety: null });
    expect(JSON.stringify(facts['Acelepryn Insecticide'])).not.toMatch(/0\.4|16 fl oz|ceiling|maximum/i);
    expect(facts['Roundup QuikPro SC']).toMatchObject({ rate: expect.stringContaining('16 fl oz in 1 gal'), limit: expect.stringMatching(/32 fl oz per 1,000 sq ft.*12 months/), safety: expect.stringContaining('indaziflam') });
  });
});

describe('consumers of protocols.json', () => {
  test('completion prefill offers none of them: no completionDefaultProducts, so no catalog-default rate (Arena 0.29, Acelepryn 0.05) is ever seeded', () => {
    for (const cfg of CHEMICAL) {
      const resolved = resolveCompletionDefaultProductNames({ protocols, serviceType: cfg.name, serviceKey: cfg.serviceKey, month: 4 });
      expect(resolved).toMatchObject({ programKey: 'area_addon', source: 'none', names: [] });
    }
  });

  test('the knowledge-base entry lists one-time treatments, not "Visits/Year", costs or tiers', () => {
    const entry = KnowledgeBase._internals.protocolEntry('area_addon', program, ['area_addon']);
    expect(entry.category).toBe('protocols');
    expect(entry.content).toContain('5 one-time treatments');
    expect(entry.content).not.toMatch(/Visits\/Year|Legacy materials|Tiers:|\$/);
    // A recurring program is unchanged.
    expect(KnowledgeBase._internals.protocolEntry('bed_bug', protocols.bed_bug, ['bed_bug']).content).toContain('Visits/Year');
  });

  test('the knowledge index and the get_protocol reader render it as an ordinary program with visits', async () => {
    const { executeTechTool } = require('../services/intelligence-bar/tech-tools');
    const r = await executeTechTool('get_protocol', { service_type: 'area_addon' });
    expect(r.type).toBe('area_addon');
    expect(r.protocol.visits).toHaveLength(5);
  });

  test('the admin programs list names only its listed programs, so the new key does not appear there', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin-protocols.js'), 'utf8');
    expect(src).not.toMatch(/PROGRAM_KEYS = \[[^\]]*area_addon/);
  });
});

describe('the job card resolves the program through the existing matcher', () => {
  const catalog = [
    { id: 'p1', name: 'Snapshot 2.5TG' }, { id: 'p2', name: 'Arena 50 WDG' }, { id: 'p3', name: 'Topchoice Granular Insecticide' },
    { id: 'p4', name: 'Acelepryn Insecticide' }, { id: 'p5', name: 'Roundup QuikPro SC' },
  ];

  test.each(CHEMICAL.map((cfg, i) => [cfg.serviceKey, cfg, `p${i + 1}`]))('%s resolves its own product line with the label facts attached', async (serviceKey, cfg, id) => {
    const out = await jobCard.resolveVisitLines({
      facts: { serviceType: cfg.name, serviceCategory: cfg.category, serviceKey, scheduledDate: '2026-09-04', addons: [] },
      protocols, catalog, dbh: () => ({}),
    });
    expect(out.visit).toMatchObject({ month: 'Any' });
    expect(out.lines.map((l) => l.product.id)).toEqual([id]);
    expect(out.lines[0]).toMatchObject({ selected: true, role: 'base', governed: expect.objectContaining({ rate: expect.any(String) }) });
  });
});

describe('Codex round 8: "Once a year (April)" was declared but never enforced - April is advice, any month is allowed', () => {
  const acelepryn = program.visits.find((v) => Object.values(v.lineMeta)[0].catalogProductHints[0] === 'Acelepryn Insecticide');

  test('the limit is the enforced one (maxPerYear 1, no minimum gap) and names no month', () => {
    expect(AREA_ADDONS.items.lawn_insect_preventive).toMatchObject({ maxPerYear: 1, limitProduct: 'Acelepryn Insecticide' });
    expect(AREA_ADDONS.items.lawn_insect_preventive.minDaysApart).toBeUndefined();
    expect(acelepryn.labelFacts.limit).toBe('Once in 12 months.');
    expect(JSON.stringify(program.visits.map((v) => v.labelFacts))).not.toMatch(/april/i);
  });

  test('April is an advisory timing note on the visit, and says any month is allowed', () => {
    expect(acelepryn.notes).toBe('Best timing: April, before mole cricket nymphs and caterpillars build. Any month is allowed.');
    expect(acelepryn.month).toBe('Any');
  });

  test('the pricer comment no longer states April as a limit', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'pricing-engine', 'constants.js'), 'utf8');
    expect(source).not.toMatch(/once a year \(April\)/i);
    expect(source).toContain('once in 12 months (April is the best time, not a limit');
  });

  test('the technician-instruction lines are worded as instructions, not as limits the system claims to enforce', () => {
    const byProduct = Object.fromEntries(program.visits.map((v) => [Object.values(v.lineMeta)[0].catalogProductHints[0], v]));
    expect(byProduct['Snapshot 2.5TG'].labelFacts.safety).toMatch(/^Technician instruction: clear existing weeds/);
    expect(byProduct['Arena 50 WDG'].labelFacts.safety).toMatch(/^Technician instruction: carry the Florida FIFRA 2\(ee\) sheet/);
    expect(byProduct['Roundup QuikPro SC'].labelFacts.safety).toContain('Technician instruction: apply to hard surfaces and bare ground only');
    expect(byProduct['Roundup QuikPro SC'].notes).toMatch(/^Technician instruction: apply to hard surfaces/);
    expect(byProduct['Snapshot 2.5TG'].notes).toMatch(/^Technician instruction:/);
  });
});
