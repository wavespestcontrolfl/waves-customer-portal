const {
  linesFromScheduledServices,
  missingLines,
  matchesFilter,
  SELLABLE_LINES,
} = require('../services/newsletter-audience-profiles');

describe('newsletter audience profiles — service-line classification', () => {
  test('classifies recurring pest + lawn from free-text service_type', () => {
    const { lines, hasRecurring } = linesFromScheduledServices([
      { service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true },
      { service_type: 'Lawn Care Visit #3', status: 'pending', is_recurring: true },
    ]);
    expect(lines.sort()).toEqual(['lawn', 'pest']);
    expect(hasRecurring).toBe(true);
  });

  test('recurringOnly (default) excludes one-off jobs — keeps them cross-sell eligible', () => {
    const rows = [
      { service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true },
      // A live (non-terminal) one-off job: recurringOnly gates it, not status.
      { service_type: 'One-Time Rodent Exclusion', status: 'confirmed', is_recurring: false },
    ];
    // Default: a one-off rodent job does NOT make them "has rodent".
    expect(linesFromScheduledServices(rows).lines.sort()).toEqual(['pest']);
    // Looser definition can be requested explicitly.
    expect(linesFromScheduledServices(rows, { recurringOnly: false }).lines.sort())
      .toEqual(['pest', 'rodent']);
  });

  test('ignores terminal-status services (cancelled/completed/skipped) — only live coverage counts', () => {
    // Matches the canonical active-recurring definition (TERMINAL_STATUSES in
    // waveguard-existing-services): completed/cancelled/skipped/no_show/
    // rescheduled rows are NOT current coverage, so they don't make a customer
    // "have" that line (and don't wrongly suppress a missing_service target).
    const { lines } = linesFromScheduledServices([
      { service_type: 'Quarterly Pest Control', status: 'cancelled', is_recurring: true },
      { service_type: 'Lawn Care', status: 'completed', is_recurring: true },
      { service_type: 'Rodent Plan', status: 'skipped', is_recurring: true },
      { service_type: 'Mosquito Treatment', status: 'confirmed', is_recurring: true },
    ]);
    expect(lines).toEqual(['mosquito']);
  });

  test('folds palm injection and commercial variants into their sellable line', () => {
    const { lines } = linesFromScheduledServices([
      { service_type: 'Palm Injection - Lethal Bronzing', status: 'confirmed', is_recurring: true },
      { service_type: 'Commercial Pest Control', status: 'confirmed', is_recurring: true },
    ]);
    expect(lines.sort()).toEqual(['pest', 'tree_shrub']);
  });

  test('missingLines is the sellable universe minus held lines', () => {
    expect(missingLines(['pest']).sort()).toEqual(
      ['lawn', 'mosquito', 'rodent', 'termite', 'tree_shrub'],
    );
    expect(missingLines(SELLABLE_LINES)).toEqual([]);
  });
});

describe('newsletter audience profiles — segment filter', () => {
  const pestOnly = {
    is_customer: true, region_zone: 'manatee', waveguard_tier: 'Bronze', line_count: 1,
    has: { pest: true, lawn: false, mosquito: false, tree_shrub: false, termite: false, rodent: false },
  };
  const pestAndLawn = {
    is_customer: true, region_zone: 'sarasota', waveguard_tier: 'Silver', line_count: 2,
    has: { pest: true, lawn: true, mosquito: false, tree_shrub: false, termite: false, rodent: false },
  };
  const lead = {
    is_customer: false, region_zone: null, waveguard_tier: null, line_count: 0,
    has: { pest: false, lawn: false, mosquito: false, tree_shrub: false, termite: false, rodent: false },
  };

  test('null filter matches everyone', () => {
    expect(matchesFilter(pestOnly, null)).toBe(true);
  });

  test('"has pest but not lawn" targets pest-only, excludes pest+lawn', () => {
    const filter = { has_service: ['pest'], missing_service: ['lawn'] };
    expect(matchesFilter(pestOnly, filter)).toBe(true);
    expect(matchesFilter(pestAndLawn, filter)).toBe(false);
    expect(matchesFilter(lead, filter)).toBe(false);
  });

  test('"pest+lawn but no mosquito" requires both held and one missing', () => {
    const filter = { has_service: ['pest', 'lawn'], missing_service: ['mosquito'] };
    expect(matchesFilter(pestAndLawn, filter)).toBe(true);
    expect(matchesFilter(pestOnly, filter)).toBe(false);
  });

  test('unknown service-line key fails CLOSED (typo matches nobody, never everybody)', () => {
    // A typo'd missing_service must NOT read as "missing for everyone" and blast
    // the whole list — the profile is rejected so the segment resolves to empty.
    expect(matchesFilter(pestOnly, { missing_service: ['mosquitos'] })).toBe(false);
    expect(matchesFilter(lead, { missing_service: ['mosquitos'] })).toBe(false);
    // An unknown has_service key likewise matches nobody (not a free pass).
    expect(matchesFilter(pestOnly, { has_service: ['pesst'] })).toBe(false);
    // A valid key alongside an invalid one still fails closed.
    expect(matchesFilter(pestOnly, { missing_service: ['lawn', 'mosquitos'] })).toBe(false);
  });

  test('audience + region + tier + line-count filters AND together', () => {
    expect(matchesFilter(pestOnly, { audience: 'customers' })).toBe(true);
    expect(matchesFilter(lead, { audience: 'customers' })).toBe(false);
    expect(matchesFilter(pestOnly, { region_zone: ['manatee'] })).toBe(true);
    expect(matchesFilter(pestOnly, { region_zone: ['tampa'] })).toBe(false);
    expect(matchesFilter(pestOnly, { waveguard_tier: ['bronze'] })).toBe(true); // case-insensitive
    expect(matchesFilter(pestAndLawn, { max_line_count: 1 })).toBe(false);
    expect(matchesFilter(pestOnly, { max_line_count: 1 })).toBe(true);
  });
});
