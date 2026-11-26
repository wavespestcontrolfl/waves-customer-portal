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

  test('the assessment tests before the first Arbor-OTC dose and screens out food palms', () => {
    const steps = visitOf(1).primary;
    expect(steps).toMatch(/No Arbor-OTC dose until the palm tests negative/);
    expect(steps).toMatch(/fruit the family eats/);
    expect(protocols.palm_injection.safety_rules.join(' ')).toMatch(/Never inject a palm whose fruit or nuts the family eats/);
  });
});
