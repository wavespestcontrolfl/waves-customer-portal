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
  supplementalCompanionLines,
} = require('../services/estimate-converter');
const { serviceKeyFor, buildRecurringFollowUpRows } = require('../services/recurring-appointment-seeder');

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
      { name: 'Lawn Fertilization & Weed Control', frequency: 'bimonthly', appsPerYear: 6 },
      { name: 'Tree & Shrub Care Program', frequency: 'bimonthly', visitsPerYear: 6 },
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

  test('lawn/T&S ignores the billing-cadence selection — explicit visits rule (Codex P1)', () => {
    // Lawn plans commonly BILL monthly while visiting bimonthly; the
    // accept-frequency override is a pest-route semantic only.
    const { combos } = combineRecurringServicesForScheduling(
      [
        { name: 'Lawn Fertilization & Weed Control', appsPerYear: 6 },
        { name: 'Tree & Shrub Care Program', visitsPerYear: 6 },
      ],
      { acceptFrequency: 'monthly' },
    );
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Lawn + Tree & Shrub');
    expect(combos[0].service.frequency).toBe('bimonthly');
  });

  test('9-app lawn never combines with a 6-visit T&S program (same bimonthly pattern bucket)', () => {
    // patternFromVisitsPerYear buckets 6–11 visits as "bimonthly" — explicit
    // visit counts are the cadence truth (Codex P1).
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Lawn Fertilization & Weed Control', appsPerYear: 9 },
      { name: 'Tree & Shrub Care Program', visitsPerYear: 6 },
    ]);
    expect(combos).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('lawn + T&S without explicit visit counts stay separate (visits required for this route)', () => {
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Lawn Fertilization & Weed Control', frequency: 'bimonthly' },
      { name: 'Tree & Shrub Care Program', frequency: 'bimonthly' },
    ]);
    expect(combos).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('explicit unequal visit counts block combining on any route', () => {
    const { combos } = combineRecurringServicesForScheduling([
      { name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4 },
      { name: 'Rodent Bait Stations', frequency: 'quarterly', visitsPerYear: 5 },
    ]);
    expect(combos).toEqual([]);
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

  test('line-level visit counts drive the combo cadence when no plan selection was recorded', () => {
    const { combos } = combineRecurringServicesForScheduling([
      { name: 'Pest Control', visitsPerYear: 4 },
      { name: 'Termite Bait Station System', visitsPerYear: 4 },
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0].service.frequency).toBe('quarterly');
  });

  test('the ACCEPTED selection beats stale quote-time line cadence on the primary (Codex P1)', () => {
    // Customer quoted quarterly (line carries visits 4) but switched the
    // plan to monthly at accept — the quarterly companion must NOT combine.
    const { combos } = combineRecurringServicesForScheduling(
      [
        { name: 'Pest Control', service: 'pest_control', frequency: 'quarterly', visitsPerYear: 4 },
        { name: 'Rodent Bait Stations', service: 'rodent_bait' },
      ],
      { acceptFrequency: 'monthly' },
    );
    expect(combos).toEqual([]);
  });

  test('stale line visit counts never BLOCK an accepted quarterly combo (Codex P1)', () => {
    // Public accept can leave the original pest line at 12 visits while the
    // rodent line carries 4 — the accepted quarterly plan must still
    // combine; the stale count neither blocks nor rides.
    const { combos } = combineRecurringServicesForScheduling(
      [
        { name: 'Pest Control', service: 'pest_control', visitsPerYear: 12 },
        { name: 'Rodent Bait Stations', service: 'rodent_bait', visitsPerYear: 4 },
      ],
      { acceptFrequency: 'quarterly' },
    );
    expect(combos).toHaveLength(1);
    expect(combos[0].service.frequency).toBe('quarterly');
    expect(combos[0].service.visitsPerYear).toBe(4);
  });

  test('stale line visit counts never ride a combo whose cadence the selection overrode (Codex P1)', () => {
    // Stale monthly line (12 visits) + accepted quarterly plan: the combo is
    // quarterly and must NOT carry visitsPerYear 12 — the seeder would plan
    // 12 follow-ups at quarterly spacing.
    const { combos } = combineRecurringServicesForScheduling(
      [
        { name: 'Pest Control', service: 'pest_control', visitsPerYear: 12 },
        { name: 'Rodent Bait Stations', service: 'rodent_bait' },
      ],
      { acceptFrequency: 'quarterly' },
    );
    expect(combos).toHaveLength(1);
    expect(combos[0].service.frequency).toBe('quarterly');
    expect(combos[0].service.visitsPerYear).toBeUndefined();
  });

  test('a primary with no cadence anywhere never combines', () => {
    // Pest line has no service-level cadence and no accepted frequency was
    // passed — the platform's "pest defaults quarterly" must NOT bypass the
    // gate (Codex P2). The rodent companion's program default alone cannot
    // create a combo.
    const { remaining, combos } = combineRecurringServicesForScheduling([
      { name: 'Pest Control' },
      { name: 'Rodent Bait Stations' },
    ]);
    expect(combos).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  test('the ACCEPTED frequency is the primary cadence when the line omits one', () => {
    // Real server-priced accept: pest line carries no frequency; the
    // customer selected the quarterly plan. Companion defaults to its
    // quarterly program → combine.
    const quarterly = combineRecurringServicesForScheduling(
      [{ name: 'Pest Control', service: 'pest_control' }, { name: 'Rodent Bait Stations', service: 'rodent_bait' }],
      { acceptFrequency: 'quarterly' },
    );
    expect(quarterly.combos).toHaveLength(1);
    expect(quarterly.combos[0].service.frequency).toBe('quarterly');

    // Legacy monthly pest plan: accepted monthly ≠ quarterly bait program →
    // stays separate (Codex P2 regression).
    const monthly = combineRecurringServicesForScheduling(
      [{ name: 'Pest Control', service: 'pest_control' }, { name: 'Rodent Bait Stations', service: 'rodent_bait' }],
      { acceptFrequency: 'monthly' },
    );
    expect(monthly.combos).toEqual([]);
  });

  test('termite bait with no persisted cadence combines via its quarterly program default (Codex P2)', () => {
    // v1-legacy-mapper persists "Termite Bait" with no frequency/visits.
    const { combos } = combineRecurringServicesForScheduling([
      { name: 'Pest Control', service: 'pest_control', visitsPerYear: 4 },
      { name: 'Termite Bait', service: 'termite_bait' },
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Quarterly Pest + Termite Bait Station');
    expect(combos[0].service.frequency).toBe('quarterly');
  });

  test('rodent bait supplements (rodentBaitMo) join the match — server-priced estimates never put them in services (Codex P2)', () => {
    const supplements = supplementalCompanionLines({
      result: { recurring: { rodentBaitMo: 39 } },
    });
    expect(supplements).toHaveLength(1);
    expect(recurringServiceKey(supplements[0])).toBe('rodent_bait');

    const { remaining, combos } = combineRecurringServicesForScheduling(
      [{ name: 'Pest Control', service: 'pest_control', frequency: 'quarterly' }],
      { supplementalCompanions: supplements },
    );
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Pest & Rodent Control');
    expect(remaining).toEqual([]);
  });

  test('supplemental extraction reads both persisted shapes', () => {
    expect(supplementalCompanionLines({ recurring: { rodentBaitMo: 25 } })).toHaveLength(1);
    expect(supplementalCompanionLines({ result: { results: { rodBaitMo: 25 } } })).toHaveLength(1);
    expect(supplementalCompanionLines({ result: { recurring: {} } })).toEqual([]);
    expect(supplementalCompanionLines({})).toEqual([]);
  });

  test('combined follow-up rows inherit the parent service_id (Codex P2)', () => {
    const rows = buildRecurringFollowUpRows(
      {
        id: 'parent-1',
        customer_id: 'cust-1',
        scheduled_date: '2026-06-20',
        service_type: 'Pest & Rodent Control',
        service_id: 'catalog-uuid-1',
      },
      { pattern: 'quarterly' },
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.service_id).toBe('catalog-uuid-1');
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
