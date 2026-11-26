// The rodent card's close-out actions (owner 2026-11-23/25, protocols page D9 + D15a/b): only placing a rodenticide is a treatment. An
// inspection, a trap, a check, a seal, a non-toxic block or a re-inspection records no treatment, so no re-entry advisory follows it.
const protocols = require('../config/protocols.json');
const { parseProtocolLines } = require('../services/waveguard-plan-engine');
const { _internals: { buildCompletionActions } } = require('../routes/admin-protocols');

const PRODUCTS = [
  { id: 'victor', name: 'Victor Expanded Trigger Rat Snap Trap', active: true, category: 'rodent_trap', default_unit: 'each' },
  { id: 'tomcat', name: 'Tomcat Bait Chunx with Bromethalin', active: true, category: 'rodenticide', epa_reg_number: '12455-132' },
  { id: 'blox', name: 'Contrac Blox', active: true, category: 'rodenticide', epa_reg_number: '12455-79' },
];
const actionsOf = (programKey, visit) => buildCompletionActions({
  lines: [...parseProtocolLines(visit.primary, 'base'), ...parseProtocolLines(visit.secondary, 'conditional')], products: PRODUCTS, programKey, visit,
});

describe('rodent card close-out actions', () => {
  test('only the bait placements on the bait-station card are treatments, each with its own product and never selected base work', () => {
    const treated = [];
    for (const visit of protocols.rodent.visits) {
      for (const action of actionsOf('rodent', visit)) if (action.treatmentApplied) treated.push([visit.visit, action.product?.id, action.conditional, action.product?.method]);
    }
    expect(treated.sort()).toEqual([[5, 'blox', true, 'bait_placement'], [5, 'tomcat', true, 'bait_placement']]);
  });

  test('the pest plan rodent visit splits home and commercial bait into their own if-needed actions', () => {
    const visit = protocols.pest.visits.find((v) => v.visit === 5);
    const bait = actionsOf('pest', visit).filter((action) => ['tomcat', 'blox'].includes(action.product?.id));
    expect(bait.map((action) => [action.product.id, action.conditional, action.treatmentApplied]).sort()).toEqual([['blox', true, true], ['tomcat', true, true]]);
  });

  test('both trap setup cards ask about peanut allergies before the bait step', () => {
    for (const n of [2, 6]) {
      const steps = protocols.rodent.visits.find((v) => v.visit === n).primary.split('\n');
      const ask = steps.findIndex((line) => /peanut allergies/.test(line));
      const bait = steps.findIndex((line) => /pea-size/.test(line));
      expect([n, ask >= 0, ask < bait]).toEqual([n, true, true]);
    }
  });
});
