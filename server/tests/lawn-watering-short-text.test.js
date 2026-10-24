const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { shortWateringText, shortForecastSentence } = require('../services/service-report/lawn-watering-short-text');

// Fri Oct 23 2026, 7:04 PM ET (the owner's screenshot visit).
const AT = '2026-10-23T23:04:00Z';
const DRY = { mode: 'hold', hold_until: 'dry', source: 'label' };
const H24 = { mode: 'hold', hold_hours: 24, source: 'owner' };
const SHORT = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' };
const LONG = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'label' };
const NONE = { mode: 'none', source: 'label' };

const build = (rules, runtime = null) => buildWateringInstruction({ rules, completedAt: AT, runtime, plainWhenNoSetup: true, labelFirst: true });
const text = (rules, runtime) => shortWateringText(build(rules, runtime));

describe('shortWateringText', () => {
  test.each([
    ['until-dry hold', [DRY], 'Let the treatment dry before you water.'],
    ['timed hold', [H24], 'Skip watering until Sat 8 PM.'],
    ['water in, no setup on file', [SHORT], 'Water 1/4 inch by Sat 7 PM, even on an off day.'],
    ['long window only', [LONG], 'Get about 1/2 inch of water by Fri, Nov 6 at 6 PM. Rain counts.'],
    ['dry hold then water in', [DRY, SHORT], 'Let the treatment dry first. Then water 1/4 inch by Sat 7 PM, even on an off day.'],
    ['timed hold then water in', [H24, SHORT], 'Skip watering until Sat 8 PM. Then water 1/4 inch by Sun 8 PM, even on an off day.'],
    ['dry hold then long', [DRY, LONG], 'Let the treatment dry first. Then get about 1/2 inch of water by Fri, Nov 6 at 6 PM. Rain counts.'],
    ['water in and long', [SHORT, LONG], 'Water 1/4 inch by Sat 7 PM, even on an off day. Get 1/2 inch total by Fri, Nov 6 at 6 PM. Rain counts.'],
    ['screenshot: dry hold, water in, long', [DRY, SHORT, LONG],
      'Let the treatment dry first. Then water 1/4 inch by Sat 7 PM, even on an off day. Get 1/2 inch total by Fri, Nov 6 at 6 PM. Rain counts.'],
    ['none', [NONE], 'No change. Keep your usual schedule.'],
  ])('%s', (_name, rules, expected) => {
    expect(text(rules)).toBe(expected);
  });

  test('keeps the same times and amounts as the full lines', () => {
    const instruction = build([DRY, SHORT, LONG]);
    const full = instruction.lines.join(' ');
    expect(full).toContain('by Sat 7 PM');
    expect(full).toContain('by Fri, Nov 6 at 6 PM');
    expect(shortWateringText(instruction)).toContain('by Sat 7 PM');
    expect(shortWateringText(instruction)).toContain('by Fri, Nov 6 at 6 PM');
  });

  test('every shape fits one GSM-7 segment with the lead-in', () => {
    const shapes = [[DRY], [H24], [SHORT], [LONG], [DRY, SHORT], [H24, SHORT], [DRY, LONG], [SHORT, LONG], [DRY, SHORT, LONG], [H24, LONG], [NONE]];
    shapes.forEach((rules) => {
      const body = `Lawn watering: ${text(rules)}`;
      expect(body.length).toBeLessThanOrEqual(160);
      expect(body).toMatch(/^[\x20-\x7E]+$/);
    });
  });

  test('minutes from the setup on file', () => {
    expect(text([SHORT], { headTypes: ['spray'] })).toBe('Water by Sat 7 PM, about 15 min per zone, even on an off day.');
    expect(text([SHORT], { headTypes: ['spray', 'rotor'] })).toBe('Water by Sat 7 PM: spray zones about 15 min, rotor zones about 40 min, even on an off day.');
    expect(text([SHORT], { headTypes: ['drip'] })).toBe('Water by Sat 7 PM, one full cycle on each zone, even on an off day.');
  });

  test('a timed hold that also waits for drying keeps both conditions', () => {
    const dry4 = { mode: 'hold', hold_until: 'dry', hold_hours: 2, source: 'label' };
    expect(text([dry4])).toBe('Skip watering until 10 PM tonight and the treatment is dry.');
  });

  test('an unknown or broken shape returns null (the full lines go out)', () => {
    expect(shortWateringText(null)).toBeNull();
    expect(shortWateringText({ state: null, lines: [] })).toBeNull();
    expect(shortWateringText({ state: 'water_in', lines: ['x.'] })).toBeNull();
    expect(shortWateringText({ state: 'hold', holdUntilLabel: 'something else', lines: ['x.'] })).toBeNull();
    const instruction = build([SHORT, LONG]);
    expect(shortWateringText({ ...instruction, later: { ...instruction.later, waterInBy: 'bad' } })).toBeNull();
  });
});

describe('shortForecastSentence', () => {
  const water = build([SHORT]);
  test('plain water in', () => {
    const instruction = { ...water, forecast: { inches: 0.4, checkpointLabel: 'Sat 1 PM', line: 'full' } };
    expect(shortForecastSentence(instruction, 'full')).toBe('Rain forecast: about 0.4 inch by Sat 1 PM. If 1/4 inch falls by then, skip the run.');
  });
  test('after a timed hold names both ends', () => {
    const held = build([H24, SHORT]);
    const instruction = { ...held, forecast: { inches: 0.5, checkpointLabel: 'Sun 2 PM', afterHold: true, line: 'full' } };
    expect(shortForecastSentence(instruction, 'full')).toBe('Rain forecast: about 1/2 inch between Sat 8 PM and Sun 2 PM. If 1/4 inch falls, skip the run.');
  });
  test('no full sentence due: none', () => {
    expect(shortForecastSentence({ ...water, forecast: { inches: 0.4, checkpointLabel: 'Sat 1 PM' } }, null)).toBeNull();
  });
});
