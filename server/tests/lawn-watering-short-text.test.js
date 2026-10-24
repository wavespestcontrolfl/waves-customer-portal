const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { shortWateringText, shortForecastSentence } = require('../services/service-report/lawn-watering-short-text');
const { countSegments } = require('../services/messaging/segment-counter');
const { PURPOSE_POLICY } = require('../services/messaging/policy');

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
    ['timed hold', [H24], 'Skip lawn watering until Sat 8 PM.'],
    ['water in, no setup on file', [SHORT], 'Water about 1/4 inch by Sat 7 PM, even on an off day.'],
    ['long window only', [LONG], 'Get about 1/2 inch of water by Fri, Nov 6 at 6 PM. Rain and regular watering count.'],
    ['dry hold then water in', [DRY, SHORT], 'Let the treatment dry first. Then water about 1/4 inch by Sat 7 PM, even on an off day.'],
    ['timed hold then water in', [H24, SHORT], 'Skip lawn watering until Sat 8 PM. Then water about 1/4 inch by Sun 8 PM, even on an off day.'],
    ['dry hold then long', [DRY, LONG], 'Let the treatment dry first. Then get about 1/2 inch of water by Fri, Nov 6 at 6 PM. Rain and regular watering count.'],
    ['water in and long', [SHORT, LONG], 'Water about 1/4 inch by Sat 7 PM, even on an off day. Get about 1/2 inch total by Fri, Nov 6 at 6 PM. Rain and regular watering count.'],
    ['screenshot: dry hold, water in, long', [DRY, SHORT, LONG],
      'Let the treatment dry first. Then water about 1/4 inch by Sat 7 PM, even on an off day. Get about 1/2 inch total by Fri, Nov 6 at 6 PM. Rain and regular watering count.'],
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

  // Accuracy over one segment: the screenshot shape is 183 characters, two
  // segments. Every shape, with the longest minutes clause and the longer rain
  // sentence, stays GSM-7 and within the purpose's segment target.
  test('every shape fits the watering text segment target with the lead-in', () => {
    const { maxSegments } = PURPOSE_POLICY.lawn_watering_instruction;
    const mixed = { headTypes: ['spray', 'rotor'] };
    const dry2 = { mode: 'hold', hold_until: 'dry', hold_hours: 2, source: 'label' };
    const rain = 'Rain forecast: about 1/2 inch between Sat 8 PM and Sun 2 PM. If 1/4 inch falls, skip the run. If not, run it.';
    const shapes = [[DRY], [H24], [SHORT], [LONG], [DRY, SHORT], [H24, SHORT], [DRY, LONG], [SHORT, LONG], [DRY, SHORT, LONG], [H24, LONG], [H24, SHORT, LONG], [NONE]];
    const bodies = [
      ...shapes.map((rules) => `Lawn watering: ${text(rules)}`),
      ...shapes.filter((rules) => rules.includes(SHORT)).map((rules) => `Lawn watering: ${text(rules, mixed)}`),
      `Lawn watering: ${text([dry2, H24, SHORT], mixed)} ${rain}`,
    ];
    expect(`Lawn watering: ${text([DRY, SHORT, LONG])}`).toHaveLength(183);
    bodies.forEach((body) => {
      expect(body).not.toContain('null');
      const { encoding, segmentCount } = countSegments(body);
      expect(encoding).toBe('GSM_7');
      expect(segmentCount).toBeLessThanOrEqual(maxSegments);
    });
  });

  test('minutes from the setup on file', () => {
    expect(text([SHORT], { headTypes: ['spray'] })).toBe('Water by Sat 7 PM, about 15 min per zone, even on an off day.');
    expect(text([SHORT], { headTypes: ['spray', 'rotor'] })).toBe('Water by Sat 7 PM: spray zones about 15 min, rotor zones about 40 min, even on an off day.');
    expect(text([SHORT], { headTypes: ['drip'] })).toBe('Water by Sat 7 PM, one full cycle on each zone, even on an off day.');
  });

  test('a timed hold that also waits for drying keeps both conditions', () => {
    const dry4 = { mode: 'hold', hold_until: 'dry', hold_hours: 2, source: 'label' };
    expect(text([dry4])).toBe('Skip lawn watering until 10 PM tonight and the treatment is dry.');
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
    expect(shortForecastSentence(instruction, 'full')).toBe('Rain forecast: about 0.4 inch by Sat 1 PM. If 1/4 inch falls by then, skip the run. If not, run it.');
  });
  test('after a timed hold names both ends', () => {
    const held = build([H24, SHORT]);
    const instruction = { ...held, forecast: { inches: 0.5, checkpointLabel: 'Sun 2 PM', afterHold: true, line: 'full' } };
    expect(shortForecastSentence(instruction, 'full')).toBe('Rain forecast: about 1/2 inch between Sat 8 PM and Sun 2 PM. If 1/4 inch falls, skip the run. If not, run it.');
  });
  test('no full sentence due: none', () => {
    expect(shortForecastSentence({ ...water, forecast: { inches: 0.4, checkpointLabel: 'Sat 1 PM' } }, null)).toBeNull();
  });
});
