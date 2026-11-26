// The palm injection card (owner 2026-11-25, protocols page D8): lethal bronzing prevention with Arbor-OTC is the main service, tested
// first; every other injection follows a diagnosis. Only an injection line is a treatment, each with its own product, and none is
// selected base work on the general application card: the tech picks the one the test or diagnosis supports.
const protocols = require('../config/protocols.json');
const { matchServiceProtocol } = require('../services/protocol-matcher');
const { parseProtocolLines } = require('../services/waveguard-plan-engine');
const { _internals: { buildCompletionActions } } = require('../routes/admin-protocols');

// The live catalog rows (read 2026-11-26): two Arbor-OTC bottle sizes, two IMA-jet strengths.
const PRODUCTS = [
  ['otc1', 'Arborjet Arbor OTC Fungicide 1 oz'], ['otc5', 'Arborjet Arbor OTC Fungicide 5 oz'],
  ['ima10', 'Arborjet Ima-Jet 10'], ['ima5', 'Arborjet Ima-Jet Systemic Insecticide'],
  ['g4', 'Arborjet Tree-Age G-4 Injectable Insecticide'], ['r10', 'ArborJet Tree-Age R10 Insecticide'],
  ['phos', 'Arborjet PHOSPHO-Jet Systemic Fungicide'], ['pj', 'Arborjet Palm-Jet Palm Nutrition'],
  ['mn', 'ArborJet Mn-Jet Fe Micros'], ['prop', 'Arborjet Propizol Injectable Fungicide'],
].map(([id, name]) => ({ id, name, active: true, category: 'tree_injection', application_method: 'trunk_injection' }));
const visitOf = (n) => protocols.palm_injection.visits.find((v) => v.visit === n);
const actionsOf = (visit) => buildCompletionActions({
  lines: [...parseProtocolLines(visit.primary, 'base'), ...parseProtocolLines(visit.secondary, 'conditional')], products: PRODUCTS, programKey: 'palm_injection', visit,
});
const treated = (n) => actionsOf(visitOf(n)).filter((a) => a.treatmentApplied).map((a) => [a.product?.id, a.conditional, a.product?.method]);

describe('palm injection card', () => {
  test('the application card lists each injection as an if-needed line with the exact bottle', () => {
    expect(treated(2).sort()).toEqual([
      ['g4', true, 'trunk_injection'], ['ima10', true, 'trunk_injection'], ['mn', true, 'trunk_injection'],
      ['otc5', true, 'trunk_injection'], ['phos', true, 'trunk_injection'], ['pj', true, 'trunk_injection'],
    ]);
  });

  test('assessment and follow-up record no treatment; the lethal bronzing card records only Arbor-OTC', () => {
    expect([treated(1), treated(3)]).toEqual([[], []]);
    expect(treated(4)).toEqual([['otc5', false, 'trunk_injection']]);
  });

  test('a booking that names lethal bronzing gets the Arbor-OTC card; a plain injection keeps the application card', () => {
    const visit = (name, serviceKey) => matchServiceProtocol(protocols, name, { serviceKey }).matchedVisit?.visit;
    expect(visit('Lethal Bronzing Preventive OTC Program')).toBe(4);
    expect(visit('Palm Injection Service', 'palm_injection')).toBe(2);
    expect(visit('Palm Injection Assessment')).toBe(1);
  });

  test('the job card never names a product on the assessment and takes only the exact bottle on an injection line', async () => {
    const jobCard = require('../services/job-card');
    const card = (catalog, serviceType) => jobCard.resolveVisitLines({ facts: { isLawn: false, serviceType, serviceCategory: 'tree_shrub', serviceKey: 'palm_injection', scheduledDate: '2026-11-27', addons: [] }, protocols, catalog, dbh: () => ({}) });
    expect((await card(PRODUCTS, 'Palm Injection Assessment')).lines).toEqual([]);
    const full = await card(PRODUCTS, 'Palm Injection Service');
    expect(full.lines.map((l) => [l.product.id, l.selected]).sort()).toEqual([['g4', false], ['ima10', false], ['mn', false], ['otc5', false], ['phos', false], ['pj', false]]);
    // G-4 and IMA-jet 10 missing from the catalog: the card leaves them unresolved, never R10 or the 5% IMA-jet, even when the 5%
    // row carries the alias "IMA-jet" (a near name the text pass would otherwise match).
    const aliased = PRODUCTS.filter((p) => !['g4', 'ima10'].includes(p.id)).map((p) => (p.id === 'ima5' ? { ...p, aliases: ['IMA-jet'] } : p));
    expect((await card(aliased, 'Palm Injection Service')).lines.map((l) => l.product.id)).not.toContain('ima5');
    const partial = await card(PRODUCTS.filter((p) => !['g4', 'ima10'].includes(p.id)), 'Palm Injection Service');
    expect(partial.lines.map((l) => l.product.id)).not.toEqual(expect.arrayContaining(['r10']));
    expect(partial.lines.map((l) => l.product.id)).not.toContain('ima5');
    const actions = buildCompletionActions({ lines: [...parseProtocolLines(visitOf(2).secondary, 'conditional')], products: PRODUCTS.filter((p) => p.id !== 'g4'), programKey: 'palm_injection', visit: visitOf(2) });
    expect(actions.map((a) => a.product?.id)).not.toContain('r10');
    // Its safety rules ride the card.
    expect(full.procedure.safety.join(' ')).toMatch(/Never inject a palm whose fruit or nuts anyone eats/);
  });

  test('a stage name beats the disease name, and both prevention names reach the palm program', () => {
    const visit = (name) => matchServiceProtocol(protocols, name).matchedVisit?.visit;
    const program = (name) => matchServiceProtocol(protocols, name).programKey;
    expect(visit('Palm Injection Assessment - Lethal Bronzing')).toBe(1);
    expect(visit('Palm Injection Follow Up - Lethal Bronzing')).toBe(3);
    expect([program('Oxytetracycline Injection'), visit('Oxytetracycline Injection')]).toEqual(['palm_injection', 4]);
    expect([program('Palm Bronzing Prevention'), visit('Palm Bronzing Prevention')]).toEqual(['palm_injection', 4]);
    expect(visit('Lethal Bronzing Assessment')).toBe(1);
    expect(visit('Lethal Bronzing Follow Up')).toBe(3);
    // A booked follow-up (it carries the source visit's name, on a date the tech picks) is the re-inspection, never a dose: the
    // 3-month Arbor-OTC dose is its own scheduled visit.
    const { followupVisitMatch } = require('../services/protocol-matcher');
    const booked = (name) => followupVisitMatch(matchServiceProtocol(protocols, name), true).matchedVisit.visit;
    expect(booked('Lethal Bronzing Preventive OTC Program')).toBe(3);
    expect(booked('Palm Injection Service')).toBe(3);
  });

  test('the assessment tests before the first Arbor-OTC dose and screens out food palms', () => {
    const steps = visitOf(1).primary;
    expect(steps).toMatch(/No lethal bronzing dose until the palm tests negative/);
    expect(steps).toMatch(/fruit or nuts anyone eats, sells or gives away/);
    expect(protocols.palm_injection.safety_rules.join(' ')).toMatch(/Never inject a palm whose fruit or nuts anyone eats, sells or gives away/);
    // Owner 2026-10-01 ("Mechanical labels only"): IMA-jet 10, TREE-äge and PALM-jet show the label line, never a worked-out dose.
    for (const line of visitOf(2).secondary.split('\n').filter((l) => /IMA-jet 10|TREE-äge G4|PALM-jet Mg|Mn-Jet Fe/.test(l))) {
      expect(line).toMatch(/Dose from the .*label's/);
      expect(line).not.toMatch(/\d\s*(tsp|fl oz)/);
    }
    // Arbor-OTC: the label's trunk-width step is on both dose cards.
    for (const n of [2, 4]) expect(`${visitOf(n).primary}\n${visitOf(n).secondary}`).toMatch(/thin or thick trunk moves the dose one size/);
  });
});
