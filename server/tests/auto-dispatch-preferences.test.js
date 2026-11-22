const { normalizePreferences } = require('../services/auto-dispatch/preferences');
const { classifyServiceCategory, defaultTimeWindow, TIME_WINDOWS } = require('../services/auto-dispatch/service-category');

describe('service category classification', () => {
  test.each([
    ['Quarterly Pest Control', 'general'],
    ['German Roach Cleanout', 'general'],
    ['Lawn Care Visit #3', 'lawn'],
    ['Fertilization & Weed Control', 'lawn'],
    ['Tree & Shrub', 'lawn'],
    ['WaveGuard Mosquito Treatment', 'mosquito'],
    // Owner 2026-11-21: exclusion is its own category (the owner seals, the second technician traps).
    ['Rodent Exclusion', 'exclusion'],
    ['Rodent Exclusion & Trapping Service', 'exclusion'],
    ['Rodent Trapping, Exclusion & Sanitation Service', 'exclusion'],
    ['Rodent Wire Mesh Exclusion Service', 'exclusion'],
    ['Roof-Entry Cover / Bird Box Service', 'exclusion'],
    ['Rodent Sanitation Service — Heavy', 'exclusion'],
    ['Rodent Inspection Service', 'exclusion'],
    // The estimate engine's own labels for sealing work and for the bundle that includes it.
    ['Rodent Entry-Point Plugging', 'exclusion'],
    ['Rodent Plugging', 'exclusion'],
    ['Rodent entry-point sealing', 'exclusion'],
    ['Seal rodent entry points', 'exclusion'],
    ['Rodent Guarantee Combo (12 mo)', 'exclusion'],
    ['Rodent Guarantee', 'exclusion'],
    ['Attic Sanitation', 'exclusion'],
    // The payment-only guarantee rider is never a visit; it stays rodent.
    ['Rodent Guarantee Service', 'rodent'],
    // Sanitation, sealing and plugging count only beside a rodent, attic or entry-point word.
    ['Cockroach sanitation', 'general'],
    ['Lawn Plugging', 'lawn'],
    // The GENERAL rodent visit (the whole name: /book's rodent choice, the call booking's coarse
    // label, an estimate hold saved under the lead's interest) is the first look: exclusion line.
    ['Rodent Control', 'exclusion'],
    ['Rodent Control Service', 'exclusion'],
    ['Rodent Pest Control Service', 'exclusion'],
    ['rodent', 'exclusion'],
    ['rodent_general_one_time', 'exclusion'],
    // One whole part of a two-service name (what /book saves for two choices) counts the same.
    ['Mosquito Control + Rodent Control', 'exclusion'],
    ['Rodent Control + Pest Control', 'exclusion'],
    ['Pest Control + Rodent Trapping Service', 'rodent'],
    // ...but a name that says more than "rodent control" keeps its own reading.
    ['Pest & Rodent Control Service', 'rodent'],
    ['Rodent Control and Trapping', 'rodent'],
    // A key-only slot search passes the service KEY as the name: an exclusion key reads exclusion,
    // a trapping or bait key stays rodent.
    ['rodent_inspection', 'exclusion'],
    ['rodent_wire_mesh', 'exclusion'],
    ['rodent_bird_box', 'exclusion'],
    ['rodent_sanitation_heavy', 'exclusion'],
    ['rodent_trapping_exclusion', 'exclusion'],
    // The estimate engine's keys (no catalog row), and its payment-only guarantee rider.
    ['rodent_plugging', 'exclusion'],
    ['rodent_guarantee_combo', 'exclusion'],
    ['rodent_sanitation', 'exclusion'],
    ['exclusion_v2', 'exclusion'],
    ['rodent_guarantee', 'rodent'],
    ['rodent_trapping', 'rodent'],
    ['rodent_trapping_followup', 'rodent'],
    ['rodent_bait_quarterly', 'rodent'],
    ['Rodent Trapping Service', 'rodent'],
    ['Rodent Trapping Follow-Up Visit Service', 'rodent'],
    ['Rodent Trap Check - Additional', 'rodent'],
    ['Quarterly Rodent Bait Station Service', 'rodent'],
    ['Dead Rodent Removal & Odor Treatment', 'rodent'],
    ['Pest & Rodent Control', 'rodent'],
    ['Termite WDO Inspection', 'termite'],
    ['', 'general'],
  ])('%s → %s', (input, expected) => {
    expect(classifyServiceCategory(input)).toBe(expected);
  });
});

describe('service-type default time-of-day (owner rule)', () => {
  test('pest-family services default to EARLY morning', () => {
    expect(defaultTimeWindow('Quarterly Pest Control')).toBe(TIME_WINDOWS.early_morning);
    expect(defaultTimeWindow('Rodent Exclusion')).toBe(TIME_WINDOWS.early_morning);
    expect(defaultTimeWindow('Termite Inspection')).toBe(TIME_WINDOWS.early_morning);
  });
  test('lawn services default to MID/LATE morning', () => {
    expect(defaultTimeWindow('Lawn Care Visit')).toBe(TIME_WINDOWS.late_morning);
  });
});

describe('normalizePreferences', () => {
  test('no row → service-type default time window, no explicit prefs', () => {
    const p = normalizePreferences(null, 'Quarterly Pest Control');
    expect(p.has_explicit_prefs).toBe(false);
    expect(p.preferred_days).toEqual([]);
    expect(p.preferred_time_window).toBeNull();
    expect(p.effective_time_window).toBe(TIME_WINDOWS.early_morning);
    expect(p.blackout).toBeNull();
  });

  test('explicit preferred_day + preferred_time become soft signals', () => {
    const p = normalizePreferences(
      { preferred_day: 'tuesday', preferred_time: 'morning', blackout_start: null, blackout_end: null },
      'Lawn Care',
    );
    expect(p.preferred_days).toEqual(['tuesday']);
    expect(p.preferred_day_indexes).toEqual([2]);
    expect(p.preferred_time_window).toBe(TIME_WINDOWS.morning);
    expect(p.effective_time_window).toBe(TIME_WINDOWS.morning); // explicit overrides default
    expect(p.has_explicit_prefs).toBe(true);
    expect(p.strict).toBe(false);
  });

  test('no_preference values are ignored (fall back to default)', () => {
    const p = normalizePreferences({ preferred_day: 'no_preference', preferred_time: 'no_preference' }, 'Lawn Care');
    expect(p.preferred_days).toEqual([]);
    expect(p.effective_time_window).toBe(TIME_WINDOWS.late_morning);
    expect(p.has_explicit_prefs).toBe(false);
  });

  test('blackout window is captured and normalized to YYYY-MM-DD', () => {
    const p = normalizePreferences(
      { preferred_day: 'no_preference', preferred_time: 'no_preference', blackout_start: '2026-08-01T00:00:00.000Z', blackout_end: '2026-08-10' },
      'Pest Control',
    );
    expect(p.blackout).toEqual({ start: '2026-08-01', end: '2026-08-10' });
    expect(p.has_explicit_prefs).toBe(true);
  });
});
