// GATE_LAWN_REPORT_POLISH: the lawn report polish (owner 2026-10-09): the Water card's third state, one label
// line per product card (frozen with the lawn report facts), the status card's keep-off line. Gate off = the
// payload, render, PDF and PDF key it has always had. Synthetic data only.

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn() };
});

const history = require('../services/lawn-assessment-history');
const featureGates = require('../config/feature-gates');
const irrigation = require('@waves/irrigation-runtime');
const { buildReportV1Data, resolveCanonicalLawnRender, buildLawnWaterContext, portalIrrigationInches } = require('../services/service-report/report-data');
const { mapWater } = require('../services/service-report/lawn-report-v2');
const { buildWateringInstruction, GENERIC_MINUTES_PER_QUARTER_INCH } = require('../services/service-report/lawn-watering-instruction');
const polish = require('../services/service-report/lawn-report-polish');
const labels = require('../services/service-report/lawn-label-lines');
const facts = require('../services/service-report/lawn-report-facts');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const COPY = require('../../shared/lawn-report-polish-copy.json');
const { buildReportAskFacts } = require('../services/service-report/report-ask-ai');

const GATE = 'GATE_LAWN_REPORT_POLISH';
const saved = process.env[GATE];
const gateOn = () => { process.env[GATE] = 'true'; };
const gateOff = () => { delete process.env[GATE]; };
afterEach(() => { if (saved === undefined) gateOff(); else process.env[GATE] = saved; });

describe('the gate reader', () => {
  test('strict opt-in: only the exact string true', () => {
    gateOff();
    expect(featureGates.lawnReportPolishLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'True', 'yes', '']) {
      process.env[GATE] = v;
      expect(featureGates.lawnReportPolishLive()).toBe(false);
    }
    gateOn();
    expect(featureGates.lawnReportPolishLive()).toBe(true);
  });

  test('the payload key and the PDF key part exist only while live, and only for a lawn report with a reportV2', () => {
    gateOff();
    expect(polish.lawnPolishPayload({ serviceLine: 'lawn', reportV2: {} })).toEqual({});
    expect(polish.polishPdfStamp()).toBe('');
    gateOn();
    expect(polish.lawnPolishPayload({ serviceLine: 'lawn', reportV2: {} })).toEqual({ lawnPolish: true });
    expect(polish.lawnPolishPayload({ serviceLine: 'pest', reportV2: {} })).toEqual({});
    expect(polish.lawnPolishPayload({ serviceLine: 'lawn', reportV2: null })).toEqual({});
    expect(polish.polishPdfStamp()).toBe(':polish=1');
  });
});

describe('ONE rate table: the banner\'s (spray 15 min, rotor 40 min per quarter inch)', () => {
  test('the banner and the package read the same constant', () => {
    expect(GENERIC_MINUTES_PER_QUARTER_INCH).toBe(irrigation.OWNER_MINUTES_PER_QUARTER_INCH);
    expect(irrigation.OWNER_MINUTES_PER_QUARTER_INCH).toEqual({ spray: 15, rotor: 40 });
    expect(irrigation.OWNER_HEAD_RATE_IN_PER_HR).toEqual({ spray: 1, rotor: 0.375 });
  });

  test('the banner prints the minutes of a half inch on that table', () => {
    const rules = [{ name: 'x', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_hours: 24, source: 'label' } }];
    const spray = buildWateringInstruction({ rules, completedAt: '2026-10-09T14:00:00Z', runtime: { headTypes: ['spray'], runMinutes: 45, wateringDays: ['Mon'] } });
    expect(spray.lines.join(' ')).toMatch(/30 minutes/);
    const rotor = buildWateringInstruction({ rules, completedAt: '2026-10-09T14:00:00Z', runtime: { headTypes: ['rotor'], runMinutes: 45, wateringDays: ['Mon'] } });
    expect(rotor.lines.join(' ')).toMatch(/80 minutes/);
  });

  test('the package default table is NOT changed (portal preview, weekly email, move guard)', () => {
    expect(irrigation.HEAD_PRECIP_RATE_IN_PER_HR).toEqual({ spray: 1.5, rotor: 0.5 });
    const input = { runMinutes: 45, wateringDays: ['Mon'], systemType: ['spray'] };
    expect(irrigation.deriveIrrigationInchesPerWeek(input).inchesPerWeek).toBe(1.13);
    expect(irrigation.deriveIrrigationInchesPerWeek({ ...input, systemType: ['rotor'] }).inchesPerWeek).toBe(0.38);
    // drip still counts as a head type by default
    expect(irrigation.deriveIrrigationInchesPerWeek({ ...input, systemType: ['rotor', 'drip'] }).reason).toBe('mixed_head_types');
    expect(portalIrrigationInches({ irrigation_run_minutes: 45, watering_days: ['Mon'], irrigation_system_type: ['spray'] })).toBe(1.13);
  });

  test('the opt-in: the owner table and drip ignored, old to new for 45 minutes one day a week', () => {
    const owner = { rates: irrigation.OWNER_HEAD_RATE_IN_PER_HR, ignoreDrip: true };
    const derive = (systemType) => irrigation.deriveIrrigationInchesPerWeek({ runMinutes: 45, wateringDays: ['Mon'], systemType }, owner);
    expect(derive(['spray']).inchesPerWeek).toBe(0.75); // package table: 1.13
    expect(derive(['rotor']).inchesPerWeek).toBe(0.28); // package table: 0.38
    expect(derive(['rotor', 'drip']).inchesPerWeek).toBe(0.28);
    expect(derive(['spray', 'drip']).headType).toBe('spray');
    expect(derive(['spray', 'rotor']).reason).toBe('mixed_head_types');
    expect(derive(['spray', 'rotor', 'drip']).reason).toBe('mixed_head_types');
    expect(derive(['drip']).reason).toBe('drip_only');
    expect(derive([]).reason).toBe('missing_head_type');
    expect(irrigation.deriveIrrigationInchesPerWeek({ runMinutes: 240, wateringDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], systemType: ['spray'] }, owner).reason).toBe('implausible_total');
  });
});

describe('the label-line half needs the facts gate; the Water card half does not', () => {
  const FACTS = 'GATE_LAWN_REPORT_FACTS';
  const savedFacts = process.env[FACTS];
  afterEach(() => { if (savedFacts === undefined) delete process.env[FACTS]; else process.env[FACTS] = savedFacts; });
  const set = (polishOn, factsOn) => {
    if (polishOn) gateOn(); else gateOff();
    if (factsOn) process.env[FACTS] = 'true'; else delete process.env[FACTS];
  };

  test('truth table: lawnReportLabelLinesLive() = polish AND facts, strict true', () => {
    const rows = [[false, false, false], [true, false, false], [false, true, false], [true, true, true]];
    rows.forEach(([p, f, want]) => { set(p, f); expect(featureGates.lawnReportLabelLinesLive()).toBe(want); });
    process.env[GATE] = '1'; process.env[FACTS] = 'true';
    expect(featureGates.lawnReportLabelLinesLive()).toBe(false);
  });

  test('polish alone (facts dark): the Water card and status key still work', () => {
    set(true, false);
    expect(featureGates.lawnReportPolishLive()).toBe(true);
    expect(featureGates.lawnReportLabelLinesLive()).toBe(false);
    const water = mapWater(buildLawnWaterContext({ propertyPrefs: { irrigation_run_minutes: 45, watering_days: ['Mon'], irrigation_system_type: ['rotor', 'spray'], irrigation_system: true }, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(water.scheduleKind).toBe('runtime_only');
    expect(polish.lawnPolishPayload({ serviceLine: 'lawn', reportV2: {} })).toEqual({ lawnPolish: true });
  });

  test('read side: a record frozen with labelLines renders them whatever either gate says', () => {
    const notes = JSON.stringify({ lawnReportFacts: { v: 1, frozenAt: '2026-10-09T12:00:00Z', reentry: { rule: 'dry' }, productUse: {}, labelLines: { v: 1, items: { 'sp-9': [0] } } } });
    [[false, false], [true, false], [false, true], [true, true]].forEach(([p, f]) => {
      set(p, f);
      expect(facts.frozenLabelDropsFor('lawn', notes)).toEqual({ 'sp-9': [0] });
      expect(facts.precautionForCard(facts.frozenLabelDropsFor('lawn', notes), { id: 'sp-9' }, 'A. B.')).toBe('B.');
    });
  });
});

describe('the report\'s irrigation figure while the gate is live', () => {
  const prefs = (extra) => ({ irrigation_run_minutes: 45, watering_days: ['Mon'], irrigation_system_type: ['rotor'], irrigation_system: true, ...extra });

  test('gate off: the report\'s own resolver (the package table) and no polish key', () => {
    gateOff();
    expect(polish.prefsInchesFor(prefs(), portalIrrigationInches)).toBe(0.38);
    expect(buildLawnWaterContext({ propertyPrefs: prefs(), serviceDate: '2026-10-09' })).not.toHaveProperty('scheduleKind');
  });

  test('gate on: explicit inches win; the toggle off derives nothing; one turf head derives on the owner table', () => {
    gateOn();
    expect(polish.polishPrefsInches(prefs({ irrigation_inches_per_week: 1.5 }))).toBe(1.5);
    expect(polish.polishPrefsInches(prefs({ irrigation_system: false }))).toBeNull();
    expect(polish.polishPrefsInches(prefs())).toBe(0.28);
    expect(polish.polishPrefsInches(prefs({ irrigation_system_type: ['spray', 'rotor'] }))).toBeNull();
    expect(polish.polishPrefsInches(null)).toBeNull();
  });

  test('what is on file, in plain words', () => {
    const on = (extra) => polish.describeScheduleOnFile(prefs(extra));
    expect(on()).toBe('45 min, Mondays');
    expect(on({ watering_days: ['Mon', 'Thu'] })).toBe('45 min, Mondays and Thursdays');
    expect(on({ watering_days: ['Mon', 'Wed', 'Fri'] })).toBe('45 min, Mondays, Wednesdays and Fridays');
    expect(on({ watering_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] })).toBe('45 min, every day');
    expect(on({ watering_days: [] })).toBe('45 min');
    expect(on({ irrigation_run_minutes: null })).toBe('Mondays');
    expect(on({ irrigation_run_minutes: null, watering_days: [] })).toBeNull();
    expect(on({ irrigation_run_minutes: 999 })).toBe('Mondays');
    expect(polish.describeScheduleOnFile(null)).toBeNull();
  });

  test('the basis line of a derived figure only', () => {
    expect(polish.derivedBasisLine(prefs())).toBe('About 0.28" a week from 45 minutes per zone, 1 day a week on rotor heads — typical head rates.');
    expect(polish.derivedBasisLine(prefs({ irrigation_inches_per_week: 1.5 }))).toBeNull();
    expect(polish.derivedBasisLine(prefs({ irrigation_system_type: ['spray', 'rotor'] }))).toBeNull();
    expect(polish.derivedBasisLine(prefs({ irrigation_system: false }))).toBeNull();
  });

  test('state B: a mixed system keeps profileMissing true and status unknown, and the context names the schedule', () => {
    gateOn();
    const mixed = prefs({ irrigation_system_type: ['rotor', 'spray', 'drip'] });
    const context = buildLawnWaterContext({ propertyPrefs: mixed, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 });
    expect(context.irrigationAdvice.profileMissing).toBe(true);
    expect(context.irrigationAdvice.status).toBe('unknown');
    expect(context.irrigationInchesPerWeek).toBeNull();
    expect(context.effectiveInches7d).toBe(1.2);
    expect(context).toMatchObject({ scheduleKind: 'runtime_only', scheduleText: '45 min, Mondays' });
    const water = mapWater(context);
    expect(water).toMatchObject({ scheduleOnFile: false, scheduleKind: 'runtime_only', scheduleText: '45 min, Mondays', status: 'unknown', confidence: 'low' });
    expect(water.explanation).toMatch(/sprinkler schedule on file \(45 min, Mondays\)/);
    expect(water.explanation).not.toMatch(/don.t have your irrigation schedule/);
    expect(water.irrigationInches).toBeNull();
    expect(water).not.toHaveProperty('irrigationBasis');
  });

  test('state A: one turf head type derives inches, the balance computes, the basis line rides', () => {
    gateOn();
    const context = buildLawnWaterContext({ propertyPrefs: prefs({ irrigation_system_type: ['rotor', 'drip'] }), serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 });
    expect(context.irrigationAdvice.profileMissing).toBe(false);
    expect(context.irrigationInchesPerWeek).toBe(0.28);
    const water = mapWater(context);
    expect(water).toMatchObject({ scheduleOnFile: true, scheduleKind: 'inches', irrigationInches: 0.28 });
    expect(water.irrigationBasis).toMatch(/^About 0\.28" a week from 45 minutes per zone/);
  });

  test('state A with typed inches prints no basis line; state C (nothing on file) is the old card', () => {
    gateOn();
    const typed = mapWater(buildLawnWaterContext({ propertyPrefs: prefs({ irrigation_inches_per_week: 1.25 }), serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(typed).toMatchObject({ scheduleKind: 'inches', irrigationInches: 1.25 });
    expect(typed).not.toHaveProperty('irrigationBasis');
    const none = mapWater(buildLawnWaterContext({ propertyPrefs: null, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(none).toMatchObject({ scheduleKind: 'none', scheduleOnFile: false });
    expect(none).not.toHaveProperty('scheduleText');
    const headsOnly = mapWater(buildLawnWaterContext({ propertyPrefs: { irrigation_system_type: ['rotor'], irrigation_system: true }, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(headsOnly.scheduleKind).toBe('none');
    const off = mapWater(buildLawnWaterContext({ propertyPrefs: prefs({ irrigation_system: false }), serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(off.scheduleKind).toBe('none');
    const moved = mapWater(buildLawnWaterContext({ propertyPrefs: prefs(), serviceDate: '2026-10-09', completionRainfall7dInches: 1.2, scheduleUnconfirmed: true }));
    expect(moved.scheduleKind).toBe('none');
  });

  test('gate off: the water payload is exactly the old one (no polish key), mixed and single', () => {
    gateOff();
    for (const systemType of [['rotor', 'spray', 'drip'], ['rotor', 'drip'], ['spray']]) {
      const water = mapWater(buildLawnWaterContext({ propertyPrefs: prefs({ irrigation_system_type: systemType }), serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
      ['scheduleKind', 'scheduleText', 'irrigationBasis'].forEach((key) => expect(water).not.toHaveProperty(key));
    }
  });
});

describe('an area water snapshot is used only when its irrigation figure is the one the report resolves now', () => {
  const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
  const prefs = (extra) => ({ irrigation_run_minutes: 45, watering_days: ['Mon'], irrigation_system_type: ['rotor'], irrigation_system: true, ...extra });
  // No property rainfall, so the card may fall back to the area snapshot.
  const context = (propertyPrefs) => buildLawnWaterContext({ propertyPrefs, serviceDate: '2026-10-09' });
  const snapshot = (irrigation_inches_per_week) => ({
    status: 'low', interpretation: 'water_deficit_likely', confidence: 'high', rain_7day_inches: 0.5, adjusted_rain_7day_inches: 0.5,
    irrigation_inches_per_week, total_water_7day_inches: 0.5 + irrigation_inches_per_week, target_water_inches_per_week: 1,
  });

  test('explicit inches + a snapshot made with the same figure: the snapshot is used, inches as entered, no basis line', () => {
    gateOn();
    const water = mapWater(context(prefs({ irrigation_inches_per_week: 1.25 })), snapshot(1.25));
    expect(water).toMatchObject({ source: 'area_snapshot', scheduleKind: 'inches', irrigationInches: 1.25 });
    expect(water).not.toHaveProperty('irrigationBasis');
  });

  test('explicit inches + a snapshot with another figure: the customer\'s inches print as entered (the live card), never the snapshot\'s', () => {
    gateOn();
    const water = mapWater(context(prefs({ irrigation_inches_per_week: 1.25 })), snapshot(0.38));
    expect(water).toMatchObject({ source: 'irrigation_advice', scheduleKind: 'inches', irrigationInches: 1.25 });
    expect(water).not.toHaveProperty('irrigationBasis');
  });

  test('single head + a snapshot made on the same table: the snapshot is used and the basis line rides with the figure', () => {
    gateOn();
    const water = mapWater(context(prefs()), snapshot(0.28));
    expect(water).toMatchObject({ source: 'area_snapshot', scheduleKind: 'inches', irrigationInches: 0.28 });
    expect(water.irrigationBasis).toMatch(/^About 0\.28" a week from 45 minutes per zone/);
  });

  test('single head + an OLD snapshot (package table, 0.38): no figure of unknown origin; the card prints the current 0.28 with its basis', () => {
    gateOn();
    const water = mapWater(context(prefs()), snapshot(0.38));
    expect(water).toMatchObject({ source: 'irrigation_advice', scheduleKind: 'inches', irrigationInches: 0.28 });
    expect(water.irrigationBasis).toMatch(/^About 0\.28"/);
    expect(JSON.stringify(water)).not.toMatch(/0\.38|0\.88/);
  });

  test('mixed heads + a snapshot that holds a figure: the third state (schedule on file, inches not on file), no snapshot number', () => {
    gateOn();
    const water = mapWater(context(prefs({ irrigation_system_type: ['rotor', 'spray'] })), snapshot(0.38));
    expect(water).toMatchObject({ source: 'irrigation_advice', scheduleKind: 'runtime_only', scheduleText: '45 min, Mondays', scheduleParts: 'minutes_and_days', scheduleOnFile: false });
    expect(water.irrigationInches).toBeNull();
    expect(JSON.stringify(water)).not.toMatch(/0\.38|0\.88/);
  });

  test('gate off: the snapshot passes through exactly as before, whatever its figure', () => {
    gateOff();
    const water = mapWater(context(prefs()), snapshot(0.99));
    expect(water).toMatchObject({ source: 'area_snapshot', irrigationInches: 0.99 });
    ['scheduleKind', 'irrigationBasis', 'scheduleParts'].forEach((key) => expect(water).not.toHaveProperty(key));
    expect(polish.snapshotForCard({}, snapshot(0.99))).toEqual(snapshot(0.99));
  });

  test('the diagnosis reads the same snapshot as the card (a rejected snapshot drives neither)', () => {
    gateOn();
    const waterContext = context(prefs());
    const report = (irrigation) => buildLawnReportV2({ lawnAssessment: { scores: {}, waterContext }, applications: [], waterSnapshot: { ...snapshot(irrigation), interpretation: 'wet_condition_watch', status: 'high' } });
    expect(report(0.28).water.source).toBe('area_snapshot');
    const old = report(0.38);
    expect(old.water.source).toBe('irrigation_advice');
    expect(old.water.status).not.toBe('high');
  });
});

describe('state B says which parts of the schedule are on file', () => {
  test.each([
    [{ irrigation_run_minutes: 45, watering_days: ['Mon'], irrigation_system_type: ['rotor', 'spray'] }, 'minutes_and_days', '45 min, Mondays'],
    [{ irrigation_run_minutes: 45, watering_days: [], irrigation_system_type: ['rotor', 'spray'] }, 'minutes_only', '45 min'],
    [{ irrigation_run_minutes: null, watering_days: ['Mon', 'Thu'], irrigation_system_type: ['rotor'] }, 'days_only', 'Mondays and Thursdays'],
  ])('%j', (propertyPrefs, parts, text) => {
    gateOn();
    const water = mapWater(buildLawnWaterContext({ propertyPrefs: { irrigation_system: true, ...propertyPrefs }, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(water).toMatchObject({ scheduleKind: 'runtime_only', scheduleParts: parts, scheduleText: text });
  });

  test('state A and state C carry no parts', () => {
    gateOn();
    const a = mapWater(buildLawnWaterContext({ propertyPrefs: { irrigation_inches_per_week: 1, irrigation_system: true }, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    const c = mapWater(buildLawnWaterContext({ propertyPrefs: null, serviceDate: '2026-10-09', completionRainfall7dInches: 1.2 }));
    expect(a).not.toHaveProperty('scheduleParts');
    expect(c).not.toHaveProperty('scheduleParts');
  });
});

describe('Ask Waves reads the third state', () => {
  const askFacts = (water) => buildReportAskFacts({ data: { serviceLine: 'lawn', applications: [], reportV2: { water } } }).lawn_report.water_this_week;

  test('state B: the schedule on file is a fact, the inches stay hidden, no "no schedule" claim', () => {
    const facts = askFacts({ rainInches: 1.2, irrigationInches: null, totalInches: 1.2, targetInches: 1, scheduleOnFile: false, scheduleKind: 'runtime_only', scheduleText: '45 min, Mondays', status: 'unknown', explanation: polish.scheduleOnFileExplanation('45 min, Mondays', 1) });
    expect(facts.irrigation_schedule_on_file).toBe('45 min, Mondays');
    expect(facts).not.toHaveProperty('irrigation_inches_per_week');
    expect(facts).not.toHaveProperty('total_inches_7_days');
    expect(facts.explanation).toMatch(/sprinkler schedule on file/);
  });

  test('without the key (gate off, or nothing on file) the facts are the old ones', () => {
    const facts = askFacts({ rainInches: 1.2, irrigationInches: null, totalInches: 1.2, targetInches: 1, scheduleOnFile: false, status: 'unknown', explanation: 'We don\u2019t have your irrigation schedule on file yet.' });
    expect(facts).not.toHaveProperty('irrigation_schedule_on_file');
  });
});

describe('the fixed customer sentences', () => {
  const sentences = [
    COPY.confidenceLabel, COPY.ctaTitle, COPY.ctaBody, COPY.ctaButton,
    '45 min, Mondays', '45 min, Mondays and Thursdays', '45 min', 'Mondays',
    'About 0.28" a week from 45 minutes per zone, 1 day a week on rotor heads — typical head rates.',
  ];

  test.each(sentences)('passes the customer-copy rules: %s', (text) => {
    expect(customerCopyViolations(text)).toEqual([]);
    // no result promise (the schedule row echoes the customer's own entries, so the writer's time-word screen does not apply)
    expect(text).not.toMatch(/\b(?:safe|will|within|guarantee|results?)\b/i);
  });

  test('the Ask Waves explanation passes too', () => {
    expect(customerCopyViolations(polish.scheduleOnFileExplanation('45 min, Mondays', 1))).toEqual([]);
  });
});

describe('ONE label line per product card: the rule, on the real catalog strings', () => {
  const DRY = 'Stay off treated areas until the application has dried.';
  const WATERED_IN = 'Stay off treated areas until the product has been watered in and the turf is dry.';
  const GRANULE = 'Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 24 hours. People and pets can use the lawn once it has been watered in and the turf is dry.';
  const decide = (precaution, reentry, reentryHours) => labels.precautionAfterDrops(precaution, labels.precautionDrops({ precaution, reentry, reentryHours }));

  test('spray: the re-entry line alone (the "Per the product label:" lead is read through)', () => {
    expect(decide('Per the product label: keep people and pets off treated areas until sprays have dried.', DRY)).toBeNull();
  });

  test('a one-sentence until-dry precaution on a liquid: the re-entry line alone', () => {
    expect(decide('Keep people and pets off treated areas until the turf is dry.', DRY)).toBeNull();
  });

  test('granule watered in (Dimension, Stonewall): the handling sentences stay, the third sentence goes, the line stays', () => {
    expect(decide(GRANULE, WATERED_IN)).toBe('Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 24 hours.');
  });

  test('granule (Dylox): its own keep-off sentence is the same kind as the line and goes', () => {
    const dylox = 'Granules on sidewalks or driveways are swept back into the turf. Water in the same day with about ¼ inch. Keep people and pets off treated areas until it has been watered in and the turf is dry.';
    expect(decide(dylox, WATERED_IN)).toBe('Granules on sidewalks or driveways are swept back into the turf. Water in the same day with about ¼ inch.');
  });

  // The strings below are the live catalog rows of the local test database (read 2026-10-09), word for word.
  test('real rows: PolyPlus 24-0-11 (a "no re-entry wait" sentence), Arena (a qualified sentence), Dispatch (a pointer), Stonewall (no re-entry line)', () => {
    expect(decide('Granules on sidewalks or driveways are swept back into the turf or beds; watering-in follows the visit notes. No re-entry wait once watered in and dry.', WATERED_IN))
      .toBe('Granules on sidewalks or driveways are swept back into the turf or beds; watering-in follows the visit notes.');
    const arena = 'When this pesticide product is used, the technician follows the product label and service report instructions. People and pets should remain off treated areas until the application has dried, unless the label or technician instructions require a longer interval.';
    expect(decide(arena, DRY)).toBe(arena);
    const dispatch = 'When this support product is used, follow the technician service report for watering, access, or other customer action items.';
    expect(decide(dispatch, DRY)).toBe(dispatch);
    expect(decide(GRANULE, '')).toBe(GRANULE);
    expect(decide(GRANULE, null)).toBe(GRANULE);
  });

  test('a weaker until-dry sentence beside a stricter watered-in line goes (never two keep-off sentences)', () => {
    expect(decide('Keep people and pets off treated areas until the turf is dry. Sweep granules back into the turf.', WATERED_IN)).toBe('Sweep granules back into the turf.');
  });

  test('fail toward printing: a stricter precaution than the line, an unreadable sentence, an unreadable line, hours', () => {
    expect(decide(GRANULE, DRY)).toBe(GRANULE); // the precaution says more than the line
    const mix = 'Used only as part of a spray mix — the precautions of the products it is mixed with apply.';
    expect(decide(mix, DRY)).toBe(mix); // surfactant: the mix note is no keep-off sentence
    const arena = 'Per the product label: keep people and pets off treated areas until sprays have dried.';
    expect(decide(arena, 'Follow the product label and technician service report before re-entering treated areas.')).toBe(arena);
    expect(decide(arena, null)).toBe(arena);
    expect(decide(arena, DRY, 4)).toBe(arena); // a stored re-entry figure: nothing dropped
    expect(decide('Keep people and pets off treated areas for 24 hours.', DRY)).toBe('Keep people and pets off treated areas for 24 hours.');
    expect(decide('', DRY)).toBeNull();
  });

  test('the card never ends with no keep-off line: a drop only happens beside a readable keep-off line', () => {
    const precautions = [GRANULE, 'Keep people and pets off treated areas until the turf is dry.', 'Per the product label: keep people and pets off treated areas until sprays have dried.'];
    for (const precaution of precautions) {
      for (const reentry of [DRY, WATERED_IN]) {
        const drops = labels.precautionDrops({ precaution, reentry });
        if (drops.length) expect(labels.kindOf(reentry)).not.toBeNull();
      }
    }
    expect(labels.precautionDrops({ precaution: GRANULE, reentry: 'Follow the technician.' })).toEqual([]);
  });

  test('without the catalog SQL (third sentence still there) and with it (sentence gone) the card is the same', () => {
    const withoutSql = decide(GRANULE, WATERED_IN);
    const withSql = decide('Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 24 hours.', WATERED_IN);
    expect(withoutSql).toBe(withSql);
  });
});

describe('the label-line decision is frozen with the lawn report facts', () => {
  const rows = [
    { id: 'row-spray', application_method: 'broadcast_spray', approved_report_product_facts: { wateringRule: { mode: 'none', source: 'label' }, reentrySummary: 'Stay off treated areas until the application has dried.', precautionSummary: 'Per the product label: keep people and pets off treated areas until sprays have dried.' } },
    { id: 'row-other', application_method: 'broadcast_spray', approved_report_product_facts: { reentrySummary: 'Follow the technician.', precautionSummary: 'Per the product label: keep people and pets off treated areas until sprays have dried.' } },
  ];
  const build = (extra) => facts.buildReportFacts({ rows, run: null, assessment: null, techFindings: [], withTies: false, now: new Date('2026-10-09T15:00:00Z'), ...extra });

  test('built only while the gate asks for it; a block built without it has no labelLines key', () => {
    expect(build({})).not.toHaveProperty('labelLines');
    expect(build({ withLabelLines: true }).labelLines).toEqual({ v: 1, items: { 'row-spray': [0] } });
  });

  test('read back by id; the card drops the frozen sentence; a record without the block is untouched', () => {
    const notes = JSON.stringify({ [facts.FREEZE_KEY]: build({ withLabelLines: true }) });
    const drops = facts.frozenLabelDropsFor('lawn', notes);
    expect(drops).toEqual({ 'row-spray': [0] });
    const precaution = rows[0].approved_report_product_facts.precautionSummary;
    expect(facts.precautionForCard(drops, { id: 'row-spray' }, precaution)).toBeNull();
    expect(facts.precautionForCard(drops, { id: 'row-other' }, precaution)).toBe(precaution);
    expect(facts.frozenLabelDropsFor('lawn', JSON.stringify({ [facts.FREEZE_KEY]: build({}) }))).toEqual({});
    expect(facts.frozenLabelDropsFor('lawn', '{}')).toEqual({});
    expect(facts.frozenLabelDropsFor('pest', notes)).toEqual({});
    expect(facts.precautionForCard({}, { id: 'row-spray' }, precaution)).toBe(precaution);
  });

  test('a hand-edited block prints nothing it was not built from', () => {
    const block = build({ withLabelLines: true });
    block.labelLines.items['row-spray'] = ['x', -1, 999];
    expect(facts.frozenLabelDropsFor('lawn', JSON.stringify({ [facts.FREEZE_KEY]: block }))).toEqual({});
    block.labelLines.v = 2;
    expect(facts.frozenLabelDropsFor('lawn', JSON.stringify({ [facts.FREEZE_KEY]: block }))).toEqual({});
  });

  test('the PDF key follows the frozen decision: unchanged for a record that drops nothing, moved for one that does', () => {
    const without = facts.frozenReportFactsStamp(JSON.stringify({ [facts.FREEZE_KEY]: build({}) }));
    const emptyDrops = facts.frozenReportFactsStamp(JSON.stringify({ [facts.FREEZE_KEY]: build({ withLabelLines: true, rows: [rows[1]] }) }));
    const dropping = facts.frozenReportFactsStamp(JSON.stringify({ [facts.FREEZE_KEY]: build({ withLabelLines: true }) }));
    expect(emptyDrops).toBe(without);
    expect(dropping).not.toBe(without);
    expect(dropping).toMatch(/^:rf=/);
  });
});

function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    const q = {};
    const applySort = () => {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of sortKeys) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b, c) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        } else if (arguments.length === 3) {
          rows = rows.filter((r) => {
            const left = String(r[a] ?? '');
            const right = String(c);
            if (b === '>') return left > right;
            if (b === '>=') return left >= right;
            if (b === '<') return left < right;
            if (b === '<=') return left <= right;
            return true;
          });
        }
        return q;
      },
      andWhere(a, b, c) {
        if (typeof a === 'function') {
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          return q;
        }
        return q.where(a, b, c);
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) {
        if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
        else rows = rows.filter((r) => r[a] !== b);
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const CUSTOMER = 'cust-lawn-polish';
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-10-08', visit_date: '2026-10-08', created_at: '2026-10-08T14:00:00Z', history_record_id: 'svc-cur',
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
};
const fixtures = () => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: [], lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-10-08', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [], service_records: [], lawn_assessments: [CUR],
});
const lawnService = () => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-10-08', completed_at: '2026-10-08T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify({}), service_data: JSON.stringify({}),
});



describe('the real report builder (in-memory reader)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    require('../services/llm/call').dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
  });

  test('gate off: no lawnPolish key; gate on: the lawn payload gains it and the water card carries its state', async () => {
    gateOff();
    const off = await buildReportV1Data(lawnService(), 'tok-polish', makeKnex(fixtures()), {});
    expect('lawnPolish' in off).toBe(false);
    expect(off.reportV2.water).not.toHaveProperty('scheduleKind');
    gateOn();
    const on = await buildReportV1Data(lawnService(), 'tok-polish', makeKnex(fixtures()), {});
    expect(on.lawnPolish).toBe(true);
    expect(on.reportV2.water.scheduleKind).toBe('none');
    const { lawnPolish, ...rest } = on;
    expect(lawnPolish).toBe(true);
    // the polish keys ride the water card and the assessment's own water context; nothing else moves
    const strip = (data) => JSON.parse(JSON.stringify({
      ...data,
      reportV2: { ...data.reportV2, water: { ...data.reportV2.water, scheduleKind: undefined } },
      lawnAssessment: data.lawnAssessment && { ...data.lawnAssessment, waterContext: data.lawnAssessment.waterContext && { ...data.lawnAssessment.waterContext, scheduleKind: undefined } },
    }));
    expect(strip(rest)).toEqual(strip(off));
  });

  test('gate on, a pest report: no key', async () => {
    gateOn();
    const pest = { ...lawnService(), service_line: 'pest', service_type: 'Quarterly Pest Control' };
    const data = await buildReportV1Data(pest, 'tok-polish', makeKnex(fixtures()), {});
    expect('lawnPolish' in data).toBe(false);
  });

  test('the lawn PDF cache signature is stable while the gate is off and moves with it while live', async () => {
    const sig = async () => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-10-08' },
      makeKnex(fixtures()),
    )).signature;
    gateOff();
    const before = await sig();
    expect(await sig()).toBe(before);
    gateOn();
    expect(await sig()).not.toBe(before);
  });
});
