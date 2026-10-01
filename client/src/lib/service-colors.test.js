import { describe, expect, it } from 'vitest';
import { detectServiceCategory } from './service-colors';

// The calendar color mirror reads the shared termite rule (Codex #5195 r1),
// so a job the server routes to termite is never painted pest.
describe('service-colors detectServiceCategory termite mirror', () => {
  it.each([
    'Liquid termiticide treatment',
    'Borate Wood Treatment',
    'Bora-Care Wood Treatment',
    'Trelona Bait Monitoring',
    'WDO Inspection',
    'Pre-Slab Termiticide Treatment',
    'Foam Drill Treatment',
    'Recurring Foam Treatment (Quarterly)',
    'FoamRecurring',
    'Termidor Foam Treatment',
  ])('%s is termite', (name) => {
    expect(detectServiceCategory(name)).toBe('termite');
  });

  it.each([
    ['Rodent Exclusion — Foam Sealing', 'rodent'],
    ['Foam Sealing Follow-Up (Rodent)', 'rodent'],
    ['Lawn Care and Termite Bait Monitoring', 'lawn'],
    ['Tree & Shrub Fertilization', 'tree'],
    ['Quarterly Pest Control', 'pest'],
  ])('%s keeps its primary category', (name, category) => {
    expect(detectServiceCategory(name)).toBe(category);
  });
});
