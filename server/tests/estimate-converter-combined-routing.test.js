/**
 * Combined-service estimate routing (combined-service-completions.md):
 * matching-cadence pairs (pest+rodent bait, pest+termite bait, lawn+T&S)
 * schedule as ONE combined service at accept; mismatched cadences and
 * unrelated lines flow through unchanged. Pricing/tier/billing read the
 * estimate lines and are never touched by combining.
 */
const {
  combineRecurringServicesForScheduling,
  durationMinutesForRecurringService,
  recurringServiceKey,
  reservedRowComboRewrites,
} = require('../services/estimate-converter');
const { serviceKeyFor } = require('../services/recurring-appointment-seeder');

describe('combineRecurringServicesForScheduling', () => {
  test('pest + rodent bait at matching cadence combine into Pest & Rodent Control', () => {
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Rodent Bait Stations', frequency: 'quarterly' },
    ]);
    expect(remaining).toEqual([]);
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Pest & Rodent Control');
    expect(combos[0].service.frequency).toBe('quarterly');
    expect(combos[0].route.catalogServiceKey).toBe('pest_rodent_quarterly');
  });

  test('pest + termite bait combine; lawn + tree & shrub combine', () => {
    const termite = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ]);
    expect(termite.combos[0].service.name).toBe('Quarterly Pest + Termite Bait Station');

    const lawn = combineRecurringServicesForScheduling([
      { name: 'Lawn Fertilization & Weed Control', frequency: 'bimonthly' },
      { name: 'Tree & Shrub Care Program', frequency: 'bimonthly' },
    ]);
    expect(lawn.combos[0].service.name).toBe('Lawn + Tree & Shrub');
    expect(lawn.remaining).toEqual([]);
  });

  test('mismatched cadences stay separate rows', () => {
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Monthly Pest Control', frequency: 'monthly' },
      { name: 'Rodent Bait Stations', frequency: 'quarterly' },
    ]);
    expect(combos).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('a pest line combines with at most ONE companion — rodent bait wins, termite stays standalone', () => {
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      { name: 'Rodent Bait Stations', frequency: 'quarterly' },
      { name: 'Termite Bait Station System', frequency: 'quarterly' },
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Pest & Rodent Control');
    expect(remaining).toHaveLength(1);
    expect(recurringServiceKey(remaining[0])).toBe('termite_bait');
  });

  test('unrelated lines pass through untouched alongside a combo', () => {
    const mosquito = { name: 'Mosquito Treatment', frequency: 'monthly' };
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
      mosquito,
      { name: 'Rodent Bait Stations', frequency: 'quarterly' },
    ]);
    expect(combos).toHaveLength(1);
    expect(remaining).toEqual([mosquito]);
  });

  test('single lines and empty input never combine', () => {
    expect(combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly' },
    ])).toEqual({ remaining: [{ name: 'Quarterly Pest Control', frequency: 'quarterly' }], combos: [] });
    expect(combineRecurringServicesForScheduling([])).toEqual({ remaining: [], combos: [] });
    expect(combineRecurringServicesForScheduling(undefined)).toEqual({ remaining: [], combos: [] });
  });

  test('fallback frequency resolves cadence when lines omit it', () => {
    const { combos } = combineRecurringServicesForScheduling(
      [{ name: 'Pest Control' }, { name: 'Rodent Bait Stations' }],
      { fallbackFrequency: 'quarterly' },
    );
    expect(combos).toHaveLength(1);
    expect(combos[0].service.frequency).toBe('quarterly');
  });
});

describe('reservedRowComboRewrites (slot-reserved accepts)', () => {
  const pestRodentCombo = () => combineRecurringServicesForScheduling([
    { name: 'Quarterly Pest Control', frequency: 'quarterly' },
    { name: 'Rodent Bait Stations', frequency: 'quarterly' },
  ]).combos;

  test('a reserved primary-line row is rewritten to the combined service', () => {
    const row = { id: 'ss-1', service_type: 'Quarterly Pest Control' };
    const rewrites = reservedRowComboRewrites([row], pestRodentCombo());
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].row).toBe(row);
    expect(rewrites[0].combo.route.name).toBe('Pest & Rodent Control');
  });

  test('a reserved companion-line row also maps to the combo', () => {
    const row = { id: 'ss-2', service_type: 'Rodent Bait Stations' };
    const rewrites = reservedRowComboRewrites([row], pestRodentCombo());
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].combo.route.catalogServiceKey).toBe('pest_rodent_quarterly');
  });

  test('both halves separately reserved → NO rewrite (would double-cover the work)', () => {
    const rewrites = reservedRowComboRewrites([
      { id: 'ss-1', service_type: 'Quarterly Pest Control' },
      { id: 'ss-2', service_type: 'Rodent Bait Stations' },
    ], pestRodentCombo());
    expect(rewrites).toEqual([]);
  });

  test('unrelated reserved rows are ignored', () => {
    const rewrites = reservedRowComboRewrites([
      { id: 'ss-3', service_type: 'Mosquito Treatment' },
    ], pestRodentCombo());
    expect(rewrites).toEqual([]);
  });

  test('no combos → no rewrites', () => {
    expect(reservedRowComboRewrites([
      { id: 'ss-1', service_type: 'Quarterly Pest Control' },
    ], [])).toEqual([]);
  });
});

describe('combined-name downstream keys', () => {
  test('serviceKeyFor keys combined names as pest_control (follow-up seeding + cadence defaults)', () => {
    expect(serviceKeyFor({ service_type: 'Pest & Rodent Control' })).toBe('pest_control');
    expect(serviceKeyFor({ service_type: 'Quarterly Pest + Termite Bait Station' })).toBe('pest_control');
    expect(serviceKeyFor({ service_type: 'Lawn + Tree & Shrub' })).toBe('lawn_care');
    // Order is load-bearing: rodent_general_one_time's name leads with
    // rodent and must stay rodent_bait (mirror of the detectServiceLine P2).
    expect(serviceKeyFor({ service_type: 'Rodent Pest Control' })).toBe('rodent_bait');
    expect(serviceKeyFor({ service_type: 'Quarterly Rodent Bait Station Service' })).toBe('rodent_bait');
    expect(serviceKeyFor({ service_type: 'Termite Bait Station System' })).toBe('termite_bait');
  });

  test('explicit duration on a combined synthetic line beats the pest-quarterly default', () => {
    expect(durationMinutesForRecurringService(
      { name: 'Quarterly Pest + Termite Bait Station', estimatedDurationMinutes: 75 },
      'quarterly',
    )).toBe(75);
    // Plain pest quarterly keeps the 60-minute default.
    expect(durationMinutesForRecurringService(
      { name: 'Quarterly Pest Control' },
      'quarterly',
    )).toBe(60);
  });
});
