/**
 * serviceMixMakesNoGuaranteeClaim (routes/estimate-public.js): the estimate
 * page's guarantee decision, read from the same normalized rows and
 * classifiers the page renders from. Owner ruling: termite carries no
 * guarantee of any kind. Codex #4982 r1: setup rows must not count as
 * unclassified work, termite work stored where the one-time rows don't reach
 * must still be seen, and unclassified service rows fail closed.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  serviceMixMakesNoGuaranteeClaim,
  estimateMakesNoGuaranteeClaim,
  normalizeOneTimeBreakdown,
  guaranteeRecurringRows,
  guaranteeProposalRows,
  serviceMixCarriesPlanTerms,
} = require('../routes/estimate-public');

const PEST = [{ name: 'Pest Control', mo: 55 }];
const { generateEstimate } = require('../services/pricing-engine');
const charge = (service, label, amount) => ({ service, label, amount, kind: 'charge' });

describe('serviceMixCarriesPlanTerms (a guarantee line covering the whole estimate)', () => {
  const rec = (name) => ({ name, mo: 50 });
  const one = (service, label) => ({ service, label, amount: 150, kind: 'charge' });
  test.each([
    ['pest', [rec('Pest Control')], [], true],
    ['pest + lawn', [rec('Pest Control'), rec('Lawn Care')], [], true],
    ['pest + a one-time flea treatment', [rec('Pest Control')], [one('flea', 'Flea Treatment')], true],
    ['rodent', [rec('Rodent Bait Stations')], [], false],
    ['pest + rodent', [rec('Pest Control'), rec('Rodent Bait Stations')], [], false],
    ['commercial pest', [rec('Commercial Pest Control')], [], false],
    ['pest + termite bait', [rec('Pest Control'), rec('Termite Bait Monitoring')], [], false],
    ['one-time rodent trapping', [], [one('rodent_trapping', 'Rodent Trapping')], false],
    ['nothing', [], [], false],
  ])('%s', (_name, recurring, oneTime, expected) => {
    expect(serviceMixCarriesPlanTerms(recurring, oneTime)).toBe(expected);
  });
});

describe('serviceMixMakesNoGuaranteeClaim', () => {
  test('a pest-only plan keeps its guarantee claims', () => {
    expect(serviceMixMakesNoGuaranteeClaim(PEST, [])).toBe(false);
  });

  test('a WaveGuard setup row or a discount never counts as unclassified work', () => {
    expect(serviceMixMakesNoGuaranteeClaim(PEST, [
      charge('waveguard_setup', 'WaveGuard Setup', 99),
      { service: 'manual_discount', label: 'Discount', amount: -20, kind: 'discount' },
    ])).toBe(false);
  });

  test.each([
    ['one-time trenching beside a pest plan', PEST, [charge('termite_trenching', 'Termite Trenching', 1200)]],
    ['a WDO inspection', PEST, [charge('wdo_inspection', 'WDO Inspection', 125)]],
    ['Bora-Care', [], [charge('bora_care', 'Bora-Care Wood Treatment', 800)]],
    ['recurring termite bait', [{ name: 'Termite Bait Monitoring', mo: 45 }], []],
    ['recurring foam named only by its wording', [{ name: 'Foam Treatment Recurring', mo: 60 }], []],
    ['termite bait mixed into a lawn label', [{ name: 'Lawn Care and Termite Bait Monitoring', mo: 80 }], []],
    ['termite bait mixed into a mosquito label', [{ name: 'Mosquito and Termite Bait Monitoring', mo: 80 }], []],
  ])('termite work: %s', (_, recurring, oneTime) => {
    expect(serviceMixMakesNoGuaranteeClaim(recurring, oneTime)).toBe(true);
  });

  test('an unclassifiable one-time service row fails closed', () => {
    expect(serviceMixMakesNoGuaranteeClaim(PEST, [charge('mystery_service', 'Specialty service', 150)])).toBe(true);
  });

  test('an unclassifiable recurring service row fails closed; a membership line does not count', () => {
    expect(serviceMixMakesNoGuaranteeClaim([...PEST, { name: 'Quarterly Specialty Visit', mo: 40 }], [])).toBe(true);
    expect(serviceMixMakesNoGuaranteeClaim([...PEST, { name: 'WaveGuard Membership', mo: 0 }], [])).toBe(false);
  });

  test('rodent foam sealing is rodent work, not termite (Codex r2)', () => {
    expect(serviceMixMakesNoGuaranteeClaim(PEST, [
      charge('rodent_exclusion', 'Rodent Exclusion – Foam Sealing', 350),
      charge('rodent_exclusion_followup', 'Foam Sealing Follow-Up (Rodent)', 95),
    ])).toBe(false);
    expect(serviceMixMakesNoGuaranteeClaim(PEST, [charge('foam_drill', 'Foam Drill Treatment', 450)])).toBe(true);
  });

  test('a pest plan saved in the nested results.recurring shape keeps its guarantee (Codex r2)', () => {
    const estData = { result: { results: { recurring: { services: PEST } }, oneTime: { items: [] } } };
    expect(serviceMixMakesNoGuaranteeClaim(guaranteeRecurringRows(estData), normalizeOneTimeBreakdown(estData).items)).toBe(false);
    const termiteNested = { result: { results: { recurring: { services: [{ name: 'Termite Bait Monitoring', mo: 45 }] } } } };
    expect(serviceMixMakesNoGuaranteeClaim(guaranteeRecurringRows(termiteNested), [])).toBe(true);
  });

  test('mapped result rows are unioned with raw engine recurring rows before the guarantee decision', () => {
    const estData = {
      result: { recurring: { services: PEST } },
      engineResult: {
        lineItems: [{ service: 'termite_bait', name: 'Termite Bait Monitoring', recurring: true, monthly: 45 }],
      },
    };
    const rows = guaranteeRecurringRows(estData);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Pest Control' }),
      expect.objectContaining({ service: 'termite_bait' }),
    ]));
    expect(serviceMixMakesNoGuaranteeClaim(rows, [])).toBe(true);
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(true);
  });

  test.each(['lineItems', 'oneTime', 'nestedOneTime', 'specItems'])('raw %s termite work survives a mapped pest-only result', (container) => {
    const rows = [{ service: 'termite_trenching', name: 'Termite Trenching', price: 1200 }];
    const rawShapes = {
      lineItems: { lineItems: rows },
      oneTime: { oneTime: { items: rows } },
      nestedOneTime: { results: { oneTime: { items: rows } } },
      specItems: { specItems: rows },
    };
    const estData = {
      result: { recurring: { services: PEST }, oneTime: { items: [], total: 0 } },
      engineResult: rawShapes[container],
    };
    expect(estimateMakesNoGuaranteeClaim(estData, { oneTimeBreakdown: { items: [] } })).toBe(true);
  });

  test('ordinary pest work in both saved containers retains its guarantees', () => {
    expect(estimateMakesNoGuaranteeClaim({
      result: { recurring: { services: PEST }, oneTime: { items: [] } },
      engineResult: { lineItems: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 250 }] },
    })).toBe(false);
  });

  test('unwrapped legacy one-time termite work participates beside a recurring pest plan', () => {
    const estData = {
      recurring: { services: PEST },
      oneTime: { items: [{ service: 'termite_trenching', name: 'Termite Trenching', price: 1200 }] },
    };
    expect(estimateMakesNoGuaranteeClaim(estData, { oneTimeBreakdown: { items: [] } })).toBe(true);
    expect(estimateMakesNoGuaranteeClaim({ ...estData, oneTime: { items: [] } })).toBe(false);
  });

  test.each([
    ['pest_control', { pest: { frequency: 'quarterly' } }, false],
    ['lawn_care', { lawn: { frequency: 'premium' } }, false],
    ['termite_bait', { termite: { stations: 12 } }, true],
    ['bora_care', { pest: { frequency: 'quarterly' }, boraCare: { areaSqFt: 500 } }, true],
  ])('inputs-only %s work is classified from its rendered engine result', (service, services, expected) => {
    const estData = { engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services } };
    expect(generateEstimate(estData.engineInputs).lineItems.map((row) => row.service)).toContain(service);
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(expected);
  });

  test('an authored proposal naming termite work is flagged even when its engine rows are pest only (Codex r4)', () => {
    const estData = {
      result: { recurring: { services: PEST }, oneTime: { items: [] } },
      proposal: {
        enabled: true,
        buildings: [{ name: 'Building A', lineItems: [
          { description: 'Monthly Pest Control', frequency: 'monthly' },
          { description: 'Termite Trenching – Building A perimeter', frequency: 'one_time' },
        ] }],
        programs: [],
      },
    };
    expect(serviceMixMakesNoGuaranteeClaim(guaranteeRecurringRows(estData), guaranteeProposalRows(estData))).toBe(true);
    const pestOnly = { ...estData, proposal: { ...estData.proposal, buildings: [{ name: 'Building A', lineItems: [{ description: 'Monthly Pest Control' }] }] } };
    expect(serviceMixMakesNoGuaranteeClaim(guaranteeRecurringRows(pestOnly), guaranteeProposalRows(pestOnly))).toBe(false);
    expect(guaranteeProposalRows({ proposal: { enabled: true, programs: [{ name: 'Termite Bait Program' }] } })).toEqual([{ name: 'Termite Bait Program', service: null }]);
  });

  test.each([false, undefined])('a stale proposal with enabled=%s cannot remove current pest-plan guarantees', (enabled) => {
    const estData = {
      result: { recurring: { services: PEST }, oneTime: { items: [] } },
      proposal: {
        enabled,
        buildings: [{ lineItems: [{ description: 'Termite Trenching' }] }],
        programs: [{ name: 'Termite Bait Program' }],
        correctiveWork: [{ label: 'Pre-Slab Termiticide Treatment' }],
      },
    };
    expect(guaranteeProposalRows(estData)).toEqual([]);
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(false);
  });

  test('authored corrective work participates in the same fail-closed guarantee decision', () => {
    const estData = {
      proposal: {
        enabled: true,
        programs: [{ name: 'Quarterly Pest Program', service: 'pest' }],
        correctiveWork: [{ label: 'Pre-Slab Termiticide Treatment', service: 'pre_slab_termiticide' }],
      },
    };
    const rows = guaranteeProposalRows(estData);
    expect(rows).toEqual([
      { name: 'Quarterly Pest Program', service: 'pest' },
      { name: 'Pre-Slab Termiticide Treatment', service: 'pre_slab_termiticide' },
    ]);
    expect(serviceMixMakesNoGuaranteeClaim([], rows)).toBe(true);
  });

  test('nothing classifiable at all makes no guarantee', () => {
    expect(serviceMixMakesNoGuaranteeClaim([], [])).toBe(true);
  });

  test('termite work stored only in engine lineItems surfaces as the unclassified residual and fails closed', () => {
    const estData = {
      result: {
        recurring: { services: PEST },
        oneTime: { items: [], total: 1200 },
        lineItems: [{ service: 'termite_trenching', name: 'Termite Trenching', price: 1200 }],
      },
    };
    const rows = normalizeOneTimeBreakdown(estData).items;
    expect(serviceMixMakesNoGuaranteeClaim(PEST, rows)).toBe(true);
  });
});
