// Annual-prepay "Service plan" dropdown: plans that differ only by cadence stay
// separate options, true duplicates still merge (sweep #3960 A3).
import { describe, expect, it } from 'vitest';
import { deriveAnnualPrepayServiceOptions, inferAnnualPrepaySuggestedAmount } from './Customer360ProfileV2';

const labels = (options) => options.map((option) => option.label);

describe('deriveAnnualPrepayServiceOptions cadence dedupe', () => {
  it('keeps plans that differ only by cadence', () => {
    const options = deriveAnnualPrepayServiceOptions({}, null, [
      { serviceType: 'Lawn Care - Every 2 Months' },
      { serviceType: 'Lawn Care - Every 3 Months' },
    ]);
    expect(labels(options)).toEqual(['Lawn Care - Every 2 Months', 'Lawn Care - Every 3 Months']);
  });

  it('keeps named-cadence plans such as Quarterly and Semiannual apart', () => {
    const options = deriveAnnualPrepayServiceOptions({}, null, [], [
      { coverageServiceType: 'Quarterly Pest Control' },
      { coverageServiceType: 'Semiannual Pest Control' },
    ]);
    expect(labels(options)).toEqual(['Quarterly Pest Control', 'Semiannual Pest Control']);
  });

  it('still merges true duplicates across sources', () => {
    const options = deriveAnnualPrepayServiceOptions(
      { serviceTypes: 'quarterly pest control, Pest Control' },
      { coverageServiceType: 'Quarterly Pest Control', planLabel: 'Quarterly Pest Control Annual Prepay' },
      [{ serviceType: 'Quarterly Pest Control' }],
    );
    expect(labels(options)).toEqual(['Quarterly Pest Control']);
  });

  it('merges a label with no cadence into a same-service option', () => {
    const options = deriveAnnualPrepayServiceOptions({ serviceTypes: 'Lawn Care' }, null, [
      { serviceType: 'Lawn Care - Every 2 Months' },
    ]);
    expect(labels(options)).toEqual(['Lawn Care - Every 2 Months']);
  });

  it('falls back to Pest Control when nothing is known', () => {
    expect(labels(deriveAnnualPrepayServiceOptions({}))).toEqual(['Pest Control']);
  });
});

// Amount suggestion follows the selected plan's cadence (codex P1 on the A3 fix).
describe('inferAnnualPrepaySuggestedAmount cadence match', () => {
  const twoPlans = [
    { serviceType: 'Lawn Care - Every 2 Months', seriesTotal: 600 },
    { serviceType: 'Lawn Care - Every 3 Months', seriesTotal: 400 },
  ];
  const suggest = (customer, label, plans = twoPlans, activeTerm = null) => (
    inferAnnualPrepaySuggestedAmount({ ...customer, prepaidPlans: plans }, label, 'quarterly', activeTerm, plans)
  );

  it('suggests each prepaid plan its own total', () => {
    expect(suggest({}, 'Lawn Care - Every 2 Months')).toBe(600);
    expect(suggest({}, 'Lawn Care - Every 3 Months')).toBe(400);
  });

  it('suggests each annual term its own pre-tax base', () => {
    const terms = [
      { status: 'active', coverageServiceType: 'Lawn Care - Every 2 Months', prepayAmount: 600 },
      { status: 'active', coverageServiceType: 'Lawn Care - Every 3 Months', prepayAmount: 400 },
    ];
    const customer = { annualPrepayTerms: terms };
    expect(suggest(customer, 'Lawn Care - Every 3 Months', [])).toBe(400);
    expect(suggest(customer, 'Lawn Care - Every 2 Months', [])).toBe(600);
  });

  it('does not take another cadence plan price when no plan has the cadence', () => {
    expect(suggest({}, 'Lawn Care - Every 4 Months')).toBe(0);
  });

  it('falls back to the profile rate, never another plan, when no plan has the cadence', () => {
    expect(suggest({ annualValue: 1000 }, 'Lawn Care - Every 4 Months')).toBe(1000);
  });

  it('keeps the single-plan case unchanged', () => {
    const plans = [{ serviceType: 'Quarterly Pest Control', seriesTotal: 320 }];
    expect(suggest({}, 'Quarterly Pest Control', plans)).toBe(320);
    expect(suggest({}, 'Pest Control', plans)).toBe(320);
    expect(suggest({}, 'Pest Control - Every 3 Months', [{ serviceType: 'Pest Control', seriesTotal: 320 }])).toBe(320);
  });
});
