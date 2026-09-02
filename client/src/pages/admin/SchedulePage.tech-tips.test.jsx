// Tips from your tech — the picker's pure helpers. Search ranks label
// matches above keyword matches above copy matches (so a tech typing the
// vocabulary they use at the truck lands on the right tip first), and the
// option subtext is the copy's first sentence, trimmed.
import { describe, expect, test } from 'vitest';
import { rankTechTips, techTipSubtext, techTipSentLabel, parkTaggedNoteLines, stripParkedTaggedLines, TECH_TIP_MAX } from './SchedulePage.jsx';

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

describe('parkTaggedNoteLines', () => {
  const notes = [
    'Treated the perimeter and the lanai.',
    '[Found] Ant trail at the slider track',
    '[found] moisture under the kitchen sink',
    '[Found] German roach activity',
    '[Next] Reservice the lanai in two weeks',
    '[Protocol] Perimeter spray',
  ].join('\n');

  test('parks free-typed lines for the tag, case-insensitively, skipping chip marker lines', () => {
    expect(parkTaggedNoteLines({ notes, tag: 'found', labels: ['German roach activity'], current: '' }))
      .toBe('Ant trail at the slider track\nmoisture under the kitchen sink');
    expect(parkTaggedNoteLines({ notes, tag: 'next' })).toBe('Reservice the lanai in two weeks');
  });

  test('appends to existing text without duplicating it', () => {
    expect(parkTaggedNoteLines({ notes, tag: 'next', current: 'Reservice the lanai in two weeks\nTrim the hedge' }))
      .toBe('Reservice the lanai in two weeks\nTrim the hedge');
    expect(parkTaggedNoteLines({ notes, tag: 'next', current: 'Trim the hedge' }))
      .toBe('Trim the hedge\nReservice the lanai in two weeks');
  });

  test('an elaborated line that contains a chip label is the tech\'s detail, not the marker — it parks', () => {
    const elaborated = '[Found] Ant activity at the kitchen sink\n[Found] Ant activity\n[Found]  ant   ACTIVITY  ';
    expect(parkTaggedNoteLines({ notes: elaborated, tag: 'found', labels: ['Ant activity'] }))
      .toBe('Ant activity at the kitchen sink');
  });

  test('nothing to park is null, so state is left untouched', () => {
    expect(parkTaggedNoteLines({ notes: 'Plain prose only.', tag: 'found', current: 'keep me' })).toBeNull();
    expect(parkTaggedNoteLines({ notes, tag: 'found', labels: ['Ant trail at the slider track', 'moisture under the kitchen sink', 'German roach activity'] })).toBeNull();
  });
});

describe('stripParkedTaggedLines', () => {
  const notes = 'Treated the perimeter.\n[Found] Ant trail at the slider\n[Found] German roach activity\n[Next] Reservice in two weeks\n[Protocol] Perimeter spray';
  test('removes the free-typed lines a park owns; chip markers and other tags stay', () => {
    expect(stripParkedTaggedLines({ notes, parked: { found: 'Ant trail at the slider' }, labels: { found: ['German roach activity'] } }))
      .toBe('Treated the perimeter.\n[Found] German roach activity\n[Next] Reservice in two weeks\n[Protocol] Perimeter spray');
    expect(stripParkedTaggedLines({ notes, parked: { found: 'x', next: 'y' } }))
      .toBe('Treated the perimeter.\n[Protocol] Perimeter spray');
  });
  test('no park for a tag leaves its lines untouched', () => {
    expect(stripParkedTaggedLines({ notes, parked: {} })).toBe(notes);
    expect(stripParkedTaggedLines({ notes, parked: { found: '   ' } })).toBe(notes);
  });
});

test('the per-visit cap matches the registry cap', () => {
  expect(TECH_TIP_MAX).toBe(3);
});
