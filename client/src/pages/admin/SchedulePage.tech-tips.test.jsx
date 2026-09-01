// Tips from your tech — the picker's pure helpers. Search ranks label
// matches above keyword matches above copy matches (so a tech typing the
// vocabulary they use at the truck lands on the right tip first), and the
// option subtext is the copy's first sentence, trimmed.
import { describe, expect, test } from 'vitest';
import { rankTechTips, techTipSubtext, techTipSentLabel, TECH_TIP_MAX } from './SchedulePage.jsx';

const TIPS = [
  { id: 'water_bromeliads', label: 'Flush bromeliads weekly', keywords: ['bromeliad', 'cups', 'water'], copy: 'If you have bromeliads, the cup holds water. Flush weekly.' },
  { id: 'moisture_ac_drip', label: 'A/C condensate line', keywords: ['ac', 'condensate', 'drip', 'ants'], copy: 'Where it drips the soil never dries. Ants follow that water.' },
  { id: 'lawn_water_morning', label: 'Water the lawn in the early morning', keywords: ['irrigation', 'sprinkler'], copy: 'Overnight watering leaves the blades wet.' },
  { id: 'light_warm_bulbs', label: 'Warm porch bulbs', keywords: ['porch', 'bulb'], copy: 'Insects steer by short-wavelength light.' },
];

describe('rankTechTips', () => {
  test('label prefix > label contains > keyword > copy, then alphabetical', () => {
    expect(rankTechTips(TIPS, 'water').map((t) => t.id)).toEqual([
      'lawn_water_morning', // label starts with the query
      'water_bromeliads', // keyword
      'moisture_ac_drip', // copy only
    ]);
  });

  test('keywords catch the tech vocabulary the label does not carry', () => {
    expect(rankTechTips(TIPS, 'ants').map((t) => t.id)).toEqual(['moisture_ac_drip']);
    expect(rankTechTips(TIPS, 'sprinkler').map((t) => t.id)).toEqual(['lawn_water_morning']);
  });

  test('no match is an empty list, not everything', () => {
    expect(rankTechTips(TIPS, 'zzz')).toEqual([]);
  });
});

describe('techTipSubtext', () => {
  test('first sentence only', () => {
    expect(techTipSubtext('If you have bromeliads, the cup holds water. Flush weekly.')).toBe('If you have bromeliads, the cup holds water.');
  });
  test('long first sentences are trimmed with an ellipsis', () => {
    const long = `${'word '.repeat(40).trim()}.`;
    const out = techTipSubtext(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(96);
  });
  test('empty copy is an empty subtext', () => {
    expect(techTipSubtext('')).toBe('');
  });
});

describe('techTipSentLabel', () => {
  test('formats the calendar day itself, never the previous ET evening', () => {
    expect(techTipSentLabel('2026-08-03')).toBe('sent Aug 3');
    expect(techTipSentLabel('2026-11-01')).toBe('sent Nov 1');
    expect(techTipSentLabel('2026-08-03T00:00:00.000Z')).toBe('sent Aug 3');
  });
  test('anything else is no label', () => {
    expect(techTipSentLabel('')).toBeNull();
    expect(techTipSentLabel(undefined)).toBeNull();
    expect(techTipSentLabel('Aug 3')).toBeNull();
  });
});

test('the per-visit cap matches the registry cap', () => {
  expect(TECH_TIP_MAX).toBe(3);
});
