// Lawn monthly program line (lawn report rebuild P9, GATE_LAWN_EXPECTATIONS).
// Synthetic payloads only.
//
// Pins: every protocols.json grass x 12 months returns a string; every string is
// clean customer copy (no ordinance / county / blackout / law wording, no
// product or brand name, no clock time, no watering / rain / mowing words);
// every claim is backed by the protocols.json visit for that grass and month;
// Jun-Sep returns null when the visit applied nitrogen (analysis_n > 0); gate
// off leaves the payload byte-identical.

const protocols = require('../config/protocols.json');
const {
  buildProgramLine, PROGRAM_LINES, DEFAULT_LINES, NO_NITROGEN_MONTHS,
} = require('../services/service-report/lawn-program-line');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const GRASSES = Object.keys(protocols.lawn);
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

const BANNED_WORDS = /\b(ordinances?|counties|county|blackouts?|laws?|bans?|banned|restrict\w*|prohibit\w*)\b/i;
const WATER_MOW = /\b(water\w*|irrigat\w*|sprinkl\w*|rain\w*|mow\w*|drought|soak\w*)/i;
const CLOCK_TIME = /\b\d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\bo['’]clock\b|\b(noon|midnight)\b/i;
const DIGITS = /\d/;
// Brand / product names that appear in protocols.json and the product catalog.
const BRANDS = /(prodiamine|celsius|acelepryn|speedzone|k-?flow|primo|maxx|dismiss|sedgehammer|headway|medallion|torque|armada|velista|atrazine|three-?way|lesco|carbonpro|hydretain|talstar|talak|arena|dylox|topchoice|anuew|t-?storm|bifen|moisture manager|dispatch|green flo|kmag|polyplus|nis\b)/i;

const monthOf = (visit) => MONTH_ABBR.indexOf(String(visit.month).slice(0, 3)) + 1;
const visitFor = (grass, month) => protocols.lawn[grass].visits.find((v) => monthOf(v) === month);
const visitText = (visit) => [visit.primary, visit.secondary, visit.notes].join('\n');

// What each claim tag needs to find in the protocol visit's own text.
const EVIDENCE = {
  pre_emergent: /prodiamine/i,
  feed: /LESCO 24-/i,
  micros: /micros|chelated|iron|\bMn\b/i,
  potassium: /K-Flow|0-0-18|0-0-2\d|Green Flo/i,
  broadleaf: /celsius|speedzone|atrazine|three-way|broadleaf/i,
  insect_prevention: /acelepryn/i,
  fungicide: /fungicide|torque|headway|armada|medallion|velista|t-storm/i,
  scout: /scout|soap flush|float test|drive-by|re-check|check|flight|monitoring/i,
  crabgrass_watch: /crabgrass/i,
  conditional_treatment: /dylox|t-storm/i,
  growth_regulator: /primo maxx/i,
  biostimulant: /carbonpro/i,
  dormancy: /dormant|dormancy/i,
  winter: /wellness|touchpoint|dormant|dormancy/i,
  seed_heads: /seed head/i,
};

describe('program line table covers protocols.json', () => {
  test('the four protocol grasses carry 12 months and a line for each', () => {
    expect(GRASSES.sort()).toEqual(['bahia', 'bermuda', 'st_augustine', 'zoysia']);
    for (const grass of GRASSES) {
      expect(Object.keys(PROGRAM_LINES[grass]).map(Number).sort((a, b) => a - b)).toEqual(MONTHS);
      expect(protocols.lawn[grass].visits.map(monthOf).sort((a, b) => a - b)).toEqual(MONTHS);
    }
    expect(Object.keys(DEFAULT_LINES).map(Number).sort((a, b) => a - b)).toEqual(MONTHS);
  });

  test.each(GRASSES)('%s x 12 months returns the table string', (grass) => {
    for (const month of MONTHS) {
      const line = buildProgramLine({ grassType: grass, month });
      expect(typeof line).toBe('string');
      expect(line).toBe(PROGRAM_LINES[grass][month].line);
    }
  });

  test('grass spelling is forgiving; unknown / mixed / null grass takes the generic line', () => {
    expect(buildProgramLine({ grassType: 'St. Augustine'.replace('. ', '_').toLowerCase(), month: 1 })).toBe(PROGRAM_LINES.st_augustine[1].line);
    expect(buildProgramLine({ grassType: 'Bermuda', month: 3 })).toBe(PROGRAM_LINES.bermuda[3].line);
    for (const grassType of [null, undefined, '', 'unknown', 'centipede', 'mixed', 'st_augustine/bermuda']) {
      for (const month of MONTHS) expect(buildProgramLine({ grassType, month })).toBe(DEFAULT_LINES[month].line);
    }
  });

  test('no valid month is a deliberate null', () => {
    for (const month of [null, undefined, 0, 13, 1.5, 'x', NaN]) {
      expect(buildProgramLine({ grassType: 'bermuda', month })).toBeNull();
    }
    expect(buildProgramLine()).toBeNull();
  });
});

describe('every string is clean customer copy', () => {
  const all = [
    ...GRASSES.flatMap((grass) => MONTHS.map((month) => [`${grass} ${month}`, PROGRAM_LINES[grass][month].line])),
    ...MONTHS.map((month) => [`default ${month}`, DEFAULT_LINES[month].line]),
  ];

  test.each(all)('%s', (_label, line) => {
    expect(line).not.toMatch(BANNED_WORDS);
    expect(line).not.toMatch(WATER_MOW);
    expect(line).not.toMatch(CLOCK_TIME);
    expect(line).not.toMatch(DIGITS);
    expect(line).not.toMatch(BRANDS);
    expect(line).not.toMatch(/\bWaves Pest Control & Lawn/i);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(line.length).toBeGreaterThan(30);
    expect(line).toMatch(/[.]$/);
    expect(line).not.toMatch(/—|–/);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(validateCustomerCopy(line)).toBe(true);
  });

  test('the banned-copy check itself catches what it should', () => {
    expect(BANNED_WORDS.test('the county fertilizer ordinance')).toBe(true);
    expect(BANNED_WORDS.test('summer blackout')).toBe(true);
    expect(BANNED_WORDS.test('state law')).toBe(true);
    expect(BANNED_WORDS.test('a healthy lawn')).toBe(false);
    expect(BRANDS.test('Celsius WG')).toBe(true);
    expect(CLOCK_TIME.test('after 3 PM')).toBe(true);
  });
});

describe('every claim is backed by protocols.json', () => {
  for (const grass of GRASSES) {
    test.each(MONTHS)(`${grass} month %i`, (month) => {
      const visit = visitFor(grass, month);
      expect(visit).toBeTruthy();
      const text = visitText(visit);
      for (const tag of PROGRAM_LINES[grass][month].tags) {
        expect(EVIDENCE[tag]).toBeDefined();
        expect({ tag, ok: EVIDENCE[tag].test(text) }).toEqual({ tag, ok: true });
      }
    });
  }

  test.each(MONTHS)('generic line, month %i, only claims what all four programs do', (month) => {
    for (const tag of DEFAULT_LINES[month].tags) {
      for (const grass of GRASSES) {
        expect({ grass, tag, ok: EVIDENCE[tag].test(visitText(visitFor(grass, month))) }).toEqual({ grass, tag, ok: true });
      }
    }
  });

  test('Jun-Sep lines never describe a nitrogen feeding (the program applies none)', () => {
    for (const month of NO_NITROGEN_MONTHS) {
      for (const grass of GRASSES) expect(PROGRAM_LINES[grass][month].tags).not.toContain('feed');
      expect(DEFAULT_LINES[month].tags).not.toContain('feed');
    }
    for (const grass of GRASSES) for (const month of [6, 7, 8, 9]) {
      expect(visitText(visitFor(grass, month))).not.toMatch(/LESCO 24-/);
    }
  });
});

describe('Jun-Sep with nitrogen applied is a deliberate null', () => {
  const nApp = { product: { name: 'Synthetic Fertilizer 24-0-11', analysis_n: 24 } };
  const kApp = { product: { name: 'Synthetic Potassium 0-0-25', analysis_n: 0 } };

  test.each([6, 7, 8, 9])('month %i: analysis_n > 0 -> null, analysis_n 0 or none -> line', (month) => {
    for (const grassType of [...GRASSES, null]) {
      expect(buildProgramLine({ grassType, month, applications: [nApp] })).toBeNull();
      expect(buildProgramLine({ grassType, month, applications: [kApp, nApp] })).toBeNull();
      expect(typeof buildProgramLine({ grassType, month, applications: [kApp] })).toBe('string');
      expect(typeof buildProgramLine({ grassType, month, applications: [] })).toBe('string');
    }
  });

  test('either report shape and a fertilizer-analysis name count as nitrogen', () => {
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [{ analysis_n: '16' }] })).toBeNull();
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [{ product: { name: 'Synthetic 24-0-11' } }] })).toBeNull();
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [{ product: { name: 'Synthetic 0-0-25' } }] })).toEqual(expect.any(String));
  });

  test('the caller-supplied catalog answer wins over the shapes', () => {
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [kApp], nitrogenApplied: true })).toBeNull();
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [nApp], nitrogenApplied: false })).toEqual(expect.any(String));
  });

  test('other months do not care about nitrogen', () => {
    for (const month of [1, 2, 3, 4, 5, 10, 11, 12]) {
      expect(typeof buildProgramLine({ grassType: 'st_augustine', month, applications: [nApp] })).toBe('string');
    }
  });
});

// ── gate wiring in buildLawnReportV2 ────────────────────────────────────────
const GATE = 'GATE_LAWN_EXPECTATIONS';
function withGate(value, fn) {
  const previous = process.env[GATE];
  if (value === undefined) delete process.env[GATE]; else process.env[GATE] = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env[GATE]; else process.env[GATE] = previous;
  }
}

function assessment(overrides = {}) {
  return {
    assessmentDate: '2026-10-14',
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'shoulder' },
    overwateringSignal: false,
    droughtStress: 'minor',
    turfProfile: { grassType: 'st_augustine' },
    observations: 'Synthetic observation.',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
    trend: [
      { date: '2026-04-15', overallScore: 60, turfDensity: 60, weedSuppression: 70, colorHealth: 65, stressDamage: 40, season: 'shoulder' },
      { date: '2026-10-14', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, season: 'shoulder' },
    ],
    ...overrides,
  };
}

describe('buildLawnReportV2 and GATE_LAWN_EXPECTATIONS', () => {
  const OLD_SHOULDER = /transitional stretch/;

  test('gate off (unset or any non-true) is byte-identical: old note, no new key', () => {
    const baseline = withGate(undefined, () => buildLawnReportV2({ lawnAssessment: assessment() }));
    for (const value of ['', 'false', '0', 'off']) {
      const off = withGate(value, () => buildLawnReportV2({ lawnAssessment: assessment() }));
      expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    }
    expect(baseline.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(baseline.snapshot).not.toHaveProperty('seasonalNoteSource');
    expect(baseline).not.toHaveProperty('seasonalNote');
  });

  test('gate on: snapshot.seasonalNote is the program line from the visit month, marked as program', () => {
    const on = withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment() }));
    expect(on.snapshot.seasonalNote).toBe(PROGRAM_LINES.st_augustine[10].line);
    expect(on.snapshot.seasonalNoteSource).toBe('program');
    expect(on).not.toHaveProperty('seasonalNote');
    // Only the season note differs from the gate-off payload.
    const off = withGate(undefined, () => buildLawnReportV2({ lawnAssessment: assessment() }));
    const strip = (v) => { const c = JSON.parse(JSON.stringify(v)); delete c.snapshot.seasonalNote; delete c.snapshot.seasonalNoteSource; return c; };
    // smsSummary and the rest are derived from other snapshot fields
    expect(strip(on)).toEqual(strip(off));
  });

  test('the month is the noon-UTC visit month, grass from the turf profile', () => {
    const month = (date, grassType) => withGate('true', () => buildLawnReportV2({
      lawnAssessment: assessment({ assessmentDate: date, turfProfile: { grassType } }),
    }).snapshot.seasonalNote);
    expect(month('2026-01-31', 'bermuda')).toBe(PROGRAM_LINES.bermuda[1].line);
    expect(month('2026-02-01', 'zoysia')).toBe(PROGRAM_LINES.zoysia[2].line);
    expect(month('2026-12-01', 'bahia')).toBe(PROGRAM_LINES.bahia[12].line);
    expect(month('2026-03-10', 'weird')).toBe(DEFAULT_LINES[3].line);
  });

  test('null line (Jun-Sep nitrogen, or no assessment date) falls back to the old note, unmarked', () => {
    const june = (extra) => withGate('true', () => buildLawnReportV2({
      lawnAssessment: assessment({ assessmentDate: '2026-06-18', scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' } }),
      ...extra,
    }));
    const withN = june({ nitrogenApplied: true });
    expect(withN.snapshot.seasonalNote).toMatch(/peak heat-and-pest/);
    expect(withN.snapshot).not.toHaveProperty('seasonalNoteSource');
    const noN = june({ nitrogenApplied: false });
    expect(noN.snapshot.seasonalNote).toBe(PROGRAM_LINES.st_augustine[6].line);
    const byName = june({ applications: [{ product: { name: 'Synthetic 24-0-11' } }] });
    expect(byName.snapshot).not.toHaveProperty('seasonalNoteSource');

    const noDate = withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment({ assessmentDate: null }) }));
    expect(noDate.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(noDate.snapshot).not.toHaveProperty('seasonalNoteSource');
  });

  test('the gate reader is exported on its own line and reads at call time', () => {
    const gates = require('../config/feature-gates');
    expect(withGate('true', () => gates.lawnExpectationsLive())).toBe(true);
    expect(withGate('1', () => gates.lawnExpectationsLive())).toBe(true);
    expect(withGate(undefined, () => gates.lawnExpectationsLive())).toBe(false);
    expect(withGate('false', () => gates.lawnExpectationsLive())).toBe(false);
  });
});
