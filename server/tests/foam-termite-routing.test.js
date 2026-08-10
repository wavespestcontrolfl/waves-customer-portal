/**
 * Drill-and-foam service-line routing pin.
 *
 * The foam services ("Foam Drill" one-time, "Recurring Foam Treatment
 * (Quarterly)" recurring — owner directive 2026-06-25) are termite work, but
 * neither name carries a "termite" token. Without an explicit foam token they
 * fell through to 'pest': amber termite blocks rendered blue on the schedule,
 * and completed foam visits routed to the pest report template instead of the
 * typed termite one.
 *
 * The client mirror lives in client/src/lib/service-colors.js — keep both
 * token lists in step.
 */

const { detectServiceLine } = require('../services/service-report/service-line-configs');
const { detectServiceCategory, normalizeServiceType } = require('../utils/service-normalizer');

describe('foam names route termite', () => {
  test.each([
    ['Foam Drill'],
    ['Recurring Foam'],
    ['Recurring Foam Treatment'],
    ['Recurring Foam Treatment (Quarterly)'],
    ['Recurring Foam Treatment (Bimonthly)'],
    ['Recurring Foam Treatment (Monthly)'],
    ['Drill-and-Foam Termite Treatment'],
    ['Drill-and-Foam Termite Treatment Service'],
    ['foam_drill'],
    ['foam_recurring'],
  ])('%s → termite category and termite report line', (name) => {
    expect(detectServiceCategory(name)).toBe('termite');
    expect(detectServiceLine(name)).toBe('termite');
  });

  test('bare foam is NOT a termite token — rodent foam-sealing stays rodent (codex 2026-08-08 P1)', () => {
    // Foam sealant is rodent-exclusion material; only the drill-and-foam
    // termite FORMS route termite, never the substring.
    for (const name of ['Rodent Exclusion – Foam Sealing', 'Foam Sealing Follow-Up (Rodent)']) {
      expect(detectServiceCategory(name)).toBe('rodent');
      expect(detectServiceLine(name)).toBe('rodent');
    }
  });

  test('normalization leaves the cadence on the label', () => {
    // No SERVICE_TYPE_MAP entry for foam on purpose: collapsing these to a
    // generic "Termite Treatment" would drop the cadence the schedule shows.
    expect(normalizeServiceType('Recurring Foam Treatment (Quarterly)')).toBe('Recurring Foam Treatment (Quarterly)');
    expect(normalizeServiceType('Foam Drill')).toBe('Foam Drill');
  });

  test('non-termite lines are unaffected by the foam token', () => {
    expect(detectServiceCategory('Quarterly Pest Control')).toBe('pest');
    expect(detectServiceCategory('Lawn Care Visit')).toBe('lawn');
    expect(detectServiceCategory('Mosquito Barrier Treatment')).toBe('mosquito');
    expect(detectServiceCategory('Rodent Exclusion')).toBe('rodent');
    expect(detectServiceCategory('Tree & Shrub Fertilization')).toBe('tree_shrub');
  });
});
