// Annual-prepay "Service plan" dropdown: plans that differ only by cadence stay
// separate options, true duplicates still merge (sweep #3960 A3).
import { describe, expect, it } from 'vitest';
import { deriveAnnualPrepayServiceOptions } from './Customer360ProfileV2';

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
