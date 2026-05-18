const {
  calculateAnnualPrepayAmount,
  countTierQualifyingRecurringServices,
  determineTier,
  hasWaveGuardSetupService,
} = require('../services/estimate-converter');

describe('estimate converter annual prepay amount', () => {
  test('uses quoted monthly total times 12, preserving zone/frequency/bundle math', () => {
    expect(calculateAnnualPrepayAmount(84.32)).toBe(1011.84);
    expect(calculateAnnualPrepayAmount('84.315')).toBe(1011.78);
  });

  test('does not collapse to a quarterly base-price shortcut', () => {
    const zoneAndRoachAdjustedMonthly = 195.62 * 4 / 12;

    expect(calculateAnnualPrepayAmount(zoneAndRoachAdjustedMonthly)).toBe(782.48);
    expect(calculateAnnualPrepayAmount(zoneAndRoachAdjustedMonthly)).not.toBe(648);
  });

  test('counts only tier-qualifying recurring services for WaveGuard activation', () => {
    const qualifyingCount = countTierQualifyingRecurringServices([
      { service: 'pest_control', name: 'Pest Control' },
      { service: 'palm_injection', name: 'Palm Injection', waveGuardDiscountEligible: false },
      { service: 'rodent_bait', name: 'Rodent Bait Stations', waveGuardDiscountEligible: false },
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'lawn_care', name: 'Duplicate Lawn Care' },
    ]);

    expect(qualifyingCount).toBe(2);
    expect(determineTier(qualifyingCount, true)).toEqual(expect.objectContaining({ tier: 'Silver' }));
    expect(determineTier(0, true)).toEqual(expect.objectContaining({ tier: 'Bronze' }));
    expect(determineTier(0, false)).toEqual(expect.objectContaining({ tier: 'none' }));
  });

  test('only recurring pest services trigger WaveGuard setup invoices', () => {
    expect(hasWaveGuardSetupService([
      { service: 'palm_injection', name: 'Palm Injection', waveGuardDiscountEligible: false },
      { service: 'rodent_bait', name: 'Rodent Bait Stations', waveGuardDiscountEligible: false },
    ])).toBe(false);

    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(true);
  });
});
