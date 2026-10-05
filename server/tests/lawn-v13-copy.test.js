// Lawn protocol v13 customer copy, behind GATE_LAWN_V13 (PR 3 of 3).
// Synthetic inputs: no database.
//
// Pins: gate off the program line, the report season note and the service outline
// stamp are the old output; the v13 monthly program line is clean customer copy
// whose every claim the v13 visit backs; v13 copy reaches a visit only when its
// plan resolved the staged v13 version (a visit with no recorded version or an
// older one keeps the legacy sentences); service outlines are stamped lawn-v13.

const protocolsJson = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const outlineService = require('../services/lawn-service-outline');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const lineModule = require('../services/service-report/lawn-program-line');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const { buildProgramLine, PROGRAM_LINES, PROGRAM_LINES_V13, QUALIFIERS } = lineModule;
const GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function withGate(value, fn) {
  const saved = process.env.GATE_LAWN_V13;
  try {
    if (value === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
  }
}

const visitFor = (month) => v13.st_augustine.visits.find((v) => v.month === MONTH_ABBR[month - 1]);

describe('gate off is byte-identical for the program line', () => {
  test('every grass and month is the old table', () => {
    withGate(undefined, () => {
      for (const grass of GRASSES) {
        for (const month of MONTHS) {
          expect(buildProgramLine({ programVisit: true, grassType: grass, month })).toBe(PROGRAM_LINES[grass][month].line);
          // A recorded v13 version changes nothing with the gate off.
          expect(buildProgramLine({ programVisit: true, grassType: grass, month, protocolVersion: LAWN_V13_VERSION })).toBe(PROGRAM_LINES[grass][month].line);
        }
      }
    });
  });

  test('protocols.json itself is unchanged by v13 (the old table still keys on the four grasses)', () => {
    expect(Object.keys(protocolsJson.lawn)).toEqual(GRASSES);
  });
});

// ── Customer program line ────────────────────────────────────────────────────
describe('v13 monthly program line', () => {
  const EVIDENCE = {
    pre_emergent: /stonewall|dimension|pre-emergent/i,
    micros: /nutra-tech/i,
    feed: /24-0-11|stonewall 0\.43/i,
    fungicide: /artavia|velista|gravex/i,
    broadleaf: /celsius|dismiss/i,
    insect_spot: /arena|talak|acelepryn|dylox/i,
    insect_treatment: /tetrino/i,
    dry_spots: /dispatch/i,
    scouting_visit: /scout visit/i,
  };
  const CONDITION_WORDS = /\bno\b|\bonly\b|\bhold\b|\bif\b|\bskip/i;
  const clausesOf = (text) => String(text).split(/[\n,;:]|\.\s|\s—\s/).map((c) => c.trim()).filter(Boolean);
  const hasQualifier = (phrase) => QUALIFIERS.some((q) => phrase.toLowerCase().includes(q));

  const BANNED_WORDS = /\b(ordinances?|counties|county|blackouts?|laws?|bans?|banned|restrict\w*|prohibit\w*)\b/i;
  const WATER_MOW = /\b(water\w*|irrigat\w*|sprinkl\w*|rain\w*|mow\w*|drought|soak\w*)/i;
  const ORDINAL = /\b(first|second|third|final|last|continu\w*|again|re-?check\w*|complet\w*|another|next|follow-?up|start\w*|begin\w*|round)\b/i;
  const BRANDS = /(prodiamine|celsius|acelepryn|tetrino|dimension|stonewall|nutra|artavia|velista|gravex|arena|talak|dylox|dismiss|certainty|dispatch|lesco|bifen|nis\b)/i;

  test('a line for every month; gate on every grass (and an unknown one) with a v13 visit gets it; gate off keeps the old table', () => {
    expect(Object.keys(PROGRAM_LINES_V13).map(Number)).toEqual(MONTHS);
    withGate('true', () => {
      for (const grassType of [...GRASSES, null, 'unknown', 'mixed']) {
        for (const month of MONTHS) expect(buildProgramLine({ programVisit: true, grassType, month, protocolVersion: LAWN_V13_VERSION })).toBe(PROGRAM_LINES_V13[month].line);
      }
      // The Jun-Sep rule is unchanged: a visit that applied nitrogen gets no line.
      expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 7, nitrogenApplied: true, protocolVersion: LAWN_V13_VERSION })).toBeNull();
    });
    withGate(undefined, () => expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 3 })).toBe(PROGRAM_LINES.bermuda[3].line));
  });

  test.each(MONTHS)('month %i: clean customer copy', (month) => {
    const { line } = PROGRAM_LINES_V13[month];
    expect(line).not.toMatch(BANNED_WORDS);
    expect(line).not.toMatch(WATER_MOW);
    expect(line).not.toMatch(ORDINAL);
    expect(line).not.toMatch(BRANDS);
    expect(line).not.toMatch(/\d|—|–/);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(line).toMatch(/\.$/);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(validateCustomerCopy(line)).toBe(true);
  });

  test.each(MONTHS)('month %i: every claim is in the line and backed by the v13 visit; conditional steps are qualified', (month) => {
    const { line, claims } = PROGRAM_LINES_V13[month];
    const visit = visitFor(month);
    const primary = clausesOf(visit.primary);
    const everything = [...primary, ...clausesOf(visit.secondary), ...clausesOf(visit.notes)];
    for (const [tag, phrase] of Object.entries(claims)) {
      expect(line).toContain(phrase);
      expect(EVIDENCE[tag]).toBeDefined();
      const hits = everything.filter((c) => EVIDENCE[tag].test(c));
      expect({ tag, backed: hits.length > 0 }).toEqual({ tag, backed: true });
      const plain = primary.some((c) => EVIDENCE[tag].test(c)) && !hits.some((c) => CONDITION_WORDS.test(c));
      if (!plain) expect({ tag, phrase, qualified: hasQualifier(phrase) }).toEqual({ tag, phrase, qualified: true });
    }
  });
});

describe('v13 program line follows the protocol version the visit\'s plan resolved', () => {
  const OLD_VERSION = '2026.06';
  test('gate on: only a visit that resolved v13 gets v13 copy; no recorded version or an older one keeps the old copy', () => {
    withGate('true', () => {
      const input = { programVisit: true, grassType: 'bermuda', month: 10 };
      expect(buildProgramLine({ ...input, protocolVersion: LAWN_V13_VERSION })).toBe(PROGRAM_LINES_V13[10].line);
      // Historical or unattributed (no ledger row, no scheduled pin): never rewritten with v13.
      expect(buildProgramLine(input)).toBe(PROGRAM_LINES.bermuda[10].line);
      expect(buildProgramLine({ ...input, protocolVersion: null })).toBe(PROGRAM_LINES.bermuda[10].line);
      expect(buildProgramLine({ ...input, protocolVersion: OLD_VERSION })).toBe(PROGRAM_LINES.bermuda[10].line);
    });
  });

  test('gate off: the recorded version changes nothing', () => {
    withGate(undefined, () => {
      for (const protocolVersion of [null, OLD_VERSION, LAWN_V13_VERSION]) {
        expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 10, protocolVersion })).toBe(PROGRAM_LINES.bermuda[10].line);
      }
    });
  });

  test('buildLawnReportV2 passes the recorded version through to the season note', () => {
    const assessment = {
      assessmentDate: '2026-10-14',
      scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'shoulder' },
      overwateringSignal: false, droughtStress: 'minor', turfProfile: { grassType: 'bermuda' }, observations: 'Synthetic observation.',
      waterContext: { rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
      trend: [{ date: '2026-10-14', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, season: 'shoulder' }],
    };
    const saved = process.env.GATE_LAWN_EXPECTATIONS;
    process.env.GATE_LAWN_EXPECTATIONS = 'true';
    try {
      const note = (protocolVersion) => withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment, programVisit: true, ...(protocolVersion ? { protocolVersion } : {}) }).snapshot.seasonalNote);
      expect(note(LAWN_V13_VERSION)).toBe(PROGRAM_LINES_V13[10].line);
      expect(note(null)).toBe(PROGRAM_LINES.bermuda[10].line);
      expect(note('2026.06')).toBe(PROGRAM_LINES.bermuda[10].line);
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_EXPECTATIONS; else process.env.GATE_LAWN_EXPECTATIONS = saved;
    }
  });
});

describe('service outline protocol stamp', () => {
  test('gate off stamps lawn-v4; the v13 program stamps lawn-v13', () => {
    expect(withGate(undefined, () => outlineService.protocolVersion())).toBe('lawn-v4');
    expect(withGate('true', () => outlineService.protocolVersion())).toBe('lawn-v13');
    expect(outlineService.PROTOCOL_VERSION).toBeUndefined();
  });
});
