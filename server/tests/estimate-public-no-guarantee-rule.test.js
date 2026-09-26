/**
 * serviceMixMakesNoGuaranteeClaim (routes/estimate-public.js): the estimate
 * page's guarantee decision, read from the same normalized rows and
 * classifiers the page renders from. Owner ruling: termite carries no
 * guarantee of any kind. Codex #4982 r1: setup rows must not count as
 * unclassified work, termite work stored where the one-time rows don't reach
 * must still be seen, and unclassified service rows fail closed.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { serviceMixMakesNoGuaranteeClaim, normalizeOneTimeBreakdown } = require('../routes/estimate-public');

const PEST = [{ name: 'Pest Control', mo: 55 }];
const charge = (service, label, amount) => ({ service, label, amount, kind: 'charge' });

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
