const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { shortWateringText, shortForecastSentence, eveningWindowDay } = require('../services/service-report/lawn-watering-short-text');
const { parseETDateTime } = require('../utils/datetime-et');
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

// GATE_LAWN_WATERING_TEXT_HOURS (owner 2026-11-15): only the "by <label>" phrase of the plain run clause becomes the
// evening window. Default (no option, or null) = today's text, byte for byte.
describe('shortWateringText with the evening window', () => {
  const base = { state: 'water_in', waterInByLabel: 'Thu 12 PM', waterInInches: 0.25, amountOnly: true };
  const TONIGHT = { eveningDay: 'tonight' };
  const FRI = { eveningDay: 'Fri' };

  test.each([
    ['amount only', base, 'Water about 1/4 inch by Thu 12 PM, even on an off day.',
      'Water about 1/4 inch tonight between 8 PM and midnight, even on an off day.',
      'Water about 1/4 inch Fri between 8 PM and midnight, even on an off day.'],
    ['measured minutes', { ...base, amountOnly: false, minutes: { measured: 20 } }, 'Water by Thu 12 PM, about 20 min per zone, even on an off day.',
      'Water tonight between 8 PM and midnight, about 20 min per zone, even on an off day.',
      'Water Fri between 8 PM and midnight, about 20 min per zone, even on an off day.'],
    ['spray and rotor', { ...base, amountOnly: false, minutes: { spray: 12, rotor: 30 } }, 'Water by Thu 12 PM: spray zones about 12 min, rotor zones about 30 min, even on an off day.',
      'Water tonight between 8 PM and midnight: spray zones about 12 min, rotor zones about 30 min, even on an off day.',
      'Water Fri between 8 PM and midnight: spray zones about 12 min, rotor zones about 30 min, even on an off day.'],
    ['one kind of head', { ...base, amountOnly: false, minutes: { rotor: 30 } }, 'Water by Thu 12 PM, about 30 min per zone, even on an off day.',
      'Water tonight between 8 PM and midnight, about 30 min per zone, even on an off day.',
      'Water Fri between 8 PM and midnight, about 30 min per zone, even on an off day.'],
    ['unknown heads', { ...base, amountOnly: false, minutes: { unknown: true } }, 'Water by Thu 12 PM, one full cycle on each zone, even on an off day.',
      'Water tonight between 8 PM and midnight, one full cycle on each zone, even on an off day.',
      'Water Fri between 8 PM and midnight, one full cycle on each zone, even on an off day.'],
  ])('%s', (_name, instruction, today, tonight, weekday) => {
    expect(shortWateringText(instruction)).toBe(today);
    expect(shortWateringText(instruction, {})).toBe(today);
    expect(shortWateringText(instruction, { eveningDay: null })).toBe(today);
    expect(shortWateringText(instruction, TONIGHT)).toBe(tonight);
    expect(shortWateringText(instruction, FRI)).toBe(weekday);
  });

  test('a hold first keeps the hold sentence and names the evening window after it', () => {
    const held = { ...base, state: 'hold_then_water_in', holdUntil: '2026-11-13T18:00:00.000Z', holdUntilLabel: 'Fri 1 PM' };
    expect(shortWateringText(held)).toBe('Skip lawn watering until Fri 1 PM. Then water about 1/4 inch by Thu 12 PM, even on an off day.');
    expect(shortWateringText(held, FRI)).toBe('Skip lawn watering until Fri 1 PM. Then water about 1/4 inch Fri between 8 PM and midnight, even on an off day.');
  });

  test('the long window, the hold-only and the no-change texts ignore the option', () => {
    const long = { ...base, longWindow: true, waterInByLabel: 'Fri, Nov 20 at 6 PM' };
    expect(shortWateringText(long, TONIGHT)).toBe(shortWateringText(long));
    const hold = { state: 'hold', holdUntil: '2026-11-13T18:00:00.000Z', holdUntilLabel: 'Fri 1 PM' };
    expect(shortWateringText(hold, TONIGHT)).toBe('Skip lawn watering until Fri 1 PM.');
    expect(shortWateringText({ state: 'none' }, TONIGHT)).toBe('No change. Keep your usual schedule.');
  });

  test('the later total sentence keeps its own deadline', () => {
    const withLater = { ...base, completedAt: '2026-11-12T23:00:00.000Z', later: { waterInInches: 0.5, waterInBy: '2026-11-19T23:00:00.000Z' } };
    const text = shortWateringText(withLater, TONIGHT);
    expect(text).toMatch(/^Water about 1\/4 inch tonight between 8 PM and midnight, even on an off day\. Get about 1\/2 inch total by /);
    expect(text.endsWith(shortWateringText(withLater).split('even on an off day. ')[1])).toBe(true);
  });

  test('every evening sentence is GSM-7 and fits the purpose within two segments with the lead-in', () => {
    const { maxSegments } = PURPOSE_POLICY.lawn_watering_instruction;
    const shapes = [base, { ...base, amountOnly: false, minutes: { spray: 12, rotor: 30 } }, { ...base, state: 'hold_then_water_in', holdUntil: '2026-11-13T18:00:00.000Z', holdUntilLabel: 'Fri 1 PM' }];
    shapes.forEach((shape) => {
      const { encoding, segmentCount } = countSegments(`Lawn watering: ${shortWateringText(shape, { eveningDay: 'Wed' })}`);
      expect(encoding).toBe('GSM_7');
      expect(segmentCount).toBeLessThanOrEqual(maxSegments);
    });
  });
});

describe('eveningWindowDay', () => {
  const et = (s) => parseETDateTime(s).toISOString();
  const ORDER = Object.freeze({ allowedHours: [{ start: '00:01', end: '04:00' }, { start: '20:00', end: '23:59' }], noHourRestriction: false });
  const inForce = () => ORDER;
  const at = (completed, deadline, hold = null) => ({
    state: hold ? 'hold_then_water_in' : 'water_in', completedAt: et(completed), waterInBy: et(deadline), ...(hold ? { holdUntil: et(hold) } : {}),
  });

  test('the same evening is tonight', () => {
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-13T12:00'), inForce)).toBe('tonight');
  });

  test('a timed hold ending Friday 1 PM names Friday', () => {
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-14T13:00', '2026-11-13T13:00'), inForce)).toBe('Fri');
  });

  test('a hold ending after 8 PM moves to the next evening when that still ends by the deadline, else nothing', () => {
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-15T12:00', '2026-11-13T21:00'), inForce)).toBe('Sat');
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-14T22:00', '2026-11-13T21:00'), inForce)).toBeNull();
  });

  test('a completion after 8 PM has no window that evening', () => {
    expect(eveningWindowDay(at('2026-11-12T20:30', '2026-11-13T12:00'), inForce)).toBeNull();
    expect(eveningWindowDay(at('2026-11-12T20:30', '2026-11-13T23:59'), inForce)).toBe('Fri');
  });

  test('a deadline before 11:59 PM that night has no window', () => {
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-12T23:00'), inForce)).toBeNull();
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-12T23:59'), inForce)).toBe('tonight');
  });

  test('a window six or more days out keeps the deadline wording', () => {
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-20T00:00', '2026-11-18T09:00'), inForce)).toBeNull();
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-20T00:00', '2026-11-17T09:00'), inForce)).toBe('Tue');
  });

  test.each([
    ['no policy', () => null],
    ['no hours on the policy', () => ({ allowedHours: null, noHourRestriction: false })],
    ['no hour restriction', () => ({ allowedHours: null, noHourRestriction: true })],
    ['no hour restriction beside windows', () => ({ allowedHours: ORDER.allowedHours, noHourRestriction: true })],
    ['an overnight window only', () => ({ allowedHours: [{ start: '00:01', end: '04:00' }], noHourRestriction: false })],
    ['an evening window that ends early', () => ({ allowedHours: [{ start: '20:00', end: '23:00' }], noHourRestriction: false })],
    ['an evening window that starts late', () => ({ allowedHours: [{ start: '21:00', end: '23:59' }], noHourRestriction: false })],
  ])('%s', (_name, policyAt) => {
    expect(eveningWindowDay(at('2026-11-12T14:00', '2026-11-13T12:00'), policyAt)).toBeNull();
  });

  test('a policy that is not in force at the window gives nothing', () => {
    const lapses = (when) => (instant) => (instant.getTime() < parseETDateTime(when).getTime() ? ORDER : null);
    const friday = at('2026-11-12T14:00', '2026-11-14T12:00', '2026-11-13T09:00');
    expect(eveningWindowDay(friday, lapses('2026-11-13T20:01'))).toBe('Fri');
    expect(eveningWindowDay(friday, lapses('2026-11-13T20:00'))).toBeNull();
    expect(eveningWindowDay(friday, lapses('2026-11-13T12:00'))).toBeNull();
  });

  test('the policy is read at the window start, built on the ET wall clock across a fall-back and a spring-forward', () => {
    const seen = [];
    const spy = (instant) => { seen.push(instant.toISOString()); return ORDER; };
    // Sat Oct 31 2026 2 PM, hold to Sun Nov 1 (the fall-back Sunday): 8 PM is EST, 01:00Z the next day.
    expect(eveningWindowDay(at('2026-10-31T14:00', '2026-11-02T12:00', '2026-11-01T13:00'), spy)).toBe('Sun');
    // Sat Mar 13 2027 2 PM, hold to Sun Mar 14 (the spring-forward Sunday): 8 PM is EDT, 00:00Z the next day.
    expect(eveningWindowDay(at('2027-03-13T14:00', '2027-03-15T12:00', '2027-03-14T13:00'), spy)).toBe('Sun');
    expect(seen).toEqual(['2026-11-02T01:00:00.000Z', '2027-03-15T00:00:00.000Z']);
    // Tonight on the fall-back Sunday itself.
    expect(eveningWindowDay(at('2026-11-01T14:00', '2026-11-02T12:00'), inForce)).toBe('tonight');
  });

  test.each([
    ['no instruction', null, inForce],
    ['no policy reader', at('2026-11-12T14:00', '2026-11-13T12:00'), undefined],
    ['no deadline', { state: 'water_in', completedAt: '2026-11-12T19:00:00.000Z' }, inForce],
    ['no completion time', { state: 'water_in', waterInBy: '2026-11-13T19:00:00.000Z' }, inForce],
  ])('%s', (_name, instruction, policyAt) => {
    expect(eveningWindowDay(instruction, policyAt)).toBeNull();
  });
});
