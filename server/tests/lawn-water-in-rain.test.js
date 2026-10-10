// GATE_LAWN_WATER_IN_RAIN (owner 2026-10-09): the pure parts. The report builder and the PDF key are pinned in
// lawn-watering-report-data.test.js. Synthetic data only.

const featureGates = require('../config/feature-gates');
const rain = require('../services/service-report/lawn-water-in-rain');
const { buildWateringInstruction, withAmountLine } = require('../services/service-report/lawn-watering-instruction');
const COPY = require('../../shared/watering-copy.json');

const HALF = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' };
const HOLD = { mode: 'hold', hold_hours: 6, source: 'label' };
const COMPLETED = '2026-09-30T18:40:00Z';
const instructionFor = (rules, runtime = null) => JSON.parse(JSON.stringify(buildWateringInstruction({
  rules: rules.map((rule, i) => ({ name: `p${i}`, rule })), completedAt: COMPLETED, runtime,
})));
const productWith = (rule, precautionSummary) => ({ approved_report_product_facts: { wateringRule: rule, precautionSummary } });

describe('the gate', () => {
  const SAVED = process.env.GATE_LAWN_WATER_IN_RAIN;
  afterEach(() => { if (SAVED === undefined) delete process.env.GATE_LAWN_WATER_IN_RAIN; else process.env.GATE_LAWN_WATER_IN_RAIN = SAVED; });

  test('is dark unless the variable is exactly true, read at call time', () => {
    delete process.env.GATE_LAWN_WATER_IN_RAIN;
    expect(featureGates.lawnWaterInRainLive()).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env.GATE_LAWN_WATER_IN_RAIN = value;
      expect(featureGates.lawnWaterInRainLive()).toBe(false);
    }
    process.env.GATE_LAWN_WATER_IN_RAIN = 'true';
    expect(featureGates.lawnWaterInRainLive()).toBe(true);
  });
});

describe('parseWaterInInches', () => {
  test.each([
    ['Water in with about ½ inch within 24 hours.', 0.5],
    ['Keep pets off until dry. Water in with about ½ inch within 24 hours.', 0.5],
    ['Irrigate with 0.5 inch of water.', 0.5],
    ['Water in with 1/2 inch.', 0.5],
    ['Water in with ¼ to ½ inch.', 0.5],
    ['Water in with 1 ½ inches right away.', 1.5],
    ['Water in within 24 hours (0.25").', 0.25],
  ])('%s', (text, expected) => {
    expect(rain.parseWaterInInches(text)).toBe(expected);
  });

  test.each([
    ['Water in lightly.'], ['Apply 3 inches of mulch. Keep pets off.'], ['Water in with 9 inches.'], [''], [null], [undefined], [42],
  ])('reads nothing from %p', (text) => {
    expect(rain.parseWaterInInches(text)).toBeNull();
  });
});

describe('thresholdInches', () => {
  test('is the largest amount a water-in product asks for', () => {
    const instruction = { waterInInches: 0.25 };
    expect(rain.thresholdInches(instruction, [productWith(HALF, 'Water in with ¼ inch.'), productWith(HALF, 'Water in with about ½ inch.')])).toBe(0.5);
  });

  test('is 0.5 inch when no amount can be read, the one default', () => {
    expect(rain.DEFAULT_WATER_IN_INCHES).toBe(0.5);
    expect(rain.thresholdInches({ waterInInches: 0.25 }, [productWith(HALF, 'Water in after application.')])).toBe(0.5);
    expect(rain.thresholdInches({ waterInInches: 0.25 }, [productWith(HALF, null)])).toBe(0.5);
    expect(rain.thresholdInches({ waterInInches: 0.25 }, [])).toBe(0.5);
    expect(rain.thresholdInches({}, undefined)).toBe(0.5);
  });

  test('ignores the precaution of a product that is not a water-in, and never drops below what the instruction prints', () => {
    expect(rain.thresholdInches({ waterInInches: 0.25 }, [productWith(HOLD, 'Water in with ¾ inch.')])).toBe(0.5);
    expect(rain.thresholdInches({ waterInInches: 1 }, [productWith(HALF, 'Water in with about ½ inch.')])).toBe(1);
  });
});

describe('resolveRainCoverage', () => {
  const instruction = instructionFor([HALF]); // deadline Thu 2026-10-01 18:00Z
  const NOW = new Date('2026-10-01T12:00:00Z');
  const products = [productWith(HALF, 'Water in with about ½ inch within 24 hours.')];
  const call = (total, over = {}) => {
    const fetchForecast = jest.fn(async () => (total === 'fail' ? { status: 'unavailable' } : { status: 'ok', precipitationInTotalExact: total }));
    return rain.resolveRainCoverage({ instruction, products, now: NOW, latitude: 27.5, longitude: -82.5, fetchForecast, ...over })
      .then((coverage) => ({ coverage, fetchForecast }));
  };
  beforeEach(() => rain._private.CLOSED_WINDOW_MEMO.clear());

  test('below, at and above the amount, on the unrounded sum', async () => {
    expect((await call(0.499)).coverage).toEqual({ covered: false, observedInches: 0.5, thresholdInches: 0.5 });
    expect((await call(0.5)).coverage).toEqual({ covered: true, observedInches: 0.5, thresholdInches: 0.5 });
    expect((await call(4.68)).coverage).toMatchObject({ covered: true, observedInches: 4.68 });
    expect((await call(0)).coverage).toMatchObject({ covered: false, observedInches: 0 });
  });

  test('reads the hours from completion to now, and to the deadline once it has passed', async () => {
    const open = await call(0.1);
    expect(open.fetchForecast.mock.calls[0][0]).toMatchObject({ exactTotal: true, latitude: 27.5, longitude: -82.5 });
    expect(open.fetchForecast.mock.calls[0][0].from.toISOString()).toBe('2026-09-30T18:40:00.000Z');
    expect(open.fetchForecast.mock.calls[0][0].to.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    const late = await call(0.1, { now: new Date('2026-10-05T00:00:00Z') });
    expect(late.fetchForecast.mock.calls[0][0].to.toISOString()).toBe('2026-10-01T18:00:00.000Z');
  });

  test('a miss is unread (null), never rain and never zero', async () => {
    expect((await call('fail')).coverage).toBeNull();
    expect((await call(null)).coverage).toBeNull();
    expect((await call(Number.NaN)).coverage).toBeNull();
    const thrown = await rain.resolveRainCoverage({ instruction, products, now: NOW, fetchForecast: async () => { throw new Error('boom'); } });
    expect(thrown).toBeNull();
    expect(await rain.resolveRainCoverage({ instruction, products, now: NOW })).toBeNull();
  });

  test('nothing is read before one whole hour has passed, or for an instruction this gate does not change', async () => {
    const early = await call(5, { now: new Date('2026-09-30T19:00:00Z') });
    expect(early.coverage).toBeNull();
    expect(early.fetchForecast).not.toHaveBeenCalled();
    for (const other of [instructionFor([{ mode: 'hold', hold_hours: 24, source: 'label' }]), instructionFor([{ mode: 'none', source: 'label' }]), null, { state: 'water_in', lines: ['x'] }]) {
      const result = await call(5, { instruction: other });
      expect(result.coverage).toBeNull();
      expect(result.fetchForecast).not.toHaveBeenCalled();
    }
  });

  test('a window that closed an hour ago is read once and remembered', async () => {
    const now = new Date('2026-10-05T00:00:00Z');
    const first = await call(0.7, { now });
    const second = await call(9, { now });
    expect(first.coverage.covered).toBe(true);
    expect(second.coverage).toMatchObject({ covered: true, observedInches: 0.7 });
    expect(second.fetchForecast).not.toHaveBeenCalled();
    // A miss is not remembered.
    rain._private.CLOSED_WINDOW_MEMO.clear();
    expect((await call('fail', { now })).coverage).toBeNull();
    expect((await call(0.1, { now })).coverage).toMatchObject({ covered: false });
  });
});

describe('applyWaterInRain', () => {
  const covered = { covered: true, observedInches: 0.7, thresholdInches: 0.5 };
  const notCovered = { covered: false, observedInches: 0.1, thresholdInches: 0.5 };

  test('covered: the two fixed sentences from the shared copy, the rest of the frozen instruction as it was', () => {
    const frozen = instructionFor([HALF]);
    const out = rain.applyWaterInRain(frozen, covered);
    expect(out.state).toBe('water_in_by_rain');
    expect(out.lines).toEqual(['Rain since your visit has watered today’s treatment in.', 'No extra sprinkler run is needed for it.']);
    expect(out.lines).toEqual([COPY.waterInByRainLine1, COPY.waterInByRainLine2]);
    expect(out).toMatchObject({ waterInBy: frozen.waterInBy, expiresAt: frozen.expiresAt, completedAt: frozen.completedAt, waterInInches: 0.5 });
    expect(frozen.state).toBe('water_in');
  });

  test('covered after a hold: the hold line stays first', () => {
    const frozen = instructionFor([HOLD, HALF]);
    expect(rain.applyWaterInRain(frozen, covered).lines).toEqual([frozen.lines[0], COPY.waterInByRainLine1, COPY.waterInByRainLine2]);
    expect(frozen.lines[0]).toMatch(/^Skip your turf watering until /);
  });

  test('not covered, or unread: the amount line for a generic pair, else the very same object', () => {
    const generic = instructionFor([HALF]);
    for (const coverage of [notCovered, null]) {
      const out = rain.applyWaterInRain(generic, coverage);
      expect(out.lines[0]).toBe('Water in today’s treatment by Thu 2 PM: about ½ inch — around 30 minutes on spray heads or 80 on rotors.');
    }
    const rotor = instructionFor([HALF], { headTypes: ['rotor'] });
    expect(rain.applyWaterInRain(rotor, notCovered)).toBe(rotor);
    const hold = instructionFor([{ mode: 'hold', hold_hours: 24, source: 'label' }]);
    expect(rain.applyWaterInRain(hold, covered)).toBe(hold);
  });

  test('the copy carries no re-entry, drying or probability wording', () => {
    for (const line of [COPY.waterInByRainLine1, COPY.waterInByRainLine2]) {
      expect(line).not.toMatch(/%|\bpercent\b|\bchance\b|\bkeep\s+off\b|\bstay\s+off\b|\bre-?entry\b|\bdry\b|\bdried\b/i);
    }
  });
});

describe('waterInRainStamp', () => {
  const generic = instructionFor([HALF]);
  test('is empty when the gate changes nothing, so the key is the gate-off key', () => {
    expect(rain.waterInRainStamp(null, null)).toBe('');
    expect(rain.waterInRainStamp(instructionFor([HALF], { headTypes: ['rotor'] }), { covered: false })).toBe('');
    expect(rain.waterInRainStamp(instructionFor([{ mode: 'hold', hold_hours: 24, source: 'label' }]), { covered: true })).toBe('');
  });

  test('tells the amount line from a banner rain has covered', () => {
    expect(rain.waterInRainStamp(generic, null)).toBe(':wir=a');
    expect(rain.waterInRainStamp(generic, { covered: false })).toBe(':wir=a');
    expect(rain.waterInRainStamp(generic, { covered: true })).toBe(':wir=c');
    expect(rain.waterInRainStamp(instructionFor([HALF], { headTypes: ['rotor'] }), { covered: true })).toBe(':wir=c');
  });
});

describe('withAmountLine (the one rate table)', () => {
  test('a generic pair becomes the amount first, with the frozen figures', () => {
    const out = withAmountLine(instructionFor([HALF]));
    expect(out.lines).toEqual(['Water in today’s treatment by Thu 2 PM: about ½ inch — around 30 minutes on spray heads or 80 on rotors.', 'Run it even if it is not your usual day.']);
  });

  test('after a hold it stays one sentence', () => {
    const out = withAmountLine(instructionFor([HOLD, HALF]));
    expect(out.lines).toHaveLength(3);
    expect(out.lines[1]).toMatch(/^After that, water in today’s treatment by .+: about ½ inch — around 30 minutes on spray heads or 80 on rotors\.$/);
  });

  test('other inch depths scale on the same table', () => {
    const out = withAmountLine(instructionFor([{ ...HALF, water_in_inches: 0.25 }]));
    expect(out.lines[0]).toMatch(/: about ¼ inch — around 15 minutes on spray heads or 40 on rotors\.$/);
  });

  test('anything else is the very same object', () => {
    const same = [
      instructionFor([HALF], { headTypes: ['rotor'] }),
      instructionFor([HALF], { headTypes: ['spray'] }),
      instructionFor([HALF], { headTypes: ['spray', 'rotor'] }),
      instructionFor([HALF], { headTypes: ['drip'] }),
      instructionFor([HALF], { explicitInchesPerWeek: 1, runMinutes: 30, wateringDays: ['mon'], headTypes: ['rotor'] }),
      JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [{ name: 'p', rule: HALF }], completedAt: COMPLETED, plainWhenNoSetup: true }))),
      instructionFor([{ mode: 'hold', hold_hours: 24, source: 'label' }]),
      instructionFor([{ mode: 'none', source: 'label' }]),
      { state: 'water_in', lines: ['Water in.'], minutes: { spray: 30, rotor: 80 }, waterInInches: 0.5 },
      null,
    ];
    for (const instruction of same) expect(withAmountLine(instruction)).toBe(instruction);
  });

  test('does not change its input', () => {
    const frozen = instructionFor([HALF]);
    const before = JSON.stringify(frozen);
    withAmountLine(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});
